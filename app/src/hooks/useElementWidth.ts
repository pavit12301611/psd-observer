// hooks/useElementWidth.ts
//
// Measures an element's own rendered width via ResizeObserver. Used by
// AgentCard's internal views (StaticAgentView, ActiveAgentView) so their
// layout responds to the card's actual pixel width instead of Tailwind's
// viewport-based `md:` breakpoints — cards live in a resizable tiling grid
// now, so "desktop viewport" says nothing about how wide a given card is.
//
// Deliberately plain ResizeObserver rather than CSS container queries: this
// app also ships as a Tauri desktop app, where the OS webview (WebView2,
// WebKitGTK, older WKWebView) can lag behind Chrome on newer CSS features.
// ResizeObserver has been broadly supported for years across all of them.

import { useEffect, useRef, useState } from 'react';

export function useElementWidth<T extends HTMLElement>(initialWidth = 0) {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(initialWidth);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    setWidth(el.getBoundingClientRect().width);

    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);

    return () => observer.disconnect();
  }, []);

  return { ref, width };
}
