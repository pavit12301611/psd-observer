import React from 'react';
import { StatusResponse } from '../types';
import { ModelStatusBar } from './ModelStatusBar';

interface StatusGridProps {
  data: StatusResponse;
}

export const StatusGrid: React.FC<StatusGridProps> = ({ data }) => {
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  };

  const allOperational = data.models.every(model => (model.overall_success_rate ?? 0) >= 99);

  return (
    <div className="min-h-screen bg-dark-bg py-12 px-4">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-success/10 mb-4">
            <svg
              className="w-8 h-8 text-success"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
          <h1 className="text-4xl font-bold text-white mb-2">
            {allOperational ? 'All models are online' : 'Some models are experiencing issues'}
          </h1>
          <p className="text-gray-400">
            Last updated on {formatDate(data.checked_at)}
          </p>
        </div>

        {/* Observer AI Section */}
        <div className="bg-dark-card border border-dark-border rounded-lg p-6 mb-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-white">Observer AI</h2>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-success"></div>
              <span className="text-sm text-gray-400">Operational</span>
            </div>
          </div>
        </div>

        {/* Model Status Bars */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {data.models.map((model) => (
            <ModelStatusBar key={model.name} model={model} />
          ))}
        </div>

        {/* Footer */}
        <div className="text-center mt-12 text-sm text-gray-500">
          <p>Monitoring {data.models.length} models over the last {data.window_hours} hours</p>
        </div>
      </div>
    </div>
  );
};
