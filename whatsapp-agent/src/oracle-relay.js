// Small, deliberately restricted PC relay for Oracle mode. Tailscale encrypts
// the transport; a separate random token authenticates the cloud agent.
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import { parseIntent } from './nlp.js';

const MAX_REQUEST = 4096;
const MAX_RESPONSE = 8 * 1024 * 1024;
export function isPrivateRelayIp(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return false;
  const n = parts.map(Number);
  return n[0] === 127 || (n[0] === 100 && n[1] >= 64 && n[1] <= 127);
}
export function validateRelaySettings(ip, token) {
  if (!isPrivateRelayIp(ip)) throw new Error('Relay IP must be a numeric Tailscale IPv4 (100.64.0.0/10) or loopback.');
  if (!/^[0-9a-f]{64}$/i.test(token || '')) throw new Error('ORACLE_RELAY_TOKEN must be 64 hex characters (32 random bytes).');
}

// Return a structured action, never shell text. The PC validates this again.
export function actionForText(input) {
  const text = String(input ?? '').trim();
  if (!text || text.length > 500) return null;
  let cmd, args;
  if (text.startsWith('/')) {
    const match = text.match(/^\/([a-z]+)(?:\s+([\s\S]*))?$/i);
    if (!match) return null;
    [, cmd, args = ''] = match; cmd = cmd.toLowerCase();
  } else {
    const parsed = parseIntent(text);
    if (!parsed?.cmd) return null;
    ({ cmd, args = '' } = parsed);
  }
  args = String(args).trim();
  if (cmd === 'open' && args.length > 0 && args.length <= 100 && /^[\p{L}\p{N} ._+-]+$/u.test(args)) return { name: 'open_app', args: { app: args } };
  if (['screenshot', 'shot'].includes(cmd) && !args) return { name: 'screenshot', args: {} };
  if (['apps', 'applications'].includes(cmd) && !args) return { name: 'list_apps', args: {} };
  if (cmd === 'windows' && !args) return { name: 'list_windows', args: {} };
  if (cmd === 'pc') {
    const match = args.toLowerCase().match(/^(volume|brightness)(?:\s+(get|up|down|mute|\d{1,3}))?$/);
    if (!match || (match[1] === 'brightness' && match[2] === 'mute')) return null;
    const value = match[2];
    if (value && /^\d+$/.test(value)) {
      if (Number(value) > 100) return null;
      return { name: match[1], args: { action: 'set', value: Number(value) } };
    }
    return { name: match[1], args: { action: value || 'get' } };
  }
  return null;
}
function safeToken(a, b) {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function body(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
export function createPcRelay({ host, port, token, execute, allowUnboundForTest = false }) {
  validateRelaySettings(host, token);
  if (!allowUnboundForTest && !Object.values(os.networkInterfaces()).flat().some(n => n?.address === host)) throw new Error('Relay must bind to your own Tailscale IPv4 address.');
  let busy = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    const send = (status, data) => { res.writeHead(status); res.end(JSON.stringify(data)); };
    if (req.method !== 'POST' || req.url !== '/command') return send(404, { error: 'Not found' });
    if (!safeToken(req.headers.authorization, `Bearer ${token}`)) return send(401, { error: 'Unauthorized' });
    if (busy) return send(409, { error: 'PC busy; request was not executed' });
    let data;
    try { data = JSON.parse(await body(req, MAX_REQUEST)); } catch { if (!res.destroyed) send(400, { error: 'Invalid request' }); return; }
    const action = typeof data?.text === 'string' ? actionForText(data.text) : null;
    if (!action) return send(400, { error: 'Unsupported PC command; nothing executed' });
    if (busy) return send(409, { error: 'PC busy; request was not executed' });
    busy = true;
    try {
      const result = await execute(action.name, action.args);
      const image = Buffer.isBuffer(result?.image) ? result.image.toString('base64') : undefined;
      if (image && image.length > MAX_RESPONSE - 4096) return send(413, { error: 'Screenshot too large' });
      send(200, { text: String(result?.text ?? 'Done').slice(0, 3000), image });
    } catch { send(500, { error: 'PC action failed; check connector logs' }); }
    finally { busy = false; }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return { server, start: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); }), stop: () => new Promise(resolve => server.close(resolve)) };
}
export async function sendPcCommand({ host, port, token, text, timeoutMs = 30000 }) {
  validateRelaySettings(host, token);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://${host}:${port}/command`, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal: controller.signal });
    const declaredLength = Number(response.headers.get('content-length'));
    if (declaredLength > MAX_RESPONSE) throw new Error('Response too large');
    let size = 0, parts = [];
    for await (const chunk of response.body) { size += chunk.length; if (size > MAX_RESPONSE) { controller.abort(); throw new Error('Response too large'); } parts.push(chunk); }
    const data = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!response.ok) return `⚠️ PC: ${String(data.error || 'request failed').slice(0, 200)}`;
    if (typeof data.text !== 'string' || (data.image !== undefined && (typeof data.image !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.image)))) throw new Error('Invalid PC response');
    return data.image ? { text: data.text, image: Buffer.from(data.image, 'base64') } : data.text;
  } finally { clearTimeout(timer); }
}
