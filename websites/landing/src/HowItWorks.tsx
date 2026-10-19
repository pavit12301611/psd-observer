import { useRef, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import {
  ScanText, Monitor, Mic, Brain, Volume2, Camera, Clipboard,
  BrainCircuit, Cpu, Layers, Eye,
  Bell, Mail, MessageSquare, Terminal, Save, Clapperboard, Tag, Blend,
  Repeat, Users, Image,
} from 'lucide-react';

const featureDescriptions: Record<string, string> = {
  OCR: "Captures screen content as text for the model to read.",
  SCREEN: "Takes a screenshot as an image for multimodal vision models.",
  CAMERA: "Captures a frame from your camera for vision models.",
  CLIPBOARD: "Accesses the current text content of your clipboard.",
  MICROPHONE: "Records audio from your microphone and transcribes it to text.",
  AUDIO: "Captures and transcribes the audio output from your computer.",
  'ALL AUDIO': "Mixes microphone and computer audio for a complete transcription (e.g., for meetings).",
  MEMORY: "Allows the agent to read from its own long-term memory.",
  LLMS: "Leverages powerful local language models for reasoning.",
  VISION: "Enables models to understand and interpret images.",
  LOCAL: "All processing happens on your device, ensuring privacy.",
  MODELS: "Easily switch between different models via any OpenAI-compatible endpoint.",
  MESSAGING: "Send notifications via WhatsApp, SMS, Email, Discord, Telegram, Pushover, and native system notifications.",
  RECORDING: "Start and stop screen recordings. Add timestamped labels for quick reference.",
  INTERACTION: "Enable multi-agent collaboration. Execute JavaScript or Python code.",
  'MEMORY STORAGE': "Store and retrieve text memories and images for contextual awareness.",
};

const HandDrawnArrow = ({ className = "", direction = "down" }: { className?: string; direction?: "down" | "right" }) => {
  if (direction === "right") {
    return (
      <svg className={className} viewBox="0 0 60 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M2 12C8 11 16 13 24 12C32 11 40 13 48 12M48 12C44 8 42 6 40 4M48 12C44 16 42 18 40 20"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg className={className} viewBox="0 0 24 60" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M12 2C11 8 13 16 12 24C11 32 13 40 12 48M12 48C8 44 6 42 4 40M12 48C16 44 18 42 20 40"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

const Tooltip = ({ content, position, onClose }: {
  content: string;
  position: { left: number; top: number; width: number };
  onClose: () => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        const target = e.target as HTMLElement;
        if (!target.closest('[data-chip]')) {
          onClose();
        }
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-50 w-64 p-3 bg-gray-800 text-white rounded-xl shadow-2xl border border-white/10"
      style={{
        left: `${position.left + position.width / 2}px`,
        top: `${position.top - 8}px`,
        transform: 'translateX(-50%) translateY(-100%)',
      }}
    >
      <p className="text-sm">{content}</p>
      <div className="absolute left-1/2 -translate-x-1/2 bottom-[-8px] w-0 h-0 border-l-8 border-l-transparent border-r-8 border-r-transparent border-t-8 border-t-gray-800" />
    </div>
  );
};

const Chip = ({ icon: Icon, icons, label, onClick, isActive }: {
  icon: React.ElementType;
  icons?: React.ElementType[];
  label: string;
  onClick: (e: React.MouseEvent) => void;
  isActive: boolean;
}) => (
  <button
    onClick={onClick}
    data-chip
    className={`
      group flex items-center gap-2 px-3 py-1.5 rounded-lg
      bg-white/5 border border-white/10
      hover:bg-white/10 hover:border-white/20 hover:scale-105
      active:scale-100
      transition-all duration-200 cursor-pointer
      ${isActive ? 'bg-white/15 border-white/30 scale-105' : ''}
    `}
  >
    {icons ? (
      <div className="flex items-center gap-1">
        {icons.map((I, idx) => <I key={idx} className="h-3.5 w-3.5 text-gray-400" />)}
      </div>
    ) : (
      <Icon className="h-4 w-4 text-gray-400 group-hover:text-gray-300" />
    )}
    <span className="text-xs font-semibold uppercase tracking-wider text-gray-400 group-hover:text-gray-300">
      {label}
    </span>
  </button>
);

const NodeCard = ({
  number,
  title,
  subtitle,
  borderColor,
  numberColor,
  children
}: {
  number: string;
  title: string;
  subtitle: string;
  borderColor: string;
  numberColor: string;
  children: React.ReactNode;
}) => (
  <div className={`relative w-full max-w-sm p-5 rounded-2xl bg-gray-900/80 border ${borderColor} backdrop-blur-md`}>
    <div className="flex items-start gap-3 mb-4">
      <span className={`text-3xl font-bold ${numberColor} opacity-40`}>{number}</span>
      <div>
        <h3 className="text-lg font-bold text-white">{title}</h3>
        <p className="text-sm text-gray-500">{subtitle}</p>
      </div>
    </div>
    {children}
  </div>
);

const HowItWorks = () => {
  const [activeChip, setActiveChip] = useState<string | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ left: number; top: number; width: number } | null>(null);

  const handleChipClick = (e: React.MouseEvent, label: string) => {
    e.stopPropagation();
    if (activeChip === label) {
      setActiveChip(null);
      setTooltipPosition(null);
    } else {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setActiveChip(label);
      setTooltipPosition({ left: rect.left, top: rect.top, width: rect.width });
    }
  };

  const renderChips = (chips: { icon: React.ElementType; label: string; icons?: React.ElementType[] }[]) => (
    <div className="flex flex-wrap justify-center gap-2">
      {chips.map((chip) => (
        <Chip
          key={chip.label}
          icon={chip.icon}
          icons={chip.icons}
          label={chip.label}
          onClick={(e) => handleChipClick(e, chip.label)}
          isActive={activeChip === chip.label}
        />
      ))}
    </div>
  );

  return (
    <div className="min-h-screen bg-[#0D1321] text-white overflow-x-hidden">
      {activeChip && tooltipPosition && (
        <Tooltip
          content={featureDescriptions[activeChip] || "No description available."}
          position={tooltipPosition}
          onClose={() => { setActiveChip(null); setTooltipPosition(null); }}
        />
      )}

      <nav className="sticky top-0 z-50 bg-[#0D1321]/80 backdrop-blur-xl border-b border-white/5">
        <div className="container mx-auto px-6 py-4">
          <Link to="/" className="flex items-center space-x-2 text-gray-400 hover:text-white transition w-fit">
            <ArrowLeft className="w-5 h-5" />
            <span>Back to Home</span>
          </Link>
        </div>
      </nav>

      <section className="py-24 md:py-32 bg-[#0D1321] relative">
        <div className="container mx-auto px-6">
          <div className="text-center mb-16">
            <h1 className="text-3xl md:text-4xl font-bold text-white mb-3">
              How Agents Work
            </h1>
            <p className="text-lg text-gray-400 max-w-2xl mx-auto mt-6">
              Observer micro-agents follow a simple, powerful loop: see with sensors, think with models, and act with tools.
            </p>
          </div>

          {/* Desktop: Horizontal layout */}
          <div className="hidden lg:flex items-start justify-center gap-6 max-w-6xl mx-auto">
            <NodeCard number="01" title="See" subtitle="with Sensors" borderColor="border-blue-500/40" numberColor="text-blue-400">
              {renderChips([
                { icon: ScanText, label: 'OCR' },
                { icon: Monitor, label: 'SCREEN' },
                { icon: Camera, label: 'CAMERA' },
                { icon: Clipboard, label: 'CLIPBOARD' },
                { icon: Mic, label: 'MICROPHONE' },
                { icon: Volume2, label: 'AUDIO' },
                { icon: Blend, label: 'ALL AUDIO' },
                { icon: Brain, label: 'MEMORY' },
              ])}
            </NodeCard>

            <div className="flex items-center pt-20">
              <HandDrawnArrow className="w-14 text-gray-600" direction="right" />
            </div>

            <NodeCard number="02" title="Think" subtitle="with Models" borderColor="border-purple-500/40" numberColor="text-purple-400">
              {renderChips([
                { icon: Cpu, label: 'LOCAL' },
                { icon: Eye, label: 'VISION' },
                { icon: Layers, label: 'MODELS' },
              ])}
              <div className="mt-3 p-2.5 rounded-xl bg-white/5 border border-white/10 text-center">
                <p className="text-sm font-medium text-gray-300">ollama, vLLM, llama.cpp...</p>
                <p className="text-xs text-gray-500 mt-0.5">Any OpenAI-compatible endpoint</p>
              </div>
            </NodeCard>

            <div className="flex items-center pt-20">
              <HandDrawnArrow className="w-14 text-gray-600" direction="right" />
            </div>

            <NodeCard number="03" title="Act" subtitle="with Tools" borderColor="border-emerald-500/40" numberColor="text-emerald-400">
              {renderChips([
                { icon: Mail, label: 'MESSAGING', icons: [Mail, MessageSquare, Bell] },
                { icon: Clapperboard, label: 'RECORDING', icons: [Clapperboard, Tag] },
                { icon: Users, label: 'INTERACTION', icons: [Users, Terminal] },
                { icon: Save, label: 'MEMORY STORAGE', icons: [Save, Image] },
              ])}
            </NodeCard>
          </div>

          {/* Mobile: Vertical layout */}
          <div className="lg:hidden flex flex-col items-center gap-4">
            <NodeCard number="01" title="See" subtitle="with Sensors" borderColor="border-blue-500/40" numberColor="text-blue-400">
              {renderChips([
                { icon: ScanText, label: 'OCR' },
                { icon: Monitor, label: 'SCREEN' },
                { icon: Camera, label: 'CAMERA' },
                { icon: Clipboard, label: 'CLIPBOARD' },
                { icon: Mic, label: 'MICROPHONE' },
                { icon: Volume2, label: 'AUDIO' },
                { icon: Blend, label: 'ALL AUDIO' },
                { icon: Brain, label: 'MEMORY' },
              ])}
            </NodeCard>

            <HandDrawnArrow className="h-12 text-gray-600" direction="down" />

            <NodeCard number="02" title="Think" subtitle="with Models" borderColor="border-purple-500/40" numberColor="text-purple-400">
              {renderChips([
                { icon: Cpu, label: 'LOCAL' },
                { icon: Eye, label: 'VISION' },
                { icon: BrainCircuit, label: 'LLMS' },
                { icon: Layers, label: 'MODELS' },
              ])}
              <div className="mt-3 p-2.5 rounded-xl bg-white/5 border border-white/10 text-center">
                <p className="text-sm font-medium text-gray-300">ollama, vLLM, llama.cpp...</p>
                <p className="text-xs text-gray-500 mt-0.5">Any OpenAI-compatible endpoint</p>
              </div>
            </NodeCard>

            <HandDrawnArrow className="h-12 text-gray-600" direction="down" />

            <NodeCard number="03" title="Act" subtitle="with Tools" borderColor="border-emerald-500/40" numberColor="text-emerald-400">
              {renderChips([
                { icon: Mail, label: 'MESSAGING', icons: [Mail, MessageSquare, Bell] },
                { icon: Clapperboard, label: 'RECORDING', icons: [Clapperboard, Tag] },
                { icon: Users, label: 'INTERACTION', icons: [Users, Terminal] },
                { icon: Save, label: 'MEMORY STORAGE', icons: [Save, Image] },
              ])}
            </NodeCard>

            <div className="flex items-center gap-2 mt-4 px-4 py-2 rounded-full bg-emerald-500/10 border border-emerald-500/20">
              <Repeat className="h-4 w-4 text-emerald-400" />
              <span className="text-sm text-emerald-400">Continuous loop</span>
            </div>
          </div>
        </div>
      </section>

      <footer className="py-12 border-t border-white/5">
        <div className="container mx-auto px-6">
          <div className="flex flex-col md:flex-row justify-between items-center gap-6">
            <div className="flex items-center space-x-3">
              <img src="/eye-logo-white.svg" alt="Observer AI Logo" className="w-5 h-5 opacity-60" />
              <span className="text-gray-500 text-sm">Observer AI</span>
            </div>
            <div className="flex items-center space-x-8 text-sm text-gray-500">
              <Link to="/privacy" className="hover:text-white transition">Privacy</Link>
              <Link to="/terms" className="hover:text-white transition">Terms</Link>
              <a href="https://github.com/Roy3838/Observer" className="hover:text-white transition">GitHub</a>
              <a href="https://discord.gg/wnBb7ZQDUC" className="hover:text-white transition">Discord</a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default HowItWorks;
