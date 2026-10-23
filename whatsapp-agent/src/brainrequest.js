// Shared provider transport and safe, actionable failure details. Some
// OpenAI-compatible providers return an error envelope with HTTP 200.
export class BrainError extends Error {
  constructor(message, { status = 0, code = '', retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'BrainError';
    this.status = Number(status) || 0;
    this.code = String(code || '');
    this.retryAfterMs = Math.max(0, Number(retryAfterMs) || 0);
  }
}

export function safeBrainText(value, config = {}, max = 240) {
  let text = String(value ?? '');
  for (const [key, secret] of Object.entries(config)) {
    if (/(?:apiKey|token|pin|password)$/i.test(key) && typeof secret === 'string' && secret.length >= 6) {
      text = text.split(secret).join('[redacted]');
    }
  }
  return text
    .replace(/([?&](?:key|api_key|token)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:gsk_|sk-or-|sk-proj-|sk-)[a-zA-Z0-9_-]{8,}/g, '[redacted]')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Pure classification; also understands errors from legacy callers. */
export function brainFailure(error, config = {}) {
  const raw = String(error?.message ?? error ?? 'unknown provider failure');
  const status = Number(error?.status) || Number(raw.match(/^\s*(\d{3})\b/)?.[1]) || 0;
  const code = String(error?.code || '');
  const detail = `${code} ${raw}`;
  let kind = 'provider';
  let hint = 'Check /brains for model health; try another configured provider.';
  if (status === 401 || (status === 403 && !/model|endpoint/i.test(detail)) || /invalid.api.key|authentication/i.test(detail)) {
    kind = 'auth';
    hint = 'Provider rejected the API key/access. Check its key in .env, then restart the agent.';
  } else if (status === 413) {
    kind = 'context';
    hint = 'Prompt/tool context is too large. /agent tries one compact retry; use file paths for large code/data.';
  } else if (status === 429 || /rate.limit|quota.exceeded|too.many.requests/i.test(detail)) {
    kind = 'rate_limit';
    hint = 'Free-tier quota/rate limit reached. Wait for the cooldown or configure another brain.';
  } else if (code === 'output_limit') {
    kind = 'output';
    hint = 'Model output was cut off. Increase AGENT_MAX_TOKENS or use smaller file edits.';
  } else if (/context.length|context.window|too.many.tokens|request.too.large|maximum.context|reduce.*(?:tokens|length)/i.test(detail)) {
    kind = 'context';
    hint = 'Prompt/tool context is too large. /agent tries one compact retry; use file paths for large code/data.';
  } else if (status === 404 || /model.*(?:not.found|decommission|not.available|does.not.exist)|no.endpoints/i.test(detail)) {
    kind = 'model';
    hint = 'Configured model/endpoint is unavailable. Check the model ID in .env.';
  } else if (/tool_use_failed|tool.*(?:not.support|unsupported)|function.*(?:not.support|invalid)|failed.to.call.*function/i.test(detail)) {
    kind = 'tools';
    hint = 'This model rejected tool calling. Use a tool-capable model; chat-only models cannot run /agent.';
  } else if (error?.name === 'TimeoutError' || /timed?.?out|timeout|ETIMEDOUT/i.test(detail)) {
    kind = 'timeout';
    hint = 'Model timed out. Check the local server or AI_TIMEOUT_MS.';
  } else if (/fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|network|socket|ECONNRESET/i.test(detail)) {
    kind = 'network';
    hint = 'Cannot reach the model server. Check its URL, network and running service.';
  } else if (/empty|no usable reply/i.test(detail)) {
    kind = 'empty';
    hint = 'Model returned no usable answer or tool calls. The next brain is tried automatically.';
  }
  return {
    kind, status, code,
    message: safeBrainText(raw, config),
    retryAfterMs: Math.max(0, Number(error?.retryAfterMs) || 0),
    hint,
    providerWide: kind === 'auth',
  };
}

function retryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const until = Date.parse(value);
  return Number.isFinite(until) ? Math.max(0, until - Date.now()) : 0;
}

export async function postBrainJson(url, body, headers = {}, timeoutMs = 60_000, outerSignal = null) {
  const timeout = AbortSignal.timeout(Math.max(1, Number(timeoutMs) || 60_000));
  // Keep BOTH /stop and the timeout even on early Node 20 releases without
  // AbortSignal.any. Remove listeners when the request settles.
  const controller = new AbortController();
  const signals = [timeout, outerSignal].filter(Boolean);
  const abort = (event) => controller.abort(event.target.reason);
  for (const signal of signals) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', abort, { once: true });
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await res.text();
    let data;
    try { data = JSON.parse(raw); } catch { /* handled below */ }
    if (!res.ok || data?.error) {
      const error = data?.error;
      const status = !res.ok ? res.status : Number(error?.code ?? error?.status) || 502;
      const message = typeof error === 'string' ? error : error?.message || raw || res.statusText;
      throw new BrainError(`${status}: ${String(message).slice(0, 1600)}`, {
        status,
        code: error?.code || error?.type,
        retryAfterMs: retryAfter(res.headers.get('retry-after')),
      });
    }
    if (!data || typeof data !== 'object') throw new BrainError('Invalid JSON response from model server', { status: res.status });
    return data;
  } finally {
    for (const signal of signals) signal.removeEventListener('abort', abort);
  }
}
