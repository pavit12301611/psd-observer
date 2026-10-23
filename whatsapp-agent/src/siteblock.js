// siteblock.js — 🚫 Website blocker (focus mode ke liye): blocked sites ke
// windows close kar deta hai (wmctrl -c) — ROOT/CUSTOM HOSTS KI ZARURAT NAHI.
// Window list injected (tests fake it).

const DEFAULT_BLOCK = ['youtube.com', 'instagram.com', 'facebook.com', 'netflix.com', 'twitter.com', 'x.com', 'reddit.com'];

export function parseBlockList(text) {
  const s = String(text ?? '').trim();
  if (!s) return DEFAULT_BLOCK;
  return s.split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean).map((x) => x.replace(/^www\./, ''));
}

/** Find windows whose titles look like blocked sites. */
export function findBlockedWindows(windows, sites) {
  const list = Array.isArray(windows) ? windows : String(windows ?? '').split('\n');
  const hits = [];
  for (const w of list) {
    const title = String(w ?? '');
    const lower = title.toLowerCase();
    const site = sites.find((s) => lower.includes(s.replace(/^www\./, '')) || lower.includes(s.split('.')[0]));
    if (site) hits.push({ line: title.trim().slice(0, 90), site });
  }
  return hits;
}

/**
 * One block-tick: close every blocked window. `listWindows()` and
 * `closeWindow(line)` injected (prod: wmctrl -l / wmctrl -c <title>).
 */
export async function blockTick(opts = {}) {
  const { listWindows, closeWindow, sites = DEFAULT_BLOCK } = opts;
  if (typeof listWindows !== 'function' || typeof closeWindow !== 'function') {
    return { closed: 0, message: '🚫 blocker ke runners missing hain.' };
  }
  let windows;
  try {
    windows = await listWindows();
  } catch {
    return { closed: 0, message: '🚫 windows list nahi mili.' };
  }
  const hits = findBlockedWindows(windows, sites);
  let closed = 0;
  for (const h of hits) {
    try {
      await closeWindow(h.line);
      closed++;
    } catch { /* already gone */ }
  }
  return {
    closed,
    hits: hits.map((h) => h.site),
    message: closed
      ? `🚫 *${closed} blocked window(s) band ki* — focus bana raho! (${[...new Set(hits.map((h) => h.site))].join(', ')})`
      : null,
  };
}

export { DEFAULT_BLOCK };
