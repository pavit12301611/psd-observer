// src/components/WelcomeModal.tsx

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@contexts/AuthContext';
import { useApplePayments } from '@hooks/useApplePayments';
import { X as CloseIcon, Loader2, Sparkles, Zap, Heart, Star } from 'lucide-react';
import { Logger } from '@utils/logging';
import { Analytics } from '@utils/analytics';
import { isIOS, isWeb, openExternal } from '../utils/platform';
import { CreditInfoButton } from './CreditVisualization';

interface WelcomeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onViewAllTiers: () => void;
  mode: 'local' | 'upsell';
  onContinueLocal?: () => void; // local mode only: called when user confirms they know what they're doing
  /** Upsell framing: 'onboarding' (right after ToS), 'activation' (celebratory, after first agent starts),
   *  or 'tutorial' (the first-run demo's notification landed: same free-trial pitch as onboarding). */
  variant?: 'onboarding' | 'activation' | 'tutorial';
  /** Pro/Max users skip the free-trial table; the 'tutorial' variant shows a "continue exploring" pitch instead. */
  isProUser?: boolean;
}

export const WelcomeModal: React.FC<WelcomeModalProps> = ({ isOpen, onClose, mode, variant = 'onboarding', isProUser = false }) => {
  const upsellSource = variant === 'activation' ? 'activation' : 'welcome';
  const [error, setError] = useState<string | null>(null);
  const [isButtonLoading, setIsButtonLoading] = useState(false);

  const { getAccessToken, login } = useAuth();
  const {
    isLoading: isAppleLoading,
    error: appleError,
    purchaseProduct,
  } = useApplePayments();

  const isAppleDevice = isIOS();
  const isMobileWeb = isWeb();

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setError(null);
    }
  }, [isOpen]);

  const handleProCheckout = async () => {
    setIsButtonLoading(true);
    setError(null);
    try {
      const token = await getAccessToken();
      const response = await fetch('https://api.observer-ai.com/payments/create-checkout-session', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ return_base_url: window.location.origin }),
      });
      if (!response.ok) throw new Error('Failed to create checkout session');
      const { url } = await response.json();
      window.location.href = url;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(`Action failed: ${errorMessage}. Please try again later.`);
    } finally {
      setIsButtonLoading(false);
    }
  };

  // Apple In-App Purchase handler for Pro - just purchase and navigate
  // Verification is handled by UpgradeSuccessPage
  const handleApplePurchasePro = useCallback(async () => {
    setIsButtonLoading(true);
    setError(null);

    try {
      const purchaseResult = await purchaseProduct('pro');
      if (purchaseResult.success) {
        Logger.info('WELCOME', 'StoreKit purchase succeeded, navigating to /upgrade-success');
        window.location.href = '/upgrade-success';
      } else {
        setError(purchaseResult.error || 'Purchase failed');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Purchase failed';
      setError(message);
    } finally {
      setIsButtonLoading(false);
    }
  }, [purchaseProduct]);

  const handleStarGithub = () => {
    openExternal('https://github.com/Roy3838/Observer');
  };

  const handleClose = () => {
    onClose();
  };

  const handleSignIn = () => {
    Analytics.localModeSignIn();
    onClose();
    login();
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex flex-col items-center justify-center z-[10000] backdrop-blur-sm p-2 md:p-4"
      onClick={mode === 'upsell' ? handleClose : undefined}
    >
      <div
        className="relative bg-white rounded-2xl shadow-xl border border-gray-200 w-full max-w-3xl max-h-[85vh] md:max-h-[90vh] overflow-y-auto transition-all duration-300 flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {mode === 'upsell' && (
          <button onClick={handleClose} className="absolute top-3 right-3 md:top-4 md:right-4 text-gray-400 hover:text-gray-700 z-10 transition-colors">
            <CloseIcon className="h-5 w-5 md:h-6 md:w-6" />
          </button>
        )}

        {/* MODE: Local Mode Warning (Not Signed In) */}
        {mode === 'local' && (
          <div className="p-4 md:p-8">
            {/* Header */}
            <div className="mb-3 md:mb-6">
              <h2 className="text-lg md:text-2xl font-semibold text-gray-900 mb-1">Trust me, the UX will suck.</h2>
              <p className="text-xs md:text-base text-gray-600 leading-relaxed">
                Observer <em>works</em> without an account. But a lot of things are limited:
              </p>
            </div>

            {/* What's limited */}
            <div className="space-y-2 mb-3 md:mb-6">
              <div className="bg-gray-50 border border-gray-200 rounded-xl p-2.5 md:p-3">
                <ul className="space-y-1.5">
                  <li className="flex items-center gap-2.5 text-xs md:text-sm font-medium text-gray-700">
                    <Sparkles className="h-4 w-4 text-gray-400 flex-shrink-0" />
                    Agent creator won't work, you'll have to create them manually!
                  </li>
                  <li className="flex items-center gap-2.5 text-xs md:text-sm font-medium text-gray-700">
                    <Zap className="h-4 w-4 text-gray-400 flex-shrink-0" />
                    Most notifications won't work
                  </li>
                </ul>
              </div>
            </div>

            {/* Mobile web + local model warning */}
            {isMobileWeb && (
              <div className="md:hidden bg-gray-50 border border-gray-200 rounded-xl p-2.5 mb-3 flex items-start gap-2">
                <span className="text-gray-400 text-base flex-shrink-0">⚠️</span>
                <p className="text-xs text-gray-600 leading-relaxed">
                  <strong className="text-gray-900">Local models crash mobile browsers.</strong> This is a known transformers.js limitation, download the app if you want to run local models on your phone.
                </p>
              </div>
            )}

            {/* Sign-in call to action */}
            <div className="mb-3 md:mb-6">
              <button
                onClick={handleSignIn}
                className="w-full px-6 py-3 bg-purple-600 text-white rounded-full hover:bg-purple-700 transition-colors font-medium"
              >
                Sign In
              </button>
              <p className="text-xs text-gray-500 text-center mt-2">
                I recommend this, you can sign in <strong>and</strong> use local models. Your data stays on-device either way :)
              </p>
            </div>

          </div>
        )}

        {/* MODE: Upsell (Signed In, right after accepting ToS) */}
        {mode === 'upsell' && (
          <div className="p-4 md:p-8">
            {/* ============ WELCOME SECTION (Top 60%) ============ */}
            <div className="text-center mb-4 pb-4 md:mb-6 md:pb-6 border-b border-gray-200">
              <div className="flex justify-center items-center mb-2 md:mb-3">
                <img src="/eye-logo-black.svg" alt="Observer AI Logo" className="h-10 w-10 md:h-16 md:w-16 mr-2 md:mr-3" />
                <h1 className="text-2xl md:text-3xl font-bold text-gray-800 tracking-tight">
                  {variant === 'activation' ? 'You did it! 🎉' : variant === 'tutorial' ? 'Notification Sent!' : 'Welcome to Observer!'}
                </h1>
              </div>

              {/* Hidden on mobile for compactness */}
              <p className={`${variant === 'tutorial' ? '' : 'hidden md:block '}text-sm md:text-base text-gray-600 max-w-2xl mx-auto leading-relaxed`}>
                {variant === 'activation'
                  ? 'You have a running agent. Help Observer grow — or continue free.'
                  : variant === 'tutorial'
                    ? 'Now use a local model, try out Observer Pro and continue exploring!'
                    : 'Local micro-agents that watch, log, and react.'}
              </p>
            </div>

            {variant === 'activation' ? (
              /* ============ ACTIVATION: Star + Invite (no repeat Pro pitch) ============ */
              <div className="text-center mb-4 md:mb-6">
                <p className="text-sm md:text-base text-gray-700 mb-1 flex items-center justify-center gap-2">
                  <Heart className="h-4 w-4 md:h-5 md:w-5 text-pink-500" />
                  <span className="font-semibold">Built by a solo developer</span>
                </p>
                <p className="text-xs md:text-sm text-gray-600 mb-4 md:mb-6">
                  Your agent worked — help more people find Observer
                </p>

                <div className="flex justify-center mb-4">
                  <button
                    onClick={() => { Analytics.upsellGithub(upsellSource); handleStarGithub(); }}
                    className="px-4 py-3 bg-gray-900 text-white rounded-full hover:bg-black transition-colors font-medium flex items-center justify-center gap-2 group text-sm md:text-base"
                  >
                    <Star className="h-4 w-4 text-yellow-400 fill-yellow-400 group-hover:scale-110 transition-transform" />
                    <span>Star on GitHub</span>
                    <span className="text-xs opacity-80">(1.6k)</span>
                  </button>
                </div>

                <button
                  onClick={() => { Analytics.upsellContinueFree(upsellSource); handleClose(); }}
                  className="text-xs md:text-sm text-gray-600 hover:text-gray-800 hover:underline transition-colors font-medium"
                >
                  Continue with free tier →
                </button>
              </div>
            ) : variant === 'tutorial' && isProUser ? (
              /* ============ TUTORIAL, already Pro: no pitch, just send them exploring ============ */
              <div className="text-center mb-2 md:mb-4">
                <Sparkles className="h-8 w-8 md:h-10 md:w-10 text-purple-600 mx-auto mb-3" />
                <p className="text-base md:text-lg font-semibold text-gray-900 mb-1">
                  You just taught an agent to watch for you.
                </p>
                <p className="text-sm md:text-base text-gray-600 max-w-md mx-auto mb-5 md:mb-6">
                  As a Pro user everything is unlocked. Point it at anything on your screen or camera, and have it call, text or email you when it happens.
                </p>
                <button
                  onClick={handleClose}
                  className="px-8 py-3 bg-purple-600 text-white rounded-full hover:bg-purple-700 transition-colors font-medium"
                >
                  Continue exploring →
                </button>
              </div>
            ) : (
              /* ============ ONBOARDING: Observer Pro Free Trial ============ */
              <div className="text-center mb-4 md:mb-6">
                <p className="text-sm md:text-base text-gray-700 mb-1 flex items-center justify-center gap-2">
                  <Heart className="h-4 w-4 md:h-5 md:w-5 text-pink-500" />
                  <span className="font-semibold">Built by a solo developer</span>
                </p>
                <p className="text-xs md:text-sm text-gray-600 mb-4 md:mb-6">
                  Try Observer Pro - give feedback and help development
                </p>

                {/* Observer Pro - Hero Free Trial Option */}
                <div className="bg-white border border-gray-200 rounded-2xl p-4 md:p-6 max-w-md mx-auto mb-4 relative">
                  {!isAppleDevice && (
                    <div className="absolute top-0 -translate-y-1/2 left-1/2 -translate-x-1/2">
                      <div className="bg-gray-900 text-white text-xs font-semibold uppercase tracking-wider rounded-full px-4 py-1 whitespace-nowrap">
                        Free Trial
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-center gap-2 md:gap-3 mb-3 md:mb-4 mt-2">
                    <Sparkles className="h-7 w-7 md:h-8 md:w-8 text-purple-600" />
                    <div className="text-left">
                      <h3 className="text-lg md:text-xl font-semibold text-gray-900">Observer Pro</h3>
                      <p className="text-sm text-gray-500">
                        {isAppleDevice ? (
                          <span className="text-xl md:text-2xl font-semibold text-gray-900">${'22.99'}/month</span>
                        ) : (
                          <>
                            <span className="text-xl md:text-2xl font-semibold text-gray-900">7 days free</span>
                            <span className="text-xs ml-1">then $20/month</span>
                          </>
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="space-y-1.5 md:space-y-2 mb-3 md:mb-4 text-xs md:text-sm text-gray-700 text-left">
                    <div className="flex items-start">
                      <Sparkles className="h-3.5 w-3.5 md:h-4 md:w-4 text-purple-600 mr-2 flex-shrink-0 mt-0.5" />
                      <span><strong className="text-gray-900">Unlock Agent Builder</strong> autonomous deployment</span>
                    </div>
                    <div className="flex items-start">
                      <Zap className="h-3.5 w-3.5 md:h-4 md:w-4 text-purple-600 mr-2 flex-shrink-0 mt-0.5" />
                      <span>
                        <strong className="text-gray-900">12 hours/day, 100 hours/month</strong> cloud monitoring
                        <CreditInfoButton dailyCredits={1440} monthlyCredits={12000} tierName="Pro tier" className="ml-1 align-middle" />
                      </span>
                    </div>
                    <div className="flex items-start">
                      <Zap className="h-3.5 w-3.5 md:h-4 md:w-4 text-purple-600 mr-2 flex-shrink-0 mt-0.5" />
                      <span><strong className="text-gray-900">Unlock </strong>Voice Call, Whatsapp and SMS notifications</span>
                    </div>
                    <div className="flex items-start">
                      <Sparkles className="h-3.5 w-3.5 md:h-4 md:w-4 text-purple-600 mr-2 flex-shrink-0 mt-0.5" />
                      <span><strong className="text-gray-900">Premium AI models</strong> access</span>
                    </div>
                    <div className="flex items-start">
                      <Heart className="h-3.5 w-3.5 md:h-4 md:w-4 text-gray-400 mr-2 flex-shrink-0 mt-0.5" />
                      <span><strong className="text-gray-900">Support open source</strong> development</span>
                    </div>
                  </div>

                  <button
                    onClick={() => {
                      Analytics.upsellFreeTrial(upsellSource);
                      if (isAppleDevice) handleApplePurchasePro(); else handleProCheckout();
                    }}
                    disabled={isButtonLoading || isAppleLoading}
                    className="w-full px-4 py-2.5 md:px-6 md:py-3 bg-purple-600 text-white rounded-full hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-300 transition-colors font-medium text-sm md:text-base disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center justify-center"
                  >
                    {isButtonLoading || isAppleLoading ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : null}
                    Start Free Trial
                  </button>
                  <p className="text-xs text-gray-400 mt-2 text-center">
                    <a href="https://observer-ai.com/#/Terms" target="_blank" rel="noopener noreferrer" className="hover:underline">Terms</a>
                    {' · '}
                    <a href="https://observer-ai.com/#/Privacy" target="_blank" rel="noopener noreferrer" className="hover:underline">Privacy</a>
                  </p>
                </div>

                {/* Error Display */}
                {(error || appleError) && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-2 md:p-3 mb-3 md:mb-4 text-center max-w-md mx-auto">
                    <p className="text-xs md:text-sm text-red-700">{error || appleError}</p>
                  </div>
                )}

                {/* Action Buttons - Stacked on mobile, inline on desktop */}
                <div className="flex flex-col md:flex-row items-center justify-center gap-2 md:gap-3">
                  <button
                    onClick={() => { Analytics.upsellGithub(upsellSource); handleStarGithub(); }}
                    className="px-3 py-1.5 md:px-4 md:py-2 bg-gray-900 text-white rounded-full hover:bg-black transition-colors font-medium flex items-center gap-2 group text-sm md:text-base"
                  >
                    <Star className="h-4 w-4 text-yellow-400 fill-yellow-400 group-hover:scale-110 transition-transform" />
                    <span>Star on GitHub</span>
                    <span className="text-xs opacity-80">(1.6k)</span>
                  </button>

                  <div className="hidden md:block text-gray-300">|</div>

                  <button
                    onClick={() => { Analytics.upsellContinueFree(upsellSource); handleClose(); }}
                    className="text-xs md:text-sm text-gray-600 hover:text-gray-800 hover:underline transition-colors font-medium"
                  >
                    Continue with free tier →
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

    </div>
  );
};
