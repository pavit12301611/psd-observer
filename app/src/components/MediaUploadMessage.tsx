// src/components/MediaUploadMessage.tsx

import React, { useState, useRef, useEffect } from 'react';
import { Upload, Camera, X, Monitor } from 'lucide-react';
import { createLoggerDecorator } from '../utils/logging';

interface MediaUploadMessageProps {
  requestText: string; // The text from inside %%% %%%
  onResponse: (result: string | { type: 'image', data: string } | null) => void;
}

const MediaUploadMessage: React.FC<MediaUploadMessageProps> = ({ requestText, onResponse }) => {
  const [showPreview, setShowPreview] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [captureMode, setCaptureMode] = useState<'camera' | 'screen' | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const logger = createLoggerDecorator('MediaUploadMessage');
  
  useEffect(() => {
    logger.info('Component mounted');
    return () => {
      logger.info('Component unmounting');
      if (stream) {
        logger.info('Cleaning up stream on unmount');
        stream.getTracks().forEach(track => track.stop());
      }
    };
  }, []);
  
  useEffect(() => {
    if (stream && videoRef.current) {
      logger.info('Setting video source', { hasStream: !!stream, hasVideoRef: !!videoRef.current });
      videoRef.current.srcObject = stream;
      
      videoRef.current.onloadedmetadata = () => {
        logger.info('Video metadata loaded, attempting to play');
        videoRef.current?.play().catch(error => {
          logger.error('Failed to play video', error);
        });
      };
      
      videoRef.current.onerror = (error) => {
        logger.error('Video element error', error);
      };
    }
  }, [stream]);

  const handleUploadImage = () => {
    logger.info('Upload image button clicked');
    fileInputRef.current?.click();
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    logger.info('File selected', { fileName: file?.name, fileType: file?.type, fileSize: file?.size });
    
    if (file && file.type.startsWith('image/')) {
      logger.info('Valid image file, reading as data URL');
      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result as string;
        logger.info('File reader loaded', { resultLength: result.length, resultPreview: result.substring(0, 100) });
        // Extract base64 data (remove data:image/...;base64, prefix)
        const base64Data = result.split(',')[1];
        logger.info('Extracted base64 data', { base64Length: base64Data.length });
        onResponse({ type: 'image', data: base64Data });
      };
      reader.onerror = (error) => {
        logger.error('File reader error', error);
      };
      reader.readAsDataURL(file);
    } else {
      logger.warn('Invalid file selected', { fileType: file?.type });
    }
  };

  const handleStartCamera = async () => {
    logger.info('Starting camera');
    try {
      const constraints = { video: { facingMode: 'user' } };
      logger.info('Requesting user media', constraints);

      const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      logger.info('Media stream obtained', {
        tracks: mediaStream.getTracks().length,
        videoTracks: mediaStream.getVideoTracks().length,
        audioTracks: mediaStream.getAudioTracks().length
      });

      setCaptureMode('camera');
      setStream(mediaStream);
      setShowPreview(true);
      logger.info('Stream set and preview enabled');

    } catch (error) {
      logger.error('Camera access failed', error);
    }
  };

  const handleStartScreenShare = async () => {
    logger.info('Starting screen share');
    try {
      const constraints = { video: true };
      logger.info('Requesting display media', constraints);

      const mediaStream = await navigator.mediaDevices.getDisplayMedia(constraints);
      logger.info('Display media stream obtained', {
        tracks: mediaStream.getTracks().length,
        videoTracks: mediaStream.getVideoTracks().length,
        audioTracks: mediaStream.getAudioTracks().length
      });

      setCaptureMode('screen');
      setStream(mediaStream);
      setShowPreview(true);
      logger.info('Screen share stream set and preview enabled');

    } catch (error) {
      logger.error('Screen share access failed', error);
    }
  };

  const handleTakePicture = () => {
    logger.info('Take picture button clicked');

    if (!videoRef.current) {
      logger.error('Video ref is null');
      return;
    }

    if (!stream) {
      logger.error('Stream is null');
      return;
    }

    logger.info('Video dimensions', {
      videoWidth: videoRef.current.videoWidth,
      videoHeight: videoRef.current.videoHeight,
      readyState: videoRef.current.readyState,
      paused: videoRef.current.paused
    });

    // Create canvas to capture the frame
    const canvas = document.createElement('canvas');
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;

    logger.info('Canvas created', { width: canvas.width, height: canvas.height });

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);

      // Get base64 image data
      const base64Image = canvas.toDataURL('image/png').split(',')[1];
      logger.info('Image captured', { base64Length: base64Image.length });

      // Stop the stream and hide preview
      stream.getTracks().forEach(track => {
        logger.info('Stopping track', { kind: track.kind, label: track.label });
        track.stop();
      });
      setStream(null);
      setShowPreview(false);
      setCaptureMode(null);

      onResponse({ type: 'image', data: base64Image });
    } else {
      logger.error('Failed to get canvas context');
    }
  };

  const handleCancelCamera = () => {
    logger.info('Cancel camera button clicked');
    if (stream) {
      logger.info('Stopping camera stream');
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    }
    setShowPreview(false);
    setCaptureMode(null);
  };

  const handleDecline = () => {
    logger.info('Decline button clicked');
    // Clean up any active stream
    if (stream) {
      logger.info('Stopping stream on decline');
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    }
    setShowPreview(false);
    setCaptureMode(null);
    onResponse(null);
  };

  const handleSkipReference = () => {
    logger.info('Skip reference image button clicked');
    // Clean up any active stream
    if (stream) {
      logger.info('Stopping stream on skip');
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    }
    setShowPreview(false);
    setCaptureMode(null);
    onResponse("Can you create this agent without a reference image?");
  };

  return (
    <div className="w-full bg-gradient-to-br from-purple-50 to-purple-50 border border-purple-200 rounded-xl p-6 relative shadow-sm">
      {/* Close button in top right */}
      <button 
        onClick={handleDecline}
        className="absolute top-3 right-3 p-2 rounded-full hover:bg-white/50 transition-colors group"
      >
        <X className="h-5 w-5 text-purple-600 group-hover:text-purple-800" />
      </button>
      
      <div className="pr-10">
        <p className="text-purple-900 font-semibold mb-6 text-lg">{requestText}</p>
        
        {!showPreview ? (
          <div className="space-y-3">
            <div className="flex gap-3">
              <button
                onClick={handleUploadImage}
                className="flex-1 px-4 py-3 text-sm font-semibold text-white bg-gradient-to-r from-purple-600 to-purple-600 rounded-lg hover:from-purple-700 hover:to-purple-700 transition-all duration-200 flex items-center justify-center shadow-md hover:shadow-lg transform hover:-translate-y-0.5"
              >
                <Upload className="h-5 w-5 mr-2" />
                Upload Image
              </button>

              <button
                onClick={handleStartCamera}
                className="flex-1 px-4 py-3 text-sm font-semibold text-white bg-gradient-to-r from-purple-600 to-purple-600 rounded-lg hover:from-purple-700 hover:to-purple-700 transition-all duration-200 flex items-center justify-center shadow-md hover:shadow-lg transform hover:-translate-y-0.5"
              >
                <Camera className="h-5 w-5 mr-2" />
                Open Camera
              </button>

              <button
                onClick={handleStartScreenShare}
                className="flex-1 px-4 py-3 text-sm font-semibold text-white bg-gradient-to-r from-purple-600 to-pink-600 rounded-lg hover:from-purple-700 hover:to-pink-700 transition-all duration-200 flex items-center justify-center shadow-md hover:shadow-lg transform hover:-translate-y-0.5"
              >
                <Monitor className="h-5 w-5 mr-2" />
                Share Screen
              </button>
            </div>

            <button
              onClick={handleSkipReference}
              className="w-full px-4 py-3 text-sm font-semibold text-gray-700 bg-white border-2 border-gray-400 rounded-lg hover:bg-gray-50 hover:border-gray-500 transition-all duration-200 shadow-sm hover:shadow-md"
            >
              Skip Reference Image
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="relative rounded-xl overflow-hidden bg-black shadow-lg">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-64 object-cover"
                onCanPlay={() => logger.info('Video can play')}
                onPlaying={() => logger.info('Video is playing')}
                onWaiting={() => logger.info('Video is waiting')}
                onStalled={() => logger.info('Video stalled')}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent" />
            </div>
            
            <div className="flex gap-3">
              <button
                onClick={handleCancelCamera}
                className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              
              <button
                onClick={handleTakePicture}
                className="flex-1 px-4 py-2 text-sm font-semibold text-white bg-gradient-to-r from-green-600 to-emerald-600 rounded-lg hover:from-green-700 hover:to-emerald-700 transition-all duration-200 flex items-center justify-center shadow-md hover:shadow-lg"
              >
                {captureMode === 'screen' ? (
                  <>
                    <Monitor className="h-4 w-4 mr-2" />
                    Take Screenshot
                  </>
                ) : (
                  <>
                    <Camera className="h-4 w-4 mr-2" />
                    Take Photo
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
      
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileSelect}
        style={{ display: 'none' }}
      />
    </div>
  );
};

export default MediaUploadMessage;