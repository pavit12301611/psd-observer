// server.js — the local HTTP bridge + installable phone app (PWA).
//
// This is what the Observer app talks to instead of https://api.observer-ai.com:
//   POST /tools/send-whatsapp   Observer agents' sendWhatsapp(), free + unlimited
//   GET  /remote/listen         long-poll mailbox (patched app/src/mcp/remote.ts)
//   POST /remote/reply          MCP answers coming back to WhatsApp
//   GET  /remote/status         "is the phone linked?"
//
// And it is a complete control panel of its own — no Observer needed:
//   GET  /                      installable phone app (chat + controls + files)
//   POST /api/login             dashboard PIN → token
//   POST /api/chat              talk to the agent from the app
//   GET  /api/status            live status for the app
//   GET  /api/brains            which free model serves what (workload routing)
//   GET  /api/files             received + shared files
//   POST /api/action            run a single action directly
//   POST /api/send              send a message to the owner on WhatsApp
//
// Security: binds 0.0.0.0 so your phone on the same Wi-Fi can use it, but
// every data route needs the bridge token (or the PIN to get one). Login is
// rate-limited. Sending to any number other than the owner is refused.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { maskNumber, normalizeNumber } from './allowlist.js';
import { ROOT } from './config.js';
import { cachedIcon } from './webapp.js';
import * as apps from './apps.js';
import * as files from './files.js';
import { routerFor } from './router.js';

const MAX_BODY = 30 * 1024 * 1024;
const VERSION = '2.4.1';
const WEB_DIR = path.join(ROOT, 'webapp');

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
};

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Request body too large (30 MB max)'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('Invalid JSON body'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const stripDataPrefix = (b64) => (typeof b64 === 'string' && b64.includes(',') && b64.startsWith('data:') ? b64.slice(b64.indexOf(',') + 1) : b64);
const dataUrl = (buffer, mime = 'image/png') => `data:${mime};base64,${Buffer.from(buffer).toString('base64')}`;

/** Shape an agent reply for the phone app. */
export function replyForApp(reply) {
  if (reply == null) return { ok: true, text: '' };
  if (typeof reply === 'string') return { ok: true, text: reply };
  const out = { ok: true, text: reply.text ?? '' };
  const images = [];
  if (reply.image) images.push(dataUrl(reply.image));
  for (const extra of reply.extraImages ?? []) images.push(dataUrl(extra));
  if (images.length) out.images = images;
  if (reply.document) {
    out.documentName = reply.document.fileName;
    if (reply.document.path) out.documentPath = reply.document.path;
  }
  if (reply.video) out.videoName = 'screen-recording.mp4';
  if (reply.audio) {
    out.audio = dataUrl(reply.audio, reply.mimetype ?? 'audio/ogg');
    out.audioMimetype = reply.mimetype;
  }
  if (reply.poll) out.text = `📊 ${reply.poll.name}\n${reply.poll.values.map((v) => `• ${v}`).join('\n')}`;
  return out;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function createBridgeServer({ config, store, whatsapp, mailbox, actions, runOwner, log = console }) {
  const authed = (req, url) => {
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    return req.headers['x-bridge-token'] === config.bridgeToken || bearer === config.bridgeToken || url.searchParams.get('t') === config.bridgeToken;
  };

  const loginAttempts = new Map(); // ip → {count, resetAt}
  function loginAllowed(ip) {
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (!entry || entry.resetAt < now) {
      loginAttempts.set(ip, { count: 0, resetAt: now + 5 * 60_000 });
      return true;
    }
    return entry.count < 12;
  }
  function recordLogin(ip) {
    const entry = loginAttempts.get(ip) ?? { count: 0, resetAt: Date.now() + 5 * 60_000 };
    entry.count += 1;
    loginAttempts.set(ip, entry);
  }

  function json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' });
    res.end(payload);
  }

  async function sendPayload({ message, text, images, videos, mediaUrls, media_urls }) {
    const body = String(message ?? text ?? '');
    const imgs = (images ?? []).slice(0, 5).map((b64) => Buffer.from(stripDataPrefix(b64), 'base64'));
    const vids = (videos ?? []).slice(0, 2).map((b64) => Buffer.from(stripDataPrefix(b64), 'base64'));
    const hosted = (mediaUrls ?? media_urls ?? []).filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)).slice(0, 5);
    if (!imgs.length && !vids.length && hosted.length) {
      await whatsapp.sendToOwner({ imageUrls: hosted, text: body || 'Media from Observer AI' });
      return;
    }
    if (imgs.length) {
      await whatsapp.sendToOwner({ image: imgs[0], extraImages: imgs.slice(1), text: body || 'Media from Observer AI' });
    } else if (vids.length) {
      await whatsapp.sendToOwner({ video: vids[0], text: body || 'Video from Observer AI' });
    } else {
      await whatsapp.sendToOwner(body || 'Alert from Observer AI');
    }
  }

  function listShared() {
    try {
      return fs.readdirSync(config.sharedDir)
        .map((name) => {
          const full = path.join(config.sharedDir, name);
          const stat = fs.statSync(full);
          return stat.isFile() ? { name, path: full, size: stat.size } : null;
        })
        .filter(Boolean)
        .slice(0, 100);
    } catch {
      return [];
    }
  }

  function listDownloads() {
    return (store.data.downloads ?? []).slice(0, 60).map((d) => ({
      name: d.file,
      file: d.file,
      kind: d.kind,
      ts: d.ts,
      path: path.join(config.downloadsDir, d.file),
    }));
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const route = `${req.method} ${url.pathname}`;
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, authorization, x-bridge-token');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    try {
      // ── public: health, app shell, icons ─────────────────────────────────
      if (route === 'GET /health') {
        return json(res, 200, {
          ok: true,
          service: 'observer-whatsapp-agent',
          version: VERSION,
          whatsapp: whatsapp.status(),
          owner: maskNumber(config.ownerNumber),
          agent: maskNumber(config.agentNumber),
          observerTabConnected: mailbox.observerOnline(),
        });
      }

      if (req.method === 'GET' && url.pathname === '/dashboard') {
        res.writeHead(302, { location: `/${url.search}` });
        return res.end();
      }

      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        try {
          const body = fs.readFileSync(path.join(WEB_DIR, file));
          res.writeHead(200, {
            'content-type': type,
            'content-length': body.length,
            'cache-control': file === 'sw.js' ? 'no-cache' : 'public, max-age=300',
          });
          return res.end(body);
        } catch {
          return json(res, 404, { detail: 'App shell missing on disk (webapp/ folder).' });
        }
      }

      if (req.method === 'GET' && (url.pathname === '/icon-192.png' || url.pathname === '/icon-512.png' || url.pathname === '/apple-touch-icon.png')) {
        const size = url.pathname.includes('512') ? 512 : 192;
        const png = cachedIcon(size);
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'public, max-age=86400' });
        return res.end(png);
      }

      if (route === 'POST /api/login') {
        const ip = req.socket.remoteAddress ?? 'unknown';
        if (!loginAllowed(ip)) return json(res, 429, { detail: 'Too many attempts. Wait 5 minutes.' });
        const body = await readJsonBody(req);
        const pin = String(body.pin ?? '');
        const ok = pin && (safeEqual(pin, config.dashboardPin) || safeEqual(pin, config.bridgeToken));
        if (!ok) {
          recordLogin(ip);
          return json(res, 401, { detail: 'Wrong PIN. It is printed in the agent console at startup.' });
        }
        loginAttempts.delete(ip);
        return json(res, 200, { ok: true, token: config.bridgeToken });
      }

      if (route === 'GET /qr.png') {
        if (!authed(req, url)) return json(res, 401, { detail: 'Bridge token required (add ?t=<token> — printed in the agent console).' });
        try {
          const png = fs.readFileSync(config.qrPngFile);
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
          return res.end(png);
        } catch { return json(res, 404, { detail: 'No QR right now — either already linked, or WhatsApp is still connecting.' }); }
      }

      if (!authed(req, url)) {
        return json(res, 401, { detail: 'Bridge token required (x-bridge-token header, Bearer, or the dashboard PIN via /api/login). It is printed when the agent starts.' });
      }

      switch (route) {
        case 'GET /api/brains': {
          const router = routerFor(config, console);
          return json(res, 200, {
            ...router.snapshot(),
            tierBudgets: { tiny: 2, light: 3, standard: 5, heavy: 8 },
            model: config.ollamaModel,
          });
        }

        case 'GET /api/status':
          return json(res, 200, {
            version: VERSION,
            whatsapp: whatsapp.status(),
            owner: config.ownerNumber,
            agent: config.agentNumber,
            pairingCode: whatsapp.state.pairingCode,
            hasQr: Boolean(whatsapp.state.lastQr),
            observerTabConnected: mailbox.observerOnline(),
            forwardToObserver: config.forwardToObserver,
            allowSimulate: config.allowSimulate,
            access: actions?.accessReport?.() ?? { level: config.accessLevel },
            agentTools: Boolean(config.agentTools),
            model: config.ollamaModel,
            brains: routerFor(config, console).catalog.map((m) => ({
              id: m.id, label: m.label, local: m.local, vision: m.vision,
              tiers: [m.minTier, m.maxTier], quality: m.quality,
            })),
            stats: store.data.stats,
            reminders: store.data.reminders.length,
            cronJobs: (store.data.cronJobs ?? []).length,
            openTodos: store.data.todos.filter((t) => !t.done).length,
            notes: store.data.notes.length,
            pending: store.data.pending ? { text: store.data.pending.text, ts: store.data.pending.ts } : null,
          });

        case 'POST /api/chat': {
          const body = await readJsonBody(req);
          const text = String(body.text ?? '').slice(0, 4000);
          if (!text.trim()) return json(res, 400, { detail: 'text is required' });
          if (body.from && normalizeNumber(body.from) !== config.ownerNumber) {
            return json(res, 403, { detail: 'This agent only listens to the owner.' });
          }
          if (!runOwner) return json(res, 503, { detail: 'Agent is still starting up.' });
          const reply = await runOwner(text);
          return json(res, 200, replyForApp(reply));
        }

        case 'POST /api/action': {
          if (!actions) return json(res, 503, { detail: 'Actions are not ready yet.' });
          const body = await readJsonBody(req);
          const result = await actions.execute(String(body.name ?? ''), body.args ?? {}, { source: 'app' });
          return json(res, 200, replyForApp(result));
        }

        case 'GET /api/download': {
          // Authenticated file download for the phone app ("Send" in chat).
          const wanted = url.searchParams.get('path') ?? '';
          const resolved = files.resolvePath(wanted, { extraRoots: config.filesExtraRoots ?? [], mustExist: true });
          if (!resolved.ok) return json(res, 400, { detail: resolved.reason });
          const stat = fs.statSync(resolved.path);
          if (stat.isDirectory()) return json(res, 400, { detail: 'That path is a folder, not a file.' });
          res.writeHead(200, {
            'content-type': files.mimeFor(resolved.path),
            'content-length': stat.size,
            'content-disposition': `attachment; filename="${encodeURIComponent(path.basename(resolved.path))}"`,
            'cache-control': 'no-store',
          });
          const stream = fs.createReadStream(resolved.path);
          stream.on('error', (err) => {
            log.error?.(`[bridge] download failed: ${err.message}`);
            if (!res.headersSent) json(res, 500, { detail: err.message });
            else res.destroy(err);
          });
          return stream.pipe(res);
        }

        case 'GET /api/files':
          return json(res, 200, { downloads: listDownloads(), shared: listShared() });

        case 'GET /api/apps':
          try {
            return json(res, 200, { apps: apps.appList(apps.discoverApps(), 200).map((a) => ({ id: a.id, name: a.name })) });
          } catch (err) {
            return json(res, 200, { apps: [], detail: err.message });
          }

        case 'POST /api/send': {
          await sendPayload(await readJsonBody(req));
          return json(res, 200, { success: true });
        }

        case 'POST /tools/send-whatsapp': {
          const body = await readJsonBody(req);
          // Owner-only also on the way out: a phone-number `to_number` must be
          // the owner's. Observer-code strings (anchor-apple-…) are accepted
          // and, like the cloud, resolve to the owner's phone — which here is
          // simply the one configured owner.
          const asNumber = normalizeNumber(body.to_number ?? '');
          if (/^\+?\d[\d\s-]{8,}$/.test(String(body.to_number ?? '')) && asNumber !== config.ownerNumber) {
            return json(res, 403, { detail: 'Native WhatsApp bridge is owner-only: it sends solely to the configured OWNER_NUMBER.' });
          }
          await sendPayload(body);
          return json(res, 200, { success: true, message_sid: 'native-whatsapp' });
        }

        case 'POST /tools/is-whitelisted':
          return json(res, 200, { success: true, whitelisted: true, is_whitelisted: true, linked: true, channel: 'whatsapp' });

        case 'GET /remote/listen':
        case 'GET /remote/inbox':
          return json(res, 200, { messages: await mailbox.listen(25_000) });

        case 'GET /remote/status':
          return json(res, 200, {
            linked: whatsapp.status().startsWith('connected') || config.dryRun,
            name: `Native WhatsApp (+${maskNumber(config.agentNumber)})`,
            revoked: false,
          });

        case 'POST /remote/reply': {
          const body = await readJsonBody(req);
          const text = String(body.text ?? '').slice(0, 4000);
          if (!text && !(body.images?.length)) return json(res, 400, { detail: 'text is required' });
          const images = (body.images ?? []).slice(0, 3).map(stripDataPrefix);
          const how = mailbox.deliverReply({ text, images });
          if (how === 'direct') await sendPayload({ message: text, images });
          return json(res, 200, { success: true, deliveredVia: how });
        }

        case 'POST /api/simulate': {
          if (!config.allowSimulate) return json(res, 403, { detail: 'Simulate is off. Set ALLOW_SIMULATE=true (or use --dry-run) to enable it.' });
          const body = await readJsonBody(req);
          const result = await whatsapp.simulate(String(body.text ?? ''), body.from ? normalizeNumber(body.from) : config.ownerNumber);
          return json(res, 200, result);
        }

        default:
          return json(res, 404, { detail: `No such route: ${route}` });
      }
    } catch (err) {
      log.error?.(`[bridge] ${route} failed: ${err.message}`);
      return json(res, err.status ?? 500, { detail: err.message });
    }
  });

  return {
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            reject(new Error(`Port ${config.port} is already in use. Another copy of the agent is probably running — check \`./start.sh --status\` / \`systemctl --user status observer-whatsapp-agent\`, or set PORT=<other> in .env.`));
          } else if (err.code === 'EACCES') {
            reject(new Error(`Not allowed to bind ${config.host}:${config.port}. Use a port above 1024 (PORT=8787).`));
          } else {
            reject(new Error(`Could not start the local bridge: ${err.message}`));
          }
        });
        server.listen(config.port, config.host, () => {
          const shownHost = config.host === '0.0.0.0' ? 'PC-IP' : config.host;
          log.info?.(`[bridge] listening on http://${config.host}:${config.port}`);
          log.info?.(`[bridge] phone app: http://${shownHost}:${config.port}/  (PIN: ${config.dashboardPin})`);
          log.info?.(`[bridge] direct link (keep private): http://${shownHost}:${config.port}/?t=${config.bridgeToken}`);
          log.info?.(`[bridge] token: ${config.bridgeToken}`);
          resolve(server);
        });
        server.on('error', (err) => log.error?.(`[bridge] server error: ${err.message}`));
      });
    },
    stop() { server.close(); },
  };
}
