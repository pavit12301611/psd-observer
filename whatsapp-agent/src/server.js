// server.js — local HTTP bridge (Node built-in http, no Express).
//
// This is what the Observer app talks to instead of https://api.observer-ai.com:
//   POST /tools/send-whatsapp   Observer agents' sendWhatsapp(), free + unlimited
//   GET  /remote/listen         long-poll mailbox (patched app/src/mcp/remote.ts)
//   POST /remote/reply          MCP answers coming back to WhatsApp
//   GET  /remote/status         "is the phone linked?"
// Plus a tiny dashboard (status + QR + command tester) and POST /api/send.
//
// Security: binds 127.0.0.1 by default and every route except /health needs
// the bridge token (x-bridge-token header, Bearer token, or ?t= for the QR
// image). Sending to any number other than the owner is refused outright.

import http from 'node:http';
import fs from 'node:fs';
import { maskNumber, normalizeNumber } from './allowlist.js';

const MAX_BODY = 30 * 1024 * 1024;

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

export function createBridgeServer({ config, store, whatsapp, mailbox, log = console }) {
  const authed = (req, url) => {
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    return req.headers['x-bridge-token'] === config.bridgeToken || bearer === config.bridgeToken || url.searchParams.get('t') === config.bridgeToken;
  };

  function json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const route = `${req.method} ${url.pathname}`;
    // CORS: the Observer webapp runs on another localhost origin. Token auth
    // still applies to every route below except /health and the dashboard shell.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, authorization, x-bridge-token');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    try {
      if (route === 'GET /health') {
        return json(res, 200, {
          ok: true,
          service: 'observer-whatsapp-agent',
          whatsapp: whatsapp.status(),
          owner: maskNumber(config.ownerNumber),
          agent: maskNumber(config.agentNumber),
          observerTabConnected: mailbox.observerOnline(),
        });
      }
      if (route === 'GET /' || route === 'GET /dashboard') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(dashboardHtml(config, authed(req, url)));
      }
      if (route === 'GET /qr.png') {
        if (!authed(req, url)) return json(res, 401, { detail: 'Bridge token required (add ?t=<token> — printed in the agent console).' });
        try {
          const png = fs.readFileSync(config.qrPngFile);
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
          return res.end(png);
        } catch { return json(res, 404, { detail: 'No QR right now — either already linked, or WhatsApp is still connecting.' }); }
      }

      if (!authed(req, url)) return json(res, 401, { detail: 'Bridge token required (x-bridge-token header or Bearer). It is printed when the agent starts.' });

      switch (route) {
        case 'GET /api/status':
          return json(res, 200, {
            whatsapp: whatsapp.status(),
            owner: config.ownerNumber,
            agent: config.agentNumber,
            pairingCode: whatsapp.state.pairingCode,
            hasQr: Boolean(whatsapp.state.lastQr),
            observerTabConnected: mailbox.observerOnline(),
            forwardToObserver: config.forwardToObserver,
            allowSimulate: config.allowSimulate,
            stats: store.data.stats,
            reminders: store.data.reminders.length,
            openTodos: store.data.todos.filter((t) => !t.done).length,
            notes: store.data.notes.length,
          });
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
      return new Promise((resolve) => {
        server.listen(config.port, config.host, () => {
          log.info?.(`[bridge] listening on http://${config.host}:${config.port}`);
          log.info?.(`[bridge] dashboard (keep this URL private): http://${config.host}:${config.port}/?t=${config.bridgeToken}`);
          log.info?.(`[bridge] token: ${config.bridgeToken}`);
          resolve(server);
        });
        server.on('error', (err) => log.error?.(`[bridge] server error: ${err.message}`));
      });
    },
    stop() { server.close(); },
  };
}

function dashboardHtml(config, hasToken) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Observer WhatsApp Agent</title>
<style>
 body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0b141a;color:#e9edef;margin:0;padding:24px}
 .card{background:#111b21;border:1px solid #222d34;border-radius:14px;padding:20px;max-width:760px;margin:0 auto 16px}
 h1{font-size:22px;margin:0 0 4px} .sub{color:#8696a0;margin:0 0 16px}
 .ok{color:#25d366} code{background:#1f2c34;padding:2px 6px;border-radius:6px}
 img.qr{background:#fff;border-radius:12px;padding:10px;max-width:320px;width:100%}
 input,button{font:inherit} input{flex:1;background:#1f2c34;border:1px solid #2a3942;color:#fff;border-radius:10px;padding:10px}
 button{background:#25d366;border:0;border-radius:10px;padding:10px 16px;font-weight:600;cursor:pointer}
 .row{display:flex;gap:8px} pre{white-space:pre-wrap;background:#0b141a;border-radius:10px;padding:12px;min-height:60px}
 li{margin:3px 0} .muted{color:#8696a0}
</style></head><body>
<div class="card">
 <h1>🤖 Observer WhatsApp Agent</h1>
 <p class="sub">Free native WhatsApp (linked device) · Owner <b>+${config.ownerNumber}</b> only · Agent <b>+${config.agentNumber}</b> · ₹0/message</p>
 ${hasToken ? `<p>Status: <b id="status">loading…</b></p>
 <div id="qrbox" style="display:none"><p>📱 Scan with the <b>agent phone</b> (+${config.agentNumber}): WhatsApp → Linked devices → Link a device</p><img class="qr" id="qr" alt="WhatsApp linking QR"></div>
 <p id="pair" class="muted"></p>` : `<p>🔒 Open this page with the private dashboard URL printed in the agent console (it ends with <code>?t=…</code>) to see status and the linking QR.</p>`}
</div>
${hasToken && config.allowSimulate ? `<div class="card"><h2>🧪 Try a command (simulation)</h2>
 <div class="row"><input id="cmd" placeholder="/help, /weather Nainital, remind me in 5m to stretch, 45*12…"><button id="go">Send as owner</button></div>
 <p class="muted">This runs the real command engine + owner check without WhatsApp. Try also from another number via API to see it ignored.</p>
 <pre id="out">Replies will appear here…</pre></div>` : ''}
<div class="card"><h2>📱 First-time linking</h2><ol>
 <li>Keep this agent running (<code>npm start</code> in <code>whatsapp-agent/</code>).</li>
 <li>On the <b>agent phone +${config.agentNumber}</b>: WhatsApp → ⋮/Settings → <b>Linked devices</b> → <b>Link a device</b> → scan the QR above (or in the terminal).</li>
 <li>From <b>your phone +${config.ownerNumber}</b>, WhatsApp the agent number: <code>/help</code></li>
 <li>Anyone else messaging the agent number gets <b>silence</b> — by design.</li></ol>
 <p class="muted">Free AI brain: install Ollama, <code>ollama pull llama3.2</code>, done. Commands work even without it. Full guide: whatsapp-agent/README.md</p></div>
<script>
const t = new URLSearchParams(location.search).get('t') || '';
async function refresh(){
 if(!t) return;
 try{
  const s = await (await fetch('/api/status',{headers:{'x-bridge-token':t}})).json();
  document.getElementById('status').innerHTML = '<span class="ok">'+s.whatsapp+'</span> · '+s.stats.received+' in · '+s.stats.replied+' out · '+s.stats.ignoredNonOwner+' non-owner ignored';
  document.getElementById('qrbox').style.display = s.hasQr ? 'block':'none';
  if(s.hasQr) document.getElementById('qr').src = '/qr.png?t='+t+'&_='+Date.now();
  if(s.pairingCode) document.getElementById('pair').textContent = 'Pairing code: '+s.pairingCode;
 }catch(e){}
}
refresh(); setInterval(refresh, 5000);
const go=document.getElementById('go');
if(go) go.onclick = async () => {
 const text=document.getElementById('cmd').value;
 const out=document.getElementById('out'); out.textContent='…';
 const r=await (await fetch('/api/simulate',{method:'POST',headers:{'content-type':'application/json','x-bridge-token':t},body:JSON.stringify({text})})).json();
 out.textContent = r.ignored ? '(ignored — not the owner)' : (r.sent.map(s=>s.text||JSON.stringify(s)).join('\\n\\n') || '(no reply)');
};
</script></body></html>`;
}
