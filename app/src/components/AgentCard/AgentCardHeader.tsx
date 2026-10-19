// components/AgentCard/AgentCardHeader.tsx
import React from 'react';
import { Play, Power, Zap } from 'lucide-react';

interface AgentCardHeaderProps {
    agentId: string;
    agentName: string;
    agentDescription: string;
    isRunning: boolean;
    isStarting: boolean;
    hasQuotaError: boolean;
    isLive: boolean;
    onToggle: () => void;
}

const AgentCardHeader: React.FC<AgentCardHeaderProps> = ({ agentId, agentName, agentDescription, isRunning, isStarting, hasQuotaError, onToggle }) => {
    return (
        <div className="mb-6">
            <div className="flex justify-between items-start">
                <div className="agent-drag-handle flex-1 min-w-0 pr-4 cursor-grab active:cursor-grabbing">
                    <h3 className="text-xl font-bold text-gray-800 truncate">{agentName}</h3>
                    <p className="text-sm text-gray-600 mt-1">{agentDescription || "No description provided."}</p>
                </div>

                <button
                  onClick={onToggle}
                  data-tutorial-start-button={agentId}
                  className={`px-4 py-2 rounded-lg font-medium flex-shrink-0 flex items-center transition-colors text-sm ${
                    hasQuotaError ? 'bg-red-100 text-red-700 cursor-not-allowed'
                      : isStarting ? 'bg-yellow-100 text-yellow-700 cursor-wait'
                      : isRunning ? 'bg-red-100 text-red-700 hover:bg-red-200'
                      : 'bg-green-100 text-green-700 hover:bg-green-200'
                  }`}
                  disabled={isStarting || hasQuotaError}
                >
                  {hasQuotaError ? <><Zap className="w-4 h-4 mr-2" /> Limit</>
                      : isStarting ? 'Starting...'
                      : isRunning ? <><Power className="w-4 h-4 mr-2" /> Stop</>
                      : <><Play className="w-4 h-4 mr-2" /> Start</>}
                </button>
            </div>
        </div>
    );
};

export default AgentCardHeader;
