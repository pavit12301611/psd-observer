// src/components/AICreator/MCPPanel.tsx
//
// Docked "MCP" panel — the non-hero posture of the MCP assistant. Replaces the old
// MCPModal: instead of a centered blocking modal, this is a non-blocking overlay that
// slides in from the right edge (desktop) or up from the bottom (mobile), tucking in
// just above the footer so the launcher pill there stays the single open/close control.
//
// The conversation itself lives in MCPProvider (app root), so this is a thin render
// slot — the same shared brain as the GetStarted hero <MCP>, just a different posture.

import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Sparkles } from 'lucide-react';
import MCP from './MCP';
import type { TokenProvider } from '@utils/main_loop';

interface MCPPanelProps {
  isOpen: boolean;
  onClose: () => void;
  getToken: TokenProvider;
  isAuthenticated: boolean;
  isUsingObServer: boolean;
  onSignIn?: () => void;
  onSwitchToObServer?: () => void;
  onUpgrade?: () => void;
  onRefresh?: () => void;
  initialMessage?: string;
}

const MCPPanel: React.FC<MCPPanelProps> = ({
  isOpen,
  onClose,
  getToken,
  isAuthenticated,
  isUsingObServer,
  onSignIn,
  onSwitchToObServer,
  onUpgrade,
  onRefresh,
  initialMessage,
}) => {

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  return createPortal(
    <div
      // Non-blocking: only the panel itself captures clicks, the grid stays usable.
      // Mobile: bottom sheet above the footer pill bar. Desktop: right rail above the
      // floating footer bubble. z below the global modals (z-[9999]) and the footer.
      className={`fixed z-40 pointer-events-none transition-transform duration-300 ease-out
        left-0 right-0 bottom-20 px-2
        md:left-auto md:right-0 md:top-20 md:bottom-24 md:w-[420px] md:px-0 md:pr-4
        ${isOpen
          ? 'translate-y-0 md:translate-x-0'
          : 'translate-y-[130%] md:translate-y-0 md:translate-x-[110%]'}`}
      aria-hidden={!isOpen}
    >
      <div className="pointer-events-auto flex flex-col h-[60vh] md:h-full bg-white rounded-2xl md:rounded-2xl shadow-2xl border border-gray-200 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 shrink-0">
          <div className="flex items-center gap-2">
            <div className="bg-purple-50 flex justify-center items-center rounded-lg w-8 h-8">
              <Sparkles className="text-purple-600 w-4 h-4" strokeWidth={2} />
            </div>
            <h2 className="text-base font-semibold text-gray-900">Observer</h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={onClose}
              className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-md"
              title="Close Observer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* MCP content — fills remaining height */}
        <div className="flex-1 min-h-0 p-3">
          <MCP
            getToken={getToken}
            isAuthenticated={isAuthenticated}
            isUsingObServer={isUsingObServer}
            onSignIn={onSignIn}
            onSwitchToObServer={onSwitchToObServer}
            onUpgrade={onUpgrade}
            onRefresh={onRefresh}
            initialMessage={initialMessage}
            heightClass="h-full"
          />
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default MCPPanel;
