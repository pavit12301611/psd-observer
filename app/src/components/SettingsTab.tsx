import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Palette, TestTube2, Loader2, FileDown, CheckCircle2, Database, Trash2, Cloud, Server, Cpu, Mic, Monitor, Play, Square, Volume2, Keyboard, Check, AlertTriangle, Eye, EyeOff, Layers, Move, Maximize2, Zap, ChevronDown, ChevronRight, ScanText, AudioLines, SlidersHorizontal, Sparkles, User, Settings2, ArrowLeft } from 'lucide-react';
import { SensorSettings } from '../utils/settings';
import { StreamManager } from '../utils/streamManager';
import { isDesktop } from '../utils/platform';

// Whisper imports
import { WhisperModelManager } from '../utils/whisper/WhisperModelManager';
import { TranscriptionRouter } from '../utils/whisper/TranscriptionRouter';
import { WhisperModelState, TranscriptionMode } from '../utils/whisper/types';
import { useSubscriberText } from '../hooks/useTranscriptionState';
import { SUGGESTED_MODELS, LANGUAGE_NAMES } from '../config/whisper-models';

import { AVAILABLE_OCR_LANGUAGES } from '../config/ocr-languages';

// Change Detection component
import ChangeDetectionSettings from './ChangeDetectionSettings';
import { ObServerTab } from './ObServerTab';
import UserInfoCard from './settings/UserInfoCard';
import Switch from './settings/Switch';

interface SettingsTabProps {
  isDarkMode?: boolean;
  onToggleDarkMode?: () => void;
  onOpenAccount?: () => void;
  initialView?: SettingsView;
}

export type SettingsView = 'main' | 'subscription' | 'appSettings';

// Clickable row used on the settings home screen (ChatGPT / Claude style list).
const NavRow: React.FC<{
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}> = ({ icon, title, description, onClick }) => (
  <button
    onClick={onClick}
    className="w-full flex items-center gap-4 px-5 py-4 text-left hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors"
  >
    <span className="flex items-center justify-center h-9 w-9 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 flex-shrink-0">
      {icon}
    </span>
    <div className="min-w-0 flex-1">
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}</p>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>
    </div>
    <ChevronRight className="h-4 w-4 text-gray-400 flex-shrink-0" />
  </button>
);

const BackHeader: React.FC<{ title: string; onBack: () => void }> = ({ title, onBack }) => (
  <div className="flex items-center gap-3">
    <button
      onClick={onBack}
      className="p-2 -ml-2 rounded-lg text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
      aria-label="Back to settings"
    >
      <ArrowLeft className="h-5 w-5" />
    </button>
    <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{title}</h1>
  </div>
);

// Helper function to format bytes
const formatBytes = (bytes: number, decimals = 1) => {
  if (!+bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
};

// Calm, bordered section — no drop shadows, no gradients, dark-mode aware.
// This is the one visual container settings uses instead of the old
// heavy-shadow "SaaS card" look.
const Section: React.FC<{
  title: string;
  description?: string;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, description, icon, badge, children }) => (
  <section className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
    <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-gray-100 dark:border-gray-800">
      <div className="flex items-center gap-2.5 min-w-0">
        {icon && <span className="text-gray-400 dark:text-gray-500 flex-shrink-0">{icon}</span>}
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">{title}</h3>
          {description && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>
          )}
        </div>
      </div>
      {badge}
    </div>
    <div className="px-5 py-5">{children}</div>
  </section>
);

// Neutral segmented-control button — replaces the old bright-bordered/gradient
// "mode card" buttons throughout this tab.
const SegmentButton: React.FC<{
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  icon?: React.ReactNode;
  label: string;
  sublabel?: string;
}> = ({ active, onClick, disabled, icon, label, sublabel }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`flex-1 px-3 py-2.5 rounded-xl border text-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
      active
        ? 'border-purple-300 dark:border-purple-700 bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300'
        : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600'
    }`}
  >
    {icon && <div className="flex justify-center mb-1">{icon}</div>}
    <div className="text-sm font-medium">{label}</div>
    {sublabel && <div className="text-xs mt-0.5 opacity-75">{sublabel}</div>}
  </button>
);

const inputClass = "block w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent disabled:bg-gray-100 dark:disabled:bg-gray-800/50 disabled:cursor-not-allowed";
const labelClass = "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5";

const SettingsTab: React.FC<SettingsTabProps> = ({ isDarkMode = false, onToggleDarkMode, onOpenAccount, initialView = 'main' }) => {

  const [view, setView] = useState<SettingsView>(initialView);
  useEffect(() => { setView(initialView); }, [initialView]);

  // --- OCR State Management ---
  const [ocrLang, setOcrLang] = useState(SensorSettings.getOcrLanguage());

  // --- OCR Handler Functions ---
  const handleOcrLangChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newLang = e.target.value;
    setOcrLang(newLang);
    SensorSettings.setOcrLanguage(newLang);
  };


  // --- NEW WHISPER STATE ---
  const [whisperSettings, setWhisperSettings] = useState(SensorSettings.getWhisperSettings());
  const [modelState, setModelState] = useState<WhisperModelState | null>(null);
  const [isTestRunning, setIsTestRunning] = useState(false);
  const [transcriptionMode, setTranscriptionModeState] = useState<TranscriptionMode>(
    TranscriptionRouter.getInstance().getMode()
  );
  const [selfHostedUrl, setSelfHostedUrl] = useState(SensorSettings.getSelfHostedWhisperUrl());

  // --- KEYBOARD SHORTCUTS STATE (Desktop Only) ---
  const [overlayShortcuts, setOverlayShortcuts] = useState({
    toggle: '',
    move_up: '',
    move_down: '',
    move_left: '',
    move_right: '',
    resize_up: '',
    resize_down: '',
    resize_left: '',
    resize_right: ''
  });
  const [availableAgents, setAvailableAgents] = useState<Array<{id: string, name: string}>>([]);
  const [agentShortcuts, setAgentShortcuts] = useState<Record<string, string>>({});
  const [activeShortcuts, setActiveShortcuts] = useState<string[]>([]);
  const [shortcutFeedback, setShortcutFeedback] = useState<{ message: string, type: 'success' | 'error' } | null>(null);
  const [capturingFor, setCapturingFor] = useState<string | null>(null);
  const [newAgentId, setNewAgentId] = useState('');
  const [showMoveShortcuts, setShowMoveShortcuts] = useState(false);
  const [showResizeShortcuts, setShowResizeShortcuts] = useState(false);

  // --- SCREEN CAPTURE QUALITY STATE (Desktop Only) ---
  const [captureQuality, setCaptureQuality] = useState(SensorSettings.getCaptureQuality());

  const handleCaptureQualityChange = (field: 'maxWidth' | 'jpegQuality' | 'fps', value: number) => {
    const updated = { ...captureQuality, [field]: value };
    setCaptureQuality(updated);
    SensorSettings.setCaptureQuality(updated);
  };

  // --- AUDIO TEST STATE ---
  type AudioTestSource = 'microphone' | 'screenAudio' | 'allAudio';
  interface TranscriptionRecord {
    id: string;
    transcript: string;
    audioUrl: string | null;
    timestamp: Date;
    source: AudioTestSource;
  }
  const [audioTestSource, setAudioTestSource] = useState<AudioTestSource>('microphone');
  const [transcriptionHistory, setTranscriptionHistory] = useState<TranscriptionRecord[]>([]);
  const [playingRecordId, setPlayingRecordId] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const currentTestIdRef = useRef<string | null>(null);
  const TEST_AGENT_ID = 'settings-audio-test';

  // Use subscriber text hook - shows what this test agent is subscribed to
  const transcriptionStreamType = audioTestSource === 'microphone' ? 'microphone' : 'screenAudio';
  const { committedText, interimText } = useSubscriberText(TEST_AGENT_ID, transcriptionStreamType);

  // Model manager instance
  const modelManager = WhisperModelManager.getInstance();

  // Subscribe to model state changes
  useEffect(() => {
    const unsubscribe = modelManager.onStateChange(setModelState);
    setModelState(modelManager.getState());
    return unsubscribe;
  }, [modelManager]);

  // --- KEYBOARD SHORTCUTS FUNCTIONS (Desktop Only) ---
  const buildKeyCombo = (event: KeyboardEvent): string => {
    const modifiers = [];
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

    if (event.metaKey) modifiers.push(isMac ? 'Cmd' : 'Super');
    if (event.ctrlKey) modifiers.push('Ctrl');
    if (event.altKey) modifiers.push('Alt');
    if (event.shiftKey) modifiers.push('Shift');

    let key = event.key;
    if (key === ' ') key = 'Space';
    if (key.length === 1) key = key.toUpperCase();

    if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) {
      return '';
    }

    return modifiers.length > 0 ? `${modifiers.join('+')}+${key}` : key;
  };

  const handleAddAgent = useCallback(() => {
    if (!newAgentId.trim()) return;

    const agentId = newAgentId.trim();
    if (availableAgents.find(a => a.id === agentId)) {
      setShortcutFeedback({ message: `Agent "${agentId}" already exists`, type: 'error' });
      return;
    }

    setAvailableAgents(prev => [...prev, { id: agentId, name: agentId }]);
    setNewAgentId('');
    setShortcutFeedback({ message: `Agent "${agentId}" added`, type: 'success' });
    setTimeout(() => setShortcutFeedback(null), 2000);
  }, [newAgentId, availableAgents]);

  const loadAllShortcuts = useCallback(async () => {
    if (!isDesktop()) return;

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const [unifiedConfig, registeredShortcuts] = await Promise.all([
        invoke<any>('get_shortcut_config'),
        invoke<string[]>('get_registered_shortcuts')
      ]);

      setOverlayShortcuts({
        toggle: unifiedConfig.overlay_toggle || '',
        move_up: unifiedConfig.overlay_move_up || '',
        move_down: unifiedConfig.overlay_move_down || '',
        move_left: unifiedConfig.overlay_move_left || '',
        move_right: unifiedConfig.overlay_move_right || '',
        resize_up: unifiedConfig.overlay_resize_up || '',
        resize_down: unifiedConfig.overlay_resize_down || '',
        resize_left: unifiedConfig.overlay_resize_left || '',
        resize_right: unifiedConfig.overlay_resize_right || ''
      });

      setAgentShortcuts(unifiedConfig.agent_shortcuts || {});
      const agentIds = Object.keys(unifiedConfig.agent_shortcuts || {});
      const agents = agentIds.map(id => ({ id, name: id }));
      setAvailableAgents(agents);
      setActiveShortcuts(registeredShortcuts);
    } catch (error) {
      console.error('Failed to load shortcuts:', error);
    }
  }, []);

  const validateAllShortcuts = (): string | null => {
    const usedShortcuts = new Set<string>();
    const conflicts: string[] = [];

    for (const [_, shortcut] of Object.entries(overlayShortcuts)) {
      if (shortcut && shortcut.trim()) {
        if (usedShortcuts.has(shortcut)) {
          conflicts.push(shortcut);
        } else {
          usedShortcuts.add(shortcut);
        }
      }
    }

    for (const [_, shortcut] of Object.entries(agentShortcuts)) {
      if (shortcut && shortcut.trim()) {
        if (usedShortcuts.has(shortcut)) {
          conflicts.push(shortcut);
        } else {
          usedShortcuts.add(shortcut);
        }
      }
    }

    if (conflicts.length > 0) {
      return `Duplicate shortcuts detected: ${conflicts.join(', ')}`;
    }

    return null;
  };

  const handleSaveAllShortcuts = useCallback(async () => {
    const validationError = validateAllShortcuts();
    if (validationError) {
      setShortcutFeedback({ message: validationError, type: 'error' });
      return;
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const unifiedConfigToSave = {
        overlay_toggle: overlayShortcuts.toggle.trim() || null,
        overlay_move_up: overlayShortcuts.move_up.trim() || null,
        overlay_move_down: overlayShortcuts.move_down.trim() || null,
        overlay_move_left: overlayShortcuts.move_left.trim() || null,
        overlay_move_right: overlayShortcuts.move_right.trim() || null,
        overlay_resize_up: overlayShortcuts.resize_up.trim() || null,
        overlay_resize_down: overlayShortcuts.resize_down.trim() || null,
        overlay_resize_left: overlayShortcuts.resize_left.trim() || null,
        overlay_resize_right: overlayShortcuts.resize_right.trim() || null,
        agent_shortcuts: agentShortcuts
      };

      await invoke('set_shortcut_config', { config: unifiedConfigToSave });

      setShortcutFeedback({
        message: 'All shortcuts saved! Restart the app to activate overlay shortcuts.',
        type: 'success'
      });

      setTimeout(() => setShortcutFeedback(null), 4000);
    } catch (error) {
      console.error('Failed to save shortcuts:', error);
      setShortcutFeedback({ message: `Error saving shortcuts: ${error}`, type: 'error' });
    }
  }, [overlayShortcuts, agentShortcuts]);

  // Load shortcuts on mount (desktop only)
  useEffect(() => {
    loadAllShortcuts();
  }, [loadAllShortcuts]);

  // Key capture effect (desktop only)
  useEffect(() => {
    if (!capturingFor || !isDesktop()) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        setCapturingFor(null);
        return;
      }

      const combo = buildKeyCombo(event);
      if (combo) {
        if (capturingFor.startsWith('overlay_')) {
          const overlayKey = capturingFor.replace('overlay_', '');
          setOverlayShortcuts(prev => ({
            ...prev,
            [overlayKey]: combo
          }));
        } else {
          setAgentShortcuts(prev => ({
            ...prev,
            [capturingFor]: combo
          }));
        }
        setCapturingFor(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [capturingFor]);

  // --- OVERLAY CONTROL HANDLERS (Desktop Only) ---
  const handleShowOverlay = useCallback(async () => {
    if (!isDesktop()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('show_overlay');
    } catch (error) {
      console.error('Failed to show overlay:', error);
    }
  }, []);

  const handleHideOverlay = useCallback(async () => {
    if (!isDesktop()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('hide_overlay');
    } catch (error) {
      console.error('Failed to hide overlay:', error);
    }
  }, []);

  const handleClearOverlay = useCallback(async () => {
    if (!isDesktop()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('clear_overlay_messages');
    } catch (error) {
      console.error('Failed to clear overlay:', error);
    }
  }, []);

  // --- TRANSCRIPTION MODE HANDLER ---
  const handleTranscriptionModeChange = (mode: TranscriptionMode) => {
    if (isTestRunning) {
      handleStopTest();
    }
    TranscriptionRouter.getInstance().setMode(mode);
    setTranscriptionModeState(mode);
  };

  const handleSelfHostedUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSelfHostedUrl(e.target.value);
    SensorSettings.setSelfHostedWhisperUrl(e.target.value);
  };

  // --- SIMPLE WHISPER HANDLERS ---

  const handleModelIdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newSettings = { ...whisperSettings, modelId: e.target.value };
    setWhisperSettings(newSettings);
    SensorSettings.setWhisperModelId(e.target.value);
  };

  const handleTaskChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const task = e.target.value || undefined;
    const newSettings = { ...whisperSettings, task: task as any };
    setWhisperSettings(newSettings);
    SensorSettings.setWhisperTask(task as any);
  };

  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const language = e.target.value || undefined;
    const newSettings = { ...whisperSettings, language };
    setWhisperSettings(newSettings);
    SensorSettings.setWhisperLanguage(language);
  };

  const handleQuantizedChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newSettings = { ...whisperSettings, quantized: e.target.checked };
    setWhisperSettings(newSettings);
    SensorSettings.setWhisperQuantized(e.target.checked);
  };

  const handleDeviceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const device = e.target.value as 'webgpu' | 'wasm';
    const newSettings = { ...whisperSettings, device };
    setWhisperSettings(newSettings);
    SensorSettings.setWhisperDevice(device);
  };

  const handleChunkDurationChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newDuration = parseInt(e.target.value, 10);
    const newSettings = { ...whisperSettings, chunkDurationMs: newDuration };
    setWhisperSettings(newSettings);
    SensorSettings.setWhisperChunkDuration(newDuration);
  };

  const handleLoadModel = async () => {
    try {
      await modelManager.loadModel();
    } catch (error) {
      console.error('Failed to load model:', error);
      alert(`Failed to load model: ${error}`);
    }
  };

  const handleUnloadModel = () => {
    if (isTestRunning) {
      handleStopTest();
    }
    modelManager.unloadModel();
  };


  const handleStartTest = async () => {
    // For local mode, ensure model is loaded
    if (transcriptionMode === 'local' && !modelManager.isReady()) {
      alert('Please load a model first');
      return;
    }

    // For self-hosted mode, ensure URL is configured
    if (transcriptionMode === 'self-hosted' && !selfHostedUrl.trim()) {
      alert('Please enter a Whisper server URL');
      return;
    }

    try {
      // Create new test ID and clear recording chunks
      currentTestIdRef.current = `test-${Date.now()}`;
      recordedChunksRef.current = [];

      // Map audio source to stream types
      const streamTypeMap: Record<AudioTestSource, ('microphone' | 'screenAudio')[]> = {
        'microphone': ['microphone'],
        'screenAudio': ['screenAudio'],
        'allAudio': ['microphone', 'screenAudio'],
      };
      const requiredStreams = streamTypeMap[audioTestSource];

      // Use StreamManager to acquire streams
      await StreamManager.requestStreamsForAgent(TEST_AGENT_ID, requiredStreams);
      const streams = StreamManager.getCurrentState();

      // Get the audio stream for MediaRecorder (for playback)
      let audioStream: MediaStream | null = null;

      if (audioTestSource === 'microphone') {
        audioStream = streams.microphoneStream;
      } else if (audioTestSource === 'screenAudio') {
        audioStream = streams.screenAudioStream;
      } else if (audioTestSource === 'allAudio') {
        // For allAudio, use screenAudio for recording (or fallback to mic)
        audioStream = streams.screenAudioStream || streams.microphoneStream;
      }

      if (!audioStream) {
        throw new Error(`Failed to acquire ${audioTestSource} stream`);
      }

      // Set up MediaRecorder for recording (for playback in history)
      try {
        const recorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm;codecs=opus' });
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            recordedChunksRef.current.push(e.data);
          }
        };
        recorder.start(1000); // Collect chunks every second
        mediaRecorderRef.current = recorder;
      } catch (recorderError) {
        console.warn('MediaRecorder not supported, playback will not be available:', recorderError);
      }

      // Transcription is already set up by StreamManager.requestStreamsForAgent()
      // via TranscriptionRouter.acquireService() - no need to create our own
      setIsTestRunning(true);
    } catch (error) {
      console.error('Failed to start transcription test:', error);
      StreamManager.releaseStreamsForAgent(TEST_AGENT_ID);
      alert(`Failed to start test: ${error}`);
    }
  };

  const handleStopTest = () => {
    // Capture current transcript before stopping (using deduplicated values)
    const currentTranscript = committedText + (committedText && interimText ? ' ' : '') + interimText;
    const testId = currentTestIdRef.current;
    const testSource = audioTestSource;

    // Stop MediaRecorder and save to history
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.onstop = () => {
        let audioUrl: string | null = null;
        if (recordedChunksRef.current.length > 0) {
          const blob = new Blob(recordedChunksRef.current, { type: 'audio/webm' });
          audioUrl = URL.createObjectURL(blob);
        }

        // Add to history (newest first) - include empty transcripts too
        if (testId) {
          setTranscriptionHistory(prev => [{
            id: testId,
            transcript: currentTranscript,
            audioUrl,
            timestamp: new Date(),
            source: testSource,
          }, ...prev]);
        }
      };
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    } else if (testId) {
      // No recording, but still save transcript (even if empty)
      setTranscriptionHistory(prev => [{
        id: testId,
        transcript: currentTranscript,
        audioUrl: null,
        timestamp: new Date(),
        source: testSource,
      }, ...prev]);
    }

    // Release streams
    StreamManager.releaseStreamsForAgent(TEST_AGENT_ID);
    setIsTestRunning(false);
    currentTestIdRef.current = null;
  };

  // Handle audio playback for a specific record
  const handlePlayRecording = (record: TranscriptionRecord) => {
    if (!record.audioUrl) return;

    // If clicking the same record that's playing, stop it
    if (playingRecordId === record.id && audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current.currentTime = 0;
      setPlayingRecordId(null);
      return;
    }

    // Stop any currently playing audio
    if (audioElementRef.current) {
      audioElementRef.current.pause();
    }

    // Play the new recording
    audioElementRef.current = new Audio(record.audioUrl);
    audioElementRef.current.onended = () => setPlayingRecordId(null);
    audioElementRef.current.play();
    setPlayingRecordId(record.id);
  };

  // Cleanup audio URLs on unmount
  useEffect(() => {
    return () => {
      // Cleanup all audio URLs in history
      transcriptionHistory.forEach(record => {
        if (record.audioUrl) {
          URL.revokeObjectURL(record.audioUrl);
        }
      });
      if (audioElementRef.current) {
        audioElementRef.current.pause();
        audioElementRef.current = null;
      }
    };
  }, []);

  if (view === 'subscription') {
    return (
      <div className="w-full pb-16 space-y-2">
        <div className="max-w-3xl mx-auto"><BackHeader title="Subscription" onBack={() => setView('main')} /></div>
        <ObServerTab />
      </div>
    );
  }

  if (view === 'main') {
    return (
      <div className="max-w-2xl mx-auto space-y-6 pb-16">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Settings</h1>

        <UserInfoCard />

        <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
          <div className="flex items-center gap-4 px-5 py-4">
            <span className="flex items-center justify-center h-9 w-9 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 flex-shrink-0">
              <Palette className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Appearance</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Dark mode</p>
            </div>
            {onToggleDarkMode && (
              <Switch checked={isDarkMode} onChange={onToggleDarkMode} label="Toggle dark mode" />
            )}
          </div>
          <NavRow icon={<Sparkles className="h-4 w-4" />} title="Subscription" description="Plans, billing, and usage" onClick={() => setView('subscription')} />
          {onOpenAccount && (
            <NavRow icon={<User className="h-4 w-4" />} title="Account" description="Profile and sign-in" onClick={onOpenAccount} />
          )}
          <NavRow icon={<Settings2 className="h-4 w-4" />} title="App Settings" description="Change detection, OCR, speech, shortcuts" onClick={() => setView('appSettings')} />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-16">
      <BackHeader title="App Settings" onBack={() => setView('main')} />

      {/* --- Desktop Only Settings --- */}
      {isDesktop() && (
        <>
          {/* --- Overlay Controls --- */}
          <Section title="Overlay Controls" description="Show, hide, or clear the floating overlay window." icon={<Layers className="h-4 w-4" />}>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleShowOverlay}
                className="flex items-center px-4 py-2 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 font-medium text-sm transition-colors"
              >
                <Eye className="h-4 w-4 mr-2" />
                Show Overlay
              </button>
              <button
                onClick={handleHideOverlay}
                className="flex items-center px-4 py-2 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 font-medium text-sm transition-colors"
              >
                <EyeOff className="h-4 w-4 mr-2" />
                Hide Overlay
              </button>
              <button
                onClick={handleClearOverlay}
                className="flex items-center px-4 py-2 border border-gray-200 dark:border-gray-700 text-red-600 dark:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/40 font-medium text-sm transition-colors"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Clear Messages
              </button>
            </div>
          </Section>

          {/* --- Keyboard Shortcuts --- */}
          <Section
            title="Keyboard Shortcuts"
            icon={<Keyboard className="h-4 w-4" />}
            badge={activeShortcuts.length > 0 ? (
              <span className="text-xs bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 px-2 py-1 rounded-full font-medium">
                {activeShortcuts.length} active
              </span>
            ) : undefined}
          >
            <div className="space-y-6">

              {/* Feedback Messages - Show at top */}
              {shortcutFeedback && (
                <div className={`flex items-center text-sm p-3 rounded-lg border ${
                  shortcutFeedback.type === 'success'
                    ? 'bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400 border-green-200 dark:border-green-900'
                    : 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 border-red-200 dark:border-red-900'
                }`}>
                  {shortcutFeedback.type === 'success' ? <Check className="h-4 w-4 mr-2 flex-shrink-0" /> : <AlertTriangle className="h-4 w-4 mr-2 flex-shrink-0" />}
                  {shortcutFeedback.message}
                </div>
              )}

              {/* Toggle Overlay Shortcut - Primary */}
              <div className="bg-gray-50 dark:bg-gray-800/50 p-4 rounded-xl border border-gray-100 dark:border-gray-800">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center min-w-0">
                    <Eye className="h-5 w-5 mr-3 text-gray-400 flex-shrink-0" />
                    <div className="min-w-0">
                      <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">Toggle Overlay</span>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Show or hide the overlay window</p>
                    </div>
                  </div>
                  <div className="flex items-center flex-shrink-0">
                    <button
                      onClick={() => setCapturingFor('overlay_toggle')}
                      disabled={capturingFor === 'overlay_toggle'}
                      className={`px-4 py-2 text-sm rounded-lg font-mono transition-all min-w-[140px] text-center border ${
                        capturingFor === 'overlay_toggle'
                          ? 'bg-orange-50 dark:bg-orange-950/30 text-orange-700 dark:text-orange-400 border-orange-300 dark:border-orange-800 animate-pulse'
                          : overlayShortcuts.toggle
                          ? 'bg-white dark:bg-gray-900 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-800 hover:border-purple-300'
                          : 'bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400 border-dashed border-gray-300 dark:border-gray-700 hover:border-gray-400'
                      }`}
                    >
                      {capturingFor === 'overlay_toggle' ? 'Press keys...' : overlayShortcuts.toggle || 'Click to set'}
                    </button>
                    {overlayShortcuts.toggle && capturingFor !== 'overlay_toggle' && (
                      <button
                        onClick={() => setOverlayShortcuts(prev => ({ ...prev, toggle: '' }))}
                        className="ml-2 p-1 text-gray-400 hover:text-red-500 transition-colors"
                        title="Clear shortcut"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Move Shortcuts - Collapsible */}
              <div className="border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden">
                <button
                  onClick={() => setShowMoveShortcuts(!showMoveShortcuts)}
                  className="w-full flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  <div className="flex items-center">
                    <Move className="h-4 w-4 mr-2 text-gray-400" />
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Move Overlay</span>
                    <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">
                      ({Object.entries(overlayShortcuts).filter(([k, v]) => k.startsWith('move_') && v).length}/4 set)
                    </span>
                  </div>
                  {showMoveShortcuts ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
                </button>
                {showMoveShortcuts && (
                  <div className="p-4 grid grid-cols-2 gap-3 bg-white dark:bg-gray-900">
                    {(['move_up', 'move_down', 'move_left', 'move_right'] as const).map((key) => (
                      <div key={key} className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
                        <span className="text-sm text-gray-600 dark:text-gray-400 capitalize">{key.replace('move_', '').replace('_', ' ')}</span>
                        <div className="flex items-center">
                          <button
                            onClick={() => setCapturingFor(`overlay_${key}`)}
                            disabled={capturingFor === `overlay_${key}`}
                            className={`px-3 py-1.5 text-xs rounded font-mono transition-all min-w-[80px] text-center border ${
                              capturingFor === `overlay_${key}`
                                ? 'bg-orange-50 dark:bg-orange-950/30 text-orange-700 dark:text-orange-400 border-orange-300 dark:border-orange-800 animate-pulse'
                                : overlayShortcuts[key]
                                ? 'bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700'
                                : 'bg-white dark:bg-gray-900 text-gray-400 dark:text-gray-500 border-dashed border-gray-300 dark:border-gray-700'
                            }`}
                          >
                            {capturingFor === `overlay_${key}` ? '...' : overlayShortcuts[key] || 'Set'}
                          </button>
                          {overlayShortcuts[key] && (
                            <button
                              onClick={() => setOverlayShortcuts(prev => ({ ...prev, [key]: '' }))}
                              className="ml-1 p-1 text-gray-300 dark:text-gray-600 hover:text-red-500"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Resize Shortcuts - Collapsible */}
              <div className="border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden">
                <button
                  onClick={() => setShowResizeShortcuts(!showResizeShortcuts)}
                  className="w-full flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  <div className="flex items-center">
                    <Maximize2 className="h-4 w-4 mr-2 text-gray-400" />
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Resize Overlay</span>
                    <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">
                      ({Object.entries(overlayShortcuts).filter(([k, v]) => k.startsWith('resize_') && v).length}/4 set)
                    </span>
                  </div>
                  {showResizeShortcuts ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
                </button>
                {showResizeShortcuts && (
                  <div className="p-4 grid grid-cols-2 gap-3 bg-white dark:bg-gray-900">
                    {(['resize_up', 'resize_down', 'resize_left', 'resize_right'] as const).map((key) => (
                      <div key={key} className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
                        <span className="text-sm text-gray-600 dark:text-gray-400 capitalize">{key.replace('resize_', '').replace('_', ' ')}</span>
                        <div className="flex items-center">
                          <button
                            onClick={() => setCapturingFor(`overlay_${key}`)}
                            disabled={capturingFor === `overlay_${key}`}
                            className={`px-3 py-1.5 text-xs rounded font-mono transition-all min-w-[80px] text-center border ${
                              capturingFor === `overlay_${key}`
                                ? 'bg-orange-50 dark:bg-orange-950/30 text-orange-700 dark:text-orange-400 border-orange-300 dark:border-orange-800 animate-pulse'
                                : overlayShortcuts[key]
                                ? 'bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700'
                                : 'bg-white dark:bg-gray-900 text-gray-400 dark:text-gray-500 border-dashed border-gray-300 dark:border-gray-700'
                            }`}
                          >
                            {capturingFor === `overlay_${key}` ? '...' : overlayShortcuts[key] || 'Set'}
                          </button>
                          {overlayShortcuts[key] && (
                            <button
                              onClick={() => setOverlayShortcuts(prev => ({ ...prev, [key]: '' }))}
                              className="ml-1 p-1 text-gray-300 dark:text-gray-600 hover:text-red-500"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Agent Shortcuts Section */}
              <div className="border-t border-gray-100 dark:border-gray-800 pt-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center">
                    <Zap className="h-4 w-4 mr-2 text-gray-400" />
                    <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">Agent Shortcuts</span>
                  </div>
                  <span className="text-xs text-gray-400 dark:text-gray-500">{availableAgents.length} configured</span>
                </div>

                {/* Add New Agent */}
                <div className="flex items-center gap-2 mb-4">
                  <input
                    type="text"
                    value={newAgentId}
                    onChange={(e) => setNewAgentId(e.target.value)}
                    placeholder="Enter agent ID..."
                    className={`flex-grow ${inputClass}`}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddAgent()}
                  />
                  <button
                    onClick={handleAddAgent}
                    disabled={!newAgentId.trim()}
                    className="px-4 py-2 bg-purple-600 text-white text-sm rounded-lg hover:bg-purple-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed transition-colors font-medium"
                  >
                    Add
                  </button>
                </div>

                {/* Agent List */}
                {availableAgents.length > 0 ? (
                  <div className="space-y-2">
                    {availableAgents.map((agent) => {
                      const shortcut = agentShortcuts[agent.id];
                      const isDuplicate = shortcut && Object.entries(agentShortcuts)
                        .filter(([id, s]) => id !== agent.id && s === shortcut).length > 0;

                      return (
                        <div key={agent.id} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                          <span className="text-sm text-gray-700 dark:text-gray-300 font-medium">{agent.name}</span>
                          <div className="flex items-center">
                            <button
                              onClick={() => setCapturingFor(agent.id)}
                              disabled={capturingFor === agent.id}
                              className={`px-3 py-1.5 text-xs rounded-lg font-mono transition-all min-w-[120px] text-center border ${
                                capturingFor === agent.id
                                  ? 'bg-orange-50 dark:bg-orange-950/30 text-orange-700 dark:text-orange-400 border-orange-300 dark:border-orange-800 animate-pulse'
                                  : isDuplicate
                                  ? 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 border-red-300 dark:border-red-800'
                                  : agentShortcuts[agent.id]
                                  ? 'bg-white dark:bg-gray-900 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-800'
                                  : 'bg-white dark:bg-gray-900 text-gray-400 dark:text-gray-500 border-dashed border-gray-300 dark:border-gray-700'
                              }`}
                            >
                              {capturingFor === agent.id ? 'Press keys...' : agentShortcuts[agent.id] || 'Click to set'}
                              {isDuplicate && ' ⚠️'}
                            </button>
                            <button
                              onClick={() => {
                                setAvailableAgents(prev => prev.filter(a => a.id !== agent.id));
                                setAgentShortcuts(prev => {
                                  const updated = { ...prev };
                                  delete updated[agent.id];
                                  return updated;
                                });
                              }}
                              className="ml-2 p-1 text-gray-300 dark:text-gray-600 hover:text-red-500 transition-colors"
                              title="Remove agent"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-center py-6 bg-gray-50 dark:bg-gray-800/50 rounded-lg border-2 border-dashed border-gray-200 dark:border-gray-700">
                    <Zap className="h-8 w-8 mx-auto text-gray-300 dark:text-gray-600 mb-2" />
                    <p className="text-sm text-gray-500 dark:text-gray-400">No agent shortcuts configured</p>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Add an agent ID above to create a shortcut</p>
                  </div>
                )}
              </div>

              {/* Save Button & Help */}
              <div className="border-t border-gray-100 dark:border-gray-800 pt-6 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Click any button and press your desired key combination. Press Escape to cancel.
                  </p>
                  <button
                    onClick={handleSaveAllShortcuts}
                    className="px-5 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500 text-sm font-semibold transition-colors flex-shrink-0"
                  >
                    Save Shortcuts
                  </button>
                </div>
                <p className="text-xs text-gray-400 dark:text-gray-500">
                  Overlay shortcuts require an app restart to take effect. Agent shortcuts are applied immediately.
                </p>
              </div>
            </div>
          </Section>

          {/* --- Screen Capture Quality --- */}
          <Section title="Screen Capture Quality" icon={<Monitor className="h-4 w-4" />}>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label htmlFor="cap-max-width" className={labelClass}>Max width (px)</label>
                <input
                  id="cap-max-width"
                  type="number"
                  min={160}
                  max={7680}
                  step={2}
                  value={captureQuality.maxWidth}
                  onChange={(e) => handleCaptureQualityChange('maxWidth', parseInt(e.target.value, 10) || 0)}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="cap-jpeg-quality" className={labelClass}>JPEG quality (1–100)</label>
                <input
                  id="cap-jpeg-quality"
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={captureQuality.jpegQuality}
                  onChange={(e) => handleCaptureQualityChange('jpegQuality', parseInt(e.target.value, 10) || 0)}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="cap-fps" className={labelClass}>FPS</label>
                <input
                  id="cap-fps"
                  type="number"
                  min={1}
                  max={120}
                  step={1}
                  value={captureQuality.fps}
                  onChange={(e) => handleCaptureQualityChange('fps', parseInt(e.target.value, 10) || 0)}
                  className={inputClass}
                />
              </div>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-3">
              Higher values are sharper but use more CPU. Changes apply the next time screen capture starts — toggle the screen sensor off and on to re-tune. Defaults: 1280 / 55 / 10.
            </p>
          </Section>
        </>
      )}

      {/* --- Change Detection Settings --- */}
      <Section title="Change Detection" icon={<SlidersHorizontal className="h-4 w-4" />}>
        <ChangeDetectionSettings compact={false} />
      </Section>

      {/* --- Screen OCR Settings --- */}
      <Section title="OCR Settings" icon={<ScanText className="h-4 w-4" />}>
        <div>
          <label htmlFor="ocr-lang" className={labelClass}>Recognition Language</label>
          <select id="ocr-lang" value={ocrLang} onChange={handleOcrLangChange} className={inputClass}>
          {AVAILABLE_OCR_LANGUAGES.map(lang => <option key={lang.code} value={lang.code}>{lang.label}</option>)}
          </select>
        </div>
      </Section>

      {/* --- Whisper Model Management --- */}
      <Section title="Whisper Speech Recognition" icon={<AudioLines className="h-4 w-4" />}>
        <div className="space-y-6">
          {/* Transcription Mode Toggle */}
          <div className="bg-gray-50 dark:bg-gray-800/50 p-4 rounded-xl border border-gray-100 dark:border-gray-800">
            <label className={labelClass}>
              Transcription Mode
            </label>
            <div className="flex gap-2">
              <SegmentButton
                active={transcriptionMode === 'cloud'}
                onClick={() => handleTranscriptionModeChange('cloud')}
                icon={<Cloud className="h-4 w-4" />}
                label="Cloud"
                sublabel="Real-time, low overhead"
              />
              <SegmentButton
                active={transcriptionMode === 'self-hosted'}
                onClick={() => handleTranscriptionModeChange('self-hosted')}
                icon={<Server className="h-4 w-4" />}
                label="Self-Hosted"
                sublabel="Your own Whisper server"
              />
              <SegmentButton
                active={transcriptionMode === 'local'}
                onClick={() => handleTranscriptionModeChange('local')}
                icon={<Cpu className="h-4 w-4" />}
                label="Browser"
                sublabel="Offline, uses CPU"
              />
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-3">
              {transcriptionMode === 'cloud'
                ? 'Audio is streamed to Observer servers for real-time transcription.'
                : transcriptionMode === 'self-hosted'
                ? 'Audio is sent to your own Whisper-compatible server for processing.'
                : 'Audio is processed locally in your browser using transformers.js Very CPU intensive!'}
            </p>
          </div>

          {/* Self-Hosted URL input */}
          {transcriptionMode === 'self-hosted' && (
            <div className="bg-gray-50 dark:bg-gray-800/50 p-4 rounded-xl border border-gray-100 dark:border-gray-800">
              <label className={labelClass}>
                Whisper Server URL
              </label>
              <input
                type="url"
                placeholder="http://localhost:8000"
                value={selfHostedUrl}
                onChange={handleSelfHostedUrlChange}
                className={inputClass}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                OpenAI-compatible endpoint (faster-whisper, whisper.cpp, speaches, etc.)
              </p>
            </div>
          )}

          {/* Local Mode: Model Configuration */}
          {transcriptionMode === 'local' && (
          <>
          <div>
            <label htmlFor="model-id" className={labelClass}>
              Model ID
            </label>
            <input
              type="text"
              id="model-id"
              value={whisperSettings.modelId}
              onChange={handleModelIdChange}
              placeholder="Enter any HuggingFace model ID"
              list="model-suggestions"
              disabled={modelState?.status === 'loading' || modelState?.status === 'loaded'}
              className={inputClass}
            />
            <datalist id="model-suggestions">
              {SUGGESTED_MODELS.map(model => (
                <option key={model} value={model} />
              ))}
            </datalist>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Examples: onnx-community/whisper-small.en (English only), onnx-community/whisper-small (multilingual)
            </p>
          </div>

          {/* Responsive Options - Only show for multilingual models */}
          {!whisperSettings.modelId.endsWith('.en') && (
            <div className="bg-gray-50 dark:bg-gray-800/50 p-4 rounded-xl border border-gray-100 dark:border-gray-800">
              <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">Multilingual Options</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="task" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Task
                  </label>
                  <select
                    id="task"
                    value={whisperSettings.task || ''}
                    onChange={handleTaskChange}
                    className={inputClass}
                  >
                    <option value="">Default (transcribe)</option>
                    <option value="transcribe">Transcribe</option>
                    <option value="translate">Translate to English</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="language" className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Language
                  </label>
                  <select
                    id="language"
                    value={whisperSettings.language || ''}
                    onChange={handleLanguageChange}
                    className={inputClass}
                  >
                    <option value="">Auto-detect</option>
                    {Object.entries(LANGUAGE_NAMES).map(([code, name]) => (
                      <option key={code} value={code}>{name}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Quantized Option */}
          <div className="flex items-center">
            <input
              type="checkbox"
              id="quantized"
              checked={whisperSettings.quantized}
              onChange={handleQuantizedChange}
              className="h-4 w-4 text-purple-600 border-gray-300 dark:border-gray-600 rounded focus:ring-purple-500"
            />
            <label htmlFor="quantized" className="ml-2 text-sm font-medium text-gray-700 dark:text-gray-300">
              Quantized (smaller file sizes, faster loading)
            </label>
          </div>

          {/* Compute Backend */}
          <div>
            <label htmlFor="whisper-device" className={labelClass}>
              Compute Backend
            </label>
            <select
              id="whisper-device"
              value={whisperSettings.device || 'wasm'}
              onChange={handleDeviceChange}
              disabled={modelState?.status === 'loading' || modelState?.status === 'loaded'}
              className={inputClass}
            >
              <option value="wasm">WASM (CPU — works everywhere)</option>
              <option value="webgpu">WebGPU (GPU — faster, needs browser support)</option>
            </select>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              WebGPU is much faster for larger models but isn't available in every browser. If the model fails to load, switch back to WASM.
            </p>
          </div>
          </>
          )}

          {/* Chunk Duration - Shared by both modes */}
          {transcriptionMode !== 'cloud' && (
          <div>
            <label htmlFor="chunk-duration" className={labelClass}>
              Chunk Duration ({Math.round(whisperSettings.chunkDurationMs / 1000)}s)
            </label>
            <input
              type="range"
              id="chunk-duration"
              min="1000"
              max="60000"
              step="1000"
              value={whisperSettings.chunkDurationMs}
              onChange={handleChunkDurationChange}
              disabled={isTestRunning}
              className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer disabled:cursor-not-allowed accent-purple-600"
            />
            <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mt-1">
              <span>1s</span>
              <span>30s</span>
              <span>60s</span>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
              Each agent accumulates transcripts during its loop window and clears them after processing.
            </p>
          </div>
          )}

          {/* Local Mode: Model Management Buttons */}
          {transcriptionMode === 'local' && (
            <div className="flex items-center space-x-3">
              <button
                onClick={handleLoadModel}
                disabled={modelState?.status === 'loading' || modelState?.status === 'loaded'}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed flex items-center transition-colors text-sm font-medium"
              >
                {modelState?.status === 'loading' ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : modelState?.status === 'loaded' ? (
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                ) : (
                  <Database className="mr-2 h-4 w-4" />
                )}
                {modelState?.status === 'loading' ? 'Loading...' : modelState?.status === 'loaded' ? 'Model Loaded' : 'Load Model'}
              </button>

              {modelState?.status === 'loaded' && (
                <button
                  onClick={handleUnloadModel}
                  className="px-4 py-2 border border-gray-200 dark:border-gray-700 text-red-600 dark:text-red-400 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/40 flex items-center transition-colors text-sm font-medium"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Unload Model
                </button>
              )}
            </div>
          )}

          {/* Audio Source Toggle + Test Button */}
          <div className="bg-gray-50 dark:bg-gray-800/50 p-4 rounded-xl border border-gray-100 dark:border-gray-800">
            <label className={labelClass}>
              Test Audio Source
            </label>
            <div className="flex flex-wrap gap-2 mb-4">
              <button
                onClick={() => setAudioTestSource('microphone')}
                disabled={isTestRunning}
                className={`flex items-center px-3 py-2 rounded-lg border transition-colors ${
                  audioTestSource === 'microphone'
                    ? 'border-purple-300 dark:border-purple-700 bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300'
                    : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:border-gray-300'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <Mic className="h-4 w-4 mr-2" />
                <span className="text-sm font-medium">Microphone</span>
              </button>
              <button
                onClick={() => setAudioTestSource('screenAudio')}
                disabled={isTestRunning}
                className={`flex items-center px-3 py-2 rounded-lg border transition-colors ${
                  audioTestSource === 'screenAudio'
                    ? 'border-purple-300 dark:border-purple-700 bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300'
                    : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:border-gray-300'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <Monitor className="h-4 w-4 mr-2" />
                <span className="text-sm font-medium">Screen Audio</span>
              </button>
              <button
                onClick={() => setAudioTestSource('allAudio')}
                disabled={isTestRunning}
                className={`flex items-center px-3 py-2 rounded-lg border transition-colors ${
                  audioTestSource === 'allAudio'
                    ? 'border-purple-300 dark:border-purple-700 bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300'
                    : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:border-gray-300'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <Volume2 className="h-4 w-4 mr-2" />
                <span className="text-sm font-medium">All Audio</span>
              </button>
            </div>

            <div className="flex items-center flex-wrap gap-3">
              <button
                onClick={isTestRunning ? handleStopTest : handleStartTest}
              disabled={
                (transcriptionMode === 'local' && modelState?.status !== 'loaded') ||
                (transcriptionMode === 'self-hosted' && !selfHostedUrl.trim())
              }
              className={`px-4 py-2 rounded-lg text-white flex items-center transition-colors disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-sm font-medium ${
                isTestRunning ? 'bg-red-600 hover:bg-red-700' : 'bg-purple-600 hover:bg-purple-700'
              }`}
            >
              <TestTube2 className="mr-2 h-4 w-4" />
              {isTestRunning ? 'Stop Test' : 'Start Test'}
            </button>
            {transcriptionMode === 'cloud' && (
              <span className="text-sm text-green-600 dark:text-green-400 flex items-center">
                <CheckCircle2 className="h-4 w-4 mr-1" />
                Cloud Ready
              </span>
            )}
            {transcriptionMode === 'self-hosted' && selfHostedUrl.trim() && (
              <span className="text-sm text-green-600 dark:text-green-400 flex items-center">
                <CheckCircle2 className="h-4 w-4 mr-1" />
                Server Configured
              </span>
            )}
            {transcriptionMode === 'self-hosted' && !selfHostedUrl.trim() && (
              <span className="text-sm text-amber-600 dark:text-amber-400 flex items-center">
                Enter server URL to enable
              </span>
            )}
            </div>
          </div>

          {/* Local Mode: Model Loading Progress */}
          {transcriptionMode === 'local' && modelState?.status === 'loading' && modelState.progress.length > 0 && (
            <div className="space-y-3 pt-2">
              <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                Loading Model: {modelState.config?.modelId}
              </h4>
              {modelState.progress.map((item) => (
                <div key={item.file}>
                  <div className="flex justify-between items-center text-sm mb-1">
                    <span className="text-gray-600 dark:text-gray-400 flex items-center truncate max-w-[60%]">
                      {item.status === 'done'
                        ? <CheckCircle2 className="h-4 w-4 text-green-500 mr-2 flex-shrink-0"/>
                        : <FileDown className="h-4 w-4 text-gray-400 mr-2 flex-shrink-0"/>
                      }
                      <span className="truncate">{item.file}</span>
                    </span>
                    <span className="font-medium text-gray-500 dark:text-gray-400 flex-shrink-0">
                      {item.status === 'done'
                        ? 'Done'
                        : item.total > 0
                          ? `${formatBytes(item.loaded)} / ${formatBytes(item.total)}`
                          : `${Math.round(item.progress)}%`
                      }
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                    <div
                      className={`h-2 rounded-full transition-all duration-300 ${
                        item.status === 'done' ? 'bg-green-500' : 'bg-purple-600'
                      }`}
                      style={{ width: `${item.progress}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Local Mode: Error Display */}
          {transcriptionMode === 'local' && modelState?.error && (
            <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg p-3">
              <p className="text-sm text-red-800 dark:text-red-300">
                <strong>Error:</strong> {modelState.error}
              </p>
            </div>
          )}

          {/* Transcription Results */}
          <div>
            <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Live Transcription</h4>
            <div className="border border-gray-200 dark:border-gray-800 rounded-xl bg-gray-50 dark:bg-gray-800/50 max-h-96 overflow-y-auto">
              {/* Currently running test */}
              {isTestRunning && (
                <div className="p-3 border-b border-gray-200 dark:border-gray-800 bg-purple-50/60 dark:bg-purple-950/20">
                  <div className="flex items-start gap-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <Loader2 className="h-4 w-4 animate-spin text-purple-500" />
                        <span className="text-xs font-medium text-purple-600 dark:text-purple-400">
                          Recording ({audioTestSource === 'microphone' ? 'Mic' : audioTestSource === 'screenAudio' ? 'Screen' : 'All'})
                        </span>
                      </div>
                      <p className="text-gray-800 dark:text-gray-200 text-sm leading-relaxed whitespace-pre-wrap">
                        {(committedText || interimText) ? (
                          <>
                            <span>{committedText}</span>
                            {committedText && interimText && ' '}
                            <span className="text-gray-500 dark:text-gray-400 italic">{interimText}</span>
                          </>
                        ) : (
                          <span className="text-gray-400 dark:text-gray-500 italic">
                            {audioTestSource === 'microphone' ? 'Speak into your microphone...' : 'Play some audio on your device...'}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Transcription history */}
              {transcriptionHistory.map((record) => (
                <div key={record.id} className="p-3 border-b border-gray-200 dark:border-gray-800 last:border-b-0 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          {record.source === 'microphone' ? (
                            <Mic className="h-3 w-3 inline mr-1" />
                          ) : record.source === 'screenAudio' ? (
                            <Monitor className="h-3 w-3 inline mr-1" />
                          ) : (
                            <Volume2 className="h-3 w-3 inline mr-1" />
                          )}
                          {record.timestamp.toLocaleTimeString()}
                        </span>
                      </div>
                      <p className="text-gray-800 dark:text-gray-200 text-sm leading-relaxed whitespace-pre-wrap">
                        {record.transcript}
                      </p>
                    </div>
                    {record.audioUrl && (
                      <button
                        onClick={() => handlePlayRecording(record)}
                        className={`flex-shrink-0 p-2 rounded-full transition-colors ${
                          playingRecordId === record.id
                            ? 'bg-red-100 dark:bg-red-950/50 text-red-600 dark:text-red-400 hover:bg-red-200'
                            : 'bg-purple-100 dark:bg-purple-950/50 text-purple-600 dark:text-purple-400 hover:bg-purple-200'
                        }`}
                        title={playingRecordId === record.id ? 'Stop' : 'Play recording'}
                      >
                        {playingRecordId === record.id ? (
                          <Square className="h-4 w-4" />
                        ) : (
                          <Play className="h-4 w-4" />
                        )}
                      </button>
                    )}
                  </div>
                </div>
              ))}

              {/* Empty state */}
              {!isTestRunning && transcriptionHistory.length === 0 && (
                <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">
                  Start a test to see transcription results here.
                </p>
              )}
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
};

export default SettingsTab;
