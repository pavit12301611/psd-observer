// PersonalInfoWarningModal.tsx
import React from 'react';
import { AlertTriangle, ShieldCheck, X } from 'lucide-react';
import { getDetectedDataTypes, getPlaceholderSuggestion } from '@utils/code_sanitizer';

interface PersonalInfoWarningModalProps {
  isOpen: boolean;
  onClose: () => void;
  detectedFunctions: string[];
  codePreview: string;
  lineNumbers: Record<string, number[]>;
  removedPassphraseCount?: number;
  removedPassphraseLines?: number[];
  onCancel: () => void;
  onEditAgent: () => void;
  onUploadAnyway: () => void;
}

const PersonalInfoWarningModal: React.FC<PersonalInfoWarningModalProps> = ({
  isOpen,
  onClose,
  detectedFunctions,
  codePreview,
  lineNumbers,
  removedPassphraseCount = 0,
  removedPassphraseLines = [],
  onCancel,
  onEditAgent,
  onUploadAnyway
}) => {
  if (!isOpen) return null;

  const hasFunctionWarnings = detectedFunctions.length > 0;
  const hasRemovedPassphrases = removedPassphraseCount > 0;
  const dataTypes = getDetectedDataTypes(detectedFunctions);

  // Create a map of line number to function names for that line
  const lineToFunctions: Record<number, string[]> = {};
  Object.entries(lineNumbers).forEach(([funcName, lines]) => {
    lines.forEach(lineNum => {
      if (!lineToFunctions[lineNum]) {
        lineToFunctions[lineNum] = [];
      }
      lineToFunctions[lineNum].push(funcName);
    });
  });
  const removedPassphraseLineSet = new Set(removedPassphraseLines);

  // Highlight lines in code preview with inline placeholder suggestions
  const getHighlightedCode = () => {
    const lines = codePreview.split('\n');

    return lines.map((line, index) => {
      const lineNum = index + 1;
      const functionsOnLine = lineToFunctions[lineNum] || [];
      const isPassphraseLine = removedPassphraseLineSet.has(lineNum);
      const isHighlighted = functionsOnLine.length > 0 || isPassphraseLine;

      return (
        <div
          key={index}
          className={`${
            isPassphraseLine
              ? 'bg-emerald-50 border-l-4 border-emerald-400'
              : functionsOnLine.length > 0
                ? 'bg-amber-50 border-l-4 border-amber-400'
                : ''
          } px-3 py-1 flex items-center justify-between gap-3`}
        >
          <div className="flex items-center min-w-0">
            <span className="text-gray-400 select-none mr-4 inline-block w-8 text-right flex-shrink-0">
              {lineNum}
            </span>
            <span className="font-mono text-sm truncate">{line}</span>
          </div>
          {isHighlighted && (
            <div className="flex items-center gap-2 flex-shrink-0">
              {isPassphraseLine && (
                <span className="text-xs px-2 py-1 bg-emerald-100 text-emerald-800 rounded-full border border-emerald-200 whitespace-nowrap">
                  Passphrase removed
                </span>
              )}
              {functionsOnLine.map((funcName, idx) => (
                <span
                  key={idx}
                  className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded-full border border-blue-200 whitespace-nowrap"
                >
                  Suggested: {getPlaceholderSuggestion(funcName)}
                </span>
              ))}
            </div>
          )}
        </div>
      );
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-[80] p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-xl w-full sm:w-11/12 sm:max-w-3xl max-h-[92dvh] sm:max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-5 sm:px-6 py-4 border-b border-gray-100">
          <div className="flex items-start gap-3 min-w-0">
            <div className={`p-2 rounded-full flex-shrink-0 ${hasFunctionWarnings ? 'bg-amber-50' : 'bg-emerald-50'}`}>
              {hasFunctionWarnings
                ? <AlertTriangle className="h-5 w-5 text-amber-600" />
                : <ShieldCheck className="h-5 w-5 text-emerald-600" />
              }
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-gray-900">
                {hasFunctionWarnings ? 'Review before uploading' : 'Passphrase removed for your safety'}
              </h2>
              <p className="text-sm text-gray-500 mt-0.5">
                {hasFunctionWarnings
                  ? 'We found things worth double-checking before this goes public.'
                  : 'Nothing else to review — your agent is ready to upload.'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400 flex-shrink-0"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 p-5 sm:p-6 overflow-y-auto space-y-4">
          {hasRemovedPassphrases && (
            <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl">
              <div className="flex items-start gap-2.5">
                <ShieldCheck className="h-5 w-5 text-emerald-600 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-emerald-900">
                  We automatically deleted{' '}
                  <span className="font-semibold">
                    {removedPassphraseCount} whitelist passphrase{removedPassphraseCount > 1 ? 's' : ''}
                  </span>{' '}
                  from your code (line{removedPassphraseLines.length > 1 ? 's' : ''}{' '}
                  {removedPassphraseLines.join(', ')}). These codes let anyone bind a phone number to
                  your account, so they're never uploaded to the community — no action needed.
                </p>
              </div>
            </div>
          )}

          {hasFunctionWarnings && (
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl">
              <p className="text-sm text-amber-900">
                Your agent calls notification functions that may include personal information such as{' '}
                <span className="font-semibold">{dataTypes.join(', ')}</span>. Please replace any real
                values with placeholders before uploading.
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                {detectedFunctions.map((func) => (
                  <span
                    key={func}
                    className="px-2.5 py-1 bg-white text-blue-700 rounded-full font-mono text-xs border border-blue-200"
                  >
                    {func}() <span className="text-gray-400 font-sans">line {lineNumbers[func]?.join(', ')}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Code Preview */}
          <div>
            <h3 className="font-medium text-gray-900 mb-2 text-sm">Code preview</h3>
            <div className="bg-gray-50 border border-gray-200 rounded-xl overflow-auto max-h-80">
              <div className="p-2">
                {getHighlightedCode()}
              </div>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="p-4 sm:p-5 border-t border-gray-100 flex flex-col-reverse sm:flex-row justify-end gap-3">
          <button
            onClick={onCancel}
            className="w-full sm:w-auto px-5 py-2.5 border border-gray-200 rounded-full hover:bg-gray-50 text-gray-700 text-sm font-medium transition-colors"
          >
            Cancel Upload
          </button>
          {hasFunctionWarnings && (
            <button
              onClick={onEditAgent}
              className="w-full sm:w-auto px-5 py-2.5 rounded-full bg-blue-600 text-white hover:bg-blue-700 text-sm font-medium transition-colors"
            >
              Edit Agent
            </button>
          )}
          <button
            onClick={onUploadAnyway}
            className="w-full sm:w-auto px-5 py-2.5 rounded-full bg-gray-900 text-white hover:bg-black text-sm font-medium transition-colors"
          >
            {hasFunctionWarnings ? "I've Removed Personal Info - Upload Anyway" : 'Continue Upload'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PersonalInfoWarningModal;
