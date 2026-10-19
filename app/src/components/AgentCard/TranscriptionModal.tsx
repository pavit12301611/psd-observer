import React, { useState, useRef, useEffect } from 'react';
import { X, Search, Copy, Volume2, Mic, Headphones, Settings } from 'lucide-react';
import { AudioStreamType } from '@utils/streamManager';
import { SensorSettings } from '@utils/settings';

interface TranscriptionModalProps {
  isOpen: boolean;
  onClose: () => void;
  streamType: AudioStreamType;
  fullTranscript: string;
  streamTitle: string;
}

const TranscriptionModal: React.FC<TranscriptionModalProps> = ({
  isOpen,
  onClose,
  streamType,
  fullTranscript,
  streamTitle
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [copySuccess, setCopySuccess] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new content arrives
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [fullTranscript]);

  // Get Whisper settings for display
  const whisperSettings = SensorSettings.getWhisperSettings();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(fullTranscript);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  };

  const getStreamIcon = () => {
    switch (streamType) {
      case 'microphone':
        return <Mic className="w-5 h-5 text-blue-600" />;
      case 'screenAudio':
        return <Volume2 className="w-5 h-5 text-green-600" />;
      case 'allAudio':
        return <Headphones className="w-5 h-5 text-purple-600" />;
      default:
        return <Volume2 className="w-5 h-5 text-gray-600" />;
    }
  };

  const highlightSearchTerm = (text: string) => {
    if (!searchTerm) return text;

    const regex = new RegExp(`(${searchTerm})`, 'gi');
    const parts = text.split(regex);

    return parts.map((part, index) =>
      regex.test(part) ? (
        <mark key={index} className="bg-yellow-200 px-1 rounded">
          {part}
        </mark>
      ) : (
        part
      )
    );
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b">
          <div className="flex items-center gap-3">
            {getStreamIcon()}
            <div>
              <h2 className="text-xl font-semibold text-gray-900">Live Transcription</h2>
              <p className="text-sm text-gray-500">{streamTitle}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Search Bar */}
        <div className="p-4 border-b bg-gray-50">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search transcript..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>

        {/* Model Info Bar */}
        <div className="px-6 py-3 bg-blue-50 border-b flex items-center justify-between text-sm">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1">
              <Settings className="w-4 h-4 text-blue-600" />
              <span className="font-medium text-blue-900">Model:</span>
              <span className="text-blue-700">{whisperSettings.modelId}</span>
            </div>
            <div className="text-blue-700">
              Chunk size: {Math.round(whisperSettings.chunkDurationMs / 1000)}s
            </div>
            {whisperSettings.language && (
              <div className="text-blue-700">
                Language: {whisperSettings.language}
              </div>
            )}
          </div>
          <button
            onClick={handleCopy}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
              copySuccess
                ? 'bg-green-100 text-green-700'
                : 'bg-blue-100 text-blue-700 hover:bg-blue-200'
            }`}
          >
            <Copy className="w-4 h-4" />
            {copySuccess ? 'Copied!' : 'Copy All'}
          </button>
        </div>

        {/* Transcript Content */}
        <div className="flex-1 overflow-hidden">
          <div
            ref={transcriptRef}
            className="h-full overflow-y-auto p-6 text-gray-800 leading-relaxed"
          >
            {fullTranscript ? (
              <div className="whitespace-pre-wrap break-words">
                {highlightSearchTerm(fullTranscript)}
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-500">
                <div className="text-center">
                  <Volume2 className="w-12 h-12 mx-auto mb-4 text-gray-300" />
                  <p className="text-lg font-medium">No transcription yet</p>
                  <p className="text-sm">Start speaking to see live transcription appear here</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t bg-gray-50 text-center">
          <p className="text-xs text-gray-500">
            Live transcription preview (UI rolling window)
          </p>
        </div>
      </div>
    </div>
  );
};

export default TranscriptionModal;
