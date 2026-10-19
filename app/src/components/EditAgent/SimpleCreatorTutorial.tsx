import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, ArrowRight } from 'lucide-react';

export interface TutorialStepConfig {
  selector: string;
  title: string;
  message: string;
}

interface Props {
  tutorialStep: number; // 1-indexed, 0 = inactive
  steps: TutorialStepConfig[];
  onNext: () => void;
  onDismiss: () => void;
}

const SimpleCreatorTutorial: React.FC<Props> = ({ tutorialStep, steps, onNext, onDismiss }) => {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [snoozed, setSnoozed] = useState(false);
  const snoozeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cfg = steps[tutorialStep - 1] ?? null;

  useEffect(() => {
    setSnoozed(false);
    if (snoozeTimer.current) clearTimeout(snoozeTimer.current);
  }, [tutorialStep]);

  useEffect(() => {
    if (!cfg?.selector) { setRect(null); return; }
    let scrolled = false;
    let rafId: number;
    const loop = () => {
      const el = document.querySelector(cfg.selector);
      if (el) {
        setRect(el.getBoundingClientRect());
        if (!scrolled) {
          const r = el.getBoundingClientRect();
          // Only scroll when the element's panel is actually visible horizontally
          if (r.left < window.innerWidth && r.right > 0) {
            const panel = el.closest('.overflow-y-auto') as HTMLElement | null;
            if (panel) {
              const elTop = r.top - panel.getBoundingClientRect().top + panel.scrollTop;
              panel.scrollTo({ top: elTop - panel.clientHeight / 2 + (el as HTMLElement).offsetHeight / 2, behavior: 'smooth' });
            }
            scrolled = true;
          }
        }
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [cfg?.selector]);

  if (!cfg || tutorialStep === 0 || snoozed) return null;

  const handleSnooze = () => {
    snoozeTimer.current = setTimeout(() => setSnoozed(false), 30_000);
    setSnoozed(true);
  };

  const isLast = tutorialStep === steps.length;
  const pad = 8;

  const getBubbleStyle = (): React.CSSProperties => {
    if (!rect) return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
    const W = 272, H = 220, vw = window.innerWidth, vh = window.innerHeight;
    const clampTop = (t: number) => Math.max(pad, Math.min(t, vh - H - pad));
    const left = Math.max(pad, Math.min(rect.left, vw - W - pad));
    if (rect.right + W + pad * 3 < vw) return { left: rect.right + pad * 2, top: clampTop(rect.top) };
    if (rect.left - W - pad > 0) return { left: rect.left - W - pad, top: clampTop(rect.top) };
    // Below: flip above if off-screen
    const belowTop = rect.bottom + pad * 2;
    if (belowTop + H <= vh - pad) return { top: belowTop, left };
    return { top: Math.max(pad, rect.top - H - pad * 2), left };
  };

  return createPortal(
    <>
      {rect && (
        <>
          <div className="fixed z-[200] pointer-events-none" style={{ top: 0, left: 0, right: 0, height: Math.max(0, rect.top - pad), background: 'rgba(0,0,0,0.45)' }} />
          <div className="fixed z-[200] pointer-events-none" style={{ top: rect.bottom + pad, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.45)' }} />
          <div className="fixed z-[200] pointer-events-none" style={{ top: rect.top - pad, width: Math.max(0, rect.left - pad), height: rect.height + pad * 2, background: 'rgba(0,0,0,0.45)' }} />
          <div className="fixed z-[200] pointer-events-none" style={{ top: rect.top - pad, left: rect.right + pad, right: 0, height: rect.height + pad * 2, background: 'rgba(0,0,0,0.45)' }} />
        </>
      )}
      <div className="fixed z-[201] bg-white rounded-xl shadow-2xl p-4 pointer-events-auto" style={{ width: 272, ...getBubbleStyle() }}>
        <button onClick={handleSnooze} className="absolute top-2 right-2 text-gray-400 hover:text-gray-600 transition-colors">
          <X className="h-4 w-4" />
        </button>
        <p className="text-[10px] font-bold text-blue-600 uppercase tracking-wider mb-1">Tutorial</p>
        <h3 className="font-bold text-gray-900 text-sm mb-1.5 pr-5">{cfg.title}</h3>
        <p className="text-xs text-gray-600 leading-relaxed mb-3">{cfg.message}</p>
        <div className="flex gap-1 mb-3">
          {steps.map((_, i) => (
            <div key={i} className={`h-1 flex-1 rounded-full transition-colors ${i < tutorialStep ? 'bg-blue-500' : 'bg-gray-200'}`} />
          ))}
        </div>
        <div className="flex items-center justify-between">
          <button onClick={onDismiss} className="text-xs text-gray-400 hover:text-gray-600 transition-colors">Skip</button>
          <button onClick={onNext} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-700 transition-colors">
            {isLast ? 'Done' : 'Next'}
            {!isLast && <ArrowRight className="h-3 w-3" />}
          </button>
        </div>
      </div>
    </>,
    document.body
  );
};

export default SimpleCreatorTutorial;
