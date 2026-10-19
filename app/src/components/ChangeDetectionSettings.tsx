import React, { useState, useEffect } from 'react';
import { Camera, Monitor, Zap } from 'lucide-react';
import {
  DetectionMode,
  getChangeDetectionMode,
  setChangeDetectionMode,
  getThresholds,
  setTextSimilarityThreshold,
  setDHashSimilarityThreshold,
  setSuspiciousSimilarityThreshold,
  setPixelSimilarityThreshold
} from '../utils/change_detector';

// Mode-specific smart defaults
interface PresetConfig {
  textSimilarity: number;
  dhashImageSimilarity: number;
  pixelImageSimilarity: number;
  suspiciousSimilarity: number;
}

const MODE_DEFAULTS: Record<string, PresetConfig> = {
  "Detect Mainly Camera Changes": {
    textSimilarity: 0.90,
    dhashImageSimilarity: 0.85, // More lenient for camera noise
    pixelImageSimilarity: 0.95, // Not used but set sensibly
    suspiciousSimilarity: 0.998, // Not used
  },
  "Detect Mainly UI Changes": {
    textSimilarity: 0.90,
    dhashImageSimilarity: 0.90, // Not used
    pixelImageSimilarity: 0.95, // Strict for UI testing
    suspiciousSimilarity: 0.998, // Not used
  },
  "Hybrid": {
    textSimilarity: 0.90,
    dhashImageSimilarity: 0.90,
    pixelImageSimilarity: 0.95,
    suspiciousSimilarity: 0.998,
  },
};

// Mode card configuration
interface ModeCardConfig {
  mode: DetectionMode;
  IconComponent: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  bestFor: string[];
  isRecommended?: boolean;
}

interface ChangeDetectionSettingsProps {
  compact?: boolean; // For modal view
  useTextInputs?: boolean; // Use text inputs instead of sliders
  focusedThreshold?: 'text' | 'dhash' | 'pixel' | 'suspicious'; // For focused modal mode
}

const ChangeDetectionSettings: React.FC<ChangeDetectionSettingsProps> = ({
  compact = false,
  useTextInputs = compact, // Default to text inputs in compact mode
  focusedThreshold,
}) => {
  const MODE_CARDS: ModeCardConfig[] = [
    {
      mode: DetectionMode.Hybrid,
      IconComponent: Zap,
      title: "Smart (Auto)",
      description: "Intelligently adapts to what you're monitoring",
      bestFor: ["Mixed content", "Unsure", "General use"],
      isRecommended: true,
    },
    {
      mode: DetectionMode.DHashOnly,
      IconComponent: Camera,
      title: "Camera Feed",
      description: "Handles lighting changes, compression, and movement",
      bestFor: ["Webcams", "Video streams", "Live feeds"],
    },
    {
      mode: DetectionMode.PixelDifferenceOnly,
      IconComponent: Monitor,
      title: "Screen UI",
      description: "Detects pixel-perfect changes in applications",
      bestFor: ["Apps", "Websites", "UI testing"],
    },
  ];
  const [detectionMode, setDetectionModeState] = useState(getChangeDetectionMode());
  const [thresholds, setThresholds] = useState(getThresholds());
  // Track which threshold to show in focused mode (can change based on mode selection)
  const [activeFocusedThreshold, setActiveFocusedThreshold] = useState(focusedThreshold);

  // Sync with global state changes
  useEffect(() => {
    const interval = setInterval(() => {
      setDetectionModeState(getChangeDetectionMode());
      setThresholds(getThresholds());
    }, 500); // Reduced from 100ms
    return () => clearInterval(interval);
  }, []);

  const handleModeSelect = (mode: DetectionMode) => {
    setDetectionModeState(mode);
    setChangeDetectionMode(mode);

    // Apply mode-specific smart defaults
    const defaults = MODE_DEFAULTS[mode];
    setTextSimilarityThreshold(defaults.textSimilarity);
    setDHashSimilarityThreshold(defaults.dhashImageSimilarity);
    setPixelSimilarityThreshold(defaults.pixelImageSimilarity);
    setSuspiciousSimilarityThreshold(defaults.suspiciousSimilarity);
    setThresholds(defaults);

    // Update focused threshold based on mode (for focused modal view)
    if (focusedThreshold) {
      if (mode === DetectionMode.DHashOnly) {
        setActiveFocusedThreshold('dhash');
      } else if (mode === DetectionMode.PixelDifferenceOnly) {
        setActiveFocusedThreshold('pixel');
      } else if (mode === DetectionMode.Hybrid) {
        // In hybrid mode, keep the original focused threshold or default to suspicious
        setActiveFocusedThreshold(focusedThreshold);
      }
    }
  };

  const handleTextSimilarityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(e.target.value);
    setTextSimilarityThreshold(value);
    setThresholds({ ...thresholds, textSimilarity: value });
  };

  const handleDHashSimilarityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(e.target.value);
    setDHashSimilarityThreshold(value);
    setThresholds({ ...thresholds, dhashImageSimilarity: value });
  };

  const handleSuspiciousSimilarityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(e.target.value);
    setSuspiciousSimilarityThreshold(value);
    setThresholds({ ...thresholds, suspiciousSimilarity: value });
  };

  const handlePixelSimilarityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(e.target.value);
    setPixelSimilarityThreshold(value);
    setThresholds({ ...thresholds, pixelImageSimilarity: value });
  };

  // Helper to check if threshold is relevant for current mode
  const isThresholdRelevant = (threshold: 'text' | 'dhash' | 'pixel' | 'suspicious') => {
    switch (threshold) {
      case 'text':
        return true; // Always shown
      case 'dhash':
        return detectionMode !== DetectionMode.PixelDifferenceOnly;
      case 'pixel':
        return detectionMode !== DetectionMode.DHashOnly;
      case 'suspicious':
        return detectionMode === DetectionMode.Hybrid;
      default:
        return false;
    }
  };

  // Helper to determine visual state of threshold
  const getThresholdState = (threshold: 'text' | 'dhash' | 'pixel' | 'suspicious'): 'active' | 'inactive' => {
    if (!isThresholdRelevant(threshold)) return 'inactive';
    return 'active';
  };

  // Helper to get inactive message
  const getInactiveMessage = (threshold: 'text' | 'dhash' | 'pixel' | 'suspicious'): string => {
    const modeName = detectionMode === DetectionMode.DHashOnly ? 'Camera' :
                     detectionMode === DetectionMode.PixelDifferenceOnly ? 'Screen UI' : 'Hybrid';

    switch (threshold) {
      case 'dhash':
        return `Not used in ${modeName} mode`;
      case 'pixel':
        return `Not used in ${modeName} mode`;
      case 'suspicious':
        return 'Only used in Hybrid mode';
      default:
        return '';
    }
  };

  // If focused mode, render simplified view
  if (activeFocusedThreshold) {
    const thresholdConfig = {
      text: {
        label: '📝 Text Changes',
        value: thresholds.textSimilarity,
        onChange: handleTextSimilarityChange,
        min: 0.5,
        max: 1.0,
        step: 0.01,
      },
      dhash: {
        label: '📷 Camera Changes',
        value: thresholds.dhashImageSimilarity,
        onChange: handleDHashSimilarityChange,
        min: 0.5,
        max: 1.0,
        step: 0.01,
      },
      pixel: {
        label: '🖥️ UI Changes',
        value: thresholds.pixelImageSimilarity,
        onChange: handlePixelSimilarityChange,
        min: 0.5,
        max: 1.0,
        step: 0.01,
      },
      suspicious: {
        label: '⚡ Pixel Check Trigger',
        value: thresholds.suspiciousSimilarity,
        onChange: handleSuspiciousSimilarityChange,
        min: 0.95,
        max: 1.0,
        step: 0.001,
      },
    };

    const config = thresholdConfig[activeFocusedThreshold];
    const currentPercent = (config.value * 100).toFixed(activeFocusedThreshold === 'suspicious' ? 2 : 0);

    return (
      <div className="space-y-4">
        {/* Mode Selector */}
        <div className="flex gap-2">
          {MODE_CARDS.map((card) => {
            const isSelected = detectionMode === card.mode;
            // Show checkmark in Hybrid mode based on what was detected
            const showCheckmark = detectionMode === DetectionMode.Hybrid && (
              (activeFocusedThreshold === 'dhash' && card.mode === DetectionMode.DHashOnly) ||
              (activeFocusedThreshold === 'pixel' && card.mode === DetectionMode.PixelDifferenceOnly)
            );

            return (
              <button
                key={card.mode}
                onClick={() => handleModeSelect(card.mode)}
                className={`flex-1 px-3 py-2 border-2 rounded-lg cursor-pointer transition-all flex items-center justify-center gap-1.5 ${
                  isSelected
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm'
                }`}
              >
                <card.IconComponent
                  className={`h-4 w-4 ${isSelected ? 'text-blue-600' : 'text-gray-500'}`}
                />
                <span className={`text-sm font-semibold ${isSelected ? 'text-blue-900' : 'text-gray-700'}`}>
                  {card.title}
                </span>
                {showCheckmark && (
                  <span className="text-blue-600 font-bold">✓</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Threshold Control */}
        <div>
          <label className="block text-sm font-medium text-gray-900 mb-2">
            {config.label}
          </label>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={config.min}
              max={config.max}
              step={config.step}
              value={config.value}
              onChange={config.onChange}
              className="flex-1 h-2 bg-blue-200 rounded-lg appearance-none cursor-pointer"
            />
            <span className="text-lg font-bold text-blue-700 min-w-[4rem] text-right">{currentPercent}%</span>
          </div>
          <div className="text-xs text-gray-600 text-center mt-2">
            Less sensitive ← → More sensitive
          </div>
        </div>
      </div>
    );
  }

  // Regular full settings view
  return (
    <div className={compact ? 'space-y-4' : 'space-y-5'}>
      {/* Mode Selection - Compact Horizontal */}
      <div>
        <label className="block text-sm font-medium text-gray-900 mb-2">
          What are you monitoring?
        </label>
        <div className="flex gap-2">
          {MODE_CARDS.map((card) => {
            const isSelected = detectionMode === card.mode;
            return (
              <button
                key={card.mode}
                onClick={() => handleModeSelect(card.mode)}
                className={`flex-1 p-2 border-2 rounded-lg cursor-pointer transition-all ${
                  isSelected
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm'
                }`}
              >
                <div className="flex flex-col items-center gap-1.5">
                  <card.IconComponent
                    className={`h-5 w-5 ${isSelected ? 'text-blue-600' : 'text-gray-500'}`}
                  />
                  <span className={`text-sm font-semibold ${isSelected ? 'text-blue-900' : 'text-gray-700'}`}>
                    {card.title}
                  </span>
                  {!compact && isSelected && (
                    <p className="text-xs text-gray-600 mt-0.5">{card.description}</p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Threshold Controls */}
      <div>
        <label className="block text-sm font-medium text-gray-900 mb-2">
          Thresholds
        </label>
        <div className={compact ? 'space-y-3' : 'space-y-4'}>
          {/* Text Similarity */}
          <div className={getThresholdState('text') === 'inactive' ? 'opacity-50' : ''}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <label htmlFor="text-similarity" className="text-sm font-medium text-gray-900">
                  📝 Text Changes
                </label>
                {getThresholdState('text') === 'active' && (
                  <span className="text-xs text-blue-600 font-medium">← ACTIVE</span>
                )}
              </div>
              <div className="flex items-center space-x-2">
                <input
                  type="number"
                  min="0.5"
                  max="1.0"
                  step="0.01"
                  value={thresholds.textSimilarity.toFixed(2)}
                  onChange={(e) => {
                    const value = parseFloat(e.target.value);
                    if (value >= 0.5 && value <= 1.0) {
                      handleTextSimilarityChange(e);
                    }
                  }}
                  disabled={getThresholdState('text') === 'inactive'}
                  className="w-16 px-2 py-1 text-xs border border-gray-300 rounded focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
                />
                <span className={`text-sm font-semibold ${getThresholdState('text') === 'active' ? 'text-blue-700' : 'text-gray-500'}`}>
                  {(thresholds.textSimilarity * 100).toFixed(0)}%
                </span>
              </div>
            </div>
            {!useTextInputs && (
              <>
                <input
                  type="range"
                  id="text-similarity"
                  min="0.5"
                  max="1.0"
                  step="0.01"
                  value={thresholds.textSimilarity}
                  onChange={handleTextSimilarityChange}
                  disabled={getThresholdState('text') === 'inactive'}
                  className={`w-full h-2 rounded-lg appearance-none cursor-pointer ${
                    getThresholdState('text') === 'active' ? 'bg-blue-200' : 'bg-gray-300 cursor-not-allowed'
                  }`}
                />
                <p className="text-xs text-gray-600 mt-1">
                  {getThresholdState('text') === 'inactive'
                    ? getInactiveMessage('text')
                    : 'Lower values detect smaller text changes'}
                </p>
              </>
            )}
          </div>

          {/* DHash Similarity */}
          <div className={getThresholdState('dhash') === 'inactive' ? 'opacity-50' : ''}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <label htmlFor="dhash-similarity" className="text-sm font-medium text-gray-900">
                  📷 Camera Changes
                </label>
                {getThresholdState('dhash') === 'active' && (
                  <span className="text-xs text-blue-600 font-medium">← ACTIVE</span>
                )}
                {getThresholdState('dhash') === 'inactive' && (
                  <span className="text-xs text-gray-500 font-medium">⚫ {getInactiveMessage('dhash')}</span>
                )}
              </div>
              <div className="flex items-center space-x-2">
                <input
                  type="number"
                  min="0.5"
                  max="1.0"
                  step="0.01"
                  value={thresholds.dhashImageSimilarity.toFixed(2)}
                  onChange={(e) => {
                    const value = parseFloat(e.target.value);
                    if (value >= 0.5 && value <= 1.0) {
                      handleDHashSimilarityChange(e);
                    }
                  }}
                  disabled={getThresholdState('dhash') === 'inactive'}
                  className="w-16 px-2 py-1 text-xs border border-gray-300 rounded focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
                />
                <span className={`text-sm font-semibold ${getThresholdState('dhash') === 'active' ? 'text-blue-700' : 'text-gray-500'}`}>
                  {(thresholds.dhashImageSimilarity * 100).toFixed(0)}%
                </span>
              </div>
            </div>
            {!useTextInputs && (
              <>
                <input
                  type="range"
                  id="dhash-similarity"
                  min="0.5"
                  max="1.0"
                  step="0.01"
                  value={thresholds.dhashImageSimilarity}
                  onChange={handleDHashSimilarityChange}
                  disabled={getThresholdState('dhash') === 'inactive'}
                  className={`w-full h-2 rounded-lg appearance-none cursor-pointer ${
                    getThresholdState('dhash') === 'active' ? 'bg-blue-200' : 'bg-gray-300 cursor-not-allowed'
                  }`}
                />
                <p className="text-xs text-gray-600 mt-1">
                  Handles lighting changes and video compression. Lower values catch more camera movement
                </p>
              </>
            )}
          </div>

          {/* Pixel Similarity */}
          <div className={getThresholdState('pixel') === 'inactive' ? 'opacity-50' : ''}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <label htmlFor="pixel-similarity" className="text-sm font-medium text-gray-900">
                  🖥️ UI Changes
                </label>
                {getThresholdState('pixel') === 'active' && (
                  <span className="text-xs text-blue-600 font-medium">← ACTIVE</span>
                )}
                {getThresholdState('pixel') === 'inactive' && (
                  <span className="text-xs text-gray-500 font-medium">⚫ {getInactiveMessage('pixel')}</span>
                )}
              </div>
              <div className="flex items-center space-x-2">
                <input
                  type="number"
                  min="0.5"
                  max="1.0"
                  step="0.01"
                  value={thresholds.pixelImageSimilarity.toFixed(2)}
                  onChange={(e) => {
                    const value = parseFloat(e.target.value);
                    if (value >= 0.5 && value <= 1.0) {
                      handlePixelSimilarityChange(e);
                    }
                  }}
                  disabled={getThresholdState('pixel') === 'inactive'}
                  className="w-16 px-2 py-1 text-xs border border-gray-300 rounded focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
                />
                <span className={`text-sm font-semibold ${getThresholdState('pixel') === 'active' ? 'text-blue-700' : 'text-gray-500'}`}>
                  {(thresholds.pixelImageSimilarity * 100).toFixed(0)}%
                </span>
              </div>
            </div>
            {!useTextInputs && (
              <>
                <input
                  type="range"
                  id="pixel-similarity"
                  min="0.5"
                  max="1.0"
                  step="0.01"
                  value={thresholds.pixelImageSimilarity}
                  onChange={handlePixelSimilarityChange}
                  disabled={getThresholdState('pixel') === 'inactive'}
                  className={`w-full h-2 rounded-lg appearance-none cursor-pointer ${
                    getThresholdState('pixel') === 'active' ? 'bg-blue-200' : 'bg-gray-300 cursor-not-allowed'
                  }`}
                />
                <p className="text-xs text-gray-600 mt-1">
                  Detects pixel-perfect changes. Lower values catch smaller UI updates
                </p>
              </>
            )}
          </div>

          {/* Suspicious Similarity (Hybrid only) */}
          {isThresholdRelevant('suspicious') && (
            <div className={getThresholdState('suspicious') === 'inactive' ? 'opacity-50' : ''}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <label htmlFor="suspicious-similarity" className="text-sm font-medium text-gray-900">
                    ⚡ Pixel Check Trigger
                  </label>
                  {getThresholdState('suspicious') === 'active' && (
                    <span className="text-xs text-blue-600 font-medium">← ACTIVE</span>
                  )}
                  {getThresholdState('suspicious') === 'inactive' && (
                    <span className="text-xs text-gray-500 font-medium">⚫ {getInactiveMessage('suspicious')}</span>
                  )}
                </div>
                <div className="flex items-center space-x-2">
                  <input
                    type="number"
                    min="0.95"
                    max="1.0"
                    step="0.001"
                    value={thresholds.suspiciousSimilarity.toFixed(3)}
                    onChange={(e) => {
                      const value = parseFloat(e.target.value);
                      if (value >= 0.95 && value <= 1.0) {
                        handleSuspiciousSimilarityChange(e);
                      }
                    }}
                    disabled={getThresholdState('suspicious') === 'inactive'}
                    className="w-20 px-2 py-1 text-xs border border-gray-300 rounded focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
                  />
                  <span className={`text-sm font-semibold ${getThresholdState('suspicious') === 'active' ? 'text-blue-700' : 'text-gray-500'}`}>
                    {(thresholds.suspiciousSimilarity * 100).toFixed(2)}%
                  </span>
                </div>
              </div>
              {!useTextInputs && (
                <>
                  <input
                    type="range"
                    id="suspicious-similarity"
                    min="0.95"
                    max="1.0"
                    step="0.001"
                    value={thresholds.suspiciousSimilarity}
                    onChange={handleSuspiciousSimilarityChange}
                    disabled={getThresholdState('suspicious') === 'inactive'}
                    className={`w-full h-2 rounded-lg appearance-none cursor-pointer ${
                      getThresholdState('suspicious') === 'active' ? 'bg-blue-200' : 'bg-gray-300 cursor-not-allowed'
                    }`}
                  />
                  <p className="text-xs text-gray-600 mt-1">
                    When camera similarity is very high, triggers detailed pixel check for subtle UI changes
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ChangeDetectionSettings;
