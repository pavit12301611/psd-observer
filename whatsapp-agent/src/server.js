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
import os from 'node:os';
import { createAppMedia } from './appbridge.js';
import { createMobilePlatform } from './mobile/platform.js';
import { mobileRoute } from './mobile/routes.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { maskNumber, normalizeNumber } from './allowlist.js';
import { ROOT } from './config.js';
import { cachedIcon } from './webapp.js';
import * as apps from './apps.js';
import { resolveRecipient, listContacts, ensureGuestStore } from './guests.js';
import * as files from './files.js';
import * as pc from './pccontrol.js';
import * as hands from './hands.js';
import { pngSize } from './elementfinder.js';
import { routerFor } from './router.js';
import * as solver from './solver.js';
import * as tts from './tts.js';
import { transcribeAudio, transcriptionAvailable } from './transcribe.js';

const MAX_BODY = 30 * 1024 * 1024;
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const WEB_DIR = path.join(ROOT, 'webapp');

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/desktop': ['desktop.html', 'text/html; charset=utf-8'],
  '/desktop.js': ['desktop.js', 'text/javascript; charset=utf-8'],
  '/desktop.css': ['desktop.css', 'text/css; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
};

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > MAX_BODY) { req.resume(); reject(Object.assign(new Error('Request body too large (30 MB max)'), { status: 413 })); return; }
    let size = 0, tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY) { tooLarge = true; chunks.length = 0; reject(Object.assign(new Error('Request body too large (30 MB max)'), { status: 413 })); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        const body = JSON.parse(raw);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('JSON object required');
        resolve(body);
      } catch { reject(Object.assign(new Error('Invalid JSON body: expected an object'), { status: 400 })); }
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
  const out = { ok: reply.ok !== false, text: reply.text ?? (typeof reply.error === 'string' ? reply.error : reply.error?.message) ?? '' };
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
  if (typeof reply.spoken === 'string') out.spoken = reply.spoken.slice(0,2200);
  if (reply.poll) out.text = `📊 ${reply.poll.name}\n${reply.poll.values.map((v) => `• ${v}`).join('\n')}`;
  return out;
}

/** Strong ETag for one frame, so an unchanged screen costs no bandwidth. */
/**
 * `?cx=&cy=&cw=&ch=` in 0-1000 normalised screen space. The `c` prefix keeps
 * these clear of `w` (the frame width) and of old clients that send neither.
 * Missing or nonsensical values mean "no crop", so nothing breaks.
 */
export function readCrop(params) {
  const num = (name) => {
    const raw = params.get(name);
    if (raw === null || raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const x = num('cx'), y = num('cy'), w = num('cw'), h = num('ch');
  if ([x, y, w, h].some((value) => value === null)) return null;
  if (w < 20 || h < 20 || x < 0 || y < 0 || x > 1000 || y > 1000 || x + w > 1000 || y + h > 1000) return null;
  return { x, y, w, h };
}

export function screenTag(buffer) {
  return `"${crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 20)}"`;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function createBridgeServer({
  config, store, whatsapp, mailbox, actions, harness = null, voice = null, wavoip = null, runOwner, log = console,
  // Injectable so tests never touch a real desktop, and so the number of
  // screenshots per request is explicit and measurable.
  screen = null, app = null, system = null,
}) {
  // Remote-session awareness + clipboard. Injectable like `screen`, so tests
  // exercise the routes without a desktop.
  const sys = system ?? {
    state: () => pc.remoteSessionState(),
    wake: () => pc.wakeDisplay(),
    clipboardRead: () => pc.clipboardRead(),
    clipboardWrite: (text) => pc.clipboardWrite(text),
  };
  let mobile = null;
  try { mobile = createMobilePlatform({ config, app, runOwner, voice, normalise: replyForApp, solve: solveJob }); }
  catch { log.error?.('[mobile] Private mobile state could not be loaded; new mobile APIs fail closed. Existing owner commands are still available.'); }
  async function solveJob(input) {
    const upload = input.upload, buffer = Buffer.from(upload.base64, 'base64');
    const mime = upload.mime, document = mime === 'application/pdf' || /\.(pdf|docx|txt)$/i.test(upload.name);
    if (!config.downloadsDir) throw new Error('Downloads folder is not configured');
    fs.mkdirSync(config.downloadsDir, { recursive: true, mode: 0o700 });
    const clean = String(upload.name).replace(/[^\w.\- ]/g, '_'), name = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}-${clean}`;
    const savedPath = path.join(config.downloadsDir, name);
    fs.writeFileSync(savedPath, buffer, { mode: 0o600, flag: 'wx' });
    store.addDownload?.({ file: name, kind: document ? 'document' : 'image', ts: Date.now(), caption: input.text });
    const result = document ? await solver.solveQuestionDocument(config, buffer, { fileName: name, mimeType: mime, caption: input.text, harness, log }) : await solver.solveQuestionImage(config, buffer, { caption: input.text, autoDetect: false, savedPath, harness, log });
    if (!result.ok) return { ok: false, text: result.error || 'Solver could not complete. No automatic retry.' };
    return { ok: true, text: result.text };
  }
  const media = createAppMedia();
  const appReply = (reply) => media.shape(reply, replyForApp);
  const scr = screen ?? {
    capture: (opts) => pc.captureScreenshot(opts),
    click: (x, y, button, repeat) => pc.click(x, y, button, repeat),
    relative: (x,y) => pc.moveMouseRelative(x,y),
    scroll: (direction,amount) => pc.scrollMouse(direction,amount),
    drag: (x1,y1,x2,y2) => pc.dragMouse(x1,y1,x2,y2),
    key: (combo) => pc.keyCombo(combo),
    type: (text) => pc.typeText(text),
    crop: (buffer, box, opts) => pc.cropFrame(buffer, box, opts),
  };
  // Size of the last frame the phone asked for. A tap then needs ZERO extra
  // screenshots — important on Wayland, where every capture can pop the
  // portal's "share your screen" prompt.
  let lastFrameSize = null;
  function activeJobCount() {
    try { return (mobile?.jobs?.list?.() || []).filter((job) => job.state === 'running').length; } catch { return 0; }
  }
  const principalFor = (req, url) => {
    if (typeof config.bridgeToken !== 'string' || !config.bridgeToken.trim()) return null;
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    // Constant-time: a plain === leaks the token a byte at a time to anything
    // that can time requests on the LAN.
    const tokens = [req.headers['x-bridge-token'], bearer, url.searchParams.get('t')].filter((value) => typeof value === 'string');
    if (tokens.some((candidate) => safeEqual(candidate, config.bridgeToken))) return { id: 'owner', name: 'PC owner', kind: 'owner' };
    for (const value of tokens) { const device = mobile?.devices.authenticate(value); if (device) return device; }
    return null;
  };

  const authed = (req, url) => Boolean(principalFor(req, url));
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
    let url;
    try { url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`); }
    catch { return json(res, 400, { detail: 'Invalid request URL or Host header' }); }
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

      if (route === 'POST /api/app/pair') {
        if (!mobile) return json(res, 503, { detail: 'Private mobile journal unavailable; no pairing/jobs can be safely accepted. Repair PC mobile state without deleting owner data.' });
        if (typeof config.bridgeToken !== 'string' || !config.bridgeToken.trim()) return json(res, 503, { detail: 'Bridge authentication is not configured' });
        const ip = req.socket.remoteAddress || 'unknown';
        if (!loginAllowed(ip)) return json(res, 429, { detail: 'Too many attempts. Wait five minutes.' });
        const b = await readJsonBody(req);
        const allowed = typeof b.code === 'string' ? mobile.devices.consumeCode(b.code) : typeof b.pin === 'string' && b.pin.length > 0 && safeEqual(b.pin, config.dashboardPin);
        if (!allowed) { recordLogin(ip); return json(res, 401, { detail: 'Wrong PIN, or expired/used pairing QR. No device was paired.' }); }
        if (b.serverId && b.serverId !== mobile.devices.serverId) return json(res, 409, { detail: 'QR belongs to another PC identity' });
        const paired = mobile.devices.register(b); loginAttempts.delete(ip);
        // Pairing must keep working even if local signing storage cannot be prepared.
        let update = {};
        try { const key = mobile.updates.key(); update = { updateSigningKey: key.key, updateKeyId: key.keyId, updateKeyAlgorithm: key.algorithm }; }
        catch { update = {}; }
        return json(res, 200, { ...paired, protocol: 2, capabilities: mobile.capabilities(), ...update });
      }
      if (route === 'POST /api/login') {
        if (typeof config.bridgeToken !== 'string' || !config.bridgeToken.trim()) return json(res, 503, { detail: 'Bridge authentication is not configured' });
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

      if (!mobile && !principalFor(req, url) && (req.headers['x-bridge-token'] || req.headers.authorization)) return json(res,503,{detail:'Private mobile state needs repair. The session was not invalidated and no request was replayed.'});
      if (!authed(req, url)) {
        return json(res, 401, { detail: 'Bridge token required (x-bridge-token header, Bearer, or the dashboard PIN via /api/login). It is printed when the agent starts.' });
      }

      if (req.method === 'GET' && /^\/api\/app\/media\/[a-f0-9]{32}$/.test(url.pathname)) {
        const item = media.get(url.pathname.split('/').pop());
        if (!item) return json(res, 404, { detail: 'Attachment expired. Request the file again explicitly if needed.' });
        res.writeHead(200, { 'content-type': item.mime, 'content-length': item.buffer.length, 'content-disposition': `attachment; filename="${encodeURIComponent(item.name)}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return res.end(item.buffer);
      }
      if (mobile && await mobileRoute({ req, res, url, principal: principalFor(req, url), platform: mobile, json, body: readJsonBody, runOwner })) return;
      switch (route) {
        case 'GET /api/app/state':
          if (!app) return json(res, 503, { detail: 'This agent has no structured mobile API. Update the PC agent.' });
          return json(res, 200, { apiVersion: 1, version: VERSION, host: os.hostname(), platform: process.platform, pcControl: Boolean(config.allowPcControl), controlPinRequired: Boolean(config.controlPin), capabilities: mobile?.capabilities() || { jobs: false, error: 'Mobile private-state repair required' }, serverId: mobile?.devices.serverId, ...app.state() });
        case 'POST /api/app/approval': {
          if (!app) return json(res, 503, { detail: 'Structured approvals unavailable. Update the PC agent.' });
          const body = await readJsonBody(req);
          if (typeof body.id !== 'string' || !/^[a-f0-9]{64}$/.test(body.id) || typeof body.approve !== 'boolean') return json(res, 400, { detail: 'Exact approval id and boolean decision required.' });
          const decision = app.decide(body.id, body.approve);
          if (decision.busy) return json(res, 423, { detail: 'An agent task is still settling. Wait or stop it, then review this approval again.' });
          if (decision.stale) return json(res, 409, { detail: 'That request changed, expired or was already resolved. Refresh and review the current action.' });
          return json(res, 200, appReply(await decision.reply));
        }

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
            harness: harness ? harness.status() : null,
            stats: store.data.stats,
            reminders: store.data.reminders.length,
            cronJobs: (store.data.cronJobs ?? []).length,
            openTodos: store.data.todos.filter((t) => !t.done).length,
            notes: store.data.notes.length,
            pending: store.data.pending ? { text: store.data.pending.text, ts: store.data.pending.ts } : null,
          });

        case 'POST /api/chat': {
          const body = await readJsonBody(req);
          const text = String(body.text ?? '');
          if (text.length > 16000) return json(res, 413, { detail: 'Message exceeds the 16000-character mobile limit; nothing was executed.' });
          if (!text.trim()) return json(res, 400, { detail: 'text is required' });
          if (body.from && normalizeNumber(body.from) !== config.ownerNumber) {
            return json(res, 403, { detail: 'This agent only listens to the owner.' });
          }
          if (!runOwner) return json(res, 503, { detail: 'Agent is still starting up.' });
          let history;
          if (body.history !== undefined) {
            if (!Array.isArray(body.history) || body.history.length > 12 || body.history.some((m) => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 4000) || body.history.reduce((n, m) => n + m.content.length, 0) > 40000) return json(res, 400, { detail: 'Invalid bounded conversation history.' });
            history = body.history.map(({ role, content }) => ({ role, content }));
          }
          const reply = await runOwner(text, { source: 'app', isOwner: true, ...(history ? { appHistory: history } : {}) });
          return json(res, 200, appReply(reply));
        }

        // ── JARVIS voice call (phone app 📞 Call tab) ──────────────────────
        // Browser mic → text (SpeechRecognition, or /api/call/transcribe for
        // browsers without it) → the shared voice brain (intents → API-model
        // tool loop → execute) → JARVIS audio back. One round-trip per turn;
        // /api/call/events mirrors live state while long commands run.
        case 'GET /api/voice': {
          const engines = tts.listTTSEngines(config);
          return json(res, 200, {
            ok: true,
            engines: engines.map((e) => ({ name: e.name, label: e.label })),
            best: engines[0]?.label ?? null,
            statusText: tts.ttsStatus(config),
            transcription: transcriptionAvailable(config),
            voiceCall: config.voiceCall !== false,
            callMode: Boolean(store.data.voiceCallMode || config.whatsappVoiceReplies),
            wavoip: wavoip ? wavoip.status() : null,
          });
        }

        case 'POST /api/voice/test': {
          const body = await readJsonBody(req);
          const sample = String(body.text ?? `Good evening, ${config.jarvisAddress || 'Sir'}. This is JARVIS at your service.`).slice(0, 300);
          try {
            const result = await tts.synthesize(sample, config, log);
            return json(res, 200, { ok: true, audio: dataUrl(result.buffer, (result.mimetype || 'audio/ogg').split(';')[0]), mimetype: result.mimetype, engine: result.engine, text: sample });
          } catch (err) {
            return json(res, 503, { ok: false, detail: err.message, speakInBrowser: sample });
          }
        }

        case 'POST /api/call/start': {
          if (!voice) return json(res, 503, { detail: 'Voice engine is not wired in this build.' });
          if (config.voiceCall === false) return json(res, 403, { detail: 'Voice calls are off (VOICE_CALL=false).' });
          const body = await readJsonBody(req);
          const started = await voice.start('app', body.sessionId ? String(body.sessionId) : null, { silent: body.silent === true });
          return json(res, 200, {
            ok: true,
            sessionId: started.sessionId,
            greeting: started.greeting,
            spoken: started.spoken,
            state: started.state,
            audio: started.audio ? dataUrl(started.audio.buffer, (started.audio.mimetype || 'audio/ogg').split(';')[0]) : null,
            audioMimetype: started.audio?.mimetype ?? null,
          });
        }

        case 'POST /api/call/say': {
          if (!voice) return json(res, 503, { detail: 'Voice engine is not wired in this build.' });
          if (config.voiceCall === false) return json(res, 403, { detail: 'Voice calls are off (VOICE_CALL=false).' });
          const body = await readJsonBody(req);
          const text = String(body.text ?? '').slice(0, 4000);
          if (!text.trim()) return json(res, 400, { detail: 'text is required' });
          if (body.from && normalizeNumber(body.from) !== config.ownerNumber) {
            return json(res, 403, { detail: 'This agent only listens to the owner.' });
          }
          const result = await voice.say(body.sessionId ? String(body.sessionId) : null, text, { source: 'app' });
          return json(res, 200, {
            ok: true,
            sessionId: result.sessionId,
            heard: result.heard,
            text: result.text ?? '',
            spoken: result.spoken ?? '',
            state: result.state,
            ended: Boolean(result.ended),
            awaitingConfirm: Boolean(result.awaitingConfirm),
            images: (result.images ?? []).map((img) => dataUrl(img)),
            documentName: result.document?.fileName ?? '',
            audio: result.audio ? dataUrl(result.audio.buffer, (result.audio.mimetype || 'audio/ogg').split(';')[0]) : null,
            audioMimetype: result.audio?.mimetype ?? null,
          });
        }

        case 'POST /api/call/transcribe': {
          const body = await readJsonBody(req);
          if (!body.audioBase64) return json(res, 400, { detail: 'audioBase64 is required' });
          const buffer = Buffer.from(stripDataPrefix(body.audioBase64), 'base64');
          if (!buffer.length) return json(res, 400, { detail: 'empty audio' });
          if (buffer.length > 12 * 1024 * 1024) return json(res, 413, { detail: 'audio clip too large (12 MB max)' });
          try {
            const out = await transcribeAudio(config, buffer, String(body.mimeType || 'audio/webm'), log);
            return json(res, 200, { ok: true, text: out.text, provider: out.provider });
          } catch (err) {
            return json(res, 503, { ok: false, detail: err.message });
          }
        }

        case 'POST /api/call/interrupt': {
          if (!voice) return json(res, 503, { detail: 'Voice engine is not wired in this build.' });
          const body = await readJsonBody(req);
          return json(res, 200, { ok: voice.interrupt(String(body.sessionId ?? '')) });
        }

        case 'POST /api/call/stop': {
          if (!voice) return json(res, 503, { detail: 'Voice engine is not wired in this build.' });
          const body = await readJsonBody(req);
          return json(res, 200, { ok: voice.end(String(body.sessionId ?? '')) });
        }

        case 'GET /api/call/events': {
          if (!voice) return json(res, 503, { detail: 'Voice engine is not wired in this build.' });
          const sessionId = url.searchParams.get('session') || '';
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            connection: 'keep-alive',
          });
          res.write(`event: ready\ndata: ${JSON.stringify({ sessionId })}\n\n`);
          const unsubscribe = voice.on(sessionId, (event) => {
            try { res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ }
          });
          const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch { /* gone */ } }, 25_000);
          req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
          return; // socket stays open — this *is* the response
        }

        case 'POST /api/action': {
          if (app?.busy?.() || mobile?.jobs.active) return json(res, 423, { detail: 'Wait for the active agent task before starting another action.' });
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

        // ── remote control (phone app / from anywhere over Tailscale) ──────
        // Live screen + tap-to-click. Same PC, same controls as WhatsApp —
        // the phone is just another client of the same agent.
        case 'GET /api/screen': {
          if (!config.allowPcControl) return json(res, 403, { detail: 'PC control is off (ALLOW_PC_CONTROL=false).' });
          const shot = await scr.capture({ portalTimeoutMs: Math.min(Number(config.portalTimeoutMs) || 30_000, 20_000) });
          const size = pngSize(shot) ?? { width: 0, height: 0 };
          if (size.width && size.height) lastFrameSize = size;
          const tag = screenTag(shot);
          // Unchanged screen → 304, no capture wasted on the phone's side and
          // no image re-sent. The phone asks again only when it wants to.
          if (req.headers['if-none-match'] === tag) {
            res.writeHead(304, { etag: tag, 'cache-control': 'no-store', 'x-screen-width': size.width, 'x-screen-height': size.height });
            return res.end();
          }
          const wanted = Math.max(480, Math.min(1920, Number(url.searchParams.get('w')) || 1280));
          // Zoomed view: the phone asks for a normalised region (0-1000) and
          // gets real pixels of that region instead of an upscaled thumbnail.
          const crop = readCrop(url.searchParams);
          let image = null, mime = 'image/png', cropped = false;
          if (crop && scr.crop) {
            const region = await scr.crop(shot, crop, { maxWidth: wanted });
            if (region) { image = region.image; mime = region.mime; cropped = true; }
          }
          if (!image) ({ image, mime } = await hands.shrinkForModel(shot, wanted, 70));
          res.writeHead(200, {
            'content-type': mime,
            'content-length': image.length,
            'cache-control': 'no-store',
            etag: tag,
            'x-screen-width': size.width,
            'x-screen-height': size.height,
            'x-screen-crop': cropped ? 'region' : 'full',
          });
          return res.end(image);
        }

        case 'POST /api/tap': {
          if (!config.allowPcControl) return json(res, 403, { detail: 'PC control is off (ALLOW_PC_CONTROL=false).' });
          const body = await readJsonBody(req);
          if (config.controlPin && !safeEqual(String(body.pin ?? ''), config.controlPin)) return json(res, 403, { detail: 'PC control PIN required.' });
          if (config.accessLevel === 'safe') return json(res, 403, { detail: 'Manual input requires standard/full access.' });
          if (app?.busy?.() || mobile?.jobs.active) return json(res, 423, { detail: 'Stop or wait for the active agent task before using manual input.' });
          const rx = Number(body.x);
          const ry = Number(body.y);
          if (!Number.isFinite(rx) || !Number.isFinite(ry)) return json(res, 400, { detail: 'x and y are required (0-1000 relative, or pixels with relative:false)' });
          // Prefer the size of the frame the phone is actually looking at: one
          // screenshot per tap is exactly the "screenshot har second" cost the
          // owner asked to avoid.
          let size = lastFrameSize;
          if (!size) {
            const shot = await scr.capture({ portalTimeoutMs: Math.min(Number(config.portalTimeoutMs) || 30_000, 20_000) });
            size = pngSize(shot) ?? { width: 0, height: 0 };
            if (size.width && size.height) lastFrameSize = size;
          }
          // `relative:true` (the app sends this) means 0-1000 like the hands
          // loop; raw pixels are accepted too.
          const x = body.relative === false
            ? Math.round(rx)
            : Math.round((Math.min(1000, Math.max(0, rx)) / 1000) * (size.width || 1));
          const y = body.relative === false
            ? Math.round(ry)
            : Math.round((Math.min(1000, Math.max(0, ry)) / 1000) * (size.height || 1));
          if (!size.width || x < 0 || y < 0 || x >= size.width || y >= size.height) {
            return json(res, 400, { detail: `Tap outside the screen (${size.width}×${size.height})` });
          }
          await scr.click(x, y);
          log.info?.(`[bridge] tap ${x},${y} from the phone app`);
          return json(res, 200, { ok: true, x, y, width: size.width, height: size.height });
        }

        case 'POST /api/drag': {
          if (!config.allowPcControl || config.accessLevel === 'safe') return json(res,403,{detail:'Manual input is not permitted'});
          if (app?.busy?.() || mobile?.jobs.active) return json(res,423,{detail:'Wait/stop the active agent operation first'});
          const b=await readJsonBody(req);
          if(config.controlPin&&!safeEqual(String(b.pin??''),config.controlPin))return json(res,403,{detail:'PC control PIN required.'});
          if(!lastFrameSize||!scr.drag)return json(res,409,{detail:'Capture a current screenshot first; this input backend must support drag.'});
          const points=[b.from,b.to];if(points.some(p=>!p||![p.x,p.y].every(Number.isFinite)||p.x<0||p.y<0||p.x>=1000||p.y>=1000))return json(res,400,{detail:'Bounded normalized screenshot coordinates required'});
          const [a,z]=points.map(p=>({x:Math.min(lastFrameSize.width-1,Math.round(p.x/1000*lastFrameSize.width)),y:Math.min(lastFrameSize.height-1,Math.round(p.y/1000*lastFrameSize.height))}));
          await scr.drag(a.x,a.y,z.x,z.y);return json(res,200,{ok:true});
        }
        case 'POST /api/pointer': {
          if (!config.allowPcControl || config.accessLevel === 'safe') return json(res, 403, { detail: 'Manual input is not permitted by PC policy.' });
          if (app?.busy?.() || mobile?.jobs.active) return json(res, 423, { detail: 'Wait/stop the active agent operation first.' });
          const body = await readJsonBody(req);
          if (config.controlPin && !safeEqual(String(body.pin ?? ''), config.controlPin)) return json(res, 403, { detail: 'PC control PIN required.' });
          if (body.op === 'move') {
            if (![body.dx,body.dy].every(Number.isFinite) || Math.abs(body.dx)>200 || Math.abs(body.dy)>200) return json(res,400,{detail:'Bounded deltas required'});
            if (!scr.relative) return json(res,503,{detail:'Relative input unavailable'}); await scr.relative(body.dx,body.dy);
          } else if (body.op === 'click') {
            if (!['left','right'].includes(body.button)) return json(res,400,{detail:'Invalid button'}); await scr.click(undefined,undefined,body.button,1);
          } else if (body.op === 'scroll') {
            if (!['up','down','left','right'].includes(body.direction) || !Number.isInteger(body.amount) || body.amount<1 || body.amount>5) return json(res,400,{detail:'Invalid bounded scroll'});
            if (!scr.scroll) return json(res,503,{detail:'Scroll unavailable'}); await scr.scroll(body.direction,body.amount);
          } else return json(res,400,{detail:'Unsupported pointer operation'});
          return json(res,200,{ok:true});
        }
        case 'POST /api/key': {
          if (!config.allowPcControl) return json(res, 403, { detail: 'PC control is off (ALLOW_PC_CONTROL=false).' });
          const body = await readJsonBody(req);
          if (config.controlPin && !safeEqual(String(body.pin ?? ''), config.controlPin)) return json(res, 403, { detail: 'PC control PIN required.' });
          if (config.accessLevel === 'safe') return json(res, 403, { detail: 'Manual input requires standard/full access.' });
          if (app?.busy?.() || mobile?.jobs.active) return json(res, 423, { detail: 'Stop or wait for the active agent task before using manual input.' });
          const key = String(body.key ?? '').trim();
          if (!key) return json(res, 400, { detail: 'key is required (e.g. "ctrl+l", "Return")' });
          await scr.key(key);
          return json(res, 200, { ok: true, key });
        }

        case 'POST /api/type': {
          if (!config.allowPcControl) return json(res, 403, { detail: 'PC control is off (ALLOW_PC_CONTROL=false).' });
          const body = await readJsonBody(req);
          if (config.controlPin && !safeEqual(String(body.pin ?? ''), config.controlPin)) return json(res, 403, { detail: 'PC control PIN required.' });
          if (config.accessLevel === 'safe') return json(res, 403, { detail: 'Manual input requires standard/full access.' });
          if (app?.busy?.() || mobile?.jobs.active) return json(res, 423, { detail: 'Stop or wait for the active agent task before using manual input.' });
          const text = String(body.text ?? '');
          if (!text) return json(res, 400, { detail: 'text is required' });
          await scr.type(text.slice(0, 4000));
          return json(res, 200, { ok: true, chars: Math.min(text.length, 4000) });
        }

        // ── session awareness, display wake and clipboard (phone parity) ───
        case 'GET /api/pc/state': {
          let state = null, error = null;
          try { state = await sys.state(); } catch (err) { error = err.message; }
          return json(res, state ? 200 : 503, {
            ...(state || {}),
            pcControl: Boolean(config.allowPcControl),
            controlPinRequired: Boolean(config.controlPin),
            accessLevel: config.accessLevel,
            busy: Boolean(app?.busy?.() || mobile?.jobs.active),
            activeJobs: activeJobCount(),
            ...(error ? { detail: error } : {}),
          });
        }
        case 'POST /api/pc/display': {
          if (!config.allowPcControl) return json(res, 403, { detail: 'PC control is off (ALLOW_PC_CONTROL=false).' });
          const body = await readJsonBody(req);
          if (config.controlPin && !safeEqual(String(body.pin ?? ''), config.controlPin)) return json(res, 403, { detail: 'PC control PIN required.' });
          try { return json(res, 200, { ok: true, ...(await sys.wake()) }); }
          catch (err) { return json(res, 503, { detail: err.message }); }
        }
        case 'GET /api/clipboard': {
          if (!config.allowPcControl) return json(res, 403, { detail: 'PC control is off (ALLOW_PC_CONTROL=false).' });
          try { return json(res, 200, await sys.clipboardRead()); }
          catch (err) { return json(res, 503, { detail: err.message }); }
        }
        case 'POST /api/clipboard': {
          if (!config.allowPcControl) return json(res, 403, { detail: 'PC control is off (ALLOW_PC_CONTROL=false).' });
          const body = await readJsonBody(req);
          if (config.controlPin && !safeEqual(String(body.pin ?? ''), config.controlPin)) return json(res, 403, { detail: 'PC control PIN required.' });
          if (config.accessLevel === 'safe') return json(res, 403, { detail: 'Clipboard write requires standard/full access.' });
          const text = String(body.text ?? '');
          if (!text) return json(res, 400, { detail: 'text is required' });
          if (text.length > 20_000) return json(res, 413, { detail: 'Clipboard text is limited to 20000 characters.' });
          try { return json(res, 200, await sys.clipboardWrite(text)); }
          catch (err) { return json(res, 503, { detail: err.message }); }
        }

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

        // ── DeepSeek Harness IPC + Phone/Desktop Control Routes ──────────
        case 'GET /api/guests': {
          const policy = ensureGuestStore(store, config);
          return json(res, 200, {
            ok: true,
            policy,
            contacts: listContacts(store),
            lastGuestSender: store.data.lastGuestSender || null,
            auditLog: (store.data.guestAuditLog || []).slice(-30),
          });
        }

        case 'POST /api/whatsapp/send': {
          const body = await readJsonBody(req);
          const kind = String(body.kind || 'text');
          let sendReply = (payload) => whatsapp.sendToOwner(payload);
          let recipientInfo = { to: config.ownerNumber, name: 'owner' };
          if (body.to) {
            const resolved = resolveRecipient(store, config, body.to);
            if (!resolved.ok) {
              return json(res, 400, { ok: false, detail: resolved.reason });
            }
            recipientInfo = { to: resolved.number, name: resolved.name };
            sendReply = (payload) => (
              whatsapp.sendToNumber
                ? whatsapp.sendToNumber(resolved.number, payload)
                : whatsapp.sendToOwner(payload)
            );
          }
          if (kind === 'screenshot') {
            const shot = await pc.captureScreenshot({ portalTimeoutMs: Math.min(Number(config.portalTimeoutMs) || 30_000, 25_000) });
            await sendReply({ image: shot, text: String(body.caption || '📸 Fedora Desktop') });
            return json(res, 200, { ok: true, via: whatsapp.status(), ...recipientInfo });
          }
          if (kind === 'file') {
            const target = path.resolve(String(body.filePath || ''));
            if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
              return json(res, 400, { ok: false, detail: `File not found: ${target}` });
            }
            const buf = fs.readFileSync(target);
            const ext = path.extname(target).toLowerCase();
            const isImg = Boolean(body.asImage) || ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);
            if (isImg) {
              await sendReply({ image: buf, text: String(body.caption || path.basename(target)) });
            } else {
              await sendReply({
                document: buf,
                fileName: path.basename(target),
                mimetype: files.mimeFor(target),
                text: String(body.caption || ''),
              });
            }
            return json(res, 200, { ok: true, via: whatsapp.status(), file: target, ...recipientInfo });
          }
          await sendReply(String(body.text || ''));
          return json(res, 200, { ok: true, via: whatsapp.status(), ...recipientInfo });
        }

        case 'GET /api/solve/status':
          return json(res, 200, await solver.solverStatus(config, log));

        case 'POST /api/solve': {
          const body = await readJsonBody(req);
          const instructions = String(body.instructions ?? body.caption ?? '').slice(0, 2000).trim();
          if (body.screen) {
            const shot = await scr.capture({ portalTimeoutMs: Math.min(Number(config.portalTimeoutMs) || 30_000, 20_000) });
            const solved = await solver.solveQuestionImage(config, shot, {
              caption: instructions || 'Solve every question visible on this screen accurately.',
              autoDetect: false,
              harness,
              log,
            });
            if (!solved.ok) return json(res, 502, { ok: false, detail: solved.error || 'Solver failed.' });
            return json(res, 200, { ok: true, text: solved.text, stages: solved.stages, images: [dataUrl(shot)] });
          }
          if (body.imageBase64) {
            const rawBuf = Buffer.from(stripDataPrefix(body.imageBase64), 'base64');
            const mimeType = String(body.mimeType || 'image/png');
            const isDoc = mimeType === 'application/pdf' || /\.(pdf|docx|txt)$/i.test(String(body.fileName || ''));
            fs.mkdirSync(config.downloadsDir, { recursive: true });
            const cleanName = String(body.fileName || `question-${Date.now()}.${isDoc ? 'pdf' : 'png'}`).replace(/[^\w.\- ]/g, '_');
            const savedPath = path.join(config.downloadsDir, cleanName);
            fs.writeFileSync(savedPath, rawBuf);
            store.addDownload({ file: cleanName, kind: isDoc ? 'document' : 'image', ts: Date.now(), caption: instructions });
            const solved = isDoc
              ? await solver.solveQuestionDocument(config, rawBuf, { fileName: cleanName, mimeType, caption: instructions, harness, log })
              : await solver.solveQuestionImage(config, rawBuf, { caption: instructions, autoDetect: false, savedPath, harness, log });
            if (!solved.ok) return json(res, 502, { ok: false, detail: solved.error || 'Solver failed.' });
            return json(res, 200, { ok: true, text: solved.text, stages: solved.stages });
          }
          if (body.text) {
            const solved = await solver.solveQuestionText(config, String(body.text), { caption: instructions, harness, log });
            if (!solved.ok) return json(res, 502, { ok: false, detail: solved.error || 'Solver failed.' });
            return json(res, 200, { ok: true, text: solved.text, stages: solved.stages });
          }
          return json(res, 400, { detail: 'Provide imageBase64, screen:true, or text.' });
        }

        case 'GET /api/harness':
          return json(res, 200, harness ? harness.status() : { installed: false });

        case 'GET /api/harness/web-url': {
          if (!harness) return json(res, 503, { detail: 'Harness not initialised.' });
          const ws = harness.webStatus().running ? harness.webStatus() : await harness.startWeb();
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(ws.localUrl || '');
        }

        case 'POST /api/harness/web': {
          if (!harness) return json(res, 503, { detail: 'Harness not initialised.' });
          const body = await readJsonBody(req);
          const action = String(body.action || 'start');
          const out = action === 'stop' ? await harness.stopWeb() : await harness.startWeb();
          return json(res, 200, { ok: true, web: out });
        }

        case 'POST /api/harness/install': {
          if (!harness) return json(res, 503, { detail: 'Harness not initialised.' });
          const out = await harness.install();
          return json(res, 200, out);
        }

        default:
          return json(res, 404, { detail: `No such route: ${route}` });
      }
    } catch (err) {
      log.error?.(`[bridge] ${route} failed: ${err.message}`);
      if (err.status === 413) res.setHeader('connection', 'close');
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
          mobile?.start();
          resolve(server);
        });
        server.on('error', (err) => log.error?.(`[bridge] server error: ${err.message}`));
      });
    },
    publish(message, type = 'agent_notice') { const text = typeof message === 'string' ? message : message?.text || 'Your PC agent has an update.'; return mobile?.events.publish(type, text); },
    stop() { mobile?.stop(); media.clear(); server.close(); },
  };
}
