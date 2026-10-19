/**
 * PCM Audio Utilities for the Unified Audio Pipeline
 *
 * This module provides utilities for working with PCM audio data in the
 * unified transcription pipeline where all audio is standardized to:
 * - Format: Float32 PCM
 * - Sample Rate: 16kHz
 * - Channels: Mono
 */

/** Standard sample rate for transcription (Whisper standard) */
export const PCM_SAMPLE_RATE = 16000;

/** Standard chunk duration for transcription in milliseconds */
export const PCM_CHUNK_DURATION_MS = 100; // 100ms chunks for streaming

/** Number of samples in a standard chunk at 16kHz */
export const PCM_CHUNK_SAMPLES = PCM_SAMPLE_RATE * (PCM_CHUNK_DURATION_MS / 1000);

/**
 * Decode base64-encoded PCM f32 samples to Float32Array
 * This is the primary decoder for audio from Tauri/Rust backend
 *
 * @param base64 - Base64-encoded little-endian f32 samples
 * @returns Float32Array of audio samples in [-1, 1] range
 */
export function decodeBase64PCM(base64: string): Float32Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Float32Array(bytes.buffer);
}

/**
 * Encode Float32Array to base64 PCM format
 *
 * @param samples - Float32Array of audio samples
 * @returns Base64-encoded string
 */
export function encodeBase64PCM(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert Float32 samples to Int16 samples (for cloud APIs that expect Int16)
 *
 * @param samples - Float32Array in [-1, 1] range
 * @returns Int16Array scaled to [-32768, 32767]
 */
export function float32ToInt16(samples: Float32Array): Int16Array {
  const result = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    // Clamp to [-1, 1] and scale to Int16 range
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    result[i] = Math.round(clamped * 32767);
  }
  return result;
}

/**
 * Convert Int16 samples to Float32 samples
 *
 * @param samples - Int16Array in [-32768, 32767] range
 * @returns Float32Array scaled to [-1, 1]
 */
export function int16ToFloat32(samples: Int16Array): Float32Array {
  const result = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    result[i] = samples[i] / 32768;
  }
  return result;
}

/**
 * Create a WAV blob from Float32 PCM samples at 16kHz mono
 * Used for self-hosted Whisper APIs that expect WAV files
 *
 * @param samples - Float32Array of mono audio samples
 * @param sampleRate - Sample rate (default: 16000)
 * @returns Blob with audio/wav MIME type
 */
export function createWavBlob(samples: Float32Array, sampleRate: number = PCM_SAMPLE_RATE): Blob {
  // Convert to Int16 for WAV format
  const int16Samples = float32ToInt16(samples);

  // WAV header constants
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = int16Samples.length * (bitsPerSample / 8);
  const headerSize = 44;

  const buffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  // fmt sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Sub-chunk size
  view.setUint16(20, 1, true);  // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Write audio data
  const audioView = new Int16Array(buffer, headerSize);
  audioView.set(int16Samples);

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * PCM Buffer - Accumulates audio chunks for batched processing
 *
 * Used to buffer PCM samples before sending to transcription services
 * that require larger chunks (e.g., local Whisper wants ~15s buffers)
 */
export class PCMBuffer {
  private chunks: Float32Array[] = [];
  private totalSamples = 0;
  private readonly maxSamples: number;

  /**
   * Create a new PCM buffer
   *
   * @param maxDurationMs - Maximum buffer duration in milliseconds
   * @param sampleRate - Sample rate (default: 16000)
   */
  constructor(maxDurationMs: number, sampleRate: number = PCM_SAMPLE_RATE) {
    this.maxSamples = Math.floor(sampleRate * (maxDurationMs / 1000));
  }

  /**
   * Add samples to the buffer
   *
   * @param samples - Float32Array of audio samples to add
   */
  push(samples: Float32Array): void {
    this.chunks.push(samples);
    this.totalSamples += samples.length;
  }

  /**
   * Check if buffer is full (reached max duration)
   */
  isFull(): boolean {
    return this.totalSamples >= this.maxSamples;
  }

  /**
   * Get current buffer duration in milliseconds
   */
  getDurationMs(sampleRate: number = PCM_SAMPLE_RATE): number {
    return (this.totalSamples / sampleRate) * 1000;
  }

  /**
   * Get total number of samples in buffer
   */
  getSampleCount(): number {
    return this.totalSamples;
  }

  /**
   * Flush and concatenate all samples
   *
   * @returns Concatenated Float32Array of all buffered samples
   */
  flush(): Float32Array {
    if (this.chunks.length === 0) {
      return new Float32Array(0);
    }

    const result = new Float32Array(this.totalSamples);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    this.chunks = [];
    this.totalSamples = 0;
    return result;
  }

  /**
   * Clear buffer without returning data
   */
  clear(): void {
    this.chunks = [];
    this.totalSamples = 0;
  }

  /**
   * Check if buffer is empty
   */
  isEmpty(): boolean {
    return this.totalSamples === 0;
  }
}

/**
 * Compute RMS (Root Mean Square) level for audio samples
 * Useful for voice activity detection
 *
 * @param samples - Float32Array of audio samples
 * @returns RMS level (0 = silence, 1 = max amplitude)
 */
export function computeRMS(samples: Float32Array): number {
  if (samples.length === 0) return 0;

  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Simple voice activity detection based on RMS threshold
 *
 * @param samples - Float32Array of audio samples
 * @param threshold - RMS threshold (default: 0.01)
 * @returns true if voice activity detected
 */
export function hasVoiceActivity(samples: Float32Array, threshold: number = 0.01): boolean {
  return computeRMS(samples) > threshold;
}
