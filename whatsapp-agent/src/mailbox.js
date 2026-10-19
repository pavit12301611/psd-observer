// mailbox.js — the local, free version of api/remote.py's Redis mailbox.
//
// Old flow (paid cloud): Twilio webhook → Redis → browser long-poll → MCP →
// POST /remote/reply → Twilio. New flow (this file, in-memory, one owner):
//
//   WhatsApp (native) → inbox queue → Observer tab long-polls /remote/listen
//   → MCP acts (screen/camera/tools) → POST /remote/reply → native WhatsApp.
//
// A reply resolves the oldest waiting WhatsApp handler if there is one (so the
// WA layer sends it, with typing/read states); otherwise server.js sends it
// directly. Either way exactly one WhatsApp message is sent.

export class Mailbox {
  constructor({ waitMs = 90_000, inboxMaxAgeMs = 5 * 60_000 } = {}) {
    this.waitMs = waitMs;
    this.inboxMaxAgeMs = inboxMaxAgeMs;
    this.inbox = [];            // {channel:'whatsapp', text, ts}
    this.pendingReplies = [];   // FIFO resolvers waiting on Observer
    this.listenWaiters = new Set();
    this.lastListenAt = 0;
  }

  /** True while an Observer tab has polled recently (the /status "session open" signal). */
  observerOnline(withinMs = 45_000) {
    return Date.now() - this.lastListenAt < withinMs;
  }

  _wakeListeners() {
    for (const wake of [...this.listenWaiters]) wake();
  }

  /**
   * Offer a WhatsApp message to Observer and wait for its reply.
   * Resolves {text, images?} or null on timeout. Callers should check
   * observerOnline() first to fail fast.
   */
  async forwardToObserver(text, waitMs = this.waitMs) {
    this.inbox.push({ channel: 'whatsapp', text: String(text).slice(0, 4000), ts: Date.now() });
    this._wakeListeners();
    return new Promise((resolve) => {
      const pending = { resolve, timer: null };
      pending.timer = setTimeout(() => {
        this.pendingReplies = this.pendingReplies.filter((p) => p !== pending);
        resolve(null);
      }, waitMs);
      pending.timer.unref?.();
      this.pendingReplies.push(pending);
    });
  }

  /**
   * A reply arrived from Observer. Returns 'pending' if a WhatsApp handler
   * consumed it (it will do the sending), 'direct' if nobody is waiting
   * (server.js must send it to WhatsApp itself).
   */
  deliverReply({ text, images }) {
    const pending = this.pendingReplies.shift();
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve({ text, images });
      return 'pending';
    }
    return 'direct';
  }

  /**
   * Long-poll used by the patched app/src/mcp/remote.ts listenInbox().
   * Resolves with queued messages (stale ones dropped) or [] after holdMs.
   */
  async listen(holdMs = 25_000) {
    this.lastListenAt = Date.now();
    const deadline = Date.now() + holdMs;
    for (;;) {
      const now = Date.now();
      const fresh = this.inbox.filter((m) => now - m.ts <= this.inboxMaxAgeMs);
      this.inbox = [];
      if (fresh.length) return fresh.map(({ channel, text }) => ({ channel, text }));
      if (now >= deadline) return [];
      await new Promise((resolve) => {
        const wake = () => { clearTimeout(timer); this.listenWaiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, Math.min(deadline - Date.now(), 5_000));
        timer.unref?.();
        this.listenWaiters.add(wake);
      });
      this.lastListenAt = Date.now(); // still here, still listening
    }
  }
}
