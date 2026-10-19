/**
 * PCM Audio Capture for Browser
 *
 * Captures audio from a MediaStream and extracts raw PCM samples at 16kHz mono.
 * Uses AudioWorklet for efficient real-time audio processing without the overhead
 * of MediaRecorder encoding/decoding.
 *
 * This is the browser-side equivalent of the Rust resampling layer - the browser's
 * AudioContext automatically handles resampling to our target rate.
 */

import { PCM_SAMPLE_RATE } from './pcmUtils';
import { Logger } from '@utils/logging';

/** Callback type for receiving PCM samples */
export type PCMCallback = (samples: Float32Array) => void;

/**
 * PCM Audio Capture - extracts raw PCM from MediaStream
 *
 * Key features:
 * - Uses AudioContext at 16kHz (browser auto-resamples)
 * - AudioWorklet extracts raw f32 samples
 * - No MediaRecorder overhead (encoding/decoding)
 * - Posts samples directly to callback
 */
export class PCMAudioCapture {
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private isRunning = false;
  private sampleCount = 0;

  /**
   * Start capturing PCM samples from a MediaStream
   *
   * @param stream - MediaStream with audio track(s)
   * @param onChunk - Callback for each PCM chunk (Float32Array @ 16kHz mono)
   */
  async start(stream: MediaStream, onChunk: PCMCallback): Promise<void> {
    if (this.isRunning) {
      Logger.warn('PCMAudioCapture', 'Already running, stopping first');
      this.stop();
    }

    try {
      // Create AudioContext at 16kHz - browser will auto-resample input
      this.audioContext = new AudioContext({ sampleRate: PCM_SAMPLE_RATE });

      // Log the actual sample rate (might differ on some browsers)
      const actualRate = this.audioContext.sampleRate;
      if (actualRate !== PCM_SAMPLE_RATE) {
        Logger.warn('PCMAudioCapture', `Requested ${PCM_SAMPLE_RATE}Hz but got ${actualRate}Hz`);
      }

      // Create inline AudioWorklet processor
      const workletCode = `
        class PCMExtractorProcessor extends AudioWorkletProcessor {
          constructor() {
            super();
          }

          process(inputs, outputs, parameters) {
            // Get first input, first channel (mono)
            const input = inputs[0];
            if (input && input.length > 0) {
              // Clone the data before posting (audio buffers are reused)
              const samples = new Float32Array(input[0]);
              this.port.postMessage(samples, [samples.buffer]);
            }
            return true; // Keep processor alive
          }
        }
        registerProcessor('pcm-extractor-processor', PCMExtractorProcessor);
      `;

      const blob = new Blob([workletCode], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);

      await this.audioContext.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      // Create worklet node
      this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-extractor-processor');

      // Handle samples from worklet
      this.workletNode.port.onmessage = (event) => {
        if (!this.isRunning) return;

        const samples = event.data as Float32Array;
        this.sampleCount += samples.length;

        // Log periodically
        if (this.sampleCount === samples.length) {
          Logger.info('PCMAudioCapture', `First chunk: ${samples.length} samples @ ${actualRate}Hz`);
        }

        // Pass samples to callback
        onChunk(samples);
      };

      // Connect stream -> source -> worklet
      this.sourceNode = this.audioContext.createMediaStreamSource(stream);
      this.sourceNode.connect(this.workletNode);

      // Note: We don't connect to destination (no playback) - just extraction

      this.isRunning = true;
      this.sampleCount = 0;

      Logger.info('PCMAudioCapture', `Started capturing at ${actualRate}Hz`);
    } catch (error) {
      Logger.error('PCMAudioCapture', `Failed to start: ${error}`);
      this.cleanup();
      throw error;
    }
  }

  /**
   * Stop capturing and clean up resources
   */
  stop(): void {
    if (!this.isRunning) return;

    const totalDuration = (this.sampleCount / PCM_SAMPLE_RATE).toFixed(2);
    Logger.info('PCMAudioCapture', `Stopped after ${this.sampleCount} samples (${totalDuration}s)`);

    this.cleanup();
  }

  private cleanup(): void {
    this.isRunning = false;

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode.port.close();
      this.workletNode = null;
    }

    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
  }

  /**
   * Check if capture is currently running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Get total samples captured so far
   */
  getSampleCount(): number {
    return this.sampleCount;
  }

  /**
   * Get total duration captured in seconds
   */
  getDurationSeconds(): number {
    return this.sampleCount / PCM_SAMPLE_RATE;
  }
}

/**
 * Create a single PCM capture instance for the application
 * Each audio source should have its own instance
 */
export function createPCMAudioCapture(): PCMAudioCapture {
  return new PCMAudioCapture();
}
