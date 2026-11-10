// mailsetup.js — 📧 One-command mail setup (no host/port memorising).
//
// Before this file, setup was:
//   /mail setup imap.gmail.com user@gmail.com app password with spaces
// which asked the owner to know an IMAP hostname, and silently stored the
// password as plaintext. Now:
//
//   /email setup psd_ai@gmail.com              → exact 3-step guide + links
//   /email setup psd_ai@gmail.com abcd efgh ijkl mnop
//                                              → provider auto-detected,
//                                                secret sealed (0600 key),
//                                                IMAP + SMTP both live-tested,
//                                                password never echoed
//
// Everything is injectable so tests never touch a real mailbox.

import fs from 'node:fs';
import path from 'node:path';
import { loadMailConfig, saveMailConfig, MAIL_FILE } from './mail.js';
import { createImapClient } from './imap.js';
import { createSmtpClient, scrubCredentials } from './smtp.js';
import { sealSecret, openSecret, sealState } from './secrets.js';

/** Provider presets: the only facts the owner should never have to look up. */
export const PROVIDERS = {
  gmail: {
    label: 'Gmail', imapHost: 'imap.gmail.com', imapPort: 993,
    smtpHost: 'smtp.gmail.com', smtpPort: 465, secure: true, altSmtpPort: 587,
    setupUrl: 'https://myaccount.google.com/apppasswords',
    note: '2-Step Verification ON hona chahiye, phir 16-char *App password* banao (normal password nahi chalega).',
  },
  outlook: {
    label: 'Outlook / Hotmail', imapHost: 'outlook.office365.com', imapPort: 993,
    smtpHost: 'smtp-mail.outlook.com', smtpPort: 587, secure: false, altSmtpPort: 465,
    setupUrl: 'https://account.microsoft.com/security',
    note: 'Microsoft account → Security → Advanced → App passwords (2FA ON ho tab).',
  },
  yahoo: {
    label: 'Yahoo', imapHost: 'imap.mail.yahoo.com', imapPort: 993,
    smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465, secure: true, altSmtpPort: 587,
    setupUrl: 'https://login.yahoo.com/account/security',
    note: 'Account Security → Generate app password.',
  },
  icloud: {
    label: 'iCloud', imapHost: 'imap.mail.me.com', imapPort: 993,
    smtpHost: 'smtp.mail.me.com', smtpPort: 587, secure: false, altSmtpPort: 465,
    setupUrl: 'https://appleid.apple.com',
    note: 'Apple ID → Sign-In and Security → App-Specific Passwords.',
  },
  zoho: {
    label: 'Zoho', imapHost: 'imap.zoho.in', imapPort: 993,
    smtpHost: 'smtp.zoho.in', smtpPort: 465, secure: true, altSmtpPort: 587,
    setupUrl: 'https://accounts.zoho.in/home#security',
    note: 'Security → App Passwords (Zoho India domain; .com users: imap.zoho.com).',
  },
  rediff: {
    label: 'Rediffmail', imapHost: 'imap.rediff.com', imapPort: 993,
    smtpHost: 'smtp.rediff.com', smtpPort: 465, secure: true, altSmtpPort: 587,
    setupUrl: 'https://mail.rediff.com',
    note: 'Rediff settings me POP/IMAP enable karo, phir app password.',
  },
  fastmail: {
    label: 'Fastmail', imapHost: 'imap.fastmail.com', imapPort: 993,
    smtpHost: 'smtp.fastmail.com', smtpPort: 465, secure: true, altSmtpPort: 587,
    setupUrl: 'https://app.fastmail.com/settings/security/apppasswords',
    note: 'Settings → Privacy & Security → App passwords.',
  },
  proton: {
    label: 'Proton Mail', imapHost: '127.0.0.1', imapPort: 1143,
    smtpHost: '127.0.0.1', smtpPort: 1025, secure: false, altSmtpPort: 1025,
    setupUrl: 'https://proton.me/mail/bridge',
    note: 'Proton Bridge chahiye (localhost 1143/1025). Bridge ke bina IMAP/SMTP nahi milta.',
  },
  custom: {
    label: 'Custom / college / office', imapHost: null, imapPort: 993,
    smtpHost: null, smtpPort: 465, secure: true, altSmtpPort: 587,
    setupUrl: null,
    note: 'Custom host: `/mail setup <imap-host> <email> <app-password>`.',
  },
};

const DOMAIN_MAP = {
  'gmail.com': 'gmail', 'googlemail.com': 'gmail',
  'outlook.com': 'outlook', 'hotmail.com': 'outlook', 'live.com': 'outlook', 'msn.com': 'outlook',
  'yahoo.com': 'yahoo', 'yahoo.in': 'yahoo', 'yahoo.co.in': 'yahoo', 'ymail.com': 'yahoo', 'rocketmail.com': 'yahoo',
  'icloud.com': 'icloud', 'me.com': 'icloud', 'mac.com': 'icloud',
  'zoho.com': 'zoho', 'zoho.in': 'zoho',
  'rediffmail.com': 'rediff', 'rediff.com': 'rediff',
  'fastmail.com': 'fastmail', 'fastmail.fm': 'fastmail',
  'proton.me': 'proton', 'protonmail.com': 'proton', 'pm.me': 'proton',
};

export function detectProvider(address) {
  const domain = String(address ?? '').trim().toLowerCase().split('@')[1] ?? '';
  return DOMAIN_MAP[domain] ?? 'custom';
}

export function providerPreset(address) {
  const key = detectProvider(address);
  return { key, ...PROVIDERS[key] };
}

export function isEmailAddress(value) {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(String(value ?? '').trim());
}

/** App passwords are shown as "abcd efgh ijkl mnop" — spaces are not part of it. */
export function normaliseSecret(value) {
  return String(value ?? '').replace(/\s+/g, '');
}

/** Hides a secret for display. Never returns any character of it. */
export function maskSecret(value) {
  if (!value) return '(none)';
  return '••••••••';
}

/**
 * Parse `/email setup …` arguments.
 *   "<address>"                        → guide only
 *   "<address> <secret with spaces>"   → ready to save
 *   "<imap-host> <address> <secret>"   → legacy explicit host
 */
const cleanAddress = (value) => String(value ?? '').trim();

export function parseSetupArgs(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { error: 'empty' };
  const [first, ...rest] = text.split(/\s+/);
  const explicitHost = /^(imap|mail|outlook|smtp)\.[a-z0-9.-]+$/i.test(first) || /^\d{1,3}(\.\d{1,3}){3}$/.test(first);
  if (explicitHost) {
    const address = cleanAddress(rest[0]);
    const secret = normaliseSecret(rest.slice(1).join(' '));
    if (!isEmailAddress(address)) return { error: 'address', host: first };
    return { host: first, address, secret: secret || null, provider: detectProvider(address) };
  }
  if (!isEmailAddress(first)) return { error: 'address' };
  const secret = normaliseSecret(rest.join(' '));
  return { address: cleanAddress(first), secret: secret || null, provider: detectProvider(cleanAddress(first)) };
}

/** The 3-step guide — the actual "easy setup". */
export function setupGuide(addressOrProvider) {
  const email = cleanAddress(addressOrProvider);
  const preset = providerPreset(email);
  const lines = [
    `📧 *Email setup — ${email || 'address chahiye'}* (${preset.label})`,
    '',
    email ? '1️⃣  App password banao (normal password kaam nahi karega):' : '1️⃣  Pehle address bhejo: `/email setup psd_ai@gmail.com`',
  ];
  if (preset.setupUrl) lines.push(`     ${preset.setupUrl}`);
  lines.push(`     _${preset.note}_`);
  if (preset.imapHost) {
    lines.push(`     Auto-detect: IMAP ${preset.imapHost}:${preset.imapPort} · SMTP ${preset.smtpHost}:${preset.smtpPort}`);
  }
  lines.push('', '2️⃣  Wahi password isi message me bhej do (spaces ki chinta nahi):');
  lines.push(`     \`/email setup ${email || 'psd_ai@gmail.com'} abcd efgh ijkl mnop\``);
  lines.push('', '3️⃣  Main khud test kar lunga — IMAP login + SMTP auth dono. Pass = ready.');
  lines.push('', '🔐 Password is PC ke `data/mail.json` me *sealed* (AES-256-GCM, key `data/.mail-key` 0600) jaata hai,');
  lines.push('   reply me kabhi print nahi hota, aur `/email status` sirf •••••••• dikhata hai.');
  return lines.join('\n');
}

function fileFor(opts = {}) {
  return opts.file ?? MAIL_FILE;
}

/**
 * Save + immediately verify. Seals the secret, chmods the file to 0600, and
 * reports per-protocol results instead of making the owner guess.
 */
export async function saveMailSetup(parsed, opts = {}) {
  const {
    file = fileFor(opts),
    dataDir = path.dirname(file),
    log = null,
    verify = true,
    imapFactory,
    smtpFactory,
  } = opts;

  if (!parsed || parsed.error === 'empty') return setupGuide('');
  if (parsed.error === 'address') {
    return `📧 Ye address valid nahi lagta${parsed.host ? ` (host ${parsed.host} theek, address nahi)` : ''}.\nExample: \`/email setup psd_ai@gmail.com\``;
  }
  if (!parsed.secret) return setupGuide(parsed.address);

  const preset = providerPreset(parsed.address);
  const secret = normaliseSecret(parsed.secret);
  if (secret.length < 6) return '📧 App password bahut chhota lagta hai — poora 16-character password bhejo.';

  let cfg;
  try { cfg = loadMailConfig(file); } catch { cfg = {}; }
  const sealed = sealSecret(secret, { dir: dataDir, log });
  const next = {
    ...cfg,
    host: parsed.host ?? preset.imapHost,
    imapPort: parsed.host ? cfg.imapPort ?? 993 : preset.imapPort,
    smtpHost: preset.smtpHost,
    smtpPort: preset.smtpPort,
    secure: preset.secure,
    provider: preset.key,
    user: parsed.address,
    pass: sealed,
    setupAt: Date.now(),
  };
  if (parsed.host) next.provider = 'custom';
  saveMailConfig(next, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }

  const head = [
    `📧 *Saved* — ${next.user}`,
    `• Provider: ${preset.label} · IMAP ${next.host ?? '—'}${next.imapPort ? `:${next.imapPort}` : ''} · SMTP ${next.smtpHost ?? '—'}${next.smtpPort ? `:${next.smtpPort}` : ''}`,
    `• Password: ${maskSecret(secret)} · ${sealState(sealed) === 'sealed' ? '🔐 sealed on disk' : '⚠️ plaintext (key file ban nahi payi)'}`,
  ];
  if (!verify) return [...head, '', 'Test: `/email test`'].join('\n');

  const report = await verifyMailSetup({ ...next, pass: secret }, { imapFactory, smtpFactory, log });
  return [...head, '', report.text].join('\n');
}

const weakError = (err) => scrubCredentials(err?.message ?? String(err), []);

/** Guess the real problem from the server's words, so the fix is obvious. */
export function explainMailError(message) {
  const text = String(message ?? '');
  if (/535|534|5\.7\.8|AUTH|Login fail|auth fail|Invalid credentials|BadCredentials|authentication failed/i.test(text)) {
    return 'app password galat/expire — naya banao (normal Gmail password nahi chalega)';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return 'host resolve nahi hua — internet/DNS check karo';
  if (/ETIMEDOUT|ECONNREFUSED|timeout/i.test(text)) return 'server tak nahi pahuncha — port/network/firewall (office Wi-Fi block karta hai)';
  if (/STARTTLS/i.test(text)) return 'port 587 ne STARTTLS refuse kiya — 465 (TLS) try karo';
  if (/certificate|self.signed|SSL|TLS/i.test(text)) return 'TLS/certificate problem — network ya antivirus proxy check karo';
  return 'details neeche — `/email guide` bhi dekh lo';
}

/**
 * Live test of both directions. Returns per-protocol rows — a saved password
 * that cannot log in is worse than no password, so this runs on every setup.
 */
export async function verifyMailSetup(cfg, opts = {}) {
  const {
    imapFactory = (c) => createImapClient({ host: c.host, port: c.imapPort, user: c.user, pass: c.pass }),
    smtpFactory = (c) => createSmtpClient({ host: c.smtpHost, port: c.smtpPort, secure: c.secure, user: c.user, pass: c.pass }),
    altSmtpPort = 587,
    log = null,
  } = opts;

  const rows = [];
  let imapOk = false;
  let smtpOk = false;

  if (cfg.host && cfg.user) {
    let client = null;
    try {
      client = imapFactory({ ...cfg, host: cfg.host, imapPort: cfg.imapPort ?? 993 });
      await client.connect();
      if (client.login) await client.login?.();
      imapOk = true;
      rows.push(`• IMAP (${cfg.host}:${cfg.imapPort ?? 993}) ✅ login ok`);
    } catch (err) {
      rows.push(`• IMAP (${cfg.host}:${cfg.imapPort ?? 993}) ❌ ${explainMailError(weakError(err))}`);
    } finally {
      try { await client?.logout?.(); } catch { /* bye */ }
    }
  } else {
    rows.push('• IMAP ❌ host/user missing');
  }

  if (cfg.smtpHost && cfg.user) {
    const attempts = [{ port: cfg.smtpPort ?? 465, secure: cfg.secure !== false }];
    if (altSmtpPort && altSmtpPort !== attempts[0].port) attempts.push({ port: altSmtpPort, secure: false });
    for (const attempt of attempts) {
      const client = smtpFactory({ ...cfg, smtpPort: attempt.port, secure: attempt.secure });
      try {
        await client.connect();
        smtpOk = true;
        rows.push(`• SMTP (${cfg.smtpHost}:${attempt.port}) ✅ login ok — email bhej sakta hoon`);
        await client.quit?.();
        break;
      } catch (err) {
        try { await client?.quit?.(); } catch { /* bye */ }
        const last = attempt === attempts[attempts.length - 1];
        if (last) rows.push(`• SMTP (${cfg.smtpHost}:${attempt.port}) ❌ ${explainMailError(weakError(err))}`);
        else log?.info?.(`[mailsetup] smtp ${attempt.port} failed, trying next`);
      }
    }
  } else {
    rows.push('• SMTP ❌ host/user missing');
  }

  const text = [
    '🔎 *Live test*',
    ...rows,
    '',
    imapOk && smtpOk
      ? '✅ Dono ready — `/mail today` (padhna) aur `/email send …` (bhejna) chalega.'
      : imapOk
        ? '⚠️ Padhna chal raha hai, bhejna nahi. `/email guide` dekho ya 587/465 badal ke dekho.'
        : '⚠️ Login fail. App password dobara banao (2FA ON hona chahiye), phir `/email setup <address> <app-password>`.',
  ].join('\n');
  return { imapOk, smtpOk, rows, text };
}

/** One-line status for /email and /email status. No secret material. */
export function mailSetupStatus(opts = {}) {
  const file = fileFor(opts);
  const cfg = loadMailConfig(file);
  if (!cfg.user) return `📧 Email: *setup nahi hua* · \`/email setup psd_ai@gmail.com\` (30 second ka kaam)`;
  const preset = PROVIDERS[cfg.provider] ?? null;
  const when = cfg.setupAt
    ? new Date(cfg.setupAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
    : 'kabhi nahi';
  return [
    `📧 Email: *${cfg.user}*${preset ? ` (${preset.label})` : ''}`,
    `• IMAP ${cfg.host ?? '—'}${cfg.imapPort ? `:${cfg.imapPort}` : ''} · SMTP ${cfg.smtpHost ?? '—'}${cfg.smtpPort ? `:${cfg.smtpPort}` : ''}`,
    `• Password ${maskSecret(cfg.pass)} · ${sealState(cfg.pass) === 'sealed' ? 'sealed (0600 key)' : cfg.pass ? 'plaintext' : 'missing'}`,
    `• Monitor ${cfg.monitor ? 'ON' : 'OFF'} · set: ${when}`,
    'Test: `/email test` · Change: `/email setup <address> <app-password>` · Wipe: `/email forget`',
  ].join('\n');
}

/** Remove credentials + monitor flag. Keeps the rest of mail.json intact. */
export function forgetMail(opts = {}) {
  const file = fileFor(opts);
  const cfg = loadMailConfig(file);
  if (!cfg.user && !cfg.pass) return '📧 Kuch saved hi nahi tha.';
  const was = cfg.user;
  const next = { monitor: false, lastCheck: 0, lastCount: 0, lastSeenUids: [] };
  saveMailConfig(next, file);
  return `🧹 Mail credentials hata diye${was ? ` (${was})` : ''}. \`/email setup <address>\` se dobara lagao.`;
}

/**
 * Resolve a stored (possibly sealed) credential for a client. Legacy
 * plaintext keeps working; a broken key produces a clear instruction instead
 * of a stack trace.
 */
export function resolveStoredSecret(cfg, opts = {}) {
  try { return openSecret(cfg?.pass, opts); } catch (err) { return { error: err.message }; }
}
