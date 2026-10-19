/**
 * Unified Transcription Service
 *
 * Single service that handles all transcription modes (local, cloud, self-hosted)
 * with PCM f32 @ 16kHz mono input from the unified audio pipeline.
 *
 * Key differences from legacy services:
 * - Accepts raw PCM samples via feedPCM() instead of MediaStream
 * - No MediaRecorder/encoding overhead
 * - Direct Float32Array to Whisper worker (local mode)
 * - Efficient Int16 conversion for cloud streaming
 * - WAV creation for self-hosted REST APIs
 */

import { TranscriptionMode, UnifiedTranscriptionConfig, DEFAULT_UNIFIED_CONFIG } from './types';
import { WhisperModelManager } from './WhisperModelManager';
import { TranscriptionRouter } from './TranscriptionRouter';
import { TranscriptionSubscriber } from './TranscriptionSubscriber';
import { TranscriptionStateManager } from './TranscriptionStateManager';
import { AudioStreamType } from '../streamManager';
import { SensorSettings } from '../settings';
import { Logger } from '../logging';
import { PCMBuffer, float32ToInt16, createWavBlob, PCM_SAMPLE_RATE } from '../audio/pcmUtils';
import { platformFetch } from '../platform';

/** Cloud WebSocket URL */
const CLOUD_WS_URL = 'wss://api.observer-ai.com/v1/audio/transcriptions/stream';

/**
 * Unified Transcription Service - single implementation for all modes
 */
export class UnifiedTranscriptionService {
  private mode: TranscriptionMode;
  private config: UnifiedTranscriptionConfig;
  private streamType: AudioStreamType = 'microphone';
  private isRunning = false;
  private chunkCounter = 0;

  // Subscriber management
  private subscribers = new Set<TranscriptionSubscriber>();

  // Mode-specific state
  private pcmBuffer: PCMBuffer | null = null;
  private ws: WebSocket | null = null;
  private cloudStreamBuffer: Int16Array[] = [];
  private cloudStreamTimer: ReturnType<typeof setInterval> | null = null;

  // Cleanup for interim result listener (local mode)
  private unsubscribeInterimResults: (() => void) | null = null;

  // Track last audio received for cloud mode reconnect logic
  private lastAudioReceivedAt: number | null = null;

  constructor(mode?: TranscriptionMode, config?: Partial<UnifiedTranscriptionConfig>) {
    this.mode = mode ?? SensorSettings.getTranscriptionMode();
    this.config = { ...DEFAULT_UNIFIED_CONFIG, ...config, mode: this.mode };

    Logger.info('UnifiedTranscriptionService', `Created with mode: ${this.mode}`);
  }

  /**
   * Start the transcription service for a given stream type.
   * Note: This service doesn't need a MediaStream - it receives PCM via feedPCM()
   */
  async start(streamType: AudioStreamType): Promise<void>;
  async start(stream: MediaStream, streamType?: AudioStreamType): Promise<void>;
  async start(
    streamOrType: MediaStream | AudioStreamType,
    streamType?: AudioStreamType
  ): Promise<void> {
    if (this.isRunning) {
      Logger.warn('UnifiedTranscriptionService', 'Service already running');
      return;
    }

    // Handle overloaded parameters
    if (typeof streamOrType === 'string') {
      this.streamType = streamOrType;
    } else {
      // MediaStream passed (for compatibility) - we ignore it since we use feedPCM
      this.streamType = streamType ?? 'microphone';
    }

    this.isRunning = true;
    this.chunkCounter = 0;

    Logger.info('UnifiedTranscriptionService', `Starting ${this.mode} transcription for ${this.streamType}`);

    // Initialize based on mode
    switch (this.mode) {
      case 'local':
        await this.initLocalMode();
        break;
      case 'cloud':
        await this.initCloudMode();
        break;
      case 'self-hosted':
        await this.initSelfHostedMode();
        break;
    }
  }

  /**
   * Feed PCM samples to the transcription service.
   * This is the main input method for the unified pipeline.
   *
   * @param samples - Float32Array of PCM samples at 16kHz mono
   */
  feedPCM(samples: Float32Array): void {
    if (samples.length === 0) return;

    // Self-healing for cloud mode: if we receive audio but service is stopped,
    // restart it. This handles race conditions where the service timed out
    // but audio starts flowing again.
    if (!this.isRunning && this.mode === 'cloud') {
      Logger.info('UnifiedTranscriptionService', 'Audio received while stopped, restarting cloud mode...');
      this.start(this.streamType);
      return; // This chunk is lost, but subsequent chunks will flow
    }

    if (!this.isRunning) return;

    switch (this.mode) {
      case 'local':
        this.feedLocalMode(samples);
        break;
      case 'cloud':
        this.feedCloudMode(samples);
        break;
      case 'self-hosted':
        this.feedSelfHostedMode(samples);
        break;
    }
  }

  /**
   * Stop the transcription service
   */
  stop(): void {
    if (!this.isRunning) return;

    Logger.info('UnifiedTranscriptionService', `Stopping ${this.mode} transcription`);
    this.isRunning = false;

    // Cleanup based on mode
    switch (this.mode) {
      case 'local':
        this.cleanupLocalMode();
        break;
      case 'cloud':
        this.cleanupCloudMode();
        break;
      case 'self-hosted':
        this.cleanupSelfHostedMode();
        break;
    }

    // Notify state manager
    TranscriptionStateManager.streamStopped(this.streamType);
  }

  // ========== Subscriber Management ==========

  addSubscriber(subscriber: TranscriptionSubscriber): void {
    this.subscribers.add(subscriber);
    Logger.debug('UnifiedTranscriptionService', `Added subscriber ${subscriber.id}, total: ${this.subscribers.size}`);
  }

  removeSubscriber(subscriber: TranscriptionSubscriber): void {
    this.subscribers.delete(subscriber);
    Logger.debug('UnifiedTranscriptionService', `Removed subscriber ${subscriber.id}, total: ${this.subscribers.size}`);
  }

  private setInterimToSubscribers(text: string): void {
    for (const subscriber of this.subscribers) {
      subscriber.setInterimText(text);
    }
  }

  private commitToSubscribers(text: string): void {
    for (const subscriber of this.subscribers) {
      subscriber.commitText(text);
    }
  }

  // ========== Local Mode (Whisper in browser) ==========

  private async initLocalMode(): Promise<void> {
    const modelManager = WhisperModelManager.getInstance();
    if (!modelManager.isReady()) {
      Logger.info('UnifiedTranscriptionService', 'Model not loaded, loading automatically...');
      await modelManager.loadModel();
    }

    // Get chunk duration from settings (user configures via SettingsTab slider)
    const settings = SensorSettings.getWhisperSettings();
    const bufferMs = settings.chunkDurationMs;
    this.config.localBufferMs = bufferMs;

    // Create buffer for accumulating samples
    this.pcmBuffer = new PCMBuffer(bufferMs, PCM_SAMPLE_RATE);

    // Subscribe to interim results
    this.unsubscribeInterimResults = modelManager.onInterimResult((text, _chunkId) => {
      if (this.isRunning) {
        this.setInterimToSubscribers(text);
        TranscriptionStateManager.setInterimText(this.streamType, text);
      }
    });

    Logger.info('UnifiedTranscriptionService', `Local mode initialized with ${bufferMs}ms buffer (from settings)`);
  }

  private feedLocalMode(samples: Float32Array): void {
    if (!this.pcmBuffer) return;

    this.pcmBuffer.push(samples);

    // Process when buffer is full
    if (this.pcmBuffer.isFull()) {
      const audio = this.pcmBuffer.flush();
      const chunkId = ++this.chunkCounter;

      // Notify state manager
      TranscriptionStateManager.chunkRecordingStarted(this.streamType, this.config.localBufferMs!);
      TranscriptionStateManager.chunkTranscriptionStarted(this.streamType);

      // Transcribe async (non-blocking)
      this.transcribeLocalAsync(audio, chunkId);
    }
  }

  private async transcribeLocalAsync(audio: Float32Array, chunkId: number): Promise<void> {
    try {
      const result = await WhisperModelManager.getInstance().transcribePCM(audio, chunkId);

      if (result?.text && this.isRunning) {
        this.commitToSubscribers(result.text);
        TranscriptionStateManager.chunkTranscriptionEnded(this.streamType, result.text, chunkId);
      }
    } catch (error) {
      if (this.isRunning) {
        Logger.error('UnifiedTranscriptionService', `Local transcription failed for chunk ${chunkId}: ${error}`);
      }
    }
  }

  private cleanupLocalMode(): void {
    if (this.unsubscribeInterimResults) {
      this.unsubscribeInterimResults();
      this.unsubscribeInterimResults = null;
    }

    // Flush any remaining audio
    if (this.pcmBuffer && !this.pcmBuffer.isEmpty()) {
      const audio = this.pcmBuffer.flush();
      const chunkId = ++this.chunkCounter;
      this.transcribeLocalAsync(audio, chunkId);
    }
    this.pcmBuffer = null;
  }

  // ========== Cloud Mode (WebSocket streaming) ==========

  private async initCloudMode(): Promise<void> {
    try {
      const token = await TranscriptionRouter.getToken();

      const ws = new WebSocket(CLOUD_WS_URL);
      this.ws = ws;

      ws.onopen = () => {
        Logger.info('UnifiedTranscriptionService', 'Cloud WebSocket connected');

        // Send authentication
        if (this.ws === ws && token) {
          ws.send(JSON.stringify({
            token,
            format: 'pcm16',  // Tell server we're sending PCM Int16
            sampleRate: PCM_SAMPLE_RATE
          }));
        }

        // Start streaming timer
        this.startCloudStreamTimer();
        TranscriptionStateManager.chunkRecordingStarted(this.streamType, 0);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const { text, is_final, reconnect } = data;

          if (reconnect) {
            Logger.info('UnifiedTranscriptionService', 'Server requested reconnect');
            this.reconnectCloud();
            return;
          }

          if (text) {
            if (is_final) {
              this.commitToSubscribers(text);
              TranscriptionStateManager.chunkTranscriptionEnded(this.streamType, text, 0);
            } else {
              this.setInterimToSubscribers(text);
              TranscriptionStateManager.setInterimText(this.streamType, text);
            }
          }
        } catch (error) {
          Logger.error('UnifiedTranscriptionService', `Failed to parse cloud message: ${error}`);
        }
      };

      ws.onerror = () => {
        Logger.error('UnifiedTranscriptionService', 'Cloud WebSocket error');
      };

      ws.onclose = (e) => {
        Logger.info('UnifiedTranscriptionService', `Cloud WebSocket closed: code=${e.code}`);
        if (this.ws === ws) {
          this.stopCloudStreamTimer();
          this.ws = null;
        }
      };

    } catch (error) {
      Logger.error('UnifiedTranscriptionService', `Failed to connect to cloud: ${error}`);
    }
  }

  private feedCloudMode(samples: Float32Array): void {
    // Track when we last received audio for reconnect logic
    this.lastAudioReceivedAt = Date.now();

    // Convert to Int16 and buffer
    const int16 = float32ToInt16(samples);
    this.cloudStreamBuffer.push(int16);
  }

  private startCloudStreamTimer(): void {
    const intervalMs = this.config.cloudStreamIntervalMs!;

    this.cloudStreamTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      if (this.cloudStreamBuffer.length > 0) {
        // Concatenate all buffered Int16 arrays
        const totalLength = this.cloudStreamBuffer.reduce((sum, arr) => sum + arr.length, 0);
        const combined = new Int16Array(totalLength);
        let offset = 0;
        for (const arr of this.cloudStreamBuffer) {
          combined.set(arr, offset);
          offset += arr.length;
        }
        this.cloudStreamBuffer = [];

        // Send as binary
        this.ws.send(combined.buffer);
      }
    }, intervalMs);

    Logger.debug('UnifiedTranscriptionService', `Cloud streaming timer started (${intervalMs}ms)`);
  }

  private stopCloudStreamTimer(): void {
    if (this.cloudStreamTimer) {
      clearInterval(this.cloudStreamTimer);
      this.cloudStreamTimer = null;
    }
  }

  private reconnectCloud(): void {
    if (!this.isRunning) return;

    // If we had audio flowing but it stopped, don't reconnect - just stop
    // (null means never received audio yet - keep trying in that case)
    const AUDIO_TIMEOUT_MS = 5000;
    const isStale = this.lastAudioReceivedAt &&
      (Date.now() - this.lastAudioReceivedAt > AUDIO_TIMEOUT_MS);

    if (isStale) {
      Logger.info('UnifiedTranscriptionService', 'No recent audio, stopping instead of reconnecting');
      this.stop();
      return;
    }

    Logger.info('UnifiedTranscriptionService', 'Reconnecting to cloud...');

    this.stopCloudStreamTimer();
    const oldWs = this.ws;
    this.ws = null;
    if (oldWs) {
      oldWs.close();
    }

    this.initCloudMode();
  }

  private cleanupCloudMode(): void {
    this.stopCloudStreamTimer();
    this.cloudStreamBuffer = [];
    this.lastAudioReceivedAt = null;

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ========== Self-Hosted Mode (REST API with WAV) ==========

  private async initSelfHostedMode(): Promise<void> {
    const baseUrl = SensorSettings.getSelfHostedWhisperUrl();
    if (!baseUrl || baseUrl.trim().length === 0) {
      throw new Error('Self-hosted Whisper URL is not configured');
    }

    // Get buffer duration from settings (user configures via SettingsTab slider)
    const settings = SensorSettings.getWhisperSettings();
    const bufferMs = settings.chunkDurationMs;
    this.config.selfHostedBufferMs = bufferMs;

    this.pcmBuffer = new PCMBuffer(bufferMs, PCM_SAMPLE_RATE);

    Logger.info('UnifiedTranscriptionService', `Self-hosted mode initialized with ${bufferMs}ms buffer (from settings) to ${baseUrl}`);
  }

  private feedSelfHostedMode(samples: Float32Array): void {
    if (!this.pcmBuffer) return;

    this.pcmBuffer.push(samples);

    // Process when buffer is full
    if (this.pcmBuffer.isFull()) {
      const audio = this.pcmBuffer.flush();
      const chunkId = ++this.chunkCounter;

      TranscriptionStateManager.chunkRecordingStarted(this.streamType, this.config.selfHostedBufferMs!);
      TranscriptionStateManager.chunkTranscriptionStarted(this.streamType);

      this.transcribeSelfHostedAsync(audio, chunkId);
    }
  }

  private async transcribeSelfHostedAsync(audio: Float32Array, chunkId: number): Promise<void> {
    try {
      const baseUrl = SensorSettings.getSelfHostedWhisperUrl();
      const normalizedUrl = baseUrl.replace(/\/+$/, '');

      // Create WAV blob from PCM
      const wavBlob = createWavBlob(audio, PCM_SAMPLE_RATE);

      const formData = new FormData();
      formData.append('file', wavBlob, `chunk_${chunkId}.wav`);
      formData.append('model', 'whisper-1');

      const response = await platformFetch(`${normalizedUrl}/v1/audio/transcriptions`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Self-hosted API error (${response.status}): ${errorText}`);
      }

      const result = await response.json();

      if (result?.text && this.isRunning) {
        this.commitToSubscribers(result.text);
        TranscriptionStateManager.chunkTranscriptionEnded(this.streamType, result.text, chunkId);
      }
    } catch (error) {
      if (this.isRunning) {
        Logger.error('UnifiedTranscriptionService', `Self-hosted transcription failed for chunk ${chunkId}: ${error}`);
      }
    }
  }

  private cleanupSelfHostedMode(): void {
    // Flush any remaining audio
    if (this.pcmBuffer && !this.pcmBuffer.isEmpty()) {
      const audio = this.pcmBuffer.flush();
      const chunkId = ++this.chunkCounter;
      this.transcribeSelfHostedAsync(audio, chunkId);
    }
    this.pcmBuffer = null;
  }

  // ========== Utility Methods ==========

  isReady(): boolean {
    switch (this.mode) {
      case 'local':
        return WhisperModelManager.getInstance().isReady();
      case 'cloud':
        return true;
      case 'self-hosted':
        const url = SensorSettings.getSelfHostedWhisperUrl();
        return !!url && url.trim().length > 0;
    }
  }

  getMode(): TranscriptionMode {
    return this.mode;
  }

  isActive(): boolean {
    return this.isRunning;
  }
}
