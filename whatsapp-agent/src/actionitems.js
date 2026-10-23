// actionitems.js — 🎙️→📝 Meeting transcript se action items: "Friday tak
// submit", "Rahul will email the deck" → due dates + owners. Pure parser +
// optional brain enrich. `/notes` ke baad auto-suggest.

const VERBS = /(submit|send|email|finish|complete|prepare|review|share|book|schedule|draft|fix|update|call|check)/i;
const TIME_WORDS = /\b(today|tomorrow|kal|parso|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|agle hafte|\d{1,2}\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|by (?:the )?(?:end of )?(?:day|week|month))\b/i;

/** Extract action items from transcript lines. */
export function extractActions(transcript) {
  const out = [];
  const lines = String(transcript ?? '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    const hasVerb = VERBS.test(line);
    const hasTime = TIME_WORDS.test(line);
    if (!hasVerb) continue;
    // owner: "X will ..." / "X: ..." / "X ko ..."
    const ownerM = line.match(/(?:^|\b)([A-Z][a-z]{2,12})\s+(?:will|should|karega|karegi|ko)\b/)
      ?? line.match(/^([A-Z][a-z]{2,12}):/);
    out.push({
      task: line.replace(/^(?:and|aur|ok|okay|theek)\s+/i, '').slice(0, 160),
      owner: ownerM?.[1] ?? null,
      dueHint: hasTime ? (line.match(TIME_WORDS)?.[0] ?? null) : null,
    });
    if (out.length >= 10) break;
  }
  return out;
}

/** Suggest calendar/hw entries text from extracted actions. */
export function actionsReply(actions) {
  if (!actions.length) return null;
  const rows = actions.map((a, i) =>
    `${i + 1}. ${a.task}${a.owner ? ` — *${a.owner}*` : ''}${a.dueHint ? ` (${a.dueHint})` : ''}`);
  return [
    '📝 *Action items mile:*\n' + rows.join('\n'),
    '',
    'Add karun? `/hw add <task> <due>` ya `/cal add <when> <task>` bolo.',
  ].join('\n');
}

/** Brain-enriched extraction (optional). `enrich(text)` returns JSON actions. */
export async function extractActionsSmart(transcript, opts = {}) {
  const { enrich } = opts;
  const basic = extractActions(transcript);
  if (typeof enrich !== 'function') return basic;
  try {
    const smart = await enrich(String(transcript).slice(0, 8000));
    if (Array.isArray(smart) && smart.length) return smart.slice(0, 10);
  } catch { /* basic below */ }
  return basic;
}
