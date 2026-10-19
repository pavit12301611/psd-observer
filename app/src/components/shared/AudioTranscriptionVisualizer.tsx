import React, { useRef, useEffect, useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { AudioStreamType } from '@utils/streamManager';
import { useTranscriptionState, useSubscriberText } from '@hooks/useTranscriptionState';

interface AudioTranscriptionVisualizerProps {
  stream: MediaStream;
  streamType: AudioStreamType;
  agentId: string;
  title: string;
  icon: React.ReactNode;
  onClick?: () => void;
}

/**
 * Shared audio visualization component with transcription progress.
 * Shows transcription text for the specified agent's subscriber.
 * Used by SensorPreviewPanel, SharingPermissionsModal, and SettingsTab.
 */
const AudioTranscriptionVisualizer: React.FC<AudioTranscriptionVisualizerProps> = ({
  stream,
  streamType,
  agentId,
  title,
  icon,
  onClick,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameId = useRef<number>();

  // Global transcription state (for status like isTranscribing)
  const globalState = useTranscriptionState(streamType);

  // Subscriber-specific text (what this agent sees)
  const { committedText, interimText } = useSubscriberText(agentId, streamType);

  // Audio visualization
  useEffect(() => {
    if (!stream || !canvasRef.current || stream.getAudioTracks().length === 0) return;

    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const canvas = canvasRef.current;
    const canvasCtx = canvas.getContext('2d')!;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      animationFrameId.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);
      canvasCtx.fillStyle = '#1f2937';
      canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width / bufferLength) * 2;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * canvas.height;
        const alpha = barHeight / canvas.height;
        canvasCtx.fillStyle = `rgba(52, 211, 153, ${alpha})`; // emerald-400
        canvasCtx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
        x += barWidth + 1;
      }
    };

    draw();

    return () => {
      if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
      source.disconnect();
      analyser.disconnect();
      audioContext.close().catch(() => {});
    };
  }, [stream]);

  // Get last N words for display (committed + interim)
  const { committedWords, interimWords } = useMemo(() => {
    // Combine for word count, but track where interim starts
    const allWords = (committedText + (interimText ? ' ' + interimText : ''))
      .split(/\s+/)
      .filter(w => w.length > 0);

    // Take last 25 words
    const lastWords = allWords.slice(-25);

    // Figure out how many are from interim
    const interimWordCount = interimText.split(/\s+/).filter(w => w.length > 0).length;
    const committedInWindow = Math.max(0, lastWords.length - interimWordCount);

    return {
      committedWords: lastWords.slice(0, committedInWindow).join(' '),
      interimWords: lastWords.slice(committedInWindow).join(' '),
    };
  }, [committedText, interimText]);

  // Determine current status for display
  // Cloud streaming uses interimText, chunk-based uses recordingStartedAt
  const statusInfo = useMemo(() => {
    // Cloud streaming mode (has interim text updates)
    if (interimText) {
      return { label: 'Streaming', color: 'text-cyan-400' };
    }
    // Chunk-based mode (local/self-hosted)
    if (globalState.recordingStartedAt) {
      if (globalState.isTranscribing) {
        return { label: 'Transcribing', color: 'text-orange-400' };
      }
      return { label: 'Recording', color: 'text-green-400' };
    }
    // Stream is active but no transcription instance
    return { label: 'Active, not used', color: 'text-gray-500' };
  }, [globalState.isTranscribing, interimText, globalState.recordingStartedAt]);

  return (
    <div
      className={`bg-gray-800 rounded-lg p-3 flex flex-col gap-2 ${onClick ? 'cursor-pointer hover:bg-gray-750' : ''}`}
      onClick={onClick}
      title={onClick ? 'Click to view full transcription' : undefined}
    >
      {/* Header */}
      <div className="flex items-center gap-2 text-xs font-medium text-gray-300">
        {icon}
        <span>{title}</span>
        <span className={`${statusInfo.color} text-[10px] font-normal`}>
          {statusInfo.label}
        </span>
      </div>

      {/* Waveform */}
      <canvas ref={canvasRef} className="w-full h-10 rounded" />

      {/* Transcription text with loading indicator */}
      {(committedWords || interimWords || globalState.isTranscribing) && (
        <div className="relative overflow-hidden h-5">
          <div className="absolute inset-0 flex items-center">
            {/* Gradient fade on left */}
            <div className="absolute left-0 top-0 bottom-0 w-8 bg-gradient-to-r from-gray-800 to-transparent z-10 pointer-events-none" />

            {/* Text content */}
            <div className="absolute top-0 bottom-0 right-1 left-8 flex items-center justify-end overflow-hidden gap-1">
              <div
                className="text-xs whitespace-nowrap overflow-hidden"
                style={{ direction: 'rtl' }}
              >
                <span style={{ direction: 'ltr', unicodeBidi: 'embed' }}>
                  <span className="text-gray-300">{committedWords}</span>
                  {committedWords && interimWords && ' '}
                  <span className="text-gray-400 italic">{interimWords}</span>
                </span>
              </div>
              {globalState.isTranscribing && (
                <Loader2 className="w-3 h-3 text-orange-400 animate-spin flex-shrink-0" />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AudioTranscriptionVisualizer;
