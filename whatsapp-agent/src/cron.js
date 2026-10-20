// cron.js — recurring scheduled jobs (A2 feature)
// Free, offline, no external cron needed. Owner-only, persisted in store.json
// Supports:
//   every <N><s|m|h|d>            e.g. every 10m, every 2h, har 30 second
//   daily at <time>               e.g. every day at 9am, roz 9 baje, daily at 18:30
//   weekly on <weekday> at <time> e.g. every Monday at 9am, har Monday 9 baje
//   every weekday at 9am / every weekend at 10am
//
// Time parsing respects config.timezone (Asia/Kolkata) but stored as UTC timestamp
// and nextDue computed in local wall-clock terms via Intl-friendly Date math.

const UNIT_MS = {
  s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
};

const WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  // hindi / hinglish variants
  ravivaar: 0, itvaar: 0, somvaar: 1, somvar: 1, mangalvaar: 2, mangalvar: 2,
  budhvaar: 3, budhvar: 3, guruvaar: 4, guruwar: 4, shukravaar: 5, shukravar: 5, shanivaar: 6,
};

function parseClockPart(s) {
  // "9am", "9:30pm", "18:30", "9 baje", "9" -> { hour, minute }
  const raw = String(s ?? '').trim().toLowerCase().replace(/\s*baje\s*/i, '').replace(/\s+/g, ' ').trim();
  let m;
  // 9:30 am/pm
  m = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hour = Number(m[1]);
  let minute = Number(m[2] ?? 0);
  if (hour > 23 || minute > 59) return null;
  if (m[3]) {
    const ap = m[3].toLowerCase();
    if (ap === 'pm' && hour < 12) hour += 12;
    if (ap === 'am' && hour === 12) hour = 0;
  }
  return { hour, minute };
}

function nextDailyAt(hour, minute, now = new Date()) {
  const due = new Date(now);
  due.setHours(hour, minute, 0, 0);
  if (due.getTime() <= now.getTime()) due.setDate(due.getDate() + 1);
  return due;
}

function nextWeeklyAt(weekday, hour, minute, now = new Date()) {
  const due = new Date(now);
  due.setHours(hour, minute, 0, 0);
  const curDay = due.getDay();
  let diff = (weekday - curDay + 7) % 7;
  // if today is the weekday but time already passed -> next week
  if (diff === 0 && due.getTime() <= now.getTime()) diff = 7;
  if (diff !== 0) {
    due.setDate(due.getDate() + diff);
  }
  // If diff was 0 and time still future, keep today
  return due;
}

/**
 * Parse a cron schedule prefix and return { schedule, scheduleRaw, nextDueTs, rest }
 * Input examples:
 *  "every 10m drink water"
 *  "har 2 ghante me backup"
 *  "every day at 9am good morning"
 *  "roz 9 baje chai"
 *  "every Monday at 9am standup"
 */
export function parseCronSchedule(input, now = new Date()) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  const lower = text.toLowerCase();

  let m;

  // 1) Interval: every <N> <unit> [me] <rest>
  //    Supports hinglish: har, roz is not interval but daily
  //    Pattern: (every|har|har ek|har 1) <num> <unit>
  m = text.match(/^(?:every|har)\s+(?:ek\s+)?(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|ghante?|ghanta|days?|d|second|minute|hour|day)\s*(?:me|mein|ko)?\s+([\s\S]+)$/i);
  if (m) {
    const num = Number(m[1]);
    const unitRaw = m[2].toLowerCase();
    // map hinglish ghante -> hours
    let unit = unitRaw;
    if (unitRaw.startsWith('ghante') || unitRaw.startsWith('ghanta')) unit = 'h';
    const msPerUnit = UNIT_MS[unit] ?? UNIT_MS[unit.replace(/s$/, '')];
    if (msPerUnit && num > 0) {
      const everyMs = num * msPerUnit;
      // guard: at least 30 seconds, at most 30 days to avoid abuse
      if (everyMs < 30_000) return { error: 'Interval kam se kam 30 seconds hona chahiye. Try: every 1m' };
      if (everyMs > 30 * 86_400_000) return { error: 'Interval 30 din se zyada nahi.' };
      const schedule = { kind: 'interval', everyMs };
      const scheduleRaw = `every ${num}${unitRaw.startsWith('g') ? 'h' : unitRaw.slice(0, 1) === 's' ? 's' : unitRaw.includes('m') ? 'm' : unitRaw.includes('h') ? 'h' : 'd'}`;
      // Better raw: keep original prefix
      const rawPrefix = text.match(/^(?:every|har)\s+(?:ek\s+)?\d+(?:\.\d+)?\s*[^\s]+\s*(?:me|mein|ko)?/i)?.[0] ?? `every ${num} ${unitRaw}`;
      return { schedule, scheduleRaw: rawPrefix.trim(), rest: m[3].trim(), nextDueTs: now.getTime() + everyMs };
    }
  }

  // 2) Daily: [every|har|roz] [day|din] at <time> <rest>
  //    e.g. "every day at 9am good morning", "roz 9 baje chai", "daily at 18:30 gym", "har din 9am backup"
  m = text.match(/^(?:every|har|roz|daily)\s*(?:day|daily|din)?\s*(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm|baje)?)\s+([\s\S]+)$/i);
  if (m) {
    const clock = parseClockPart(m[1]);
    if (clock) {
      const schedule = { kind: 'daily', hour: clock.hour, minute: clock.minute };
      const next = nextDailyAt(clock.hour, clock.minute, now);
      const rawPrefix = text.slice(0, text.toLowerCase().indexOf(m[2].toLowerCase())).trim();
      // include up to time
      const fullPrefix = text.match(/^(?:every|har|roz|daily)\s*(?:day|daily|din)?\s*(?:at\s+)?\d[^\s]*\s*(?:am|pm|baje)?/i)?.[0] ?? `daily at ${m[1]}`;
      return { schedule, scheduleRaw: fullPrefix, rest: m[2].trim(), nextDueTs: next.getTime() };
    }
  }

  // 2b) Alternate daily phrasing: "at 9am daily <rest>" or "9am roz <rest>"
  m = text.match(/^at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s+(?:daily|roz)?\s*([\s\S]+)$/i);
  if (m) {
    const clock = parseClockPart(m[1]);
    if (clock) {
      const schedule = { kind: 'daily', hour: clock.hour, minute: clock.minute };
      return { schedule, scheduleRaw: `daily at ${m[1]}`, rest: m[2].trim(), nextDueTs: nextDailyAt(clock.hour, clock.minute, now).getTime() };
    }
  }

  // 3) Weekly: every <weekday> at <time> <rest>
  //    e.g. "every Monday at 9am standup", "har Monday 9 baje meeting"
  m = text.match(/^(?:every|har)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|ravivaar|itvaar|somvaar|somvar|mangalvaar|mangalvar|budhvaar|budhvar|guruvaar|guruwar|shukravaar|shukravar|shanivaar)\s*(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm|baje)?)\s+([\s\S]+)$/i);
  if (m) {
    const weekday = WEEKDAYS[m[1].toLowerCase()];
    const clock = parseClockPart(m[2]);
    if (weekday != null && clock) {
      const schedule = { kind: 'weekly', weekday, hour: clock.hour, minute: clock.minute };
      return { schedule, scheduleRaw: `every ${m[1]} at ${m[2]}`, rest: m[3].trim(), nextDueTs: nextWeeklyAt(weekday, clock.hour, clock.minute, now).getTime() };
    }
  }

  // 3b) Weekday / Weekend shorthand: every weekday at 9am / every weekend at 10am
  m = text.match(/^every\s+(weekday|weekdays|weekend|weekends)\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm|baje)?)\s+([\s\S]+)$/i);
  if (m) {
    const clock = parseClockPart(m[2]);
    if (clock) {
      const kind = m[1].toLowerCase().startsWith('weekday') ? 'weekday' : 'weekend';
      // Represent as kind with weekdays list
      const schedule = { kind, hour: clock.hour, minute: clock.minute };
      // compute next due: check today then forward
      let nextDue = nextDailyAt(clock.hour, clock.minute, now);
      const isWeekend = (d) => [0, 6].includes(d.getDay());
      const isWeekday = (d) => !isWeekend(d);
      const predicate = kind === 'weekday' ? isWeekday : isWeekend;
      // if today's day doesn't match the kind, advance until it does
      let tries = 0;
      while (!predicate(nextDue) && tries < 8) {
        nextDue.setDate(nextDue.getDate() + 1);
        tries++;
      }
      // if today matches but time passed, we already handled via nextDailyAt forward
      // but if we advanced due to mismatch, need to keep time
      return { schedule, scheduleRaw: `every ${kind} at ${m[2]}`, rest: m[3].trim(), nextDueTs: nextDue.getTime() };
    }
  }

  // 1b) Interval shorthand (fallback after daily/weekly): "every hour", "har ghante", "every day" as interval 24h
  m = text.match(/^(?:every|har)\s+(hour|ghante?|ghanta|day|din)\s+([\s\S]+)$/i);
  if (m) {
    const unitRaw = m[1].toLowerCase();
    let everyMs = 3600_000;
    if (unitRaw.startsWith('day') || unitRaw === 'din') everyMs = 86_400_000;
    const schedule = { kind: 'interval', everyMs };
    return { schedule, scheduleRaw: m[0].split(' ').slice(0, 2).join(' '), rest: m[2].trim(), nextDueTs: now.getTime() + everyMs };
  }

  return null;
}

export function computeNextDue(schedule, fromTs = Date.now()) {
  const now = new Date(fromTs);
  if (!schedule) return fromTs + 60_000;
  if (schedule.kind === 'interval') {
    return fromTs + schedule.everyMs;
  }
  if (schedule.kind === 'daily') {
    // nextDailyAt expects "now" as base; we want fromTs as base but ensure it's in future
    const base = new Date(fromTs);
    // set to today at hour:minute, if <= base then tomorrow
    const cand = new Date(base);
    cand.setHours(schedule.hour, schedule.minute, 0, 0);
    if (cand.getTime() <= base.getTime()) cand.setDate(cand.getDate() + 1);
    return cand.getTime();
  }
  if (schedule.kind === 'weekly') {
    return nextWeeklyAt(schedule.weekday, schedule.hour, schedule.minute, new Date(fromTs)).getTime();
  }
  if (schedule.kind === 'weekday' || schedule.kind === 'weekend') {
    const next = new Date(fromTs);
    next.setHours(schedule.hour, schedule.minute, 0, 0);
    if (next.getTime() <= fromTs) next.setDate(next.getDate() + 1);
    const isWeekend = (d) => [0, 6].includes(d.getDay());
    const pred = schedule.kind === 'weekday' ? (d) => !isWeekend(d) : isWeekend;
    let tries = 0;
    while (!pred(next) && tries < 8) {
      next.setDate(next.getDate() + 1);
      tries++;
    }
    return next.getTime();
  }
  return fromTs + 60_000;
}

export function describeSchedule(schedule) {
  if (!schedule) return 'unknown schedule';
  if (schedule.kind === 'interval') {
    const ms = schedule.everyMs;
    if (ms % 86_400_000 === 0) return `every ${ms / 86_400_000}d`;
    if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000}h`;
    if (ms % 60_000 === 0) return `every ${ms / 60_000}m`;
    return `every ${Math.round(ms / 1000)}s`;
  }
  if (schedule.kind === 'daily') {
    const hh = String(schedule.hour).padStart(2, '0');
    const mm = String(schedule.minute).padStart(2, '0');
    return `daily at ${hh}:${mm}`;
  }
  if (schedule.kind === 'weekly') {
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const hh = String(schedule.hour).padStart(2, '0');
    const mm = String(schedule.minute).padStart(2, '0');
    return `every ${names[schedule.weekday]} at ${hh}:${mm}`;
  }
  if (schedule.kind === 'weekday' || schedule.kind === 'weekend') {
    const hh = String(schedule.hour).padStart(2, '0');
    const mm = String(schedule.minute).padStart(2, '0');
    return `every ${schedule.kind} at ${hh}:${mm}`;
  }
  return JSON.stringify(schedule);
}

// human readable next due
export function formatSchedule(schedule, nextDueTs, tz = 'Asia/Kolkata') {
  const base = describeSchedule(schedule);
  const when = new Intl.DateTimeFormat('en-IN', {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(nextDueTs));
  return `${base} → ${when}`;
}

/** Loop that fires due cron jobs every 30s. Recurring! Survives restarts. */
/**
 * Fire every job whose time has come. Exported (not just inlined in the timer)
 * so a test can run it once instead of waiting 30 seconds.
 * Returns the list of job ids that fired.
 */
export async function runDueJobs(store, send, log = console, runCommand = null, now = Date.now()) {
  const fired = [];
  {
    const jobs = store.listCronJobs();
    if (!jobs.length) return fired;
    const due = jobs.filter(j => j.nextDueTs <= now);
    if (!due.length) return fired;
    for (const job of due) {
      try {
        // compute new nextDue BEFORE sending, so if send fails we don't spam
        const nextDue = computeNextDue(job.schedule, now);
        // update store
        const idx = store.data.cronJobs.findIndex(j => j.id === job.id);
        if (idx !== -1) {
          store.data.cronJobs[idx].nextDueTs = nextDue;
          store.data.cronJobs[idx].lastRunTs = now;
          store.data.cronJobs.sort((a, b) => a.nextDueTs - b.nextDueTs);
          store.save();
        }
        const nextStr = new Intl.DateTimeFormat('en-IN', {
          timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short',
          hour: 'numeric', minute: '2-digit', hour12: true,
        }).format(new Date(nextDue));
        // A job whose text is a command ("/brief") runs through the agent, so
        // scheduled work is the same code as manual work — not a second path.
        let output = null;
        if (typeof runCommand === 'function' && String(job.text).trim().startsWith('/')) {
          try {
            output = await runCommand(String(job.text).trim());
          } catch (err) {
            log.warn?.(`[cron] #${job.id} command failed: ${err.message}`);
            output = `⚠️ Scheduled /${job.text} fail hua: ${err.message}`;
          }
        }
        if (output != null) await send(output);
        else await send(`🔁 *Scheduled:* ${job.text}\n_${job.scheduleRaw} · next ${nextStr}_`);
        fired.push(job.id);
        log.info?.(`[cron] fired #${job.id} "${job.text.slice(0,40)}" → next ${new Date(nextDue).toISOString()}`);
      } catch (err) {
        log.error?.(`[cron] job #${job.id} failed: ${err.message}`);
      }
    }
  }
  return fired;
}

export function startCronLoop(store, send, log = console, runCommand = null) {
  const timer = setInterval(() => {
    runDueJobs(store, send, log, runCommand).catch((err) => log.error?.(`[cron] loop failed: ${err.message}`));
  }, 30_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
