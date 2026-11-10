// mailsend.js — ✉️ One place that actually sends mail (shared by /email send
// and the AI's `send_email` action, so both behave identically).
//
// Deliberately small: resolve the saved account, unseal the password, talk to
// the provider's SMTP, and return a sentence a human can act on. No credential
// ever appears in the result.

import path from 'node:path';
import { loadMailConfig, MAIL_FILE } from './mail.js';
import { createSmtpClient, scrubCredentials } from './smtp.js';
import { explainMailError, resolveStoredSecret } from './mailsetup.js';

/** This fork's owner inbox — `/mailme` ka default. `/email to` se badal sakte ho. */
export const DEFAULT_OWNER_EMAIL = 'pavitsingh3222@gmail.com';

/**
 * Kahan bhejna hai, priority order me: `/email to` se saved → OWNER_EMAIL env →
 * memory ka email fact → fork ka default. Return hamesha ek valid address.
 */
export function resolveOwnerEmail({ config = null, store = null } = {}) {
  const candidates = [
    store?.data?.ownerEmail,
    config?.ownerEmail,
    store?.data?.facts?.email,
    store?.data?.facts?.gmail,
    DEFAULT_OWNER_EMAIL,
  ];
  for (const raw of candidates) {
    const value = typeof raw === 'string' ? raw : raw?.value;
    const address = String(value ?? '').trim().toLowerCase();
    if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(address)) return address;
  }
  return DEFAULT_OWNER_EMAIL;
}

/** Pehli line se subject, taaki `/mailme hi bhai` bhi ek accha mail bane. */
export function autoSubject(text, { prefix = 'Observer' } = {}) {
  const firstLine = String(text ?? '').split(/\r?\n/).find((line) => line.trim()) ?? '';
  const snippet = firstLine.replace(/\s+/g, ' ').trim().slice(0, 60);
  return snippet ? `${prefix} · ${snippet}` : `${prefix} · note`;
}

export function mailFileFor(config) {
  if (config?.dataDir) return path.join(config.dataDir, 'mail.json');
  return MAIL_FILE;
}

const clean = (value) => String(value ?? '').trim();

/**
 * Send one email.
 * @returns {Promise<{ok: boolean, text: string, messageId?: string, to?: string}>}
 */
export async function sendMail({ to, subject, text, html = null, attachments = [] } = {}, opts = {}) {
  const { config = null, file = mailFileFor(config), clientFactory = createSmtpClient, log = null } = opts;
  const recipient = clean(to);
  if (!recipient) return { ok: false, text: '✉️ "To" address chahiye.' };

  let cfg;
  try { cfg = loadMailConfig(file); } catch { cfg = {}; }
  if (!cfg.user || !cfg.smtpHost) {
    return {
      ok: false,
      text: '✉️ Email setup nahi hua.\nPehle: `/email setup psd_ai@gmail.com` (auto-detect + live test, 30 second).',
    };
  }

  const secret = resolveStoredSecret(cfg, { dir: path.dirname(file), log });
  const pass = typeof secret === 'string' ? secret : '';
  if (!pass) {
    return { ok: false, text: `✉️ Saved password khul nahi raha${secret?.error ? ` — ${secret.error}` : ''}.\n\`/email setup ${cfg.user} <app-password>\` se dobara lagao.` };
  }

  const attempt = async (port, secure) => {
    const client = clientFactory({
      host: cfg.smtpHost, port, secure, user: cfg.user, pass,
    });
    await client.connect();
    const result = await client.send({
      from: cfg.user,
      to: recipient,
      subject: clean(subject) || '(no subject)',
      text: String(text ?? ''),
      html,
      attachments,
    });
    await client.quit?.();
    return result;
  };

  let result;
  try {
    result = await attempt(cfg.smtpPort ?? 465, cfg.secure !== false);
  } catch (err) {
    const altPort = (cfg.smtpPort ?? 465) === 465 ? 587 : 465;
    log?.info?.(`[mail] smtp ${cfg.smtpPort ?? 465} failed, trying ${altPort}`);
    try {
      result = await attempt(altPort, altPort === 465);
    } catch (err2) {
      const reason = explainMailError(scrubCredentials(err2?.message ?? err2, [pass]));
      return { ok: false, text: `✉️ Mail nahi gaya — ${reason}\n\`/email test\` se dono directions check karo.` };
    }
  }

  return {
    ok: true,
    messageId: result?.messageId,
    to: recipient,
    text: `✉️ *Sent* → ${recipient}\n• Subject: ${clean(subject) || '(no subject)'}\n• ${result?.bytes ?? 0} bytes · id ${String(result?.messageId ?? '').slice(0, 12)}…`,
  };
}
