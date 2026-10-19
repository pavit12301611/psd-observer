// src/components/AttributionSplash.tsx
//
// A single-question screen shown right after ToS acceptance (before the Pro-trial
// upsell): "Where did you hear about Observer?". Answering isn't required to
// proceed — clicking any option (or Skip) both records the answer and advances the
// flow, so it never blocks onboarding. "Other" reveals a free-text input instead of
// immediately advancing, so it needs its own submit step.

import React, { useState } from 'react';
import { Compass } from 'lucide-react';
import { Analytics } from '@utils/analytics';
import type { AttributionSource } from '@utils/analytics';

interface AttributionSplashProps {
  isOpen: boolean;
  onDone: () => void;
}

// Ordered by actual channel strength (Reddit is the biggest driver right now), not
// alphabetically — first options get the most eyeballs.
const OPTIONS: { id: AttributionSource; label: string }[] = [
  { id: 'reddit', label: 'Reddit' },
  { id: 'github', label: 'GitHub' },
  { id: 'google', label: 'Google' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'friend', label: 'A friend told me' },
];

export const AttributionSplash: React.FC<AttributionSplashProps> = ({ isOpen, onDone }) => {
  const [showOther, setShowOther] = useState(false);
  const [otherText, setOtherText] = useState('');

  React.useEffect(() => { if (isOpen) Analytics.attributionShown(); }, [isOpen]);

  if (!isOpen) return null;

  const choose = (source: AttributionSource) => {
    Analytics.attributionSelected(source);
    onDone();
  };

  const submitOther = () => {
    Analytics.attributionSelected('other', otherText.trim() || undefined);
    onDone();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[10000] backdrop-blur-sm p-2 md:p-4">
      <div className="relative bg-white rounded-2xl shadow-xl border border-gray-200 w-full max-w-lg overflow-hidden transition-all duration-300">
        <div className="flex items-center gap-3 px-6 py-5 border-b border-gray-100">
          <div className="flex items-center justify-center h-9 w-9 rounded-full bg-gray-100 flex-shrink-0">
            <Compass className="h-5 w-5 text-gray-700" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900">One quick question</h2>
            <p className="text-sm text-gray-500 mt-0.5">Where did you hear about Observer?</p>
          </div>
        </div>

        <div className="p-6">
          {!showOther ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                {OPTIONS.map(opt => (
                  <button
                    key={opt.id}
                    onClick={() => choose(opt.id)}
                    className="px-4 py-3 rounded-xl border border-gray-200 hover:bg-gray-50 hover:border-gray-300 transition-colors text-left"
                  >
                    <span className="text-sm font-medium text-gray-800">{opt.label}</span>
                  </button>
                ))}
                <button
                  onClick={() => setShowOther(true)}
                  className="px-4 py-3 rounded-xl border border-gray-200 hover:bg-gray-50 hover:border-gray-300 transition-colors text-left"
                >
                  <span className="text-sm font-medium text-gray-800">Other</span>
                </button>
              </div>

              <button
                onClick={() => choose('other')}
                className="w-full mt-4 text-sm text-gray-400 hover:text-gray-600 transition-colors"
              >
                Skip
              </button>
            </>
          ) : (
            <>
              <input
                autoFocus
                type="text"
                value={otherText}
                onChange={e => setOtherText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submitOther(); }}
                placeholder="Where did you hear about us?"
                className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500 text-sm text-gray-800"
              />
              <button
                onClick={submitOther}
                className="w-full mt-3 px-6 py-3 bg-gray-900 text-white rounded-full hover:bg-black transition-colors font-medium text-sm"
              >
                Continue
              </button>
              <button
                onClick={() => setShowOther(false)}
                className="w-full mt-2 text-sm text-gray-400 hover:text-gray-600 transition-colors"
              >
                Back
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default AttributionSplash;
