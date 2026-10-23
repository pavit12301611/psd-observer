// formfill.js — 📝 One-command form fill: "/fill name:Rahul, email:x@y.com,
// phone:98..." — har field me type karke Tab se next field. Runner injected
// (prod: pc.type + pc.key tab).

export function parseFill(text) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  return s
    .split(',')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const m = chunk.match(/^([^:]{1,40})\s*:\s*(.+)$/);
      return m ? { field: m[1].trim(), value: m[2].trim() } : null;
    })
    .filter(Boolean);
}

/**
 * Fill fields in order: type(value) → tab → type(value) …
 * `type(text)` and `tab()` are injected async fns.
 */
export async function fillForm(fields, opts = {}) {
  const { type, tab } = opts;
  if (typeof type !== 'function' || typeof tab !== 'function') {
    return { ok: false, error: '📝 type()/tab() runners chahiye' };
  }
  if (!fields.length) return { ok: false, error: '📝 Usage: `/fill name:Rahul, phone:98…` (field:value pairs)' };
  let typed = 0;
  for (let i = 0; i < fields.length; i++) {
    await type(fields[i].value);
    typed++;
    if (i < fields.length - 1) await tab();
  }
  return {
    ok: true,
    typed,
    reply: `📝 *${typed} fields fill ho gaye* — ${fields.map((f) => f.field).join(' → ')}\n(End me Enter dabana na bhoolna)`,
  };
}

export function fillReply(result) {
  return result.ok ? result.reply : result.error;
}
