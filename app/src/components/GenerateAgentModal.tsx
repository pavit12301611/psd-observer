// GenerateAgentModal.tsx
import React, { useState, useEffect, useRef } from 'react';
import { X, Sparkles, Terminal, Code, Cpu, Clipboard, ChevronDown, CheckCircle, Loader2 } from 'lucide-react';
import GenerateAgent from './GenerateAgent';
import { listModels, Model } from '@utils/inferenceServer'; // For model fetching
// Removed getOllamaServerAddress import - no longer needed
import getSystemPrompt from '@utils/system_prompt'; // For copying browser prompt
import getPythonSystemPrompt from '@utils/python_system_prompt'; // For copying python prompt
import type { TokenProvider } from '@utils/main_loop';

interface GenerateAgentModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialAgentType?: 'browser' | 'python';
  getToken: TokenProvider;
}

const DEFAULT_MODEL = 'gemini-2.5-flash-preview-04-17';

const GenerateAgentModal: React.FC<GenerateAgentModalProps> = ({
  isOpen,
  onClose,
  initialAgentType = 'browser',
  getToken,
}) => {
  const [agentType, setAgentType] = useState<'browser' | 'python'>(initialAgentType);

  // --- State for Model Dropdown ---
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  const [availableModels, setAvailableModels] = useState<Model[]>([]);
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState<boolean>(false);
  const [loadingModels, setLoadingModels] = useState<boolean>(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; left: number } | null>(null);

  // Calculate dropdown position when it's opened
  useEffect(() => {
    if (isModelDropdownOpen && modelDropdownRef.current) {
      const rect = modelDropdownRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      const dropdownHeight = 400; // max-h-[400px]

      // If there's not enough space below and more space above, show above
      const showAbove = spaceBelow < dropdownHeight && spaceAbove > spaceBelow;

      setDropdownPosition({
        top: showAbove ? rect.top - dropdownHeight - 4 : rect.bottom + 4, // 4px spacing
        left: rect.left,
      });
    }
  }, [isModelDropdownOpen]);

  // --- State for Clipboard ---
  const [copyStatusMessage, setCopyStatusMessage] = useState<string>('');

  // Fetch models when modal opens or agentType (if models depend on it - not currently) changes
  useEffect(() => {
    if (isOpen) {
      const fetchModels = async () => {
        setLoadingModels(true);
        setModelsError(null);
        try {
          const result = listModels();
          if (result.error) {
            throw new Error(result.error);
          }
          setAvailableModels(result.models);
          // If default model is in list, keep it, else pick first or keep default
          if (!result.models.find(m => m.name === DEFAULT_MODEL) && result.models.length > 0) {
            setSelectedModel(result.models[0].name);
          } else if (result.models.length === 0 && DEFAULT_MODEL) {
            // No models fetched, but we have a hardcoded default
            setSelectedModel(DEFAULT_MODEL);
          } else if (result.models.length === 0 && !DEFAULT_MODEL) {
            setModelsError("No models available and no default set.");
            setSelectedModel(''); // No model can be selected
          }
        } catch (e) {
          const errorMsg = e instanceof Error ? e.message : String(e);
          console.error('Failed to fetch models:', errorMsg);
          setModelsError(`Failed to load models: ${errorMsg}. Using default: ${DEFAULT_MODEL}.`);
          setAvailableModels([]); // Clear available models on error
          setSelectedModel(DEFAULT_MODEL); // Fallback to default on error
        } finally {
          setLoadingModels(false);
        }
      };
      fetchModels();
    }
  }, [isOpen]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) {
        setIsModelDropdownOpen(false);
      }
    };
    if (isModelDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isModelDropdownOpen]);


  const handleCopySystemPrompt = async () => {
    const promptToCopy = agentType === 'browser' ? getSystemPrompt() : getPythonSystemPrompt();
    try {
      await navigator.clipboard.writeText(promptToCopy);
      setCopyStatusMessage('Copied!');
      setTimeout(() => setCopyStatusMessage(''), 2000); // Clear message after 2 seconds
    } catch (err) {
      console.error('Failed to copy system prompt:', err);
      setCopyStatusMessage('Failed to copy');
      setTimeout(() => setCopyStatusMessage(''), 2000);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Modal Header */}
        <div className="bg-blue-600 text-white p-3 px-4 flex items-center justify-between">
          <div className="flex items-center">
            <Sparkles className="h-5 w-5 mr-2 text-white" />
            <h3 className="font-semibold text-lg">AI Agent Generator</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-full text-white hover:bg-blue-500 transition-colors"
            aria-label="Close modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Agent Type Toggle & Controls Section */}
        <div className="bg-white p-3 px-4 flex flex-col space-y-3 border-b border-gray-200">
          {/* Agent Type Toggle - Centered */}
          <div className="flex justify-center">
            <div className="bg-gray-100 rounded-lg p-0.5 flex items-center space-x-0.5 shadow-sm">
              <button
                onClick={() => setAgentType('browser')}
                className={`px-5 py-1.5 rounded-md flex items-center transition-all duration-150 ease-in-out text-xs font-medium ${
                  agentType === 'browser'
                    ? 'bg-blue-600 text-white shadow'
                    : 'text-blue-700 hover:bg-blue-100 hover:text-blue-800'
                }`}
              >
                <Code className="h-4 w-4 mr-1.5" />
                Browser
              </button>
              <button
                onClick={() => setAgentType('python')}
                className={`px-5 py-1.5 rounded-md flex items-center transition-all duration-150 ease-in-out text-xs font-medium ${
                  agentType === 'python'
                    ? 'bg-blue-600 text-white shadow'
                    : 'text-blue-700 hover:bg-blue-100 hover:text-blue-800'
                }`}
              >
                <Terminal className="h-4 w-4 mr-1.5" />
                System
              </button>
            </div>
          </div>

          {/* Model Selection and System Prompt Buttons */}
          <div className="flex flex-col space-y-2">
            {/* Model Selection Button */}
            <div className="relative" ref={modelDropdownRef}>
              <button
                onClick={() => setIsModelDropdownOpen(!isModelDropdownOpen)}
                className="w-full text-gray-700 hover:text-blue-600 transition-colors px-3 py-1.5 rounded hover:bg-gray-100 flex items-center justify-between text-sm"
                aria-label="Select model"
                title={`Current model: ${selectedModel || 'Not selected'}`}
              >
                <div className="flex items-center">
                  <Cpu className="h-4 w-4 mr-2" />
                  <span>Generate with: <span className="font-medium">{selectedModel || 'Select model'}</span></span>
                </div>
                <ChevronDown size={16} className={`transition-transform ${isModelDropdownOpen ? 'rotate-180' : ''}`} />
              </button>
              {isModelDropdownOpen && dropdownPosition && (
                <div 
                  className="fixed w-[calc(100%-2rem)] md:w-auto md:min-w-[320px] bg-white border border-gray-300 rounded-md shadow-xl z-[100] max-h-[400px] overflow-y-auto py-1"
                  style={{
                    top: dropdownPosition.top,
                    left: dropdownPosition.left,
                    width: modelDropdownRef.current?.offsetWidth,
                  }}
                >
                  {loadingModels && (
                    <div className="px-3 py-2 text-sm text-gray-500">Loading models...</div>
                  )}
                  {modelsError && !loadingModels && (
                    <div className="px-3 py-2 text-sm text-red-600 whitespace-normal">{modelsError}</div>
                  )}
                  {!loadingModels && availableModels.length === 0 && !modelsError && (
                    <div className="px-3 py-2 text-sm text-gray-500">No models found.</div>
                  )}
                  {!loadingModels && availableModels.map((model) => (
                    <button
                      key={model.name}
                      onClick={() => {
                        setSelectedModel(model.name);
                        setIsModelDropdownOpen(false);
                      }}
                      className={`w-full text-left px-3 py-1.5 text-sm flex items-center justify-between ${
                        selectedModel === model.name
                          ? 'bg-blue-500 text-white'
                          : 'text-gray-700 hover:bg-gray-100'
                      }`}
                    >
                      <span className="truncate">{model.name}</span>
                      {selectedModel === model.name && <CheckCircle size={14} className="text-white ml-2"/>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* System Prompt Copy Button */}
            <div className="relative">
              <button
                onClick={handleCopySystemPrompt}
                className="w-full text-gray-700 hover:text-blue-600 transition-colors px-3 py-1.5 rounded hover:bg-gray-100 flex items-center text-sm"
                aria-label="Copy system prompt"
                title="Copy system prompt"
              >
                <Clipboard className="h-4 w-4 mr-2" />
                <span>Copy system prompt</span>
              </button>
              {copyStatusMessage && (
                <span className="absolute right-0 top-1/2 transform -translate-y-1/2 mr-3 px-2 py-0.5 bg-gray-700 text-white text-xs rounded shadow-lg whitespace-nowrap">
                  {copyStatusMessage}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Display selected model or loading/error status clearly */}
        {(loadingModels || modelsError) && (
          <div className="px-4 py-1.5 text-center text-xs border-b border-gray-200">
            {loadingModels ? (
              <span className="text-gray-500 flex items-center justify-center">
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                Loading models...
              </span>
            ) : (
              <span className="text-red-500">{modelsError && (modelsError.length > 70 ? "Error loading models." : modelsError)}</span>
            )}
          </div>
        )}


        {/* Modal Content */}
        <div className="p-5 flex-1 overflow-y-auto bg-gray-50">
          <GenerateAgent agentType={agentType} modelName={selectedModel} getToken={getToken}/>
        </div>
      </div>
    </div>
  );
};

export default GenerateAgentModal;
