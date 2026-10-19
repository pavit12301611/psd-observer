import React, { useState, useRef, useEffect, useMemo, CSSProperties } from 'react';
import ReactPlayer from 'react-player';

// --- TYPE DEFINITIONS (Unchanged) ---
interface ClipMarker {
  label: string;
  timestamp: number;
}
interface RecordingData {
  id: string;
  blob: Blob;
  createdAt: Date;
  metadata: ClipMarker[];
}

// --- PROPS INTERFACES ---
interface ClipPlayerProps {
  recording: RecordingData;
}

interface TimelineProps {
  duration: number;
  playedSeconds: number;
  markers: ClipMarker[];
  recordingStartTime: number;
  onSeek: (seconds: number) => void;
  // New props to control playback from the timeline
  playing: boolean;
  onTogglePlay: () => void;
}

// --- STYLING (Updated for bigger bar) ---
const styles: { [key: string]: CSSProperties } = {
  playerWrapper: {
    backgroundColor: '#fafafa',
    borderTop: '1px solid #e5e7eb',
    padding: '16px',
  },
  videoArea: {
    position: 'relative',
    width: '100%',
    cursor: 'pointer',
    borderRadius: '8px',
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  controlsContainer: {
    paddingTop: '20px',
  },
  timelineContainer: {
    position: 'relative',
    width: '100%',
    height: '60px', // Increased height
  },
  timelineTrack: {
    position: 'absolute',
    bottom: '15px', // Adjusted for new height
    height: '12px',  // Much thicker track
    width: '100%',
    backgroundColor: '#f0f0f0',
    borderRadius: '6px',
    cursor: 'grab', // Default cursor indicates it's draggable
  },
  timelineProgress: {
    height: '100%',
    backgroundColor: '#3b82f6',
    borderRadius: '6px',
    pointerEvents: 'none', // Prevent progress bar from stealing mouse events
  },
  timelineNeedle: {
    position: 'absolute',
    top: '0',
    bottom: '0',
    width: '2px',
    transform: 'translateX(-1px)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    pointerEvents: 'none',
  },
  timelineNeedleHandle: {
    position: 'absolute',
    top: '3px', // Adjusted for new height
    width: '16px',
    height: '16px',
    backgroundColor: '#3b82f6',
    borderRadius: '50%',
    border: '3px solid #ffffff',
    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
  },
  timelineNeedleLine: {
    width: '2px',
    height: '30px', // Taller line
    backgroundColor: '#3b82f6',
    position: 'absolute',
    top: '11px', // Adjusted
  },
  marker: {
    position: 'absolute',
    bottom: '32px', // Raised to be above the taller track
    transform: 'translateX(-50%)',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  markerTag: {
    padding: '4px 8px',
    backgroundColor: '#ffffff',
    color: '#1f2937',
    borderRadius: '6px',
    fontSize: '12px',
    whiteSpace: 'nowrap',
    boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
    border: '1px solid #e5e7eb',
    marginBottom: '4px',
  },
  markerTick: {
    width: '2px',
    height: '6px',
    backgroundColor: '#9ca3af',
  },
};

// --- TIMELINE COMPONENT (With Drag-to-Seek Logic) ---
const Timeline: React.FC<TimelineProps> = ({
  duration,
  playedSeconds,
  markers,
  recordingStartTime,
  onSeek,
  playing,
  onTogglePlay,
}) => {
  const [expandedMarker, setExpandedMarker] = useState<number | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const wasPlayingRef = useRef(false);

  const handleSeekLogic = (e: MouseEvent | React.MouseEvent<HTMLDivElement>) => {
    if (!trackRef.current || duration === 0) return;
    const rect = trackRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const seekRatio = Math.max(0, Math.min(1, clickX / rect.width)); // Clamp between 0 and 1
    onSeek(seekRatio * duration);
  };
  
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsScrubbing(true);
    wasPlayingRef.current = playing;
    if (playing) {
      onTogglePlay(); // Pause the video
    }
    handleSeekLogic(e);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      handleSeekLogic(e);
    };

    const handleMouseUp = () => {
      setIsScrubbing(false);
      if (wasPlayingRef.current) {
        onTogglePlay(); // Resume playing if it was playing before
      }
    };

    if (isScrubbing) {
      document.body.style.cursor = 'grabbing';
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.body.style.cursor = 'default';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isScrubbing, duration, onSeek, onTogglePlay]); // Add dependencies

  const handleMarkerClick = (markerTimestamp: number) => {
    setExpandedMarker(prev => (prev === markerTimestamp ? null : markerTimestamp));
    const markerTimeInSeconds = (markerTimestamp - recordingStartTime) / 1000;
    onSeek(markerTimeInSeconds);
  };

  const playedPercentage = duration > 0 ? (playedSeconds / duration) * 100 : 0;

  return (
    <div style={styles.timelineContainer}>
      {markers.map((marker) => {
        const markerTimeInSeconds = (marker.timestamp - recordingStartTime) / 1000;
        if (markerTimeInSeconds < 0 || markerTimeInSeconds > duration) return null;

        const markerPosition = (markerTimeInSeconds / duration) * 100;
        const isExpanded = expandedMarker === marker.timestamp;
        const label = isExpanded ? marker.label : `${marker.label.substring(0, 15)}${marker.label.length > 15 ? '...' : ''}`;

        return (
          <div
            key={marker.timestamp}
            style={{ ...styles.marker, left: `${markerPosition}%` }}
            onClick={(e) => { e.stopPropagation(); handleMarkerClick(marker.timestamp); }}
          >
            <div style={styles.markerTag}>{label}</div>
            <div style={styles.markerTick} />
          </div>
        );
      })}

      {/* Main timeline track now uses onMouseDown to initiate seeking */}
      <div ref={trackRef} style={styles.timelineTrack} onMouseDown={handleMouseDown}>
        <div style={{ ...styles.timelineProgress, width: `${playedPercentage}%` }} />
      </div>

      <div style={{ ...styles.timelineNeedle, left: `${playedPercentage}%` }}>
        <div style={styles.timelineNeedleHandle} />
        <div style={styles.timelineNeedleLine} />
      </div>
    </div>
  );
};

// --- CLIP PLAYER COMPONENT (Now passes playing state to Timeline) ---
export default function ClipPlayer({ recording }: ClipPlayerProps) {
  const [playing, setPlaying] = useState(false);
  const [playedSeconds, setPlayedSeconds] = useState(0);
  const [duration, setDuration] = useState(0);
  const playerRef = useRef<ReactPlayer>(null);

  const videoUrl = useMemo(() => (recording.blob ? URL.createObjectURL(recording.blob) : null), [recording.blob]);

  const recordingStartTime = useMemo(() => {
    if (duration > 0) {
      return recording.createdAt.getTime() - duration * 1000;
    }
    return recording.createdAt.getTime();
  }, [recording.createdAt, duration]);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  const handleSeek = (seconds: number) => {
    playerRef.current?.seekTo(seconds, 'seconds');
    setPlayedSeconds(seconds);
  };

  const togglePlay = () => {
    setPlaying((prev) => !prev);
  };

  if (!videoUrl) return null;

  return (
    <div style={styles.playerWrapper}>
      <div style={styles.videoArea} onClick={togglePlay}>
        <ReactPlayer
          ref={playerRef}
          url={videoUrl}
          playing={playing}
          controls={false}
          width="100%"
          height="auto"
          onProgress={(state) => setPlayedSeconds(state.playedSeconds)}
          onDuration={setDuration}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />
      </div>

      <div style={styles.controlsContainer}>
        <Timeline
          duration={duration}
          playedSeconds={playedSeconds}
          markers={recording.metadata}
          recordingStartTime={recordingStartTime}
          onSeek={handleSeek}
          playing={playing}
          onTogglePlay={togglePlay}
        />
      </div>
    </div>
  );
}
