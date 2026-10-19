// src/components/AICreator/AgentAutocompleteInput.tsx

import React, { useState, useRef, useEffect } from 'react';
import { Users, X } from 'lucide-react';
import { getAllAgentIds } from '@utils/agent_database';
import { detectPartialAgentTyping } from '@utils/agentParser';

interface AgentAutocompleteInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled: boolean;
  className?: string;
  disableAutocomplete?: boolean;
  // Image preview handling - supports multiple images
  onImagePaste?: (base64Data: string) => void;
  previewImages?: string[];
  onRemovePreview?: (index: number) => void;
}

export const AgentAutocompleteInput: React.FC<AgentAutocompleteInputProps> = ({
  value, onChange, placeholder, disabled, className, disableAutocomplete = false,
  onImagePaste, previewImages, onRemovePreview
}) => {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [filteredSuggestions, setFilteredSuggestions] = useState<string[]>([]);
  const [partialTyping, setPartialTyping] = useState<{
    partialMatch: string;
    start: number;
    end: number;
  } | null>(null);

  // Load agent IDs on component mount (only if autocomplete is enabled)
  useEffect(() => {
    if (disableAutocomplete) return;

    const loadAgentIds = async () => {
      try {
        const ids = await getAllAgentIds();
        setAgentIds(ids);
      } catch (error) {
        console.error('Failed to load agent IDs:', error);
      }
    };
    loadAgentIds();
  }, [disableAutocomplete]);

  // Collapse textarea to single line when disabled (better UX during model responses)
  useEffect(() => {
    if (disabled && inputRef.current) {
      inputRef.current.style.height = '48px';
    }
  }, [disabled]);

  // Auto-focus when input becomes enabled again
  useEffect(() => {
    if (!disabled && inputRef.current) {
      inputRef.current.focus();
    }
  }, [disabled]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    const newCursorPos = e.target.selectionStart || 0;

    onChange(newValue);

    // Skip autocomplete logic if disabled
    if (disableAutocomplete) return;

    // Check for partial agent typing
    const partial = detectPartialAgentTyping(newValue, newCursorPos);
    setPartialTyping(partial);

    if (partial) {
      // Filter agent IDs based on partial match
      const filtered = agentIds.filter(id =>
        id.toLowerCase().includes(partial.partialMatch.toLowerCase())
      );
      setFilteredSuggestions(filtered);
      setShowSuggestions(filtered.length > 0);
    } else {
      setShowSuggestions(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Trigger the form submit
      const form = e.currentTarget.closest('form');
      if (form) {
        form.requestSubmit();
      }
    }
  };

  const handleKeyUp = (_: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Remove cursor position tracking as it's not needed
  };

  const handleSuggestionClick = (agentId: string) => {
    if (!partialTyping) return;

    // Replace partial typing with selected agent ID
    const newValue =
      value.substring(0, partialTyping.start) +
      agentId +
      value.substring(partialTyping.end);

    onChange(newValue);
    setShowSuggestions(false);
    setPartialTyping(null);

    // Focus back to input
    inputRef.current?.focus();
  };

  const handleBlur = () => {
    // Delay hiding suggestions to allow clicking
    setTimeout(() => setShowSuggestions(false), 150);
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onImagePaste) return;

    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // Check if item is an image (matches existing upload logic: accept="image/*")
      if (item.type.startsWith('image/')) {
        e.preventDefault(); // Prevent default paste behavior for images

        const file = item.getAsFile();
        if (!file) continue;

        // Convert to base64 (same as MediaUploadMessage.tsx:62-66)
        const reader = new FileReader();
        reader.onload = (event) => {
          const result = event.target?.result as string;
          // Extract base64 data (remove data:image/...;base64, prefix)
          const base64Data = result.split(',')[1];
          onImagePaste(base64Data);
        };
        reader.readAsDataURL(file);

        break; // Only handle first image
      }
    }
  };

  function renderSuggestions() {
    if (disableAutocomplete || !showSuggestions || filteredSuggestions.length === 0) return null;

    return (
      <div className="absolute bottom-full left-0 right-0 mb-1 bg-white border border-gray-300 rounded-md shadow-lg z-50 max-h-40 overflow-y-auto">
        {filteredSuggestions.map((agentId, _) => (
          <button
            key={agentId}
            onClick={() => handleSuggestionClick(agentId)}
            className="w-full text-left px-3 py-2 hover:bg-purple-50 text-sm flex items-center border-b border-gray-100 last:border-b-0"
          >
            <Users className="h-4 w-4 text-purple-500 mr-2" />
            <span className="font-mono">@{agentId}</span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="relative w-full">
      {previewImages && previewImages.length > 0 ? (
        // With images: wrapper gets the styling
        <div className={`flex flex-col ${className}`}>
          {/* Image Previews - Inside the input box */}
          <div className="p-2 pb-0">
            <div className="flex space-x-2 overflow-x-auto pb-2">
              {previewImages.map((image, index) => (
                <div key={index} className="relative flex-shrink-0">
                  <img
                    src={`data:image/png;base64,${image}`}
                    alt={`Pasted preview ${index + 1}`}
                    className="h-20 w-20 object-cover rounded border border-gray-200"
                  />
                  {onRemovePreview && (
                    <button
                      type="button"
                      onClick={() => onRemovePreview(index)}
                      className="absolute top-1 right-1 p-0.5 bg-red-500 text-white rounded-full hover:bg-red-600 shadow-md"
                      title="Remove image"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <textarea
            ref={inputRef}
            value={value}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            onBlur={handleBlur}
            onPaste={handlePaste}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            className="w-full resize-none border-none focus:ring-0 focus:outline-none p-2 md:p-3"
            style={{
              minHeight: '48px',
              overflow: 'hidden'
            }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = 'auto';
              target.style.height = Math.max(target.scrollHeight, 48) + 'px';
            }}
          />
        </div>
      ) : (
        // Without images: textarea gets the styling directly (original behavior)
        <textarea
          ref={inputRef}
          value={value}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onBlur={handleBlur}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className={`w-full resize-none placeholder:truncate placeholder:overflow-hidden ${className}`}
          style={{
            minHeight: '48px',
            overflow: 'hidden'
          }}
          onInput={(e) => {
            const target = e.target as HTMLTextAreaElement;
            target.style.height = 'auto';
            target.style.height = Math.max(target.scrollHeight, 48) + 'px';
          }}
        />
      )}

      {!disableAutocomplete && renderSuggestions()}
    </div>
  );
};