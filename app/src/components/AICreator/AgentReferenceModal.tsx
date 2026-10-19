import React from 'react';
import { X, XCircle, Brain, Code, Database, Clock, CheckCircle, Image } from 'lucide-react';
import { AgentReferenceData } from '@utils/agentParser';

interface AgentReferenceModalProps {
  isOpen: boolean;
  onClose: () => void;
  agentData: AgentReferenceData | null;
}

const AgentReferenceModal: React.FC<AgentReferenceModalProps> = ({ isOpen, onClose, agentData }) => {
  if (!isOpen || !agentData) return null;

  const { agent, code, memory, recentRuns, reference } = agentData;

  // Collect all images from recent runs
  const allImages: string[] = [];
  recentRuns.forEach(run => {
    // Add model images (base64 images sent to model)
    if (run.modelImages) {
      allImages.push(...run.modelImages);
    }

    // Add screenshot and camera sensor images
    run.sensors.forEach(sensor => {
      if ((sensor.type === 'screenshot' || sensor.type === 'camera') && sensor.content) {
        // Handle both base64 and raw image data
        if (typeof sensor.content === 'string') {
          allImages.push(sensor.content);
        } else if (sensor.content.data) {
          allImages.push(sensor.content.data);
        }
      }
    });
  });

  // Remove duplicates and limit to most recent 20 images
  const uniqueImages = Array.from(new Set(allImages)).slice(-20);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden">
        <div className="flex justify-between items-center p-6 border-b border-gray-200">
          <div className="flex items-center">
            <span className="text-purple-600 font-mono text-lg">@{reference.agentId}</span>
            {agent && <h2 className="ml-3 text-xl font-semibold text-gray-800">{agent.name}</h2>}
          </div>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-gray-100">
            <X className="h-6 w-6 text-gray-500" />
          </button>
        </div>

        <div className="overflow-y-auto max-h-[calc(90vh-120px)]">
          {!agent ? (
            <div className="p-6 text-center">
              <XCircle className="h-16 w-16 text-red-500 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-red-800 mb-2">Agent Not Found</h3>
              <p className="text-red-600">The agent @{reference.agentId} doesn't exist in the database.</p>
            </div>
          ) : (
            <div className="p-6 space-y-6">
              {/* Agent Info */}
              <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
                <div className="flex items-center mb-3">
                  <Brain className="h-5 w-5 text-purple-600 mr-2" />
                  <h3 className="font-semibold text-purple-800">Agent Configuration</h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="font-medium text-gray-600">Model:</span>
                    <span className="ml-2 text-gray-800">{agent.model_name}</span>
                  </div>
                  <div>
                    <span className="font-medium text-gray-600">Loop Interval:</span>
                    <span className="ml-2 text-gray-800">{agent.loop_interval_seconds}s</span>
                  </div>
                </div>
                <div className="mt-3">
                  <span className="font-medium text-gray-600">Description:</span>
                  <p className="mt-1 text-gray-800">{agent.description}</p>
                </div>
              </div>

              {/* System Prompt */}
              <div className="border border-gray-200 rounded-lg p-4">
                <div className="flex items-center mb-3">
                  <Code className="h-5 w-5 text-blue-600 mr-2" />
                  <h3 className="font-semibold text-gray-800">System Prompt</h3>
                </div>
                <div className="bg-gray-50 border rounded p-3 max-h-40 overflow-y-auto">
                  <pre className="text-sm text-gray-700 whitespace-pre-wrap font-mono">
                    {agent.system_prompt}
                  </pre>
                </div>
              </div>

              {/* Code */}
              {code && (
                <div className="border border-gray-200 rounded-lg p-4">
                  <div className="flex items-center mb-3">
                    <Code className="h-5 w-5 text-green-600 mr-2" />
                    <h3 className="font-semibold text-gray-800">Agent Code</h3>
                  </div>
                  <div className="bg-gray-50 border rounded p-3 max-h-40 overflow-y-auto">
                    <pre className="text-sm text-gray-700 whitespace-pre-wrap font-mono">
                      {code}
                    </pre>
                  </div>
                </div>
              )}

              {/* Memory */}
              {memory.trim() && (
                <div className="border border-gray-200 rounded-lg p-4">
                  <div className="flex items-center mb-3">
                    <Database className="h-5 w-5 text-indigo-600 mr-2" />
                    <h3 className="font-semibold text-gray-800">Memory</h3>
                  </div>
                  <div className="bg-gray-50 border rounded p-3 max-h-32 overflow-y-auto">
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">{memory}</p>
                  </div>
                </div>
              )}

              {/* Recent Runs */}
              {recentRuns.length > 0 && (
                <div className="border border-gray-200 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center">
                      <Clock className="h-5 w-5 text-orange-600 mr-2" />
                      <h3 className="font-semibold text-gray-800">Recent Performance</h3>
                    </div>
                    <span className="text-sm text-gray-600">
                      {recentRuns.filter(run => !run.hasError).length}/{recentRuns.length} successful
                    </span>
                  </div>

                  <div className="space-y-3">
                    {recentRuns.slice(-5).reverse().map((run, _) => (
                      <div key={run.id} className={`border rounded-lg p-3 ${
                        run.hasError ? 'border-red-200 bg-red-50' : 'border-green-200 bg-green-50'
                      }`}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center">
                            {run.hasError ? (
                              <XCircle className="h-4 w-4 text-red-500 mr-2" />
                            ) : (
                              <CheckCircle className="h-4 w-4 text-green-500 mr-2" />
                            )}
                            <span className="text-sm font-medium">
                              {new Date(run.startTime).toLocaleString()}
                            </span>
                          </div>
                          {run.duration && (
                            <span className="text-xs text-gray-600">{run.duration.toFixed(1)}s</span>
                          )}
                        </div>

                        {run.modelPrompt && (
                          <div className="mb-2">
                            <span className="text-xs font-medium text-gray-600">Input:</span>
                            <p className="text-xs text-gray-700 mt-1">
                              {run.modelPrompt.substring(0, 150)}
                              {run.modelPrompt.length > 150 ? '...' : ''}
                            </p>
                          </div>
                        )}

                        {run.modelResponse && (
                          <div className="mb-2">
                            <span className="text-xs font-medium text-gray-600">Output:</span>
                            <p className="text-xs text-gray-700 mt-1">
                              {run.modelResponse.substring(0, 150)}
                              {run.modelResponse.length > 150 ? '...' : ''}
                            </p>
                          </div>
                        )}

                        {run.tools.length > 0 && (
                          <div>
                            <span className="text-xs font-medium text-gray-600">Tools:</span>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {run.tools.map((tool, j) => (
                                <span key={j} className={`px-2 py-1 rounded text-xs ${
                                  tool.status === 'success' ? 'bg-green-200 text-green-800' : 'bg-red-200 text-red-800'
                                }`}>
                                  {tool.name}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Images Preview */}
              {uniqueImages.length > 0 && (
                <div className="border border-gray-200 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center">
                      <Image className="h-5 w-5 text-pink-600 mr-2" />
                      <h3 className="font-semibold text-gray-800">Recent Images</h3>
                    </div>
                    <span className="text-sm text-gray-600">
                      {uniqueImages.length} image{uniqueImages.length !== 1 ? 's' : ''}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 max-h-64 overflow-y-auto">
                    {uniqueImages.map((imageData, index) => {
                      // Ensure image has proper data URL format
                      const imageSrc = imageData.startsWith('data:') ? imageData : `data:image/png;base64,${imageData}`;

                      return (
                        <img
                          key={index}
                          src={imageSrc}
                          alt={`Agent capture ${index + 1}`}
                          className="w-full h-20 object-cover rounded border border-gray-200"
                          onError={(e) => {
                            // Hide broken images
                            (e.target as HTMLElement).style.display = 'none';
                          }}
                        />
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AgentReferenceModal;