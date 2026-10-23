// catchup.js — ⏰ Missed-schedule catch-up: PC band tha jab brief/cron due
// tha? On hote hi pending kaam turant + "missed while off" note.

export function missedJobs(jobs, opts = {}) {
  const { now = Date.now, graceMs = 5 * 60_000, maxAgeMs = 24 * 3600_000 } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  return (jobs ?? []).filter((j) => {
    const due = j.nextDueTs ?? j.dueTs ?? j.due ?? 0;
    if (!due || due > nowTs - graceMs) return false; // not yet overdue
    return nowTs - due <= maxAgeMs; // too old = forget (24h window)
  });
}

/** Human note appended to a catch-up run so it never looks live. */
export function catchupNote(job, opts = {}) {
  const { now = Date.now, tz = 'Asia/Kolkata' } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const due = job.nextDueTs ?? job.dueTs ?? job.due ?? 0;
  const when = new Date(due).toLocaleString('en-IN', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short',
  });
  return `⏰ _Ye ${when} ka scheduled tha — PC band tha, isliye abhi bheja (missed catch-up)._`;
}

/**
 * Run all missed jobs through `runJob(job)` (injected). Returns report lines.
 * `advance(job)` reschedules; injected so store ops stay outside.
 */
export async function runCatchup(jobs, opts = {}) {
  const { runJob, advance, now = Date.now } = opts;
  const due = missedJobs(jobs, { now });
  const lines = [];
  for (const job of due) {
    try {
      const out = await runJob(job);
      lines.push(`${job.text ?? job.cmd ?? 'job'}: ${typeof out === 'string' ? out.slice(0, 120) : 'done'}`);
    } catch (err) {
      lines.push(`${job.text ?? 'job'}: fail (${err?.message ?? err})`);
    }
    advance?.(job);
  }
  return { ran: due.length, lines };
}
