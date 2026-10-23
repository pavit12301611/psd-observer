// revisioncall.js — 📞 Voice Revision Call: JARVIS call karke due flashcards
// poochta hai, tum jawab do, next segment me sahi jawab + score. Builder is
// pure (segments), the call engine (voicecall.js) speaks them in order.

export function buildRevisionSegments(pack, opts = {}) {
  const { due = null, max = 5, now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const cards = due ?? (pack?.flashcards ?? []).slice(0, max);
  const pick = cards.slice(0, max);
  if (!pick.length) return [];
  const segs = [];
  segs.push({ say: `Revision call shuru. ${pick.length} sawal. Har sawal ke baad jawab do, phir main bataunga. Chalo.`, kind: 'intro' });
  pick.forEach((c, i) => {
    segs.push({ say: `Sawal ${i + 1}. ${c.q}`, kind: 'question', card: c });
    segs.push({ say: `Sahi jawab hai. ${c.a}`, kind: 'reveal', card: c });
  });
  segs.push({ say: 'Khatam. Great job! `/revise` se roz practice karte raho.', kind: 'outro' });
  void nowTs;
  return segs;
}

/** Score what the owner said vs the card (simple keyword overlap). */
export function scoreAnswerSpoken(card, spoken) {
  const s = String(spoken ?? '').toLowerCase();
  const a = String(card?.a ?? '').toLowerCase();
  if (!s.trim()) return { correct: false, score: 0 };
  const words = a.split(/\W+/).filter((w) => w.length > 3);
  const hits = words.filter((w) => s.includes(w)).length;
  const score = words.length ? hits / words.length : 0;
  return { correct: score >= 0.4, score };
}

/** Human summary after the call. */
export function revisionSummary(results) {
  const total = results.length;
  const right = results.filter((r) => r.correct).length;
  return `📞 *Revision call done* — ${right}/${total} sahi (${total ? Math.round((right / total) * 100) : 0}%)\n${right === total ? 'Perfect! 🏆' : 'Kal phir se! 💪'}`;
}
