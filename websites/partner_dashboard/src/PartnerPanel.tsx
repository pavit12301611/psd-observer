import { useState } from 'react';
import {
  KeyRound, Building2, Loader2, AlertCircle, ExternalLink, RefreshCw, Wallet, ArrowRight,
} from 'lucide-react';
import { partnerFetch, ApiError } from './api';
import { Field, Row, inputCls } from './EnterprisePanel';
import { PartnerDeal, PartnerDealsResponse, PartnerProvisionResponse } from './types';

// quota_manager meters monitoring at 2 credits per minute (30s loops).
const CREDITS_PER_HOUR = 120;
const UNLIMITED = -1;
const DEFAULT_POOL = 30_000;

type Mode = 'new' | 'deals';

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);

const date = (unix: number) =>
  new Date(unix * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

export function PartnerPanel() {
  const [partnerKey, setPartnerKey] = useState('');
  const [mode, setMode] = useState<Mode>('new');

  // New deal form
  const [name, setName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [tier, setTier] = useState('max');
  const [seats, setSeats] = useState(10);
  const [daysUntilDue, setDaysUntilDue] = useState(30);
  const [trialDays, setTrialDays] = useState('');
  const [pool, setPool] = useState(DEFAULT_POOL);
  const [unlimitedPool, setUnlimitedPool] = useState(false);

  // A review is a dry run of exactly these inputs; editing any of them drops it,
  // so "Create" always creates what was just quoted.
  const [review, setReview] = useState<PartnerProvisionResponse | null>(null);
  const [created, setCreated] = useState<PartnerProvisionResponse | null>(null);

  const [deals, setDeals] = useState<PartnerDealsResponse | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const edit = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setReview(null);
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  };

  const provision = (dryRun: boolean) =>
    run(dryRun ? 'review' : 'create', async () => {
      const body: Record<string, unknown> = {
        name: name.trim(),
        admin_email: adminEmail.trim(),
        tier,
        seats,
        days_until_due: daysUntilDue,
        monthly_credits: unlimitedPool ? UNLIMITED : pool,
        dry_run: dryRun,
      };
      if (trialDays.trim()) body.trial_period_days = Number(trialDays);

      const res = await partnerFetch<PartnerProvisionResponse>(partnerKey.trim(), '/payments/partner/orgs', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (dryRun) {
        setReview(res);
      } else {
        setCreated(res);
        setReview(null);
        setName('');
        setAdminEmail('');
      }
    });

  const loadDeals = () =>
    run('deals', async () => {
      setDeals(await partnerFetch<PartnerDealsResponse>(partnerKey.trim(), '/payments/partner/orgs'));
    });

  const openStripe = () =>
    run('stripe', async () => {
      const res = await partnerFetch<{ url: string }>(partnerKey.trim(), '/payments/partner/stripe-link', {
        method: 'POST',
      });
      window.open(res.url, '_blank', 'noopener');
    });

  const switchMode = (m: Mode) => {
    setMode(m);
    setError(null);
    if (m === 'deals' && !deals && partnerKey.trim()) loadDeals();
  };

  const keyMissing = !partnerKey.trim();
  const formIncomplete = !name.trim() || !adminEmail.trim() || seats < 1;

  return (
    <div className="bg-white border border-gray-100 rounded-3xl shadow-xl shadow-gray-200/60 p-7">
      <label htmlFor="partner-key" className="block text-sm font-semibold text-gray-700 mb-2">
        Partner Key
      </label>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <KeyRound className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
          <input
            id="partner-key"
            type="password"
            value={partnerKey}
            onChange={(e) => {
              setPartnerKey(e.target.value);
              setDeals(null);
            }}
            placeholder="Enter your partner key"
            autoComplete="off"
            className="w-full bg-gray-50 border border-gray-200 rounded-xl pl-10 pr-4 py-3 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-400 focus:bg-white transition"
          />
        </div>
        <button
          onClick={openStripe}
          disabled={keyMissing || busy !== null}
          title="Your earnings and payouts in Stripe"
          className="shrink-0 px-4 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:border-blue-300 hover:text-blue-600 disabled:text-gray-300 disabled:hover:border-gray-200 flex items-center gap-2 transition"
        >
          {busy === 'stripe' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wallet className="w-4 h-4" />}
          Payouts
        </button>
      </div>
      <p className="mt-2 text-xs text-gray-400">
        Never stored — kept in memory for this tab only. Payouts opens your Stripe account, where every
        commission payment appears as the customer pays.
      </p>

      <div className="mt-6 flex gap-1 bg-gray-100 rounded-xl p-1">
        {(['new', 'deals'] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => switchMode(m)}
            className={`flex-1 text-sm font-medium rounded-lg py-2 transition ${
              mode === m ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {m === 'new' ? 'New deal' : 'My deals'}
          </button>
        ))}
      </div>

      {mode === 'new' ? (
        <div className="mt-6 space-y-4">
          <Field label="Company name">
            <input value={name} onChange={(e) => edit(setName)(e.target.value)} placeholder="Acme Inc" className={inputCls} />
          </Field>

          <Field
            label="Billing / admin contact email"
            hint="Receives the invoice and becomes the org owner. One org per company domain."
          >
            <input
              type="email"
              value={adminEmail}
              onChange={(e) => edit(setAdminEmail)(e.target.value)}
              placeholder="cto@acme.com"
              className={inputCls}
            />
          </Field>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Field label="Tier">
              <select value={tier} onChange={(e) => edit(setTier)(e.target.value)} className={inputCls}>
                <option value="max">Max</option>
                <option value="pro">Pro</option>
              </select>
            </Field>
            <Field label="Seats">
              <input
                type="number"
                min={1}
                value={seats}
                onChange={(e) => edit(setSeats)(Number(e.target.value))}
                className={inputCls}
              />
            </Field>
            <Field label="Net days">
              <input
                type="number"
                min={1}
                max={60}
                value={daysUntilDue}
                onChange={(e) => edit(setDaysUntilDue)(Number(e.target.value))}
                className={inputCls}
              />
            </Field>
            <Field label="Trial days">
              <input
                type="number"
                min={1}
                max={30}
                value={trialDays}
                onChange={(e) => edit(setTrialDays)(e.target.value)}
                placeholder="None"
                className={inputCls}
              />
            </Field>
          </div>

          <Field
            label="Monthly monitoring pool (credits)"
            hint={
              unlimitedPool
                ? 'Unlimited shared monitoring. Every seat still keeps its own daily limit.'
                : `Shared by the whole org, about ${Math.round(pool / CREDITS_PER_HOUR).toLocaleString()} hours of monitoring a month at 30s loops.`
            }
          >
            <div className="flex gap-3 items-center">
              <input
                type="number"
                min={1}
                value={pool}
                disabled={unlimitedPool}
                onChange={(e) => edit(setPool)(Number(e.target.value))}
                className={inputCls}
              />
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={unlimitedPool}
                  onChange={(e) => edit(setUnlimitedPool)(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                Unlimited
              </label>
            </div>
          </Field>

          <p className="text-xs text-gray-400 leading-relaxed">
            Deals use the standard seat price. For a negotiated price, contact Observer before closing.
          </p>

          {!review ? (
            <button
              onClick={() => provision(true)}
              disabled={keyMissing || formIncomplete || busy !== null}
              className="w-full bg-gray-800 hover:bg-gray-900 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed text-white font-semibold rounded-xl px-4 py-3 transition flex items-center justify-center gap-2"
            >
              {busy === 'review' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
              Review deal
            </button>
          ) : (
            <div className="rounded-2xl border border-blue-100 bg-blue-50/50 p-4 space-y-3">
              <Quote res={review} />
              <button
                onClick={() => provision(false)}
                disabled={busy !== null}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 text-white font-semibold rounded-xl px-4 py-3 transition flex items-center justify-center gap-2"
              >
                {busy === 'create' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Building2 className="w-4 h-4" />}
                Create org & send invoice
              </button>
            </div>
          )}

          {created && (
            <div className="pt-5 border-t border-gray-100 space-y-3">
              <p className="text-sm font-semibold text-green-700">Org created — send the customer the invoice.</p>
              <Row label="Org ID">{created.org_id}</Row>
              <Row label="Owner">
                {created.owner_email}{' '}
                <span className={created.owner_status === 'active' ? 'text-green-600' : 'text-amber-600'}>
                  ({created.owner_status === 'active' ? 'seated now' : 'invite emailed'})
                </span>
              </Row>
              <Row label="Invoice">
                {created.hosted_invoice_url ? (
                  <a
                    href={created.hosted_invoice_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 hover:underline inline-flex items-center gap-1"
                  >
                    Open invoice <ExternalLink className="w-3 h-3" />
                  </a>
                ) : (
                  <span className="text-gray-500">
                    {created.invoice_id ? 'Not finalized yet — it appears under My deals within ~1h.' : 'Trial — first invoice when it ends.'}
                  </span>
                )}
              </Row>
              {created.commission_until && (
                <Row label="Commission">
                  {created.quote.commission_percent}% of every paid invoice until {date(created.commission_until)}
                </Row>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-500">
              {deals
                ? `${deals.orgs.length} org${deals.orgs.length === 1 ? '' : 's'} · ${deals.commission_percent}% for ${deals.commission_months} months each`
                : 'Enter your key to load your deals.'}
            </p>
            <button
              onClick={loadDeals}
              disabled={keyMissing || busy !== null}
              title="Reload from Stripe"
              className="p-1.5 text-gray-400 hover:text-blue-600 disabled:text-gray-200"
            >
              <RefreshCw className={`w-4 h-4 ${busy === 'deals' ? 'animate-spin' : ''}`} />
            </button>
          </div>
          {deals?.orgs.map((d) => <DealCard key={d.org_id ?? d.created} deal={d} />)}
        </div>
      )}

      {error && (
        <div className="mt-4 flex items-start gap-2.5 bg-red-50 border border-red-100 rounded-xl px-4 py-3 text-sm text-red-700">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

function Quote({ res }: { res: PartnerProvisionResponse }) {
  const q = res.quote;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-white rounded-xl px-3 py-2.5">
          <p className="text-[11px] uppercase tracking-wide text-gray-400 font-medium">Customer pays</p>
          <p className="text-lg font-bold text-gray-900">
            {money(q.monthly_total, q.currency)}
            <span className="text-sm font-normal text-gray-500">/mo</span>
          </p>
        </div>
        <div className="bg-white rounded-xl px-3 py-2.5">
          <p className="text-[11px] uppercase tracking-wide text-gray-400 font-medium">You earn</p>
          <p className="text-lg font-bold text-green-700">
            {money(q.monthly_commission, q.currency)}
            <span className="text-sm font-normal text-gray-500">/mo</span>
          </p>
        </div>
      </div>
      <p className="text-xs text-gray-500 leading-relaxed">
        {res.seats} {res.tier === 'max' ? 'Max' : 'Pro'} seats × {money(q.unit_amount, q.currency)}. You receive{' '}
        {q.commission_percent}% of each invoice when the customer pays it, for {q.commission_months} months. Refunds
        and chargebacks take back the matching share.
      </p>
    </div>
  );
}

function DealCard({ deal }: { deal: PartnerDeal }) {
  const inv = deal.latest_invoice;
  const earning = deal.commission_until !== null && deal.commission_until * 1000 > Date.now();
  return (
    <div className="rounded-2xl border border-gray-100 px-4 py-3 space-y-1.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-gray-900 truncate">{deal.company ?? deal.org_id}</p>
          <p className="text-xs text-gray-500 truncate">
            {deal.seats ?? '?'} seats · {deal.admin_email} · since {date(deal.created)}
          </p>
        </div>
        <span
          className={`shrink-0 px-2.5 py-1 rounded-full text-xs font-medium ${
            deal.status === 'active' || deal.status === 'trialing'
              ? 'bg-green-50 text-green-700'
              : 'bg-amber-50 text-amber-700'
          }`}
        >
          {deal.status}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
        {inv && inv.currency && (
          <span>
            Latest invoice: {money(inv.status === 'paid' ? inv.amount_paid ?? 0 : inv.amount_due ?? 0, inv.currency)}{' '}
            <span className={inv.status === 'paid' ? 'text-green-600' : 'text-amber-600'}>({inv.status})</span>
            {inv.hosted_invoice_url && inv.status !== 'paid' && (
              <a
                href={inv.hosted_invoice_url}
                target="_blank"
                rel="noreferrer"
                className="ml-1.5 text-blue-600 hover:underline inline-flex items-center gap-0.5"
              >
                open <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </span>
        )}
        {deal.commission_until && (
          <span>
            {earning ? 'Earning until' : 'Commission ended'} {date(deal.commission_until)}
          </span>
        )}
      </div>
    </div>
  );
}
