// src/utils/IterationStore.ts

import { LogEntry, Logger } from './logging';

export interface SensorData {
  type: 'screenshot' | 'camera' | 'ocr' | 'audio' | 'clipboard' | 'memory' | 'imemory';
  content: any;
  timestamp: string;
  size?: number; // For images
  source?: string; // For audio (microphone, screenAudio, allAudio) or imemory (sourceAgent)
  imageCount?: number; // For imemory sensor
}

export interface ToolCall {
  name: string;
  status: 'success' | 'error';
  params?: any;
  error?: string;
  timestamp: string;
}

export interface IterationData {
  id: string;
  agentId: string;
  sessionId: string;
  sessionIterationNumber: number; // 1, 2, 3... within this session
  startTime: string;
  sensors: SensorData[];
  modelPrompt?: string;
  modelImages?: string[]; // Base64 images sent to model
  modelResponse?: string;
  modelResponseTime?: string;
  tools: ToolCall[];
  duration?: number;
  hasError: boolean;
  isSkipped?: boolean; // True if iteration was skipped
  skipReason?: 'same_inputs' | 'network_error'; // Why the iteration was skipped
}

export interface AgentSession {
  sessionId: string;
  agentId: string;
  startTime: string;
  endTime?: string;
  iterations: IterationData[];
}

class IterationStoreClass {
  private iterations = new Map<string, IterationData>();
  private currentSessions = new Map<string, string>(); // agentId -> sessionId
  private sessionIterationCounts = new Map<string, number>(); // sessionId -> count

  constructor() {
    // Subscribe to all log entries
    Logger.addListener(this.handleLogEntry.bind(this));
    // Load persisted data on startup
    this.loadFromIndexedDB();
  }

  private handleLogEntry(log: LogEntry) {
    const iterationId = log.details?.iterationId;
    if (!iterationId) return;

    // Get or create iteration
    let iteration = this.iterations.get(iterationId);
    if (!iteration) {
      const agentId = log.source;
      const sessionId = this.currentSessions.get(agentId);
      
      if (!sessionId) {
        // Silently skip - iterations will be processed once session loads from IndexedDB
        return;
      }

      // Get session iteration number
      const currentCount = this.sessionIterationCounts.get(sessionId) || 0;
      const sessionIterationNumber = currentCount + 1;
      this.sessionIterationCounts.set(sessionId, sessionIterationNumber);

      iteration = {
        id: iterationId,
        agentId,
        sessionId,
        sessionIterationNumber,
        startTime: log.timestamp.toISOString(),
        sensors: [],
        tools: [],
        hasError: false
      };
      this.iterations.set(iterationId, iteration);
    }

    // At this point, iteration is guaranteed to exist
    const currentIteration = iteration;

    // Process different log types
    const logType = log.details?.logType;
    
    if (logType?.startsWith('sensor-')) {
      this.processSensorLog(currentIteration, log);
    } else if (logType === 'model-prompt') {
      if (typeof log.details?.content === 'object') {
        currentIteration.modelPrompt = log.details.content.modifiedPrompt;
        currentIteration.modelImages = log.details.content.images || [];
      } else {
        currentIteration.modelPrompt = log.details?.content;
        currentIteration.modelImages = [];
      }
    } else if (logType === 'model-response') {
      currentIteration.modelResponse = typeof log.details?.content === 'string'
        ? log.details.content
        : '';
      currentIteration.modelResponseTime = log.timestamp.toISOString();
      this.calculateDuration(currentIteration);
    } else if (logType === 'iteration-skipped') {
      currentIteration.isSkipped = true;
      const skipReason = log.details?.content?.reason;
      if (skipReason === 'network_error') {
        currentIteration.skipReason = 'network_error';
        currentIteration.modelResponse = `Network error - iteration skipped: ${log.details?.content?.error || 'Connection failed'}`;
      } else {
        currentIteration.skipReason = 'same_inputs';
        currentIteration.modelResponse = 'No significant change detected - iteration skipped to save resources.';
      }
      this.calculateDuration(currentIteration);
    } else if (logType === 'tool-success' || logType === 'tool-error') {
      this.processToolLog(currentIteration, log);
    }

    // Update error status
    if (logType === 'tool-error') {
      currentIteration.hasError = true;
    }
  }

  private processSensorLog(iteration: IterationData, log: LogEntry) {
    const logType = log.details?.logType;
    const content = log.details?.content;

    let sensorData: SensorData | null = null;

    switch (logType) {
      case 'sensor-screenshot':
        sensorData = {
          type: 'screenshot',
          content: content,
          timestamp: log.timestamp.toISOString(),
          size: content?.size
        };
        break;
      
      case 'sensor-camera':
        sensorData = {
          type: 'camera',
          content: content,
          timestamp: log.timestamp.toISOString(),
          size: content?.size
        };
        break;
      
      case 'sensor-ocr':
        sensorData = {
          type: 'ocr',
          content: content,
          timestamp: log.timestamp.toISOString()
        };
        break;
      
      case 'sensor-audio':
        sensorData = {
          type: 'audio',
          content: content,
          timestamp: log.timestamp.toISOString(),
          source: content?.source
        };
        break;
      
      case 'sensor-clipboard':
        sensorData = {
          type: 'clipboard',
          content: content,
          timestamp: log.timestamp.toISOString()
        };
        break;
      
      case 'sensor-memory':
        sensorData = {
          type: 'memory',
          content: content,
          timestamp: log.timestamp.toISOString()
        };
        break;
      
      case 'sensor-imemory':
        sensorData = {
          type: 'imemory',
          content: content,
          timestamp: log.timestamp.toISOString(),
          source: content?.sourceAgent,
          imageCount: content?.imageCount
        };
        break;
    }

    if (sensorData) {
      iteration.sensors.push(sensorData);
    }
  }

  private processToolLog(iteration: IterationData, log: LogEntry) {
    const isSuccess = log.details?.logType === 'tool-success';
    const content = log.details?.content;

    const toolCall: ToolCall = {
      name: content?.tool || 'unknown',
      status: isSuccess ? 'success' : 'error',
      timestamp: log.timestamp.toISOString()
    };

    if (isSuccess) {
      toolCall.params = content?.params;
    } else {
      toolCall.error = content?.error;
      toolCall.params = content?.params; // Also save params for failed tools
    }

    iteration.tools.push(toolCall);
  }

  private calculateDuration(iteration: IterationData) {
    if (iteration.modelResponseTime) {
      const startTime = new Date(iteration.startTime).getTime();
      const endTime = new Date(iteration.modelResponseTime).getTime();
      iteration.duration = (endTime - startTime) / 1000; // in seconds
    }
  }

  // IndexedDB setup
  private async openIterationDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('IterationStoreDB', 1);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      
      request.onupgradeneeded = () => {
        const db = request.result;
        
        // Store for current sessions tracking
        if (!db.objectStoreNames.contains('currentSessions')) {
          db.createObjectStore('currentSessions', { keyPath: 'agentId' });
        }
        
        // Store for agent session history
        if (!db.objectStoreNames.contains('agentSessions')) {
          db.createObjectStore('agentSessions', { keyPath: 'key' }); // key will be agentId
        }
      };
    });
  }

  private async loadFromIndexedDB() {
    try {
      const db = await this.openIterationDB();
      
      // Load current sessions
      const tx = db.transaction('currentSessions', 'readonly');
      const store = tx.objectStore('currentSessions');
      const request = store.getAll();
      
      await new Promise<void>((resolve, reject) => {
        request.onsuccess = () => {
          const sessions = request.result;
          sessions.forEach((item: { agentId: string, sessionId: string }) => {
            this.currentSessions.set(item.agentId, item.sessionId);
          });
          resolve();
        };
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      Logger.error('IterationStore', 'Failed to load from IndexedDB', error);
    }
  }

  private async saveToIndexedDB() {
    try {
      const db = await this.openIterationDB();
      const tx = db.transaction('currentSessions', 'readwrite');
      const store = tx.objectStore('currentSessions');
      
      // Clear and rebuild current sessions
      await new Promise<void>((resolve, reject) => {
        const clearRequest = store.clear();
        clearRequest.onsuccess = () => resolve();
        clearRequest.onerror = () => reject(clearRequest.error);
      });
      
      // Add all current sessions
      for (const [agentId, sessionId] of this.currentSessions.entries()) {
        await new Promise<void>((resolve, reject) => {
          const request = store.add({ agentId, sessionId });
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      }
    } catch (error) {
      Logger.error('IterationStore', 'Failed to save to IndexedDB', error);
    }
  }

  private async saveSessionToIndexedDB(agentId: string, sessionId: string) {
    try {
      const db = await this.openIterationDB();
      
      // Get existing agent data or create new
      const tx = db.transaction('agentSessions', 'readwrite');
      const store = tx.objectStore('agentSessions');
      
      let agentData: { key: string, currentSession: string, sessions: Record<string, AgentSession> } = {
        key: agentId,
        currentSession: sessionId,
        sessions: {}
      };

      // Try to get existing data
      const existingRequest = store.get(agentId);
      await new Promise<void>((resolve, reject) => {
        existingRequest.onsuccess = () => {
          if (existingRequest.result) {
            agentData = existingRequest.result;
          }
          resolve();
        };
        existingRequest.onerror = () => reject(existingRequest.error);
      });

      // Get all iterations for this session
      const sessionIterations = this.getIterationsForSession(sessionId);
      
      agentData.currentSession = sessionId;
      agentData.sessions[sessionId] = {
        sessionId,
        agentId,
        startTime: sessionIterations.length > 0 ? sessionIterations[0].startTime : new Date().toISOString(),
        iterations: sessionIterations
      };

      // Save updated data
      await new Promise<void>((resolve, reject) => {
        const request = store.put(agentData);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      
    } catch (error) {
      Logger.error('IterationStore', `Failed to save session ${sessionId} for agent ${agentId}`, error);
    }
  }

  // Public API
  public startSession(agentId: string, sessionId: string) {
    this.currentSessions.set(agentId, sessionId);
    this.sessionIterationCounts.set(sessionId, 0);
    this.saveToIndexedDB();
    Logger.info('IterationStore', `Started session ${sessionId} for agent ${agentId}`);
  }

  public async endSession(agentId: string): Promise<void> {
    const sessionId = this.currentSessions.get(agentId);
    if (sessionId) {
      // Save current session to persistent storage
      await this.saveSessionToIndexedDB(agentId, sessionId);
      
      // Clean up current session data
      this.currentSessions.delete(agentId);
      this.sessionIterationCounts.delete(sessionId);
      
      // Remove iterations from memory (they're now persisted)
      const iterationsToRemove = Array.from(this.iterations.values())
        .filter(iteration => iteration.sessionId === sessionId);
      
      iterationsToRemove.forEach(iteration => {
        this.iterations.delete(iteration.id);
      });
      
      await this.saveToIndexedDB();

      Logger.info('IterationStore', `Ended session ${sessionId} for agent ${agentId}`);
    }
  }

  public getIterationsForAgent(agentId: string): IterationData[] {
    // Only return current session iterations (from memory)
    const currentSessionId = this.currentSessions.get(agentId);
    if (!currentSessionId) return [];

    return Array.from(this.iterations.values())
      .filter(iteration => iteration.agentId === agentId && iteration.sessionId === currentSessionId)
      .sort((a, b) => a.sessionIterationNumber - b.sessionIterationNumber);
  }

  public getLastToolsForAgent(agentId: string, limit: number = 3): ToolCall[] {
    const iterations = this.getIterationsForAgent(agentId);
    const allTools: ToolCall[] = [];

    // Collect all tools from all iterations, most recent first
    for (let i = iterations.length - 1; i >= 0; i--) {
      const iteration = iterations[i];
      // Add tools in reverse order (most recent first within the iteration)
      for (let j = iteration.tools.length - 1; j >= 0; j--) {
        allTools.push(iteration.tools[j]);
        if (allTools.length >= limit) {
          return allTools;
        }
      }
    }

    return allTools;
  }

  public getToolsFromLastIteration(agentId: string): ToolCall[] {
    const iterations = this.getIterationsForAgent(agentId);
    if (iterations.length === 0) return [];

    // Get the most recent iteration
    const lastIteration = iterations[iterations.length - 1];
    return [...lastIteration.tools]; // Return copy of tools array
  }

  public getIteration(iterationId: string): IterationData | undefined {
    return this.iterations.get(iterationId);
  }

  public getIterationsForSession(sessionId: string): IterationData[] {
    return Array.from(this.iterations.values())
      .filter(iteration => iteration.sessionId === sessionId)
      .sort((a, b) => a.sessionIterationNumber - b.sessionIterationNumber);
  }

  public getAllIterations(): IterationData[] {
    return Array.from(this.iterations.values())
      .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  }

  public async getHistoricalSessions(agentId: string): Promise<AgentSession[]> {
    try {
      const db = await this.openIterationDB();
      const tx = db.transaction('agentSessions', 'readonly');
      const store = tx.objectStore('agentSessions');
      const request = store.get(agentId);
      
      return new Promise((resolve, reject) => {
        request.onsuccess = () => {
          const result = request.result;
          if (!result) {
            resolve([]);
            return;
          }
          
          const sessions = (Object.values(result.sessions || {}) as AgentSession[]).sort((a: AgentSession, b: AgentSession) => 
            new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
          );
          resolve(sessions);
        };
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      Logger.error('IterationStore', `Failed to get historical sessions for agent ${agentId}`, error);
      return [];
    }
  }

  public async clearAllHistory(agentId: string): Promise<void> {
    try {
      // Clear current session data
      const sessionId = this.currentSessions.get(agentId);
      if (sessionId) {
        // Remove all iterations for this session from memory
        const iterationsToRemove = Array.from(this.iterations.values())
          .filter(iteration => iteration.sessionId === sessionId);

        iterationsToRemove.forEach(iteration => {
          this.iterations.delete(iteration.id);
        });

        // Reset session iteration count
        this.sessionIterationCounts.set(sessionId, 0);
      }

      // Clear from IndexedDB
      const db = await this.openIterationDB();
      const tx = db.transaction('agentSessions', 'readwrite');
      const store = tx.objectStore('agentSessions');

      await new Promise<void>((resolve, reject) => {
        const request = store.delete(agentId);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      Logger.info('IterationStore', `Cleared all history for agent ${agentId}`);
    } catch (error) {
      Logger.error('IterationStore', `Failed to clear all history for agent ${agentId}`, error);
    }
  }

  public async getStorageUsage(agentId: string): Promise<{ currentSessionMB: number, totalHistoryMB: number }> {
    // Calculate current session size
    const currentIterations = this.getIterationsForAgent(agentId);
    let currentSessionBytes = 0;

    currentIterations.forEach(iteration => {
      // Estimate size of iteration data
      currentSessionBytes += this.estimateIterationSize(iteration);
    });

    // Calculate historical data size from IndexedDB
    let totalHistoryBytes = currentSessionBytes;
    try {
      const historicalSessions = await this.getHistoricalSessions(agentId);
      historicalSessions.forEach(session => {
        session.iterations.forEach(iteration => {
          totalHistoryBytes += this.estimateIterationSize(iteration);
        });
      });
    } catch (error) {
      Logger.error('IterationStore', `Failed to calculate historical storage for agent ${agentId}`, error);
    }

    return {
      currentSessionMB: Number((currentSessionBytes / (1024 * 1024)).toFixed(2)),
      totalHistoryMB: Number((totalHistoryBytes / (1024 * 1024)).toFixed(2))
    };
  }

  private estimateIterationSize(iteration: IterationData): number {
    let size = 0;

    // Base iteration data (rough estimate)
    size += JSON.stringify({
      id: iteration.id,
      agentId: iteration.agentId,
      sessionId: iteration.sessionId,
      startTime: iteration.startTime,
      modelPrompt: iteration.modelPrompt,
      modelResponse: iteration.modelResponse,
      tools: iteration.tools
    }).length;

    // Sensor data (images are the big ones)
    iteration.sensors.forEach(sensor => {
      if (sensor.type === 'screenshot' || sensor.type === 'camera') {
        // Estimate base64 image size - typical screenshot might be 100-500KB
        size += sensor.size || 300000; // Default 300KB if size not available
      } else {
        // Other sensor types are much smaller
        size += JSON.stringify(sensor.content || '').length;
      }
    });

    // Model images
    if (iteration.modelImages) {
      iteration.modelImages.forEach(image => {
        // Base64 images
        size += image.length * 0.75; // Base64 is ~33% larger than binary
      });
    }

    return size;
  }

  // Debug method
  public debug() {
    console.log('IterationStore Debug:', {
      totalIterations: this.iterations.size,
      currentSessions: Array.from(this.currentSessions.entries()),
      sessionCounts: Array.from(this.sessionIterationCounts.entries()),
      iterations: Array.from(this.iterations.values())
    });
  }
}

// Export singleton instance
export const IterationStore = new IterationStoreClass();