//! Unified PCM Audio Pipeline - Resampling utilities for 16kHz mono output
//!
//! This module provides audio resampling from native capture rates to 16kHz mono,
//! which is the standard format for both local Whisper and cloud transcription.
//!
//! Supported source rates:
//! - macOS: 48000 Hz
//! - Windows: 48000 Hz (typical, but varies by device)
//! - iOS: 44100 Hz

use rubato::{FftFixedIn, Resampler};
use std::sync::{Arc, Mutex};

/// Target sample rate for transcription (Whisper standard)
pub const TARGET_SAMPLE_RATE: u32 = 16000;

/// Audio resampler that converts from native sample rate to 16kHz mono
pub struct AudioResampler {
    resampler: FftFixedIn<f32>,
    source_rate: u32,
    /// Ratio for sample count calculation
    ratio: f64,
}

impl AudioResampler {
    /// Create a new resampler for the given source sample rate
    ///
    /// # Arguments
    /// * `source_rate` - The input sample rate (e.g., 48000, 44100)
    ///
    /// # Returns
    /// A new AudioResampler or an error if creation fails
    pub fn new(source_rate: u32) -> Result<Self, String> {
        if source_rate == TARGET_SAMPLE_RATE {
            return Err("Source rate equals target rate, no resampling needed".to_string());
        }

        // Use a chunk size that works well for audio buffers (1024 samples is typical)
        // FftFixedIn requires input to be exactly this size, so we'll handle buffering
        let chunk_size = 1024;

        let resampler = FftFixedIn::<f32>::new(
            source_rate as usize,
            TARGET_SAMPLE_RATE as usize,
            chunk_size,
            2,  // Sub-chunks for interpolation
            1,  // Mono channel
        ).map_err(|e| format!("Failed to create resampler: {}", e))?;

        let ratio = TARGET_SAMPLE_RATE as f64 / source_rate as f64;

        log::info!(
            "[AudioPipeline] Created resampler: {}Hz -> {}Hz (ratio: {:.4})",
            source_rate, TARGET_SAMPLE_RATE, ratio
        );

        Ok(Self {
            resampler,
            source_rate,
            ratio,
        })
    }

    /// Get the source sample rate this resampler was configured for
    pub fn source_rate(&self) -> u32 {
        self.source_rate
    }

    /// Resample audio from source rate to 16kHz
    ///
    /// # Arguments
    /// * `input` - Mono f32 samples at the source sample rate
    ///
    /// # Returns
    /// Resampled mono f32 samples at 16kHz
    pub fn resample(&mut self, input: &[f32]) -> Result<Vec<f32>, String> {
        if input.is_empty() {
            return Ok(Vec::new());
        }

        let chunk_size = self.resampler.input_frames_max();
        let mut output = Vec::with_capacity((input.len() as f64 * self.ratio) as usize + chunk_size);

        // Process in chunks
        let mut pos = 0;
        while pos < input.len() {
            let end = (pos + chunk_size).min(input.len());
            let chunk = &input[pos..end];

            // Pad if necessary (last chunk might be smaller)
            let padded: Vec<f32>;
            let input_slice = if chunk.len() < chunk_size {
                padded = chunk.iter()
                    .cloned()
                    .chain(std::iter::repeat(0.0).take(chunk_size - chunk.len()))
                    .collect();
                &padded[..]
            } else {
                chunk
            };

            // Resample requires Vec<Vec<f32>> for multi-channel (we use mono)
            let input_channels = vec![input_slice.to_vec()];

            match self.resampler.process(&input_channels, None) {
                Ok(resampled) => {
                    if !resampled.is_empty() && !resampled[0].is_empty() {
                        // For partial last chunk, only take proportional output
                        if chunk.len() < chunk_size {
                            let expected_output = (chunk.len() as f64 * self.ratio).ceil() as usize;
                            output.extend_from_slice(&resampled[0][..expected_output.min(resampled[0].len())]);
                        } else {
                            output.extend_from_slice(&resampled[0]);
                        }
                    }
                }
                Err(e) => {
                    log::warn!("[AudioPipeline] Resampling error: {}", e);
                    // On error, return what we have so far
                    break;
                }
            }

            pos = end;
        }

        Ok(output)
    }
}

/// Thread-safe wrapper for AudioResampler
pub struct SharedResampler {
    inner: Arc<Mutex<Option<AudioResampler>>>,
    source_rate: u32,
}

impl SharedResampler {
    /// Create a new shared resampler (lazy initialization)
    pub fn new(source_rate: u32) -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            source_rate,
        }
    }

    /// Resample audio, initializing the resampler on first use
    pub fn resample(&self, input: &[f32]) -> Result<Vec<f32>, String> {
        // Skip if already at target rate
        if self.source_rate == TARGET_SAMPLE_RATE {
            return Ok(input.to_vec());
        }

        let mut guard = self.inner.lock().map_err(|e| format!("Lock poisoned: {}", e))?;

        // Lazy initialization
        if guard.is_none() {
            *guard = Some(AudioResampler::new(self.source_rate)?);
        }

        guard.as_mut().unwrap().resample(input)
    }

    /// Reset the resampler state (e.g., when stream restarts)
    pub fn reset(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = None;
        }
    }
}

/// Simple linear interpolation resampler for when rubato isn't needed
/// (simpler, lower quality, but guaranteed to work)
pub fn resample_linear(input: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resample_48k_to_16k() {
        let mut resampler = AudioResampler::new(48000).expect("Failed to create resampler");

        // Generate 1 second of 48kHz silence
        let input: Vec<f32> = vec![0.0; 48000];
        let output = resampler.resample(&input).expect("Failed to resample");

        // Should be approximately 16000 samples (within reasonable margin)
        assert!(output.len() > 15000 && output.len() < 17000,
            "Expected ~16000 samples, got {}", output.len());
    }

    #[test]
    fn test_resample_44k_to_16k() {
        let mut resampler = AudioResampler::new(44100).expect("Failed to create resampler");

        // Generate 1 second of 44.1kHz silence
        let input: Vec<f32> = vec![0.0; 44100];
        let output = resampler.resample(&input).expect("Failed to resample");

        // Should be approximately 16000 samples
        assert!(output.len() > 15000 && output.len() < 17000,
            "Expected ~16000 samples, got {}", output.len());
    }

    #[test]
    fn test_linear_resample() {
        // Generate a simple sine wave at 48kHz
        let input: Vec<f32> = (0..4800)
            .map(|i| (i as f32 * std::f32::consts::PI * 2.0 / 480.0).sin())
            .collect();

        let output = resample_linear(&input, 48000, 16000);

        // Should be ~1600 samples (4800 / 3)
        assert!(output.len() == 1600, "Expected 1600 samples, got {}", output.len());
    }

    #[test]
    fn test_shared_resampler() {
        let shared = SharedResampler::new(48000);

        let input: Vec<f32> = vec![0.5; 1024];
        let output = shared.resample(&input).expect("Failed to resample");

        // Should be approximately 341 samples (1024 / 3)
        assert!(output.len() > 300 && output.len() < 400,
            "Expected ~341 samples, got {}", output.len());
    }

    #[test]
    fn test_passthrough_when_same_rate() {
        let shared = SharedResampler::new(TARGET_SAMPLE_RATE);

        let input: Vec<f32> = vec![0.5; 1024];
        let output = shared.resample(&input).expect("Failed to resample");

        // Should be exact same length (no resampling)
        assert_eq!(output.len(), 1024);
    }
}
