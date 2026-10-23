// sharedetect.js — 🕶️ Screen-share detector: Zoom/Teams/OBS/Meet share chal
// raha ho to owner ko warn + optional auto-arm shades (auto-OFF KABHI NAHI —
// wo rule locked hai). Detect = injected (tests fake the probe).

const SHARE_PATTERNS = [
  /obs\b/i, /zoom/i, /teams/i, /webex/i, /meet\.google\.com/i,
  /screen.?share/i, /vokoscreen/i, /kazam/i, /simplescreenrecorder/i,
];

/** `probe()` returns a list of running process/command strings. */
export async function detectShare(opts = {}) {
  const { probe } = opts;
  if (typeof probe !== 'function') return { sharing: false, apps: [] };
  try {
    const procs = await probe();
    const list = Array.isArray(procs) ? procs : String(procs ?? '').split('\n');
    const hits = list
      .map((p) => String(p))
      .filter((p) => SHARE_PATTERNS.some((re) => re.test(p)));
    return { sharing: hits.length > 0, apps: [...new Set(hits.map((p) => p.trim().slice(0, 60)))] };
  } catch {
    return { sharing: false, apps: [] };
  }
}

/** Decide the action: warn, or arm shades (never disarm). */
export function sharePolicy(sharing, opts = {}) {
  const { shadesOn = false, autoArm = false } = opts;
  if (!sharing.sharing) return { action: 'none' };
  if (shadesOn) return { action: 'stay', message: '🕶️ Screen share chal raha hai + shades ON hain — safe.' };
  if (autoArm) return { action: 'arm', message: '🕶️ Screen share detect hua — shades auto-ON kar diye (OFF sirf `/shades off` se).' };
  return {
    action: 'warn',
    message: `⚠️ *Screen share chal raha hai* (${sharing.apps[0] ?? 'unknown'})\nKoi screen dekh sakta hai. Shades on karna hai? \`/shades on\``,
  };
}
