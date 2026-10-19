// components/ModelCard/ModelRow.tsx
//
// One shared, minimal row used for every kind of model in the unified Models list —
// installed, downloadable, remote, or cloud. Deliberately plain: an icon, a name, one
// muted meta line, an optional thin progress bar, and whatever action(s) the caller
// builds for the right side. No per-state colored cards/badges — state is expressed in
// the action control and meta text instead.

import React from 'react';

interface ModelRowProps {
  icon: React.ReactNode;
  name: string;
  tag?: string;
  meta?: React.ReactNode;
  action?: React.ReactNode;
  progressPct?: number | null;
  dimmed?: boolean;
  settingsSlot?: React.ReactNode;
  detailSlot?: React.ReactNode;
}

export const ModelRow: React.FC<ModelRowProps> = ({
  icon, name, tag, meta, action, progressPct, dimmed, settingsSlot, detailSlot,
}) => (
  <div className={dimmed ? 'opacity-50' : undefined}>
    <div className="flex items-center gap-3 py-2.5">
      <div className="w-8 h-8 rounded-lg bg-gray-100 text-gray-500 flex items-center justify-center flex-shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className="text-sm font-medium text-gray-900 truncate">{name}</span>
          {tag && <span className="text-[11px] text-gray-400 flex-shrink-0">{tag}</span>}
        </div>
        {meta && <div className="text-xs text-gray-400 mt-0.5 truncate">{meta}</div>}
        {progressPct != null && (
          <div className="w-full max-w-[220px] bg-gray-100 rounded-full h-1 mt-1.5">
            <div
              className="h-1 rounded-full bg-gray-800 transition-all duration-300"
              style={{ width: `${Math.max(0, Math.min(100, progressPct))}%` }}
            />
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">{action}</div>
    </div>
    {detailSlot}
    {settingsSlot}
  </div>
);

// ── Small shared action-button styles, so every row's buttons feel like one system ──
// (the `data-*` index signature lets onboarding tutorials tag specific buttons for a
// spotlight/click-target without every caller needing a one-off native <button>)

type RowButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { [key: `data-${string}`]: string | boolean | undefined };

export const RowButtonPrimary: React.FC<RowButtonProps> = ({ className = '', ...props }) => (
  <button
    {...props}
    className={`px-2.5 py-1 text-xs font-medium bg-gray-900 text-white rounded-md hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${className}`}
  />
);

export const RowButtonGhost: React.FC<RowButtonProps> = ({ className = '', ...props }) => (
  <button
    {...props}
    className={`px-2.5 py-1 text-xs font-medium text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-md disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${className}`}
  />
);

export const RowIconButton: React.FC<RowButtonProps> = ({ className = '', ...props }) => (
  <button
    {...props}
    className={`p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-md disabled:opacity-30 disabled:cursor-not-allowed transition-colors ${className}`}
  />
);
