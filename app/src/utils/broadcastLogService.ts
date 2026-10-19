// src/utils/broadcastLogService.ts
// Polls broadcast extension debug logs and pipes to the unified Logger

import { invoke } from '@tauri-apps/api/core';
import { Logger, LogLevel } from './logging';

/**
 * Service to poll broadcast extension logs and pipe them to the unified Logger
 */
class BroadcastLogServiceClass {
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private lastLogLength = 0;
  private isPolling = false;
  private pollIntervalMs = 1000; // Poll every second

  /**
   * Start polling for broadcast logs
   */
  start(intervalMs = 1000) {
    if (this.isPolling) return;

    this.pollIntervalMs = intervalMs;
    this.isPolling = true;
    this.lastLogLength = 0;

    // Initial poll
    this.poll();

    // Set up interval
    this.pollInterval = setInterval(() => this.poll(), this.pollIntervalMs);

    Logger.info('BroadcastLogService', 'Started polling broadcast logs');
  }

  /**
   * Stop polling
   */
  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.isPolling = false;
    Logger.info('BroadcastLogService', 'Stopped polling broadcast logs');
  }

  /**
   * Poll for new log entries
   */
  private async poll() {
    try {
      const logContent = await invoke<string>('plugin:screen-capture|read_broadcast_debug_log_cmd');

      // Check if there's new content
      if (logContent.length > this.lastLogLength) {
        const newContent = logContent.slice(this.lastLogLength);
        this.lastLogLength = logContent.length;

        // Parse and emit new lines
        const lines = newContent.split('\n').filter(line => line.trim());
        for (const line of lines) {
          this.parseLine(line);
        }
      }
    } catch (error) {
      // Silently ignore errors (extension might not be running)
    }
  }

  /**
   * Parse a log line and emit to Logger
   */
  private parseLine(line: string) {
    // Format: [timestamp] message
    // Example: [2026-02-27T22:07:25Z] SampleHandler init

    const match = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (!match) {
      // Non-standard format, log as-is
      Logger.debug('BROADCAST', line);
      return;
    }

    const [, timestamp, message] = match;

    // Determine log level based on message content
    let level = LogLevel.DEBUG;
    if (message.startsWith('❌')) {
      level = LogLevel.ERROR;
    } else if (message.startsWith('✅')) {
      level = LogLevel.INFO;
    } else if (message.includes('error') || message.includes('Error')) {
      level = LogLevel.ERROR;
    } else if (message.includes('warning') || message.includes('Warning')) {
      level = LogLevel.WARNING;
    }

    Logger.log(level, 'BROADCAST', message, {
      logType: 'broadcast-extension',
      timestamp: timestamp
    });
  }

  /**
   * Get the App Group path (for debugging)
   */
  async getAppGroupPath(): Promise<string | null> {
    try {
      return await invoke<string>('plugin:screen-capture|get_app_group_path_cmd');
    } catch {
      return null;
    }
  }

  /**
   * List files in App Group container (for debugging)
   */
  async listAppGroupFiles(): Promise<{ path: string; files: string[] } | null> {
    try {
      return await invoke<{ path: string; files: string[] }>('plugin:screen-capture|list_app_group_files_cmd');
    } catch {
      return null;
    }
  }

  /**
   * Read full broadcast log (for debugging)
   */
  async readFullLog(): Promise<string | null> {
    try {
      return await invoke<string>('plugin:screen-capture|read_broadcast_debug_log_cmd');
    } catch {
      return null;
    }
  }

  /**
   * Reset log position (to re-read all logs)
   */
  reset() {
    this.lastLogLength = 0;
  }
}

export const BroadcastLogService = new BroadcastLogServiceClass();
