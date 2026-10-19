// src/components/AgentImportHandler.tsx

import { PlusCircle, RotateCw } from 'lucide-react';

interface AgentImportHandlerProps {
  onAddAgent: () => void;
  agentCount: number;
  activeAgentCount: number;
  isRefreshing: boolean;
  onRefresh: () => void;
}

const AgentImportHandler = ({
  onAddAgent,
  agentCount,
  activeAgentCount,
  isRefreshing,
  onRefresh
}: AgentImportHandlerProps) => {

  return (
    <>
      {agentCount > 0 && (
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center space-x-2">
            <button onClick={onRefresh} className="p-2 rounded-md hover:bg-gray-100" disabled={isRefreshing} title="Refresh agents">
              <RotateCw className={`h-5 w-5 ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
            <p className="text-sm font-medium">
              <span className="hidden md:inline">Active: </span>
              {activeAgentCount} / <span className="hidden md:inline">Total: </span>{agentCount}
            </p>
          </div>
          
          <div className="flex items-center space-x-2 md:space-x-3">
            <button
              onClick={onAddAgent}
              data-tutorial-grid-create
              className="flex items-center space-x-2 px-3 md:px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600"
            >
              <PlusCircle className="h-5 w-5" />
              <span className="hidden md:inline">Create Agent</span>
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default AgentImportHandler;
