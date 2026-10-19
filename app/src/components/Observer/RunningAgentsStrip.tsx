// src/components/Observer/RunningAgentsStrip.tsx
//
// The floating side of the dock/float agent cards (see FloatingAgentsContext.tsx and
// AgentLiveCard.tsx). Renders one AgentLiveCard per agent id that's currently "floating",
// portaled to document.body and viewport-fixed so it covers the whole app window —
// including above the top bar and outside whatever size <main>/the chat panel happens to
// be — rather than being clipped to wherever this component sits in the tree.

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CompleteAgent } from '@utils/agent_database';
import { StreamManager, StreamState } from '@utils/streamManager';
import AgentLiveCard from './AgentLiveCard';
import { useFloatingAgents } from './FloatingAgentsContext';

interface RunningAgentsStripProps {
  agents: CompleteAgent[];
  runningAgents: Set<string>;
  startingAgents: Set<string>;
  onToggle: (agentId: string, isCurrentlyRunning: boolean) => void;
  onSelectAgent?: (agentId: string) => void;
}

const RunningAgentsStrip: React.FC<RunningAgentsStripProps> = ({ agents, runningAgents, startingAgents, onToggle, onSelectAgent }) => {
  const [streams, setStreams] = useState<StreamState>(StreamManager.getCurrentState());
  const { floating } = useFloatingAgents();

  useEffect(() => {
    StreamManager.addListener(setStreams);
    return () => StreamManager.removeListener(setStreams);
  }, []);

  const floatingIds = Object.keys(floating);
  if (floatingIds.length === 0) return null;

  return createPortal(
    <div className="fixed inset-0 pointer-events-none z-[9999] overflow-visible">
      {floatingIds.map(agentId => {
        const agent = agents.find(a => a.id === agentId);
        if (!agent) return null;
        return (
          <AgentLiveCard
            key={agentId}
            agent={agent}
            isRunning={runningAgents.has(agentId)}
            isStarting={startingAgents.has(agentId)}
            streams={streams}
            mode="floating"
            floatingPos={floating[agentId]}
            onToggle={onToggle}
            onSelectAgent={onSelectAgent}
          />
        );
      })}
    </div>,
    document.body
  );
};

export default RunningAgentsStrip;
