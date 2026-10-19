// src/components/SensorStatusBar.tsx

import React, { useState, useEffect } from 'react';
import { Monitor, Video, Mic } from 'lucide-react';
import { StreamManager, StreamState } from '@utils/streamManager';

const SensorIcon: React.FC<{ Icon: React.ElementType; isActive: boolean; label: string }> = ({ Icon, isActive, label }) => (
  <div className={`flex items-center gap-1.5 transition-colors ${isActive ? 'text-green-400' : 'text-gray-500'}`} title={label}>
    <Icon className="w-4 h-4" />
    <div className={`w-1.5 h-1.5 rounded-full transition-colors ${isActive ? 'bg-green-400 animate-pulse' : 'bg-gray-600'}`}></div>
  </div>
);

const SensorStatusBar: React.FC = () => {
  const [streams, setStreams] = useState<StreamState>(() => StreamManager.getCurrentState());

  useEffect(() => {
    const handleStreamUpdate = (newState: StreamState) => {
      setStreams(newState);
    };
    StreamManager.addListener(handleStreamUpdate);
    return () => {
      StreamManager.removeListener(handleStreamUpdate);
    };
  }, []);

  return (
    <div className="fixed bottom-0 left-1/2 -translate-x-1/2 mb-4 px-4 py-2 bg-gray-800 bg-opacity-80 backdrop-blur-sm rounded-lg shadow-lg border border-gray-700">
      <div className="flex items-center gap-4">
        <SensorIcon Icon={Monitor} isActive={!!streams.screenVideoStream} label="Screen Sharing" />
        <SensorIcon Icon={Video} isActive={!!streams.cameraStream} label="Camera" />
        <SensorIcon Icon={Mic} isActive={!!streams.microphoneStream} label="Microphone" />
      </div>
    </div>
  );
};

export default SensorStatusBar;
