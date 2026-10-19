import { useState, useEffect, useCallback } from 'react';
import { AudioStreamType, StreamManager } from '@utils/streamManager';
import { TranscriptionStateManager, TranscriptionState } from '@utils/whisper/TranscriptionStateManager';
import { TranscriptionRouter } from '@utils/whisper/TranscriptionRouter';

/**
 * Hook to subscribe to transcription state for a specific audio stream type.
 * Queries current state on mount (survives component reload mid-recording).
 */
export const useTranscriptionState = (type: AudioStreamType): TranscriptionState => {
  const [state, setState] = useState<TranscriptionState>(() =>
    TranscriptionStateManager.getState(type)
  );

  useEffect(() => {
    // Get current state immediately (in case it changed between render and effect)
    setState(TranscriptionStateManager.getState(type));

    // Subscribe to updates
    return TranscriptionStateManager.subscribe(type, setState);
  }, [type]);

  return state;
};

export interface SubscriberText {
  /** Committed (final) transcript text */
  committedText: string;
  /** Interim (partial) transcript text */
  interimText: string;
  /** Combined transcript (committed + interim) */
  fullText: string;
}

/**
 * Hook to get transcription text for a specific subscriber (agent + stream type).
 * Use this when you want to show what a specific agent/owner is subscribed to.
 *
 * @param agentId - The agent/owner ID that owns the subscription
 * @param streamType - The audio stream type
 */
export const useSubscriberText = (
  agentId: string,
  streamType: AudioStreamType
): SubscriberText => {
  const [text, setText] = useState<SubscriberText>({
    committedText: '',
    interimText: '',
    fullText: '',
  });

  // Track subscriber reference to detect when it's created
  const [subscriberVersion, setSubscriberVersion] = useState(0);

  const updateText = useCallback(() => {
    // Use getOrCreateSubscriber to ensure subscriber exists when service is active
    const subscriber = StreamManager.getOrCreateSubscriber(agentId, streamType);
    setText({
      committedText: subscriber.getCommittedText(),
      interimText: subscriber.getInterimText(),
      fullText: subscriber.getTranscript(),
    });
  }, [agentId, streamType]);

  // Listen for stream state changes to detect when subscriber might be created
  useEffect(() => {
    const handleStreamChange = () => {
      const subscriber = StreamManager.getSubscriber(agentId, streamType);
      if (subscriber) {
        // Subscriber exists now, trigger re-setup
        setSubscriberVersion(v => v + 1);
      }
    };

    StreamManager.addListener(handleStreamChange);
    return () => StreamManager.removeListener(handleStreamChange);
  }, [agentId, streamType]);

  // Set up subscriber callback when subscriber exists or is created
  useEffect(() => {
    // Only create subscriber if there's an active service (stream is running)
    const router = TranscriptionRouter.getInstance();
    if (!router.hasActiveService(streamType)) {
      setText({ committedText: '', interimText: '', fullText: '' });
      return;
    }

    // Get or create subscriber for this agent + stream type
    const subscriber = StreamManager.getOrCreateSubscriber(agentId, streamType);

    // Get initial state
    updateText();

    // Subscribe to updates
    const previousOnUpdate = subscriber.onUpdate;
    subscriber.onUpdate = (transcript: string) => {
      previousOnUpdate?.(transcript);
      updateText();
    };

    return () => {
      // Restore previous handler (if any)
      subscriber.onUpdate = previousOnUpdate;
    };
  }, [agentId, streamType, updateText, subscriberVersion]);

  return text;
};
