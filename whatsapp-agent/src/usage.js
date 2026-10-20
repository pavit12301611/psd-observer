// usage.js — "aaj kitna quota kharch hua?" in one WhatsApp message.
//
// Free tiers are not infinite: Groq gives ~1,000 requests/day per model,
// OpenRouter 50/day on a fresh account, Gemini's free limits are per-project
// and unpublished. When a limit is hit mid-task the agent just falls to the
// next brain and the owner never learns why the answers got dumber/slower.
//
// Every router call is counted here (one line per model per day, persisted in
// store.json so it survives restarts), and /usage shows it with a warning at
// 80% of any limit we actually know.

const LOCAL = new Set(['local', 'ollama']);

/** Known free-tier ceilings. null = the provider does not publish one. */
export const QUOTAS = {
  groq: { perDay: 1000, perMinute: 30, note: 'per model, free tier' },
  openrouter: { perDay: 50, perMinute: 20, note: '50/day fresh · 1000/day after a one-time $10' },
  gemini: { perDay: null, perMinute: null, note: 'limit is per-project — check AI Studio (free tier trains on data)' },
  local: { perDay: null, perMinute: null, note: 'your PC — unlimited' },
  ollama: { perDay: null, perMinute: null, note: 'your PC — unlimited' },
};

const dayKey = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);
const providerOf = (modelId) => String(modelId ?? '').split(':')[0] || 'unknown';
const shortModel = (modelId) => String(modelId ?? '').split(':').slice(1).join(':') || String(modelId);

/** Ensure the store has today's bucket. Old days are trimmed to 14. */
export function usageBucket(store, ts = Date.now()) {
  if (!store?.data) return null;
  if (!store.data.usage || typeof store.data.usage !== 'object') store.data.usage = {};
  const days = store.data.usage;
  const key = dayKey(ts);
  if (!days[key]) days[key] = { models: {} };
  if (!days[key].models) days[key].models = {};
  const keys = Object.keys(days).sort();
  for (const old of keys.slice(0, Math.max(0, keys.length - 14))) delete days[old];
  return days[key];
}

/**
 * Count one model call. `info` is what router.record() received:
 * {ok, ms, tier, error}. Failures are counted too — a 429 burns quota just
 * like a success.
 */
export function noteUsage(store, modelId, info = {}, ts = Date.now()) {
  const bucket = usageBucket(store, ts);
  if (!bucket || !modelId) return null;
  const id = String(modelId);
  const entry = bucket.models[id] ?? { provider: providerOf(id), calls: 0, ok: 0, fail: 0, ms: 0, lastTs: 0 };
  entry.calls += 1;
  if (info.ok) entry.ok += 1; else entry.fail += 1;
  entry.ms += Math.max(0, Number(info.ms) || 0);
  entry.lastTs = ts;
  bucket.models[id] = entry;
  store.save?.();
  return entry;
}

export function totals(store, ts = Date.now()) {
  const bucket = usageBucket(store, ts);
  const out = { models: 0, calls: 0, ok: 0, fail: 0, ms: 0, byProvider: {} };
  for (const [id, e] of Object.entries(bucket?.models ?? {})) {
    out.models += 1;
    out.calls += e.calls;
    out.ok += e.ok;
    out.fail += e.fail;
    out.ms += e.ms;
    const p = e.provider || providerOf(id);
    out.byProvider[p] = (out.byProvider[p] ?? 0) + e.calls;
  }
  return out;
}

/** 0..1 of a known daily limit, or null when the provider hides it. */
export function quotaUsed(store, provider, ts = Date.now()) {
  const quota = QUOTAS[provider];
  if (!quota?.perDay) return null;
  const used = totals(store, ts).byProvider[provider] ?? 0;
  return Math.min(1, used / quota.perDay);
}

export function warnings(store, ts = Date.now()) {
  const out = [];
  const t = totals(store, ts);
  for (const [provider, used] of Object.entries(t.byProvider)) {
    const quota = QUOTAS[provider];
    if (!quota?.perDay) continue;
    const pct = used / quota.perDay;
    if (pct >= 0.8) {
      out.push(`⚠️ *${provider}* — ${used}/${quota.perDay} calls (${Math.round(pct * 100)}%). `
        + (provider === 'groq' ? 'Kal reset hoga; abhi local model pe switch kar lunga.' : 'Limit kareeb — local pe switch karna better.'));
    }
  }
  return out;
}

const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

/** WhatsApp-ready /usage report. */
export function usageReport(store, { catalog = [], now = Date.now(), days = 7 } = {}) {
  const bucket = usageBucket(store, now);
  const t = totals(store, now);
  const lines = [`📊 *AI usage — aaj* (${dayKey(now)})`, ''];

  const rows = Object.entries(bucket?.models ?? {}).sort((a, b) => b[1].calls - a[1].calls);
  if (!rows.length) {
    lines.push('_Aaj abhi koi AI call nahi hui._');
  } else {
    for (const [id, e] of rows.slice(0, 8)) {
      const fail = e.fail ? ` · ${e.fail} fail` : '';
      lines.push(`• ${shortModel(id)} — ${e.calls} calls${fail} · avg ${fmtMs(e.ms / Math.max(1, e.calls))}`);
    }
    lines.push('', `Total: *${t.calls}* calls (${t.ok} ok, ${t.fail} fail) · ${fmtMs(t.ms / Math.max(1, t.calls))} average`);
  }

  lines.push('', '*Provider limits*');
  for (const [provider, used] of Object.entries(t.byProvider).sort((a, b) => b[1] - a[1])) {
    const quota = QUOTAS[provider] ?? { note: 'unknown provider' };
    const limit = quota.perDay
      ? `${used}/${quota.perDay} (${Math.round((used / quota.perDay) * 100)}%)`
      : `${used} calls`;
    lines.push(`• ${provider}: ${limit} — _${quota.note}_`);
  }
  const known = Object.keys(QUOTAS).filter((p) => !t.byProvider[p]);
  if (known.length) lines.push(`_Idle: ${known.join(', ')}_`);

  const warn = warnings(store, now);
  if (warn.length) lines.push('', ...warn);

  const history = [];
  const all = store?.data?.usage ?? {};
  for (const key of Object.keys(all).sort().slice(-days)) {
    if (key === dayKey(now)) continue;
    const calls = Object.values(all[key]?.models ?? {}).reduce((n, e) => n + (e.calls ?? 0), 0);
    if (calls) history.push(`${key.slice(5)}: ${calls}`);
  }
  if (history.length) lines.push('', `*Pichhle din* — ${history.join(' · ')}`);

  const models = catalog.length ? `\n_${catalog.length} brains configured — /brains_` : '';
  return lines.join('\n') + models;
}
