// macrohistory.js — 💾 /savemacro: bina /teach recording ke, last N commands
// ko ek named macro bana do. "roz same 4 commands" → ek command me.

import * as learn from './learn.js';

const recent = []; // {cmd, args, at} ring buffer
export const MAX_RECENT = 30;

const TRACK_SKIP = new Set(['savemacro', 'teach', 'stop', 'cancel', 'abort', 'ruko', 'help', 'ping']);

export function trackCommand(cmd, args = '') {
  const c = String(cmd ?? '').trim().toLowerCase();
  if (!c || TRACK_SKIP.has(c)) return;
  recent.push({ cmd: c, args: String(args ?? ''), at: Date.now() });
  if (recent.length > MAX_RECENT) recent.shift();
}

export function recentCommands(n = 5) {
  return recent.slice(-Math.max(1, Math.min(n, MAX_RECENT)));
}

/** Save last n commands as a macro (learned entry — replay via /<name>). */
export function saveMacroFromHistory(store, nameRaw, n = 5) {
  const name = learn.normalizeKeyword(nameRaw);
  const err = learn.validateKeyword(name);
  if (err) return { ok: false, error: `💾 ${err}` };
  const picked = recentCommands(n);
  if (picked.length < 2) {
    return { ok: false, error: '💾 Kam se kam 2 commands chahiye history me (abhi bahut kam hain).' };
  }
  const commands = picked.map((r) => `/${r.cmd}${r.args ? ` ${r.args}` : ''}`);
  const entry = store?.addLearned?.(name, commands, `/savemacro ${name} ${n}`);
  if (!entry) return { ok: false, error: '💾 store.addLearned nahi mila' };
  return {
    ok: true,
    entry,
    reply: `💾 *Macro "${name}" saved* — ${picked.length} commands:\n${commands.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nChalao: \`/${name}\``,
  };
}

export function clearRecent() {
  recent.length = 0;
}
