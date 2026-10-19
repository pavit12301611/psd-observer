// src/components/InfoTooltip.tsx

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';

interface InfoTooltipProps {
  /** Tooltip copy */
  body: string;
  /** Size of the info icon */
  size?: 'sm' | 'md';
  /** Additional class for positioning */
  className?: string;
  /** When given, the children become the hover/tap trigger instead of the info icon. */
  children?: React.ReactNode;
}

const BUBBLE_WIDTH = 256; // px

/**
 * Lightweight info bubble for short copy. Opens on tap (mobile-safe) and on
 * hover (desktop). Rendered through a portal so it escapes the pricing table's
 * `overflow-x-auto` clip, anchored to the icon via getBoundingClientRect.
 */
export const InfoTooltip: React.FC<InfoTooltipProps> = ({
  body,
  size = 'sm',
  className = '',
  children,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; placeAbove: boolean } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);

  const iconSize = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const open = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    cancelClose();
    const rect = btn.getBoundingClientRect();
    const margin = 8;
    let left = rect.left + rect.width / 2 - BUBBLE_WIDTH / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - BUBBLE_WIDTH - margin));
    const placeAbove = window.innerHeight - rect.bottom < 140;
    const top = placeAbove ? rect.top - margin : rect.bottom + margin;
    setCoords({ top, left, placeAbove });
    setIsOpen(true);
  }, [cancelClose]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setIsOpen(false), 120);
  }, [cancelClose]);

  useEffect(() => {
    if (!isOpen) return;
    const close = () => setIsOpen(false);
    const handleClickOutside = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node) || bubbleRef.current?.contains(e.target as Node)) return;
      close();
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  useEffect(() => () => cancelClose(), [cancelClose]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); open(); }}
        onMouseEnter={open}
        onMouseLeave={scheduleClose}
        className={children
          ? `inline-flex items-center justify-center cursor-help ${className}`
          : `inline-flex items-center justify-center text-gray-400 hover:text-purple-600 transition-colors ${className}`}
        aria-label={children ? undefined : 'More information'}
      >
        {children ?? <Info className={iconSize} />}
      </button>

      {isOpen && coords && createPortal(
        <div
          ref={bubbleRef}
          role="tooltip"
          style={{
            position: 'fixed',
            top: coords.top,
            left: coords.left,
            width: BUBBLE_WIDTH,
            transform: coords.placeAbove ? 'translateY(-100%)' : undefined,
          }}
          className="z-[10001] rounded-lg bg-gray-900 text-white text-xs leading-relaxed px-3 py-2 shadow-xl"
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {body}
        </div>,
        document.body
      )}
    </>
  );
};

export default InfoTooltip;
