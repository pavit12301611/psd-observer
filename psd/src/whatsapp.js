// whatsapp.js — the link to the existing WhatsApp agent (whatsapp-agent/).
//
// PSD does not re-implement WhatsApp. It talks to the agent that already links
// to the owner's phone as a companion device, over the agent's own local bridge:
//
//   POST /api/send            send text/images to the owner
//   POST /api/chat            run one owner turn (this is the upgrade path:
//                             WhatsApp messages can be answered by PSD's agents)
//   GET  /api/status          is the phone linked, what is the agent doing
//
// If the agent is not running, PSD degrades quietly: the notch, the web UI and
// the CLI keep working, and the message is queued for the next time it is up.

const trimSlash = (value) => String(value ?? '').replace(/\/+$/, '');

export function createWhatsApp(config, { log = console } = {}) {
  const queue = [];
  let lastSeen = null;         // last successful /api/status body
  let lastError = '';
  let lastOkAt = 0;

  const base = trimSlash(config.whatsappUrl);
  const headers = () => ({
    'content-type': 'application/json',
    ...(config.whatsappToken ? { 'x-bridge-token': config.whatsappToken } : {}),
  });

  async function call(path, { method = 'GET', body, timeout = 20_000 } = {}) {
    const res = await fetch(`${base}${path}`, {
      method, headers: headers(), body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) throw new Error(json?.detail || `agent bridge ${res.status}`);
    return json;
  }

  async function status({ fresh = false, timeout = 4000 } = {}) {
    if (!fresh && lastSeen && Date.now() - lastOkAt < 5000) return lastSeen;
    try {
      lastSeen = await call('/api/status', { timeout });
      lastOkAt = Date.now();
      lastError = '';
      return lastSeen;
    } catch (err) {
      lastError = err.message;
      lastSeen = null;
      return null;
    }
  }

  async function send(text, { image = null } = {}) {
    if (!config.whatsappBridge) return { ok: false, error: 'WhatsApp bridge is disabled (PSD_WHATSAPP_BRIDGE=false).' };
    const payload = { message: String(text ?? '').slice(0, 8000), ...(image ? { images: [image] } : {}) };
    try {
      await call('/api/send', { method: 'POST', body: payload, timeout: 20_000 });
      return { ok: true };
    } catch (err) {
      lastError = err.message;
      // Keep the last few so the owner is not silently ignored while the agent
      // restarts (systemd restarts it on failure).
      queue.push({ ...payload, at: Date.now() });
      if (queue.length > 20) queue.shift();
      return { ok: false, error: err.message, queued: true };
    }
  }

  /** Flush anything queued while the agent was down. Called by the health loop. */
  async function flush() {
    if (!queue.length) return 0;
    const pending = queue.splice(0, queue.length);
    let sent = 0;
    for (const item of pending) {
      try {
        await call('/api/send', { method: 'POST', body: { message: item.message, ...(item.images ? { images: item.images } : {}) } });
        sent += 1;
      } catch {
        queue.unshift(item);
        break;
      }
    }
    return sent;
  }

  /** Ask the WhatsApp agent to run one owner turn (WhatsApp → PSD bridging). */
  async function chat(text, { timeout = 120_000 } = {}) {
    try {
      const reply = await call('/api/chat', { method: 'POST', body: { text }, timeout });
      return { ok: true, text: reply?.text ?? '', images: reply?.images ?? [] };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  return {
    send, status, chat, flush,
    get queued() { return queue.length; },
    get info() {
      return {
        url: base,
        tokenConfigured: Boolean(config.whatsappToken),
        queued: queue.length,
        lastError,
        linked: lastSeen?.whatsapp?.startsWith?.('connected') ?? false,
        whatsapp: lastSeen?.whatsapp ?? (lastError ? 'offline' : 'unknown'),
        owner: lastSeen?.owner ?? null,
        agent: lastSeen?.agent ?? null,
        version: lastSeen?.version ?? null,
      };
    },
  };
}
