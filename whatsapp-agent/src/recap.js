// recap.js — 🗓️ Weekly recap: Sunday ko auto-summary — kitna padha, kitna
// kharcha, kitne tasks done, accuracy. Pure composition — sources injected.

export function buildRecap(opts = {}) {
  const {
    focusWeek = () => null,
    expWeek = () => null,
    hwDone = 0, hwTotal = 0,
    statsWeek = () => null,
    examCountdown = () => null,
    accuracy = () => null,
  } = opts;

  const lines = ['🗓️ *Weekly Recap* — pichhle 7 din'];
  const focus = safe(focusWeek);
  if (focus) lines.push(`\n${focus}`);
  const stats = safe(statsWeek);
  if (stats) lines.push(`\n${stats}`);
  if (hwTotal) lines.push(`\n📝 Homework: ${hwDone}/${hwTotal} complete`);
  const exp = safe(expWeek);
  if (exp) lines.push(`\n${exp.split('\n').slice(0, 4).join('\n')}`);
  const acc = safe(accuracy);
  if (acc) lines.push(`\n${acc.split('\n').slice(0, 3).join('\n')}`);
  const exams = safe(examCountdown);
  if (exams) lines.push(`\n${exams}`);
  if (lines.length === 1) lines.push('\nIs hafte kuch record nahi hua — agle hafte try karte hain! 💪');
  return lines.join('\n');
}

function safe(fn) {
  try {
    const r = fn();
    return typeof r === 'string' && r.trim() ? r : null;
  } catch {
    return null;
  }
}

/** Suggestion line at the end — keep it honest and short. */
export function recapGoal(facts = {}) {
  if ((facts.focusMin ?? 0) < 60) return '🎯 Agle hafte goal: kam se kam 60 min deep work.';
  if ((facts.hwDone ?? 0) < (facts.hwTotal ?? 1)) return '🎯 Agle hafte goal: saara homework time pe.';
  return '🎯 Is hafte solid tha — next week aur upar! 🚀';
}
