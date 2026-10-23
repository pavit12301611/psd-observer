// sourcelinks.js — 📚 Har informative jawab me source links (Wikipedia etc).
// grounding.js ke results se URLs nikal ke answer ke neeche chipka deta hai.

/** Pull {title,url} sources out of a grounding/wiki result (flexible shapes). */
export function extractSources(grounding) {
  if (!grounding) return [];
  const raw = grounding.sources ?? grounding.citations ?? grounding.refs ?? [];
  const out = [];
  for (const s of raw) {
    if (typeof s === 'string') out.push({ url: s, title: s.replace(/^https?:\/\//, '').slice(0, 60) });
    else if (s && (s.url ?? s.link)) out.push({ url: s.url ?? s.link, title: s.title ?? s.name ?? String(s.url ?? s.link).slice(0, 60) });
  }
  return out.slice(0, 4);
}

/** Append a compact "Source:" footer when we have sources. No-op otherwise. */
export function withSource(answer, sources) {
  const list = Array.isArray(sources) ? sources : extractSources(sources);
  if (!list.length || !answer) return answer;
  const lines = list.map((s) => `• ${s.title} — ${s.url}`);
  return `${answer}\n\n📚 *Sources*\n${lines.join('\n')}`;
}
