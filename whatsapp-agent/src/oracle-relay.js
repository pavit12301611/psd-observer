// Small, deliberately restricted PC relay for Oracle mode. Tailscale encrypts
// the transport; a separate random token authenticates the cloud agent.
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';

const MAX_REQUEST = 16384;
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

// Slash commands always go to the PC. This explicit local-only subset avoids
// silently starting AI, schedulers, or unsupported WhatsApp integration.
const COMMANDS = new Set(`help commands menu ping time date access apps applications windows tasks open close quit focus switch screenshot shot ocr webcam cam record screencast wifi bt bluetooth kill svc service notify system sysinfo pc ls dir read cat write savefile send getfile download dl mv move rename cp copy mkdir zip unzip rm delete files get sendfile yes haan no nahi cancel confirm`.split(' '));
const PC_SUBCOMMANDS = new Set(`status info disk ip battery top screenshot shot volume vol brightness bright media music open close quit notify lock clipboard clip clipset find get elements ui ground type paste key click mousemove move mouse scroll drag shutdown poweroff reboot restart suspend sleep confirm cancel`.split(' '));
export function isSupportedPcCommand(input) {
  if (typeof input !== 'string' || input.length > 4000 || /[\r\n]/.test(input)) return false;
  const match = input.trim().match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+([^\r\n]*))?$/);
  if (!match) return false;
  const cmd = match[1].toLowerCase();
  if (!COMMANDS.has(cmd)) return false;
  if (cmd === 'pc') {
    const sub = (match[2] || 'status').trim().split(/\s+/)[0].toLowerCase();
    return PC_SUBCOMMANDS.has(sub);
  }
  return true;
}
const HELP = 'PC commands: /open, /close, /apps, /windows, /screenshot, /ocr, /pc, /wifi, /bt, /system, /ls, /read, /write, /send, /download, /mv, /cp, /mkdir, /zip, /unzip, /rm, /yes, /no. One slash command per message. AI, shell, scheduled jobs and voice commands are not supported in this connector. All non-slash text goes to Oracle AI.';
function encodeReply(reply) {
  if (typeof reply === 'string') return { text: reply };
  if (!reply || typeof reply !== 'object') return { text: '⚠️ Command returned no reply; check PC before retrying.' };
  const out = { text: typeof reply.text === 'string' ? reply.text : '' };
  for (const key of ['image', 'video', 'audio']) if (Buffer.isBuffer(reply[key])) out[key] = reply[key].toString('base64');
  if (reply.document && Buffer.isBuffer(reply.document.buffer)) out.document = { buffer: reply.document.buffer.toString('base64'), fileName: String(reply.document.fileName || 'file').slice(0, 255), mimetype: String(reply.document.mimetype || 'application/octet-stream').slice(0, 150) };
  if (reply.audio) { out.mimetype = String(reply.mimetype || 'audio/mpeg').slice(0, 150); out.ptt = Boolean(reply.ptt); }
  if (Array.isArray(reply.extraImages)) out.extraImages = reply.extraImages.filter(Buffer.isBuffer).map(b => b.toString('base64'));
  if (!out.text && !out.image && !out.video && !out.audio && !out.document && !out.extraImages?.length) out.text = '⚠️ Unsupported reply type; check PC before retrying.';
  return out;
}
function decodeReply(data) {
  if (typeof data?.text !== 'string') throw new Error('Invalid PC response');
  const decode = value => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid PC media');
    return Buffer.from(value, 'base64');
  };
  const out = { text: data.text };
  for (const key of ['image', 'video', 'audio']) if (data[key] !== undefined) out[key] = decode(data[key]);
  if (data.extraImages !== undefined) {
    if (!Array.isArray(data.extraImages)) throw new Error('Invalid PC media');
    out.extraImages = data.extraImages.map(decode);
  }
  if (data.document !== undefined) {
    if (!data.document || typeof data.document.fileName !== 'string' || typeof data.document.mimetype !== 'string') throw new Error('Invalid PC document');
    out.document = { buffer: decode(data.document.buffer), fileName: data.document.fileName, mimetype: data.document.mimetype };
  }
  if (data.audio !== undefined) { out.mimetype = String(data.mimetype || 'audio/mpeg'); out.ptt = Boolean(data.ptt); }
  return Object.keys(out).length === 1 ? out.text : out;
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
    const text = typeof data?.text === 'string' ? data.text.trim() : '';
    if (!isSupportedPcCommand(text)) return send(400, { error: 'Unsupported PC command; nothing executed' });
    if (busy) return send(409, { error: 'PC busy; request was not executed' });
    busy = true;
    try {
      const result = /^\/(?:help|commands|menu)$/i.test(text) ? HELP : await execute(text);
      const encoded = encodeReply(result);
      if (/reply[^\n]*(?:yes|haan)/i.test(encoded.text)) encoded.text += '\n\nOracle mode: confirm with /yes or cancel with /no (plain text goes to AI).';
      if (Buffer.byteLength(JSON.stringify(encoded)) > MAX_RESPONSE) return send(413, { error: 'Reply too large to relay; command may have run' });
      send(200, encoded);
    } catch { send(500, { error: 'PC action failed; it may have run. Check the PC before retrying.' }); }
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
    return decodeReply(data);
  } finally { clearTimeout(timer); }
}
