// allowlist.js — the single most important rule of this service:
//
//   The agent listens to ONE number (the owner) and nobody else. Ever.
//
// Everything in here is a pure function so the rule can be unit-tested without
// a WhatsApp connection. `whatsapp.js` adds the async LID→phone resolution on
// top of `candidateNumbers()`.

/** Digits only. Bare 10-digit numbers are treated as Indian (+91). */
export function normalizeNumber(input, defaultCountryCode = '91') {
  if (input == null) return '';
  let digits = String(input).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10 && defaultCountryCode) digits = defaultCountryCode + digits;
  // Indian numbers sometimes arrive as 0XXXXXXXXXX
  if (digits.length === 11 && digits.startsWith('0') && defaultCountryCode === '91') {
    digits = defaultCountryCode + digits.slice(1);
  }
  return digits;
}

/** '919528923866@s.whatsapp.net' / '919528923866:4@s.whatsapp.net' -> '919528923866'. LIDs -> ''. */
export function jidToNumber(jid) {
  if (!jid || typeof jid !== 'string') return '';
  if (jid.endsWith('@lid')) return ''; // a LID is not a phone number; never compare it as one
  const user = jid.split('@')[0].split(':')[0];
  return /^\d+$/.test(user) ? user : '';
}

export const isGroupJid = (jid) => typeof jid === 'string' && jid.endsWith('@g.us');
export const isBroadcastJid = (jid) =>
  typeof jid === 'string' && (jid === 'status@broadcast' || jid.endsWith('@broadcast'));
export const isNewsletterJid = (jid) => typeof jid === 'string' && jid.endsWith('@newsletter');
export const isLidJid = (jid) => typeof jid === 'string' && jid.endsWith('@lid');

/**
 * Every phone number a message key might be carrying. WhatsApp increasingly
 * addresses 1:1 chats by LID (`remoteJid: '12345@lid'`) and puts the real
 * phone JID in `remoteJidAlt`; groups do the same with `participant` /
 * `participantAlt`. Older Baileys versions used different field names, so we
 * collect from all of them and let the caller add LID-mapping lookups.
 */
export function candidateNumbers(key = {}) {
  const seen = new Set();
  const out = [];
  const push = (value) => {
    const n = jidToNumber(value) || (/^\d{7,15}$/.test(String(value ?? '')) ? String(value) : '');
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  };
  push(key.remoteJid);
  push(key.participant);
  push(key.remoteJidAlt);
  push(key.participantAlt);
  push(key.senderPn);
  push(key.participantPn);
  push(key._pn);
  return out;
}

/** Every LID a key carries (for LID→PN resolution when no PN is present at all). */
export function candidateLids(key = {}) {
  return [key.remoteJid, key.participant, key.remoteJidAlt, key.participantAlt, key._lid].filter(isLidJid);
}

/** True if any candidate equals the owner number (all compared normalised). */
export function isOwner(candidates, ownerNumber) {
  const owner = normalizeNumber(ownerNumber);
  if (!owner) return false;
  return (candidates ?? []).some((c) => normalizeNumber(c) === owner);
}

/** Mask a number for logs: 9195****3866 — full numbers never need to hit a log file. */
export function maskNumber(value) {
  const n = normalizeNumber(value) || String(value ?? '');
  if (n.length <= 8) return '****';
  return `${n.slice(0, 4)}****${n.slice(-4)}`;
}

/** '919528923866' -> the 1:1 chat JID Baileys sends to. */
export function numberToJid(number) {
  return `${normalizeNumber(number)}@s.whatsapp.net`;
}
