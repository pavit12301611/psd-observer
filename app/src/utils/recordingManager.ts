// src/utils/recordingManager.ts
import { StreamManager } from './streamManager';
import { saveRecordingToDb, ClipMarker } from './recordingsDB';
import { Logger } from './logging';

type RecordableStreamType = 'screen' | 'camera';
type RecordingState = 'IDLE' | 'BUFFERING' | 'RECORDING';

class RecordingManager {
  private state: RecordingState = 'IDLE';
  private recorders = new Map<RecordableStreamType, MediaRecorder>();
  private chunks = new Map<RecordableStreamType, Blob[]>();
  private pendingMarkers: ClipMarker[] = [];


  // --- Public API for Agent Lifecycle ---

  public initialize(): void {
    if (this.state === 'IDLE') {
      Logger.info("RecordingManager", "Initializing and starting the first buffer.");
      this.startNewBuffer();
    }
  }

  public handleEndOfLoop(): void {
    if (this.state === 'BUFFERING') {
      Logger.debug("RecordingManager", "End of loop: In BUFFERING state. Cycling buffer.");
      this.discardCurrentBuffer();
      this.startNewBuffer();
    } else if (this.state === 'RECORDING') {
      Logger.debug("RecordingManager", "End of loop: In RECORDING state. Continuing recording.");
    }
  }

  public async forceStop(): Promise<void> {
    Logger.info("RecordingManager", `forceStop called. Current state: ${this.state}`);
    if (this.state === 'BUFFERING') {
      this.discardAndShutdown();
    } else {
      Logger.info("RecordingManager", `Saving from forceStop`);
      await this.saveAndFinishClip();
    }
    this.state = 'IDLE';
  }

  public addMarker(label: string): void {
    if (this.state === 'IDLE') {
      Logger.warn("RecordingManager", `markClip called while IDLE. Marker will be stored and attached to the next recording session.`);
    }
    const marker: ClipMarker = {
      label,
      timestamp: Date.now(),
    };
    this.pendingMarkers.push(marker);
    Logger.info("RecordingManager", `Marker added: "${label}" at ${new Date(marker.timestamp).toLocaleTimeString()}`);
  }

  // --- Public API for Agent Tools ---

  public startClip(): void {
    if (this.state === 'BUFFERING') {
      this.state = 'RECORDING';
      Logger.info("RecordingManager", "startClip called. State changed to RECORDING. The current buffer will be saved.");
    } else {
      Logger.warn("RecordingManager", `startClip called in unexpected state: ${this.state}. No action taken.`);
    }
  }

  public async stopClip(): Promise<void> {
    if (this.state === 'RECORDING') {
      Logger.info("RecordingManager", "stopClip called. Saving clip and returning to BUFFERING state.");
      await this.saveAndFinishClip();
      this.startNewBuffer();
    } else {
      Logger.warn("RecordingManager", `stopClip called in unexpected state: ${this.state}. No action taken.`);
    }
  }

  // --- Private Implementation ---

  private async saveAndFinishClip(): Promise<void> {
    if (this.recorders.size === 0) {
      Logger.warn("RecordingManager", "saveAndFinishClip called but no active recorders.");
      return;
    }

    Logger.info("RecordingManager", `saveAndFinishClip called. Preparing to save ${this.recorders.size} recorders.`);
  
    const saveJobs: Promise<void>[] = [];
  
    this.recorders.forEach((recorder, type) => {
      const chunks = this.chunks.get(type) ?? [];
      Logger.debug("RecordingManager",
        `Preparing to stop '${type}' recorder. Current chunks: ${chunks.length}, state: ${recorder.state}`);
  
      const job = new Promise<void>((resolve) => {
        const finalizeAndSave = async () => {
          if (recorder.state === 'inactive' && chunks.length === 0) {
            Logger.warn("RecordingManager", `'${type}' recorder was already inactive with no data. Nothing to save.`);
            resolve();
            return;
          }

          const blob = new Blob(chunks, { type: recorder.mimeType });
          const filename = `${type}-clip-${Date.now()}`;
          Logger.info("RecordingManager",
            `'${type}' stopped. Saving ${chunks.length} chunks (${blob.size} bytes) as '${filename}' with mimeType: '${recorder.mimeType}'.`);
  
          try {
            await saveRecordingToDb(blob, this.pendingMarkers); 
            Logger.info("RecordingManager", `Saved clip for '${type}' with ${this.pendingMarkers.length} markers successfully.`);
          } catch (err) {
            Logger.error("RecordingManager", `Failed to save clip for '${type}'.`, err);
          }
          resolve();
        };

        if (recorder.state === 'inactive') {
          finalizeAndSave();
        } else {
          recorder.addEventListener('stop', finalizeAndSave, { once: true });
          recorder.stop();
        }
      });
  
      saveJobs.push(job);
    });
  
    await Promise.all(saveJobs);

    if (this.pendingMarkers.length > 0) {
        Logger.info("RecordingManager", `All clips for this session saved. Clearing ${this.pendingMarkers.length} markers.`);
        this.pendingMarkers = [];
    }
  
    this.recorders.clear();
    this.chunks.clear();
    Logger.debug("RecordingManager", "All recorders saved & cleared.");
  }
  
  private startNewBuffer(): void {
    if (this.recorders.size > 0) {
      this.discardAndShutdown();
    }

    const { 
      screenVideoStream, 
      cameraStream, 
      screenAudioStream, 
      microphoneStream 
    } = StreamManager.getCurrentState();

    const streamsToRecord = [
      { type: 'screen' as RecordableStreamType, video: screenVideoStream, audio: screenAudioStream },
      { type: 'camera' as RecordableStreamType, video: cameraStream, audio: microphoneStream }
    ];
    
    let bufferStarted = false;

    for (const { type, video, audio } of streamsToRecord) {
      if (!video) continue;

      const videoTracks = video.getVideoTracks();

      // Check if video tracks are active before proceeding
      const hasActiveVideoTrack = videoTracks.some(track => track.readyState === 'live');
      if (!hasActiveVideoTrack) {
        Logger.warn("RecordingManager", `Skipping '${type}' recorder: no active video tracks`);
        continue;
      }

      const tracks = [...videoTracks];
      if (audio) {
        tracks.push(...audio.getAudioTracks());
      }
      const combinedStream = new MediaStream(tracks);

      const mediaRecorder = this.createRecorderWithFallback(combinedStream, type);

      if (!mediaRecorder) {
        continue;
      }

      const chunksForType: Blob[] = [];
      this.chunks.set(type, chunksForType);

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksForType.push(event.data);
      };

      this.recorders.set(type, mediaRecorder);

      try {
        mediaRecorder.start(1000); // Start buffering
        bufferStarted = true;
      } catch (err) {
        Logger.error("RecordingManager", `Failed to start '${type}' recorder`, err);
        this.recorders.delete(type);
        this.chunks.delete(type);
      }
    }
  
    if (bufferStarted) {
      this.state = 'BUFFERING';
      Logger.debug("RecordingManager", "New buffer started successfully. State is now BUFFERING.");
    } else {
      this.state = 'IDLE';
      Logger.warn("RecordingManager", "startNewBuffer called, but no active or recordable streams found.");
    }
  }

  // Helper method to find a supported MIME type and create a MediaRecorder.
  private createRecorderWithFallback(stream: MediaStream, type: RecordableStreamType): MediaRecorder | null {
    // List of MIME types to try, in order of preference.
    // MP4 is often preferred for mobile compatibility.
    // WebM with VP9/VP8 is the standard for web browsers.
    const mimeTypesToTry = [
        'video/mp4; codecs="avc1.42E01E, mp4a.40.2"', // H.264 video, AAC audio
        'video/mp4',
        'video/webm; codecs="vp9, opus"',
        'video/webm; codecs="vp8, opus"',
        'video/webm',
    ];

    for (const mimeType of mimeTypesToTry) {
        if (MediaRecorder.isTypeSupported(mimeType)) {
            try {
                const recorder = new MediaRecorder(stream, { mimeType });
                Logger.info("RecordingManager", `Successfully created recorder for '${type}' with supported MIME type: ${mimeType}`);
                return recorder;
            } catch (err) {
                Logger.warn("RecordingManager", `MIME type '${mimeType}' reported as supported, but failed to create recorder.`, err);
                // Continue to the next type...
            }
        }
    }
    
    // If we get here, no supported MIME type was found.
    Logger.error("RecordingManager", `Could not create MediaRecorder for stream type '${type}'. No supported MIME types found in the preferred list.`);
    return null; // Return null to indicate failure.
  }


  private discardCurrentBuffer(): void {
    this.chunks.clear();
    this.recorders.forEach(recorder => recorder.stop());
  }

  private discardAndShutdown(): void {
    this.discardCurrentBuffer();
    this.state = 'IDLE';
    Logger.info("RecordingManager", "Buffer discarded and manager is now IDLE.");
  }

  public getState(): RecordingState {
    return this.state;
  }

  /**
   * Get the current video buffer as base64 array.
   * Returns whatever chunks currently exist in the buffer.
   * In BUFFERING state: returns just this loop's video.
   * In RECORDING state: returns all video since startClip() was called.
   *
   * @param type - Optional. If specified, returns only that stream type.
   *               If omitted, returns all active streams.
   * @returns Array of base64-encoded videos. Empty array if no videos available.
   */
  public async getVideo(type?: RecordableStreamType): Promise<string[]> {
    // Minimum size threshold - videos smaller than this are likely just headers/init data
    const MIN_VIDEO_SIZE_BYTES = 10 * 1024; // 10KB

    const typesToGet: RecordableStreamType[] = type
      ? [type]
      : (['screen', 'camera'] as RecordableStreamType[]);

    const results: string[] = [];

    for (const streamType of typesToGet) {
      const chunks = this.chunks.get(streamType);
      if (!chunks || chunks.length === 0) {
        Logger.debug("RecordingManager", `getVideo: no chunks available for '${streamType}'`);
        continue;
      }

      const recorder = this.recorders.get(streamType);
      const mimeType = recorder?.mimeType || 'video/webm';
      const blob = new Blob(chunks, { type: mimeType });

      // Skip videos that are too small to be useful (likely just init data)
      if (blob.size < MIN_VIDEO_SIZE_BYTES) {
        Logger.warn("RecordingManager", `getVideo: '${streamType}' video too small (${blob.size} bytes < ${MIN_VIDEO_SIZE_BYTES}). Not enough data yet - try again after more iterations.`);
        continue;
      }

      Logger.debug("RecordingManager", `getVideo for '${streamType}': ${chunks.length} chunks, ${blob.size} bytes, mimeType: ${mimeType}`);

      // Convert blob to base64
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = (reader.result as string).split(',')[1];
          resolve(result);
        };
        reader.readAsDataURL(blob);
      });

      results.push(base64);
    }

    return results;
  }
}

export const recordingManager = new RecordingManager();
