import { AudioStreamType } from '../streamManager';
import { Logger } from '../logging';

/**
 * Interface for transcription subscribers.
 * Each agent owns its own subscriber that accumulates transcript
 * text independently and clears at the end of each loop cycle.
 */
export interface TranscriptionSubscriber {
  /** Unique identifier for this subscriber (typically agentId:streamType) */
  readonly id: string;

  /** The audio stream type this subscriber is listening to */
  readonly streamType: AudioStreamType;

  /** Get accumulated transcript since last clear (committed + interim) */
  getTranscript(): string;

  /** Get only committed (final) text */
  getCommittedText(): string;

  /** Get only interim (partial) text */
  getInterimText(): string;

  /** Append new transcribed text (for non-streaming callers) */
  appendText(text: string): void;

  /** Set interim text (replaces previous interim, for streaming services) */
  setInterimText(text: string): void;

  /** Commit final text (clears interim, adds to committed chunks) */
  commitText(text: string): void;

  /** Clear accumulated transcript (call at end of agent loop) */
  clear(): void;

  /** Cleanup (call when agent stops) */
  destroy(): void;

  /** Optional event handler for UI updates */
  onUpdate?: (transcript: string) => void;
}

/**
 * Default implementation of TranscriptionSubscriber.
 * Accumulates transcribed text independently for each agent.
 */
export class TranscriptionSubscriberImpl implements TranscriptionSubscriber {
  public readonly id: string;
  public readonly streamType: AudioStreamType;
  public onUpdate?: (transcript: string) => void;

  private committedChunks: string[] = [];
  private interimText: string = '';
  private isDestroyed = false;

  constructor(agentId: string, streamType: AudioStreamType) {
    this.id = `${agentId}:${streamType}`;
    this.streamType = streamType;
    Logger.debug('TranscriptionSubscriber', `Created subscriber ${this.id}`);
  }

  public getTranscript(): string {
    if (this.isDestroyed) {
      Logger.warn('TranscriptionSubscriber', `Attempted to get transcript from destroyed subscriber ${this.id}`);
      return '';
    }
    const committed = this.committedChunks.join(' ');
    if (this.interimText) {
      return committed ? `${committed} ${this.interimText}` : this.interimText;
    }
    return committed;
  }

  public getCommittedText(): string {
    if (this.isDestroyed) return '';
    return this.committedChunks.join(' ');
  }

  public getInterimText(): string {
    if (this.isDestroyed) return '';
    return this.interimText;
  }

  public appendText(text: string): void {
    if (this.isDestroyed) {
      Logger.warn('TranscriptionSubscriber', `Attempted to append to destroyed subscriber ${this.id}`);
      return;
    }

    if (text && text.trim()) {
      this.committedChunks.push(text.trim());
      Logger.debug('TranscriptionSubscriber', `Subscriber ${this.id} received text (${text.length} chars), total chunks: ${this.committedChunks.length}`);

      if (this.onUpdate) {
        this.onUpdate(this.getTranscript());
      }
    }
  }

  public setInterimText(text: string): void {
    if (this.isDestroyed) return;

    this.interimText = text?.trim() || '';
    Logger.debug('TranscriptionSubscriber', `Subscriber ${this.id} interim: "${this.interimText.slice(0, 30)}..."`);

    if (this.onUpdate) {
      this.onUpdate(this.getTranscript());
    }
  }

  public commitText(text: string): void {
    if (this.isDestroyed) return;

    this.interimText = '';
    if (text && text.trim()) {
      this.committedChunks.push(text.trim());
      Logger.debug('TranscriptionSubscriber', `Subscriber ${this.id} committed: "${text.trim().slice(0, 30)}...", total: ${this.committedChunks.length}`);

      if (this.onUpdate) {
        this.onUpdate(this.getTranscript());
      }
    }
  }

  public clear(): void {
    if (this.isDestroyed) return;

    const previousLength = this.committedChunks.length;
    this.committedChunks = [];
    this.interimText = '';
    Logger.debug('TranscriptionSubscriber', `Subscriber ${this.id} cleared (had ${previousLength} chunks)`);
  }

  public destroy(): void {
    if (this.isDestroyed) return;

    this.isDestroyed = true;
    this.committedChunks = [];
    this.interimText = '';
    this.onUpdate = undefined;
    Logger.debug('TranscriptionSubscriber', `Subscriber ${this.id} destroyed`);
  }
}
