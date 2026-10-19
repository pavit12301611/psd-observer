// src/utils/agent-output.ts
import { Logger } from './logging';
import * as utilities from './handlers/utils';

// Map to store output processors
const processors = new Map<string, Function>();

/**
 * Register an output processor for an agent
 * 
 * @param agentId ID of the agent
 * @param processor Function that processes the complete output
 */
export function registerProcessor(agentId: string, processor: Function): void {
  processors.set(agentId, processor);
  Logger.info(agentId, `Registered output processor`);
}

/**
 * Process agent output text using the registered processor
 * 
 * @param agentId ID of the agent
 * @param text Complete output text from the model
 * @returns True if processing resulted in an action
 */
export async function processOutput(agentId: string, text: string): Promise<boolean> {
  // Get the processor (or use a default logger if none exists)
  const processor = processors.get(agentId) || ((response: string) => {
    Logger.info(agentId, `Agent output: ${response.length > 100 ? 
      response.substring(0, 100) + '...' : response}`);
    return false;
  });
  
  // Filter out content inside <think>...</think> tags if needed
  //if (excludeThink) {
  //  filteredText = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  //  Logger.debug(agentId, `Filtered out <think> blocks from agent output`);
  //}

  try {
    // Process the entire response at once
    const result = await processor(text, utilities, agentId);
    return !!result; // Convert to boolean
  } catch (error) {
    Logger.error(agentId, `Error processing response: ${error}`);
    return false;
  }
}

/**
 * Clear the processor for an agent
 * 
 * @param agentId ID of the agent
 */
export function clearProcessor(agentId: string): void {
  processors.delete(agentId);
  Logger.info(agentId, `Cleared output processor`);
}
