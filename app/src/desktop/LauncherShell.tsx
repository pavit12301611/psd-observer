import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { platformFetch } from '@utils/platform';
import {
  ExternalLink, Loader, CheckCircle2, Power,
  Download, Settings, RotateCw, Check, AlertTriangle, Keyboard,
  Eye, EyeOff, Trash2, ChevronRight, Info
} from 'lucide-react';

// --- Helper Component for the Status Display (MODIFIED) ---
// Now accepts strings to display full URLs or ports.
const StatusDisplay: React.FC<{
  isChecking: boolean;
  foundServers: string[];
}> = ({ isChecking, foundServers }) => {
  if (isChecking) {
    return (
      <div className="flex items-center justify-center space-x-4 animate-fade-in">
        <Loader className="h-7 w-7 animate-spin text-slate-400" />
        <p className="text-base text-slate-500">Scanning for local AI server...</p>
      </div>
    );
  }

  if (foundServers.length > 0) {
    return (
      <div className="flex items-center justify-center space-x-4 animate-fade-in">
        <CheckCircle2 className="h-8 w-8 text-green-500" />
        <p className="text-base text-slate-700 font-medium">
          Success! Found server at: <span className="font-bold">{foundServers.join(', ')}</span>
        </p>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center space-x-4 animate-fade-in">
      <Info className="h-8 w-8 text-blue-500" />
      <p className="text-base text-slate-700 font-medium">Welcome! First, let's get you set up with a local AI server.</p>
    </div>
  );
};


function LauncherShell() {
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  // --- STATE MODIFICATION ---
  // Now stores full URLs or identifiers for display
  const [foundServers, setFoundServers] = useState<string[]>([]);

  // --- TAB STATE ---
  const [activeTab, setActiveTab] = useState<'server' | 'controls'>('server');

  // --- SERVER CONFIGURATION STATE ---
  const [showServerConfig, setShowServerConfig] = useState(false);
  const [customUrlInput, setCustomUrlInput] = useState('');
  const [saveFeedback, setSaveFeedback] = useState<{ message: string, type: 'success' | 'error' } | null>(null);
  const [showNoServerDialog, setShowNoServerDialog] = useState(false);
  
  // --- CONTROLS TAB STATE VARIABLES ---
  const [overlayShortcuts, setOverlayShortcuts] = useState({
    toggle: '',
    move_up: '',
    move_down: '',
    move_left: '',
    move_right: '',
    resize_up: '',
    resize_down: '',
    resize_left: '',
    resize_right: ''
  });
  const [availableAgents, setAvailableAgents] = useState<Array<{id: string, name: string}>>([]);
  const [agentShortcuts, setAgentShortcuts] = useState<Record<string, string>>({});
  const [activeShortcuts, setActiveShortcuts] = useState<string[]>([]);
  const [shortcutFeedback, setShortcutFeedback] = useState<{ message: string, type: 'success' | 'error' } | null>(null);
  const [capturingFor, setCapturingFor] = useState<string | null>(null);
  const [newAgentId, setNewAgentId] = useState('');

  // --- KEY CAPTURE UTILITIES ---
  const buildKeyCombo = (event: KeyboardEvent): string => {
    const modifiers = [];
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    
    if (event.metaKey) modifiers.push(isMac ? 'Cmd' : 'Super');
    if (event.ctrlKey) modifiers.push('Ctrl');
    if (event.altKey) modifiers.push('Alt');
    if (event.shiftKey) modifiers.push('Shift');
    
    // Map common keys
    let key = event.key;
    if (key === ' ') key = 'Space';
    if (key === 'ArrowUp') key = 'ArrowUp';
    if (key === 'ArrowDown') key = 'ArrowDown';
    if (key === 'ArrowLeft') key = 'ArrowLeft';
    if (key === 'ArrowRight') key = 'ArrowRight';
    if (key.length === 1) key = key.toUpperCase();
    
    // Don't allow modifier-only combos
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) {
      return '';
    }
    
    return modifiers.length > 0 ? `${modifiers.join('+')}+${key}` : key;
  };

  const handleAddAgent = useCallback(() => {
    if (!newAgentId.trim()) return;
    
    const agentId = newAgentId.trim();
    if (availableAgents.find(a => a.id === agentId)) {
      setShortcutFeedback({ message: `Agent "${agentId}" already exists`, type: 'error' });
      return;
    }
    
    setAvailableAgents(prev => [...prev, { id: agentId, name: agentId }]);
    setNewAgentId('');
    setShortcutFeedback({ message: `Agent "${agentId}" added`, type: 'success' });
    setTimeout(() => setShortcutFeedback(null), 2000);
  }, [newAgentId, availableAgents]);

  const runServerChecks = useCallback(async () => {
    setIsChecking(true);
    setFoundServers([]);
    setSaveFeedback(null);

    try {
      // 1. Determine which URLs to test (same logic as before)
      const savedUrl = await invoke<string | null>('get_ollama_url');
      let urlsToTest: string[] = [];
      if (savedUrl) {
        urlsToTest.push(savedUrl);
      } else {
        urlsToTest = ['http://127.0.0.1:11434', 'http://127.0.0.1:8080'];
      }

      // 2. Create two promises: one for the browser fetch, one for the Rust command.

      // Promise 1: Browser-based fetch
      const browserCheckPromise = new Promise<string[]>(async (resolve, reject) => {
        try {
          const fetchPromises = urlsToTest.map(url =>
            platformFetch(`${url}/v1/models`, {
              method: 'GET',
              headers: { 'Accept': 'application/json' },
              signal: AbortSignal.timeout(2500),
            }).then(response => {
              if (!response.ok) throw new Error(`Server at ${url} not OK.`);
              return url;
            })
          );
          const results = await Promise.allSettled(fetchPromises);
          const successfulUrls = results
            .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
            .map(r => r.value);
          
          if (successfulUrls.length > 0) {
            console.log("Browser check succeeded:", successfulUrls);
            resolve(successfulUrls);
          } else {
            reject(new Error("Browser check found no servers."));
          }
        } catch (error) {
          reject(error);
        }
      });

      // Promise 2: Rust backend invoke
      const backendCheckPromise = new Promise<string[]>(async (resolve, reject) => {
        try {
          const successfulUrls = await invoke<string[]>('check_ollama_servers', { urls: urlsToTest });
          if (successfulUrls.length > 0) {
            console.log("Backend check succeeded:", successfulUrls);
            resolve(successfulUrls);
          } else {
            reject(new Error("Backend check found no servers."));
          }
        } catch (error) {
          reject(error);
        }
      });

      // 3. Race them! Promise.any resolves with the value of the FIRST promise to succeed.
      const successfulUrls = await Promise.any([browserCheckPromise, backendCheckPromise]);
      setFoundServers(successfulUrls);

    } catch (error) {
      // This block only runs if *both* checks fail.
      console.error("Both browser and backend checks failed:", error);
      setFoundServers([]);
    } finally {
      setIsChecking(false);
    }
  }, []);

  // --- NEW: Function to handle saving the custom URL ---
  const handleSaveSettings = useCallback(async () => {
    const urlToSave = customUrlInput.trim() === '' ? null : customUrlInput.trim();

    // Simple validation
    if (urlToSave && !urlToSave.startsWith('http')) {
      setSaveFeedback({ message: 'URL must start with http:// or https://', type: 'error' });
      return;
    }

    try {
      await invoke('set_ollama_url', { newUrl: urlToSave });
      setSaveFeedback({ message: 'Settings saved!', type: 'success' });
      // Important: Immediately re-run the check with the new settings
      runServerChecks();
    } catch (error) {
      console.error("Failed to save settings:", error);
      setSaveFeedback({ message: 'Error saving settings.', type: 'error' });
    }
  }, [customUrlInput, runServerChecks]);
  
  // --- UNIFIED SHORTCUT LOADING AND SAVING ---
  const loadAllShortcuts = useCallback(async () => {
    try {
      const [unifiedConfig, registeredShortcuts] = await Promise.all([
        invoke<any>('get_shortcut_config'),
        invoke<string[]>('get_registered_shortcuts')
      ]);
      
      // Set overlay shortcuts from unified config
      setOverlayShortcuts({
        toggle: unifiedConfig.overlay_toggle || '',
        move_up: unifiedConfig.overlay_move_up || '',
        move_down: unifiedConfig.overlay_move_down || '',
        move_left: unifiedConfig.overlay_move_left || '',
        move_right: unifiedConfig.overlay_move_right || '',
        resize_up: unifiedConfig.overlay_resize_up || '',
        resize_down: unifiedConfig.overlay_resize_down || '',
        resize_left: unifiedConfig.overlay_resize_left || '',
        resize_right: unifiedConfig.overlay_resize_right || ''
      });
      
      // Set agent shortcuts from unified config - no need to fetch agents from backend
      setAgentShortcuts(unifiedConfig.agent_shortcuts || {});
      // Generate available agents from the shortcuts that are configured
      const agentIds = Object.keys(unifiedConfig.agent_shortcuts || {});
      const agents = agentIds.map(id => ({ id, name: id })); // Use ID as name for now
      setAvailableAgents(agents);
      
      // Set registered shortcuts
      setActiveShortcuts(registeredShortcuts);
    } catch (error) {
      console.error('Failed to load shortcuts:', error);
    }
  }, []);
  
  const validateAllShortcuts = (): string | null => {
    const usedShortcuts = new Set<string>();
    const conflicts: string[] = [];
    
    // Check overlay shortcuts
    for (const [_, shortcut] of Object.entries(overlayShortcuts)) {
      if (shortcut && shortcut.trim()) {
        if (usedShortcuts.has(shortcut)) {
          conflicts.push(shortcut);
        } else {
          usedShortcuts.add(shortcut);
        }
      }
    }
    
    // Check agent shortcuts
    for (const [_, shortcut] of Object.entries(agentShortcuts)) {
      if (shortcut && shortcut.trim()) {
        if (usedShortcuts.has(shortcut)) {
          conflicts.push(shortcut);
        } else {
          usedShortcuts.add(shortcut);
        }
      }
    }
    
    if (conflicts.length > 0) {
      return `Duplicate shortcuts detected: ${conflicts.join(', ')}`;
    }
    
    return null;
  };

  const handleSaveAllShortcuts = useCallback(async () => {
    // Validate all shortcuts for conflicts
    const validationError = validateAllShortcuts();
    if (validationError) {
      setShortcutFeedback({ 
        message: validationError, 
        type: 'error' 
      });
      return;
    }
    
    try {
      // Save unified config with both overlay and agent shortcuts
      const unifiedConfigToSave = {
        overlay_toggle: overlayShortcuts.toggle.trim() || null,
        overlay_move_up: overlayShortcuts.move_up.trim() || null,
        overlay_move_down: overlayShortcuts.move_down.trim() || null,
        overlay_move_left: overlayShortcuts.move_left.trim() || null,
        overlay_move_right: overlayShortcuts.move_right.trim() || null,
        overlay_resize_up: overlayShortcuts.resize_up.trim() || null,
        overlay_resize_down: overlayShortcuts.resize_down.trim() || null,
        overlay_resize_left: overlayShortcuts.resize_left.trim() || null,
        overlay_resize_right: overlayShortcuts.resize_right.trim() || null,
        agent_shortcuts: agentShortcuts
      };
      
      await invoke('set_shortcut_config', { config: unifiedConfigToSave });
      
      setShortcutFeedback({ 
        message: 'All shortcuts saved! Restart the app to activate all shortcuts.', 
        type: 'success' 
      });
      
      // Clear feedback after 4 seconds
      setTimeout(() => setShortcutFeedback(null), 4000);
    } catch (error) {
      console.error('Failed to save shortcuts:', error);
      setShortcutFeedback({ 
        message: `Error saving shortcuts: ${error}`, 
        type: 'error' 
      });
    }
  }, [overlayShortcuts, agentShortcuts]);

  // --- EFFECT HOOKS ---

  // 1. Get the main app's URL from Tauri backend (unchanged)
  useEffect(() => {
    invoke<string>('get_server_url')
      .then(url => setServerUrl(url))
      .catch(console.error);
  }, []);

  // 2. NEW: On load, fetch the saved custom URL to populate the input field.
  useEffect(() => {
    invoke<string | null>('get_ollama_url')
      .then(url => {
        if (url) {
          setCustomUrlInput(url);
        }
      })
      .catch(console.error);
  }, []);

  // 3. Run the server checks once on startup (unchanged)
  useEffect(() => {
    runServerChecks();
  }, [runServerChecks]);
  
  // 4. Load all shortcuts configuration on startup
  useEffect(() => {
    loadAllShortcuts();
  }, [loadAllShortcuts]);
  
  // 6. Key capture effect
  useEffect(() => {
    if (!capturingFor) return;
    
    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      
      // Escape cancels capture
      if (event.key === 'Escape') {
        setCapturingFor(null);
        return;
      }
      
      const combo = buildKeyCombo(event);
      if (combo) {
        // Check if we're setting an overlay shortcut or agent shortcut
        if (capturingFor.startsWith('overlay_')) {
          const overlayKey = capturingFor.replace('overlay_', '');
          setOverlayShortcuts(prev => ({
            ...prev,
            [overlayKey]: combo
          }));
        } else {
          // Agent shortcut
          setAgentShortcuts(prev => ({
            ...prev,
            [capturingFor]: combo
          }));
        }
        setCapturingFor(null);
      }
    };
    
    // Capture keys globally
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [capturingFor, buildKeyCombo]);

  // --- Overlay Control Handlers ---
  const handleShowOverlay = useCallback(async () => {
    try {
      const overlayWindow = await WebviewWindow.getByLabel('overlay');
      if (overlayWindow) {
        await overlayWindow.show();
      }
    } catch (error) {
      console.error('Failed to show overlay:', error);
    }
  }, []);

  const handleHideOverlay = useCallback(async () => {
    try {
      const overlayWindow = await WebviewWindow.getByLabel('overlay');
      if (overlayWindow) {
        await overlayWindow.hide();
      }
    } catch (error) {
      console.error('Failed to hide overlay:', error);
    }
  }, []);

  const handleClearOverlay = useCallback(async () => {
    try {
      await invoke('clear_overlay_messages');
    } catch (error) {
      console.error('Failed to clear overlay messages:', error);
    }
  }, []);

  // --- Handlers ---
  const handleOpenApp = () => {
    // Check if no servers are found, show confirmation dialog
    if (showFailureState) {
      setShowNoServerDialog(true);
      return;
    }
    // Open the server URL if available
    serverUrl && open(serverUrl);
  };

  const handleConfirmLaunchWithoutServer = () => {
    setShowNoServerDialog(false);
    // Proceed with launching Observer even without local server
    serverUrl && open(serverUrl);
  };

  const handleDownloadOllama = () => open('https://ollama.com');

  const showSuccessState = !isChecking && foundServers.length > 0;
  const showFailureState = !isChecking && foundServers.length === 0;

  return (
    <div className="fixed inset-0 bg-slate-50 flex items-center justify-center p-4 font-sans overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 p-8 max-w-2xl w-full text-center my-auto">

        {/* Header */}
        <div className="mb-6">
          <div className="flex justify-center items-center mb-3">
            <img src="/eye-logo-black.svg" alt="Observer AI Logo" className="h-16 w-16 mr-3" />
            <h1 className="text-3xl font-bold text-slate-800 tracking-tight">Observer AI</h1>
          </div>
          <p className="text-base text-gray-500 max-w-md mx-auto leading-relaxed">
            {showSuccessState ? "You're all set and ready to launch!" : "Welcome! Let's find your local AI server."}
          </p>
        </div>

        {/* Tab Navigation */}
        <div className="mb-5">
          <div className="flex space-x-1 bg-slate-100 p-1 rounded-xl border border-slate-200">
            <button
              onClick={() => setActiveTab('server')}
              className={`flex-1 px-4 py-2.5 text-sm font-semibold rounded-lg transition-all duration-200 ${
                activeTab === 'server'
                  ? 'bg-white text-slate-800 shadow-md ring-1 ring-slate-200'
                  : 'text-slate-600 hover:text-slate-800 hover:bg-slate-50'
              }`}
            >
              Server Setup
            </button>
            <button
              onClick={() => setActiveTab('controls')}
              className={`flex-1 px-4 py-2.5 text-sm font-semibold rounded-lg transition-all duration-200 ${
                activeTab === 'controls'
                  ? 'bg-white text-slate-800 shadow-md ring-1 ring-slate-200'
                  : 'text-slate-600 hover:text-slate-800 hover:bg-slate-50'
              }`}
            >
              Advanced Controls
            </button>
          </div>
        </div>

        {/* Tab Content */}
        {activeTab === 'server' && (
          <div className="animate-fade-in">
            {/* Launch Observer Button - Always Visible */}
            <div className="mb-4">
              <button
                onClick={handleOpenApp}
                className="w-full px-6 py-4 bg-green-500 text-white rounded-lg hover:bg-green-600 focus:outline-none focus:ring-4 focus:ring-green-300 transition-all duration-300 font-semibold text-lg shadow-lg hover:shadow-xl flex items-center justify-center"
              >
                Launch Observer
                <ExternalLink className="h-6 w-6 ml-3" />
              </button>
            </div>

            {/* System Check Status Area */}
            <div className="bg-gradient-to-r from-slate-50 to-slate-100 border border-slate-200 rounded-xl p-4 h-16 flex items-center justify-center mb-4">
              <StatusDisplay isChecking={isChecking} foundServers={foundServers} />
            </div>

            {/* Download Ollama Button - Only show if failed */}
            {showFailureState && (
              <div className="mb-4">
                <button
                  onClick={handleDownloadOllama}
                  className="w-full px-8 py-5 bg-blue-500 text-white rounded-xl hover:bg-blue-600 focus:outline-none focus:ring-4 focus:ring-blue-300 transition-all duration-300 font-semibold text-xl shadow-lg hover:shadow-xl flex items-center justify-center"
                >
                  <Download className="h-7 w-7 mr-3" />
                  Get Started with Ollama
                </button>

                {/* Explanatory Text */}
                <div className="mt-4 text-center">
                  <p className="text-sm text-slate-700 font-medium">
                    Ollama is a free, open-source AI server that runs locally on your computer. Observer also works with Llama.cpp, vLLM, LMStudio or any other endpoint!
                  </p>
                </div>

                {/* Alternative Option */}
                <div className="mt-4 text-center">
                  <p className="text-xs text-slate-400 mb-2"> Set your endpoint IP below.</p>
                  <button
                    onClick={runServerChecks}
                    className="text-sm text-blue-600 hover:text-blue-700 hover:underline transition group inline-flex items-center font-medium"
                  >
                    <RotateCw className="h-4 w-4 mr-1.5 transition-transform group-hover:rotate-[-90deg]" />
                    Check for Server
                  </button>
                </div>
              </div>
            )}

            {/* Server Configuration Section - Collapsible */}
            <div className="mt-4">
              <button
                onClick={() => {
                  setShowServerConfig(!showServerConfig);
                  setSaveFeedback(null);
                }}
                className="w-full text-left bg-slate-50 border border-slate-200 rounded-xl p-4 hover:bg-slate-100 transition-all duration-200 flex items-center justify-between"
              >
                <div className="flex items-center">
                  <Settings className="h-4 w-4 mr-2 text-blue-600" />
                  <span className="text-base font-semibold text-slate-800">Server Configuration</span>
                </div>
                <div className={`transform transition-transform duration-200 ${showServerConfig ? 'rotate-90' : ''}`}>
                  <ChevronRight className="h-4 w-4 text-slate-400" />
                </div>
              </button>

              {showServerConfig && (
                <div className="mt-2 bg-slate-50 border border-slate-200 rounded-xl p-4 animate-fade-in">
                  <div className="space-y-3 text-left">
                <label htmlFor="custom-url" className="block text-sm font-medium text-slate-700">
                  Custom Model Server URL
                </label>
                <div className="flex items-center space-x-2">
                  <input
                    id="custom-url"
                    type="text"
                    value={customUrlInput}
                    onChange={(e) => setCustomUrlInput(e.target.value)}
                    placeholder="e.g. http://192.168.1.50:11434"
                    className="flex-grow px-4 py-3 border border-slate-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all"
                  />
                  <button
                    onClick={handleSaveSettings}
                    className="px-5 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-all font-medium"
                  >
                    Save
                  </button>
                </div>
                {saveFeedback && (
                  <div className={`flex items-center text-sm ${saveFeedback.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                    {saveFeedback.type === 'success' ? <Check className="h-4 w-4 mr-2" /> : <AlertTriangle className="h-4 w-4 mr-2" />}
                    {saveFeedback.message}
                  </div>
                )}
                    <p className="text-xs text-slate-500 mt-1">
                      Leave empty to auto-detect Ollama (127.0.0.1:11434) or other local servers
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        {activeTab === 'controls' && (
          <div className="animate-fade-in space-y-5">
            {/* Overlay Controls Section */}
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
              <h3 className="text-base font-semibold text-slate-800 mb-3 flex items-center">
                <Eye className="h-4 w-4 mr-2 text-green-600" />
                Overlay Controls
              </h3>

              <div className="space-y-3">
                <div className="flex space-x-3">
                  <button
                    onClick={handleShowOverlay}
                    className="flex-1 px-4 py-3 bg-green-50 text-green-700 border border-green-200 rounded-lg hover:bg-green-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 transition-all duration-200 font-medium text-sm flex items-center justify-center"
                  >
                    <Eye className="h-4 w-4 mr-2" />
                    Show Overlay
                  </button>
                  <button
                    onClick={handleHideOverlay}
                    className="flex-1 px-4 py-3 bg-red-50 text-red-700 border border-red-200 rounded-lg hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-all duration-200 font-medium text-sm flex items-center justify-center"
                  >
                    <EyeOff className="h-4 w-4 mr-2" />
                    Hide Overlay
                  </button>
                </div>
                <button
                  onClick={handleClearOverlay}
                  className="w-full px-4 py-3 bg-slate-50 text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-slate-500 transition-all duration-200 font-medium text-sm flex items-center justify-center"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Clear Messages
                </button>
              </div>
            </div>
            {/* Keyboard Shortcuts Section */}
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
              <h3 className="text-base font-semibold text-slate-800 mb-3 flex items-center">
                <Keyboard className="h-4 w-4 mr-2 text-purple-600" />
                Keyboard Shortcuts
                <span className="ml-2 text-sm font-normal text-slate-500">
                  ({Object.values(overlayShortcuts).filter(s => s.trim()).length + Object.values(agentShortcuts).filter(s => s.trim()).length} configured)
                </span>
              </h3>

              <div className="space-y-4">
                {/* Current Active Shortcuts Display */}
                {activeShortcuts.length > 0 && (
                  <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                    <h4 className="text-sm font-semibold text-green-800 mb-2">Currently Active Shortcuts:</h4>
                    <div className="flex flex-wrap gap-2">
                      {activeShortcuts.map((shortcut, index) => (
                        <span key={index} className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded font-mono">
                          {shortcut}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Overlay Shortcuts Section */}
                <div>
                  <h4 className="text-sm font-semibold text-slate-800 mb-3">Overlay Controls</h4>
                <div className="grid grid-cols-1 gap-3">
                  <div className="flex items-center justify-between">
                    <label className="text-sm text-slate-700 font-medium">Toggle Overlay</label>
                    <button
                      onClick={() => setCapturingFor('overlay_toggle')}
                      disabled={capturingFor === 'overlay_toggle'}
                      className={`
                        px-3 py-2 text-xs rounded-md font-mono transition-all min-w-[120px] text-center
                        ${capturingFor === 'overlay_toggle' 
                          ? 'bg-orange-100 text-orange-700 border-2 border-orange-300 animate-pulse' 
                          : overlayShortcuts.toggle 
                          ? 'bg-green-100 text-green-700 border border-green-300 hover:bg-green-200' 
                          : 'bg-slate-100 text-slate-600 border border-slate-300 hover:bg-slate-200'
                        }
                      `}
                    >
                      {capturingFor === 'overlay_toggle' 
                        ? "Press any key..." 
                        : overlayShortcuts.toggle || "Click to set"
                      }
                    </button>
                    {overlayShortcuts.toggle && capturingFor !== 'overlay_toggle' && (
                      <button
                        onClick={() => setOverlayShortcuts(prev => ({ ...prev, toggle: '' }))}
                        className="ml-2 text-red-500 hover:text-red-700 text-xs"
                        title="Clear shortcut"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex items-center justify-between">
                      <label className="text-sm text-slate-700 font-medium">Move Up</label>
                      <button
                        onClick={() => setCapturingFor('overlay_move_up')}
                        disabled={capturingFor === 'overlay_move_up'}
                        className={`
                          px-3 py-2 text-xs rounded-md font-mono transition-all min-w-[100px] text-center
                          ${capturingFor === 'overlay_move_up' 
                            ? 'bg-orange-100 text-orange-700 border-2 border-orange-300 animate-pulse' 
                            : overlayShortcuts.move_up 
                            ? 'bg-green-100 text-green-700 border border-green-300 hover:bg-green-200' 
                            : 'bg-slate-100 text-slate-600 border border-slate-300 hover:bg-slate-200'
                          }
                        `}
                      >
                        {capturingFor === 'overlay_move_up' 
                          ? "Press..." 
                          : overlayShortcuts.move_up || "Set"
                        }
                      </button>
                      {overlayShortcuts.move_up && capturingFor !== 'overlay_move_up' && (
                        <button
                          onClick={() => setOverlayShortcuts(prev => ({ ...prev, move_up: '' }))}
                          className="ml-2 text-red-500 hover:text-red-700 text-xs"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    
                    <div className="flex items-center justify-between">
                      <label className="text-sm text-slate-700 font-medium">Move Down</label>
                      <button
                        onClick={() => setCapturingFor('overlay_move_down')}
                        disabled={capturingFor === 'overlay_move_down'}
                        className={`
                          px-3 py-2 text-xs rounded-md font-mono transition-all min-w-[100px] text-center
                          ${capturingFor === 'overlay_move_down' 
                            ? 'bg-orange-100 text-orange-700 border-2 border-orange-300 animate-pulse' 
                            : overlayShortcuts.move_down 
                            ? 'bg-green-100 text-green-700 border border-green-300 hover:bg-green-200' 
                            : 'bg-slate-100 text-slate-600 border border-slate-300 hover:bg-slate-200'
                          }
                        `}
                      >
                        {capturingFor === 'overlay_move_down' 
                          ? "Press..." 
                          : overlayShortcuts.move_down || "Set"
                        }
                      </button>
                      {overlayShortcuts.move_down && capturingFor !== 'overlay_move_down' && (
                        <button
                          onClick={() => setOverlayShortcuts(prev => ({ ...prev, move_down: '' }))}
                          className="ml-2 text-red-500 hover:text-red-700 text-xs"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex items-center justify-between">
                      <label className="text-sm text-slate-700 font-medium">Move Left</label>
                      <button
                        onClick={() => setCapturingFor('overlay_move_left')}
                        disabled={capturingFor === 'overlay_move_left'}
                        className={`
                          px-3 py-2 text-xs rounded-md font-mono transition-all min-w-[100px] text-center
                          ${capturingFor === 'overlay_move_left' 
                            ? 'bg-orange-100 text-orange-700 border-2 border-orange-300 animate-pulse' 
                            : overlayShortcuts.move_left 
                            ? 'bg-green-100 text-green-700 border border-green-300 hover:bg-green-200' 
                            : 'bg-slate-100 text-slate-600 border border-slate-300 hover:bg-slate-200'
                          }
                        `}
                      >
                        {capturingFor === 'overlay_move_left' 
                          ? "Press..." 
                          : overlayShortcuts.move_left || "Set"
                        }
                      </button>
                      {overlayShortcuts.move_left && capturingFor !== 'overlay_move_left' && (
                        <button
                          onClick={() => setOverlayShortcuts(prev => ({ ...prev, move_left: '' }))}
                          className="ml-2 text-red-500 hover:text-red-700 text-xs"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    
                    <div className="flex items-center justify-between">
                      <label className="text-sm text-slate-700 font-medium">Move Right</label>
                      <button
                        onClick={() => setCapturingFor('overlay_move_right')}
                        disabled={capturingFor === 'overlay_move_right'}
                        className={`
                          px-3 py-2 text-xs rounded-md font-mono transition-all min-w-[100px] text-center
                          ${capturingFor === 'overlay_move_right' 
                            ? 'bg-orange-100 text-orange-700 border-2 border-orange-300 animate-pulse' 
                            : overlayShortcuts.move_right 
                            ? 'bg-green-100 text-green-700 border border-green-300 hover:bg-green-200' 
                            : 'bg-slate-100 text-slate-600 border border-slate-300 hover:bg-slate-200'
                          }
                        `}
                      >
                        {capturingFor === 'overlay_move_right' 
                          ? "Press..." 
                          : overlayShortcuts.move_right || "Set"
                        }
                      </button>
                      {overlayShortcuts.move_right && capturingFor !== 'overlay_move_right' && (
                        <button
                          onClick={() => setOverlayShortcuts(prev => ({ ...prev, move_right: '' }))}
                          className="ml-2 text-red-500 hover:text-red-700 text-xs"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                  
                  {/* Resize Shortcuts */}
                  <div className="mt-4">
                    <label className="text-sm text-slate-700 font-medium mb-2 block">Resize Shortcuts</label>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex items-center justify-between">
                        <label className="text-sm text-slate-700">Resize Up</label>
                        <button
                          onClick={() => setCapturingFor('overlay_resize_up')}
                          disabled={capturingFor === 'overlay_resize_up'}
                          className={`
                            px-3 py-2 text-xs rounded-md font-mono transition-all min-w-[100px] text-center
                            ${capturingFor === 'overlay_resize_up' 
                              ? 'bg-orange-100 text-orange-700 border-2 border-orange-300 animate-pulse' 
                              : overlayShortcuts.resize_up 
                              ? 'bg-green-100 text-green-700 border border-green-300 hover:bg-green-200' 
                              : 'bg-slate-100 text-slate-600 border border-slate-300 hover:bg-slate-200'
                            }
                          `}
                        >
                          {capturingFor === 'overlay_resize_up' 
                            ? "Press..." 
                            : overlayShortcuts.resize_up || "Set"
                          }
                        </button>
                        {overlayShortcuts.resize_up && capturingFor !== 'overlay_resize_up' && (
                          <button
                            onClick={() => setOverlayShortcuts(prev => ({ ...prev, resize_up: '' }))}
                            className="ml-2 text-red-500 hover:text-red-700 text-xs"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                      
                      <div className="flex items-center justify-between">
                        <label className="text-sm text-slate-700">Resize Down</label>
                        <button
                          onClick={() => setCapturingFor('overlay_resize_down')}
                          disabled={capturingFor === 'overlay_resize_down'}
                          className={`
                            px-3 py-2 text-xs rounded-md font-mono transition-all min-w-[100px] text-center
                            ${capturingFor === 'overlay_resize_down' 
                              ? 'bg-orange-100 text-orange-700 border-2 border-orange-300 animate-pulse' 
                              : overlayShortcuts.resize_down 
                              ? 'bg-green-100 text-green-700 border border-green-300 hover:bg-green-200' 
                              : 'bg-slate-100 text-slate-600 border border-slate-300 hover:bg-slate-200'
                            }
                          `}
                        >
                          {capturingFor === 'overlay_resize_down' 
                            ? "Press..." 
                            : overlayShortcuts.resize_down || "Set"
                          }
                        </button>
                        {overlayShortcuts.resize_down && capturingFor !== 'overlay_resize_down' && (
                          <button
                            onClick={() => setOverlayShortcuts(prev => ({ ...prev, resize_down: '' }))}
                            className="ml-2 text-red-500 hover:text-red-700 text-xs"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                      
                      <div className="flex items-center justify-between">
                        <label className="text-sm text-slate-700">Resize Left</label>
                        <button
                          onClick={() => setCapturingFor('overlay_resize_left')}
                          disabled={capturingFor === 'overlay_resize_left'}
                          className={`
                            px-3 py-2 text-xs rounded-md font-mono transition-all min-w-[100px] text-center
                            ${capturingFor === 'overlay_resize_left' 
                              ? 'bg-orange-100 text-orange-700 border-2 border-orange-300 animate-pulse' 
                              : overlayShortcuts.resize_left 
                              ? 'bg-green-100 text-green-700 border border-green-300 hover:bg-green-200' 
                              : 'bg-slate-100 text-slate-600 border border-slate-300 hover:bg-slate-200'
                            }
                          `}
                        >
                          {capturingFor === 'overlay_resize_left' 
                            ? "Press..." 
                            : overlayShortcuts.resize_left || "Set"
                          }
                        </button>
                        {overlayShortcuts.resize_left && capturingFor !== 'overlay_resize_left' && (
                          <button
                            onClick={() => setOverlayShortcuts(prev => ({ ...prev, resize_left: '' }))}
                            className="ml-2 text-red-500 hover:text-red-700 text-xs"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                      
                      <div className="flex items-center justify-between">
                        <label className="text-sm text-slate-700">Resize Right</label>
                        <button
                          onClick={() => setCapturingFor('overlay_resize_right')}
                          disabled={capturingFor === 'overlay_resize_right'}
                          className={`
                            px-3 py-2 text-xs rounded-md font-mono transition-all min-w-[100px] text-center
                            ${capturingFor === 'overlay_resize_right' 
                              ? 'bg-orange-100 text-orange-700 border-2 border-orange-300 animate-pulse' 
                              : overlayShortcuts.resize_right 
                              ? 'bg-green-100 text-green-700 border border-green-300 hover:bg-green-200' 
                              : 'bg-slate-100 text-slate-600 border border-slate-300 hover:bg-slate-200'
                            }
                          `}
                        >
                          {capturingFor === 'overlay_resize_right' 
                            ? "Press..." 
                            : overlayShortcuts.resize_right || "Set"
                          }
                        </button>
                        {overlayShortcuts.resize_right && capturingFor !== 'overlay_resize_right' && (
                          <button
                            onClick={() => setOverlayShortcuts(prev => ({ ...prev, resize_right: '' }))}
                            className="ml-2 text-red-500 hover:text-red-700 text-xs"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              
                </div>

                {/* Agent Shortcuts Section */}
                <div>
                  <h4 className="text-sm font-semibold text-slate-800 mb-3">Agent Controls ({availableAgents.length} agents)</h4>
                
                {/* Add New Agent */}
                <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-md">
                  <label className="text-sm text-slate-700 font-medium block mb-2">Add New Shortcut</label>
                  <div className="flex items-center space-x-2">
                    <input
                      type="text"
                      value={newAgentId}
                      onChange={(e) => setNewAgentId(e.target.value)}
                      placeholder="Agent ID (e.g., activity-monitor, distraction-agent)"
                      className="flex-grow px-3 py-2 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                      onKeyDown={(e) => e.key === 'Enter' && handleAddAgent()}
                    />
                    <button
                      onClick={handleAddAgent}
                      className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                    >
                      Add
                    </button>
                  </div>
                </div>
                
                {availableAgents.length > 0 && (
                  <div className="grid grid-cols-1 gap-3">
                    {availableAgents.map((agent) => {
                      const shortcut = agentShortcuts[agent.id];
                      const isDuplicate = shortcut && Object.entries(agentShortcuts)
                        .filter(([id, s]) => id !== agent.id && s === shortcut).length > 0;
                      
                      return (
                        <div key={agent.id} className="flex items-center justify-between">
                          <span className="text-sm text-slate-700 font-medium flex-1">{agent.name}</span>
                          <button
                            onClick={() => setCapturingFor(agent.id)}
                            disabled={capturingFor === agent.id}
                            className={`
                              px-3 py-2 text-xs rounded-md font-mono transition-all min-w-[120px] text-center
                              ${capturingFor === agent.id 
                                ? 'bg-orange-100 text-orange-700 border-2 border-orange-300 animate-pulse' 
                                : isDuplicate
                                ? 'bg-red-100 text-red-700 border border-red-300 hover:bg-red-200'
                                : agentShortcuts[agent.id] 
                                ? 'bg-green-100 text-green-700 border border-green-300 hover:bg-green-200' 
                                : 'bg-slate-100 text-slate-600 border border-slate-300 hover:bg-slate-200'
                              }
                            `}
                          >
                            {capturingFor === agent.id 
                              ? "Press any key..." 
                              : agentShortcuts[agent.id] || "Click to set"
                            }
                            {isDuplicate && " ⚠️"}
                          </button>
                          {agentShortcuts[agent.id] && capturingFor !== agent.id && (
                            <button
                              onClick={() => {
                                // Remove agent completely from both frontend and backend
                                setAvailableAgents(prev => prev.filter(a => a.id !== agent.id));
                                setAgentShortcuts(prev => {
                                  const updated = { ...prev };
                                  delete updated[agent.id];
                                  return updated;
                                });
                                setShortcutFeedback({ message: `Agent "${agent.id}" removed`, type: 'success' });
                                setTimeout(() => setShortcutFeedback(null), 2000);
                              }}
                              className="ml-2 text-red-500 hover:text-red-700 text-xs"
                              title="Remove agent completely"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                
                {availableAgents.length === 0 && (
                  <div className="text-center py-4">
                    <p className="text-sm text-slate-500 mb-2">No agents added yet.</p>
                    <p className="text-xs text-slate-400">Add agents above to assign shortcuts to them.</p>
                  </div>
                )}
              </div>
              
                {/* Save All Button */}
                <div className="flex justify-end pt-6 border-t border-slate-200">
                  <button
                    onClick={handleSaveAllShortcuts}
                    className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 text-sm font-semibold shadow-sm transition-all"
                  >
                    Save All Shortcuts
                  </button>
                </div>
              
                {/* Feedback Messages */}
                {shortcutFeedback && (
                  <div className={`flex items-center text-sm p-3 rounded-lg ${shortcutFeedback.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                    {shortcutFeedback.type === 'success' ? <Check className="h-4 w-4 mr-2" /> : <AlertTriangle className="h-4 w-4 mr-2" />}
                    {shortcutFeedback.message}
                  </div>
                )}

                {/* Help Text */}
                <div className="text-xs text-slate-600 bg-slate-100 p-4 rounded-lg border border-slate-200">
                  <div className="space-y-2">
                    <p><strong>How it works:</strong> Click buttons to capture key combinations instantly • Press Escape to cancel</p>
                    <p><strong>Examples:</strong> Cmd+B, Alt+ArrowUp, Ctrl+Shift+X, F1, Space, etc.</p>
                    <p><strong>Tips:</strong> Use ✕ to clear shortcuts • Overlay shortcuts need app restart, agent shortcuts work immediately</p>
                    <p><strong>Windows users:</strong> Try Alt+ instead of Cmd+ if shortcuts conflict with system shortcuts</p>
                  </div>
                </div>
              </div>
            </div>
        )}

        <p className="text-xs text-gray-400 mt-4">
          <Power className="h-3 w-3 inline-block mr-1.5" />
          The background server is running. You can close this launcher.
        </p>

        {/* No Server Confirmation Dialog */}
        {showNoServerDialog && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white rounded-xl p-6 max-w-md mx-4 text-center shadow-2xl">
              <div className="mb-4">
                <div className="mx-auto w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center mb-3">
                  <AlertTriangle className="h-6 w-6 text-amber-600" />
                </div>
                <h3 className="text-lg font-semibold text-slate-800 mb-2">No Local AI Server Found</h3>
                <p className="text-sm text-slate-600">
                  You won't be able to use local models without a server like Ollama. You can still use Observer with remote API endpoints.
                </p>
              </div>
              <div className="flex space-x-3">
                <button
                  onClick={() => setShowNoServerDialog(false)}
                  className="flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-500 transition-all font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmLaunchWithoutServer}
                  className="flex-1 px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 focus:outline-none focus:ring-2 focus:ring-green-500 transition-all font-medium"
                >
                  Launch Anyway
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default LauncherShell;
