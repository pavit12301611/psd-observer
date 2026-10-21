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
import { spawn } from 'node:child_process';
import pino from 'pino';
import QRCode from 'qrcode';
// Baileys is imported lazily inside start(): the phone app, commands and
// tests all work without the (large) WhatsApp dependency installed.
let baileysModule = null;
async function loadBaileys() {
  if (!baileysModule) baileysModule = await import('@whiskeysockets/baileys');
  return baileysModule;
}
import {
  candidateNumbers, candidateLids, isOwner, isGroupJid, isBroadcastJid,
  isNewsletterJid, jidToNumber, maskNumber, normalizeNumber, numberToJid,
} from './allowlist.js';
import { jarvisGreeting, spokenSummary } from './jarvis.js';
import * as ai from './ai.js';
import * as ocr from './ocr.js';
import * as solver from './solver.js';
import * as pc from './pccontrol.js';
import * as finder from './elementfinder.js';
import { isStopCommand } from './cancel.js';
import { transcribeAudio } from './transcribe.js';

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

/**
 * Move a permanently-dead WhatsApp login (phone unlinked / session logged
 * out) aside so a fresh link can start in its place. The dead login is KEPT
 * as a sibling folder `auth_info_loggedout_<timestamp>/` — never deleted,
 * never overwritten (a same-second second archive gets a `-1`, `-2`, …
 * suffix). Returns the backup path, or null when there was nothing to move.
 */
export function archiveDeadAuthDir(authDir, now = new Date()) {
  if (!authDir || !fs.existsSync(authDir)) return null;
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace(/Z$/, '');
  let backup = `${authDir}_loggedout_${stamp}`;
  for (let n = 1; fs.existsSync(backup); n++) backup = `${authDir}_loggedout_${stamp}-${n}`;
  fs.renameSync(authDir, backup);
  return backup;
}

export function createWhatsApp({ config, store, agent, log = console, onConnected = null }) {
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
    qrOpened: false,
    relinkAttempts: 0,   // auto-relinks after a phone-side unlink (capped, reset on connect)
    relinkScheduled: false,
    stopped: false,
    simulated: [], // dry-run sent log for tests/dashboard
    downloadMediaMessage: null, // set by start() from the lazily loaded Baileys
    // Incoming voice calls (3.0): the real answering engine (src/wavoip.js)
    // is attached by index.js; until it reports connected, owner calls fall
    // back to an instant JARVIS voice-note session (see handleCallEvents).
    voipCoordinator: null,
    callTimers: new Map(), // callId → fallback timer
    lastSentImage: null, // last screenshot we sent to owner — used to diff red marks
    lastSentImageAt: 0,
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
            hasAudio: Boolean(reply.audio),
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
    if (reply.audio) {
      // Voice note / audio reply from /voicereply (TTS)
      const mimetype = reply.mimetype ?? (reply.ptt ? 'audio/ogg; codecs=opus' : 'audio/mpeg');
      await send({ audio: reply.audio, mimetype, ptt: Boolean(reply.ptt), caption: reply.text?.slice(0, 300) });
      if (reply.text) {
        // also send text caption as separate message for readability (optional)
        // but keep it in one if Baileys supports caption with audio (some clients ignore)
      }
      return;
    }
    if (reply.document) {
      await send({ document: reply.document.buffer, fileName: reply.document.fileName, mimetype: reply.document.mimetype ?? 'application/octet-stream', caption: reply.text });
      return;
    }
    if (reply.image) {
      // Remember last image we sent — so when owner marks it red and sends back, we can diff only the NEW red pixels (ignores YouTube/brave red icons in dock)
      try { state.lastSentImage = Buffer.from(reply.image); state.lastSentImageAt = Date.now(); } catch {}
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

  // ── JARVIS voice identity + mode ──────────────────────────────────────────

  /** True when a call/message JID belongs to the owner (phone JID, learned
   *  owner LID, or the call event's callerPn). Unknown LIDs never pass. */
  function isOwnerJid(jid, extra = []) {
    if (!jid) return false;
    const jidStr = String(jid);
    if (jidStr.endsWith('@lid')) {
      const user = jidStr.split('@')[0].split(':')[0];
      if (state.ownerLids.has(jidStr) || state.ownerLids.has(user) || state.ownerLids.has(`${user}@lid`)) return true;
    }
    const numbers = [jidToNumber(jidStr)];
    for (const cand of Array.isArray(extra) ? extra : [extra]) {
      if (!cand) continue;
      const candStr = String(cand);
      numbers.push(jidToNumber(candStr), normalizeNumber(candStr.split('@')[0]));
    }
    return isOwner(numbers.filter(Boolean), config.ownerNumber);
  }

  function voiceModeOn() {
    return config.voiceCall !== false
      && Boolean(config.whatsappVoiceReplies || store.data.voiceCallMode);
  }

  /** In voice mode, follow the text reply with a JARVIS voice note. */
  async function maybeVoiceReply(reply, chatJid, rawMsg) {
    if (!voiceModeOn() || reply == null) return;
    try {
      const flat = typeof reply === 'string' ? { text: reply } : reply;
      if (flat.audio) return; // already carries audio (e.g. /voicereply, /call on)
      const text = String(flat.text ?? '').trim();
      if (!text || text.startsWith('⏳')) return;
      const spoken = (agent.spokenFor ? agent.spokenFor(reply) : spokenSummary(reply, config)) || '';
      if (!spoken.trim()) return;
      const audioReply = agent.jarvisAudioReply
        ? await agent.jarvisAudioReply(spoken)
        : null;
      if (!audioReply || typeof audioReply === 'string' || !audioReply.audio) return;
      await transportSend(chatJid, { audio: audioReply.audio, mimetype: audioReply.mimetype, ptt: audioReply.ptt }, rawMsg);
    } catch (err) {
      log.warn?.(`[wa] voice reply skipped: ${err.message}`);
    }
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
      const reply = await agent.handle(content.text, { waStatus: status, mediaMeta: content.mediaMeta });
      if (reply != null) {
        await transportSend(chatJid, reply, rawMsg);
        await maybeVoiceReply(reply, chatJid, rawMsg);
      }
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
        if (!state.downloadMediaMessage) throw new Error('WhatsApp media helper not ready yet');
        buffer = await state.downloadMediaMessage(rawMsg, 'buffer', {}, {
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
    const mediaMeta = savedAs ? {
      buffer,
      savedPath: path.join(config.downloadsDir, savedAs),
      savedAs,
      mimeType: content.media?.mimetype || '',
      mediaKind: content.kind,
    } : null;

    if (caption.startsWith('/')) {
      await transportSend(chatJid, `💾 Saved as ${savedAs}${sizeNote}`, rawMsg);
      return processOwnerMessage({ chatJid, content: { kind: 'text', text: caption, mediaMeta }, rawMsg });
    }
    if (caption && agent.isHarnessAuto?.()) {
      await transportSend(chatJid, `💾 Saved as ${savedAs}${sizeNote}`, rawMsg);
      return processOwnerMessage({ chatJid, content: { kind: 'text', text: caption, mediaMeta }, rawMsg });
    }
    if (content.kind === 'image' && buffer) {
      // Marked screenshot -> click where user marked (red pen)
      // User flow: /screenshot -> mark red dot where to click -> send back with caption "click here / yahan click karo / tap this"
      const lowerCap = caption.toLowerCase();
      const isClickMark = /click|tap|press|dabao|yahan|ispe|here|this|mark|nishan|yes pe|no pe/i.test(caption) && caption.length < 120;
      // Also treat any image that looks like an edited screenshot with red annotation even without caption?
      // Check for red pen quickly via image analysis if caption is empty but image is from downloads (previous screenshot)
      // If caption says "yes pe click", just OCR the live screen for "Yes" — far more reliable than red-pixel math
      let captionTarget = extractClickTarget(caption);
      if (captionTarget) {
        try {
          log?.info?.(`[wa] caption target "${captionTarget}" from "${caption.slice(0,60)}" — locating on live screen`);
          const hit = await finder.locateOnScreen(config, captionTarget, log);
          await pc.click(hit.x, hit.y);
          const after = await pc.captureScreenshot({ portalTimeoutMs: config.portalTimeoutMs }).catch(() => null);
          const tip = `🎯 Clicked "${hit.matched}" @ ${hit.x},${hit.y} (${hit.source}${hit.confidence ? ` ${hit.confidence}%` : ''}) — from your caption "${captionTarget}"`;
          if (after) return transportSend(chatJid, { image: after, text: tip }, rawMsg);
          return transportSend(chatJid, tip, rawMsg);
        } catch (e) {
          log.info?.(`[wa] caption target locate failed (${e.message}), falling back to red-mark detection`);
        }
      }
      let tryMark = isClickMark;
      if (!tryMark && !caption && buffer.length > 5000) {
        // Heuristic: if user just sends back a screenshot with no caption, check if it's likely a marked one
        // We will attempt red-mark detection anyway if no other handler produces a description — but only if caption empty
        // To avoid false positives on normal photos, only try if image is PNG/JPEG screenshot-sized (>800px wide)
        try {
          const sz = finder.pngSize(buffer);
          if (sz && sz.width >= 800) tryMark = false; // don't auto-trigger on every large image without caption
        } catch {}
      }
      if (tryMark) {
        try {
          const hit = await handleMarkedClick(buffer, config, log, caption);
          if (hit) {
            // Click and send back new screenshot as confirmation
            await pc.click(hit.x, hit.y);
            const after = await pc.captureScreenshot({ portalTimeoutMs: config.portalTimeoutMs }).catch(() => null);
            const tip = `🎯 Clicked where you marked @ ${hit.x},${hit.y} (${hit.source}${hit.confidence ? ` ${hit.confidence}%` : ''})`;
            if (after) return transportSend(chatJid, { image: after, text: tip + ` — "${hit.matched ?? caption}"` }, rawMsg);
            return transportSend(chatJid, tip, rawMsg);
          }
        } catch (err) {
          log.warn?.(`[wa] marked click failed: ${err.message}`);
          // fall through to normal image handling so user gets at least OCR/description
        }
      }
      // "ye error fix karo" — treat the photo as a PC error to diagnose ONLY when not a question sheet
      if (/\b(fix|error|issue|problem|kya galat|kyu aa raha)\b/i.test(caption) && !solver.captionExplicitlyWantsSolve(caption)) {
        try {
          const diagnosed = await ai.diagnoseImage(config, buffer.toString('base64'), caption, log);
          if (diagnosed?.text) {
            return transportSend(chatJid, {
              text: `💾 Saved as ${savedAs}${sizeNote}\n\n🩺 *Kya galat hai*\n\n${diagnosed.text}\n\n_(${diagnosed.local ? 'local vision' : diagnosed.model})_`,
            }, rawMsg);
          }
        } catch (err) {
          log.warn?.(`[wa] diagnose failed: ${err.message}`);
        }
      }
      // ── Ultra-Accuracy Question Image Solver (auto-detects questions even with empty caption!) ──
      if (config.solverAutoImages !== false) {
        try {
          let notifiedSolving = false;
          const solved = await solver.solveQuestionImage(config, buffer, {
            caption,
            autoDetect: true,
            savedPath: path.join(config.downloadsDir, savedAs),
            harness: agent.harness ?? null,
            log,
            onProgress: (msg) => {
              if (!notifiedSolving) {
                notifiedSolving = true;
                transportSend(chatJid, msg, rawMsg).catch(() => {});
              }
            },
          });
          if (solved?.isQuestion && solved.ok && solved.text) {
            return transportSend(chatJid, `💾 Saved as ${savedAs}${sizeNote}\n\n${solved.text}`, rawMsg);
          }
          if (solved && !solved.isQuestion && solved.casualDescription) {
            return transportSend(chatJid, `💾 Saved as ${savedAs}${sizeNote}\n\n👁️ ${solved.casualDescription}`, rawMsg);
          }
        } catch (err) {
          log.warn?.(`[wa] question solver failed (${err.message}), falling back to standard vision/OCR`);
        }
      }
      // Fallback: 1) vision description 2) local OCR text
      const description = await ai.describeImage(config, buffer.toString('base64'), caption, log);
      if (description) return transportSend(chatJid, `💾 Saved as ${savedAs}${sizeNote}\n\n👁️ ${description}`, rawMsg);
      try {
        const text = await ocr.ocrImage(buffer, { langs: config.ocrLangs });
        if (text) {
          return transportSend(chatJid, `💾 Saved as ${savedAs}${sizeNote}\n\n🔎 *Text in the image*\n\n${text.slice(0, 2000)}${text.length > 2000 ? '\n…' : ''}\n\n_(Free OCR on your PC. For photo descriptions: ollama pull llava + OLLAMA_VISION_MODEL=llava)_`, rawMsg);
        }
      } catch { /* tesseract not installed: fall through */ }
      return transportSend(chatJid, `💾 Photo saved as ${savedAs}${sizeNote}.\n_(Set OLLAMA_VISION_MODEL, e.g. llava, for photo descriptions — or install tesseract for text OCR.)_`, rawMsg);
    }
    if (content.kind === 'voice' || content.kind === 'audio') {
      if (!buffer) {
        return transportSend(chatJid, `🎙️ Voice note received (dry-run: audio not downloaded).`, rawMsg);
      }
      try {
        const { text, provider } = await transcribeAudio(config, buffer, content.media?.mimetype ?? 'audio/ogg', log);
        await transportSend(chatJid, `🎙️ *Samjha:* ${text.slice(0, 1500)}${text.length > 1500 ? '…' : ''}\n_(transcribed free · ${provider})_`, rawMsg);
        // Voice notes go through the SAME voice brain as the live call:
        // Hindi normalisation, "X aur Y" multi-command chaining, spoken
        // confirmations and (in /call mode) a JARVIS voice-note answer.
        if (agent.voice?.sayWhatsApp) {
          try {
            if (!config.dryRun && state.sock) { try { await state.sock.sendPresenceUpdate('composing', chatJid); } catch { /* cosmetic */ } }
            const res = await agent.voice.sayWhatsApp(text);
            const reply = res?.reply ?? (res?.text || null);
            if (reply != null && reply !== '') await transportSend(chatJid, reply, rawMsg);
            const flat = typeof reply === 'string' ? { text: reply } : (reply ?? {});
            if (voiceModeOn() && res?.audio?.buffer && !flat.audio) {
              await transportSend(chatJid, {
                audio: res.audio.buffer,
                mimetype: res.audio.mimetype ?? 'audio/ogg; codecs=opus',
                ptt: (res.audio.mimetype || '').includes('opus') || res.audio.ext === 'ogg',
              }, rawMsg);
            } else if (reply != null) {
              await maybeVoiceReply(reply, chatJid, rawMsg);
            }
            store.bump('replied');
            if (!config.dryRun && state.sock) { try { await state.sock.sendPresenceUpdate('paused', chatJid); } catch { /* cosmetic */ } }
            return;
          } catch (err) {
            log.warn?.(`[wa] voice pipeline failed (${err.message}); falling back to typed handling`);
          }
        }
        // Treat the transcript exactly like a typed message: it can be a command!
        return processOwnerMessage({ chatJid, content: { kind: 'text', text }, rawMsg });
      } catch (err) {
        return transportSend(chatJid, `🎙️ Audio saved as ${savedAs}${sizeNote}.\n\n${err.message}`, rawMsg);
      }
    }
    if (content.kind === 'document' && buffer) {
      // PDF / DOCX / TXT: if it has questions (or caption asks to solve), run the verified solver!
      try {
        const text = await ocr.extractDocumentText(buffer, content.fileName, content.media?.mimetype);
        if (text) {
          if (config.solverAutoImages !== false && (solver.captionExplicitlyWantsSolve(caption) || solver.looksLikeQuestionText(text))) {
            const solvedDoc = await solver.solveQuestionDocument(config, buffer, {
              fileName: content.fileName,
              mimeType: content.media?.mimetype,
              caption,
              harness: agent.harness ?? null,
              log,
              onProgress: (msg) => transportSend(chatJid, msg, rawMsg).catch(() => {}),
            });
            if (solvedDoc?.ok && solvedDoc.text) {
              return transportSend(chatJid, `💾 Saved as ${savedAs}${sizeNote}\n\n📄 *${content.fileName ?? 'Question Sheet'}*\n\n${solvedDoc.text}`, rawMsg);
            }
          }
          const summary = await ai.complete(config, `Summarise this document briefly for WhatsApp (language: same as the document, Hinglish if mixed). Bullet points, max 12 lines.\n\n${text.slice(0, 8000)}`, log);
          return transportSend(chatJid, `💾 Saved as ${savedAs}${sizeNote}\n\n📄 *${content.fileName ?? 'document'}*\n\n${summary ? summary.text : `${text.slice(0, 1800)}${text.length > 1800 ? '\n…' : ''}`}`, rawMsg);
        }
      } catch (err) {
        log.warn?.(`[wa] document text extraction failed: ${err.message}`);
      }
    }
    return transportSend(chatJid, `💾 Saved as ${savedAs}${sizeNote} in my downloads. (/downloads lists them)`, rawMsg);
  }

  function extractClickTarget(caption) {
    const low = String(caption ?? '').toLowerCase();
    // Common UI labels - if caption mentions them near click, use that directly via OCR on live screen
    const labels = ['yes','no','battle','agent','auto','ok','cancel','submit','send','save','allow','deny','close','open','next','back','login','sign in','search'];
    for (const lab of labels) {
      if (low.includes(lab) && /click|tap|press|dabao|yahan|ispe|here|kar/i.test(low)) return lab;
    }
    // Try to extract word after "click" e.g. "click on Yes"
    const m = low.match(/click\s+(?:on\s+)?([a-z0-9_ ]{2,20})/);
    if (m) return m[1].trim();
    const m2 = low.match(/tap\s+(?:on\s+)?([a-z0-9_ ]{2,20})/);
    if (m2) return m2[1].trim();
    // Hindi: "yes pe click"
    const m3 = low.match(/([a-z0-9_ ]{2,20})\s+pe\s+click/);
    if (m3) return m3[1].trim();
    return null;
  }
  function parseMarkColor(caption) {
    const low = String(caption ?? '').toLowerCase();
    if (/\bgreen\b|\bhara\b|\bhari\b|\bharA\b/.test(low)) return 'green';
    if (/\bblue\b|\bneela\b|\bneeli\b/.test(low)) return 'blue';
    if (/\byellow\b|\bpeela\b|\bpeeli\b/.test(low)) return 'yellow';
    if (/\bred\b|\blal\b/.test(low)) return 'red';
    return 'red'; // default
  }
  function isColorMarked(r,g,b,a, color) {
    if (a < 40) return false;
    if (color === 'green') return g > 130 && r < 120 && b < 120 && (g - r) > 25 && (g - b) > 25;
    if (color === 'blue') return b > 130 && r < 120 && g < 120 && (b - r) > 25 && (b - g) > 25;
    if (color === 'yellow') return r > 140 && g > 140 && b < 100 && (r - b) > 40 && (g - b) > 40;
    // red default (lenient for JPEG)
    return r > 130 && g < 130 && b < 130 && (r - g) > 30 && (r - b) > 30;
  }
  async function handleMarkedClick(buffer, config, log, caption='') {
    // If we have the original screenshot we sent, diff only NEW red pixels (so YouTube red icons in dock are ignored)
    let baseBuffer = state.lastSentImage && (Date.now() - state.lastSentImageAt < 5*60*1000) ? state.lastSentImage : null;
    // Try 1: red-pen detection via sharp (fast, offline, no AI)
    try {
      const sharp = (await import('sharp')).default;
      const markColor = parseMarkColor(caption);
      log?.info?.(`[wa] mark color: ${markColor} for "${caption.slice(0,40)}"`);
      // Prepare marked image raw
      const marked = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let baseRaw = null, baseInfo = null;
      if (baseBuffer) {
        try {
          // Resize base to match marked dimensions (WhatsApp may have recompressed/resized)
          baseRaw = await sharp(baseBuffer).resize(marked.info.width, marked.info.height, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
          baseInfo = baseRaw.info;
        } catch {}
      }
      // Scan for NEW red pixels: red in marked but not red in base
      let sumX = 0, sumY = 0, count = 0;
      let minX = marked.info.width, minY = marked.info.height, maxX = 0, maxY = 0;
      const stride = 4;
      for (let y = 0; y < marked.info.height; y++) {
        for (let x = 0; x < marked.info.width; x++) {
          const idx = (y * marked.info.width + x) * stride;
          const r = marked.data[idx], g = marked.data[idx+1], b = marked.data[idx+2], a = marked.data[idx+3];
          // JPEG compresses red to ~R140-200, so be lenient; also check R dominance
          const isRedMarked = isColorMarked(r,g,b,a, markColor);
          if (!isRedMarked) continue;
          // If we have base, check if base was already red there — then it's not a new mark (e.g. YouTube icon)
          if (baseRaw) {
            const bR = baseRaw.data[idx], bG = baseRaw.data[idx+1], bB = baseRaw.data[idx+2];
            const isRedBase = isColorMarked(bR,bG,bB,255, markColor);
            if (isRedBase) continue; // dock icon, not user mark
          }
          sumX += x; sumY += y; count++;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
      if (count > 10 && count < 80000) {
        // Centroid of red cluster
        const cx = Math.round(sumX / count);
        const cy = Math.round(sumY / count);
        const w = maxX - minX, h = maxY - minY;
        // Map from marked-image coords (phone may have resized) to real screen via proportion
        // The marked image is a screenshot the PC sent, so its dimensions should match screen.
        // If phone resized it (WhatsApp compresses), we scale proportionally.
        const screen = await pc.captureScreenshot({ portalTimeoutMs: config.portalTimeoutMs }).catch(() => null);
        let screenSize = null;
        if (screen) {
          const sz = finder.pngSize(screen);
          if (sz) screenSize = sz;
        }
        // If we have screen size, scale marked coords to screen coords
        let sx = cx, sy = cy;
        if (screenSize) {
          sx = Math.round((cx / marked.info.width) * screenSize.width);
          sy = Math.round((cy / marked.info.height) * screenSize.height);
        }
        return { x: sx, y: sy, source: 'red-mark', confidence: Math.min(95, Math.round(50 + Math.min(count/200, 40))), matched: 'marked spot', width: w, height: h };
      }
    } catch (e) {
      log.info?.(`[wa] red-mark scan failed (${e.message}), trying vision model`);
    }
    // Try 2: vision model — ask it to find the red mark
    try {
      const raw = await ai.locateInImage(config, buffer.toString('base64'), 'red mark or circle or arrow indicating where to click', log);
      const pt = raw ? finder.parseVisionPoint(raw) : null;
      if (pt) {
        const screen = await pc.captureScreenshot({ portalTimeoutMs: config.portalTimeoutMs }).catch(() => null);
        const screenSize = screen ? finder.pngSize(screen) : null;
        // Vision point is 0..1000 relative to the *marked image* itself
        // Convert to screen coords via proportion if we have both sizes
        // For now we assume marked image == screen, so scale 1:1
        // If we have screenSize, we can scale: but vision point already 0..1000, so we need to map
        // We need the marked image dimensions — we have info from sharp above, fallback to assuming same as screen
        // Simpler: use relative 0..1000 scaled to screen
        let x = Math.round((pt.x / 1000) * (screenSize?.width ?? 1920));
        let y = Math.round((pt.y / 1000) * (screenSize?.height ?? 1080));
        // If we have actual marked image width/height from sharp, use that instead
        // But we already returned above if sharp succeeded — vision fallback only when sharp missing
        return { x, y, source: 'vision', matched: 'red mark', confidence: null };
      }
    } catch {}
    return null;
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

  // ── incoming WhatsApp voice calls ─────────────────────────────────────────
  // This messaging socket can detect + reject calls but cannot carry audio
  // (official Baileys limitation). The real answering happens in the VoIP
  // engine (src/wavoip.js, its own linked device). Coordination rule:
  //   • Engine connected → do nothing here. Only if it has NOT answered
  //     within WA_CALL_FALLBACK_DELAY_MS (and no device accepted either) do
  //     we step in — rejecting from here too early would kill the call.
  //   • Engine absent/off → after a short "pickup" beat, reject and start a
  //     JARVIS voice-note session, so calling still *reaches* JARVIS.
  // Non-owner callers: ignored (or rejected per WA_CALL_UNKNOWN). Never,
  // ever answered — a call into this agent is a call into the owner's PC.

  function clearCallTimer(callId) {
    const timer = state.callTimers.get(callId);
    if (timer) { clearTimeout(timer); state.callTimers.delete(callId); }
  }

  async function rejectCallSafe(callId, from) {
    try { await state.sock?.rejectCall?.(callId, from); } catch (err) { log.warn?.(`[wa] rejectCall failed: ${err.message}`); }
  }

  async function runCallFallback(callId, from, offerAt = 0) {
    state.callTimers.delete(callId);
    if (state.voipCoordinator?.recentlyAnswered?.(callId, offerAt)) return; // engine took it after all
    log.info?.('[wa] owner call not answered by VoIP engine — starting JARVIS voice session fallback');
    await rejectCallSafe(callId, from);
    if (!store.data.voiceCallMode) { store.data.voiceCallMode = true; store.save(); }
    const engineReady = Boolean(state.voipCoordinator?.isHandlingCalls?.());
    const greeting = jarvisGreeting(config);
    const spoken = `${greeting} I have picked up your call on our voice line, ${config.jarvisAddress || 'Sir'}. Simply send a voice note and I shall carry it out. To speak with me live, open the Call tab in your phone app.`;
    try {
      const audio = agent.jarvisAudioReply ? await agent.jarvisAudioReply(spoken) : null;
      if (audio && typeof audio !== 'string') await sendToOwner(audio);
    } catch (err) { log.warn?.(`[wa] call greeting voice failed: ${err.message}`); }
    // Name the EXACT failed stage so the owner can fix it in one step —
    // "call cut gaya" bina wajah ke kabhi nahi.
    const st = state.voipCoordinator?.status?.() ?? null;
    const lastEngineEvent = Array.isArray(st?.lastEvents) && st.lastEvents.length
      ? st.lastEvents[st.lastEvents.length - 1]
      : null;
    const reason = engineReady
      ? `Engine ready tha par is call ko answer nahi kar paaya — ek baar dobara call karke dekho; agent phone silent/DND pe rakho taaki wahi pehle na uthaye.${lastEngineEvent ? `\n_(engine ki aakhri khabar: ${lastEngineEvent.kind}${lastEngineEvent.detail ? ` — ${String(lastEngineEvent.detail).slice(0, 100)}` : ''})_` : ''}`
      : st?.stage === 'engine-missing'
        ? 'Wajah: VoIP engine *install hi nahi hua*. Fix (ek baar): `bash scripts/observer.sh voice call-engine`'
        : st?.stage === 'not-linked'
          ? 'Wajah: VoIP device *link nahi hua* (QR scan baaki hai). Fix: `bash scripts/observer.sh voice link-voip`'
          : st?.stage === 'connect-failed' || st?.stage === 'connecting'
            ? `Wajah: engine connect nahi ho pa raha${st.lastError ? ` (${String(st.lastError).slice(0, 120)})` : ''} — main khud retry kar raha hoon. Fix: \`bash scripts/observer.sh voice status\`, na bane to \`voice call-engine\` dobara.`
            : 'Asli WhatsApp call uthane wala engine abhi ON nahi hai.';
    await sendToOwner([
      '📞 *Call received, Sir.*',
      reason,
      'Tab tak *Voice Call Mode ON* kar diya hai: voice note bhejo, main sun ke command execute karke JARVIS ki awaaz me jawab dunga.',
      engineReady ? '' : 'Live baat-cheet ke liye phone app ka *📞 Call tab* abhi, isi waqt kaam karta hai. Poori guide: WHATSAPP-CALL.md',
      'Live status: /call · Voice mode band karna ho: /call off',
    ].filter(Boolean).join('\n'));
  }

  async function handleCallEvents(calls) {
    for (const event of calls ?? []) {
      try {
        const callId = String(event.id ?? '');
        const from = event.from ?? event.chatId ?? '';
        if (event.status === 'accept') { clearCallTimer(callId); log.info?.('[wa] call accepted on some device — fallback cancelled'); continue; }
        if (['terminate', 'reject', 'timeout'].includes(event.status)) { clearCallTimer(callId); continue; }
        if (event.status !== 'offer' || event.isGroup) continue;

        const owner = isOwnerJid(from, [event.callerPn, event.caller_pn]);
        if (!owner) {
          log.info?.(`[wa] incoming call from non-owner (${from}) — ${config.waCallUnknown === 'reject' ? 'rejecting' : 'ignored, ring jane diya'}`);
          if (config.waCallUnknown === 'reject') await rejectCallSafe(callId, from);
          continue;
        }
        log.info?.(`📞 [wa] OWNER is calling JARVIS on WhatsApp (from=${from}${event.callerPn || event.caller_pn ? `, callerPn=${event.callerPn ?? event.caller_pn}` : ''}, id=${callId})`);
        // Tell the VoIP engine "the owner is ringing RIGHT NOW" — it may only
        // see his anonymous @lid, while this socket just verified callerPn.
        // Also nudges an immediate reconnect if the engine dropped earlier.
        state.voipCoordinator?.noteOwnerCall?.({ callId, from, callerPn: event.callerPn ?? event.caller_pn ?? '' });
        if (config.waCallFallback === 'ignore') continue;
        if (config.waCallFallback === 'reject' && !state.voipCoordinator?.isHandlingCalls?.()) {
          await rejectCallSafe(callId, from);
          await sendToOwner('📞 Sir, WhatsApp calls abhi band hain (WA_CALL_FALLBACK=reject). Phone app ka 📞 Call tab use karo, ya /call on karke voice notes bhejo.');
          continue;
        }
        // Give the real VoIP engine first chance to pick up. The engine's own
        // pipeline (offer decryption queue + WASM relay-latency handshake)
        // legitimately takes up to ~20s before acceptCall lands — rejecting
        // from THIS socket earlier kills the ringing call on every device,
        // so while the engine is up we wait at least 35s before stepping in.
        const offerAt = Date.now();
        const configured = Number(config.waCallFallbackDelayMs) || 12_000;
        const handling = Boolean(state.voipCoordinator?.isHandlingCalls?.());
        const engineWanted = Boolean(config.waCallAnswer);
        const delay = handling
          ? Math.max(35_000, configured)
          : engineWanted
            ? Math.min(6_000, configured) // reconnect-in-flight ko ek mauka
            : Math.min(2_500, configured);
        clearCallTimer(callId);
        const timer = setTimeout(() => { runCallFallback(callId, from, offerAt).catch((err) => log.error?.(`[wa] call fallback failed: ${err.message}`)); }, delay);
        timer.unref?.();
        state.callTimers.set(callId, timer);
      } catch (err) {
        log.error?.(`[wa] call event handling failed: ${err.message}`);
      }
    }
  }

  async function handleUpsert({ messages, type }) {
    if (type !== 'notify') return; // ignore history sync / appends
    const queued = [];
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
        const content = extractContent(rawMsg.message);
        // /stop must never wait behind the command it is stopping — even when
        // it arrives in the same WhatsApp batch as that command.
        if (content?.text && isStopCommand(content.text)) {
          await processOwnerMessage({ chatJid, content, rawMsg });
          continue;
        }
        queued.push({ chatJid, content, rawMsg });
      } catch (err) {
        log.error?.(`[wa] message handling failed: ${err.message}`);
      }
    }
    for (const item of queued) {
      try {
        await processOwnerMessage(item);
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
    let B;
    try {
      B = await loadBaileys();
    } catch (err) {
      state.conn = 'WhatsApp library missing — run npm install';
      log.error?.('[wa] Could not load @whiskeysockets/baileys: ' + err.message);
      log.error?.('[wa] Run `npm install` inside whatsapp-agent/. The phone app keeps working in the meantime.');
      return;
    }
    const makeWASocket = B.default;
    const {
      useMultiFileAuthState, DisconnectReason, downloadMediaMessage,
      fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers,
    } = B;
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
    state.downloadMediaMessage = downloadMediaMessage;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', handleUpsert);
    // 📞 WhatsApp calls: hand to the VoIP engine (real pickup) or fall back.
    try { sock.ev.on('call', (calls) => { handleCallEvents(calls).catch((err) => log.error?.(`[wa] call handler failed: ${err.message}`)); }); } catch { /* very old Baileys build */ }
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
          // Fedora desktop: first QR of the run pops open in the default image
          // viewer (GNOME/KDE both honour xdg-open). QRs refresh every ~20 s,
          // so only the first one opens; later ones update the file silently.
          // The service runs headless under systemd --user too — no display,
          // no attempt. Disable with OPEN_QR=false.
          if (config.openQr && !state.qrOpened && process.platform === 'linux'
              && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
            state.qrOpened = true;
            try {
              spawn('xdg-open', [config.qrPngFile], { detached: true, stdio: 'ignore' }).unref();
              log.info?.('[wa] Opened the QR in your image viewer — scan it within ~20 s, or use the dashboard copy if it expires.');
            } catch { /* terminal + dashboard QRs still work */ }
          }
        } catch (err) { log.error?.(`[wa] QR render failed: ${err.message}`); }
      }
      if (connection === 'open') {
        state.conn = 'connected';
        state.lastQr = null;
        state.reconnectDelay = 2_000;
        state.relinkAttempts = 0;
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
        // "Updated!" message (version + what changed + how long) — the owner
        // should never have to wonder whether an update landed.
        if (typeof onConnected === 'function') {
          Promise.resolve()
            .then(() => onConnected())
            .catch((err) => log.warn?.(`[wa] onConnected failed: ${err.message}`));
        }
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        state.conn = 'disconnected';
        state.sock = null;
        if (state.stopped) return;
        if (code === DisconnectReason.loggedOut || code === 401) {
          // The agent phone unlinked this device (or WhatsApp dropped the
          // session). These creds can NEVER log in again, so reconnecting
          // with them is pointless. Archive the dead login (timestamped,
          // never deleted) and start a FRESH link automatically: a new QR
          // shows up in the logs/dashboard and the owner just scans it with
          // the agent phone. Capped so a banned/kicked number can't loop
          // forever; the counter resets on every successful connect.
          if (config.autoRelink !== false && !state.relinkScheduled && state.relinkAttempts < 3) {
            state.relinkAttempts += 1;
            state.relinkScheduled = true;
            state.conn = 'logged out — preparing a fresh QR to scan';
            log.error?.(`[wa] ❌ WhatsApp logged this device out (unlinked from the phone?). The dead login will be backed up and a FRESH QR generated automatically — keep watching these logs (or open the dashboard) and scan it with the AGENT phone (+${config.agentNumber}): WhatsApp → Linked devices → Link a device.`);
            setTimeout(() => {
              state.relinkScheduled = false;
              if (state.stopped) return;
              try {
                const backup = archiveDeadAuthDir(config.authDir);
                if (backup) log.info?.(`[wa] dead login backed up to ${backup} (safe to delete later — but never share it). Starting a fresh link now…`);
              } catch (err) {
                state.conn = 'logged out — manual relink needed';
                log.error?.(`[wa] could not back up the dead login (${err.message}). Manual fix: stop the agent, run ./scripts/relink-whatsapp.sh`);
                return;
              }
              state.me = null;
              state.pairingCode = null;
              state.qrOpened = false; // let the fresh QR pop open again on the desktop
              state.ownerLids = new Set();
              state.reconnectDelay = 2_000;
              start().catch((e) => log.error?.(`[wa] fresh link start failed: ${e.message}`));
            }, 1_500).unref?.();
            return;
          }
          log.error?.(`[wa] ❌ Logged out. Easiest fix: run ./scripts/relink-whatsapp.sh (backs up the dead login, restarts, shows a fresh QR). Manual fix: stop the agent, rename/remove ${config.authDir}, restart, scan the QR with the agent phone.`);
          state.conn = 'logged out — relink needed';
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

  /** Phone app / dashboard chat: run the agent without sending to WhatsApp. */
  async function runOwner(text) {
    return agent.handle(text, { waStatus: status });
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

  return {
    start, stop, status, sendToOwner, simulate, runOwner, state,
    isOwnerJid, handleCallEvents,
    learnOwnerLid: (lid) => rememberOwnerLid(lid),
    setVoipCoordinator: (coordinator) => { state.voipCoordinator = coordinator; },
  };
}
