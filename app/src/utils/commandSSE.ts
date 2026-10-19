// src/utils/commandSSE.ts
// Elegant singleton SSE system for hotkey commands

import { isAgentLoopRunning, startAgentLoop, stopAgentLoop } from './main_loop';
import { Logger } from './logging';

export type TokenProvider = () => Promise<string | undefined>;

class CommandSSE {
  private static instance: CommandSSE;
  private eventSource: EventSource | null = null;
  private isActive = false;
  private tokenProvider: TokenProvider | undefined = undefined;
  private reconnectTimeout: number | null = null;
  private readonly serverUrl = 'http://127.0.0.1:3838';

  private constructor() {}

  static getInstance(): CommandSSE {
    if (!CommandSSE.instance) {
      CommandSSE.instance = new CommandSSE();
    }
    return CommandSSE.instance;
  }

  async start(getToken?: TokenProvider): Promise<void> {
    if (this.isActive) {
      Logger.debug('Commands', 'SSE already active, updating token only');
      this.tokenProvider = getToken;
      return;
    }

    Logger.info('Commands', 'Starting SSE command stream for hotkeys');
    this.tokenProvider = getToken;
    this.isActive = true;

    // Start SSE connection directly - no more agent registration needed
    this.connectSSE();
  }

  stop(): void {
    if (!this.isActive) return;

    Logger.info('Commands', 'Stopping SSE command stream');
    this.isActive = false;

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  updateToken(getToken?: TokenProvider): void {
    this.tokenProvider = getToken;
  }

  isRunning(): boolean {
    return this.isActive && this.eventSource !== null;
  }


  private connectSSE(): void {
    try {
      this.eventSource = new EventSource(`${this.serverUrl}/commands-stream`);

      this.eventSource.onopen = () => {
        Logger.info('Commands', 'SSE connection established');
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
        }
      };

      this.eventSource.onmessage = async (event) => {
        try {
          const commandData = JSON.parse(event.data);
          Logger.debug('Commands', 'Received SSE command:', commandData);
          
          if (commandData.type === 'command') {
            await this.handleCommand(commandData);
          }
        } catch (error) {
          Logger.error('Commands', `Failed to process SSE command: ${error}`);
        }
      };

      this.eventSource.onerror = () => {
        Logger.debug('Commands', 'SSE connection error, will reconnect in 5s');
        this.eventSource?.close();

        if (this.isActive) {
          this.reconnectTimeout = window.setTimeout(() => {
            Logger.debug('Commands', 'Attempting SSE reconnection...');
            this.connectSSE();
          }, 5000);
        }
      };

    } catch (error) {
      Logger.error('Commands', `Failed to establish SSE connection: ${error}`);
    }
  }

  private async handleCommand(commandData: any): Promise<void> {
    const { agentId, action } = commandData;

    if (action === 'toggle') {
      const isRunning = isAgentLoopRunning(agentId);
      
      if (isRunning) {
        Logger.info('Commands', `🔴 Stopping agent ${agentId} via hotkey`);
        await stopAgentLoop(agentId);
      } else {
        Logger.info('Commands', `🟢 Starting agent ${agentId} via hotkey`);
        await startAgentLoop(agentId, this.tokenProvider);
      }
    } else if (action === 'start') {
      Logger.info('Commands', `🟢 Starting agent ${agentId} via hotkey`);
      await startAgentLoop(agentId, this.tokenProvider);
    } else if (action === 'stop') {
      Logger.info('Commands', `🔴 Stopping agent ${agentId} via hotkey`);
      await stopAgentLoop(agentId);
    }
  }
}

// Elegant singleton API
const commandSSE = CommandSSE.getInstance();

export const startCommandSSE = (getToken?: TokenProvider) => commandSSE.start(getToken);
export const stopCommandSSE = () => commandSSE.stop();
export const updateCommandSSEToken = (getToken?: TokenProvider) => commandSSE.updateToken(getToken);
export const isCommandSSEActive = () => commandSSE.isRunning();
