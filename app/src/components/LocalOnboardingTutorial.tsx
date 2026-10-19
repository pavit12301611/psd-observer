import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X as CloseIcon, Server, Download, Code, ArrowRight } from 'lucide-react';
import { isTauri } from '@utils/platform';

interface LocalOnboardingTutorialProps {
  isActive: boolean;
  onDismiss: () => void;
}

type Step = {
  id: string;
  targetSelector: string | string[];
  title: string;
  message: string;
  icon: React.ReactNode;
  action: 'click' | 'next' | 'event';
  waitForEvent?: string;
};

function firstVisible(selector: string | string[]): Element | null {
  const list = Array.isArray(selector) ? selector : [selector];
  for (const sel of list) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

const STEPS: Step[] = [
  {
    id: 'open-models',
    targetSelector: 'button[data-tutorial-models]',
    title: 'Open Models',
    message: 'Click here to see the Models tab — this is where you download AI models to run locally.',
    icon: <Server className="h-5 w-5 text-blue-500" />,
    action: 'click',
  },
  {
    id: 'download-gemma',
    targetSelector: 'button[data-tutorial-gemma-e2b]',
    title: 'Get a model',
    message: '', // resolved dynamically below
    icon: <Download className="h-5 w-5 text-blue-500" />,
    action: 'click',
  },
  {
    id: 'build-custom',
    targetSelector: ['[data-tutorial-build-custom]', '[data-tutorial-grid-create]'],
    title: "Let's create an agent manually!",
    message: 'Click Create Agent to start building your first agent with full control over its behavior.',
    icon: <Code className="h-5 w-5 text-purple-500" />,
    action: 'click',
  },
];

const LocalOnboardingTutorial: React.FC<LocalOnboardingTutorialProps> = ({ isActive, onDismiss }) => {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [dismissedSteps, setDismissedSteps] = useState<Set<string>>(new Set());

  const current = STEPS[step] ?? null;
  const isCurrentDismissed = current ? dismissedSteps.has(current.id) : false;

  useEffect(() => {
    if (!isActive) { setStep(0); setDismissedSteps(new Set()); return; }
  }, [isActive]);

  useEffect(() => {
    if (!current?.targetSelector) { setRect(null); return; }
    let rafId: number;
    const loop = () => {
      const el = firstVisible(current.targetSelector);
      if (el) setRect(el.getBoundingClientRect());
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [current?.targetSelector]);

  useEffect(() => {
    if (!isActive || current?.action !== 'click' || !current.targetSelector) return;

    const handleClick = (e: Event) => {
      const target = e.target as HTMLElement;
      const highlighted = firstVisible(current.targetSelector);
      if (highlighted && (highlighted === target || highlighted.contains(target))) {
        if (step < STEPS.length - 1) {
          setStep(s => s + 1);
        } else {
          onDismiss();
        }
      }
    };

    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, [isActive, step, current]);

  useEffect(() => {
    if (!isActive || current?.action !== 'event' || !current.waitForEvent) return;

    const advance = () => {
      if (step < STEPS.length - 1) {
        setStep(s => s + 1);
      } else {
        onDismiss();
      }
    };

    window.addEventListener(current.waitForEvent, advance);
    return () => window.removeEventListener(current.waitForEvent!, advance);
  }, [isActive, step, current]);

  useEffect(() => {
    if (!isActive || current?.id !== 'download-gemma') return;
    const id = setInterval(() => {
      const state = document.querySelector('[data-tutorial-gemma-state]')?.getAttribute('data-tutorial-gemma-state');
      if (state === 'loaded' || state === 'installed') {
        if (step < STEPS.length - 1) setStep(s => s + 1);
        else onDismiss();
      }
    }, 500);
    return () => clearInterval(id);
  }, [isActive, step, current, onDismiss]);

  if (!isActive || !current || isCurrentDismissed) return null;

  const handleDismissStep = () => {
    setDismissedSteps(prev => {
      const next = new Set(prev);
      next.add(current.id);
      return next;
    });
  };

  const resolvedMessage = current.id === 'download-gemma'
    ? (() => {
        const gemmaState = document.querySelector('[data-tutorial-gemma-state]')?.getAttribute('data-tutorial-gemma-state');
        if (isTauri()) {
          switch (gemmaState) {
            case 'downloading': return 'Gemma 4 E2B is downloading — hang tight!';
            case 'installed': return 'Gemma 4 E2B is installed and ready!';
            default: return 'Click Download next to Gemma 4 E2B — it runs natively via llama.cpp for better stability and performance.';
          }
        }
        switch (gemmaState) {
          case 'downloading': return 'Gemma 4 E2B ONNX is downloading — this may take a moment.';
          case 'load': return 'Gemma 4 E2B ONNX is downloaded! Click Load to activate it in your browser.';
          case 'loading': return 'Gemma 4 E2B ONNX is loading — almost ready!';
          case 'loaded': return 'Gemma 4 E2B ONNX is loaded and ready!';
          case 'error': return 'Something went wrong. Try downloading Gemma 4 E2B ONNX again.';
          default: return 'Click Download next to Gemma 4 E2B ONNX — it runs directly in your browser, no install needed.';
        }
      })()
    : current.message;

  const pad = 8;

  const getBubbleStyle = (): React.CSSProperties => {
    if (!rect) return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
    const W = 288, H = 240, vw = window.innerWidth, vh = window.innerHeight;
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
      {/* Spotlight overlay */}
      {rect && (
        <>
          <div className="fixed z-[200] pointer-events-none" style={{ top: 0, left: 0, right: 0, height: Math.max(0, rect.top - pad), background: 'rgba(0,0,0,0.45)' }} />
          <div className="fixed z-[200] pointer-events-none" style={{ top: rect.bottom + pad, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.45)' }} />
          <div className="fixed z-[200] pointer-events-none" style={{ top: rect.top - pad, width: Math.max(0, rect.left - pad), height: rect.height + pad * 2, background: 'rgba(0,0,0,0.45)' }} />
          <div className="fixed z-[200] pointer-events-none" style={{ top: rect.top - pad, left: rect.right + pad, right: 0, height: rect.height + pad * 2, background: 'rgba(0,0,0,0.45)' }} />
        </>
      )}

      {/* Bubble */}
      <div
        className="fixed z-[201] bg-white rounded-xl shadow-2xl p-4 pointer-events-auto"
        style={{ width: 288, maxWidth: 'calc(100vw - 32px)', ...getBubbleStyle() }}
      >
        <button onClick={handleDismissStep} className="absolute top-2 right-2 text-gray-400 hover:text-gray-600 transition-colors">
          <CloseIcon className="h-4 w-4" />
        </button>

        <p className="text-[10px] font-bold text-blue-600 uppercase tracking-wider mb-1">Getting Started</p>
        <div className="flex items-center gap-2 mb-1.5 pr-5">
          {current.icon}
          <h3 className="font-bold text-gray-900 text-sm">{current.title}</h3>
        </div>
        <p className="text-xs text-gray-600 leading-relaxed mb-3">{resolvedMessage}</p>

        {/* Progress dots */}
        <div className="flex gap-1 mb-3">
          {STEPS.map((_, i) => (
            <div key={i} className={`h-1 flex-1 rounded-full transition-colors ${i < step ? 'bg-blue-500' : i === step ? 'bg-blue-400' : 'bg-gray-200'}`} />
          ))}
        </div>

        <div className="flex items-center justify-between">
          <button onClick={onDismiss} className="text-xs text-gray-400 hover:text-gray-600 transition-colors">Skip</button>
          {current.action === 'next' && (
            <button
              onClick={() => step < STEPS.length - 1 ? setStep(s => s + 1) : onDismiss()}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-700 transition-colors"
            >
              Next <ArrowRight className="h-3 w-3" />
            </button>
          )}
          {(current.action === 'click' || current.action === 'event') && (
            <span className="text-xs text-gray-400 italic">
              {current.action === 'event' ? 'close modal to advance' : 'click to advance'}
            </span>
          )}
        </div>
      </div>
    </>,
    document.body
  );
};

export default LocalOnboardingTutorial;
