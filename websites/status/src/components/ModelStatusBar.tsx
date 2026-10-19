import React from 'react';
import { ModelStatus } from '../types';

interface ModelStatusBarProps {
  model: ModelStatus;
}

const getBarColor = (successRate: number): string => {
  if (successRate >= 100) return 'bg-success';
  if (successRate >= 50) return 'bg-warning';
  return 'bg-danger';
};

const getBarOpacity = (successRate: number): string => {
  if (successRate >= 100) return 'opacity-100';
  if (successRate >= 95) return 'opacity-90';
  if (successRate >= 90) return 'opacity-80';
  if (successRate >= 80) return 'opacity-70';
  if (successRate >= 70) return 'opacity-60';
  return 'opacity-50';
};

export const ModelStatusBar: React.FC<ModelStatusBarProps> = ({ model }) => {
  const uptimePercentage = (model.overall_success_rate ?? 0).toFixed(3);

  // Get the last hour's success rate (most recent)
  const lastHourStat = model.hourly_stats[model.hourly_stats.length - 1];
  const lastHourSuccessRate = lastHourStat.success_rate ?? 0;

  // Determine if model is down (0% overall uptime OR last hour < 20%)
  const isDown = (model.overall_success_rate ?? 0) === 0 || lastHourSuccessRate < 20;
  const dotColor = isDown ? 'bg-danger' : 'bg-success';
  const cardBg = isDown ? 'bg-danger/10 border-danger/30' : 'bg-dark-card border-dark-border';

  return (
    <div className={`${cardBg} rounded-lg p-6`}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${dotColor}`}></div>
          <h3 className="text-lg font-semibold text-white">{model.name}</h3>
        </div>
        <span className="text-sm text-gray-400">{uptimePercentage}% uptime</span>
      </div>

      {/* 24-hour status bar */}
      <div className="flex gap-[2px] h-12 items-end">
        {model.hourly_stats.map((stat) => {
          const successRate = stat.success_rate ?? 0;
          const barColor = getBarColor(successRate);
          const barOpacity = getBarOpacity(successRate);
          const height = successRate > 0 ? `${successRate}%` : '4px';

          return (
            <div
              key={stat.hour}
              className={`flex-1 ${barColor} ${barOpacity} rounded-sm transition-all hover:opacity-100 cursor-pointer`}
              style={{ height }}
              title={`${stat.hour}: ${successRate.toFixed(1)}%`}
            />
          );
        })}
      </div>

      <div className="flex justify-between mt-2 text-xs text-gray-500">
        <span>24 hours ago</span>
        <span>Now</span>
      </div>
    </div>
  );
};
