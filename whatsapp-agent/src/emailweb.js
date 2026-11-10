// emailweb.js — 🌐 Email bhejo browser ke logged-in Gmail session se.
//
// Zero credentials: koi app password nahi, koi IMAP/SMTP nahi, koi 2FA setup
// nahi. Jo Gmail Chrome me pehle se logged-in hai, wahi use hota hai — kyunki
// the real bottleneck was never "send an email", it was "get an app password".
//
// How it stays reliable without driving Gmail's whole UI:
//   1. Gmail has a documented compose-prefill URL (`view=cm&fs=1&to&su&body`),
//      so the agent never has to click "Compose" or type into three fields.
//   2. Only one click is automated: **Send** (located by OCR/AT-SPI).
//   3. The result is verified by reading Gmail's own "Message sent" toast —
//      and if the toast is not seen, the reply says so instead of claiming
//      success. "Send dabaya" ≠ "mail chala gaya".
//
// Bhejna ek outward action hai: `/email web send` sirf owner ke command se
// chalta hai (guest/kids block already upar hai).

export const GMAIL_COMPOSE = 'https://mail.google.com/mail/';
export const GMAIL_INBOX = 'https://mail.google.com/mail/u/0/#inbox';
/** Browsers/OS argument limits — isse lamba body URL me nahi jaata. */
export const MAX_URL_LENGTH = 1900;
export const MAX_BODY_VIA_URL = 1200;

/** Ek email address, aur wahi normalise. Throws on junk (header injection included). */
export function cleanRecipient(value) {
  const address = String(value ?? '').trim();
  if (/[\r\n]/.test(address)) throw new Error('address me line break nahi ho sakta');
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(address)) throw new Error(`"${address}" valid email address nahi lagta`);
  return address;
}

/**
 * Compose URL banao. Chhoti body URL me hi chali jaati hai ("url" mode);
 * lambi body ke liye sirf to+subject prefill hote hain aur body baad me
 * clipboard se paste hoti hai ("paste" mode) — URL ki limit todne se behtar.
 */
export function buildComposeUrl({ to, subject = '', body = '' } = {}) {
  const recipient = cleanRecipient(to);
  const text = String(body ?? '');
  const title = String(subject ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200);

  const make = (includeBody) => {
    const params = new URLSearchParams({ view: 'cm', fs: '1', tf: '1', to: recipient, su: title });
    if (includeBody) params.set('body', text);
    return `${GMAIL_COMPOSE}?${params.toString()}`;
  };

  const withBody = make(true);
  const fits = text.length > 0 && text.length <= MAX_BODY_VIA_URL && withBody.length <= MAX_URL_LENGTH;
  if (fits || !text) {
    const url = text ? withBody : make(false);
    return { url, mode: 'url', to: recipient, subject: title, bodyInUrl: Boolean(text) };
  }
  return { url: make(false), mode: 'paste', to: recipient, subject: title, bodyInUrl: false };
}

/**
 * Gmail login state from screen text. Indian-locale Gmail bhi cover karta hai
 * ("Sign in" / "Compose" / "Inbox" / "Sent" sab).
 */
export function detectLoginState(text) {
  const value = String(text ?? '');
  if (/\b(compose|inbox|sent|starred|snoozed|drafts)\b/i.test(value)) return 'signed-in';
  if (/\b(sign in|sign-in|create an account|choose an account|use another account)\b/i.test(value)) return 'signed-out';
  return 'unknown';
}

/** Gmail ka apna confirmation toast — jhooth se "bhej diya" na kahein. */
export function detectSentState(text) {
  const value = String(text ?? '');
  if (/\b(message sent|sending|undo)\b/i.test(value)) return 'sent';
  if (/\b(error|failed|couldn't send|could not send|try again)\b/i.test(value)) return 'failed';
  return 'unknown';
}

export function describeLogin(state, address = null) {
  if (state === 'signed-in') {
    return [
      '🌐 *Gmail browser session ready* ✅',
      ...(address ? [`• Account: ${address}`] : []),
      '• Kuch setup nahi chahiye — `/email web send to@x.com Subject | body` chala do.',
      '• Yaad rakho: ye mail aapke Gmail se *aapke* naam par jaayega (Sent folder me dikhega).',
    ].join('\n');
  }
  if (state === 'signed-out') {
    return [
      '🌐 Gmail browser me *logged in nahi* hai.',
      `• Chrome me ${GMAIL_INBOX} khol ke login kar lo (ek hi baar).`,
      '• Phir `/email web check` — main khud dekh lunga.',
      '• Login ke baad koi app password nahi chahiye, seedha `/email web send …`.',
    ].join('\n');
  }
  return [
    '🌐 Login state pata nahi chala (page shayad load ho raha tha).',
    '• Ek baar Gmail khol ke dekho, phir `/email web check` dobara.',
  ].join('\n');
}

export function describeWebEmail({ to, subject, body, mode }) {
  const kb = (String(body ?? '').length / 1024).toFixed(1);
  return [
    `🌐 *Browser se bhej raha hoon* → ${to}`,
    `• Subject: ${subject || '(no subject)'} · ${kb} KB · ${mode === 'paste' ? 'body paste hoga' : 'URL prefill'}`,
    '• Compose khulega, sirf *Send* dabana hai — phir Gmail ke "Message sent" se verify.',
  ].join('\n');
}

export function webIntro() {
  return [
    '🌐 *`/email web` — bina password wala email*',
    '',
    'Jo Gmail tumhare Chrome me logged-in hai, wahi use hota hai:',
    '• Koi app password nahi · koi 2FA setup nahi · koi SMTP/IMAP nahi',
    '• Compose (to/subject/body) Gmail ke prefill link se bhar jaata hai',
    '• Sirf *Send* button agent dabata hai, aur Gmail ke "Message sent" toast se confirm karta hai',
    '',
    'Commands:',
    '• `/email web check` — Chrome me Gmail logged-in hai ya nahi',
    '• `/email web send to@x.com Subject | body` — bhej do',
    '',
    '_(SMTP wala `/email send` tab zaroori hai jab PC locked/headless ho — browser ke bina.)_',
  ].join('\n');
}
