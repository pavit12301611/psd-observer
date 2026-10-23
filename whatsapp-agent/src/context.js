// context.js — 🧠 Multi-turn memory: "wo file bhejo", "kal wali photo",
// "pichhla sawal" — bot ko pichhli baat ka context yaad rehta hai.
// Slots track the last thing of each kind; resolveRefs() rewrites pronouns
// before the intent parser sees the message.

const slots = {
  file: null, photo: null, pdf: null, folder: null,
  topic: null, app: null, path: null, lastQuestion: null, updatedAt: 0,
};

const SLOT_FOR_NOUN = {
  file: 'file', photo: 'photo', pdf: 'pdf', video: 'file',
  folder: 'folder', dir: 'folder', app: 'app', topic: 'topic',
  question: 'lastQuestion', sawal: 'lastQuestion',
};

export function remember(kind, value) {
  const k = kind in slots ? kind : null;
  if (!k || value == null) return false;
  slots[k] = String(value);
  slots.updatedAt = Date.now();
  return true;
}

export function recall(kind) {
  return slots[kind] ?? null;
}

export function snapshot() {
  return { ...slots };
}

export function clearContext() {
  for (const k of Object.keys(slots)) slots[k] = k === 'updatedAt' ? 0 : null;
  return '🧠 Context clear — ab nayi baat shuru.';
}

/**
 * Rewrite "wo/us/pichhli/kal wali <noun>" with the remembered value.
 * Conservative: only single-token replacements, never touches other words.
 */
export function resolveRefs(text) {
  let out = String(text ?? '');
  // "wo file", "woh pdf", "us folder ko", "kal wali photo", "pichhla sawal"
  const re = /\b(woh?|us|pichhl[ia]|kal wali|last)\s+(file|photo|pdf|video|folder|dir|app|topic|question|sawal)\b/gi;
  out = out.replace(re, (m, _det, noun) => {
    const slot = SLOT_FOR_NOUN[noun.toLowerCase()];
    return slot && slots[slot] ? slots[slot] : m;
  });
  return out;
}

/** Auto-capture entities from an outgoing command so the NEXT message can
 *  refer to them ("wo file"). Called after each handled command. */
export function absorb(text) {
  const s = String(text ?? '');
  const pathM = s.match(/(?:^|\s)([~./\w-]*[\w-]+\.(?:pdf|png|jpe?g|txt|md|csv|zip|mp[34]|docx?|xlsx?))/i);
  if (pathM) {
    remember('file', pathM[1]); // every path is a "file" for "wo file"
    if (pathM[1].toLowerCase().endsWith('.pdf')) remember('pdf', pathM[1]);
  }
  const folderM = s.match(/(?:folder|dir|directory)\s+([~./\w-]+)/i);
  if (folderM) remember('folder', folderM[1]);
  const appM = s.match(/\/open\s+([\w-]+)/i) ?? s.match(/\b(?:kholo|open)\s+([\w-]+)/i);
  if (appM) remember('app', appM[1]);
}

export function contextStatus() {
  const filled = Object.entries(slots)
    .filter(([k, v]) => k !== 'updatedAt' && v)
    .map(([k, v]) => `  ${k}: ${String(v).slice(0, 60)}`);
  return filled.length
    ? `🧠 *Yaad rakha hua context*\n${filled.join('\n')}\n(Bol "wo file bhejo" type commands — samajh jaunga)`
    : '🧠 Context abhi khaali hai — koi bhi command do, main yaad rakhunga.';
}
