//! Android JNI module for screen/audio capture
//!
//! This module provides JNI entry points for Kotlin to pass raw frame/audio data
//! to Rust for processing and Channel delivery. All heavy processing (JPEG encoding,
//! audio resampling) happens in Rust to match the desktop/iOS architecture.

use base64::{engine::general_purpose::STANDARD, Engine};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::RgbaImage;
use jni::objects::{JByteArray, JClass};
use jni::sys::jint;
use jni::JNIEnv;
use parking_lot::RwLock;
use rubato::{FftFixedIn, Resampler};
use serde::Serialize;
use std::io::Cursor;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::Channel;

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
    /// Base64-encoded PCM (f32 samples, little-endian, mono, 16kHz)
    pub samples: String,
    /// Unix timestamp in seconds
    pub timestamp: f64,
    /// Sample rate (always 16000 after resampling)
    pub sample_rate: u32,
    /// Number of samples in this chunk
    pub sample_count: usize,
}

// Capture settings - optimized for performance
const JPEG_QUALITY: u8 = 50;
const MAX_WIDTH: u32 = 1280;
const TARGET_SAMPLE_RATE: u32 = 16000;

/// Audio resampler that converts from native sample rate to 16kHz mono
struct AudioResampler {
    resampler: FftFixedIn<f32>,
    source_rate: u32,
    ratio: f64,
}

impl AudioResampler {
    fn new(source_rate: u32) -> Result<Self, String> {
        if source_rate == TARGET_SAMPLE_RATE {
            return Err("Source rate equals target rate, no resampling needed".to_string());
        }

        let chunk_size = 1024;

        let resampler = FftFixedIn::<f32>::new(
            source_rate as usize,
            TARGET_SAMPLE_RATE as usize,
            chunk_size,
            2,
            1, // Mono
        )
        .map_err(|e| format!("Failed to create resampler: {}", e))?;

        let ratio = TARGET_SAMPLE_RATE as f64 / source_rate as f64;

        log::info!(
            "[AndroidCapture] Created resampler: {}Hz -> {}Hz (ratio: {:.4})",
            source_rate,
            TARGET_SAMPLE_RATE,
            ratio
        );

        Ok(Self {
            resampler,
            source_rate,
            ratio,
        })
    }

    fn resample(&mut self, input: &[f32]) -> Result<Vec<f32>, String> {
        if input.is_empty() {
            return Ok(Vec::new());
        }

        let chunk_size = self.resampler.input_frames_max();
        let mut output =
            Vec::with_capacity((input.len() as f64 * self.ratio) as usize + chunk_size);

        let mut pos = 0;
        while pos < input.len() {
            let end = (pos + chunk_size).min(input.len());
            let chunk = &input[pos..end];

            let padded: Vec<f32>;
            let input_slice = if chunk.len() < chunk_size {
                padded = chunk
                    .iter()
                    .cloned()
                    .chain(std::iter::repeat(0.0).take(chunk_size - chunk.len()))
                    .collect();
                &padded[..]
            } else {
                chunk
            };

            let input_channels = vec![input_slice.to_vec()];

            match self.resampler.process(&input_channels, None) {
                Ok(resampled) => {
                    if !resampled.is_empty() && !resampled[0].is_empty() {
                        if chunk.len() < chunk_size {
                            let expected_output =
                                (chunk.len() as f64 * self.ratio).ceil() as usize;
                            output.extend_from_slice(
                                &resampled[0][..expected_output.min(resampled[0].len())],
                            );
                        } else {
                            output.extend_from_slice(&resampled[0]);
                        }
                    }
                }
                Err(e) => {
                    log::warn!("[AndroidCapture] Resampling error: {}", e);
                    break;
                }
            }

            pos = end;
        }

        Ok(output)
    }
}

/// Thread-safe wrapper for AudioResampler with lazy initialization
struct SharedResampler {
    inner: Mutex<Option<AudioResampler>>,
    source_rate: u32,
}

impl SharedResampler {
    fn new(source_rate: u32) -> Self {
        Self {
            inner: Mutex::new(None),
            source_rate,
        }
    }

    fn resample(&self, input: &[f32]) -> Result<Vec<f32>, String> {
        if self.source_rate == TARGET_SAMPLE_RATE {
            return Ok(input.to_vec());
        }

        let mut guard = self
            .inner
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;

        if guard.is_none() {
            *guard = Some(AudioResampler::new(self.source_rate)?);
        }

        guard.as_mut().unwrap().resample(input)
    }

    fn reset(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = None;
        }
    }
}

/// Shared state for Android capture channels
struct AndroidCaptureState {
    frame_channel: RwLock<Option<Channel<FrameData>>>,
    audio_channel: RwLock<Option<Channel<AudioData>>>,
    audio_resampler: SharedResampler,
    frame_count: std::sync::atomic::AtomicU64,
}

impl AndroidCaptureState {
    fn new() -> Self {
        Self {
            frame_channel: RwLock::new(None),
            audio_channel: RwLock::new(None),
            audio_resampler: SharedResampler::new(48000), // Android typically captures at 48kHz
            frame_count: std::sync::atomic::AtomicU64::new(0),
        }
    }
}

static CAPTURE_STATE: OnceLock<Arc<AndroidCaptureState>> = OnceLock::new();

fn get_state() -> Arc<AndroidCaptureState> {
    CAPTURE_STATE
        .get_or_init(|| Arc::new(AndroidCaptureState::new()))
        .clone()
}

/// Store the video channel from Tauri command
pub fn set_frame_channel(channel: Channel<FrameData>) {
    let state = get_state();
    let mut guard = state.frame_channel.write();
    *guard = Some(channel);
    state
        .frame_count
        .store(0, std::sync::atomic::Ordering::SeqCst);
    log::info!("[AndroidCapture] Frame channel set");
}

/// Clear the video channel
pub fn clear_frame_channel() {
    let state = get_state();
    let mut guard = state.frame_channel.write();
    *guard = None;
    log::info!("[AndroidCapture] Frame channel cleared");
}

/// Store the audio channel from Tauri command
pub fn set_audio_channel(channel: Channel<AudioData>) {
    let state = get_state();
    let mut guard = state.audio_channel.write();
    *guard = Some(channel);
    state.audio_resampler.reset();
    log::info!("[AndroidCapture] Audio channel set");
}

/// Clear the audio channel
pub fn clear_audio_channel() {
    let state = get_state();
    let mut guard = state.audio_channel.write();
    *guard = None;
    log::info!("[AndroidCapture] Audio channel cleared");
}

/// Check if video streaming is active
pub fn is_video_streaming() -> bool {
    let state = get_state();
    let result = state.frame_channel.read().is_some();
    result
}

/// Check if audio streaming is active
pub fn is_audio_streaming() -> bool {
    let state = get_state();
    let result = state.audio_channel.read().is_some();
    result
}

/// JNI entry point: Called from Kotlin when a video frame is available
///
/// # Safety
/// This function is called from JNI and must handle raw JNI types safely
#[no_mangle]
pub extern "system" fn Java_com_plugin_screencapture_ScreenCaptureService_nativeOnFrame(
    env: JNIEnv,
    _class: JClass,
    rgba: JByteArray,
    width: jint,
    height: jint,
    stride: jint,
) {
    let state = get_state();
    let channel = state.frame_channel.read();

    if channel.is_none() {
        return;
    }

    // Convert JByteArray to Vec<u8>
    let rgba_bytes = match env.convert_byte_array(&rgba) {
        Ok(bytes) => bytes,
        Err(e) => {
            log::error!("[AndroidCapture] Failed to convert byte array: {:?}", e);
            return;
        }
    };

    // Process frame: RGBA → JPEG → base64 → FrameData
    let frame_count = state
        .frame_count
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);

    if let Some(frame_data) = process_frame(&rgba_bytes, width, height, stride, frame_count) {
        if frame_count == 0 {
            log::info!(
                "[AndroidCapture] First frame processed ({}x{}, {} bytes encoded)",
                frame_data.width,
                frame_data.height,
                frame_data.frame.len()
            );
        }

        if let Some(ch) = channel.as_ref() {
            if let Err(e) = ch.send(frame_data) {
                log::error!("[AndroidCapture] Failed to send frame: {:?}", e);
            }
        }
    }
}

/// JNI entry point: Called from Kotlin when audio data is available
///
/// # Safety
/// This function is called from JNI and must handle raw JNI types safely
#[no_mangle]
pub extern "system" fn Java_com_plugin_screencapture_AudioCaptureManager_nativeOnAudio(
    env: JNIEnv,
    _class: JClass,
    pcm: JByteArray,
    sample_rate: jint,
) {
    let state = get_state();
    let channel = state.audio_channel.read();

    if channel.is_none() {
        return;
    }

    // Convert JByteArray to Vec<u8>
    let pcm_bytes = match env.convert_byte_array(&pcm) {
        Ok(bytes) => bytes,
        Err(e) => {
            log::error!("[AndroidCapture] Failed to convert audio byte array: {:?}", e);
            return;
        }
    };

    // Process audio: PCM → resample → base64 → AudioData
    if let Some(audio_data) = process_audio(&pcm_bytes, sample_rate, &state.audio_resampler) {
        if let Some(ch) = channel.as_ref() {
            if let Err(e) = ch.send(audio_data) {
                log::error!("[AndroidCapture] Failed to send audio: {:?}", e);
            }
        }
    }
}

/// Process raw RGBA frame data into FrameData
fn process_frame(
    rgba: &[u8],
    width: jint,
    height: jint,
    stride: jint,
    frame_count: u64,
) -> Option<FrameData> {
    let width = width as u32;
    let height = height as u32;
    let stride = stride as u32;

    // Handle stride padding - Android ImageReader may have row padding
    let expected_stride = width * 4; // 4 bytes per RGBA pixel

    let image_data = if stride > expected_stride {
        // Need to remove padding from each row
        let mut unpacked = Vec::with_capacity((width * height * 4) as usize);
        for row in 0..height {
            let row_start = (row * stride) as usize;
            let row_end = row_start + (width * 4) as usize;
            if row_end <= rgba.len() {
                unpacked.extend_from_slice(&rgba[row_start..row_end]);
            }
        }
        unpacked
    } else {
        rgba.to_vec()
    };

    // Create RgbaImage
    let image = match RgbaImage::from_raw(width, height, image_data) {
        Some(img) => img,
        None => {
            log::error!(
                "[AndroidCapture] Failed to create image from raw data ({}x{})",
                width,
                height
            );
            return None;
        }
    };

    // Downscale if too large
    let resized = if width > MAX_WIDTH {
        let scale = MAX_WIDTH as f32 / width as f32;
        let new_height = (height as f32 * scale) as u32;
        image::imageops::resize(&image, MAX_WIDTH, new_height, FilterType::Nearest)
    } else {
        image
    };

    let final_width = resized.width();
    let final_height = resized.height();

    // Convert RGBA to RGB for JPEG encoding
    let rgba_bytes = resized.as_raw();
    let mut rgb_bytes = Vec::with_capacity((final_width * final_height * 3) as usize);
    for chunk in rgba_bytes.chunks_exact(4) {
        rgb_bytes.push(chunk[0]); // R
        rgb_bytes.push(chunk[1]); // G
        rgb_bytes.push(chunk[2]); // B
    }

    // Encode to JPEG
    let mut jpeg_buffer = Cursor::new(Vec::new());
    let mut encoder = JpegEncoder::new_with_quality(&mut jpeg_buffer, JPEG_QUALITY);

    if let Err(e) = encoder.encode(
        &rgb_bytes,
        final_width,
        final_height,
        image::ExtendedColorType::Rgb8,
    ) {
        log::error!("[AndroidCapture] Failed to encode JPEG: {:?}", e);
        return None;
    }

    let jpeg_bytes = jpeg_buffer.into_inner();
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();

    Some(FrameData {
        frame: jpeg_bytes,
        timestamp,
        width: final_width,
        height: final_height,
        frame_count,
    })
}

/// Process raw PCM audio data into AudioData
fn process_audio(
    pcm_bytes: &[u8],
    sample_rate: jint,
    resampler: &SharedResampler,
) -> Option<AudioData> {
    if pcm_bytes.is_empty() {
        return None;
    }

    // Convert bytes to f32 samples (assuming little-endian f32 from Kotlin)
    let samples: Vec<f32> = pcm_bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect();

    if samples.is_empty() {
        return None;
    }

    // Resample to 16kHz if needed
    let resampled = if sample_rate as u32 != TARGET_SAMPLE_RATE {
        match resampler.resample(&samples) {
            Ok(r) => r,
            Err(e) => {
                log::warn!("[AndroidCapture] Resampling failed: {}", e);
                // Fall back to linear resampling
                resample_linear(&samples, sample_rate as u32, TARGET_SAMPLE_RATE)
            }
        }
    } else {
        samples
    };

    if resampled.is_empty() {
        return None;
    }

    // Convert back to bytes for base64 encoding
    let mut output_bytes = Vec::with_capacity(resampled.len() * 4);
    for sample in &resampled {
        output_bytes.extend_from_slice(&sample.to_le_bytes());
    }

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();

    Some(AudioData {
        samples: STANDARD.encode(&output_bytes),
        timestamp,
        sample_rate: TARGET_SAMPLE_RATE,
        sample_count: resampled.len(),
    })
}

/// Simple linear interpolation resampler (fallback)
fn resample_linear(input: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if source_rate == target_rate || input.is_empty() {
        return input.to_vec();
    }

    let ratio = source_rate as f64 / target_rate as f64;
    let output_len = (input.len() as f64 / ratio).ceil() as usize;
    let mut output = Vec::with_capacity(output_len);

    for i in 0..output_len {
        let src_pos = i as f64 * ratio;
        let src_idx = src_pos.floor() as usize;
        let frac = src_pos - src_idx as f64;

        let sample = if src_idx + 1 < input.len() {
            input[src_idx] * (1.0 - frac as f32) + input[src_idx + 1] * frac as f32
        } else if src_idx < input.len() {
            input[src_idx]
        } else {
            0.0
        };

        output.push(sample);
    }

    output
}
