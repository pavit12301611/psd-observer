// watch.js — "jab ye ho jaye to batao" (watch the screen for a condition).
//
// One condition, looked at on a timer: screenshot → vision model → YES/NO.
// On YES the owner gets the screenshot plus one line; then the watcher goes
// quiet for a cooldown so a condition that stays true does not spam.
//
// Examples:
//   /watch jab build complete ho jaye
//   /watch every 2m OTP box khali hai kya
//   /watch once — jab 'In stock' dikhe tab batao
//   /watch list · /watch stop 2 · /watch stop all
//
// Vision is required (this is why 2.7.0 moved the eyes off OCR): a text-only
// model cannot answer "is the download bar gone?".

let seq = 1;

const uid = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

export function watchers(store) {
  if (!store?.data) return [];
  if (!Array.isArray(store.data.watchers)) store.data.watchers = [];
  return store.data.watchers;
}

/**
 * Parse "/watch …" args.
 * Returns {action:'list'|'stop'|'add', condition, everyMs, once, id}.
 */
export function parseWatchArgs(args = '') {
  const raw = String(args ?? '').trim();
  const lower = raw.toLowerCase();
  if (!raw || /^(list|ls|all|status)$/.test(lower)) return { action: 'list' };
  const stop = raw.match(/^(?:stop|del|delete|rm|hatao|cancel)\s*(.*)$/i);
  if (stop) {
    const what = stop[1].trim();
    if (!what || /^all$/i.test(what)) return { action: 'stop', all: true };
    return { action: 'stop', id: what.replace(/^#/, '') };
  }

  let rest = raw;
  let everyMs = 60_000;
  let once = false;

  // "every 2m" / "har 30 second" can be anywhere before the condition.
  const every = rest.match(/\b(?:every|har)\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hour|hours)\b\.?\s*/i);
  if (every) {
    const unit = every[2].toLowerCase();
    const mult = unit.startsWith('s') ? 1_000 : unit.startsWith('m') ? 60_000 : 3_600_000;
    everyMs = Math.max(10_000, Number(every[1]) * mult);
    rest = rest.replace(every[0], ' ');
  }
  if (/\b(?:once|ek baar|sirf ek)\b/i.test(rest)) {
    once = true;
    rest = rest.replace(/\b(?:once|ek baar|sirf ek)\b/i, ' ');
  }
  const condition = rest.replace(/\s+/g, ' ').replace(/^[-–—:]\s*/, '').trim();
  if (condition.length < 3) return { action: 'invalid' };
  return { action: 'add', condition: condition.slice(0, 300), everyMs, once };
}

export function addWatcher(store, { condition, everyMs = 60_000, once = false }, now = Date.now()) {
  const list = watchers(store);
  const watcher = {
    id: uid(),
    condition,
    everyMs: Math.max(10_000, Number(everyMs) || 60_000),
    once: Boolean(once),
    hits: 0,
    checks: 0,
    createdTs: now,
    lastRunTs: 0,
    lastHitTs: 0,
    lastAnswer: null,
  };
  list.push(watcher);
  store.save?.();
  return watcher;
}

export function removeWatcher(store, id) {
  const list = watchers(store);
  const wanted = String(id ?? '').replace(/^#/, '');
  const index = list.findIndex((w) => w.id === wanted || String(list.indexOf(w) + 1) === wanted);
  if (index === -1) return null;
  const [removed] = list.splice(index, 1);
  store.save?.();
  return removed;
}

export function clearWatchers(store) {
  const list = watchers(store);
  const n = list.length;
  store.data.watchers = [];
  store.save?.();
  return n;
}

/** "YES", "haan", "yes — download finished" → true. Anything else is no. */
export function parseWatchDecision(text) {
  const s = String(text ?? '').trim();
  if (!s) return { hit: false, why: 'empty reply' };
  // A JSON reply like {"hit":true,"why":"…"} is also accepted.
  const json = s.match(/\{[^}]*\}/);
  if (json) {
    try {
      const data = JSON.parse(json[0]);
      const value = data.hit ?? data.yes ?? data.answer;
      if (typeof value === 'boolean') return { hit: value, why: String(data.why ?? data.reason ?? '') };
      if (typeof value === 'string') return parseWatchDecision(value);
    } catch { /* fall through to plain text */ }
  }
  const first = s.toLowerCase().replace(/^["'*_\s]+/, '').split(/[\s.,:;!—–-]/)[0];
  if (/^(yes|y|haan|han|ha|true|sahi|bilkul|confirmed)$/.test(first)) {
    return { hit: true, why: s.slice(0, 200) };
  }
  return { hit: false, why: s.slice(0, 200) };
}

export function buildWatchPrompt(condition) {
  return [
    'You are watching a computer screen for one condition. Look at the screenshot yourself.',
    `CONDITION: "${condition}"`,
    'Reply with exactly one word: YES if the condition is visibly true on this screen right now,',
    'NO if it is not. If the screen is unreadable, reply MAYBE.',
    'Do not explain, do not add punctuation, do not guess — only YES, NO or MAYBE.',
  ].join('\n');
}

/**
 * Look once. deps.observe / deps.think are injectable so tests never touch a
 * real screen or a real model.
 */
export async function checkWatcher(watcher, { config, log = console, deps = {}, signal = null } = {}) {
  const observe = deps.observe ?? (async (cfg, lg, opts) => {
    const hands = await import('./hands.js');
    return hands.observeScreen(cfg, lg, opts);
  });
  const think = deps.think ?? (async (prompt, imageBase64, mime) => {
    const ai = await import('./ai.js');
    return ai.screenStep(config, prompt, imageBase64, log, { mime, signal, maxTokens: 12 });
  });
  const shrink = deps.shrink ?? (async (image, width, quality) => {
    const hands = await import('./hands.js');
    return hands.shrinkForModel(image, width, quality);
  });

  const shot = await observe(config, log, { useOcr: false, signal });
  if (!shot?.image) return { hit: false, error: 'screenshot nahi mila' };
  const { image, mime } = await shrink(shot.image, 1280, 75);
  const reply = await think(buildWatchPrompt(watcher.condition), image.toString('base64'), mime);
  const text = typeof reply === 'string' ? reply : reply?.text;
  if (!text) return { hit: false, error: 'vision model se jawab nahi aaya' };
  const decision = parseWatchDecision(text);
  return {
    hit: decision.hit,
    why: decision.why,
    image: shot.image,
    model: typeof reply === 'object' ? reply?.model : null,
    answered: /maybe|unreadable|clear nahi/i.test(text),
  };
}

export function describeWatcher(watcher, index) {
  const every = watcher.everyMs >= 3_600_000
    ? `${Math.round(watcher.everyMs / 3_600_000)}h`
    : watcher.everyMs >= 60_000 ? `${Math.round(watcher.everyMs / 60_000)}m` : `${Math.round(watcher.everyMs / 1000)}s`;
  const hit = watcher.hits ? ` · ${watcher.hits}× mila` : '';
  const once = watcher.once ? ' · ek baar' : '';
  return `#${index + 1} ${watcher.condition} _(${every}${once}${hit})_`;
}

/**
 * Background loop. Checks each watcher when its own interval is due; alerts on
 * a YES; never throws out of the timer.
 */
export function startWatchLoop({
  config, store, send, log = console, deps = {}, tickMs = 15_000, getSignal = () => null,
}) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      for (const watcher of [...watchers(store)]) {
        if (now - (watcher.lastRunTs ?? 0) < watcher.everyMs) continue;
        if (watcher.lastHitTs && now - watcher.lastHitTs < Math.max(watcher.everyMs, 10 * 60_000)) continue;
        watcher.lastRunTs = now;
        watcher.checks = (watcher.checks ?? 0) + 1;
        try {
          const result = await checkWatcher(watcher, { config, log, deps, signal: getSignal() });
          watcher.lastAnswer = result.error ? `error: ${result.error}` : result.hit ? 'YES' : 'NO';
          if (result.error) {
            // Three failures in a row = stop quietly instead of burning quota.
            watcher.errors = (watcher.errors ?? 0) + 1;
            if (watcher.errors >= 3) {
              removeWatcher(store, watcher.id);
              await send(`👁️ *Watch band* — "${watcher.condition}" 3 baar check nahi ho paya (${result.error}).`);
            }
            continue;
          }
          watcher.errors = 0;
          if (!result.hit) continue;
          watcher.hits = (watcher.hits ?? 0) + 1;
          watcher.lastHitTs = now;
          const time = new Date(now).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
          const head = `👁️ *Watch mil gaya* · ${time}\n_"${watcher.condition}"_`;
          const tail = watcher.once ? '\n\n_(Ek baar wala watch — ab band.)_' : '\n\n_(Agla alert 10 min baad, agar phir sach hua.)_';
          if (result.image) await send({ image: result.image, text: head + tail });
          else await send(head + tail);
          if (watcher.once) removeWatcher(store, watcher.id);
        } catch (err) {
          log.warn?.(`[watch] ${watcher.id} failed: ${err.message}`);
        }
        store.save?.();
      }
    } finally {
      busy = false;
    }
  }, Math.max(5_000, tickMs));
  timer.unref?.();
  return () => clearInterval(timer);
}
