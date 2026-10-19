// whatsapp.js — native WhatsApp via the WhatsApp Web (linked-device)
// protocol using Baileys. No Twilio, no Meta Cloud API, no browser, no fees.
//
// Pairing: this process links as a companion device of the AGENT phone
// (+91 88595 55795): WhatsApp on that phone → Linked devices → Link a device
// → scan the QR (printed here + saved to data/qr.png + shown on the local
// dashboard). The session then lives in auth_info/ — that folder IS the
// WhatsApp login. It is gitignored; never share or commit it.
//
// Owner-only rule is enforced in handleUpsert() before anything else sees a
// message: groups/status/broadcasts/self-messages are dropped, and any
// sender who is not the owner (+91 95289 23866, after LID→number resolution)
// is ignored in complete silence — no reply, no read receipt, nothing.

import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} from '@whiskeysockets/baileys';
import {
  candidateNumbers, candidateLids, isOwner, isGroupJid, isBroadcastJid,
  isNewsletterJid, jidToNumber, maskNumber, normalizeNumber, numberToJid,
} from './allowlist.js';
import * as ai from './ai.js';

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
};

function unwrap(message) {
  let msg = message ?? {};
  for (let i = 0; i < 5; i++) {
    const inner = msg.ephemeralMessage?.message ?? msg.viewOnceMessage?.message ??
      msg.viewOnceMessageV2?.message ?? msg.documentWithCaptionMessage?.message;
    if (!inner) break;
    msg = inner;
  }
  return msg;
}

function extractContent(message) {
  const msg = unwrap(message);
  if (msg.conversation) return { kind: 'text', text: msg.conversation };
  if (msg.extendedTextMessage?.text) return { kind: 'text', text: msg.extendedTextMessage.text };
  if (msg.imageMessage) return { kind: 'image', text: msg.imageMessage.caption ?? '', media: msg.imageMessage };
  if (msg.videoMessage) return { kind: 'video', text: msg.videoMessage.caption ?? '', media: msg.videoMessage };
  if (msg.documentMessage) return { kind: 'document', text: msg.documentMessage.caption ?? '', media: msg.documentMessage, fileName: msg.documentMessage.fileName };
  if (msg.audioMessage) return { kind: msg.audioMessage.ptt ? 'voice' : 'audio', text: '', media: msg.audioMessage };
  if (msg.stickerMessage) return { kind: 'sticker', text: '', media: msg.stickerMessage };
  if (msg.locationMessage) {
    const { degreesLatitude: lat, degreesLongitude: lon, name } = msg.locationMessage;
    return { kind: 'location', text: `📍 Location received${name ? `: ${name}` : ''}\nhttps://maps.google.com/?q=${lat},${lon}` };
  }
  if (msg.reactionMessage) return { kind: 'reaction', text: '' };
  return { kind: 'other', text: '' };
}

const chunkText = (text, size = 3800) => {
  const chunks = [];
  let rest = String(text ?? '');
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
};

export function createWhatsApp({ config, store, agent, log = console }) {
  const state = {
    sock: null,
    conn: config.dryRun ? 'dry-run' : 'starting',
    me: null,
    lastQr: null,
    pairingCode: null,
    ownerChatJid: numberToJid(config.ownerNumber),
    ownerLids: new Set(),
    seenIds: new Set(),
    rateStamps: [],
    reconnectDelay: 2_000,
    stopped: false,
    simulated: [], // dry-run sent log for tests/dashboard
  };

  const status = () =>
    config.dryRun
      ? 'dry-run (no WhatsApp connection; commands are simulated)'
      : `${state.conn}${state.me ? ` as +${state.me}` : ''}`;

  // ── outbound ─────────────────────────────────────────────────────────────

  async function transportSend(chatJid, reply, quoted) {
    if (config.dryRun) {
      const summary = typeof reply === 'string'
        ? { text: reply }
        : {
            text: reply.text,
            hasImage: Boolean(reply.image),
            document: reply.document?.fileName,
            poll: reply.poll?.name,
            sticker: Boolean(reply.sticker),
          };
      state.simulated.push(summary);
      log.info?.(`[dry-run] → owner: ${(summary.text ?? '(media)').slice(0, 160)}`);
      return summary;
    }
    if (!state.sock) throw new Error('WhatsApp is not connected');
    const sock = state.sock;
    const send = (content) => sock.sendMessage(chatJid, content, quoted ? { quoted } : undefined);

    if (typeof reply === 'string') reply = { text: reply };
    if (reply.poll) {
      await send({ poll: { name: reply.poll.name, values: reply.poll.values, selectableCount: 1 } });
      return;
    }
    if (reply.sticker) await send({ sticker: reply.sticker });
    if (reply.document) {
      await send({ document: reply.document.buffer, fileName: reply.document.fileName, mimetype: reply.document.mimetype ?? 'application/octet-stream', caption: reply.text });
      return;
    }
    if (reply.image) {
      await send({ image: reply.image, caption: reply.text?.slice(0, 1000) });
      for (const extra of reply.extraImages ?? []) await send({ image: extra });
      return;
    }
    if (reply.video) { await send({ video: reply.video, caption: reply.text?.slice(0, 1000) }); return; }
    if (reply.imageUrls?.length) {
      // Already-hosted media (e.g. the cloud API in WHATSAPP_MODE=native hands
      // over its R2 URLs). Baileys fetches them itself.
      await send({ image: { url: reply.imageUrls[0] }, caption: reply.text?.slice(0, 1000) });
      for (const url of reply.imageUrls.slice(1)) await send({ image: { url } });
      return;
    }
    for (const chunk of chunkText(reply.text ?? '')) await send({ text: chunk });
  }

  /** Send an alert to the owner (reminders, Observer sendWhatsapp bridge…). */
  async function sendToOwner(reply) {
    await transportSend(state.ownerChatJid, reply, undefined);
    store.bump('replied');
  }

  async function react(chatJid, key, emoji) {
    if (config.dryRun || !state.sock) return;
    try { await state.sock.sendMessage(chatJid, { react: { text: emoji, key } }); } catch { /* cosmetic */ }
  }

  // ── inbound pipeline (shared by real WhatsApp and dry-run simulate) ─────

  async function processOwnerMessage({ chatJid, content, rawMsg }) {
    store.bump('received');
    const key = rawMsg?.key;

    // Media: download → save on the PC → then act on the caption / describe.
    if (content.media && ['image', 'video', 'document', 'audio', 'voice', 'sticker'].includes(content.kind)) {
      return handleMedia({ chatJid, content, rawMsg });
    }
    if (content.kind === 'reaction' || content.kind === 'other') return;
    if (!content.text?.trim()) return;

    await react(chatJid, key, '⏳');
    if (!config.dryRun) { try { await state.sock.sendPresenceUpdate('composing', chatJid); } catch { /* cosmetic */ } }
    try {
      const reply = await agent.handle(content.text, { waStatus: status });
      if (reply != null) await transportSend(chatJid, reply, rawMsg);
      store.bump('replied');
      await react(chatJid, key, '✅');
    } catch (err) {
      log.error?.(`[wa] reply failed: ${err.message}`);
      await react(chatJid, key, '⚠️');
    } finally {
      if (!config.dryRun) { try { await state.sock.sendPresenceUpdate('paused', chatJid); } catch { /* cosmetic */ } }
    }
  }

  async function handleMedia({ chatJid, content, rawMsg }) {
    let buffer = null;
    let savedAs = null;
    if (!config.dryRun) {
      try {
        buffer = await downloadMediaMessage(rawMsg, 'buffer', {}, {
          logger: pino({ level: 'silent' }),
          reuploadRequest: state.sock.updateMediaMessage,
        });
        const mime = content.media.mimetype ?? '';
        const ext = content.fileName?.includes('.')
          ? content.fileName.split('.').pop()
          : (MIME_EXT[mime] ?? 'bin');
        fs.mkdirSync(config.downloadsDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const baseName = content.fileName ? path.basename(content.fileName) : `${content.kind}-${stamp}.${ext}`;
        savedAs = baseName.replace(/[^\w.\- ]/g, '_');
        fs.writeFileSync(path.join(config.downloadsDir, savedAs), buffer);
        store.addDownload({ file: savedAs, kind: content.kind, ts: Date.now(), caption: content.text || '' });
      } catch (err) {
        log.error?.(`[wa] media download failed: ${err.message}`);
        return transportSend(chatJid, '⚠️ I couldn\'t download that file from WhatsApp. Try sending it again.', rawMsg);
      }
    }

    const caption = (content.text ?? '').trim();
    const sizeNote = buffer ? ` (${(buffer.length / 1024).toFixed(0)} KB)` : '';

    if (/^\/?sticker/i.test(caption) && content.kind === 'image' && buffer) {
      const sticker = await makeSticker(buffer, log);
      return sticker
        ? transportSend(chatJid, { sticker }, rawMsg)
        : transportSend(chatJid, '🎨 Sticker needs the free `sharp` package on the PC: `npm install sharp` inside whatsapp-agent, then send the photo again.', rawMsg);
    }
    if (caption.startsWith('/')) {
      await transportSend(chatJid, `💾 Saved as ${savedAs}${sizeNote}`, rawMsg);
      return processOwnerMessage({ chatJid, content: { kind: 'text', text: caption }, rawMsg });
    }
    if (content.kind === 'image' && buffer) {
      const description = await ai.describeImage(config, buffer.toString('base64'), caption, log);
      if (description) return transportSend(chatJid, `💾 Saved as ${savedAs}${sizeNote}\n\n👁️ ${description}`, rawMsg);
      return transportSend(chatJid, `💾 Photo saved as ${savedAs}${sizeNote}.\n_(Set OLLAMA_VISION_MODEL, e.g. llava, and I'll also describe photos. /observer can look too.)_`, rawMsg);
    }
    if (content.kind === 'voice' || content.kind === 'audio') {
      return transportSend(chatJid, `🎙️ Audio saved as ${savedAs}${sizeNote}.\nI can't transcribe yet without a local Whisper setup — type the command and I'll act on it instantly.`, rawMsg);
    }
    return transportSend(chatJid, `💾 Saved as ${savedAs}${sizeNote} in my downloads. (/downloads lists them)`, rawMsg);
  }

  async function makeSticker(buffer) {
    try {
      const sharp = (await import('sharp')).default;
      return await sharp(buffer)
        .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 80 })
        .toBuffer();
    } catch { return null; }
  }

  /** Resolve the sender's phone number(s), including LID→PN lookup. */
  async function senderNumbers(key) {
    const numbers = candidateNumbers(key);
    if (numbers.length || !state.sock?.signalRepository?.lidMapping) return numbers;
    for (const lid of candidateLids(key)) {
      try {
        const pn = await state.sock.signalRepository.lidMapping.getPNForLID(lid);
        const n = jidToNumber(pn) || normalizeNumber(pn);
        if (n) numbers.push(n);
      } catch { /* keep going */ }
    }
    return numbers;
  }

  function rememberOwnerLid(lid) {
    if (!lid) return;
    const value = String(lid);
    state.ownerLids.add(value);
    const user = value.split('@')[0].split(':')[0];
    if (user) state.ownerLids.add(`${user}@lid`); // mappings arrive as JIDs or bare ids depending on version
  }

  function isFromOwnerLid(key) {
    return candidateLids(key).some((lid) => state.ownerLids.has(lid) || state.ownerLids.has(lid.split('@')[0]));
  }

  async function handleUpsert({ messages, type }) {
    if (type !== 'notify') return; // ignore history sync / appends
    for (const rawMsg of messages ?? []) {
      try {
        const key = rawMsg.key ?? {};
        const chatJid = key.remoteJid ?? '';
        if (!rawMsg.message) continue;
        if (key.fromMe) continue;                                   // never react to ourselves
        if (isGroupJid(chatJid) || isBroadcastJid(chatJid) || isNewsletterJid(chatJid)) continue;
        if (key.id) {
          if (state.seenIds.has(key.id)) continue;
          state.seenIds.add(key.id);
          if (state.seenIds.size > 1000) state.seenIds = new Set([...state.seenIds].slice(-500));
        }

        // ── THE owner-only gate ──────────────────────────────────────────
        const numbers = await senderNumbers(key);
        if (!isOwner(numbers, config.ownerNumber) && !isFromOwnerLid(key)) {
          store.bump('ignoredNonOwner');
          log.info?.(`[wa] ignored non-owner message from ${numbers.map(maskNumber).join(',') || chatJid} (no reply sent)`);
          continue;
        }
        state.ownerChatJid = chatJid; // reply on the exact chat (works for LID chats too)

        // Burst protection so a loop can never spam WhatsApp into a ban.
        const now = Date.now();
        state.rateStamps = state.rateStamps.filter((t) => now - t < 60_000);
        if (state.rateStamps.length >= 30) { log.warn?.('[wa] owner rate limit hit, skipping'); continue; }
        state.rateStamps.push(now);

        try { await state.sock.readMessages([key]); } catch { /* cosmetic */ }
        await processOwnerMessage({ chatJid, content: extractContent(rawMsg.message), rawMsg });
      } catch (err) {
        log.error?.(`[wa] message handling failed: ${err.message}`);
      }
    }
  }

  // ── connection ───────────────────────────────────────────────────────────

  async function start() {
    if (config.dryRun) {
      log.info?.('[wa] DRY-RUN: WhatsApp not connected. Use POST /api/simulate or the dashboard to try commands.');
      return;
    }
    fs.mkdirSync(config.authDir, { recursive: true });
    const { state: authState, saveCreds } = await useMultiFileAuthState(config.authDir);
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* offline: Baileys default */ }

    const sock = makeWASocket({
      version,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, pino({ level: 'silent' })),
      },
      logger: pino({ level: 'silent' }),
      browser: Browsers.macOS(config.deviceName),
      markOnlineOnConnect: false, // keep notifications flowing to the agent phone
      syncFullHistory: false,
      getMessage: async () => undefined, // no message store: retries of *inbound* polls only
    });
    state.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', handleUpsert);
    // Learn the owner's LID so the owner gate also matches pure-LID addressing.
    sock.ev.on('lid-mapping.update', (mapping) => {
      const entries = Array.isArray(mapping) ? mapping : [mapping];
      for (const e of entries) {
        const pn = normalizeNumber(jidToNumber(e?.pn ?? e?.phoneNumber ?? '') || e?.pn || '');
        if (pn === config.ownerNumber) rememberOwnerLid(e?.lid ?? e?.id);
      }
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        state.lastQr = qr;
        state.conn = 'waiting for QR scan';
        try {
          fs.mkdirSync(config.dataDir, { recursive: true });
          await QRCode.toFile(config.qrPngFile, qr, { width: 480 });
          log.info?.(`\n[wa] 📱 Scan this QR with the AGENT phone (+${config.agentNumber}): WhatsApp → Linked devices → Link a device\n${await QRCode.toString(qr, { type: 'terminal', small: true })}\n[wa] QR also at http://${config.host}:${config.port}/ and saved to ${config.qrPngFile}\n`);
        } catch (err) { log.error?.(`[wa] QR render failed: ${err.message}`); }
      }
      if (connection === 'open') {
        state.conn = 'connected';
        state.lastQr = null;
        state.reconnectDelay = 2_000;
        state.me = normalizeNumber(jidToNumber(sock.user?.id) || sock.user?.id || '');
        log.info?.(`[wa] ✅ Connected as +${state.me} — listening ONLY to owner +${config.ownerNumber}`);
        // Proactively learn the owner's LID (WhatsApp may hide the number behind it).
        try {
          const ownerLid = await sock.signalRepository?.lidMapping?.getLIDForPN(numberToJid(config.ownerNumber));
          rememberOwnerLid(ownerLid);
        } catch { /* mapping may arrive with the first message instead */ }
        if (state.me && state.me !== config.agentNumber) {
          log.warn?.(`[wa] ⚠️ Linked account +${state.me} != AGENT_NUMBER +${config.agentNumber}.${config.strictAgentNumber ? ' STRICT_AGENT_NUMBER=true: refusing to run.' : ' Continuing, but check which phone you scanned with.'}`);
          if (config.strictAgentNumber) { state.stopped = true; try { sock.end(new Error('agent number mismatch')); } catch { /* noop */ } return; }
        }
        // One friendly hello per process start, at most every 6 h (no restart spam).
        if (Date.now() - (store.data.stats.lastStartupNotify ?? 0) > 6 * 3600_000) {
          store.data.stats.lastStartupNotify = Date.now();
          store.save();
          sendToOwner('🤖 *Observer agent is online* (free native WhatsApp).\nSend /help, ask me anything, or /observer <task> to use the PC.').catch(() => {});
        }
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        state.conn = 'disconnected';
        state.sock = null;
        if (state.stopped) return;
        if (code === DisconnectReason.loggedOut) {
          log.error?.(`[wa] ❌ Logged out. Delete the session and link again: remove ${config.authDir}, restart, scan the QR with the agent phone.`);
          state.conn = 'logged out — delete auth_info and relink';
          return;
        }
        const delay = code === DisconnectReason.restartRequired ? 500 : state.reconnectDelay;
        state.reconnectDelay = Math.min(state.reconnectDelay * 2, 30_000);
        log.warn?.(`[wa] connection closed (code ${code ?? '?'}), reconnecting in ${delay}ms…`);
        setTimeout(() => { if (!state.stopped) start().catch((e) => log.error?.(`[wa] reconnect failed: ${e.message}`)); }, delay).unref?.();
      }
    });

    if (config.usePairingCode && !authState.creds.registered) {
      // Pairing-code linking ("Link with phone number") for the agent number.
      setTimeout(async () => {
        try {
          state.pairingCode = await sock.requestPairingCode(config.agentNumber);
          log.info?.(`\n[wa] 🔑 Pairing code for +${config.agentNumber}: ${state.pairingCode}\n[wa] On the AGENT phone: WhatsApp → Linked devices → Link a device → "Link with phone number instead" → enter the code.\n`);
        } catch (err) { log.error?.(`[wa] pairing code failed: ${err.message} (QR still works)`); }
      }, 2_500).unref?.();
    }
  }

  function stop() {
    state.stopped = true;
    try { state.sock?.end?.(new Error('shutdown')); } catch { /* noop */ }
    state.sock = null;
  }

  /** Dry-run/test hook: run the owner gate + pipeline without WhatsApp. */
  async function simulate(text, fromNumber = config.ownerNumber) {
    if (!isOwner([fromNumber], config.ownerNumber)) {
      store.bump('ignoredNonOwner');
      return { ignored: true, sent: [] };
    }
    const before = state.simulated.length;
    await processOwnerMessage({
      chatJid: numberToJid(config.ownerNumber),
      content: { kind: 'text', text },
      rawMsg: { key: { id: `sim-${Date.now()}` } },
    });
    return { ignored: false, sent: state.simulated.slice(before) };
  }

  return { start, stop, status, sendToOwner, simulate, state };
}
