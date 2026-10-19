// src/components/PricingTable.tsx

import React, { useState, useCallback } from 'react';
import {
  Loader2, Zap, ExternalLink,
  Check, X, Sparkles, User, RotateCcw, Building2, Users
} from 'lucide-react';
import { CreditInfoButton } from './CreditVisualization';
import { InfoTooltip } from './InfoTooltip';
import { isIOS } from '../utils/platform';
import { Logger } from '@utils/logging';
import type { UseApplePaymentsReturn } from '@hooks/useApplePayments';
import { openUrl } from '@tauri-apps/plugin-opener';

interface PricingTableProps {
  headline: string;
  subheadline: string;
  status: 'loading' | 'plus' | 'pro' | 'max' | 'free' | 'error' | 'enterprise';
  /** Tier the org seat grants ('pro' | 'max'), only meaningful when status is 'enterprise'. */
  orgTier?: string | null;
  isButtonLoading: boolean;
  isAuthenticated?: boolean;
  error: string | null;
  onCheckout: () => void;
  onCheckoutPlus: () => void;
  onCheckoutMax: () => void;
  onManageSubscription: () => void;
  onLogin: () => void;
  isTriggeredByQuotaError?: boolean;
  isHalfwayWarning?: boolean;
  applePayments?: UseApplePaymentsReturn | null;
  onModalClose?: () => void;
}

interface FeatureRow {
  label: string;
  sparkle?: boolean;
  free: boolean | string;
  plus: boolean | string;
  pro: boolean | string;
  max: boolean | string;
  creditInfo?: { free?: number; plus?: number; pro?: number; max?: number };
  monthlyCreditInfo?: { free?: number; plus?: number; pro?: number; max?: number };
  info?: { free?: string; plus?: string; pro?: string; max?: string };
}

interface FeatureGroup {
  group: string;
  rows: FeatureRow[];
}

const featureGroups: FeatureGroup[] = [
  {
    group: 'Core — Free Forever',
    rows: [
      { label: 'Local Models',             free: true,       plus: true,       pro: true,        max: true },
      { label: 'Logging & Recording',      free: true,       plus: true,       pro: true,        max: true },
      { label: 'Discord, Telegram, Email & Pushover', free: true, plus: true, pro: true, max: true },
    ],
  },
  {
    group: 'Cloud inference',
    rows: [
      { label: 'Micro-Agent Builder', sparkle: true, free: '3 agents/day', plus: '3 agents/day', pro: true, max: true,
        info: {
          free: 'Building a micro-agent takes ~15 messages with Observer on average, and the free tier gives you 45/day, about 3 full builds. Plenty to design and iterate.',
          plus: 'Building a micro-agent takes ~15 messages with Observer on average, and the Plus tier gives you 45/day, about 3 full builds. Plenty to design and iterate.',
        } },
      { label: 'Cloud Monitoring',         free: '30 min/day · 10 hr/mo', plus: '4 hr/day · 40 hr/mo', pro: '12 hr/day · 100 hr/mo', max: '24 hr/day · 270 hr/mo', creditInfo: { free: 60, plus: 480, pro: 1440, max: 2880 }, monthlyCreditInfo: { free: 1200, plus: 4800, pro: 12000, max: 32400 } },
    ],
  },
  {
    group: 'Notifications',
    rows: [
      { label: 'SMS, Phone & WhatsApp',      free: false, plus: false, pro: true, max: true },
    ],
  },
  {
    group: 'Support',
    rows: [
      { label: 'Support', free: 'Limited', plus: 'Limited', pro: 'Better', max: 'Priority' },
    ],
  },
];

const CheckMark = () => <Check className="h-4 w-4 md:h-5 md:w-5 text-green-500 mx-auto" />;
const CrossMark = () => <X className="h-4 w-4 md:h-5 md:w-5 text-gray-300 dark:text-gray-600 mx-auto" />;

const renderCell = (value: boolean | string, dailyCredits?: number, tierName?: string, info?: string, monthlyCredits?: number) => {
  const infoBtn = info && typeof value !== 'string' ? <InfoTooltip body={info} className="align-middle" /> : null;
  if (value === true) {
    return (
      <span className="inline-flex items-center justify-center gap-1">
        <CheckMark />
        {infoBtn}
      </span>
    );
  }
  if (value === false) return <CrossMark />;
  const text = (
    <span className="flex flex-col items-center leading-tight">
      {value.split(' · ').map((line, i) => (
        <span key={i}>
          {line.includes('agents')
            ? <>{line.split('agents')[0]}<User className="inline h-4 w-4 align-text-bottom" aria-label="agents" />{line.split('agents')[1]}</>
            : line}
        </span>
      ))}
    </span>
  );
  return (
    <span className="inline-flex flex-wrap items-center justify-center gap-x-1 text-xs md:text-sm font-semibold text-gray-700 dark:text-gray-300">
      {info ? <InfoTooltip body={info}>{text}</InfoTooltip> : text}
      {dailyCredits !== undefined && tierName && (
        <CreditInfoButton dailyCredits={dailyCredits} monthlyCredits={monthlyCredits} tierName={tierName} className="align-middle" />
      )}
      {infoBtn}
    </span>
  );
};

export const PricingTable: React.FC<PricingTableProps> = ({
  headline,
  subheadline,
  status,
  orgTier,
  isButtonLoading,
  error,
  onCheckout,
  onCheckoutPlus,
  onCheckoutMax,
  onManageSubscription,
  isTriggeredByQuotaError = false,
  applePayments,
  onModalClose,
}) => {
  const isAppleDevice = isIOS();
  const [internalLoading, setInternalLoading] = useState(false);
  // No Apple IAP product exists for Plus, so it is only offered outside iOS.
  const showPlus = !isAppleDevice;

  const effectiveStatus = status;

  const handleApplePurchase = useCallback(async (tier: 'pro' | 'max') => {
    if (!applePayments) return;
    Logger.info('PRICING_TABLE', `Starting Apple purchase for tier: ${tier}`);
    setInternalLoading(true);
    try {
      const result = await applePayments.purchaseProduct(tier);
      Logger.info('PRICING_TABLE', 'Purchase result:', result);
      if (result.success) {
        if (onModalClose) onModalClose();
        window.location.href = '/upgrade-success';
      }
    } catch (err) {
      Logger.error('PRICING_TABLE', 'Purchase failed:', err);
    } finally {
      setInternalLoading(false);
    }
  }, [applePayments, onModalClose]);

  const handleAppleRestore = useCallback(async () => {
    if (!applePayments) return;
    Logger.info('PRICING_TABLE', 'Starting Apple restore');
    setInternalLoading(true);
    try {
      const result = await applePayments.restorePurchases();
      Logger.info('PRICING_TABLE', 'Restore result:', result);
      if (result.success) {
        if (onModalClose) onModalClose();
        window.location.href = '/upgrade-success';
      }
    } catch (err) {
      Logger.error('PRICING_TABLE', 'Restore failed:', err);
    } finally {
      setInternalLoading(false);
    }
  }, [applePayments, onModalClose]);

  const handleManageSubscription = isAppleDevice && applePayments
    ? () => openUrl('https://apps.apple.com/account/subscriptions')
        .catch((err: unknown) => Logger.error('PRICING_TABLE', 'openUrl failed:', err))
    : onManageSubscription;

  const handleProCheckout  = isAppleDevice && applePayments ? () => handleApplePurchase('pro')  : onCheckout;
  const handleMaxCheckout  = isAppleDevice && applePayments ? () => handleApplePurchase('max')  : onCheckoutMax;

  const combinedLoading = isButtonLoading || internalLoading || (applePayments?.isLoading ?? false);
  const combinedError   = error || (applePayments?.error ?? null);

  // ── table column helpers ──────────────────────────────────────────────────
  const headerBase = "text-center align-top px-1 md:px-3 pt-2 pb-3 md:pt-3 md:pb-4 text-xs md:text-sm font-bold";
  const cellBase   = "text-center px-1 md:px-3 py-2 md:py-3";

  const getHeaderClass = (tier: 'free' | 'plus' | 'pro' | 'max') => {
    const current = effectiveStatus === tier;
    if (tier === 'plus') return `${headerBase} ${current ? 'bg-[#A8631F] text-white dark:bg-[#8A5220]' : 'bg-[#A8631F]/10 text-[#7A4A1C] dark:bg-[#A8631F]/20 dark:text-[#E3B07A]'}`;
    if (tier === 'pro') return `${headerBase} border-x-2 border-t-2 border-slate-400 dark:border-slate-400/70 ${current ? 'bg-slate-500 text-white dark:bg-slate-600' : 'bg-slate-100 text-slate-800 dark:bg-slate-700/40 dark:text-slate-200'}`;
    if (tier === 'max') return `${headerBase} ${current ? 'bg-amber-500  text-white dark:bg-amber-600' : 'bg-amber-50  text-amber-900 dark:bg-amber-900/30 dark:text-amber-200'}`;
    return `${headerBase} bg-gray-50 text-gray-600 dark:bg-gray-900 dark:text-gray-400`;
  };

  const getCellClass = (tier: 'free' | 'plus' | 'pro' | 'max', isLastRow = false) => {
    const current = effectiveStatus === tier;
    if (tier === 'plus') return `${cellBase} ${current ? 'bg-[#A8631F]/10 dark:bg-[#A8631F]/15' : ''}`;
    if (tier === 'pro') return `${cellBase} ${isLastRow ? 'border-b-2' : ''} border-x-2 border-slate-400 dark:border-slate-400/70 ${current ? 'bg-slate-200/70 dark:bg-slate-700/40' : 'bg-slate-100/70 dark:bg-slate-700/20'}`;
    if (tier === 'max') return `${cellBase} ${current ? 'bg-amber-50/60 dark:bg-amber-900/20'  : ''}`;
    return cellBase;
  };


  // Enterprise seats are billed to the org, not the user — there is no personal
  // subscription to show or manage, so point them at their team page instead.
  if (status === 'enterprise') {
    const tierLabel = orgTier === 'max' ? 'Max' : 'Pro';
    return (
      <div className="w-full max-w-2xl mx-auto p-5 md:p-8 bg-white dark:bg-gray-800 rounded-none md:rounded-lg text-center">
        <Building2 className="mx-auto h-12 w-12 text-purple-500 mb-3" />
        <h1 className="text-xl sm:text-2xl font-bold text-gray-800 dark:text-gray-100 tracking-tight">
          You're on an Enterprise plan
        </h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          Your seat is provided by your organization and includes all {tierLabel} features,
          drawing from a shared monthly hours pool quoted for your organization.
          Billing, seats, and the pool are managed by your team's owner.
        </p>
        <a
          href="/team"
          className="mt-5 inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold text-white bg-purple-600 hover:bg-purple-700 transition-colors shadow-md"
        >
          <Users className="h-4 w-4" />
          View your team
        </a>
        {combinedError && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400 font-semibold">{combinedError}</p>
        )}
      </div>
    );
  }

  return (
    <div className="w-full max-w-4xl mx-auto p-3 md:p-5 bg-white dark:bg-gray-800 rounded-none md:rounded-lg">

      {/* ── Header ── */}
      <div className="flex items-start gap-3 mb-3 md:mb-4">
        <Zap className={`flex-shrink-0 mt-0.5 text-purple-500 ${isTriggeredByQuotaError ? 'h-8 w-8' : 'h-6 w-6'}`} />
        <div>
          <h1 className={`font-bold text-gray-800 dark:text-gray-100 tracking-tight ${isTriggeredByQuotaError ? 'text-xl sm:text-2xl' : 'text-lg sm:text-xl'}`}>
            {headline}
          </h1>
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 mt-0.5">{subheadline}</p>
          {isTriggeredByQuotaError && (
            <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-400 dark:text-gray-500">
              <span>🚀 2k+ users</span>
              <span>•</span>
              <span>⭐ 1k+ GitHub stars</span>
              <span>•</span>
              <span>⚡ 100k+ captures/day</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Comparison Table with pricing + CTA embedded in headers ── */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm mb-3 md:mb-4">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-700">
              <th className="text-left px-2 md:px-4 py-3 text-[10px] md:text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 bg-gray-50 dark:bg-gray-900 w-[26%] md:w-2/5">
                Features
              </th>
                  {/* Free column */}
                  <th className={getHeaderClass('free')}>
                    <div aria-hidden className="mb-1 inline-block rounded-full px-1.5 md:px-2 py-0.5 text-[8px] md:text-[10px] font-bold uppercase tracking-wide invisible">Most Popular</div>
                    <div>Quick Start</div>
                    <div className="text-xs font-normal text-gray-400 dark:text-gray-500 mt-0.5">$0 / mo</div>
                    {effectiveStatus === 'free' ? (
                      <span className="mt-2 block text-xs bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300 px-2 py-0.5 rounded-full font-medium">
                        Current
                      </span>
                    ) : (
                      <button disabled className="mt-2 w-full py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-xs md:text-sm font-medium text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-700/50 cursor-not-allowed">
                        Free Forever
                      </button>
                    )}
                  </th>
                  {/* Plus column (bronze) */}
                  {showPlus && (
                    <th className={getHeaderClass('plus')}>
                      <div aria-hidden className="mb-1 inline-block rounded-full px-1.5 md:px-2 py-0.5 text-[8px] md:text-[10px] font-bold uppercase tracking-wide invisible">Most Popular</div>
                      <div>Plus</div>
                      <div className={`text-xs font-normal mt-0.5 ${effectiveStatus === 'plus' ? 'text-orange-100' : 'text-[#8A5220] dark:text-[#E3B07A]'}`}>
                        $8 / mo
                      </div>
                      {effectiveStatus === 'plus' ? (
                        <>
                          <span className="mt-2 block text-xs bg-[#A8631F]/30 text-[#7A4A1C] dark:bg-[#A8631F]/40 dark:text-[#F0CFA5] px-2 py-0.5 rounded-full font-medium">
                            Current
                          </span>
                          <button
                            onClick={handleManageSubscription}
                            disabled={combinedLoading}
                            className="mt-1.5 w-full py-1.5 rounded-lg border border-[#A8631F]/50 text-xs md:text-sm font-medium text-[#7A4A1C] dark:text-[#F0CFA5] bg-[#A8631F]/15 hover:bg-[#A8631F]/25 disabled:opacity-50 transition-colors flex items-center justify-center gap-1"
                          >
                            {combinedLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />}
                            Manage
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={onCheckoutPlus}
                          disabled={combinedLoading}
                          className="mt-2 w-full py-2 rounded-lg text-xs md:text-sm font-bold text-white bg-[#A8631F] hover:bg-[#8F5218] hover:scale-105 disabled:opacity-50 transition-all flex items-center justify-center gap-1 shadow-md ring-2 ring-[#A8631F]/40"
                        >
                          {combinedLoading && <Loader2 className="h-3 w-3 animate-spin" />}
                          Upgrade
                        </button>
                      )}
                    </th>
                  )}
                  {/* Pro column (silver) */}
                  <th className={getHeaderClass('pro')}>
                    <div className={`mb-1 inline-block rounded-full px-1.5 md:px-2 py-0.5 text-[8px] md:text-[10px] font-bold uppercase tracking-wide ${effectiveStatus === 'pro' ? 'invisible' : 'bg-slate-500 text-white dark:bg-slate-400 dark:text-slate-900'}`}>
                      Most Popular
                    </div>
                    <div>Pro</div>
                    <div className={`text-xs font-normal mt-0.5 ${effectiveStatus === 'pro' ? 'text-slate-200' : 'text-slate-500 dark:text-slate-400'}`}>
                      ${isAppleDevice ? '22.99' : '20'} / mo
                    </div>
                    {effectiveStatus === 'pro' ? (
                      <>
                        <span className="mt-2 block text-xs bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200 px-2 py-0.5 rounded-full font-medium">
                          Current
                        </span>
                        <button
                          onClick={handleManageSubscription}
                          disabled={combinedLoading}
                          className="mt-1.5 w-full py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 text-xs md:text-sm font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800/60 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-1"
                        >
                          {combinedLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />}
                          Manage
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={handleProCheckout}
                        disabled={combinedLoading}
                        className="mt-2 w-full py-2 rounded-lg text-xs md:text-sm font-bold text-white bg-slate-500 hover:bg-slate-600 hover:scale-105 disabled:opacity-50 transition-all flex items-center justify-center gap-1 shadow-md ring-2 ring-slate-300"
                      >
                        {combinedLoading && <Loader2 className="h-3 w-3 animate-spin" />}
                        Free Trial
                      </button>
                    )}
                  </th>
                  {/* Max column */}
                  <th className={getHeaderClass('max')}>
                    <div aria-hidden className="mb-1 inline-block rounded-full px-1.5 md:px-2 py-0.5 text-[8px] md:text-[10px] font-bold uppercase tracking-wide invisible">Most Popular</div>
                    <div>MAX</div>
                    <div className={`text-xs font-normal mt-0.5 ${effectiveStatus === 'max' ? 'text-amber-100' : 'text-amber-500'}`}>
                      ${isAppleDevice ? '99.99' : '80'} / mo
                    </div>
                    {effectiveStatus === 'max' ? (
                      <>
                        <span className="mt-2 block text-xs bg-amber-200 text-amber-700 dark:bg-amber-800 dark:text-amber-200 px-2 py-0.5 rounded-full font-medium">
                          Current
                        </span>
                        <button
                          onClick={handleManageSubscription}
                          disabled={combinedLoading}
                          className="mt-1.5 w-full py-1.5 rounded-lg border border-amber-300 dark:border-amber-700 text-xs md:text-sm font-medium text-amber-700 dark:text-amber-200 bg-amber-100 dark:bg-amber-900/40 hover:bg-amber-200 dark:hover:bg-amber-900/60 disabled:opacity-50 transition-colors flex items-center justify-center gap-1"
                        >
                          {combinedLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />}
                          Manage
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={handleMaxCheckout}
                        disabled={combinedLoading}
                        className="mt-2 w-full py-2 rounded-lg text-xs md:text-sm font-bold text-white bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-600 hover:to-yellow-600 hover:scale-105 disabled:opacity-50 transition-all flex items-center justify-center gap-1 shadow-md ring-2 ring-amber-300"
                      >
                        {combinedLoading && <Loader2 className="h-3 w-3 animate-spin" />}
                        Upgrade
                      </button>
                    )}
                  </th>
            </tr>
          </thead>
          <tbody>
            {featureGroups.map((group, gi) => (
              <React.Fragment key={group.group}>
                <tr>
                  <td className="px-2 md:px-4 py-1 md:py-2 bg-gray-50/80 dark:bg-gray-900/50">
                    <span className="text-xs font-bold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                      {group.group}
                    </span>
                  </td>
                  <td className="bg-gray-50/80 dark:bg-gray-900/50" />
                  {showPlus && <td className="bg-gray-50/80 dark:bg-gray-900/50" />}
                  {/* Pro column highlight runs over the group band */}
                  <td className="border-x-2 border-slate-400 dark:border-slate-400/70 bg-slate-100/70 dark:bg-slate-700/20" />
                  <td className="bg-gray-50/80 dark:bg-gray-900/50" />
                </tr>
                {group.rows.map((row, i) => {
                  const isLastRow = gi === featureGroups.length - 1 && i === group.rows.length - 1;
                  return (
                  <tr key={row.label} className={`border-t border-gray-100 dark:border-gray-700 ${row.sparkle ? '[&_svg.lucide-check]:text-blue-500 dark:[&_svg.lucide-check]:text-blue-400' : i % 2 === 1 ? 'bg-gray-50/30 dark:bg-gray-900/30' : ''}`}>
                    <td className={`px-2 md:px-4 py-3 text-xs md:text-sm font-medium ${row.sparkle ? 'border-l-2 border-l-[#2546BE]/60' : ''}`}>
                      {row.sparkle ? (
                        <span className="inline-flex items-center gap-1.5 md:gap-2.5 text-[#182960] dark:text-blue-200 font-medium">
                          <span className="relative flex-shrink-0">
                            <span className="flex h-5 w-5 md:h-6 md:w-6 items-center justify-center rounded-full bg-[#182960]">
                              <img src="/eye-logo-black.svg" alt="" className="h-3 w-3 md:h-3.5 md:w-3.5 invert" />
                            </span>
                            <span className="absolute -bottom-0.5 -right-0.5 flex h-2.5 w-2.5">
                              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-50" />
                              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-green-500 ring-2 ring-white dark:ring-gray-800" />
                            </span>
                          </span>
                          {row.label}
                        </span>
                      ) : (
                        <span className="text-gray-700 dark:text-gray-300">{row.label}</span>
                      )}
                    </td>
                        <td className={getCellClass('free')}>{renderCell(row.free, row.creditInfo?.free, 'Free tier', row.info?.free, row.monthlyCreditInfo?.free)}</td>
                        {showPlus && <td className={getCellClass('plus')}>{renderCell(row.plus, row.creditInfo?.plus, 'Plus tier', row.info?.plus, row.monthlyCreditInfo?.plus)}</td>}
                        <td className={getCellClass('pro', isLastRow)}>{renderCell(row.pro, row.creditInfo?.pro, 'Pro tier', row.info?.pro, row.monthlyCreditInfo?.pro)}</td>
                        <td className={getCellClass('max')}>{renderCell(row.max, row.creditInfo?.max, 'Max tier', row.info?.max, row.monthlyCreditInfo?.max)}</td>
                  </tr>
                  );
                })}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Error ── */}
      {combinedError && (
        <div className="text-center mt-3">
          <p className="text-sm text-red-600 dark:text-red-400 font-semibold">{combinedError}</p>
        </div>
      )}

      {/* ── iOS: Restore & Load Products ── */}
      {isAppleDevice && applePayments && (
        <div className="text-center mt-3 flex justify-center gap-4">
          {applePayments.loadProducts && (
            <button
              onClick={applePayments.loadProducts}
              disabled={combinedLoading}
              className="inline-flex items-center text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 disabled:text-gray-300 dark:disabled:text-gray-600 font-medium"
            >
              <Sparkles className="h-4 w-4 mr-1" />
              Load Products
            </button>
          )}
          <button
            onClick={handleAppleRestore}
            disabled={combinedLoading}
            className="inline-flex items-center text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:text-gray-300 dark:disabled:text-gray-600"
          >
            <RotateCcw className="h-4 w-4 mr-1" />
            Restore Purchases
          </button>
        </div>
      )}

      {/* ── Terms (required for App Store) ── */}
      <div className="text-center mt-3 pt-3 border-t border-gray-100 dark:border-gray-700">
        <p className="text-xs text-gray-400 dark:text-gray-500">
          By subscribing, you agree to our{' '}
          {isIOS() ? (
            <>
              <button onClick={() => openUrl('https://observer-ai.com/#/Terms')} className="text-blue-500 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 underline">
                Terms of Service
              </button>
              {' '}and{' '}
              <button onClick={() => openUrl('https://observer-ai.com/#/Privacy')} className="text-blue-500 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 underline">
                Privacy Policy
              </button>
            </>
          ) : (
            <>
              <a href="https://observer-ai.com/#/Terms" target="_blank" rel="noopener noreferrer" className="text-blue-500 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 underline">Terms of Service</a>
              {' '}and{' '}
              <a href="https://observer-ai.com/#/Privacy" target="_blank" rel="noopener noreferrer" className="text-blue-500 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 underline">Privacy Policy</a>
            </>
          )}
          .
        </p>
      </div>
    </div>
  );
};
