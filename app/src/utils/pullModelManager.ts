// src/utils/pullModelManager.ts

import { Logger } from './logging';
import { platformFetch } from './platform';

type PullStatus = 'idle' | 'pulling' | 'success' | 'error';

// This is the state that the manager will hold.
export interface PullState {
  status: PullStatus;
  modelName: string;
  statusText: string;
  errorText: string;
  progress: number;
  completedBytes: number;
  totalBytes: number;
}

// Simple event emitter (Publisher/Subscriber)
type Listener = (state: PullState) => void;
const listeners: Listener[] = [];
let abortController: AbortController | null = null;

let state: PullState = {
  status: 'idle',
  modelName: '',
  statusText: '',
  errorText: '',
  progress: 0,
  completedBytes: 0,
  totalBytes: 0,
};

// Notifies all subscribed components about a state change.
const broadcast = () => {
  listeners.forEach(listener => listener(state));
};

const setState = (newState: Partial<PullState>) => {
  state = { ...state, ...newState };
  broadcast();
};

const resetState = () => {
    setState({
        status: 'idle',
        modelName: '',
        statusText: '',
        errorText: '',
        progress: 0,
        completedBytes: 0,
        totalBytes: 0,
    });
}

const pullModel = async (modelName: string, serverAddress: string) => {
  if (state.status === 'pulling') {
    Logger.warn('PULL_MANAGER', 'A pull is already in progress.');
    return;
  }

  abortController = new AbortController();
  setState({
    status: 'pulling',
    modelName,
    statusText: 'Preparing to download...',
    progress: 0,
    completedBytes: 0,
    totalBytes: 0,
    errorText: ''
  });

  Logger.info('PULL_MANAGER', `Starting pull for model: ${modelName} from ${serverAddress}`);

  try {
    const response = await platformFetch(`${serverAddress}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName, stream: true }),
      signal: abortController.signal,
    });

    if (!response.body) throw new Error('Response body is empty.');
    if (response.status !== 200) {
      const errorData = await response.json();
      throw new Error(errorData.error || `Server responded with status ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        setState({ statusText: 'Verifying checksum...' });
        break;
      }

      const chunk = decoder.decode(value);
      const jsonLines = chunk.split('\n').filter(line => line.trim() !== '');

      jsonLines.forEach(line => {
        try {
          const data = JSON.parse(line);
          const newState: Partial<PullState> = { statusText: data.status };
          if (data.total && data.completed) {
            newState.progress = Math.round((data.completed / data.total) * 100);
            newState.completedBytes = data.completed;
            newState.totalBytes = data.total;
          }
          setState(newState);
          if (data.error) throw new Error(data.error);
        } catch(e) {
          Logger.warn('PULL_MANAGER', 'Could not parse streaming JSON line, skipping.', line);
        }
      });
    }

    setState({ status: 'success', progress: 100, statusText: `Successfully pulled ${modelName}!` });
    Logger.info('PULL_MANAGER', `Successfully pulled model: ${modelName}`);

  } catch (err: any) {
    if (err.name === 'AbortError') {
      Logger.warn('PULL_MANAGER', 'Model pull was cancelled by the user.');
      resetState(); // Reset completely on cancel
    } else {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
      Logger.error('PULL_MANAGER', `Failed to pull model: ${errorMessage}`);
      setState({ status: 'error', errorText: errorMessage });
    }
  }
};

const cancelPull = () => {
  if (state.status === 'pulling') {
    abortController?.abort();
  }
};

const subscribe = (listener: Listener): (() => void) => {
  listeners.push(listener);
  return () => { // Return an unsubscribe function
    const index = listeners.indexOf(listener);
    if (index > -1) {
      listeners.splice(index, 1);
    }
  };
};

const getInitialState = (): PullState => {
  return state;
};

// This is the public API of our manager
const pullModelManager = {
  pullModel,
  cancelPull,
  subscribe,
  getInitialState,
  resetState, // Expose reset for the "Done" button
};

export default pullModelManager;
