import { AudioStreamType } from '../streamManager';
import { Logger } from '@utils/logging';

// Fixed rolling window for UI display (60 seconds worth of chunks, assuming 5s chunks = 12 chunks)
const UI_ROLLING_WINDOW_CHUNKS = 12;

export interface TranscriptionState {
  recordingStartedAt: number | null;
  chunkDurationMs: number;
  isTranscribing: boolean;
  fullTranscript: string;  // UI maintains its own rolling window for display
  interimText: string;     // Current interim result (replaced on each update, cleared on final)
}

type StateListener = (state: TranscriptionState) => void;

const DEFAULT_STATE: TranscriptionState = {
  recordingStartedAt: null,
  chunkDurationMs: 0,
  isTranscribing: false,
  fullTranscript: '',
  interimText: '',
};

/**
 * Singleton that holds transcription state for all audio stream types.
 * Survives component mounts/unmounts - UI can query current state on mount.
 *
 * This manager maintains its own rolling window for UI display purposes,
 * separate from the agent-specific subscriber accumulators.
 */
class TranscriptionStateManagerClass {
  private static instance: TranscriptionStateManagerClass;
  private state = new Map<AudioStreamType, TranscriptionState>();
  private listeners = new Map<AudioStreamType, Set<StateListener>>();

  // Rolling window of recent chunks for UI display (per stream type)
  private recentChunks = new Map<AudioStreamType, string[]>();

  public static getInstance(): TranscriptionStateManagerClass {
    if (!TranscriptionStateManagerClass.instance) {
      TranscriptionStateManagerClass.instance = new TranscriptionStateManagerClass();
    }
    return TranscriptionStateManagerClass.instance;
  }

  // --- Called by transcription services ---

  public chunkRecordingStarted(
    type: AudioStreamType,
    chunkDurationMs: number
  ): void {
    const current = this.getState(type);
    this.state.set(type, {
      ...current,
      recordingStartedAt: Date.now(),
      chunkDurationMs,
      // Don't touch isTranscribing - let the transcription lifecycle manage it
    });
    this.notify(type);
  }

  public chunkTranscriptionStarted(type: AudioStreamType): void {
    const current = this.getState(type);
    Logger.debug("TranscriptionStateManager", `Chunk transcription started for ${type}`);
    this.state.set(type, {
      ...current,
      isTranscribing: true,
    });
    this.notify(type);
  }

  public setInterimText(type: AudioStreamType, text: string): void {
    const current = this.getState(type);
    this.state.set(type, {
      ...current,
      interimText: text,
      isTranscribing: true,
    });
    this.notify(type);
  }

  public chunkTranscriptionEnded(
    type: AudioStreamType,
    text: string,
    chunkId: number
  ): void {
    // Maintain our own rolling window for UI display
    if (!this.recentChunks.has(type)) {
      this.recentChunks.set(type, []);
    }

    const chunks = this.recentChunks.get(type)!;
    if (text && text.trim()) {
      chunks.push(text.trim());
      // Keep only the last N chunks for UI display
      while (chunks.length > UI_ROLLING_WINDOW_CHUNKS) {
        chunks.shift();
      }
    }

    const fullTranscript = chunks.join(' ');
    const current = this.getState(type);

    Logger.debug("TranscriptionStateManager", `Chunk ${chunkId} transcribed (UI window: ${chunks.length} chunks)`);

    this.state.set(type, {
      ...current,
      isTranscribing: false,
      fullTranscript,
      interimText: '',  // Clear interim when final arrives
    });
    this.notify(type);
  }

  public streamStopped(type: AudioStreamType): void {
    this.state.delete(type);
    this.recentChunks.delete(type);
    this.notify(type);
  }

  // --- Called by UI components ---

  public getState(type: AudioStreamType): TranscriptionState {
    return this.state.get(type) ?? { ...DEFAULT_STATE };
  }

  public subscribe(type: AudioStreamType, callback: StateListener): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(callback);

    // Return unsubscribe function
    return () => {
      this.listeners.get(type)?.delete(callback);
    };
  }

  // --- Internal ---

  private notify(type: AudioStreamType): void {
    const state = this.getState(type);
    this.listeners.get(type)?.forEach(cb => cb(state));
  }
}

export const TranscriptionStateManager = TranscriptionStateManagerClass.getInstance();
