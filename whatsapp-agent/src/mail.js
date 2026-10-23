// mail.js — 📧 Mail monitor: "/mail today" — IMAP se unread digest (Gmail
// app-password works). Priority filter: OTP/invoice/urgent pehle. Redacted
// via pii.js (OTP codes masked in digests). Credentials in data/mail.json
// (sirf PC pe), setup via /mail setup.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactPII } from './pii.js';
import { createImapClient } from './imap.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MAIL_FILE = path.join(ROOT, 'data', 'mail.json');
export const MAX_DIGEST = 12;

export function loadMailConfig(file = MAIL_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { host: null, user: null, pass: null, monitor: false, lastCheck: 0, lastSeenUids: [] };
  }
}

export function saveMailConfig(cfg, file = MAIL_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  } catch { /* best effort */ }
}

/** "/mail setup imap.gmail.com user@gmail.com apppass" — stored locally. */
export function setupMail(args, opts = {}) {
  const { file = MAIL_FILE } = opts;
  const [host, user, ...passParts] = String(args ?? '').trim().split(/\s+/);
  const pass = passParts.join(' ');
  if (!host || !user || !pass) {
    return '📧 Usage: `/mail setup <imap-host> <email> <app-password>`\n(Gmail: myaccount.google.com → App passwords banao — normal password nahi chalega)';
  }
  const cfg = loadMailConfig(file);
  cfg.host = host;
  cfg.user = user;
  cfg.pass = pass;
  saveMailConfig(cfg, file);
  return `📧 *Mail setup done* — ${user} @ ${host}\nCheck: \`/mail today\` · Monitor: \`/mail on\`\n(_credentials sirf is PC ke data/ folder me hain_)`;
}

const PRIORITY_RE = /(otp|verification|invoice|payment|urgent|action required|due|salary|offer|aadhaar|pan\b)/i;

export function isPriority(msg) {
  return PRIORITY_RE.test(`${msg?.subject ?? ''} ${msg?.from ?? ''}`);
}

/** Build a digest from parsed messages. Redacted, priority-first. */
export function mailDigest(messages, opts = {}) {
  const { limit = MAX_DIGEST, now = Date.now } = opts;
  const list = (messages ?? []).slice(-limit);
  if (!list.length) return '📭 Koi naya mail nahi hai.';
  const prio = list.filter(isPriority);
  const rest = list.filter((m) => !isPriority(m));
  const rows = [...prio, ...rest].map((m, i) => {
    const who = redactPII(String(m.from ?? '').replace(/</g, '‹').replace(/>/g, '›').slice(0, 40));
    const subj = redactPII(String(m.subject ?? '(no subject)').slice(0, 70));
    return `${isPriority(m) ? '🔴' : '•'} ${who} — ${subj}`;
  });
  const head = `📧 *Mail digest* — ${list.length} new${prio.length ? ` (${prio.length} priority)` : ''}`;
  void now;
  return `${head}\n${rows.join('\n')}\n\n_Read karo: \`/mail read <n>\` · Monitor: \`/mail on|off\`_`;
}

/** Fetch + digest with an injected client factory (tests pass fakes). */
export async function checkMail(opts = {}) {
  const {
    file = MAIL_FILE,
    createClient = (cfg) => createImapClient({ host: cfg.host, user: cfg.user, pass: cfg.pass }),
    limit = MAX_DIGEST,
  } = opts;
  const cfg = loadMailConfig(file);
  if (!cfg.host || !cfg.user) {
    return '📧 Mail setup nahi hua. `/mail setup imap.gmail.com user@gmail.com apppass` pehle chalao.';
  }
  let client;
  try {
    client = createClient(cfg);
    await client.connect();
    const messages = await client.fetchUnseen(limit);
    await client.logout?.();
    cfg.lastCheck = Date.now();
    cfg.lastCount = messages.length;
    saveMailConfig(cfg, file);
    return mailDigest(messages, { limit });
  } catch (err) {
    try { await client?.logout?.(); } catch { /* bye */ }
    return `📧 Mail check fail: ${err?.message ?? err}\n(IMAP host/user/app-password check karo)`;
  }
}

export function mailStatus(opts = {}) {
  const cfg = loadMailConfig(opts.file ?? MAIL_FILE);
  if (!cfg.host) return '📧 Mail: *not setup* · `/mail setup imap.gmail.com user@gmail.com apppass`';
  return `📧 Mail: *${cfg.user}* @ ${cfg.host} · monitor ${cfg.monitor ? 'ON' : 'OFF'} · last check: ${cfg.lastCheck ? new Date(cfg.lastCheck).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' }) : 'kabhi nahi'}`;
}

export function setMonitor(on, opts = {}) {
  const { file = MAIL_FILE } = opts;
  const cfg = loadMailConfig(file);
  cfg.monitor = on;
  saveMailConfig(cfg, file);
  return on
    ? '📧 Mail monitor *ON* — heartbeat pe check, priority mail pe ping.'
    : '📧 Mail monitor *OFF*.';
}
