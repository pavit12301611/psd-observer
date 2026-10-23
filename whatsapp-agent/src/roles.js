// roles.js — 👨‍👩‍👧‍👦 Family/Kids mode: guest numbers ko limited commands + daily
// time limit. Owner sets roles; handleGuest consults allowCommand().

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROLES_FILE = path.join(ROOT, 'data', 'roles.json');

export const KIDS_SAFE = ['help', 'study', 'revise', 'quiz', 'exp', 'cal', 'hw', 'fun', 'stats', 'today', 'weather', 'calc', 'wiki'];
export const KIDS_BLOCK = ['rm', 'delete', 'kill', 'shutdown', 'reboot', 'pc', 'shades', 'panic', 'rollback', 'shell', 'run', 'exec', 'copy', 'mail', 'clip', 'guard', 'focus', 'watch', 'make', 'topic', 'learn', 'teach'];

export function loadRoles(file = ROLES_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { users: {}, dailyLimitMin: 120 };
  }
}

function saveRoles(data, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch { /* best effort */ }
}

export function setRole(number, role, opts = {}) {
  const { file = ROLES_FILE } = opts;
  const data = loadRoles(file);
  data.users[String(number)] = { role: String(role).toLowerCase(), usedMs: 0, day: todayKey() };
  saveRoles(data, file);
  return `👨‍👩‍👧‍👦 *${number}* → role: *${role}*`;
}

export function todayKey(now = Date.now()) {
  const nowTs = typeof now === 'function' ? now() : now;
  return new Date(nowTs).toISOString().slice(0, 10);
}

/** Can this user run this command right now? */
export function allowCommand(number, cmd, opts = {}) {
  const { file = ROLES_FILE, now = Date.now } = opts;
  const data = loadRoles(file);
  const user = data.users[String(number)];
  if (!user) return { allow: true, reason: 'guest (no role set)' };
  if (user.role === 'admin') return { allow: true };
  if (KIDS_BLOCK.includes(String(cmd).toLowerCase())) {
    return { allow: false, reason: `👨‍👩‍👧‍👦 Kids mode: *${cmd}* allowed nahi hai.` };
  }
  if (user.role === 'kids') {
    if (!KIDS_SAFE.includes(String(cmd).toLowerCase())) {
      return { allow: false, reason: '👨‍👩‍👧‍👦 Kids mode: sirf study/fun commands allowed hain.' };
    }
    const nowTs = typeof now === 'function' ? now() : now;
    if (user.day !== todayKey(nowTs)) { user.day = todayKey(nowTs); user.usedMs = 0; }
    const limitMs = (data.dailyLimitMin ?? 120) * 60_000;
    if (user.usedMs >= limitMs) {
      return { allow: false, reason: `👨‍👩‍👧‍👦 Aaj ka time khatam (${data.dailyLimitMin ?? 120} min). Kal phir!` };
    }
    user.usedMs += 5 * 60_000; // ~5 min per command
    saveRoles(data, file);
    return { allow: true, leftMin: Math.round((limitMs - user.usedMs) / 60_000) };
  }
  return { allow: true };
}

export function rolesStatus(opts = {}) {
  const data = loadRoles(opts.file ?? ROLES_FILE);
  const rows = Object.entries(data.users).map(([n, u]) => `  • ${n} → ${u.role}`);
  return rows.length
    ? `👨‍👩‍👧‍👦 *Roles* (daily limit ${data.dailyLimitMin} min)\n${rows.join('\n')}`
    : '👨‍👩‍👧‍👦 Koi role set nahi. Set: `/role <number> kids|family|admin`';
}

export function setLimit(minutes, opts = {}) {
  const { file = ROLES_FILE } = opts;
  const data = loadRoles(file);
  data.dailyLimitMin = Math.max(10, Math.min(600, Number(minutes) || 120));
  saveRoles(data, file);
  return `👨‍👩‍👧‍👦 Daily limit → *${data.dailyLimitMin} min*`;
}
