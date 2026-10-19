// src/utils/handlers/JupyterConfig.ts
import { Logger } from '../logging';
import { platformFetch } from '../platform';

// Default values
let jupyterHost = '127.0.0.1';
let jupyterPort = '8888';
let jupyterToken = '';
let jupyterConnected = false;
const STORAGE_KEY = 'jupyter_config';

// Load from localStorage on init
try {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    const config = JSON.parse(stored);
    jupyterHost = config.host || jupyterHost;
    jupyterPort = config.port || jupyterPort;
    jupyterToken = config.token || jupyterToken;
    Logger.debug('CONFIG', 'Loaded Jupyter config from storage');
  }
} catch (error) {
  Logger.error('CONFIG', 'Error loading config:', error);
}

export function setJupyterConfig(host: string, port: string, token: string) {
  if (host) jupyterHost = host;
  if (port) jupyterPort = port;
  if (token) jupyterToken = token;
  
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      host: jupyterHost,
      port: jupyterPort,
      token: jupyterToken
    }));
  } catch (error) {
    Logger.error('CONFIG', 'Error saving config:', error);
  }
}

export function getJupyterConfig() {
  return {
    host: jupyterHost,
    port: jupyterPort, 
    token: jupyterToken
  };
}

export function isJupyterConnected(): boolean {
  return jupyterConnected;
}

export async function testJupyterConnection(configOverride?: {
  host?: string, 
  port?: string, 
  token?: string
}): Promise<{success: boolean, message: string}> {
  const config = configOverride 
    ? {...getJupyterConfig(), ...configOverride} 
    : getJupyterConfig();
    
  try {
    const url = `http://${config.host}:${config.port}/api/kernels`;
    
    const response = await platformFetch(url, {
      headers: {
        'Authorization': `token ${config.token}`
      }
    });
    
    // Update the connection state
    jupyterConnected = response.ok;
    
    if (response.ok) {
      Logger.info('CONFIG', `Successfully connected to Jupyter server`);
      return { success: true, message: `✅ Connected to Jupyter server` };
    } else {
      Logger.warn('CONFIG', `Jupyter connection failed: ${response.status}`);
      return { success: false, message: `❌ Connection failed: ${response.status}` };
    }
  } catch (error) {
    jupyterConnected = false;
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, message: `❌ Connection error: ${errorMessage}` };
  }
}
