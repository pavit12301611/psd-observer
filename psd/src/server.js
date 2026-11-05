// server.js — one HTTP surface for every PSD client.
//
//   notch (GNOME)   /psd/chat/stream (SSE) · /psd/status · /psd/notch
//   phone app       /  (Chat / Tasks / Files / More) · /api/*
//   whatsapp        /psd/chat · /psd/reminders · /psd/notify
//   curl / scripts  everything, with a bearer token
//
// Auth: `authorization: Bearer <token>`, `x-psd-token: <token>`, or ?token=.
// Loopback requests are trusted by default (PSD_TRUST_LOOPBACK=false to stop
// that) because the notch and the CLI live on the same machine and a token
// round-trip there would cost latency for no safety.
//
// No framework, no Express, no CORS package: this file is the whole web layer.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_BODY = 24 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
};

const STATIC = {
  '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js',
  '/styles.css': 'styles.css', '/sw.js': 'sw.js', '/manifest.webmanifest': 'manifest.webmanifest',
};

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

function json(res, status, body, extra = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > MAX_BODY) {
      req.resume();
      reject(Object.assign(new Error('Body too large (24 MB max)'), { status: 413 }));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Body too large (24 MB max)'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
        resolve(parsed);
      } catch { reject(Object.assign(new Error('Invalid JSON body: an object is required'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/** Server-sent events with a heartbeat the notch can rely on. */
function sse(res, req) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  let open = true;
  const heartbeat = setInterval(() => {
    if (!open) return;
    try { res.write(': ping\n\n'); } catch { open = false; }
  }, 20_000);
  heartbeat.unref?.();
  req.on('close', () => { open = false; clearInterval(heartbeat); });
  return {
    send(event, data) {
      if (!open) return false;
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); return true; } catch { open = false; return false; }
    },
    close() { clearInterval(heartbeat); if (open) { open = false; try { res.end(); } catch { /* gone */ } } },
    get open() { return open; },
  };
}

export function createServer({ config, engine, tools, memory, agents, notch, whatsapp, router, openai, registry, bus, log = console }) {
  const clients = new Set();

  /** Fan an event out to every stream that asked for it. */
  function publish(event, data) {
    for (const client of clients) {
      if (!client.open) { clients.delete(client); continue; }
      if (client.scope === 'chat') continue;                 // chat streams carry only their own events
      if (client.filter && !client.filter.includes(event)) continue;
      client.send(event, data);
    }
  }

  const allowlist = () => String(config.corsOrigin ?? '')
    .split(',').map((origin) => origin.trim()).filter((origin) => origin && origin !== '*');

  /**
   * A browser must not be able to drive the agent from another origin.
   *
   * Non-browser clients (curl, the CLI, GNOME's Soup, Node, the WhatsApp agent)
   * send no Origin header at all. A page does — and a page from a random site
   * can reach http://127.0.0.1 through DNS rebinding or a plain cross-origin
   * POST. So: an Origin header is only accepted when it matches the host we
   * were reached on, or an explicitly allowlisted origin.
   */
  const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);
  const hostName = (value) => String(value ?? '').toLowerCase().replace(/:\d+$/, '');

  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;                       // not a browser
    if (String(config.corsOrigin).trim() === '*') return true;   // explicit opt-out
    try {
      const parsed = new URL(origin);
      if (allowlist().includes(parsed.origin)) return true;
      const host = String(req.headers.host ?? '').toLowerCase();
      if (!host) return false;
      // Same host:port is always fine.
      if (parsed.host.toLowerCase() === host) return true;
      // A loopback origin talking to a loopback host is still same-machine:
      // `localhost` and `127.0.0.1` are the same box, and the notch, the CLI and
      // the phone proxy all spell it differently.
      const requestHost = hostName(host);
      return LOOPBACK_NAMES.has(hostName(parsed.hostname)) && LOOPBACK_NAMES.has(requestHost) &&
        (parsed.port || '80') === (host.split(':')[1] || '80');
    } catch {
      return false;
    }
  }

  function tokenOk(req, url) {
    const header = req.headers.authorization || '';
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    // The query form exists for the printed phone-app link (`psd url`). It is
    // the weakest of the three, so cross-origin browser requests may not use it.
    const query = req.headers.origin ? null : url.searchParams.get('token');
    const candidates = [bearer, req.headers['x-psd-token'], query];
    return candidates.some((value) => typeof value === 'string' && value && safeEqual(value, config.token));
  }

  function authorised(req, url) {
    if (tokenOk(req, url)) return true;
    const remote = req.socket.remoteAddress ?? '';
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return false;
    // The notch and the CLI live on this machine; a token round-trip there
    // costs latency for no safety. A browser on this machine is still refused
    // because it always sends an Origin header.
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    return Boolean(config.trustLoopback && loopback && !req.headers.origin);
  }

  function serveStatic(req, res, url, name) {
    const file = path.join(config.webDir, name);
    try {
      const body = fs.readFileSync(file);
      const type = MIME[path.extname(file)] ?? 'application/octet-stream';
      const tag = `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
      if (req.headers['if-none-match'] === tag) { res.writeHead(304, { etag: tag }); return res.end(); }
      res.writeHead(200, {
        'content-type': type, 'content-length': body.length, etag: tag,
        'cache-control': name === 'sw.js' ? 'no-cache' : 'no-cache',
        'x-content-type-options': 'nosniff',
      });
      return res.end(body);
    } catch {
      return json(res, 404, { error: 'not_found', detail: `web/${name} is missing from the install.` });
    }
  }

  /** System snapshot, cached for a second so a polling notch is free. */
  let snapshotCache = { at: 0, value: null };
  async function snapshot() {
    if (Date.now() - snapshotCache.at < 1000 && snapshotCache.value) return snapshotCache.value;
    const value = await tools.byName.get('system_status') ? await (async () => {
      const mod = await import('./tools.js');
      return mod.systemSnapshot();
    })() : null;
    snapshotCache = { at: Date.now(), value };
    return value;
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`); }
    catch { return json(res, 400, { error: 'bad_url' }); }

    const origin = req.headers.origin;
    if (origin && allowlist().includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-headers', 'content-type, authorization, x-psd-token');
      res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('vary', 'origin');
    }
    if (req.method === 'OPTIONS') {
      // A preflight from an origin we do not allow must fail, not silently
      // succeed and then be rejected on the real request.
      if (origin && !originAllowed(req)) { res.writeHead(403); return res.end(); }
      res.writeHead(204); return res.end();
    }
    if (!originAllowed(req)) {
      return json(res, 403, {
        error: 'origin_refused',
        detail: `Requests from ${origin} are refused. Add it to PSD_CORS_ORIGIN if it is your own app.`,
      });
    }

    const route = `${req.method} ${url.pathname}`;

    try {
      // ── public ───────────────────────────────────────────────────────────
      if (route === 'GET /health') {
        return json(res, 200, {
          ok: true, service: 'psd', version: config.version,
          brain: engine.healthy ? (engine.chosen?.model ?? 'configured') : 'offline-intents',
          notch: notch.info.available, whatsapp: whatsapp.info.linked,
          uptime: Math.round((Date.now() - config.startedAt) / 1000),
        });
      }
      if (req.method === 'GET' && STATIC[url.pathname]) return serveStatic(req, res, url, STATIC[url.pathname]);

      if (url.pathname === '/psd/healthz') return json(res, 200, { ok: true });

      if (!authorised(req, url)) {
        return json(res, 401, {
          error: 'unauthorised',
          detail: 'Send `authorization: Bearer <token>`, `x-psd-token: <token>` or `?token=`. The token is in ' + path.join(config.dataDir, 'token.txt') + ' (and printed by `psd token`).',
        });
      }

      // ── OpenAI-compatible surface ────────────────────────────────────────
      // Point the WhatsApp agent's LOCAL_API_URL here and every WhatsApp model
      // call becomes PSD: same tools, same permissions, same memory.
      if (route === 'GET /v1/models' || route === 'GET /psd/v1/models') {
        return json(res, 200, openai.models());
      }
      if (route === 'POST /v1/chat/completions' || route === 'POST /psd/v1/chat/completions') {
        const body = await readBody(req);
        if (body.stream) {
          // OpenAI's SSE shape is bare `data:` lines — no `event:` prefix — so a
          // stock client (and the WhatsApp agent) parses it without patches.
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          });
          const write = (payload) => {
            try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* gone */ }
          };
          try {
            await openai.streamCompletions(body, write, { signal: null });
            write('[DONE]');
          } catch (err) {
            write({ error: { message: err.message, type: 'psd_error' } });
          }
          return res.end();
        }
        const result = await openai.completions(body);
        return json(res, 200, result);
      }
      if (route === 'POST /psd/whatsapp/forward') {
        const body = await readBody(req);
        const result = await openai.forward(body);
        if (body.notify) notch.show({ title: 'WhatsApp', body: result.text.slice(0, 300), tab: 'chat' });
        return json(res, 200, result);
      }

      // ── chat ─────────────────────────────────────────────────────────────
      if (route === 'POST /psd/chat' || route === 'POST /psd/notch') {
        const body = await readBody(req);
        const text = String(body.text ?? body.message ?? url.searchParams.get('text') ?? '').slice(0, 16_000);
        if (!text.trim()) return json(res, 400, { error: 'text_required' });
        const result = await router.turn(text, {
          source: body.source ?? (url.pathname === '/psd/notch' ? 'notch' : 'api'),
          thread: body.thread ?? 'chat',
          voice: Boolean(body.voice),
        });
        if (body.notify !== false && url.pathname === '/psd/notch') {
          notch.show({ title: result.path === 'approval' ? 'Needs approval' : 'PSD', body: result.text.slice(0, 400), tab: 'chat' });
        }
        if (body.reply !== false && (body.replyToWhatsApp || body.whatsapp)) whatsapp.send(result.text);
        return json(res, 200, result);
      }

      // Streaming turn: the notch and the web UI use this so text appears as
      // the model produces it, not after the last token.
      if (route === 'POST /psd/chat/stream' || route === 'GET /psd/chat/stream') {
        const body = req.method === 'POST' ? await readBody(req) : {};
        const text = String(body.text ?? url.searchParams.get('text') ?? '').slice(0, 16_000);
        if (!text.trim()) return json(res, 400, { error: 'text_required' });
        const stream = sse(res, req);
        stream.scope = 'chat';
        clients.add(stream);
        const started = Date.now();
        let tokens = 0;
        stream.send('start', { at: started, source: body.source ?? 'notch' });
        try {
          const result = await router.turn(text, {
            source: body.source ?? 'notch',
            thread: body.thread ?? 'chat',
            onToken: (chunk) => { tokens += 1; stream.send('token', { text: chunk }); },
            onImage: (image) => stream.send('image', { image }),
          });
          stream.send('done', { ...result, tokens, ms: result.ms ?? Date.now() - started });
        } catch (err) {
          stream.send('error', { detail: err.message });
        } finally {
          clients.delete(stream);
          stream.close();
        }
        return;
      }

      // ── status ───────────────────────────────────────────────────────────
      if (route === 'GET /psd/status') {
        let probe = engine.lastProbe;
        if (url.searchParams.get('probe') === '1' || !probe) probe = await engine.probe({ deep: url.searchParams.get('deep') === '1' });
        const snap = await snapshot();
        return json(res, 200, {
          ok: true,
          agent: 'psd',
          version: config.version,
          agentId: agents.agent(config.agent)?.id ?? config.agent,
          agentName: agents.agent(config.agent)?.name ?? config.agent,
          host: config.hostname,
          platform: config.platform,
          uptimeSec: Math.round((Date.now() - config.startedAt) / 1000),
          brain: {
            active: probe?.brain ?? null,
            model: engine.chosen?.model ?? probe?.model ?? null,
            healthy: engine.healthy,
            brains: probe?.brains ?? [],
            deepLatencyMs: probe?.deepLatencyMs ?? null,
          },
          surfaces: {
            notch: notch.info,
            whatsapp: whatsapp.info,
            web: { url: `http://${os.hostname()}:${config.port}/`, port: config.port },
          },
          access: tools.accessReport(),
          agents: agents.agents.map((a) => ({ id: a.id, name: a.name, description: a.description })),
          skills: agents.skills.map((s) => ({ id: s.id, name: s.name, description: s.description, tags: s.tags })),
          system: snap,
          stats: memory.data.stats,
          reminders: memory.reminders().length,
          pending: tools.pending.list(),
        });
      }

      if (route === 'GET /psd/system') {
        const snap = await snapshot();
        notch.system(snap).catch?.(() => {});
        return json(res, 200, snap);
      }

      if (route === 'GET /psd/agents') {
        return json(res, 200, {
          agents: agents.agents.map((a) => ({ id: a.id, name: a.name, description: a.description, tools: a.tools, file: a.file })),
          skills: agents.skills.map((s) => ({ id: s.id, name: s.name, description: s.description, tags: s.tags, file: s.file })),
        });
      }

      if (route === 'GET /psd/tools') {
        return json(res, 200, { level: tools.level(), tools: tools.schemas(), pending: tools.pending.list() });
      }

      if (route === 'GET /psd/traces') {
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 20));
        return json(res, 200, { traces: memory.recentTraces(limit) });
      }

      // ── notch ring (polling fallback when D-Bus is unavailable) ──────────
      if (route === 'GET /psd/notch') {
        const since = Number(url.searchParams.get('since')) || 0;
        const wait = Math.min(25_000, Math.max(0, Number(url.searchParams.get('wait')) || 0));
        if (!wait) return json(res, 200, { seq: notch.seq, events: notch.events(since), notch: notch.info });
        const deadline = Date.now() + wait;
        while (Date.now() < deadline) {
          const events = notch.events(since);
          if (events.length) return json(res, 200, { seq: notch.seq, events, notch: notch.info });
          await new Promise((r) => setTimeout(r, 400));
        }
        return json(res, 200, { seq: notch.seq, events: [], notch: notch.info });
      }

      if (route === 'POST /psd/notch/message') {
        const body = await readBody(req);
        const delivered = await notch.push({ ...body, kind: body.kind ?? 'card' });
        return json(res, 200, { ok: true, delivered });
      }

      if (route === 'GET /psd/events') {
        const stream = sse(res, req);
        const filter = (url.searchParams.get('events') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        stream.filter = filter.length && !filter.includes('all') ? filter : null;
        clients.add(stream);
        stream.send('ready', { at: Date.now(), seq: notch.seq });
        req.on('close', () => clients.delete(stream));
        return;
      }

      // ── tools, approvals, actions ────────────────────────────────────────
      if (route === 'POST /psd/tool') {
        const body = await readBody(req);
        const name = String(body.tool ?? body.name ?? '');
        if (!name) return json(res, 400, { error: 'tool_required' });
        const result = await tools.execute(name, body.args ?? body.arguments ?? {}, { source: 'api', confirmed: body.confirmed === true });
        return json(res, 200, result);
      }

      if (route === 'GET /psd/approvals') return json(res, 200, { pending: tools.pending.list() });

      if (route === 'POST /psd/approve') {
        const body = await readBody(req);
        if (!body.id) return json(res, 400, { error: 'id_required' });
        if (body.approve === false) {
          tools.pending.queue.delete(String(body.id));
          return json(res, 200, { ok: true, cancelled: true });
        }
        const result = await tools.approve(String(body.id));
        notch.show({ title: result.ok ? 'Done' : 'Failed', body: (result.text ?? '').slice(0, 300), tab: 'chat' });
        return json(res, 200, result);
      }

      if (route === 'POST /psd/action') {
        const body = await readBody(req);
        const result = await tools.execute(String(body.tool ?? body.name ?? ''), body.args ?? {}, { source: 'api' });
        return json(res, 200, result);
      }

      // ── memory, reminders ────────────────────────────────────────────────
      if (route === 'GET /psd/memory') return json(res, 200, { facts: memory.facts(), reminders: memory.reminders(), episodes: memory.data.episodes ?? [] });
      if (route === 'POST /psd/memory') {
        const body = await readBody(req);
        if (body.forget) return json(res, 200, { ok: memory.forget(String(body.forget)) });
        if (!body.key || body.value === undefined) return json(res, 400, { error: 'key_and_value_required' });
        return json(res, 200, { ok: true, fact: memory.remember(String(body.key), String(body.value)) });
      }
      if (route === 'GET /psd/reminders') return json(res, 200, { reminders: memory.reminders() });
      if (route === 'POST /psd/reminders') {
        const body = await readBody(req);
        const { parseWhen } = await import('./tools.js');
        const at = body.at ? Number(body.at) : parseWhen(body.when ?? '');
        if (!body.text || !at) return json(res, 400, { error: 'text_and_when_required', hint: 'when: 25m, 2h, 18:30, ISO' });
        const id = memory.addReminder(String(body.text), at);
        return json(res, 200, { ok: true, id, at });
      }
      if (route === 'DELETE /psd/reminders') {
        const id = url.searchParams.get('id');
        const done = id ? memory.completeReminder(id) : null;
        return json(res, 200, { ok: Boolean(done) });
      }

      // ── whatsapp (explicit, never implicit) ──────────────────────────────
      if (route === 'POST /psd/whatsapp') {
        const body = await readBody(req);
        const text = String(body.text ?? '').slice(0, 8000);
        if (!text.trim()) return json(res, 400, { error: 'text_required' });
        const result = await whatsapp.send(text, { image: body.image ?? null });
        return json(res, result.ok ? 200 : 502, result);
      }
      if (route === 'GET /psd/whatsapp') {
        const status = await whatsapp.status({ fresh: true });
        return json(res, 200, { ...whatsapp.info, status });
      }

      // ── engine control ───────────────────────────────────────────────────
      if (route === 'GET /psd/brains') {
        const probe = await engine.probe({ deep: url.searchParams.get('deep') === '1' });
        return json(res, 200, probe);
      }
      if (route === 'POST /psd/probe') {
        const probe = await engine.probe({ deep: true });
        return json(res, 200, probe);
      }

      // ── files for the phone app ──────────────────────────────────────────
      if (route === 'GET /psd/file') {
        const wanted = url.searchParams.get('path') ?? '';
        if (!wanted) return json(res, 400, { error: 'path_required' });
        const result = await tools.execute('read_file', { path: wanted, max_bytes: 200_000 }, { source: 'web' });
        if (!result.ok) return json(res, 400, { error: 'unreadable', detail: result.text });
        const resolved = path.resolve(wanted.replace(/^~/, os.homedir()));
        res.writeHead(200, {
          'content-type': MIME[path.extname(resolved)] ?? 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        });
        return res.end(result.text);
      }

      return json(res, 404, { error: 'not_found', path: url.pathname });
    } catch (err) {
      const status = err.status ?? 500;
      log.warn?.(`[server] ${route}: ${err.message}`);
      if (!res.headersSent) return json(res, status, { error: 'request_failed', detail: err.message });
      try { res.end(); } catch { /* gone */ }
    }
  });

  // Live status for dashboards: every bus event goes out to SSE listeners.
  bus.subscribe?.((event) => {
    publish(event.type ?? 'event', event);
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return {
    server,
    publish,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => resolve(server.address()));
    }),
    close: () => new Promise((resolve) => {
      // SSE clients hold their sockets open on purpose. Closing must not wait
      // for them: kill the live ones, then stop accepting.
      for (const client of clients) { try { client.close(); } catch { /* gone */ } }
      clients.clear();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
