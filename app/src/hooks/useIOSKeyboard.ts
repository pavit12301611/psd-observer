// hooks/useIOSKeyboard.ts
// Handles iOS keyboard by detecting viewport changes and updating CSS variables

import { useEffect, useRef } from 'react';
import { isMobile } from '@utils/platform';

const PADDING = 16; // px above keyboard to keep input visible

export function useIOSKeyboard() {
  const keyboardHeightRef = useRef(0);

  useEffect(() => {
    let mobile = false;
    try { mobile = isMobile(); } catch { return; }
    if (!mobile) return;

    const root = document.documentElement;

    const computeOffset = () => {
      const kbHeight = keyboardHeightRef.current;
      if (kbHeight === 0) {
        root.style.setProperty('--keyboard-offset', '0px');
        return;
      }
      const focused = document.activeElement as HTMLElement;
      if (!focused || (focused.tagName !== 'INPUT' && focused.tagName !== 'TEXTAREA' && focused.getAttribute('contenteditable') !== 'true')) {
        root.style.setProperty('--keyboard-offset', '0px');
        return;
      }
      // getBoundingClientRect reflects the already-applied transform, so we add
      // back the current offset to get the natural (pre-transform) position.
      const currentOffset = parseFloat(root.style.getPropertyValue('--keyboard-offset') || '0') || 0;
      const visibleBottom = window.innerHeight - kbHeight;
      const naturalInputBottom = focused.getBoundingClientRect().bottom + currentOffset + PADDING;
      const offset = Math.min(Math.max(0, naturalInputBottom - visibleBottom), kbHeight);
      root.style.setProperty('--keyboard-offset', `${offset}px`);
    };

    const handleSafeAreaChanged = (e: CustomEvent) => {
      const detail = e.detail || {};
      const keyboardHeight = detail.keyboardHeight ?? 0;
      const keyboardVisible = detail.keyboardVisible ?? false;

      keyboardHeightRef.current = keyboardVisible ? keyboardHeight : 0;

      // Wait for keyboard animation to settle before measuring
      setTimeout(computeOffset, 150);
    };

    const handleFocusIn = () => {
      if (keyboardHeightRef.current > 0) {
        setTimeout(computeOffset, 50);
      }
    };

    window.addEventListener('safeAreaChanged', handleSafeAreaChanged as EventListener);
    window.addEventListener('focusin', handleFocusIn);

    return () => {
      window.removeEventListener('safeAreaChanged', handleSafeAreaChanged as EventListener);
      window.removeEventListener('focusin', handleFocusIn);
    };
  }, []);
}
