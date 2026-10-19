import { useState } from 'react';
import {
  ShieldCheck, Building2, Search, UserPlus, RefreshCw, Loader2,
  AlertCircle, ExternalLink, Copy, Check,
} from 'lucide-react';
import { adminFetch, ApiError } from './api';
import {
  OrgRecord, ProvisionOrgResponse, USAGE_LABELS, USAGE_SERVICES,
} from './types';

// Monthly monitor credits are metered 1 credit = 1 minute of monitoring.
const UNCAPPED = -1;

type Mode = 'provision' | 'manage';

export function EnterprisePanel() {
  const [adminKey, setAdminKey] = useState('');
  const [mode, setMode] = useState<Mode>('provision');

  // Provision form
  const [name, setName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [tier, setTier] = useState('pro');
  const [seats, setSeats] = useState(5);
  const [priceId, setPriceId] = useState('');
  const [daysUntilDue, setDaysUntilDue] = useState(30);
  const [trialDays, setTrialDays] = useState<string>('');
  const [monthlyMinutes, setMonthlyMinutes] = useState<number>(UNCAPPED);
  const [dryRun, setDryRun] = useState(true);
  const [provisioned, setProvisioned] = useState<ProvisionOrgResponse | null>(null);

  // Manage
  const [lookupId, setLookupId] = useState('');
  const [org, setOrg] = useState<OrgRecord | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [creditsInput, setCreditsInput] = useState<number>(UNCAPPED);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  };

  const provision = () =>
    run('provision', async () => {
      setProvisioned(null);
      const body: Record<string, unknown> = {
        name: name.trim(),
        admin_email: adminEmail.trim(),
        tier,
        seats,
        days_until_due: daysUntilDue,
        monthly_credits: monthlyMinutes,
        dry_run: dryRun,
      };
      if (priceId.trim()) body.price_id = priceId.trim();
      if (trialDays.trim()) body.trial_period_days = Number(trialDays);

      const res = await adminFetch<ProvisionOrgResponse>(adminKey, '/admin/orgs', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setProvisioned(res);
      if (!dryRun) {
        setLookupId(res.org_id);
        setNotice(`Created ${res.org_id}.`);
      }
    });

  const lookup = (id?: string) =>
    run('lookup', async () => {
      const target = (id ?? lookupId).trim();
      if (!target) return;
      const res = await adminFetch<OrgRecord>(adminKey, `/admin/orgs/${encodeURIComponent(target)}`);
      setOrg(res);
      setCreditsInput(res.monthly_credits);
      setMode('manage');
    });

  const invite = () =>
    run('invite', async () => {
      if (!org || !inviteEmail.trim()) return;
      await adminFetch(adminKey, `/admin/orgs/${encodeURIComponent(org.org_id)}/members`, {
        method: 'POST',
        body: JSON.stringify({ email: inviteEmail.trim() }),
      });
      setNotice(`Seated ${inviteEmail.trim()}.`);
      setInviteEmail('');
      setOrg(await adminFetch<OrgRecord>(adminKey, `/admin/orgs/${encodeURIComponent(org.org_id)}`));
    });

  const resync = () =>
    run('resync', async () => {
      if (!org) return;
      await adminFetch(adminKey, `/admin/orgs/${encodeURIComponent(org.org_id)}/sync`, {
        method: 'POST',
      });
      setNotice('Resynced from Stripe.');
      setOrg(await adminFetch<OrgRecord>(adminKey, `/admin/orgs/${encodeURIComponent(org.org_id)}`));
    });

  const updateCredits = () =>
    run('credits', async () => {
      if (!org) return;
      await adminFetch(adminKey, `/admin/orgs/${encodeURIComponent(org.org_id)}/credits`, {
        method: 'POST',
        body: JSON.stringify({ monthly_credits: creditsInput }),
      });
      setNotice('Updated the monthly credit pool.');
      const res = await adminFetch<OrgRecord>(adminKey, `/admin/orgs/${encodeURIComponent(org.org_id)}`);
      setOrg(res);
      setCreditsInput(res.monthly_credits);
    });

  const copyOrgId = async () => {
    if (!provisioned) return;
    await navigator.clipboard.writeText(provisioned.org_id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const keyMissing = !adminKey.trim();

  return (
    <div className="bg-white border border-gray-100 rounded-3xl shadow-xl shadow-gray-200/60 p-7">
      {/* Admin key */}
      <label htmlFor="admin-key" className="block text-sm font-semibold text-gray-700 mb-2">
        Admin Key
      </label>
      <div className="relative">
        <ShieldCheck className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        <input
          id="admin-key"
          type="password"
          value={adminKey}
          onChange={(e) => setAdminKey(e.target.value)}
          placeholder="X-Admin-Key"
          autoComplete="off"
          className="w-full bg-gray-50 border border-gray-200 rounded-xl pl-10 pr-4 py-3 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-400 focus:bg-white transition"
        />
      </div>
      <p className="mt-2 text-xs text-gray-400">
        Never stored — kept in memory for this tab only. Creates real Stripe subscriptions.
      </p>

      {/* Mode switch */}
      <div className="mt-6 flex gap-1 bg-gray-100 rounded-xl p-1">
        {(['provision', 'manage'] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 text-sm font-medium rounded-lg py-2 transition ${
              mode === m ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {m === 'provision' ? 'New org' : 'Manage org'}
          </button>
        ))}
      </div>

      {mode === 'provision' ? (
        <div className="mt-6 space-y-4">
          <Field label="Company name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Inc"
              className={inputCls}
            />
          </Field>

          <Field label="Billing contact email" hint="Becomes the org owner — the only account that can remove members.">
            <input
              type="email"
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
              placeholder="cto@acme.com"
              className={inputCls}
            />
          </Field>

          <div className="grid grid-cols-3 gap-3">
            <Field label="Tier">
              <select value={tier} onChange={(e) => setTier(e.target.value)} className={inputCls}>
                <option value="pro">Pro</option>
                <option value="max">Max</option>
              </select>
            </Field>
            <Field label="Seats">
              <input
                type="number"
                min={1}
                value={seats}
                onChange={(e) => setSeats(Number(e.target.value))}
                className={inputCls}
              />
            </Field>
            <Field label="Net days">
              <input
                type="number"
                min={0}
                value={daysUntilDue}
                onChange={(e) => setDaysUntilDue(Number(e.target.value))}
                className={inputCls}
              />
            </Field>
          </div>

          <Field label="Trial days" hint="Leave blank for no trial. During the trial no invoice is sent; the subscription reads 'trialing' and seats already work. The first real invoice goes out when it ends.">
            <input
              type="number"
              min={1}
              value={trialDays}
              onChange={(e) => setTrialDays(e.target.value)}
              placeholder="e.g. 30"
              className={inputCls}
            />
          </Field>

          <Field label="Price ID" hint="Leave blank to use STRIPE_ENTERPRISE_SEAT_PRICE_ID. Set it for negotiated pricing.">
            <input
              value={priceId}
              onChange={(e) => setPriceId(e.target.value)}
              placeholder="price_..."
              className={inputCls}
            />
          </Field>

          <Field
            label="Monthly monitoring pool (minutes)"
            hint="Shared monitoring budget for the whole org, in minutes. -1 = uncapped. Every seat still keeps its own daily limit underneath."
          >
            <input
              type="number"
              min={-1}
              value={monthlyMinutes}
              onChange={(e) => setMonthlyMinutes(Number(e.target.value))}
              className={inputCls}
            />
          </Field>

          <label className="flex items-center gap-2.5 text-sm text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Dry run — validate without touching Stripe or R2
          </label>

          <button
            onClick={provision}
            disabled={keyMissing || !name.trim() || !adminEmail.trim() || busy !== null}
            className={`w-full font-semibold rounded-xl px-4 py-3 transition flex items-center justify-center gap-2 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed text-white ${
              dryRun ? 'bg-gray-700 hover:bg-gray-800' : 'bg-amber-600 hover:bg-amber-700'
            }`}
          >
            {busy === 'provision' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Building2 className="w-4 h-4" />
            )}
            {dryRun ? 'Validate' : 'Create org & subscription'}
          </button>

          {provisioned && (
            <div className="pt-5 border-t border-gray-100 space-y-3">
              {provisioned.dry_run && (
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                  Dry run — nothing was created
                </p>
              )}
              <div className="flex items-stretch gap-2">
                <div className="flex-1 bg-gray-50 rounded-xl px-3 py-2.5 min-w-0">
                  <p className="text-[11px] uppercase tracking-wide text-gray-400 font-medium">Org ID</p>
                  <code className="text-sm font-mono text-gray-800 break-all">{provisioned.org_id}</code>
                </div>
                <button
                  onClick={copyOrgId}
                  className="shrink-0 w-12 rounded-xl border border-gray-200 text-gray-500 hover:border-blue-300 hover:text-blue-600 flex items-center justify-center"
                >
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>

              {!provisioned.dry_run && (
                <>
                  <Row label="Owner">
                    {provisioned.owner_email}{' '}
                    <span className={provisioned.owner_status === 'active' ? 'text-green-600' : 'text-amber-600'}>
                      ({provisioned.owner_status === 'active' ? 'seated now' : 'invite emailed'})
                    </span>
                  </Row>
                  <Row label="Subscription">{provisioned.stripe_subscription_id}</Row>
                  <Row label="Invoice">
                    {provisioned.hosted_invoice_url ? (
                      <a
                        href={provisioned.hosted_invoice_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-600 hover:underline inline-flex items-center gap-1"
                      >
                        Open invoice <ExternalLink className="w-3 h-3" />
                      </a>
                    ) : (
                      <span className="text-gray-500">
                        {provisioned.invoice_id} — not finalized yet, no link for ~1h
                      </span>
                    )}
                  </Row>
                  <button
                    onClick={() => lookup(provisioned.org_id)}
                    className="text-sm text-blue-600 hover:underline"
                  >
                    Manage this org →
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          <Field label="Org ID">
            <div className="flex gap-2">
              <input
                value={lookupId}
                onChange={(e) => setLookupId(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && lookup()}
                placeholder="obs_org_acme_a1b2c3"
                className={inputCls}
              />
              <button
                onClick={() => lookup()}
                disabled={keyMissing || !lookupId.trim() || busy !== null}
                className="shrink-0 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 text-white rounded-xl flex items-center"
              >
                {busy === 'lookup' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Search className="w-4 h-4" />
                )}
              </button>
            </div>
          </Field>

          {org && (
            <div className="pt-5 border-t border-gray-100 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-bold text-gray-900">{org.name}</h3>
                  <p className="text-sm text-gray-500 capitalize">
                    {org.tier} · {org.seats_used}/{org.seats_purchased} seats
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                      org.status === 'active'
                        ? 'bg-green-50 text-green-700'
                        : 'bg-amber-50 text-amber-700'
                    }`}
                  >
                    {org.status}
                  </span>
                  <button
                    onClick={resync}
                    title="Force resync from Stripe"
                    disabled={busy !== null}
                    className="p-1.5 text-gray-400 hover:text-blue-600"
                  >
                    <RefreshCw className={`w-4 h-4 ${busy === 'resync' ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>

              <div className="bg-gray-50 rounded-xl px-4 py-3 space-y-2">
                <p className="text-[11px] uppercase tracking-wide text-gray-400 font-medium">
                  Monthly monitoring pool
                </p>
                <p className="text-sm text-gray-700">
                  {org.monthly_pool.unlimited
                    ? 'Uncapped'
                    : `${org.monthly_pool.used} / ${org.monthly_pool.limit} min used`}
                  <span className="text-gray-400"> · resets {new Date(org.monthly_pool.resets_at).toLocaleDateString()}</span>
                </p>
                <div className="flex gap-2">
                  <input
                    type="number"
                    min={-1}
                    value={creditsInput}
                    onChange={(e) => setCreditsInput(Number(e.target.value))}
                    className={inputCls}
                  />
                  <button
                    onClick={updateCredits}
                    disabled={busy !== null || creditsInput === org.monthly_credits}
                    className="shrink-0 px-4 bg-gray-700 hover:bg-gray-800 disabled:bg-gray-200 disabled:text-gray-400 text-white rounded-xl flex items-center gap-2 text-sm font-medium"
                  >
                    {busy === 'credits' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Set'}
                  </button>
                </div>
                <p className="text-[11px] text-gray-400">Minutes. -1 = uncapped.</p>
              </div>

              <div className="flex gap-2">
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && invite()}
                  placeholder="teammate@acme.com"
                  disabled={org.seats_used >= org.seats_purchased}
                  className={inputCls}
                />
                <button
                  onClick={invite}
                  disabled={!inviteEmail.trim() || busy !== null || org.seats_used >= org.seats_purchased}
                  className="shrink-0 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 text-white rounded-xl flex items-center gap-2 text-sm font-medium"
                >
                  {busy === 'invite' ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <UserPlus className="w-4 h-4" />
                  )}
                  Seat
                </button>
              </div>

              <div className="overflow-x-auto -mx-2">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-gray-400 border-b border-gray-100">
                      <th className="px-2 py-2 font-medium">Member</th>
                      {USAGE_SERVICES.map((s) => (
                        <th key={s} className="px-2 py-2 font-medium text-right whitespace-nowrap">
                          {USAGE_LABELS[s]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {org.members.map((m) => (
                      <tr key={m.email} className="border-b border-gray-50 last:border-0">
                        <td className="px-2 py-2">
                          <div className="text-gray-900 truncate max-w-[180px]">{m.email}</div>
                          <div className="text-[11px] text-gray-400">
                            {m.status}
                            {m.email === org.owner_email && ' · owner'}
                          </div>
                        </td>
                        {USAGE_SERVICES.map((s) => (
                          <td key={s} className="px-2 py-2 text-right tabular-nums text-gray-600">
                            {m.usage?.[s] ?? 0}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-gray-400">Usage counters reset at UTC midnight.</p>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mt-4 flex items-start gap-2.5 bg-red-50 border border-red-100 rounded-xl px-4 py-3 text-sm text-red-700">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="mt-4 bg-green-50 border border-green-100 rounded-xl px-4 py-3 text-sm text-green-700">
          {notice}
        </div>
      )}
    </div>
  );
}

export const inputCls =
  'w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-400 focus:bg-white transition disabled:bg-gray-100 disabled:text-gray-400';

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-semibold text-gray-700 mb-1.5">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-gray-400 leading-relaxed">{hint}</p>}
    </div>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-sm">
      <span className="text-gray-400 w-24 shrink-0">{label}</span>
      <span className="text-gray-700 min-w-0 break-all">{children}</span>
    </div>
  );
}
