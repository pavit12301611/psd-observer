//! Unified macOS ScreenCaptureKit capture for both video and audio.
//!
//! This module manages a SINGLE SCStream that captures both video and audio.
//! The frontend can independently start/stop video and audio channels,
//! but internally they share the same capture session.
//!
//! This fixes the "stream output NOT found" errors that occurred when
//! running separate video and audio SCStreams.

use crate::audio_pipeline::{SharedResampler, TARGET_SAMPLE_RATE};
use crate::capture_config;
use crate::error::{Error, Result};
use crate::targets::{self, CaptureTarget, TargetKind};
use base64::{engine::general_purpose::STANDARD, Engine};
use jpeg_encoder::{ColorType, Encoder};
use parking_lot::{Mutex, RwLock};
use screencapturekit::cv::CVPixelBufferLockFlags;
use screencapturekit::prelude::*;
use screencapturekit::shareable_content::SCShareableContentInfo;
use screencapturekit::stream::delegate_trait::StreamCallbacks;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

/// Frame data sent through the channel to the frontend
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameData {
    /// Raw JPEG bytes (sent as Uint8Array to frontend)
    #[serde(with = "serde_bytes")]
    pub frame: Vec<u8>,
    /// Unix timestamp in seconds
    pub timestamp: f64,
    /// Frame dimensions
    pub width: u32,
    pub height: u32,
    /// Frame sequence number
    pub frame_count: u64,
}

/// Audio data sent through the channel to the frontend
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioData {
    /// Base64-encoded PCM (f32 samples, little-endian, mono)
    pub samples: String,
    /// Unix timestamp in seconds
    pub timestamp: f64,
    /// Sample rate (e.g., 48000)
    pub sample_rate: u32,
    /// Chunk sequence number
    pub chunk_count: u64,
}

// Capture quality (max width / JPEG quality / FPS) is runtime-tunable — pushed from the
// frontend before capture starts and read from `capture_config` when we build the stream
// and encode frames. See that module for defaults and rationale.
const AUDIO_SAMPLE_RATE: u32 = 48000;

/// Unified capture state for both video and audio
struct UnifiedCaptureState {
    /// Whether the SCStream is currently running
    is_active: AtomicBool,
    /// Whether video output is requested
    wants_video: AtomicBool,
    /// Whether audio output is requested
    wants_audio: AtomicBool,
    /// Whether the watchdog is running
    watchdog_running: AtomicBool,
    /// Video frame count
    frame_count: AtomicU64,
    /// Audio chunk count
    audio_chunk_count: AtomicU64,
    /// Last time we received ANY callback (video or audio) - for watchdog
    last_callback_epoch_ms: AtomicU64,
    /// Currently selected capture target
    selected_target: Mutex<Option<String>>,
    /// Active SCStream instance
    active_stream: Mutex<Option<SCStream>>,
    /// Video channel (set when video is requested)
    video_channel: RwLock<Option<Channel<FrameData>>>,
    /// Audio channel (set when audio is requested)
    audio_channel: RwLock<Option<Channel<AudioData>>>,
    /// Audio resampler for 16kHz transcription output
    audio_resampler: SharedResampler,
}

static CAPTURE_STATE: std::sync::OnceLock<Arc<UnifiedCaptureState>> = std::sync::OnceLock::new();

fn get_capture_state() -> Arc<UnifiedCaptureState> {
    CAPTURE_STATE
        .get_or_init(|| {
            Arc::new(UnifiedCaptureState {
                is_active: AtomicBool::new(false),
                wants_video: AtomicBool::new(false),
                wants_audio: AtomicBool::new(false),
                watchdog_running: AtomicBool::new(false),
                frame_count: AtomicU64::new(0),
                audio_chunk_count: AtomicU64::new(0),
                last_callback_epoch_ms: AtomicU64::new(0),
                selected_target: Mutex::new(None),
                active_stream: Mutex::new(None),
                video_channel: RwLock::new(None),
                audio_channel: RwLock::new(None),
                // Resample from native 48kHz to 16kHz for transcription
                audio_resampler: SharedResampler::new(AUDIO_SAMPLE_RATE),
            })
        })
        .clone()
}

fn current_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Watchdog timeout - if no callbacks for this long, stream is dead
const WATCHDOG_TIMEOUT_MS: u64 = 2000; // 2 seconds

/// Start watchdog that monitors stream health and auto-restarts if dead
fn start_watchdog(state: Arc<UnifiedCaptureState>) {
    // Only start one watchdog
    if state.watchdog_running.swap(true, Ordering::SeqCst) {
        log::info!("[ScreenCapture] Watchdog already running, not starting another");
        return;
    }

    std::thread::spawn(move || {
        log::info!("[ScreenCapture] Watchdog started");

        loop {
            std::thread::sleep(std::time::Duration::from_millis(1000));

            // Check if we should still be running
            let wants_video = state.wants_video.load(Ordering::SeqCst);
            let wants_audio = state.wants_audio.load(Ordering::SeqCst);

            if !wants_video && !wants_audio {
                log::info!("[ScreenCapture] Watchdog exiting (no streams wanted)");
                break;
            }

            let is_active = state.is_active.load(Ordering::SeqCst);
            if !is_active {
                log::warn!("[ScreenCapture] Watchdog: stream not active, attempting restart...");

                // Try to restart
                let target_id = state.selected_target.lock().clone();
                if let Err(e) = restart_capture(&state, target_id) {
                    log::error!("[ScreenCapture] Watchdog: restart failed: {:?}", e);
                }
                continue;
            }

            // Check last callback time
            let last_callback = state.last_callback_epoch_ms.load(Ordering::SeqCst);
            let now = current_epoch_ms();

            if last_callback > 0 && now - last_callback > WATCHDOG_TIMEOUT_MS {
                log::warn!(
                    "[ScreenCapture] Watchdog: no callbacks for {}ms, stream appears dead. Restarting...",
                    now - last_callback
                );

                // Mark as inactive and restart
                state.is_active.store(false, Ordering::SeqCst);

                // Take and drop the old stream
                if let Some(old_stream) = state.active_stream.lock().take() {
                    let _ = old_stream.stop_capture(); // Ignore error, it's probably already dead
                }

                // Restart
                let target_id = state.selected_target.lock().clone();
                if let Err(e) = restart_capture(&state, target_id) {
                    log::error!("[ScreenCapture] Watchdog: restart failed: {:?}", e);
                } else {
                    log::info!("[ScreenCapture] Watchdog: stream restarted successfully");
                }
            }
        }

        // Mark watchdog as stopped
        state.watchdog_running.store(false, Ordering::SeqCst);
        log::info!("[ScreenCapture] Watchdog stopped");
    });
}

/// Internal restart function (called by watchdog)
fn restart_capture(state: &Arc<UnifiedCaptureState>, target_id: Option<String>) -> Result<()> {
    // Reset callback timestamp
    state.last_callback_epoch_ms.store(0, Ordering::SeqCst);

    // Start capture (ensure_capture_running will create new stream)
    ensure_capture_running(state, target_id)
}

pub fn init<R: Runtime, C: serde::de::DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<()> {
    log::info!("[ScreenCapture] macOS unified capture initialized (ScreenCaptureKit)");
    Ok(())
}

/// Get all available capture targets
pub fn get_capture_targets(include_thumbnails: bool) -> Result<Vec<CaptureTarget>> {
    targets::get_all_targets(include_thumbnails)
}

/// Start video capture stream
/// If capture is already running (for audio), reuses the existing stream
pub fn start_capture_stream(
    target_id: Option<String>,
    on_frame: Channel<FrameData>,
) -> Result<()> {
    let state = get_capture_state();

    log::info!("[ScreenCapture] Starting video stream with target: {:?}", target_id);

    // Store the video channel
    {
        let mut channel = state.video_channel.write();
        *channel = Some(on_frame);
    }
    state.wants_video.store(true, Ordering::SeqCst);
    state.frame_count.store(0, Ordering::SeqCst);

    // Update target if provided
    if target_id.is_some() {
        let mut target = state.selected_target.lock();
        *target = target_id.clone();
    }

    // Start the unified capture if not already running
    ensure_capture_running(&state, target_id)?;

    log::info!("[ScreenCapture] Video stream started");
    Ok(())
}

/// Start audio capture stream
/// If capture is already running (for video), reuses the existing stream
pub fn start_audio_stream(on_audio: Channel<AudioData>) -> Result<()> {
    let state = get_capture_state();

    log::info!("[ScreenCapture] Starting audio stream");

    // Store the audio channel
    {
        let mut channel = state.audio_channel.write();
        *channel = Some(on_audio);
    }
    state.wants_audio.store(true, Ordering::SeqCst);
    state.audio_chunk_count.store(0, Ordering::SeqCst);

    // Start the unified capture if not already running
    let target_id = state.selected_target.lock().clone();
    ensure_capture_running(&state, target_id)?;

    log::info!("[ScreenCapture] Audio stream started");
    Ok(())
}

/// Stop video capture
/// Only tears down SCStream if audio is also stopped
pub async fn stop_capture() -> Result<()> {
    let state = get_capture_state();

    log::info!("[ScreenCapture] Stopping video stream...");

    // Clear video channel and mark as not wanted
    {
        let mut channel = state.video_channel.write();
        *channel = None;
    }
    state.wants_video.store(false, Ordering::SeqCst);

    // Check if we should tear down the stream
    maybe_stop_capture(&state);

    log::info!("[ScreenCapture] Video stream stopped");
    Ok(())
}

/// Stop audio capture
/// Only tears down SCStream if video is also stopped
pub fn stop_audio() -> Result<()> {
    let state = get_capture_state();

    log::info!("[ScreenCapture] Stopping audio stream...");

    // Clear audio channel and mark as not wanted
    {
        let mut channel = state.audio_channel.write();
        *channel = None;
    }
    state.wants_audio.store(false, Ordering::SeqCst);

    // Check if we should tear down the stream
    maybe_stop_capture(&state);

    log::info!("[ScreenCapture] Audio stream stopped");
    Ok(())
}

/// Check if audio capture is currently active
pub fn is_audio_active() -> bool {
    let state = get_capture_state();
    state.wants_audio.load(Ordering::SeqCst) && state.is_active.load(Ordering::SeqCst)
}

/// Get broadcast status
pub fn get_broadcast_status() -> Result<serde_json::Value> {
    let state = get_capture_state();

    Ok(serde_json::json!({
        "isActive": state.is_active.load(Ordering::SeqCst),
        "wantsVideo": state.wants_video.load(Ordering::SeqCst),
        "wantsAudio": state.wants_audio.load(Ordering::SeqCst),
        "frameCount": state.frame_count.load(Ordering::SeqCst),
        "audioChunkCount": state.audio_chunk_count.load(Ordering::SeqCst),
        "targetId": state.selected_target.lock().clone()
    }))
}

/// Ensure the unified capture is running
fn ensure_capture_running(
    state: &Arc<UnifiedCaptureState>,
    target_id: Option<String>,
) -> Result<()> {
    // If already running, nothing to do
    if state.is_active.load(Ordering::SeqCst) {
        log::info!("[ScreenCapture] Capture already running, reusing existing stream");
        return Ok(());
    }

    log::info!("[ScreenCapture] Starting unified ScreenCaptureKit capture...");

    // Get shareable content
    let content = SCShareableContent::get().map_err(|e| {
        log::error!("[ScreenCapture] Failed to get shareable content: {:?}", e);
        Error::Platform(format!("Failed to get shareable content: {:?}", e))
    })?;

    log::info!(
        "[ScreenCapture] Found {} displays, {} windows",
        content.displays().len(),
        content.windows().len()
    );

    let displays = content.displays();
    let windows = content.windows();

    // Build the content filter and remember the source's size in POINTS (used only as a
    // fallback if the native pixel size isn't available). The actual buffer is sized in
    // pixels below — SCStreamConfiguration is pixel-based, and sizing it from points
    // captures Retina sources at half resolution (the root cause of soft/pixelated frames).
    let (filter, frame_w_pts, frame_h_pts) = if let Some(id) = &target_id {
        if let Ok((kind, numeric_id)) = targets::parse_target_id(id) {
            match kind {
                TargetKind::Monitor => {
                    let display = displays
                        .iter()
                        .find(|d| d.display_id() == numeric_id)
                        .ok_or_else(|| Error::Platform(format!("Display {} not found", numeric_id)))?;

                    let frame = display.frame();
                    log::info!(
                        "[ScreenCapture] Capturing display: {} ({}x{} pts)",
                        display.display_id(),
                        frame.width,
                        frame.height
                    );

                    (SCContentFilter::create().with_display(display).build(), frame.width, frame.height)
                }
                TargetKind::Window => {
                    let window = windows
                        .iter()
                        .find(|w| w.window_id() == numeric_id)
                        .ok_or_else(|| Error::Platform(format!("Window {} not found", numeric_id)))?;

                    let frame = window.frame();
                    log::info!(
                        "[ScreenCapture] Capturing window: {:?} ({}x{} pts)",
                        window.title(),
                        frame.width,
                        frame.height
                    );

                    (SCContentFilter::create().with_window(window).build(), frame.width, frame.height)
                }
            }
        } else {
            return Err(Error::Platform("Invalid target ID format".to_string()));
        }
    } else {
        let display = displays
            .first()
            .ok_or_else(|| Error::Platform("No displays found".to_string()))?;

        let frame = display.frame();
        log::info!(
            "[ScreenCapture] Capturing primary display: {} ({}x{} pts)",
            display.display_id(),
            frame.width,
            frame.height
        );

        (SCContentFilter::create().with_display(display).build(), frame.width, frame.height)
    };

    // Size the capture buffer to the source's NATIVE PIXEL resolution (capped at MAX_WIDTH).
    let (out_width, out_height) = capture_pixel_dimensions(&filter, frame_w_pts, frame_h_pts);

    log::info!(
        "[ScreenCapture] Output buffer sized to {}x{} (aspect-matched, no letterbox)",
        out_width,
        out_height
    );

    // Configure stream for BOTH video and audio
    let frame_interval = CMTime::new(1, capture_config::target_fps() as i32);
    let config = SCStreamConfiguration::new()
        .with_width(out_width)
        .with_height(out_height)
        .with_minimum_frame_interval(&frame_interval)
        .with_pixel_format(PixelFormat::BGRA)
        .with_shows_cursor(true)
        .with_captures_audio(true)
        .with_excludes_current_process_audio(false)
        .with_sample_rate(AUDIO_SAMPLE_RATE as i32)
        .with_channel_count(1); // Mono

    // Create delegate to receive stream lifecycle events and errors
    let state_for_delegate = state.clone();
    let delegate = StreamCallbacks::new()
        .on_stop(move |error| {
            if let Some(e) = &error {
                log::error!("[ScreenCapture] SCStream stopped with error: {}", e);
            } else {
                log::info!("[ScreenCapture] SCStream stopped normally");
            }
            // Mark stream as inactive so we know it died
            state_for_delegate.is_active.store(false, Ordering::SeqCst);
        })
        .on_error(|error| {
            log::error!("[ScreenCapture] SCStream error: {}", error);
        });

    // Create the stream WITH delegate for error callbacks
    let mut stream = SCStream::new_with_delegate(&filter, &config, delegate);

    // Clone state for closures
    let state_for_video = state.clone();
    let state_for_audio = state.clone();
    let start_time = std::time::Instant::now();

    // Add VIDEO output handler
    stream.add_output_handler(
        Box::new(move |sample: CMSampleBuffer, of_type: SCStreamOutputType| {
            if of_type != SCStreamOutputType::Screen {
                return;
            }

            // Track that we received a callback (for watchdog)
            state_for_video.last_callback_epoch_ms.store(current_epoch_ms(), Ordering::SeqCst);

            // IMPORTANT: Always "consume" the frame by accessing the image buffer.
            // ScreenCaptureKit stops the stream if video frames aren't being consumed,
            // even when we only want audio. This keeps the stream alive.
            let image_buffer = match sample.image_buffer() {
                Some(buf) => buf,
                None => return,
            };

            let guard = match image_buffer.lock(CVPixelBufferLockFlags::READ_ONLY) {
                Ok(g) => g,
                Err(_) => return,
            };

            // If video isn't wanted, just touch the data to "consume" the frame and return
            if !state_for_video.wants_video.load(Ordering::SeqCst) {
                // Touch first byte to ensure frame is "consumed" by ScreenCaptureKit
                let _ = guard.as_slice().first();

                // Log periodically to confirm stream is still alive
                let dummy_count = state_for_video.frame_count.fetch_add(1, Ordering::SeqCst) + 1;
                if dummy_count % 100 == 0 {
                    log::info!(
                        "[ScreenCapture] Video frames consumed (audio-only mode): {} frames",
                        dummy_count
                    );
                }
                return;
            }

            // Get the channel (if available)
            let channel_guard = state_for_video.video_channel.read();
            let channel = match channel_guard.as_ref() {
                Some(c) => c,
                None => return,
            };

            let width = guard.width();
            let height = guard.height();
            let bytes_per_row = guard.bytes_per_row();
            let data = guard.as_slice();

            // Encode straight from the BGRA buffer ScreenCaptureKit handed us. SCK has
            // already scaled the frame to our configured output size, so there's no
            // resize to do here — we skip the old BGRA→RGBA→RGB copy passes entirely and
            // let the SIMD JPEG encoder read the BGRA bytes directly. Keeping this handler
            // cheap is what stops frames backing up on SCK's dispatch queue (the cause of
            // the growing capture-to-screen latency).
            if let Some(frame_data) =
                encode_bgra_frame(data, width as u32, height as u32, bytes_per_row, &state_for_video)
            {
                if let Err(e) = channel.send(frame_data) {
                    log::error!("[ScreenCapture] Failed to send video frame: {:?}", e);
                }
            }
        }),
        SCStreamOutputType::Screen,
    );

    // Add AUDIO output handler
    stream.add_output_handler(
        Box::new(move |sample: CMSampleBuffer, of_type: SCStreamOutputType| {
            if of_type != SCStreamOutputType::Audio {
                return;
            }

            // Track that we received a callback (for watchdog)
            state_for_audio.last_callback_epoch_ms.store(current_epoch_ms(), Ordering::SeqCst);

            // Only process if audio is wanted
            if !state_for_audio.wants_audio.load(Ordering::SeqCst) {
                return;
            }

            // Get the channel (if available)
            let channel_guard = state_for_audio.audio_channel.read();
            let channel = match channel_guard.as_ref() {
                Some(c) => c,
                None => return,
            };

            let count = state_for_audio.audio_chunk_count.fetch_add(1, Ordering::SeqCst) + 1;
            let elapsed_secs = start_time.elapsed().as_secs();

            if count == 1 {
                log::info!("[ScreenCapture] First audio sample received");
            }

            if count % 500 == 0 {
                log::info!(
                    "[ScreenCapture] Audio stream alive: {} chunks, {}s elapsed",
                    count,
                    elapsed_secs
                );
            }

            // Extract audio data
            let audio_buffer_list = match sample.audio_buffer_list() {
                Some(list) => list,
                None => return,
            };

            let audio_buffer = match audio_buffer_list.buffer(0) {
                Some(buf) => buf,
                None => return,
            };

            let data_bytes = audio_buffer.data();
            if data_bytes.is_empty() {
                return;
            }

            // Convert to f32 samples
            let mono_samples = unsafe {
                std::slice::from_raw_parts(
                    data_bytes.as_ptr() as *const f32,
                    data_bytes.len() / 4,
                )
            };

            // Resample from native rate (48kHz) to 16kHz for transcription
            let resampled = match state_for_audio.audio_resampler.resample(mono_samples) {
                Ok(samples) => samples,
                Err(e) => {
                    if count % 100 == 1 {
                        log::warn!("[ScreenCapture] Resampling failed, using original: {}", e);
                    }
                    mono_samples.to_vec()
                }
            };

            let bytes: Vec<u8> = resampled
                .iter()
                .flat_map(|&sample| sample.to_le_bytes())
                .collect();

            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64();

            // Send at 16kHz (resampled rate) for transcription
            let audio_payload = AudioData {
                samples: STANDARD.encode(&bytes),
                timestamp,
                sample_rate: TARGET_SAMPLE_RATE,
                chunk_count: count,
            };

            if count == 1 {
                log::info!(
                    "[ScreenCapture] First audio chunk sent ({} samples @ {}Hz -> {} samples @ {}Hz)",
                    mono_samples.len(),
                    AUDIO_SAMPLE_RATE,
                    resampled.len(),
                    TARGET_SAMPLE_RATE
                );
            }

            if let Err(e) = channel.send(audio_payload) {
                log::error!("[ScreenCapture] Failed to send audio data: {:?}", e);
            }
        }),
        SCStreamOutputType::Audio,
    );

    // Start capturing
    log::info!("[ScreenCapture] Starting unified stream capture...");
    if let Err(e) = stream.start_capture() {
        return Err(Error::Platform(format!("Failed to start stream: {}", e)));
    }

    // Store the stream
    {
        let mut active_stream = state.active_stream.lock();
        *active_stream = Some(stream);
    }

    state.is_active.store(true, Ordering::SeqCst);

    // Start watchdog to auto-restart if stream dies silently
    start_watchdog(state.clone());

    log::info!("[ScreenCapture] Unified ScreenCaptureKit stream started (video+audio)");
    Ok(())
}

/// Stop capture if neither video nor audio is needed
fn maybe_stop_capture(state: &Arc<UnifiedCaptureState>) {
    let wants_video = state.wants_video.load(Ordering::SeqCst);
    let wants_audio = state.wants_audio.load(Ordering::SeqCst);

    if wants_video || wants_audio {
        log::info!(
            "[ScreenCapture] Not stopping stream: wants_video={}, wants_audio={}",
            wants_video,
            wants_audio
        );
        return;
    }

    if !state.is_active.load(Ordering::SeqCst) {
        return;
    }

    log::info!("[ScreenCapture] Stopping unified capture (neither video nor audio needed)...");

    state.is_active.store(false, Ordering::SeqCst);

    if let Some(stream) = state.active_stream.lock().take() {
        if let Err(e) = stream.stop_capture() {
            log::warn!("[ScreenCapture] Error stopping stream: {}", e);
        }
    }

    // Clear target
    {
        let mut target = state.selected_target.lock();
        *target = None;
    }

    log::info!("[ScreenCapture] Unified capture stopped");
}

/// Determine the capture buffer size in PIXELS for a given content filter.
///
/// `SCStreamConfiguration` sizes are in pixels, but `SCDisplay`/`SCWindow` frames are
/// in points. On a Retina display points are half the real pixels, so sizing the buffer
/// from frame points captures at half resolution — that downscale is what made frames
/// look soft/pixelated regardless of JPEG quality. macOS 14+ exposes the exact
/// point→pixel scale via `SCShareableContentInfo`, so we use it to capture at native
/// resolution. On older macOS the info isn't available (`for_filter` returns `None` via
/// the bridge's `@available` guard), so we fall back to the point dimensions — no
/// regression versus the previous behavior.
fn capture_pixel_dimensions(filter: &SCContentFilter, frame_w_pts: f64, frame_h_pts: f64) -> (u32, u32) {
    if let Some(info) = SCShareableContentInfo::for_filter(filter) {
        let (px_w, px_h) = info.pixel_size();
        if px_w > 0 && px_h > 0 {
            log::info!(
                "[ScreenCapture] Native pixel size {}x{} (point→pixel scale {:.1})",
                px_w,
                px_h,
                info.point_pixel_scale()
            );
            return output_dimensions(px_w as f64, px_h as f64);
        }
    }

    log::info!("[ScreenCapture] Native pixel size unavailable (macOS <14); using point dimensions");
    output_dimensions(frame_w_pts, frame_h_pts)
}

/// Pick an output buffer size that preserves the source's aspect ratio while capping the
/// width at the configured max width. Matching the source aspect ratio is what keeps
/// ScreenCaptureKit from padding frames with black bars. Dimensions are rounded to
/// even numbers to stay friendly to the capture pipeline.
fn output_dimensions(src_width: f64, src_height: f64) -> (u32, u32) {
    if !(src_width > 0.0) || !(src_height > 0.0) {
        return (1280, 720); // sensible 16:9 fallback if the source size is unknown
    }

    let max_width = capture_config::max_width() as f64;
    let (w, h) = if src_width > max_width {
        let scale = max_width / src_width;
        (max_width, src_height * scale)
    } else {
        (src_width, src_height)
    };

    // Round to even so width/height never produce an odd-stride buffer.
    let to_even = |v: f64| -> u32 {
        let r = v.round().max(2.0) as u32;
        r & !1
    };

    (to_even(w), to_even(h))
}

/// Encode a captured BGRA frame straight to JPEG.
///
/// ScreenCaptureKit delivers frames already scaled to our configured output size,
/// so there is no downscale step on macOS. We feed the BGRA bytes (respecting the
/// buffer's row stride) directly into the SIMD JPEG encoder — no intermediate
/// RGBA/RGB copies — which is what keeps the 10fps capture loop from backing up.
fn encode_bgra_frame(
    bgra: &[u8],
    width: u32,
    height: u32,
    bytes_per_row: usize,
    state: &Arc<UnifiedCaptureState>,
) -> Option<FrameData> {
    let w = width as usize;
    let h = height as usize;
    let row_bytes = w * 4;

    if bgra.len() < bytes_per_row * h {
        log::error!("[ScreenCapture] BGRA buffer smaller than expected, skipping frame");
        return None;
    }

    // jpeg-encoder wants tightly packed rows. CVPixelBuffer rows are frequently
    // padded for alignment, so compact only when there's real padding — unpadded
    // buffers are encoded in place with zero copies.
    let packed: std::borrow::Cow<[u8]> = if bytes_per_row == row_bytes {
        std::borrow::Cow::Borrowed(&bgra[..row_bytes * h])
    } else {
        let mut v = Vec::with_capacity(row_bytes * h);
        for y in 0..h {
            let start = y * bytes_per_row;
            v.extend_from_slice(&bgra[start..start + row_bytes]);
        }
        std::borrow::Cow::Owned(v)
    };

    let mut jpeg_bytes = Vec::new();
    let encoder = Encoder::new(&mut jpeg_bytes, capture_config::jpeg_quality());
    if let Err(e) = encoder.encode(&packed, width as u16, height as u16, ColorType::Bgra) {
        log::error!("[ScreenCapture] Failed to encode JPEG: {:?}", e);
        return None;
    }

    let current_frame = state.frame_count.fetch_add(1, Ordering::SeqCst);

    if current_frame == 0 {
        log::info!(
            "[ScreenCapture] First video frame processed ({}x{}, {} bytes)",
            width,
            height,
            jpeg_bytes.len()
        );
    }

    if current_frame % 100 == 0 && current_frame > 0 {
        log::info!("[ScreenCapture] Video stream alive: {} frames", current_frame);
    }

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();

    Some(FrameData {
        frame: jpeg_bytes,
        timestamp,
        width,
        height,
        frame_count: current_frame,
    })
}
