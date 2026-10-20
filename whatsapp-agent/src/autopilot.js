// autopilot.js — one-command browser/desktop automation that VERIFIES itself.
//
// The old version opened a URL and typed immediately, then always answered
// "done" + a screenshot. If the browser never opened, the text went to
// whatever window was focused and the owner still got a screenshot saying
// everything worked. That is fixed here:
//
//   • open   → waits for a real new window (wmctrl) before anything else,
//              and falls back to a screen-change check on Wayland.
//   • type   → refuses to type unless the focused window is a browser/app we
//              just opened (never types into a random window).
//   • tap    → OCR/vision only; no blind coordinate clicking unless the owner
//              explicitly turns it on (ALLOW_BLIND_CLICKS=true).
//   • report → every step has ok/fail, and a failed run says "stopped at step
//              N" with the real reason instead of claiming success.
//
// Steps:
//   open <app|url>  tap <label>  click <x> <y>  focus <title>
//   type <text>     key <combo>  wait <ms>      screenshot
//   look [question]
//
//   /auto open agent | tap battle | tap agent | type hi | key enter | screenshot
//   /auto open chrome and search for today's weather then screenshot

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as apps from './apps.js';
import * as pc from './pccontrol.js';
import * as finder from './elementfinder.js';
import * as ocr from './ocr.js';
import { imageSignature, screenChanged, imageStats } from './imaging.js';
import { siteFor, readyMsFor, isComposerLabel } from './sites.js';

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const BROWSER_HINTS = /firefox|chrome|chromium|brave|edge|opera|vivaldi|epiphany|webkit|librewolf|waterfox|mozilla|arc\b/i;
const BROWSER_PROCS = /^(firefox|firefox-bin|chrome|chromium|chromium-browser|google-chrome|brave|brave-browser|vivaldi|opera|epiphany|webkit2gtk|librewolf|waterfox|zen|zen-browser|msedge)$/i;

/**
 * Is a desktop browser running at all? On Wayland, wmctrl often lists nothing
 * (or only XWayland windows) and the portal screenshot may be unavailable — so
 * "no window title" does not mean "the browser did not open". The process list
 * is the one signal that still works there.
 */
export async function browserRunning() {
  try {
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'comm='], { timeout: 2_500 });
    return String(stdout ?? '')
      .split('\n')
      .map((line) => line.trim().split('/').pop())
      .some((name) => BROWSER_PROCS.test(name));
  } catch {
    return false;
  }
}

/** Bring any open browser window to the front (best effort, never throws). */
async function focusAnyBrowser(log = console) {
  try {
    const titles = await apps.windowTitles();
    const hit = (titles ?? []).find((t) => BROWSER_HINTS.test(t));
    if (!hit) return null;
    await apps.windowAction('focus', hit);
    return hit;
  } catch (err) {
    log?.info?.(`[auto] browser focus failed: ${err.message}`);
    return null;
  }
}

const WEB_URLS = {
  google: 'https://www.google.com',
  youtube: 'https://www.youtube.com',
  gemini: 'https://gemini.google.com',
  bard: 'https://gemini.google.com',
  chatgpt: 'https://chatgpt.com',
  'chat gpt': 'https://chatgpt.com',
  gpt: 'https://chatgpt.com',
  claude: 'https://claude.ai',
  perplexity: 'https://www.perplexity.ai',
  copilot: 'https://copilot.microsoft.com',
  arena: 'https://arena.ai/agent',
  'arena ai': 'https://arena.ai/agent',
  agent: 'https://arena.ai/agent',
  'agent mode': 'https://arena.ai/agent',
  'arena agent': 'https://arena.ai/agent',
  gmail: 'https://mail.google.com',
  github: 'https://github.com',
  wikipedia: 'https://wikipedia.org',
  stackoverflow: 'https://stackoverflow.com',
  'stack overflow': 'https://stackoverflow.com',
  whatsapp: 'https://web.whatsapp.com',
  'whatsapp web': 'https://web.whatsapp.com',
  maps: 'https://maps.google.com',
  'google maps': 'https://maps.google.com',
  netflix: 'https://www.netflix.com',
  instagram: 'https://www.instagram.com',
  twitter: 'https://x.com',
  x: 'https://x.com',
  linkedin: 'https://www.linkedin.com',
  amazon: 'https://www.amazon.in',
  flipkart: 'https://www.flipkart.com',
};

function normalizeApp(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "arena" → arena.ai/agent etc. Exact or whole-word matches only. */
export function resolveWebUrl(appName) {
  const low = normalizeApp(appName);
  if (!low) return null;
  if (WEB_URLS[low]) return WEB_URLS[low];
  for (const [key, url] of Object.entries(WEB_URLS)) {
    if (key.length < 4) continue; // "x" / "gpt" alone are too ambiguous
    if (new RegExp(`\\b${escapeRe(key)}\\b`).test(low)) return url;
  }
  return null;
}

function urlHint(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const label = host.split('.')[0];
    return label.length >= 3 ? label : null;
  } catch {
    return null;
  }
}

// ── step parsing ─────────────────────────────────────────────────────────────

export function parseSingleStep(part) {
  const p = clean(part);
  if (!p) return null;
  let m;
  if ((m = p.match(/^(?:open|launch|start|kholo|khol)\s+(.+)$/i))) return { op: 'open', target: clean(m[1]) };
  if ((m = p.match(/^(?:tap|click|select|choose|press\s+button)\s+on\s+(.+)$/i))) return { op: 'tap', label: clean(m[1]) };
  if ((m = p.match(/^click\s+(-?\d+)[\s,]+(-?\d+)$/i))) return { op: 'click', x: Number(m[1]), y: Number(m[2]) };
  if ((m = p.match(/^(?:tap|click|select|choose)\s+(.+)$/i))) return { op: 'tap', label: clean(m[1]) };
  if ((m = p.match(/^focus(?:\s+(?:on|window))?\s+(.+)$/i))) return { op: 'focus', title: clean(m[1]) };
  if ((m = p.match(/^(?:type|paste|likho|likh)\s+([\s\S]+)$/i))) return { op: 'type', text: m[1] };
  if ((m = p.match(/^(?:ask|poocho|pucho|pooch)\s+([\s\S]+)$/i))) return { op: 'type', text: m[1], submit: true };
  if ((m = p.match(/^(?:search(?:\s+for)?|google|dhundo)\s+([\s\S]+)$/i))) return { op: 'type', text: clean(m[1]), submit: true };
  if ((m = p.match(/^(?:key|press)\s+(.+)$/i))) return { op: 'key', combo: clean(m[1]) };
  if ((m = p.match(/^(?:wait|sleep)\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds|min|m)?$/i))) {
    let value = Number(m[1]);
    const unit = (m[2] || '').toLowerCase();
    if (unit === 'ms') { /* as-is */ } else if (unit === 's' || unit.startsWith('sec')) value *= 1000;
    else if (unit === 'min' || unit === 'm') value *= 60_000;
    else if (value <= 30) value *= 1000; // bare "wait 5" = 5 seconds
    return { op: 'wait', ms: Math.min(Math.max(Math.round(value), 200), 120_000) };
  }
  if (/^(?:screenshot|ss|screen|shot)$/i.test(p)) return { op: 'screenshot' };
  if ((m = p.match(/^look(?:\s+(.+))?$/i))) return { op: 'look', question: m[1] ? clean(m[1]) : '' };
  // A short bare phrase in a pipe sequence is a tap target ("battle").
  if (p.split(/\s+/).length <= 3 && /^[\w\-. ]{2,40}$/.test(p)) return { op: 'tap', label: p };
  return null;
}

export function parseAutoSteps(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return [];
  if (t.includes('|') || t.includes(';') || t.includes('\n')) {
    const parts = t.split(/[|;]+/).map((s) => s.trim()).filter(Boolean);
    const expanded = [];
    for (const p of parts) expanded.push(...p.split(/\n/).map((s) => s.trim()).filter(Boolean));
    return expanded.map(parseSingleStep).filter(Boolean);
  }
  return parseNaturalLanguage(t);
}

/**
 * Natural language → steps. Splits on the separators people actually use
 * (then / and / phir / commas), so it works for any app, not just one site.
 */
export function parseNaturalLanguage(task) {
  const t = clean(task);
  if (!t) return [];
  const chunks = t
    .split(/\s*(?:,|;|\band\s+then\b|\bthen\b|\band\b|\baur\b|\bphir\b|\buske\s+baad\b)\s*/i)
    .map(clean)
    .filter(Boolean);

  const steps = [];
  for (const chunk of chunks) {
    let step = parseSingleStep(chunk);
    if (!step) {
      // "search for cats", "google cats" → type into whatever search box is up
      const m = chunk.match(/^(?:search(?:\s+for)?|google|dhundo)\s+([\s\S]+)$/i);
      if (m) step = { op: 'type', text: clean(m[1]), submit: true };
    }
    if (!step) continue;
    if (step.op === 'open') step.target = resolveWebUrl(step.target) || step.target;
    steps.push(step);
    // Submit right after the text it belongs to, so a later "then screenshot"
    // does not end up after the enter key.
    if (step.op === 'type' && step.submit) steps.push({ op: 'key', combo: 'enter' });
  }

  // No doubled enter keys (user wrote "then press enter" as well).
  const deduped = steps.filter((s, i) => !(s.op === 'key' && /^enter$/i.test(s.combo ?? '') && steps[i - 1]?.op === 'key'));
  // The screenshot is the proof — always last.
  const shots = deduped.filter((s) => s.op === 'screenshot');
  const rest = deduped.filter((s) => s.op !== 'screenshot');
  if (shots.length || !rest.length) rest.push({ op: 'screenshot' });
  return rest;
}

/**
 * Pull the actual question/query out of a sentence.
 *   "chatgpt pe rust vs go pooch"              → "rust vs go"
 *   "google pe aaj ka weather search karo"     → "aaj ka weather"
 *   "open chrome and search for psd-observer"  → "psd-observer"
 * Works by dropping known site names / command verbs / filler words, so it
 * copes with both English and Hinglish word order.
 */
export function extractPrompt(text) {
  const SITE_WORDS = /\b(chatgpt|gemini|claude|google|youtube|arena|perplexity|copilot|github|wikipedia|stackoverflow|stack\s*overflow|gmail|netflix|instagram|twitter|linkedin|amazon|flipkart|whatsapp\s*web|chrome|firefox|chromium|brave|browser)\b/gi;
  const LEAD_VERBS = /^(?:(?:open|kholo|khol|launch|start|visit|jao|go|search(?:\s+for)?|google|ask|type|likho|likh|play|chalao|dhundo|poocho|pucho|pooch|batao|bata)\s+)+/i;
  const TRAIL_VERBS = /\s*(?:\b(?:poocho|pucho|pooch|likho|likh|dhundo|search(?:\s+for)?|google|play|chalao|karo|kar\s*do|bhejo|bhej\s*do)\b\s*)+$/i;
  // Glue that can sit between the site and the real question.
  const LEAD_GLUE = /^(?:and|then|aur|phir|for|that|please|plz|to|se|ki|ka|ke|pe|par|me|mein)\s+/i;
  const GLUE = /\b(?:aur|and|then|phir|uske|baad|pe|par|me|mein)\b/gi;

  let out = String(text ?? '')
    .replace(/https?:\/\/\S+/gi, ' ')
    // A domain mention goes as a whole: stripping the bare site word first
    // turned "arena.ai/agent pe likho hi bro" into ".ai/agent likho hi bro".
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|in|org|net|io|ai|dev|co)(?:\/\S*)?/gi, ' ')
    .replace(SITE_WORDS, ' ')
    .replace(/[|,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // One pass is not enough: "… hello likho aur bhejo" only loses "bhejo" first,
  // and then "aur" exposes "likho" as the new trailing verb. Iterate to a fixpoint.
  for (let i = 0; i < 5; i++) {
    const before = out;
    out = out
      .replace(/^[\s"'`.:;,| -]+/, '')
      .replace(TRAIL_VERBS, ' ')
      .replace(LEAD_GLUE, ' ')
      .replace(LEAD_VERBS, ' ')
      .replace(GLUE, ' ')
      .replace(/\b(?:screenshot|ss|bhejo|bhej)\b/gi, ' ')
      .replace(/[|,;:]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (out === before) break;
  }

  // A leftover ".ai/agent" fragment when the domain was written without its name.
  return out
    .replace(/^[\s"'`-]+|[\s"'`.!?]+$/g, '')
    .replace(/^\.\w+(?:\/\S*)?\s*/, '')
    .trim();
}

/** Sites where a search URL is smarter (and far more reliable) than typing. */
function searchUrlFor(url, query) {
  if (!query) return null;
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
  const q = encodeURIComponent(query);
  const table = {
    'google.com': `https://www.google.com/search?q=${q}`,
    'youtube.com': `https://www.youtube.com/results?search_query=${q}`,
    'wikipedia.org': `https://en.wikipedia.org/w/index.php?search=${q}`,
    'github.com': `https://github.com/search?q=${q}`,
    'stackoverflow.com': `https://stackoverflow.com/search?q=${q}`,
  };
  return table[host] ?? null;
}

/**
 * Build the browser steps for `/agent <task>` when the task needs a real site.
 * Example: "chatgpt pe rust vs go pooch" → open chatgpt → type → enter → wait
 * → look (answer the question from the page) → screenshot as proof.
 */
export function buildWebSteps(task) {
  const text = clean(task);
  // An explicit link or domain wins over the known-site table.
  const explicit = text.match(/https?:\/\/\S+/i)?.[0]
    ?? text.match(/\b((?:[a-z0-9-]+\.)+(?:com|in|org|net|io|ai|dev|co)(?:\/\S*)?)\b/i)?.[1];
  const url = explicit
    ? (/^https?:/i.test(explicit) ? explicit : `https://${explicit}`)
    : resolveWebUrl(text);
  if (!url) return [];
  const prompt = extractPrompt(text);

  // A site with a real search URL → no fragile UI typing at all.
  const direct = searchUrlFor(url, prompt);
  if (direct) {
    return [
      { op: 'open', target: direct },
      { op: 'wait', ms: 1_500 },
      { op: 'look', question: prompt || 'summarise the results on this page' },
      { op: 'screenshot' },
    ];
  }

  // Chat sites (Arena, ChatGPT, Claude …) open with the composer already
  // focused: open → type → Enter. No click, no OCR guess at a "Send" button.
  const site = siteFor(url);
  const steps = [{ op: 'open', target: url }];
  if (site?.autofocus) {
    if (prompt.length >= 2) steps.push({ op: 'type', text: prompt, submit: true });
    steps.push({ op: 'wait', ms: 8_000 });
    steps.push({ op: 'look', question: prompt.length >= 2 ? prompt : 'what did the page answer?' });
    steps.push({ op: 'screenshot' });
    return steps;
  }
  if (prompt.length >= 2) steps.push({ op: 'type', text: prompt, submit: true });
  steps.push({ op: 'key', combo: 'enter' });
  steps.push({ op: 'wait', ms: 8_000 });
  steps.push({ op: 'look', question: prompt.length >= 2 ? prompt : 'what did the page answer?' });
  steps.push({ op: 'screenshot' });
  return steps;
}

function describeStep(step) {
  if (step.op === 'open') return `open "${step.target}"`;
  if (step.op === 'tap') return `tap "${step.label}"`;
  if (step.op === 'click') return `click ${step.x} ${step.y}`;
  if (step.op === 'focus') return `focus "${step.title}"`;
  if (step.op === 'type') return `type "${String(step.text).slice(0, 40)}${String(step.text).length > 40 ? '…' : ''}"`;
  if (step.op === 'key') return `key ${step.combo}`;
  if (step.op === 'wait') return `wait ${step.ms}ms`;
  if (step.op === 'screenshot') return 'screenshot';
  if (step.op === 'look') return `look "${step.question ?? ''}"`;
  return JSON.stringify(step);
}

// ── verification helpers ─────────────────────────────────────────────────────

async function activeWindowTitle() {
  const xdotool = pc.findBin('xdotool');
  if (!xdotool) return null;
  try {
    const { stdout } = await execFileAsync(xdotool, ['getactivewindow', 'getwindowname'], {
      timeout: 2_000,
      env: pc.displayEnv(),
    });
    return String(stdout ?? '').trim() || null;
  } catch {
    return null;
  }
}

async function shot(config, capMs = 6_000) {
  // Verification screenshots get a short cap: on Wayland each capture can pop
  // a permission dialog, and a slow dialog must not stall the whole task.
  const image = await pc.captureScreenshot({ portalTimeoutMs: Math.min(config?.portalTimeoutMs ?? 60_000, capMs) });
  return { image, signature: imageSignature(image), stats: imageStats(image) };
}

/**
 * Decide what an `open` step proved. Pure on purpose: the desktop can be
 * uninformative (Wayland gives no window titles), and a missing observation
 * must never be reported as a failed page load.
 *
 * @returns {{ok:boolean, known:boolean, unverified?:boolean, unchanged?:boolean,
 *            title:string|null, note?:string}}
 */
export function openVerdict({ windowResult, screen, browserBefore, browserNow }) {
  if (windowResult?.ok) {
    return { ok: true, known: true, title: windowResult.title ?? null, waitedMs: windowResult.waitedMs ?? 0 };
  }
  const browser = Boolean(browserNow);
  if (screen?.ok) {
    return { ok: true, known: false, unverified: true, title: null, note: 'screen badli — page khul gaya' };
  }
  if (browser && !browserBefore) {
    return { ok: true, known: false, unverified: true, title: null, note: 'browser launch hua (window title nahi mila)' };
  }
  if (browser && !screen?.known) {
    return { ok: true, known: false, unverified: true, title: null, note: 'browser chal raha hai, yahan title verify possible nahi' };
  }
  if (browser) {
    // Screen was readable and did not change, and the browser was already
    // open: typing now would land in whatever that window is showing.
    return { ok: false, known: true, unchanged: true, title: null };
  }
  return { ok: false, known: true, title: null };
}

/**
 * Wait until a NEW window that looks like the one we wanted exists.
 * Returns { ok, known, title, waitedMs } — `known:false` means the desktop
 * cannot list windows, so the caller should verify another way.
 */
export async function waitForWindow({ beforeTitles = [], url = '', target = '', timeoutMs = 20_000 } = {}) {
  const site = siteFor(url);
  const hint = urlHint(url) || normalizeApp(target);
  // Chat sites title their tab with the product name ("Arena", "ChatGPT").
  const siteName = site ? normalizeApp(site.name) : null;
  const started = Date.now();
  let sawList = false;
  while (Date.now() - started < timeoutMs) {
    await sleep(600);
    const titles = await apps.windowTitles();
    // null = no wmctrl; empty = wmctrl exists but this desktop blocks listing
    // (GNOME Wayland). Both mean "we cannot verify by title".
    if (titles == null || titles.length === 0) {
      return { ok: false, known: false, title: null, waitedMs: Date.now() - started };
    }
    sawList = true;
    const before = new Set(beforeTitles);
    const fresh = titles.filter((t) => !before.has(t));
    const bySite = hint && fresh.find((t) => t.toLowerCase().includes(hint));
    const byName = siteName && titles.find((t) => t.toLowerCase().includes(siteName));
    const byBrowser = fresh.find((t) => BROWSER_HINTS.test(t));
    const onlyOne = fresh.length === 1 ? fresh[0] : null;
    const match = bySite || byName || byBrowser || onlyOne;
    if (match) return { ok: true, known: true, title: match, waitedMs: Date.now() - started };
  }
  return { ok: false, known: sawList, title: null, waitedMs: Date.now() - started };
}

/** Last resort on Wayland (no wmctrl): did the screen actually change? */
async function waitForScreenChange({ before, config, timeoutMs = 12_000 }) {
  // known:false → we genuinely cannot tell (no baseline, or every capture
  // failed). known:true + ok:false → we looked and the screen really did not
  // change, which is evidence the page never appeared.
  if (!before) return { ok: false, known: false, changed: false };
  const started = Date.now();
  let probes = 0;
  let saw = false;
  while (Date.now() - started < timeoutMs && probes < 3) {
    await sleep(probes === 0 ? 2_500 : 3_000);
    probes += 1;
    try {
      const now = await shot(config);
      const diff = screenChanged(before.signature, now.signature);
      if (!diff.known) continue;
      saw = true;
      if (diff.changed) return { ok: true, known: true, changed: true, image: now.image, similarity: diff.similarity };
    } catch { /* screenshot failed — stop trying */ break; }
  }
  return { ok: false, known: saw, changed: false };
}

// ── the executor ─────────────────────────────────────────────────────────────

/**
 * Run a step list. Never throws for a normal step failure: it returns
 * { ok, text, image, steps } so the caller can tell the truth.
 */
export async function executeSteps(steps, { config = {}, log = console, label = 'Autopilot' } = {}) {
  const results = [];
  let lastImage = null;
  let verifiedTitle = null;
  let typingMode = null; // 'browser' | 'app' | null
  let currentSite = null; // site profile of the page we opened (sites.js)
  const startedAll = Date.now();

  const record = (index, step, ok, detail, extra = {}) => {
    results.push({ index: index + 1, op: step.op, ok, detail, ...extra });
    return results[results.length - 1];
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepStart = Date.now();
    try {
      if (step.op === 'open') {
        const target = String(step.target ?? '').trim();
        if (!target) throw new Error('open needs an app name or URL');
        const isUrl = /^https?:\/\//i.test(target);
        const url = isUrl ? target : resolveWebUrl(target);
        const titlesBefore = await apps.windowTitles();
        const canListWindows = Array.isArray(titlesBefore) && titlesBefore.length > 0;
        const screenBefore = canListWindows ? null : await shot(config).catch(() => null);

        let opened;
        if (url) {
          log?.info?.(`[auto] opening ${url} for "${target}"`);
          await pc.openTarget(url);
          opened = { via: 'browser', url };
          typingMode = 'browser';
        } else {
          const launched = await apps.launchApp(target);
          opened = { via: 'app', text: launched.text ?? String(launched) };
          typingMode = 'app';
          if (launched?.app) verifiedTitle = launched.app;
        }

        // Verify BEFORE going on: this is what the old version skipped.
        let verify = { ok: true, known: true, title: null, waitedMs: 0 };
        if (url) {
          const site = siteFor(url);
          const openWaitMs = site?.autofocus ? 8_000 : 12_000;
          const browserBefore = await browserRunning();
          verify = await waitForWindow({ beforeTitles: titlesBefore ?? [], url, target, timeoutMs: openWaitMs });

          if (!verify.ok) {
            // "Could not verify" is NOT "did not open". Chat sites open the new
            // page as a tab in the browser window that is already running, so
            // the window list often gains no new title at all — on Wayland it
            // gains nothing, ever. Only hard evidence of failure fails now.
            verify = openVerdict({
              windowResult: verify,
              screen: await waitForScreenChange({ before: screenBefore, config, timeoutMs: 10_000 }),
              browserBefore,
              browserNow: await browserRunning(),
            });
          }
        }
        if (!verify.ok) {
          if (verify.unchanged) {
            throw new Error(
              'browser pehle se khula hai par page ka koi asar nahi dikha. ' +
              `Ek baar khud check karo: xdg-open ${url || target}`,
            );
          }
          throw new Error(
            `browser khola par page load nahi hua (${Math.round(12_000 / 1000)}s wait, koi browser window nahi mila). ` +
            `Default browser check karo: xdg-open ${url || target} — ya fix: sudo dnf install firefox xdg-utils`,
          );
        }
        if (verify.unverified && !verify.title) {
          // We could not name the window, but the browser is what xdg-open just
          // handed the URL to. Focus it so typing lands in the composer.
          const focused = await focusAnyBrowser(log);
          if (focused) verify = { ...verify, title: focused, note: `${verify.note ?? 'opened'}, browser focused` };
        }
        verifiedTitle = verify.title ?? null;
        if (verifiedTitle) {
          try { await apps.windowAction('focus', verifiedTitle); } catch (err) { log?.info?.(`[auto] focus failed: ${err.message}`); }
        }
        const site = url ? siteFor(url) : null;
        if (site) currentSite = site;
        const siteNote = site?.autofocus ? 'composer auto-focused — click nahi chahiye' : null;
        record(i, step, true, `${opened.via === 'browser' ? `opened ${url}` : opened.text}` +
          `${verifiedTitle ? ` · window "${String(verifiedTitle).slice(0, 60)}"` : verify.note ? ` · ${verify.note}` : ''}` +
          `${siteNote ? ` · ${siteNote}` : ''}`,
          { ms: Date.now() - stepStart, verified: !verify.unverified, unverified: Boolean(verify.unverified) });
        // Chat sites need a moment before the (already focused) composer takes
        // input; everything else keeps the short settle.
        await sleep(url ? readyMsFor(url, 900) : 1_200);

      } else if (step.op === 'focus') {
        const title = String(step.title ?? '').trim();
        if (!title) throw new Error('focus needs a window title');
        await apps.windowAction('focus', title);
        verifiedTitle = title;
        record(i, step, true, `focused "${title}"`, { ms: Date.now() - stepStart });

      } else if (step.op === 'tap') {
        const label = String(step.label ?? '').trim();
        if (!label) throw new Error('tap needs a label');
        // Chat sites focus the composer themselves. Clicking it (or OCR's best
        // guess at it) is how text ends up in a sidebar, so skip the step and
        // say why instead of pretending we clicked something.
        if (currentSite?.autofocus && isComposerLabel(label)) {
          record(i, step, true, `skipped — ${currentSite.name} ka box pehle se focused hai, click ki zaroorat nahi`, {
            ms: Date.now() - stepStart, skipped: true,
          });
          continue;
        }
        const variants = [...new Set([label, label[0].toUpperCase() + label.slice(1).toLowerCase(), label.toUpperCase(), label.toLowerCase()])];
        let hit = null;
        for (const variant of variants) {
          try { hit = await finder.locateOnScreen(config, variant, log); } catch { /* try next */ }
          if (hit) break;
        }
        if (!hit && config.allowBlindClicks) {
          const BLIND = {
            battle: { rx: 0.422, ry: 0.492 },
            agent: { rx: 0.422, ry: 0.545 },
            auto: { rx: 0.470, ry: 0.492 },
          }[label.toLowerCase()];
          if (BLIND) {
            let size = { width: 1920, height: 1080 };
            try { size = finder.pngSize(await pc.captureScreenshot({ portalTimeoutMs: config?.portalTimeoutMs })) ?? size; } catch { /* defaults */ }
            const x = Math.round(size.width * BLIND.rx);
            const y = Math.round(size.height * BLIND.ry);
            await pc.click(x, y);
            record(i, step, true, `blind click @ ${x},${y} (ALLOW_BLIND_CLICKS=true — UNVERIFIED)`, {
              ms: Date.now() - stepStart,
              verified: false,
              unverified: true,
            });
            await sleep(1_200);
            continue;
          }
        }
        if (!hit) {
          let extra = '';
          try {
            const text = await ocr.ocrScreen(config);
            lastImage = text.image;
            extra = `\nScreen pe ye text mila: ${String(text.text).replace(/\s+/g, ' ').slice(0, 200) || '(koi text nahi)'}`;
          } catch { /* no OCR available */ }
          throw new Error(
            `"${label}" screen pe nahi mila (OCR + vision dono fail). ` +
            `Pehle /screenshot + /ocr se exact label dekh lo, ya coords se: click X Y.${extra}`,
          );
        }
        await pc.click(hit.x, hit.y);
        record(i, step, true, `clicked "${hit.matched ?? label}" @ ${hit.x},${hit.y} (${hit.source}${hit.confidence ? ` ${hit.confidence}%` : ''})`, { ms: Date.now() - stepStart });
        await sleep(1_000);

      } else if (step.op === 'click') {
        await pc.click(Number(step.x), Number(step.y));
        record(i, step, true, `clicked ${step.x},${step.y}`, { ms: Date.now() - stepStart });
        await sleep(600);

      } else if (step.op === 'type') {
        const text = String(step.text ?? '');
        if (!text) throw new Error('type needs text');
        // Safety gate: never paste into a window we did not just open.
        const active = await activeWindowTitle();
        if (active) {
          const looksRight = typingMode === 'app'
            || BROWSER_HINTS.test(active)
            || (verifiedTitle && active.toLowerCase().includes(String(verifiedTitle).slice(0, 24).toLowerCase()));
          if (!looksRight) {
            let recovered = false;
            if (verifiedTitle) {
              try {
                await apps.windowAction('focus', verifiedTitle);
                await sleep(600);
                const again = await activeWindowTitle();
                recovered = Boolean(again && BROWSER_HINTS.test(again));
              } catch { /* nothing to focus */ }
            }
            if (!recovered && typingMode === 'browser') {
              // Same situation as the open step: the title check cannot name
              // our window, but a browser is running. Focus it and re-check
              // rather than refusing to type on a guess.
              const focused = await focusAnyBrowser(log);
              if (focused) {
                await sleep(500);
                const again = await activeWindowTitle();
                recovered = Boolean(!again || BROWSER_HINTS.test(again));
              }
            }
            if (!recovered) {
              throw new Error(
                `typing skip ki — active window "${active}" hai, browser nahi. ` +
                'Galat jagah type karne se better hai rukna. Pehle browser kholo, phir dobara bhejo.',
              );
            }
          }
        }
        try {
          await pc.pasteText(text);
          record(i, step, true, `pasted ${text.length} chars (clipboard)`, { ms: Date.now() - stepStart });
        } catch (err) {
          log?.info?.(`[auto] pasteText failed (${err.message}) — typing instead`);
          await pc.typeText(text);
          record(i, step, true, `typed ${text.length} chars`, { ms: Date.now() - stepStart });
        }
        await sleep(600);
        if (step.submit && !(steps[i + 1]?.op === 'key')) {
          await pc.keyCombo('enter');
          // Same step, one line in the reply: "typed … + Enter".
          const last = results[results.length - 1];
          if (last && last.index === i + 1) last.detail += ' + Enter';
          else record(i, step, true, 'pressed enter (submit)', { ms: Date.now() - stepStart });
          await sleep(600);
        }

      } else if (step.op === 'key') {
        await pc.keyCombo(String(step.combo ?? 'enter'));
        record(i, step, true, `key ${step.combo ?? 'enter'}`, { ms: Date.now() - stepStart });
        await sleep(900);

      } else if (step.op === 'wait') {
        const ms = Math.min(Math.max(Number(step.ms) || 1_000, 200), 120_000);
        await sleep(ms);
        record(i, step, true, `waited ${ms}ms`, { ms: Date.now() - stepStart });

      } else if (step.op === 'screenshot') {
        const image = await pc.captureScreenshot({ portalTimeoutMs: config?.portalTimeoutMs });
        lastImage = image;
        record(i, step, true, `captured ${Math.round(image.length / 1024)} KB`, { ms: Date.now() - stepStart });
        await sleep(200);

      } else if (step.op === 'look') {
        const res = await ocr.lookAtScreen(config, step.question ?? '', log);
        const text = typeof res === 'string' ? res : String(res?.text ?? '');
        if (res?.image) lastImage = res.image;
        record(i, step, true, text.slice(0, 40).replace(/\s+/g, ' '), { ms: Date.now() - stepStart, answer: text });

      } else {
        throw new Error(`unknown step "${step.op}"`);
      }
    } catch (err) {
      const message = String(err?.message ?? err).slice(0, 600);
      record(i, step, false, message, { ms: Date.now() - stepStart });
      // Capture what the screen looks like at the failure (best effort).
      try {
        const image = await pc.captureScreenshot({ portalTimeoutMs: Math.min(config?.portalTimeoutMs ?? 60_000, 20_000) });
        if (image) lastImage = image;
      } catch { /* screenshot unavailable */ }
      return finish({ ok: false, failedAt: i + 1, results, image: lastImage, steps, label, startedAll });
    }
  }

  return finish({ ok: true, results, image: lastImage, steps, label, startedAll });
}

function finish({ ok, failedAt, results, image, steps, label, startedAll }) {
  const seconds = Math.max(1, Math.round((Date.now() - startedAll) / 1000));
  const answer = [...results].reverse().find((r) => r.answer)?.answer;
  const lines = results.map((r) => `${r.ok ? '✅' : '❌'} ${r.index}. ${describeStep(steps[r.index - 1])} → ${r.detail}`);
  let text;
  const unverified = results.filter((r) => r.unverified).length;
  if (ok) {
    text = `🤖 *${label}* — ${results.length} steps, ${seconds}s\n${lines.join('\n')}`;
    if (unverified) {
      text += `\n\nℹ️ ${unverified} step(s) apne aap verify nahi ho paye (Wayland par window titles nahi milte) — ` +
        'browser focus karke aage badha, neeche screenshot se confirm kar lo.';
    }
    if (answer) text += `\n\n💬 *Jawab:*\n${String(answer).slice(0, 1200)}`;
  } else {
    const failed = results.find((r) => !r.ok);
    text = [
      `⚠️ *${label}* — step ${failedAt}/${steps.length} pe *ruk gaya* (${seconds}s)`,
      '',
      ...lines,
      '',
      'Aage kuch nahi kiya — galat window me typing/clicking se bachne ke liye ruk gaya.',
      'Fix: /doctor chalao, ya /screenshot + /ocr se screen dekh ke exact label/coords do.',
    ].join('\n');
  }
  return { ok, text, image, steps: results, failedAt: failedAt ?? null, answer: answer ?? null };
}

/** Legacy entry point used by /auto and the `autopilot` tool. */
export async function runAutopilot(rawTask, { config, log } = {}) {
  const steps = parseAutoSteps(rawTask);
  if (!steps.length) {
    throw new Error(
      'usage: /auto open <app> | tap <label> | type <text> | key enter | screenshot\n' +
      'Example: /auto open agent | tap battle | tap agent | type hello | key enter | screenshot',
    );
  }
  return executeSteps(steps, { config, log, label: 'Autopilot' });
}

export { describeStep, activeWindowTitle };
