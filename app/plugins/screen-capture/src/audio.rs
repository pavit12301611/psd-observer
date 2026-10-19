//! Cross-platform system audio capture using platform-specific native APIs.
//!
//! This module is for Windows and Linux only.
//! macOS audio capture is handled by the unified ScreenCaptureKit module in macos.rs.
//!
//! Platform implementations:
//! - Windows: WASAPI loopback API
//! - Linux: Not yet supported (would use PulseAudio/PipeWire)

#[allow(unused_imports)]
use crate::audio_pipeline::{SharedResampler, TARGET_SAMPLE_RATE};
#[allow(unused_imports)]
use crate::error::{Error, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;

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

/// Shared audio capture state
struct AudioCaptureState {
    /// Whether audio capture is currently active
    is_active: AtomicBool,
}

impl AudioCaptureState {
    fn new() -> Self {
        Self {
            is_active: AtomicBool::new(false),
        }
    }
}

/// Global audio capture state
static AUDIO_STATE: std::sync::OnceLock<Arc<AudioCaptureState>> = std::sync::OnceLock::new();

fn get_audio_state() -> Arc<AudioCaptureState> {
    AUDIO_STATE
        .get_or_init(|| Arc::new(AudioCaptureState::new()))
        .clone()
}

// ==================== Windows WASAPI Implementation ====================

#[cfg(target_os = "windows")]
mod windows_audio {
    use super::*;
    use std::sync::Mutex;
    use std::thread;
    use wasapi::*;

    static AUDIO_CAPTURE: std::sync::OnceLock<Mutex<Option<AudioCapture>>> =
        std::sync::OnceLock::new();

    fn get_audio_capture() -> &'static Mutex<Option<AudioCapture>> {
        AUDIO_CAPTURE.get_or_init(|| Mutex::new(None))
    }

    struct AudioCapture {
        stop_signal: Arc<AtomicBool>,
        thread_handle: Option<thread::JoinHandle<()>>,
    }

    impl Drop for AudioCapture {
        fn drop(&mut self) {
            log::info!("[AudioCapture] Dropping Windows audio capture");
            self.stop_signal.store(true, Ordering::SeqCst);
            if let Some(handle) = self.thread_handle.take() {
                let _ = handle.join();
            }
        }
    }

    pub fn start_capture(on_audio: Channel<AudioData>) -> Result<()> {
        let state = get_audio_state();

        // Check if already active
        if state.is_active.load(Ordering::SeqCst) {
            log::warn!("[AudioCapture] Audio capture already active, stopping first...");
            stop_capture()?;
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        log::info!("[AudioCapture] Starting Windows WASAPI loopback capture");

        let stop_signal = Arc::new(AtomicBool::new(false));
        let stop_signal_clone = stop_signal.clone();

        let thread_handle = thread::spawn(move || {
            log::info!("[AudioCapture] Windows capture thread started");

            // Initialize COM for this thread
            if let Err(e) = initialize_mta().ok() {
                log::error!("[AudioCapture] Failed to initialize COM: {:?}", e);
                return;
            }

            let chunk_count = Arc::new(std::sync::atomic::AtomicU64::new(0));

            // Run the capture loop
            if let Err(e) = run_capture_loop(on_audio, stop_signal_clone, chunk_count) {
                log::error!("[AudioCapture] Capture loop error: {:?}", e);
            }

            log::info!("[AudioCapture] Windows capture thread stopped");
        });

        let capture = AudioCapture {
            stop_signal,
            thread_handle: Some(thread_handle),
        };

        {
            let mut capture_holder = get_audio_capture().lock().unwrap();
            *capture_holder = Some(capture);
        }

        // Mark as active
        state.is_active.store(true, Ordering::SeqCst);

        log::info!("[AudioCapture] Windows WASAPI loopback capture started");

        Ok(())
    }

    fn run_capture_loop(
        on_audio: Channel<AudioData>,
        stop_signal: Arc<AtomicBool>,
        chunk_count: Arc<std::sync::atomic::AtomicU64>,
    ) -> std::result::Result<(), Box<dyn std::error::Error>> {
        // Get default audio render device (speakers/headphones)
        log::info!("[AudioCapture] Getting default audio render device...");
        let enumerator = DeviceEnumerator::new()?;
        let device = enumerator.get_default_device(&Direction::Render)?;

        log::info!("[AudioCapture] Initializing audio client for loopback capture...");
        let mut audio_client = device.get_iaudioclient()?;

        // Get the default format
        let wave_format = audio_client.get_mixformat()?;
        log::info!(
            "[AudioCapture] Device format: {}Hz, {} channels, {} bits",
            wave_format.get_samplespersec(),
            wave_format.get_nchannels(),
            wave_format.get_bitspersample()
        );

        // Initialize in loopback mode (shared mode, capture direction)
        let blockalign = wave_format.get_blockalign();
        let (def_time, min_time) = audio_client.get_device_period()?;
        log::info!(
            "[AudioCapture] Default period: {} ns, Minimum period: {} ns",
            def_time,
            min_time
        );

        audio_client.initialize_client(
            &wave_format,
            &Direction::Capture, // Capture direction for loopback
            &StreamMode::PollingShared {
                autoconvert: false,
                buffer_duration_hns: def_time,
            },
        )?;

        log::info!("[AudioCapture] Getting audio capture client...");
        let capture_client = audio_client.get_audiocaptureclient()?;

        log::info!("[AudioCapture] Starting audio client...");
        audio_client.start_stream()?;

        log::info!("[AudioCapture] Loopback capture started, reading audio data...");

        let sample_rate = wave_format.get_samplespersec();
        let channels = wave_format.get_nchannels() as u16;
        let bits_per_sample = wave_format.get_bitspersample();

        // Create resampler for 16kHz output (transcription standard)
        let resampler = SharedResampler::new(sample_rate);
        log::info!(
            "[AudioCapture] Audio pipeline: {}Hz -> {}Hz resampling enabled",
            sample_rate,
            TARGET_SAMPLE_RATE
        );

        // The rubato FftFixedIn resampler requires exactly 1024 input samples per call.
        // WASAPI polling at 10ms delivers only ~480 samples at 48kHz — less than one full
        // chunk. Zero-padding every single call injects a 100Hz periodic artifact into the
        // FFT output, which is heard as robotic voice. We accumulate samples here and only
        // resample when we have at least one complete 1024-sample chunk.
        const RESAMPLE_CHUNK_SIZE: usize = 1024;
        let mut sample_accumulator: Vec<f32> = Vec::with_capacity(RESAMPLE_CHUNK_SIZE * 4);

        // Capture loop
        while !stop_signal.load(Ordering::SeqCst) {
            // Sleep a bit to avoid busy waiting
            thread::sleep(std::time::Duration::from_millis(10));

            // Get number of frames available in next packet
            let frames_available = match capture_client.get_next_packet_size() {
                Ok(Some(frames)) => frames,
                Ok(None) => continue, // exclusive mode returns None
                Err(e) => {
                    log::debug!("[AudioCapture] Error getting frame count: {:?}", e);
                    continue;
                }
            };

            if frames_available == 0 {
                continue;
            }

            // Allocate buffer and read audio data
            let mut buf = vec![0u8; frames_available as usize * blockalign as usize];
            let data = match capture_client.read_from_device(&mut buf) {
                Ok(_) => buf,
                Err(e) => {
                    log::error!("[AudioCapture] Error reading audio buffer: {:?}", e);
                    continue;
                }
            };

            if data.is_empty() {
                continue;
            }

            // Convert audio data to f32 based on bit depth
            let f32_samples: Vec<f32> = match bits_per_sample {
                32 => {
                    // Already f32, just reinterpret bytes
                    data.chunks_exact(4)
                        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                        .collect()
                }
                16 => {
                    // Convert i16 to f32
                    data.chunks_exact(2)
                        .map(|chunk| {
                            let sample = i16::from_le_bytes([chunk[0], chunk[1]]);
                            sample as f32 / 32768.0
                        })
                        .collect()
                }
                _ => {
                    log::warn!("[AudioCapture] Unsupported bit depth: {}", bits_per_sample);
                    continue;
                }
            };

            // Mix down to mono by averaging all channels
            let ch = channels as usize;
            let mono_samples: Vec<f32> = if ch > 1 {
                f32_samples
                    .chunks(ch)
                    .map(|frame| frame.iter().sum::<f32>() / ch as f32)
                    .collect()
            } else {
                f32_samples
            };

            // Accumulate samples before resampling.
            // WASAPI polling at 10ms delivers ~480 samples at 48kHz, but rubato's
            // FftFixedIn requires exactly 1024 samples per call. Feeding it smaller
            // zero-padded chunks on every single poll injects a 100Hz periodic
            // spectral artifact (the "robotic voice"). We buffer here and only
            // resample once we have at least one full 1024-sample chunk.
            sample_accumulator.extend_from_slice(&mono_samples);

            if sample_accumulator.len() < RESAMPLE_CHUNK_SIZE {
                continue;
            }

            // Process only complete chunks; keep the remainder for the next iteration
            let complete_len =
                (sample_accumulator.len() / RESAMPLE_CHUNK_SIZE) * RESAMPLE_CHUNK_SIZE;
            let to_resample: Vec<f32> = sample_accumulator[..complete_len].to_vec();
            sample_accumulator.drain(..complete_len);

            let count = chunk_count.fetch_add(1, Ordering::SeqCst) + 1;

            // Resample from native rate to 16kHz for transcription (no zero-padding)
            let resampled = match resampler.resample(&to_resample) {
                Ok(samples) => samples,
                Err(e) => {
                    if count % 100 == 1 {
                        log::warn!("[AudioCapture] Resampling failed, using original: {}", e);
                    }
                    to_resample.clone()
                }
            };

            // Convert resampled f32 samples to bytes
            let bytes: Vec<u8> = resampled
                .iter()
                .flat_map(|&sample| sample.to_le_bytes())
                .collect();

            // Get timestamp
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64();

            // Create AudioData payload with 16kHz sample rate
            let audio_payload = AudioData {
                samples: STANDARD.encode(&bytes),
                timestamp,
                sample_rate: TARGET_SAMPLE_RATE,
                chunk_count: count,
            };

            if count == 1 {
                log::info!(
                    "[AudioCapture] First audio batch sent ({} accumulated samples @ {}Hz -> {} @ {}Hz)",
                    to_resample.len(),
                    sample_rate,
                    resampled.len(),
                    TARGET_SAMPLE_RATE
                );
            }

            if count % 500 == 0 {
                log::debug!("[AudioCapture] Sent {} audio batches", count);
            }

            // Send through channel
            if let Err(e) = on_audio.send(audio_payload) {
                log::error!("[AudioCapture] Failed to send audio data: {:?}", e);
                break;
            }
        }

        log::info!("[AudioCapture] Stopping audio client...");
        audio_client.stop_stream()?;

        Ok(())
    }

    pub fn stop_capture() -> Result<()> {
        let state = get_audio_state();

        if !state.is_active.load(Ordering::SeqCst) {
            log::info!("[AudioCapture] Audio capture not active");
            return Ok(());
        }

        log::info!("[AudioCapture] Stopping Windows audio capture...");

        // Mark as inactive first
        state.is_active.store(false, Ordering::SeqCst);

        // Stop the capture thread
        let mut capture_holder = get_audio_capture().lock().unwrap();
        if let Some(capture) = capture_holder.take() {
            drop(capture); // Drop will stop the thread
        }

        log::info!("[AudioCapture] Windows audio capture stopped");
        Ok(())
    }
}

// ==================== Platform-Specific Public API ====================

/// Start system audio capture (Windows)
#[cfg(target_os = "windows")]
pub fn start_audio_stream(on_audio: Channel<AudioData>) -> Result<()> {
    windows_audio::start_capture(on_audio)
}

/// Start system audio capture (Linux - not supported)
#[cfg(target_os = "linux")]
pub fn start_audio_stream(_on_audio: Channel<AudioData>) -> Result<()> {
    log::error!("[AudioCapture] System audio capture not supported on Linux");
    Err(Error::AudioDevice(
        "System audio capture not supported on Linux. Please use PulseAudio/PipeWire monitoring."
            .to_string(),
    ))
}

/// Stop audio capture (Windows)
#[cfg(target_os = "windows")]
pub fn stop_audio() -> Result<()> {
    windows_audio::stop_capture()
}

/// Stop audio capture (Linux)
#[cfg(target_os = "linux")]
pub fn stop_audio() -> Result<()> {
    let state = get_audio_state();
    state.is_active.store(false, Ordering::SeqCst);
    log::info!("[AudioCapture] Audio capture stopped (Linux - not implemented)");
    Ok(())
}

/// Check if audio capture is currently active
pub fn is_audio_active() -> bool {
    get_audio_state().is_active.load(Ordering::SeqCst)
}
