// leaveby.js — 🚗 Leave-by calculator: "/leaveby 9am 25km" → kab niklo.
// Traffic factor optional (watch se live traffic page bhi chal sakta hai).

export function parseLeave(text) {
  const s = String(text ?? '').trim();
  const toMin = (h, m, ampm) => {
    let hour = Number(h);
    const a = (ampm ?? '').toLowerCase();
    if (a === 'pm' && hour < 12) hour += 12;
    if (a === 'am' && hour === 12) hour = 0;
    return { hour, minute: Number(m ?? 0) };
  };
  // "9am 25km" / "9:30 pm 25 km"
  const t1 = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(\d+(?:\.\d+)?)\s*km$/i);
  if (t1) return { arriveBy: toMin(t1[1], t1[2], t1[3]), km: Number(t1[4]) };
  // "25km 9am" / "25 km 9:30pm"
  const t2 = s.match(/^(\d+(?:\.\d+)?)\s*km\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (t2) return { arriveBy: toMin(t2[2], t2[3], t2[4]), km: Number(t2[1]) };
  return null;
}

export function leaveByReply(text, opts = {}) {
  const {
    speedKmph = 30,
    bufferMin = 15,
    now = Date.now,
  } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const parsed = parseLeave(text);
  if (!parsed) return '🚗 Usage: `/leaveby 9am 25km` — kitne baje pahunchna hai aur doori.';
  const base = new Date(nowTs);
  const arrive = new Date(base.getFullYear(), base.getMonth(), base.getDate(), parsed.arriveBy.hour, parsed.arriveBy.minute).getTime();
  const driveMin = Math.round((parsed.km / speedKmph) * 60) + bufferMin;
  const leaveAt = arrive - driveMin * 60_000;
  const fmt = (ts) => new Date(ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
  const late = leaveAt < nowTs;
  return [
    `🚗 *Leave-by calc* — ${parsed.km} km, ~${speedKmph} km/h + ${bufferMin} min buffer`,
    `• Pahunchna: ${fmt(arrive)}`,
    `• *Nikalna:* ${fmt(leaveAt)}${late ? ' ⚠️ *(already late — abhi niklo!)*' : ''}`,
    `• Drive time: ~${driveMin} min`,
  ].join('\n');
}
