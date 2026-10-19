// src/utils/feedbackReporter.ts

import { getAgent, getAgentCode } from './agent_database';
import { IterationStore, IterationData } from './IterationStore';
import yaml from 'js-yaml';

interface FeedbackDetails {
  sentiment: 'like' | 'dislike';
  comment: string;
}

interface ReportOptions {
  agentId: string;
  includeAgentConfig: boolean;
  includeLogs: boolean;
  latestIteration?: IterationData; // Pass the latest iteration data directly
}

/**
 * Generates a complete feedback report in Markdown format.
 * @param options - The options for gathering data.
 * @param feedback - The user's sentiment and comment.
 * @returns A promise that resolves to a Markdown string.
 */
export async function generateFeedbackReportMarkdown(
  options: ReportOptions,
  feedback: FeedbackDetails
): Promise<string> {
  const { agentId, includeAgentConfig, includeLogs, latestIteration } = options;
  const { sentiment, comment } = feedback;

  const reportParts: string[] = [];

  // --- Header ---
  reportParts.push('# Observer AI: Feedback Report');
  reportParts.push(`- **Sentiment:** ${sentiment === 'like' ? '👍 Like' : '👎 Dislike'}`);
  reportParts.push(`- **Agent ID:** \`${agentId}\``);
  reportParts.push(`- **Timestamp:** ${new Date().toUTCString()}`);
  reportParts.push('---');

  // --- User Comment ---
  if (comment.trim()) {
    reportParts.push('## User Comment');
    reportParts.push(`> ${comment.replace(/\n/g, '\n> ')}`); // Format as blockquote
    reportParts.push('---');
  }

  // --- Agent Configuration ---
  if (includeAgentConfig) {
    reportParts.push('## Agent Configuration');
    try {
      const agent = await getAgent(agentId);
      const code = await getAgentCode(agentId);
      if (agent && code !== null) {
        const exportData = {
          id: agent.id,
          name: agent.name,
          description: agent.description,
          model_name: agent.model_name,
          system_prompt: agent.system_prompt,
          loop_interval_seconds: agent.loop_interval_seconds,
          code,
        };
        const agentConfigYaml = yaml.dump(exportData);
        reportParts.push('```yaml');
        reportParts.push(agentConfigYaml);
        reportParts.push('```');
      } else {
        reportParts.push('Could not retrieve agent configuration.');
      }
    } catch (error) {
      console.error("Error gathering agent config for feedback:", error);
      reportParts.push('Error: Could not retrieve agent configuration.');
    }
    reportParts.push('---');
  }

  // --- Latest Run Data ---
  if (includeLogs) {
    reportParts.push('## Latest Run Data');
    try {
      // Use the passed iteration data if available, otherwise get latest from store
      const iteration = latestIteration || IterationStore.getIterationsForAgent(agentId).slice(-1)[0];
      
      if (iteration) {
        reportParts.push(`**Session:** ${iteration.sessionId}`);
        reportParts.push(`**Iteration:** ${iteration.sessionIterationNumber}`);
        reportParts.push(`**Start Time:** ${new Date(iteration.startTime).toLocaleString()}`);
        reportParts.push(`**Duration:** ${iteration.duration ? `${iteration.duration}s` : 'N/A'}`);
        reportParts.push(`**Has Error:** ${iteration.hasError ? 'Yes' : 'No'}`);
        reportParts.push('');

        // Include sensor data summary
        if (iteration.sensors.length > 0) {
          reportParts.push('### Sensors Used');
          const sensorTypes = iteration.sensors.map(s => s.type).join(', ');
          reportParts.push(`- **Types:** ${sensorTypes}`);
          reportParts.push('');
        }

        // Include model prompt and response
        if (iteration.modelPrompt) {
          reportParts.push('### Model Prompt');
          reportParts.push('```');
          reportParts.push(iteration.modelPrompt);
          reportParts.push('```');
          reportParts.push('');
        }

        if (iteration.modelResponse) {
          reportParts.push('### Model Response');
          reportParts.push('```');
          reportParts.push(iteration.modelResponse);
          reportParts.push('```');
          reportParts.push('');
        }

        // Include tool calls
        if (iteration.tools.length > 0) {
          reportParts.push('### Tool Calls');
          iteration.tools.forEach((tool, index) => {
            reportParts.push(`**${index + 1}. ${tool.name}** (${tool.status})`);
            if (tool.error) {
              reportParts.push(`- Error: ${tool.error}`);
            }
            if (tool.params) {
              reportParts.push(`- Params: ${JSON.stringify(tool.params, null, 2)}`);
            }
          });
        }
      } else {
        reportParts.push('No recent run data found for this agent.');
      }
    } catch (error) {
      console.error("Error gathering iteration data for feedback:", error);
      reportParts.push('Error: Could not retrieve latest run data.');
    }
  }

  return reportParts.join('\n\n');
}
