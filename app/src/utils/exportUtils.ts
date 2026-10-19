// src/utils/exportUtils.ts
import { IterationData, SensorData, ToolCall, AgentSession } from './IterationStore';

export type ExportFormat = 'json' | 'html' | 'markdown';

export interface ExportOptions {
  format: ExportFormat;
  includeImages: boolean;
  agentId: string;
  sessionType: 'current' | 'historical' | 'all';
  sessionId?: string;
}

export interface ExportData {
  agentId: string;
  exportDate: string;
  sessionType: string;
  currentSession?: IterationData[];
  historicalSessions?: AgentSession[];
  totalIterations: number;
}

// Format sensor content for display
const formatSensorContent = (sensor: SensorData, includeImages: boolean): string => {
  if (sensor.type === 'screenshot' || sensor.type === 'camera') {
    if (includeImages && sensor.content) {
      return `[Image data - ${sensor.size || 'unknown'} bytes]`;
    }
    return `[${sensor.type} - ${sensor.size || 'unknown'} bytes]`;
  }
  
  if (sensor.type === 'audio') {
    const transcript = sensor.content?.transcript || '';
    const source = sensor.source ? ` (${sensor.source})` : '';
    return `${transcript}${source}`;
  }
  
  if (typeof sensor.content === 'string') {
    return sensor.content;
  }
  
  return JSON.stringify(sensor.content, null, 2);
};

// Export as JSON
export const exportAsJSON = (data: ExportData, options: ExportOptions): string => {
  const exportObject = {
    ...data,
    exportOptions: {
      format: options.format,
      includeImages: options.includeImages,
      exportTimestamp: new Date().toISOString()
    }
  };

  // If images are excluded, strip base64 data but keep metadata
  if (!options.includeImages) {
    const processIterations = (iterations: IterationData[]) => {
      return iterations.map(iteration => ({
        ...iteration,
        modelImages: iteration.modelImages?.map(() => '[Image data excluded]'),
        sensors: iteration.sensors.map(sensor => ({
          ...sensor,
          content: (sensor.type === 'screenshot' || sensor.type === 'camera') 
            ? { size: sensor.content?.size, excluded: true }
            : sensor.content
        }))
      }));
    };

    if (exportObject.currentSession) {
      exportObject.currentSession = processIterations(exportObject.currentSession);
    }
    
    if (exportObject.historicalSessions) {
      exportObject.historicalSessions = exportObject.historicalSessions.map(session => ({
        ...session,
        iterations: processIterations(session.iterations)
      }));
    }
  }

  return JSON.stringify(exportObject, null, 2);
};

// Export as HTML
export const exportAsHTML = (data: ExportData, options: ExportOptions): string => {
  const formatTimestamp = (timestamp: string) => {
    return new Date(timestamp).toLocaleString();
  };

  const renderSensorHTML = (sensor: SensorData): string => {
    const content = formatSensorContent(sensor, options.includeImages);
    const timestamp = formatTimestamp(sensor.timestamp);
    
    let sensorIcon = '';
    switch (sensor.type) {
      case 'screenshot': sensorIcon = '📷'; break;
      case 'camera': sensorIcon = '🎥'; break;
      case 'ocr': sensorIcon = '📄'; break;
      case 'audio': sensorIcon = '🎵'; break;
      case 'clipboard': sensorIcon = '📋'; break;
      case 'memory': sensorIcon = '🧠'; break;
      default: sensorIcon = '📊';
    }

    return `
      <div class="sensor-item">
        <div class="sensor-header">
          <span class="sensor-icon">${sensorIcon}</span>
          <strong>${sensor.type}</strong>
          <span class="timestamp">${timestamp}</span>
        </div>
        <div class="sensor-content">${content}</div>
      </div>
    `;
  };

  const renderToolHTML = (tool: ToolCall): string => {
    const timestamp = formatTimestamp(tool.timestamp);
    const status = tool.status === 'success' ? '✅' : '❌';
    
    return `
      <div class="tool-item ${tool.status}">
        <div class="tool-header">
          <span class="tool-status">${status}</span>
          <strong>${tool.name}</strong>
          <span class="timestamp">${timestamp}</span>
        </div>
        ${tool.error ? `<div class="tool-error">Error: ${tool.error}</div>` : ''}
        ${tool.params ? `<div class="tool-params">Params: ${JSON.stringify(tool.params, null, 2)}</div>` : ''}
      </div>
    `;
  };

  const renderIterationHTML = (iteration: IterationData): string => {
    const startTime = formatTimestamp(iteration.startTime);
    const duration = iteration.duration ? `${iteration.duration.toFixed(2)}s` : 'N/A';
    
    return `
      <div class="iteration ${iteration.hasError ? 'error' : ''}">
        <div class="iteration-header">
          <h3>Iteration #${iteration.sessionIterationNumber}</h3>
          <div class="iteration-meta">
            <span>Start: ${startTime}</span>
            <span>Duration: ${duration}</span>
            ${iteration.hasError ? '<span class="error-indicator">❌ Error</span>' : ''}
          </div>
        </div>
        
        <div class="iteration-content">
          <div class="section">
            <h4>📥 Inputs (${iteration.sensors.length} sensors)</h4>
            <div class="sensors">
              ${iteration.sensors.map(renderSensorHTML).join('')}
            </div>
          </div>
          
          ${iteration.modelPrompt ? `
            <div class="section">
              <h4>💭 Model Prompt</h4>
              <pre class="prompt">${iteration.modelPrompt}</pre>
            </div>
          ` : ''}
          
          ${iteration.modelImages?.length ? `
            <div class="section">
              <h4>🖼️ Images Sent to Model (${iteration.modelImages.length})</h4>
              ${options.includeImages ? 
                iteration.modelImages.map((img, i) => 
                  `<img src="data:image/png;base64,${img}" alt="Image ${i+1}" style="max-width: 300px; margin: 10px 0;" />`
                ).join('') :
                '<p>Images excluded from export</p>'
              }
            </div>
          ` : ''}
          
          ${iteration.modelResponse ? `
            <div class="section">
              <h4>🤖 Model Response</h4>
              <div class="response">${iteration.modelResponse}</div>
            </div>
          ` : ''}
          
          <div class="section">
            <h4>🔧 Tools (${iteration.tools.length})</h4>
            <div class="tools">
              ${iteration.tools.map(renderToolHTML).join('')}
            </div>
          </div>
        </div>
      </div>
    `;
  };

  const currentSessionHTML = data.currentSession ? `
    <section class="current-session">
      <h2>🟢 Current Session (${data.currentSession.length} iterations)</h2>
      ${data.currentSession.map(renderIterationHTML).join('')}
    </section>
  ` : '';

  const historicalSessionsHTML = data.historicalSessions?.map((session, index) => {
    const sessionDate = formatTimestamp(session.startTime);
    const relativeLabel = index === 0 ? 'Last session' : 
                         index === 1 ? 'Two sessions ago' : 
                         index === 2 ? 'Three sessions ago' : 
                         `${index + 1} sessions ago`;
    
    return `
      <section class="historical-session">
        <h2>📁 ${relativeLabel} - ${sessionDate} (${session.iterations.length} iterations)</h2>
        ${session.iterations.map(renderIterationHTML).join('')}
      </section>
    `;
  }).join('') || '';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Observer AI Export - Agent ${data.agentId}</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; margin: 0; padding: 20px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .header { border-bottom: 2px solid #e0e0e0; padding-bottom: 20px; margin-bottom: 30px; }
        .header h1 { margin: 0; color: #333; }
        .meta { color: #666; margin-top: 10px; }
        .section { margin: 20px 0; }
        .section h4 { margin: 15px 0 10px 0; color: #555; border-left: 4px solid #007acc; padding-left: 10px; }
        .iteration { border: 1px solid #ddd; border-radius: 8px; margin: 20px 0; padding: 20px; background: #fafafa; }
        .iteration.error { border-color: #ff6b6b; background: #fff5f5; }
        .iteration-header { border-bottom: 1px solid #eee; padding-bottom: 10px; margin-bottom: 15px; }
        .iteration-header h3 { margin: 0; color: #333; }
        .iteration-meta { color: #666; font-size: 0.9em; margin-top: 5px; }
        .iteration-meta span { margin-right: 15px; }
        .error-indicator { color: #ff6b6b; font-weight: bold; }
        .sensor-item, .tool-item { border: 1px solid #e0e0e0; border-radius: 6px; padding: 15px; margin: 10px 0; background: white; }
        .sensor-header, .tool-header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
        .sensor-icon, .tool-status { font-size: 1.2em; }
        .timestamp { color: #888; font-size: 0.8em; margin-left: auto; }
        .sensor-content, .response { background: #f8f8f8; padding: 10px; border-radius: 4px; white-space: pre-wrap; }
        .prompt { background: #f0f0f0; padding: 15px; border-radius: 4px; white-space: pre-wrap; overflow-x: auto; }
        .tool-item.success { border-color: #51cf66; }
        .tool-item.error { border-color: #ff6b6b; }
        .tool-error { color: #c92a2a; margin-top: 8px; }
        .tool-params { background: #f8f8f8; padding: 8px; border-radius: 4px; margin-top: 8px; font-family: monospace; font-size: 0.9em; }
        .current-session h2 { color: #51cf66; }
        .historical-session h2 { color: #868e96; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 Observer AI Export</h1>
            <div class="meta">
                <strong>Agent ID:</strong> ${data.agentId}<br>
                <strong>Export Date:</strong> ${formatTimestamp(data.exportDate)}<br>
                <strong>Session Type:</strong> ${data.sessionType}<br>
                <strong>Total Iterations:</strong> ${data.totalIterations}<br>
                <strong>Images Included:</strong> ${options.includeImages ? 'Yes' : 'No'}
            </div>
        </div>
        
        ${currentSessionHTML}
        ${historicalSessionsHTML}
    </div>
</body>
</html>
  `;
};

// Export as Markdown
export const exportAsMarkdown = (data: ExportData, options: ExportOptions): string => {
  const formatTimestamp = (timestamp: string) => {
    return new Date(timestamp).toLocaleString();
  };

  const renderSensorMarkdown = (sensor: SensorData): string => {
    const content = formatSensorContent(sensor, options.includeImages);
    const timestamp = formatTimestamp(sensor.timestamp);
    
    return `
**${sensor.type.toUpperCase()}** _(${timestamp})_
${sensor.source ? `Source: ${sensor.source}` : ''}
\`\`\`
${content}
\`\`\`
`;
  };

  const renderToolMarkdown = (tool: ToolCall): string => {
    const timestamp = formatTimestamp(tool.timestamp);
    const status = tool.status === 'success' ? '✅' : '❌';
    
    let result = `
**${status} ${tool.name}** _(${timestamp})_
`;
    
    if (tool.error) {
      result += `\n❌ **Error:** ${tool.error}\n`;
    }
    
    if (tool.params) {
      result += `\n**Parameters:**\n\`\`\`json\n${JSON.stringify(tool.params, null, 2)}\n\`\`\`\n`;
    }
    
    return result;
  };

  const renderIterationMarkdown = (iteration: IterationData): string => {
    const startTime = formatTimestamp(iteration.startTime);
    const duration = iteration.duration ? `${iteration.duration.toFixed(2)}s` : 'N/A';
    const errorIndicator = iteration.hasError ? ' ❌' : '';
    
    let result = `
## Iteration #${iteration.sessionIterationNumber}${errorIndicator}

**Start Time:** ${startTime}  
**Duration:** ${duration}  
**Session ID:** ${iteration.sessionId}

### 📥 Inputs (${iteration.sensors.length} sensors)

${iteration.sensors.map(renderSensorMarkdown).join('\n')}

`;

    if (iteration.modelPrompt) {
      result += `
### 💭 Model Prompt

\`\`\`
${iteration.modelPrompt}
\`\`\`

`;
    }

    if (iteration.modelImages?.length) {
      result += `
### 🖼️ Images Sent to Model (${iteration.modelImages.length})

${options.includeImages ? 
  iteration.modelImages.map((img, i) => 
    `![Image ${i+1}](data:image/png;base64,${img})`
  ).join('\n\n') :
  '_Images excluded from export_'
}

`;
    }

    if (iteration.modelResponse) {
      result += `
### 🤖 Model Response

\`\`\`
${iteration.modelResponse}
\`\`\`

`;
    }

    result += `
### 🔧 Tools (${iteration.tools.length})

${iteration.tools.length > 0 ? 
  iteration.tools.map(renderToolMarkdown).join('\n') : 
  '_No tools used_'
}

---

`;

    return result;
  };

  let markdown = `# 🤖 Observer AI Export

**Agent ID:** ${data.agentId}  
**Export Date:** ${formatTimestamp(data.exportDate)}  
**Session Type:** ${data.sessionType}  
**Total Iterations:** ${data.totalIterations}  
**Images Included:** ${options.includeImages ? 'Yes' : 'No'}

`;

  if (data.currentSession) {
    markdown += `
# 🟢 Current Session (${data.currentSession.length} iterations)

${data.currentSession.map(renderIterationMarkdown).join('')}
`;
  }

  if (data.historicalSessions) {
    data.historicalSessions.forEach((session, index) => {
      const sessionDate = formatTimestamp(session.startTime);
      const relativeLabel = index === 0 ? 'Last session' : 
                           index === 1 ? 'Two sessions ago' : 
                           index === 2 ? 'Three sessions ago' : 
                           `${index + 1} sessions ago`;
      
      markdown += `
# 📁 ${relativeLabel} - ${sessionDate} (${session.iterations.length} iterations)

${session.iterations.map(renderIterationMarkdown).join('')}
`;
    });
  }

  return markdown;
};

// Main export function
export const exportData = async (
  currentIterations: IterationData[],
  historicalSessions: AgentSession[],
  options: ExportOptions
): Promise<void> => {
  let exportData: ExportData;
  let filename: string;
  
  // Prepare data based on session type
  switch (options.sessionType) {
    case 'current':
      exportData = {
        agentId: options.agentId,
        exportDate: new Date().toISOString(),
        sessionType: 'current',
        currentSession: currentIterations,
        totalIterations: currentIterations.length
      };
      filename = `observer-${options.agentId}-current-${new Date().toISOString().split('T')[0]}`;
      break;
      
    case 'historical':
      const selectedSession = historicalSessions.find(s => s.sessionId === options.sessionId);
      if (!selectedSession) {
        throw new Error('Selected historical session not found');
      }
      exportData = {
        agentId: options.agentId,
        exportDate: new Date().toISOString(),
        sessionType: 'historical',
        historicalSessions: [selectedSession],
        totalIterations: selectedSession.iterations.length
      };
      filename = `observer-${options.agentId}-session-${selectedSession.sessionId.slice(-8)}-${new Date().toISOString().split('T')[0]}`;
      break;
      
    case 'all':
    default:
      exportData = {
        agentId: options.agentId,
        exportDate: new Date().toISOString(),
        sessionType: 'all',
        currentSession: currentIterations.length > 0 ? currentIterations : undefined,
        historicalSessions: historicalSessions.length > 0 ? historicalSessions : undefined,
        totalIterations: currentIterations.length + historicalSessions.reduce((sum, s) => sum + s.iterations.length, 0)
      };
      filename = `observer-${options.agentId}-all-${new Date().toISOString().split('T')[0]}`;
      break;
  }

  // Generate content based on format
  let content: string;
  let mimeType: string;
  let extension: string;

  switch (options.format) {
    case 'json':
      content = exportAsJSON(exportData, options);
      mimeType = 'application/json';
      extension = 'json';
      break;
    case 'html':
      content = exportAsHTML(exportData, options);
      mimeType = 'text/html';
      extension = 'html';
      break;
    case 'markdown':
      content = exportAsMarkdown(exportData, options);
      mimeType = 'text/markdown';
      extension = 'md';
      break;
    default:
      throw new Error(`Unsupported format: ${options.format}`);
  }

  // Download file
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}.${extension}`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};