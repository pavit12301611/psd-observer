import { useState, useEffect, useRef } from 'react';

const terminalLines = [
  { prompt: '>', command: 'observer status', color: 'text-cyan-400' },
  { prompt: '', command: 'Agent: API Health Monitor', color: 'text-green-400', isOutput: true },
  { prompt: '', command: 'Target: status.observer-ai.com', color: 'text-blue-400', isOutput: true },
  { prompt: '', command: 'Interval: 10 minutes', color: 'text-purple-400', isOutput: true },
  { prompt: '', command: 'Notifications: Discord', color: 'text-yellow-400', isOutput: true },
  { prompt: '', command: 'Status: ONLINE', color: 'text-green-400', isOutput: true }
];

const Monitoring = () => {
  const [lines, setLines] = useState<Array<{ text: string; color: string; isOutput?: boolean }>>([]);
  const [currentLine, setCurrentLine] = useState(0);
  const [currentChar, setCurrentChar] = useState(0);
  const [hasStarted, setHasStarted] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);

  // Start animation when section is visible
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasStarted) {
          setHasStarted(true);
        }
      },
      { threshold: 0.3 }
    );

    if (sectionRef.current) {
      observer.observe(sectionRef.current);
    }

    return () => observer.disconnect();
  }, [hasStarted]);

  // Typing animation
  useEffect(() => {
    if (!hasStarted || currentLine >= terminalLines.length) return;

    const line = terminalLines[currentLine];
    const fullText = line.prompt ? `${line.prompt} ${line.command}` : line.command;

    if (currentChar < fullText.length) {
      const timer = setTimeout(() => setCurrentChar(c => c + 1), 25);
      return () => clearTimeout(timer);
    } else {
      const timer = setTimeout(() => {
        setLines(prev => [...prev, { text: fullText, color: line.color, isOutput: line.isOutput }]);
        setCurrentLine(l => l + 1);
        setCurrentChar(0);
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [currentChar, currentLine, hasStarted]);

  const activeLine = terminalLines[currentLine];
  const activeText = activeLine
    ? (activeLine.prompt ? `${activeLine.prompt} ${activeLine.command}` : activeLine.command).slice(0, currentChar)
    : '';

  return (
    <section ref={sectionRef} className="py-24 relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-gray-950 via-gray-900 to-gray-900" />

      <div className="container mx-auto px-6 relative">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">
            Observer Monitoring Observer
          </h2>
          <p className="text-gray-400 max-w-2xl mx-auto">
            We use Observer to monitor our own infrastructure. Watch it in action.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 max-w-6xl mx-auto">
          {/* Terminal */}
          <div className="rounded-2xl overflow-hidden bg-[#0d1117] border border-white/10 shadow-2xl">
            <div className="bg-[#161b22] px-4 py-3 flex items-center gap-2 border-b border-white/10">
              <div className="flex gap-2">
                <div className="w-3 h-3 rounded-full bg-[#ff5f56]" />
                <div className="w-3 h-3 rounded-full bg-[#ffbd2e]" />
                <div className="w-3 h-3 rounded-full bg-[#27c93f]" />
              </div>
              <span className="text-gray-500 text-sm ml-3 font-mono">observer-ai</span>
            </div>

            <div className="p-6 font-mono text-sm min-h-[280px] space-y-1">
              {lines.map((line, i) => (
                <div key={i} className={`${line.color} ${line.isOutput ? 'pl-4' : ''}`}>
                  {line.text}
                </div>
              ))}
              {currentLine < terminalLines.length && (
                <div className={`${activeLine?.color} ${activeLine?.isOutput ? 'pl-4' : ''}`}>
                  {activeText}
                  <span className="inline-block w-2 h-4 bg-white/70 ml-0.5 animate-pulse" />
                </div>
              )}
            </div>
          </div>

          {/* Live Dashboard */}
          <div className="rounded-2xl overflow-hidden bg-[#0d1117] border border-white/10 shadow-2xl">
            <div className="bg-[#161b22] px-4 py-3 flex items-center justify-between border-b border-white/10">
              <div className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
                </span>
                <span className="text-red-400 text-sm font-semibold">LIVE</span>
              </div>
              <a
                href="https://status.observer-ai.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-400 hover:text-white text-sm transition"
              >
                status.observer-ai.com &rarr;
              </a>
            </div>

            <div className="p-4">
              <img
                src="/monitoring.png"
                alt="Observer monitoring dashboard"
                className="w-full h-auto rounded-lg border border-white/5"
              />
            </div>

            <div className="bg-[#161b22] px-4 py-3 border-t border-white/10 flex items-center justify-center gap-4 text-sm">
              <a
                href="https://discord.gg/wnBb7ZQDUC"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300 transition"
              >
                Watch live in Discord
              </a>
              <span className="text-gray-700">&bull;</span>
              <a
                href="https://app.observer-ai.com"
                className="text-purple-400 hover:text-purple-300 transition"
              >
                Build your own agent
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Monitoring;
