// engine.js — the brain socket. One interface, three implementations:
//
//   ollama    POST /api/chat            (NDJSON stream, native tool calls)
//   openai    POST <url>/chat/completions (SSE stream, native tool calls)
//   intents   no model at all (offline intent layer still acts)
//
// Everything streams. PSD adds at most one extra hop over a plain chat call:
// it never rewrites the prompt per step, sends only the tools a step needs,
// and keeps the conversation window bounded, because latency is a feature.
//
// Failure is not fatal: a dead brain falls through the plan to the next one and
// finally to the offline intent layer, exactly like OpenJarvis' hybrid agents.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class NoBrainError extends Error {
  constructor(message = 'No language model is answering.') {
    super(message);
    this.name = 'NoBrainError';
    this.code = 'no_brain';
  }
}

function withTimeout(ms, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms}ms`)), ms);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    },
  };
}

/** Normalise the many shapes of a tool call into {id,name,arguments}. */
export function normalizeToolCall(raw, index = 0) {
  if (!raw) return null;
  const fn = raw.function ?? raw;
  const name = fn.name ?? raw.name ?? '';
  if (!name) return null;
  let args = fn.arguments ?? raw.arguments ?? raw.args ?? {};
  if (typeof args === 'string') {
    try { args = JSON.parse(args || '{}'); } catch { args = {}; }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
  return { id: raw.id || `call_${index}_${Date.now().toString(36)}`, name, arguments: args };
}

/** Pick a sane default model from what the local Ollama actually has. */
export function pickModel(models) {
  const names = (models ?? []).map((m) => (typeof m === 'string' ? m : m.name || m.model)).filter(Boolean);
  if (!names.length) return '';
  const score = (name) => {
    const n = name.toLowerCase();
    let s = 0;
    if (/qwen3|qwen2\.5|qwen2/.test(n)) s += 6;
    if (/llama3\.[1-9]|llama4|llama3$/.test(n)) s += 5;
    if (/mistral-nemo|mistral-small|ministral/.test(n)) s += 4;
    if (/gpt-oss|granite|phi4|gemma3/.test(n)) s += 4;
    if (/deepseek/.test(n)) s += 3;
    if (/:70b|:72b|:405b/.test(n)) s -= 3; // too slow for a notch chat
    if (/:(\d+)b/.test(n)) {
      const size = Number(n.match(/:(\d+(?:\.\d+)?)b/)?.[1] ?? 0);
      if (size >= 3 && size <= 16) s += 3;
      else if (size > 30) s -= 1;
    }
    if (/vision|llava|bakllava/.test(n)) s -= 2;
    if (/embed|nomic|mxbai|bge/.test(n)) s -= 50;
    if (/:latest$/.test(n)) s += 1;
    return s;
  };
  return [...names].sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0];
}

async function readStream(response, { kind, onToken, onToolDelta }) {
  const text = [];
  const calls = [];
  const decoder = new TextDecoder();
  let buffer = '';

  const consume = (payload) => {
    if (!payload) return;
    let data;
    try { data = JSON.parse(payload); } catch { return; }

    if (kind === 'ollama') {
      const msg = data.message ?? {};
      if (msg.content) {
        text.push(msg.content);
        onToken?.(msg.content);
      }
      for (const call of msg.tool_calls ?? []) {
        const normal = normalizeToolCall(call, calls.length);
        if (normal) calls.push(normal);
      }
      return;
    }

    // OpenAI-compatible SSE
    const choice = data.choices?.[0];
    const delta = choice?.delta ?? choice?.message ?? {};
    if (delta.content) {
      text.push(delta.content);
      onToken?.(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const part of delta.tool_calls) {
        const index = Number.isInteger(part.index) ? part.index : calls.length;
        const slot = calls[index] ?? { id: '', name: '', arguments: '' };
        if (part.id) slot.id = part.id;
        if (part.function?.name) slot.name = (slot.name || '') + part.function.name;
        if (part.function?.arguments) slot.arguments = (slot.arguments || '') + part.function.arguments;
        calls[index] = slot;
        onToolDelta?.(slot);
      }
    }
    if (choice?.finish_reason) buffer = buffer; // no-op, keeps the var used
  };

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('event:')) continue;
      if (trimmed.startsWith('data:')) {
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        consume(payload);
      } else if (trimmed.startsWith('{')) {
        consume(trimmed);
      }
    }
  }
  if (buffer.trim()) {
    const trimmed = buffer.trim();
    consume(trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed);
  }

  const toolCalls = calls
    .map((call, index) => {
      if (!call?.name) return null;
      let args = call.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args || '{}'); } catch { args = {}; } }
      return { id: call.id || `call_${index}`, name: call.name, arguments: args && typeof args === 'object' ? args : {} };
    })
    .filter(Boolean);

  return { content: text.join(''), toolCalls };
}

export function createEngine(config, { log = console } = {}) {
  let plan = config.plan ?? [];
  let chosen = null;       // {kind, id, url, model}
  let probeInfo = null;
  let failures = new Map(); // brainId -> {until, error}

  const cool = (id, error, ms = 20_000) => {
    failures.set(id, { until: Date.now() + ms, error: error?.message || String(error) });
  };
  const hot = (id) => {
    const entry = failures.get(id);
    if (!entry) return true;
    if (Date.now() > entry.until) { failures.delete(id); return true; }
    return false;
  };

  async function fetchJson(url, options, timeoutMs) {
    const guard = withTimeout(timeoutMs, options.signal);
    try {
      const res = await fetch(url, { ...options, signal: guard.signal });
      const body = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${body.slice(0, 200)}`);
      return body ? JSON.parse(body) : {};
    } finally {
      guard.done();
    }
  }

  /** Discover what is actually installed; called at boot and by /psd/status. */
  async function probe({ deep = false } = {}) {
    const started = Date.now();
    const out = { brains: [], model: '', brain: '', at: Date.now() };
    for (const entry of plan) {
      if (entry.kind === 'intents') {
        out.brains.push({ id: 'intents', kind: 'intents', label: 'Offline intents (no model)', ok: true, model: 'rules' });
        continue;
      }
      try {
        if (entry.kind === 'ollama') {
          const tags = await fetchJson(`${entry.url}/api/tags`, { method: 'GET' }, 2500);
          const model = entry.model || pickModel(tags.models);
          if (!model) throw new Error('Ollama is running but has no models (run: ollama pull qwen3:8b)');
          out.brains.push({ id: entry.id, kind: 'ollama', label: 'Ollama (local)', ok: true, model, url: entry.url, count: (tags.models ?? []).length });
          if (!out.model) { out.model = model; out.brain = 'ollama'; }
        } else {
          const models = await fetchJson(`${entry.url}/models`, {
            method: 'GET', headers: entry.apiKey ? { authorization: `Bearer ${entry.apiKey}` } : undefined,
          }, 2500);
          const listed = (models.data ?? []).map((m) => m.id).filter(Boolean);
          const model = entry.model || listed[0] || '';
          out.brains.push({ id: entry.id, kind: 'openai', label: entry.id === 'openjarvis' ? 'OpenJarvis serve' : 'OpenAI-compatible', ok: true, model, url: entry.url, count: listed.length });
          if (!out.model && model) { out.model = model; out.brain = entry.id; }
        }
      } catch (err) {
        out.brains.push({ id: entry.id, kind: entry.kind, label: entry.id, ok: false, error: err.message });
      }
    }
    out.latencyMs = Date.now() - started;
    probeInfo = out;
    if (deep) {
      // One real token through the chosen brain: the only honest latency number.
      const started = Date.now();
      try {
        await chat({ messages: [{ role: 'user', content: 'reply with the single word ok' }], maxTokens: 8 });
        out.deepLatencyMs = Date.now() - started;
      } catch (err) {
        out.deepLatencyMs = null;
        out.deepError = err.message;
      }
    }
    return out;
  }

  function activeBrains() {
    return plan
      .filter((entry) => entry.kind !== 'intents')
      .filter((entry) => hot(entry.id))
      .map((entry) => {
        const known = probeInfo?.brains?.find((b) => b.id === entry.id && b.ok);
        return { ...entry, model: entry.model || known?.model || '' };
      })
      .filter((entry) => entry.model);
  }

  /**
   * One completion. Returns {content, toolCalls, usage, brain, model}.
   * Streams text through onToken so the notch can type it out live.
   */
  async function chat({ messages, tools = [], onToken = null, signal = null, maxTokens = 1024, temperature = config.temperature, model = null }) {
    const candidates = activeBrains();
    if (!candidates.length) {
      throw new NoBrainError(
        'No model answered. Free options: `ollama pull qwen3:8b`, or set PSD_OPENAI_URL / PSD_OPENJARVIS_URL. ' +
        'PSD still works without one — apps, files, system, web and the notch keep going.',
      );
    }
    let lastError = null;
    for (const entry of candidates) {
      const guard = withTimeout(config.requestTimeoutMs, signal);
      try {
        const url = entry.kind === 'ollama' ? `${entry.url}/api/chat` : `${entry.url}/chat/completions`;
        const body = entry.kind === 'ollama'
          ? {
              model: model || entry.model,
              messages: messages.map((m) => ({ role: m.role, content: m.content ?? '', ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}), ...(m.tool_name ? { tool_name: m.tool_name } : {}) })),
              stream: true,
              tools: tools.length ? tools : undefined,
              options: { temperature, num_predict: maxTokens },
            }
          : {
              model: model || entry.model,
              messages: messages.map((m) => ({ role: m.role, content: m.content ?? '', ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}), ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}) })),
              stream: true,
              temperature,
              max_tokens: maxTokens,
              tools: tools.length ? tools : undefined,
              tool_choice: tools.length ? 'auto' : undefined,
            };
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(entry.apiKey ? { authorization: `Bearer ${entry.apiKey}` } : {}),
            ...(entry.kind === 'openai' ? { accept: 'text/event-stream' } : {}),
          },
          body: JSON.stringify(body),
          signal: guard.signal,
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => '')).slice(0, 300);
          throw new Error(`${res.status} ${detail}`);
        }
        // A server that ignores `stream` answers with plain JSON. Handle both.
        const contentType = res.headers.get('content-type') || '';
        let result;
        if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
          const data = await res.json();
          const msg = data.message ?? data.choices?.[0]?.message ?? {};
          const content = msg.content ?? '';
          if (content) onToken?.(content);
          result = {
            content,
            toolCalls: (msg.tool_calls ?? []).map((c, i) => normalizeToolCall(c, i)).filter(Boolean),
            usage: data.usage ?? data.eval_count ? { tokens: data.eval_count } : undefined,
          };
        } else {
          result = await readStream(res, { kind: entry.kind, onToken });
        }
        chosen = { id: entry.id, model: model || entry.model, kind: entry.kind };
        return { ...result, brain: entry.id, model: model || entry.model };
      } catch (err) {
        lastError = err;
        // A user cancellation must not look like a broken brain.
        if (signal?.aborted) throw err;
        const message = err?.name === 'AbortError' ? `timed out after ${config.requestTimeoutMs}ms` : err.message;
        cool(entry.id, { message });
        log.warn?.(`[engine] ${entry.id} failed: ${message}`);
      } finally {
        guard.done();
      }
    }
    throw new NoBrainError(`Every configured brain failed. Last error: ${lastError?.message ?? 'unknown'}`);
  }

  return {
    probe,
    chat,
    get plan() { return plan; },
    setPlan(next) { plan = next; failures = new Map(); },
    get chosen() { return chosen; },
    get lastProbe() { return probeInfo; },
    get healthy() { return activeBrains().length > 0; },
  };
}

export { sleep };
