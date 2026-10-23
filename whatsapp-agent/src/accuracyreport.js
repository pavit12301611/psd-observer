// accuracyreport.js — 📊 Bot ka apna report card: kitne sawal, kitne
// verified, deterministic hits, corrections. `/accuracy report`.

export function accuracyReport(store, opts = {}) {
  const s = store?.data?.accuracyStats ?? {};
  const asked = s.asked ?? s.total ?? 0;
  const verified = s.verifiedAnswers ?? 0;
  const det = s.deterministicHits ?? 0;
  const corrected = s.corrections ?? 0;
  const pct = asked ? Math.round(((verified + det) / asked) * 100) : null;
  const rows = [
    `📊 *Accuracy report*`,
    `• Sawaal aaye: ${asked}`,
    `• Verified answers: ${verified}`,
    `• Deterministic hits: ${det}`,
    `• Corrections seekhi: ${corrected}`,
  ];
  if (pct != null) rows.push(`• Hit rate: *${pct}%*`);
  return rows.join('\n');
}

export function accuracyTrend(store) {
  const weeks = store?.data?.accuracyWeeks ?? [];
  if (weeks.length < 2) return null;
  const last = weeks[weeks.length - 1];
  const prev = weeks[weeks.length - 2];
  const delta = (last.pct ?? 0) - (prev.pct ?? 0);
  return `📈 Trend: ${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)}% vs pichhle hafte`;
}
