import React, { useEffect, useState } from 'react';
import { X, Check, Server, Terminal, ExternalLink } from 'lucide-react';
import { getJupyterConfig, setJupyterConfig, testJupyterConnection as testConnection } from '@utils/handlers/JupyterConfig';
import { Logger } from '@utils/logging';
import Modal from '@components/EditAgent/Modal'

interface JupyterServerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const JupyterServerModal: React.FC<JupyterServerModalProps> = ({ isOpen, onClose }) => {
  const [jupyterHost, setJupyterHost] = useState<string>('127.0.0.1');
  const [jupyterPort, setJupyterPort] = useState<string>('8888');
  const [jupyterToken, setJupyterToken] = useState<string>('');
  const [jupyterStatus, setJupyterStatus] = useState<'unknown' | 'checking' | 'connected' | 'error'>('unknown');
  const [testOutput, setTestOutput] = useState<string>('');
  const [showTutorial, setShowTutorial] = useState<boolean>(false);

  // Load current config when modal opens
  useEffect(() => {
    if (isOpen) {
      const config = getJupyterConfig();
      setJupyterHost(config.host);
      setJupyterPort(config.port);
      setJupyterToken(config.token);
      setJupyterStatus('unknown');
      setTestOutput('');
    }
  }, [isOpen]);

  // Save Jupyter Config with auto-testing
  const handleSave = async () => {
    try {
      // Test connection before saving
      setJupyterStatus('checking');
      setTestOutput('Testing connection...');
      
      const result = await testConnection({
        host: jupyterHost,
        port: jupyterPort,
        token: jupyterToken
      });
      
      setJupyterStatus(result.success ? 'connected' : 'error');
      setTestOutput(result.message);
      
      // Save configuration if connection successful or user confirms
      if (result.success) {
        setJupyterConfig(jupyterHost, jupyterPort, jupyterToken);
        Logger.info('CONFIG', 'Jupyter configuration saved');
        onClose();
      } else {
        // Still save if user confirms despite connection failure
        setJupyterConfig(jupyterHost, jupyterPort, jupyterToken);
        Logger.info('CONFIG', 'Jupyter configuration saved despite connection error');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error('CONFIG', `Error saving Jupyter config: ${errorMessage}`);
      setTestOutput(prev => prev + `\nError saving configuration: ${errorMessage}`);
    }
  };

  const testJupyterConnection = async () => {
    setJupyterStatus('checking');
    setTestOutput('Testing connection...');
    
    const result = await testConnection({
      host: jupyterHost,
      port: jupyterPort,
      token: jupyterToken
    });
    
    setJupyterStatus(result.success ? 'connected' : 'error');
    setTestOutput(result.message);
  };

  if (!isOpen) return null;

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      className={`flex transition-all duration-300 ${
        showTutorial ? 'w-full max-w-4xl' : 'w-full max-w-lg'
      }`}
    >
        {/* Main Configuration Panel */}
        <div className="flex-1">
          <div className="flex items-center justify-between px-6 py-4 border-b">
            <h2 className="text-xl font-semibold text-gray-800 flex items-center">
              <Server className="mr-2 text-blue-600" size={20} />
              Jupyter Server Configuration
            </h2>
            <div className="flex items-center space-x-3">
              <button
                onClick={() => setShowTutorial(!showTutorial)}
                className="p-2 rounded-md text-blue-600 hover:text-blue-800 hover:bg-blue-50 text-sm font-medium"
              >
                {showTutorial ? "Hide" : "Show"} Tutorial
              </button>
              <button
                onClick={onClose}
                className="p-2 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100"
              >
                <X size={20} />
              </button>
            </div>
          </div>

          <div className="p-6 space-y-4">
            <p className="text-sm text-gray-600 mb-4">
              Configure your Jupyter server connection for Python code execution. These settings will be saved in your browser.
            </p>
            
            <div className="space-y-4">
              <div className="flex flex-col">
                <label className="block text-sm font-medium text-gray-700 mb-1">Host</label>
                <input
                  type="text"
                  value={jupyterHost}
                  onChange={(e) => setJupyterHost(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="127.0.0.1"
                />
              </div>
              
              <div className="flex flex-col">
                <label className="block text-sm font-medium text-gray-700 mb-1">Port</label>
                <input
                  type="text"
                  value={jupyterPort}
                  onChange={(e) => setJupyterPort(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="8888"
                />
              </div>
              
              <div className="flex flex-col">
                <label className="block text-sm font-medium text-gray-700 mb-1">Token</label>
                <input
                  type="password"
                  value={jupyterToken}
                  onChange={(e) => setJupyterToken(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Enter Jupyter token"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Find your token in Jupyter's terminal output when starting the server.
                </p>
              </div>
            </div>

            {testOutput && (
              <div className={`mt-4 p-3 rounded text-sm font-mono ${
                jupyterStatus === 'connected' ? 'bg-green-50 text-green-800' : 
                jupyterStatus === 'error' ? 'bg-red-50 text-red-800' :
                'bg-gray-50 text-gray-800'
              }`}>
                {testOutput}
              </div>
            )}
          </div>

          <div className="bg-gray-50 px-6 py-4 flex justify-between rounded-b-lg">
            {jupyterStatus === 'connected' && (
              <div className="flex items-center text-sm text-green-600">
                <Check size={16} className="mr-1" />
                Connected
              </div>
            )}
            {jupyterStatus === 'error' && (
              <div className="flex items-center text-sm text-red-600">
                <X size={16} className="mr-1" />
                Connection Error
              </div>
            )}
            {jupyterStatus !== 'connected' && jupyterStatus !== 'error' && <div></div>}
            
            <div className="flex space-x-3">
              <button
                onClick={testJupyterConnection}
                disabled={jupyterStatus === 'checking'}
                className={`px-4 py-2 rounded-md text-sm font-medium ${
                  jupyterStatus === 'checking'
                    ? 'bg-gray-300 text-gray-600 cursor-not-allowed'
                    : 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                }`}
              >
                {jupyterStatus === 'checking' ? (
                  <span className="flex items-center">
                    <div className="w-3 h-3 mr-2 border-2 border-blue-700 border-t-transparent rounded-full animate-spin"></div>
                    Testing...
                  </span>
                ) : 'Test Connection'}
              </button>
              
              <button
                onClick={handleSave}
                className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700"
              >
                Save Configuration
              </button>
            </div>
          </div>
        </div>
        
        {/* Tutorial Panel */}
        {showTutorial && (
          <div className="w-80 border-l bg-gray-50">
            <div className="p-4 border-b bg-gray-100">
              <h3 className="text-lg font-semibold text-gray-800 flex items-center">
                <Terminal className="mr-2 text-blue-600" size={18} />
                Jupyter Server Setup Guide
              </h3>
            </div>
            
            <div className="p-4 overflow-auto max-h-[500px]">
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded-full bg-blue-100 text-blue-500 flex items-center justify-center flex-shrink-0 text-xs">
                      1
                    </div>
                    <h3 className="font-medium text-gray-900 text-sm">Install Jupyter Server</h3>
                  </div>
                  <div className="ml-7 bg-gray-100 p-1.5 rounded-md font-mono text-xs text-gray-700">
                    pip install jupyter-server
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded-full bg-blue-100 text-blue-500 flex items-center justify-center flex-shrink-0 text-xs">
                      2
                    </div>
                    <h3 className="font-medium text-gray-900 text-sm">Start Jupyter Server</h3>
                  </div>
                  <div className="ml-7 bg-gray-100 p-1.5 rounded-md font-mono text-xs text-gray-700">
                    jupyter server
                  </div>
                  <p className="text-xs text-gray-600 ml-7 mt-1">
                    This will start the Jupyter server and display a token in the terminal output.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded-full bg-blue-100 text-blue-500 flex items-center justify-center flex-shrink-0 text-xs">
                      3
                    </div>
                    <h3 className="font-medium text-gray-900 text-sm">Find Your Token</h3>
                  </div>
                  <p className="text-xs text-gray-600 ml-7">
                    Look for a URL in terminal output like:
                  </p>
                  <div className="ml-7 bg-gray-100 p-1.5 rounded-md font-mono text-xs text-gray-700 break-all">
                    http://localhost:8888/?token=<span className="text-blue-600">abcd1234...</span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded-full bg-blue-100 text-blue-500 flex items-center justify-center flex-shrink-0 text-xs">
                      4
                    </div>
                    <h3 className="font-medium text-gray-900 text-sm">Enter Configuration</h3>
                  </div>
                  <div className="ml-7 space-y-1">
                    <p className="text-xs text-gray-600">
                      • Host: 127.0.0.1 (or localhost)
                    </p>
                    <p className="text-xs text-gray-600">
                      • Port: 8888 (default port)
                    </p>
                    <p className="text-xs text-gray-600">
                      • Token: Copy from URL in step 3
                    </p>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded-full bg-blue-100 text-blue-500 flex items-center justify-center flex-shrink-0 text-xs">
                      5
                    </div>
                    <h3 className="font-medium text-gray-900 text-sm">Test Connection</h3>
                  </div>
                  <p className="text-xs text-gray-600 ml-7">
                    Click "Test Connection" to verify your setup.
                  </p>
                </div>

                <div className="pt-2 border-t mt-4">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium text-gray-900 text-sm">Advanced Setup</h3>
                  </div>
                  <a 
                    href="https://jupyter-server.readthedocs.io/en/latest/operators/public-server.html" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="ml-0 text-xs text-blue-600 hover:text-blue-800 hover:underline flex items-center mt-1"
                  >
                    Read Jupyter Server documentation
                    <ExternalLink className="h-3 w-3 ml-1" />
                  </a>
                </div>

                <div className="pt-2">
                  <div className="p-3 bg-blue-50 text-blue-700 rounded-lg text-xs">
                    <p className="font-medium">Security Tips:</p>
                    <ul className="list-disc ml-5 mt-1 space-y-0.5">
                      <li>Set a strong token or password</li>
                      <li>Limit access to localhost unless remote access needed</li>
                      <li>Configure SSL for secure connections</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>
            
            <div className="p-4 border-t">
              <button
                onClick={() => setShowTutorial(false)}
                className="w-full px-3 py-2 bg-gray-200 text-gray-800 rounded-lg hover:bg-gray-300 transition-colors flex items-center justify-center gap-1 font-medium text-sm"
              >
                Close Tutorial
              </button>
            </div>
          </div>
        )}
   </Modal>
  );
};

export default JupyterServerModal;
