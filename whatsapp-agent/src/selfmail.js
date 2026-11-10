// selfmail.js — 🪪 The agent's own mailbox identity (psd_ai@gmail.com).
//
// What the owner asked for: "apne liye khud mail id generate kare, aur password
// sirf usi ko pata ho."
//
// What is actually possible, said plainly instead of faked:
//   • Google has **no public API to create an @gmail.com account**. The Admin
//     SDK creates users only inside a paid Workspace domain. Gmail signup needs
//     a browser, a phone OTP and a captcha, and Google's Terms forbid automated
//     signup — so a script that "creates psd_ai@gmail.com" would be a lie.
//   • What this file CAN do, and does: generate a strong password the agent
//     keeps sealed on disk (never printed, never sent to WhatsApp), open the
//     signup page, type the credentials into it using this PC's own keyboard
//     automation, and hand only the OTP step to the owner's phone.
//   • A Gmail *account* password is not what IMAP/SMTP need — those need a
//     16-character **app password**. So the flow is two steps, and both are
//     handled: this file owns the account identity, mailsetup.js owns mail.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sealSecret, openSecret, sealState } from './secrets.js';

export const AGENT_MAILBOX = 'psd_ai@gmail.com';
export const IDENTITY_FILE = 'agent-mail.json';
export const GENERATED_PASSWORD_LENGTH = 20;
export const SIGNUP_URL = 'https://accounts.google.com/signup/v2/createaccount?flowName=GlifWebSignIn';

// No l/I/1, O/0 — a human has to read this once on a phone screen.
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*-_=+?';

/**
 * Cryptographically random, class-guaranteed password.
 * `random` is injectable so tests are deterministic.
 */
export function generatePassword(opts = {}) {
  const { length = GENERATED_PASSWORD_LENGTH, random = crypto.randomInt } = opts;
  const size = Math.max(12, Number(length) || GENERATED_PASSWORD_LENGTH);
  const alphabet = LOWER + UPPER + DIGITS + SYMBOLS;
  const pick = (set) => set[random(set.length)];
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < size) chars.push(pick(alphabet));
  // Fisher–Yates with the same injected randomness: no predictable class order.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = random(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export function identityPath(opts = {}) {
  return opts.file ?? path.join(opts.dir ?? path.join(process.cwd(), 'data'), IDENTITY_FILE);
}

export function loadIdentity(opts = {}) {
  try {
    return JSON.parse(fs.readFileSync(identityPath(opts), 'utf8'));
  } catch {
    return null;
  }
}

function writeIdentity(identity, opts = {}) {
  const file = identityPath(opts);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return identity;
}

/**
 * Create (or return) the agent's identity. The password is generated here and
 * sealed immediately — the caller only ever sees masked text.
 */
export function createIdentity(opts = {}) {
  const {
    address = AGENT_MAILBOX,
    log = null,
    random = crypto.randomInt,
    regenerate = false,
  } = opts;
  const existing = loadIdentity(opts);
  if (existing && !regenerate) {
    return { created: false, identity: existing, secret: 'kept' };
  }
  const password = generatePassword({ random });
  const identity = writeIdentity({
    address,
    provider: 'gmail',
    password: sealSecret(password, { dir: opts.dir ?? path.dirname(identityPath(opts)), log }),
    status: 'awaiting-signup',
    createdAt: Date.now(),
    note: 'Account password — Gmail SMTP ke liye app password alag hota hai (/email setup).',
  }, opts);
  return { created: true, identity, secret: identity.password };
}

export function markIdentityVerified(opts = {}) {
  const existing = loadIdentity(opts);
  if (!existing) return null;
  return writeIdentity({ ...existing, status: 'ready', verifiedAt: Date.now() }, opts);
}

/** Never returns the password: existence + seal state only. */
export function identityStatus(opts = {}) {
  const identity = loadIdentity(opts);
  if (!identity) {
    return [
      '🪪 *Agent mailbox:* identity ban nahi (abhi)',
      `• Target: ${AGENT_MAILBOX}`,
      '• `/email signup` — password generate karke signup flow shuru karo',
    ].join('\n');
  }
  const label = {
    'awaiting-signup': '⏳ signup pending (OTP aapke phone pe)',
    ready: '✅ ready',
  }[identity.status] ?? identity.status;
  return [
    `🪪 *Agent mailbox:* ${identity.address}`,
    `• Status: ${label}`,
    `• Password: •••••••• · ${sealState(identity.password) === 'sealed' ? 'sealed on disk (0600 key)' : 'plaintext'}`,
    '• Password kabhi chat me print nahi hoga — sirf bot khud type karta hai.',
  ].join('\n');
}

/** The plain truth about Gmail signup, kept in one place so advice stays honest. */
export function gmailLimits() {
  return [
    'ℹ️ *Seedhi baat (jo automation nahi kar sakta):*',
    '• Google ke paas @gmail.com account banane ka koi public API nahi hai — Workspace Admin SDK sirf paid domain ke andar users banata hai.',
    `• Gmail 2004 se chal raha hai, to ${AGENT_MAILBOX} jaisa chhota naam pehle se kisi ke paas ho sakta hai — availability pehle check karo (aapke paas already ho to seedha setup).`,
    '• Signup me phone OTP + captcha aata hai, aur automated signup Google ke Terms ke against hai — isliye main sirf *assist* karta hoon, OTP aapke phone pe hi aayega.',
  ].join('\n');
}

/**
 * The assisted signup plan: what the agent does, what needs the owner's phone.
 * No secrets in the output.
 */
export function signupPlan(opts = {}) {
  const identity = loadIdentity(opts) ?? createIdentity(opts).identity;
  const steps = [
    `🪪 *Signup plan — ${identity.address}*`,
    '',
    '1️⃣ Main signup page kholta hoon (browser).',
    '2️⃣ Name/DOB aap bharo (main unhe guess nahi karta); password field pe cursor rakho — password *main khud type karta hoon* (screen pe, chat me kabhi nahi).',
    '3️⃣ Phone OTP aapke phone pe aayega — wo aap daalo (Google bot-check ke liye zaroori hai).',
    '4️⃣ Account banne par: Gmail → *App passwords* se 16-char app password banao.',
    `5️⃣ \`/email setup ${identity.address} <app password>\` — phir padhna aur bhejna dono chalu.`,
    '',
    gmailLimits(),
    '',
    `Shuru karo: \`/email signup go\` (browser + typing), ya sirf identity: \`/email signup\``,
  ];
  return { identity, steps: steps.join('\n') };
}

/**
 * Type the sealed password into whatever input is focused — the password never
 * becomes a reply, a message or a log line. `typeText` is injected (pccontrol in
 * production, a spy in tests).
 */
export async function typeSecretIntoField({ typeText, opts = {} } = {}) {
  const identity = loadIdentity(opts);
  if (!identity) throw new Error('identity nahi bani — pehle /email signup');
  if (typeof typeText !== 'function') throw new Error('typeText missing');
  const password = openSecret(identity.password, { dir: opts.dir ?? path.dirname(identityPath(opts)) });
  try {
    await typeText(password);
  } finally {
    // Keep the reference short-lived; JS cannot zero a string, so say nothing more.
  }
  return { ok: true, address: identity.address };
}

/** Masked one-liner for /email (no subcommand). */
export function identitySummary(opts = {}) {
  const identity = loadIdentity(opts);
  if (!identity) return `🪪 Agent mailbox: ${AGENT_MAILBOX} · \`/email signup\` se identity banao`;
  return `🪪 Agent mailbox: ${identity.address} · ${identity.status === 'ready' ? '✅ ready' : '⏳ signup pending'} · password ••••••••`;
}
