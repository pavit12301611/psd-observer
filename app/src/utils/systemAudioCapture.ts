// src/utils/systemAudioCapture.ts

// Keep track of the active audio stream
let activeStream: MediaStream | null = null;

/**
 * Starts capturing system audio by prompting the user to share a screen/tab with audio.
 * It isolates and returns only the audio track in a new MediaStream.
 * @returns {Promise<MediaStream | null>} A MediaStream containing only the system audio track, or null on failure.
 */
export async function startSystemAudioCapture(): Promise<MediaStream | null> {
  // If we already have an active stream, return it
  if (activeStream) {
    return activeStream;
  }

  try {
    console.log('Requesting system audio capture...');
    // We must request video to get the audio prompt in most browsers.
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        // These constraints are ideal for Whisper
        sampleRate: 16000,
        channelCount: 1,
      },
    });

    const audioTrack = displayStream.getAudioTracks()[0];
    if (!audioTrack) {
      // User likely didn't check the "Share audio" box.
      // We should stop the video track as it's not needed.
      displayStream.getVideoTracks().forEach(track => track.stop());
      throw new Error("Audio track not shared. Please ensure you check 'Share tab audio' or 'Share system audio'.");
    }

    // We don't need the video, so we can stop its track immediately.
    displayStream.getVideoTracks().forEach(track => track.stop());

    // Create a new stream containing only the audio track.
    const audioStream = new MediaStream([audioTrack]);
    
    // Store the stream for later use and cleanup
    activeStream = audioStream;
    
    // When the user stops sharing via the browser UI, clean up our reference.
    audioTrack.onended = () => {
      console.log('System audio sharing stopped by user');
      activeStream = null;
    };
    
    return audioStream;
  } catch (error) {
    console.error('System audio capture error:', error);
    // Re-throw to be handled by the caller (e.g., StreamManager)
    throw error;
  }
}

/**
 * Stops the active system audio capture stream.
 */
export function stopSystemAudioCapture(): void {
  if (activeStream) {
    activeStream.getTracks().forEach(track => track.stop());
    activeStream = null;
    console.log('System audio capture stopped');
  }
}
