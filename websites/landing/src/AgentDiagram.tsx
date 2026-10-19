import { useRef, useEffect, useState, useCallback } from 'react';
import {
  ScanText, Monitor, Mic, Brain, Volume2, Camera, Clipboard,
  BrainCircuit, Cpu, Layers, Eye,
  Bell, Mail, MessageSquare, Terminal, Save, Clapperboard, Tag, Blend,
  ChevronDown, Users, Image, Repeat,
} from 'lucide-react';

// --- DATA ---
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
  RECORDING: "Start and stop screen recordings. Add timestamped labels to recordings for quick reference in the Clips tab.",
  INTERACTION: "Enable multi-agent collaboration to break down complex tasks. Execute JavaScript or Python code. Use system dialogs for user interaction.",
  'MEMORY STORAGE': "Store and retrieve text memories and images. Agents can access their own or other agents' memories for contextual awareness.",
};

// --- TOOLTIP ---
const Tooltip = ({ content, position, onClose }: {
  content: string;
  position: DOMRect;
  onClose: () => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        if (!(e.target as Element).closest('[data-chip]')) onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-50 w-64 p-3 bg-gray-800 text-white rounded-xl shadow-2xl border border-white/10"
      style={{
        left: `${position.left + position.width / 2}px`,
        top: `${position.top - 8}px`,
        transform: 'translateX(-50%) translateY(-100%)'
      }}
    >
      <p className="text-sm leading-relaxed">{content}</p>
      <div className="absolute left-1/2 -translate-x-1/2 -bottom-2 w-0 h-0 border-l-8 border-l-transparent border-r-8 border-r-transparent border-t-8 border-t-gray-800" />
    </div>
  );
};

// --- CHIP ---
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
      transition-all duration-200
      ${isActive ? 'bg-white/15 border-white/30 scale-105' : ''}
    `}
  >
    {icons ? (
      <div className="flex items-center gap-0.5">
        {icons.map((I, idx) => (
          <I key={idx} className="h-3.5 w-3.5 text-gray-400 group-hover:text-white transition-colors" />
        ))}
      </div>
    ) : (
      <Icon className="h-4 w-4 text-gray-400 group-hover:text-white transition-colors" />
    )}
    <span className="text-xs font-medium text-gray-300 group-hover:text-white transition-colors uppercase tracking-wide">
      {label}
    </span>
  </button>
);

// --- NODE CARD ---
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
  <div className={`relative w-72 p-5 rounded-2xl bg-gray-900/80 border ${borderColor} backdrop-blur-md`}>
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

// --- DESKTOP DIAGRAM ---
const DesktopDiagram = ({ onChipClick, activeChip }: {
  onChipClick: (e: React.MouseEvent, label: string) => void;
  activeChip: string | null;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const lastAngleRef = useRef<number>(195);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.style.setProperty('--rotation', `${lastAngleRef.current}deg`);

    let ticking = false;

    const updateRotation = () => {
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const lockZoneStart = viewportHeight * 0.3;
      const lockZoneEnd = viewportHeight * 0.7;
      const diagramCenterY = rect.top + rect.height / 2;
      const targetLockAngle = 340;

      let newAngle: number;
      if (diagramCenterY > lockZoneStart && diagramCenterY < lockZoneEnd) {
        newAngle = targetLockAngle;
      } else {
        const scrollDrivenOffset = (diagramCenterY <= lockZoneStart)
          ? diagramCenterY - lockZoneStart
          : diagramCenterY - lockZoneEnd;
        newAngle = targetLockAngle + scrollDrivenOffset * -0.2;
      }

      if (Math.abs(newAngle - lastAngleRef.current) > 0.1) {
        lastAngleRef.current = newAngle;
        container.style.setProperty('--rotation', `${newAngle}deg`);
      }

      ticking = false;
    };

    const handleScroll = () => {
      if (!ticking) {
        rafRef.current = requestAnimationFrame(updateRotation);
        ticking = true;
      }
    };

    updateRotation();

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const renderChips = (chips: { icon: React.ElementType; label: string; icons?: React.ElementType[] }[]) => (
    <div className="flex flex-wrap justify-center gap-2">
      {chips.map((chip) => (
        <Chip
          key={chip.label}
          icon={chip.icon}
          icons={chip.icons}
          label={chip.label}
          onClick={(e) => onChipClick(e, chip.label)}
          isActive={activeChip === chip.label}
        />
      ))}
    </div>
  );

  return (
    <div
      ref={containerRef}
      className="relative h-[52rem] flex items-center justify-center"
      style={{ '--rotation': '195deg' } as React.CSSProperties}
    >
      {/* Rotating circle */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <svg className="w-full h-full max-w-2xl max-h-2xl" viewBox="0 0 200 200" fill="none">
          <g style={{ transform: 'rotate(var(--rotation))', transformOrigin: '100px 100px' }}>
            <circle
              cx="100" cy="100" r="85"
              stroke="url(#gradient-circle)"
              strokeWidth="1.5"
              strokeDasharray="6 8"
              className="animate-dash-flow"
              vectorEffect="non-scaling-stroke"
            />
          </g>
          <defs>
            <linearGradient id="gradient-circle" gradientTransform="rotate(90)">
              <stop offset="0%" stopColor="#3b82f6" />
              <stop offset="50%" stopColor="#a855f7" />
              <stop offset="100%" stopColor="#10b981" />
            </linearGradient>
          </defs>
        </svg>
      </div>

      {/* Center logo */}
      <div className="absolute w-72 h-72 flex items-center justify-center">
        <div className="absolute inset-0 bg-gradient-to-br from-blue-500/10 via-purple-500/10 to-emerald-500/10 rounded-full blur-3xl" />
        <div className="relative w-32 h-32 flex items-center justify-center">
          <div className="absolute inset-0 bg-gray-800/80 rounded-full" />
          <img src="/eye-logo-white.svg" alt="Observer AI Logo" className="relative w-20 h-20 opacity-90" />
        </div>
      </div>

      {/* Rotating nodes */}
      <div className="absolute inset-0 will-change-transform" style={{ transform: 'rotate(var(--rotation))' }}>
        {/* Node 1: Sensors (0°) */}
        <div className="absolute inset-0" style={{ transform: 'rotate(0deg)' }}>
          <div
            className="absolute top-1/2 left-1/2 will-change-transform"
            style={{ transform: 'translate(-50%, -22rem) rotate(calc(-1 * var(--rotation)))' }}
          >
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
          </div>
        </div>

        {/* Node 2: Models (120°) */}
        <div className="absolute inset-0" style={{ transform: 'rotate(120deg)' }}>
          <div
            className="absolute top-1/2 left-1/2 will-change-transform"
            style={{ transform: 'translate(-50%, -22rem) rotate(calc(-120deg - var(--rotation)))' }}
          >
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
          </div>
        </div>

        {/* Node 3: Tools (240°) */}
        <div className="absolute inset-0" style={{ transform: 'rotate(240deg)' }}>
          <div
            className="absolute top-1/2 left-1/2 will-change-transform"
            style={{ transform: 'translate(-50%, -22rem) rotate(calc(-240deg - var(--rotation)))' }}
          >
            <NodeCard number="03" title="Act" subtitle="with Tools" borderColor="border-emerald-500/40" numberColor="text-emerald-400">
              {renderChips([
                { icon: Mail, label: 'MESSAGING', icons: [Mail, MessageSquare, Bell] },
                { icon: Clapperboard, label: 'RECORDING', icons: [Clapperboard, Tag] },
                { icon: Users, label: 'INTERACTION', icons: [Users, Terminal] },
                { icon: Save, label: 'MEMORY STORAGE', icons: [Save, Image] },
              ])}
            </NodeCard>
          </div>
        </div>
      </div>
    </div>
  );
};

// --- MOBILE LAYOUT ---
const MobileLayout = ({ onChipClick, activeChip }: {
  onChipClick: (e: React.MouseEvent, label: string) => void;
  activeChip: string | null;
}) => {
  const renderChips = (chips: { icon: React.ElementType; label: string; icons?: React.ElementType[] }[]) => (
    <div className="flex flex-wrap justify-center gap-2">
      {chips.map((chip) => (
        <Chip
          key={chip.label}
          icon={chip.icon}
          icons={chip.icons}
          label={chip.label}
          onClick={(e) => onChipClick(e, chip.label)}
          isActive={activeChip === chip.label}
        />
      ))}
    </div>
  );

  return (
    <div className="flex flex-col items-center gap-6">
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

      <ChevronDown className="h-6 w-6 text-blue-400/50" />

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

      <ChevronDown className="h-6 w-6 text-purple-400/50" />

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
  );
};

// --- MAIN COMPONENT ---
export const AgentDiagram = () => {
  const [isDesktop, setIsDesktop] = useState(false);
  const [activeChip, setActiveChip] = useState<string | null>(null);
  const [tooltipData, setTooltipData] = useState<{ label: string; position: DOMRect } | null>(null);

  useEffect(() => {
    const checkDesktop = () => setIsDesktop(window.innerWidth >= 768);
    checkDesktop();
    window.addEventListener('resize', checkDesktop);
    return () => window.removeEventListener('resize', checkDesktop);
  }, []);

  const handleChipClick = useCallback((e: React.MouseEvent, label: string) => {
    e.stopPropagation();
    if (activeChip === label) {
      setActiveChip(null);
      setTooltipData(null);
    } else {
      setActiveChip(label);
      setTooltipData({
        label,
        position: (e.currentTarget as HTMLElement).getBoundingClientRect()
      });
    }
  }, [activeChip]);

  const handleCloseTooltip = useCallback(() => {
    setActiveChip(null);
    setTooltipData(null);
  }, []);

  return (
    <section className="py-24 md:py-32">
      <div className="container mx-auto px-6">
        {/* Header */}
        <div className="text-center mb-16 md:mb-8">
          <h2 className="text-4xl md:text-5xl font-bold text-white mb-4">
            How Agents Work
          </h2>
          <p className="text-lg text-gray-400 max-w-2xl mx-auto">
            A continuous loop of perception, reasoning, and action.
          </p>
        </div>

        {/* Tooltip */}
        {tooltipData && (
          <Tooltip
            content={featureDescriptions[tooltipData.label] || "No description available."}
            position={tooltipData.position}
            onClose={handleCloseTooltip}
          />
        )}

        {/* Diagram */}
        {isDesktop ? (
          <DesktopDiagram onChipClick={handleChipClick} activeChip={activeChip} />
        ) : (
          <MobileLayout onChipClick={handleChipClick} activeChip={activeChip} />
        )}

        {/* Loop indicator - desktop only */}
        {isDesktop && (
          <div className="flex justify-center -mt-16">
            <div className="flex items-center gap-3 px-5 py-3 rounded-full bg-white/5 border border-white/10">
              <Repeat className="h-5 w-5 text-gray-400" />
              <span className="text-sm text-gray-400">
                Runs continuously at your configured interval
              </span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};

export default AgentDiagram;
