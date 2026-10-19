import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Bot, Download, User, Clock, Cpu, Smartphone } from 'lucide-react';

const SERVER_URL = 'https://api.observer-ai.com';
const IOS_STORE_URL = 'https://apps.apple.com/us/app/observer-ai/id6758222050';
const ANDROID_STORE_URL = 'https://play.google.com/store/apps/details?id=com.observer.ai';

interface MarketplaceAgent {
  id: string;
  name: string;
  description: string;
  model_name: string;
  loop_interval_seconds: number;
  author?: string;
}

const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent);
const isAndroid = () => /Android/i.test(navigator.userAgent);

const AgentShareLandingPage: React.FC = () => {
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  const [agent, setAgent] = useState<MarketplaceAgent | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [openingApp, setOpeningApp] = useState(false);

  useEffect(() => {
    if (!agentId) return;
    (async () => {
      try {
        const res = await fetch(`${SERVER_URL}/agents/${agentId}`);
        if (!res.ok) { setNotFound(true); return; }
        setAgent(await res.json());
      } catch {
        setNotFound(true);
      } finally {
        setIsLoading(false);
      }
    })();
  }, [agentId]);

  const handleOpenInApp = () => {
    setOpeningApp(true);

    // Try the custom scheme — if the app is installed, it intercepts this
    window.location.href = `observer://marketplace/${agentId}`;

    // If the app opened, this tab goes to the background and document.hidden becomes true.
    // If not installed, the browser ignores the scheme and we fall through to the store.
    setTimeout(() => {
      if (document.hidden) return; // App opened successfully
      const storeUrl = isIOS() ? IOS_STORE_URL : isAndroid() ? ANDROID_STORE_URL : IOS_STORE_URL;
      window.location.href = storeUrl;
    }, 1500);
  };

  const handleImportInBrowser = () => {
    navigate(`/?importAgent=${agentId}`, { replace: true });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
          <p className="text-sm text-slate-400">Loading agent…</p>
        </div>
      </div>
    );
  }

  if (notFound || !agent) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4">
        <div className="text-center">
          <p className="text-slate-500 text-lg font-medium">Agent not found</p>
          <p className="text-slate-400 text-sm mt-1">This link may have expired or been removed.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">

        {/* Wordmark */}
        <div className="flex items-center justify-center gap-2 mb-8">
          <img src="/eye-logo-black.svg" alt="Observer" className="h-6 w-6" />
          <span className="text-slate-500 text-sm font-medium tracking-wide">Observer</span>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-xl shadow-slate-200/60 overflow-hidden">

          {/* Header */}
          <div className="bg-gradient-to-br from-blue-500 to-blue-600 px-6 pt-8 pb-6">
            <div className="w-12 h-12 bg-white/20 rounded-xl flex items-center justify-center mb-4">
              <Bot className="w-6 h-6 text-white" />
            </div>
            <h1 className="text-xl font-bold text-white leading-snug">{agent.name}</h1>
            {agent.author && (
              <div className="flex items-center gap-1.5 mt-2">
                <User className="w-3 h-3 text-blue-200" />
                <span className="text-blue-100 text-xs">{agent.author}</span>
              </div>
            )}
          </div>

          {/* Body */}
          <div className="px-6 py-5">
            {agent.description && (
              <p className="text-slate-600 text-sm leading-relaxed mb-5">
                {agent.description}
              </p>
            )}

            <div className="flex flex-wrap gap-2 mb-6">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-slate-100 rounded-full text-xs text-slate-500 font-medium">
                <Cpu className="w-3 h-3" />
                {agent.model_name}
              </span>
              <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-slate-100 rounded-full text-xs text-slate-500 font-medium">
                <Clock className="w-3 h-3" />
                every {agent.loop_interval_seconds}s
              </span>
            </div>

            {/* CTAs */}
            <div className="flex flex-col gap-3">
              <button
                onClick={handleOpenInApp}
                disabled={openingApp}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-500 hover:bg-blue-600 active:bg-blue-700 disabled:opacity-60 text-white text-sm font-semibold rounded-xl transition-colors"
              >
                <Smartphone className="w-4 h-4" />
                {openingApp ? 'Opening…' : 'Open in Observer App'}
              </button>
              <button
                onClick={handleImportInBrowser}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-700 text-sm font-semibold rounded-xl transition-colors"
              >
                <Download className="w-4 h-4" />
                Import in Browser
              </button>
            </div>
          </div>
        </div>

        <p className="text-center text-xs text-slate-400 mt-6">
          Shared via{' '}
          <a href="https://observer-ai.com" className="hover:text-slate-600 transition-colors">
            observer-ai.com
          </a>
        </p>
      </div>
    </div>
  );
};

export default AgentShareLandingPage;
