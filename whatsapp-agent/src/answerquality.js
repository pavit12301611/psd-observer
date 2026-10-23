// answerquality.js — 🏆 Squad answer scoring: jab kai bots jawab dete hain,
// best kaunsa hai — keyword coverage, completeness, refusal-penalty se
// auto-decide. Winner ka jawab hi owner ko jaata hai.

/** Score an answer for a question: 0..1. Pure, testable. */
export function scoreAnswer(question, answer) {
  const q = String(question ?? '').toLowerCase();
  const a = String(answer ?? '').trim();
  if (!a) return 0;

  const qWords = [...new Set(q.split(/\W+/).filter((w) => w.length > 3))];
  const aLower = a.toLowerCase();
  const covered = qWords.filter((w) => aLower.includes(w)).length;
  const coverage = qWords.length ? covered / qWords.length : 0.5;

  // completeness: too short is lazy, very long may be padding
  const len = a.length;
  const lengthScore = len < 30 ? 0.25 : len < 4000 ? 1 : 0.6;

  // refusal / hedging penalty
  const refusal = /\b(don'?t know|pata nahi|nahi bata sakta|cannot help|unable to|no idea)\b/i.test(a) ? 0.35 : 1;

  // concrete detail bonus (numbers, code, steps)
  const concrete = /\d|\b(step|pehle|phir|first|then|because|kyunki)\b/i.test(a) ? 1.1 : 1;

  return Math.min(1, coverage * 0.5 + 0.25 * lengthScore) * refusal * Math.min(concrete, 1.1);
}

/** Pick the winner from [{name, text}] — ties keep the first. */
export function bestAnswer(question, answers) {
  const scored = (answers ?? [])
    .map((r) => ({ name: r.name ?? 'bot', text: r.text ?? '', score: scoreAnswer(question, r.text) }))
    .sort((a, b) => b.score - a.score);
  return { winner: scored[0] ?? null, ranked: scored };
}
