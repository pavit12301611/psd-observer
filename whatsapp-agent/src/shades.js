// shades.js — 🕶️ SHADES: physical screen blackout for privacy.
//
// When the owner says /shades the PANEL goes black for anyone physically near
// the screen — but screenshots stay CLEAR, because the bot's capture pipeline
// reads the compositor framebuffer and we never touch that. The darkening is
// applied AFTER the pixels are composed:
//
//   method A  brightnessctl  — hardware backlight level 0 (laptops, Fedora)
//   method B  xrandr         — output gamma ramp 0 (desktop monitors, X11)
//
// Both leave the framebuffer untouched → /screenshot, /look, OCR and the
// vision brain keep seeing the real screen. Only human eyes are locked out.
//
// OWNER RULE (explicit): the screen stays black until the OWNER says
// /shades off — nothing restores it automatically, not even by mistake.
// (SHADES_TIMEOUT_MIN exists as an OPT-IN safety for people who want it;
// its default is 0 = never.) /shades off from WhatsApp works even while the
// panel is black — the phone is the remote. If the state file is ever lost
// while the backlight sits at 0, shadesOff recovers to 50% instead of
// leaving the owner staring at a dead panel.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_STATE_FILE = path.join(ROOT, 'data', 'shades-state.json');
export const DEFAULT_TIMEOUT_MIN = 0; // NEVER auto-restore — only /shades off

// ── tiny injectable shell runner (tests pass a fake) ─────────────────────────
async function defaultRun(bin, args = []) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  return promisify(execFile)(bin, args, { timeout: 8000 }).then((r) => r.stdout ?? '');
}

function stateOpts(opts = {}) {
  return {
    run: opts.run ?? defaultRun,
    stateFile: opts.stateFile ?? DEFAULT_STATE_FILE,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MIN * 60_000,
    now: opts.now ?? Date.now,
    readPct: opts.readPct ?? null, // guard testing hook (sysfs otherwise)
  };
}

// ── state persistence (survives restarts and crashes) ────────────────────────
export function loadShadeState(stateFile = DEFAULT_STATE_FILE) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

function saveShadeState(state, stateFile) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    return true;
  } catch {
    return false;
  }
}

function clearShadeState(stateFile) {
  try { fs.rmSync(stateFile, { force: true }); } catch { /* noop */ }
}

// ── method A: hardware backlight (works on Wayland + X11 laptops) ────────────
async function backlightOn(run) {
  const machine = await run('brightnessctl', ['-m']).catch((err) => {
    if (err?.code === 'ENOENT') return null;
    throw err;
  });
  if (!machine) return null;
  const line = String(machine).trim().split('\n')[0] ?? '';
  const parts = line.split(',');
  const pct = Number.parseInt((parts[3] ?? '').replace('%', ''), 10);
  const raw = parts[2]; // raw device value — restore exactly, percent rounds
  await run('brightnessctl', ['set', '0']);
  return {
    method: 'backlight',
    savedPct: Number.isFinite(pct) ? pct : null,
    savedRaw: raw ?? null,
    device: parts[0] || null, // e.g. intel_backlight — lets the guard read sysfs fork-free
  };
}

async function backlightOff(run, state) {
  const restore = state.savedRaw != null ? String(state.savedRaw) : `${state.savedPct ?? 50}%`;
  await run('brightnessctl', ['set', restore]);
}

// ── method B: gamma ramp via xrandr (desktop monitors, X11) ──────────────────
// xrandr --brightness scales the OUTPUT LUT — the X framebuffer (what
// screenshots read) stays untouched.
async function gammaOn(run) {
  const query = await run('xrandr', ['--query']).catch((err) => {
    if (err?.code === 'ENOENT') return null;
    throw err;
  });
  if (!query) return null;
  const outputs = String(query).split('\n')
    .map((l) => l.match(/^(\S+)\s+connected\b/))
    .filter(Boolean)
    .map((m) => m[1]);
  if (!outputs.length) return null;
  for (const out of outputs) await run('xrandr', ['--output', out, '--brightness', '0']);
  return { method: 'gamma', outputs };
}

async function gammaOff(run, state) {
  for (const out of state.outputs ?? []) {
    await run('xrandr', ['--output', out, '--brightness', '1']).catch(() => {});
  }
}

// ── public API ───────────────────────────────────────────────────────────────

/** Turn the shades ON — panel black, screenshots clear. */
export async function shadesOn(opts = {}) {
  const { run, stateFile, timeoutMs, now } = stateOpts(opts);
  const prev = loadShadeState(stateFile);
  if (prev?.enabled) {
    return '🕶️ *SHADES already ON* — screen is physically black (screenshots still clear).\nScreen wapas chahiye? `/shades off` bolo.';
  }

  let applied = null;
  try {
    applied = await backlightOn(run);
    if (!applied) applied = await gammaOn(run);
  } catch (err) {
    return `🕶️ Shades failed: ${err?.message ?? err}\n_Tip: brightnessctl (sudo dnf install brightnessctl) ya X11 pe xrandr chahiye._`;
  }
  if (!applied) {
    return '🕶️ Shades nahi chale — na `brightnessctl` mila (sudo dnf install brightnessctl) na `xrandr` (X11 session).';
  }

  const state = {
    enabled: true,
    at: now(),
    timeoutMs,
    ...applied,
  };
  saveShadeState(state, stateFile);

  // Opt-in timer (default 0 = never — owner rule).
  if (timeoutMs > 0) {
    const timer = setTimeout(() => {
      shadesOff({ run, stateFile, now }).catch(() => {});
    }, timeoutMs);
    timer.unref?.(); // never keep the process alive just for the failsafe
  }

  // ShadeGuard: brightness keys / power daemons / ANY change gets clamped
  // back to 0 within a moment — the screen cannot be revealed by accident.
  startShadeGuard({ run, stateFile });

  const how = applied.method === 'backlight'
    ? `hardware backlight 0${applied.savedPct != null ? ` (saved: ${applied.savedPct}%)` : ''}`
    : `gamma ramp 0 on ${applied.outputs.join(', ')}`;
  return [
    '🕶️ *SHADES ON* — screen physically *BLACK* for everyone nearby.',
    `✅ Screenshots *clear* — sirf panel dark hai (${how}), framebuffer safe.`,
    '🛡️ *STEALTH MODE* — keyboard/touchpad ki zarurat *nahi*: sab kuch WhatsApp se. Brightness keys ya koi bhi brightness change screen *reveal nahi kar sakta* (ShadeGuard active).',
    timeoutMs > 0
      ? `⏱️ Opt-in auto-restore: ${Math.round(timeoutMs / 60000)} min · turant wapas: \`/shades off\``
      : '🔒 Screen tab tak black rahega jab tak *aap* `/shades off` nahi bhejte — koi auto-restore NAHI.',
  ].join('\n');
}

/** Turn the shades OFF — panel back to the saved brightness. */
export async function shadesOff(opts = {}) {
  const { run, stateFile } = stateOpts(opts);
  const state = loadShadeState(stateFile);
  if (!state?.enabled) {
    // Recovery path: state lost but someone dimmed us to 0 earlier.
    try {
      const machine = await run('brightnessctl', ['-m']).catch(() => null);
      const pct = machine ? Number.parseInt(String(machine).split(',')[3]?.replace('%', ''), 10) : null;
      if (pct === 0) {
        await run('brightnessctl', ['set', '50%']);
        return '🕶️ Shades tha nahi, par backlight *0%* pe thi — *50%* kar di (recovery mode).';
      }
    } catch { /* fall through */ }
    return '🕶️ Shades already *OFF* hai. On karo: `/shades`';
  }

  try {
    if (state.method === 'backlight') await backlightOff(run, state);
    else await gammaOff(run, state);
  } catch (err) {
    return `🕶️ Shades off karte waqt error: ${err?.message ?? err}\nRecovery: \`brightnessctl set 50%\``;
  }
  stopShadeGuard();
  clearShadeState(stateFile);
  const how = state.method === 'backlight'
    ? `backlight → ${state.savedPct ?? 50}%`
    : `gamma → normal on ${state.outputs?.join(', ') ?? 'outputs'}`;
  return `🕶️ *SHADES OFF* — screen normal (${how}). Kisi ne kuch nahi dekha 😎`;
}

/** What's happening right now? */
export async function shadesStatus(opts = {}) {
  const { run, stateFile, now } = stateOpts(opts);
  await maybeAutoRestore({ run, stateFile, now });
  const state = loadShadeState(stateFile);
  if (!state?.enabled) return '🕶️ Shades: *OFF* — screen normal. On: `/shades`';
  const timeout = state.timeoutMs ?? 0;
  if (timeout <= 0) return '🕶️ Shades: *ON* 🔒 — auto-restore *off* (sirf aapka `/shades off` screen wapas laayega)';
  const mins = Math.max(0, Math.round((timeout - (now() - state.at)) / 60000));
  return `🕶️ Shades: *ON* (${state.method}) · opt-in auto-restore in ~${mins} min · off: \`/shades off\``;
}

/**
 * Restore if the auto-restore deadline passed (called on status/commands and
 * at startup). Returns true when it actually restored.
 */
export async function maybeAutoRestore(opts = {}) {
  const { run, stateFile, timeoutMs, now } = stateOpts(opts);
  const state = loadShadeState(stateFile);
  if (!state?.enabled) return false;
  const deadline = state.timeoutMs ?? timeoutMs;
  if (deadline <= 0) return false;
  if (now() - state.at < deadline) return false;
  await shadesOff({ run, stateFile, now });
  return true;
}

/**
 * Startup hook. With the default (no timeout) a crash-restart leaves the
 * shades exactly as the owner left them — black until /shades off — and
 * RE-ARMS the ShadeGuard so brightness keys still cannot reveal the screen
 * after a restart. Only an opted-in elapsed timeout restores anything.
 */
export async function initShades(opts = {}) {
  try {
    const restored = await maybeAutoRestore(opts);
    const state = loadShadeState(stateOpts(opts).stateFile);
    if (state?.enabled) {
      startShadeGuard(opts);
      return restored;
    }
    return restored;
  } catch {
    return false;
  }
}

// ── ShadeGuard: nothing may reveal the panel while shades are ON ────────────
// The bug this fixes: laptop brightness keys (or any power daemon) changed
// the backlight from 0 and instantly revealed the screen. The guard watches
// the backlight (fork-free via sysfs when possible) and clamps every change
// straight back to 0 — keyboard, touchpad, /pc brightness — nothing reveals.
// Full stealth remote: the phone is the only input that matters.

let guardTimer = null;
let guardMeta = null;

export function isGuardActive() {
  return guardTimer != null;
}

export function stopShadeGuard() {
  if (guardTimer) clearInterval(guardTimer);
  guardTimer = null;
  guardMeta = null;
}

/** One protection pass. Returns 'clamped' | 'ok' | 'off'. */
export async function shadeGuardTick(opts = {}) {
  const { run, stateFile, readPct } = stateOpts(opts);
  const state = loadShadeState(stateFile);
  if (!state?.enabled) {
    stopShadeGuard();
    return 'off';
  }
  try {
    if (state.method === 'backlight') {
      let pct = null;
      if (typeof readPct === 'function') {
        pct = await readPct(state.device);
      } else if (state.device) {
        // sysfs read: zero forks on the hot loop — clamp only when needed.
        try {
          const raw = fs.readFileSync(`/sys/class/backlight/${state.device}/brightness`, 'utf8');
          const max = fs.readFileSync(`/sys/class/backlight/${state.device}/max_brightness`, 'utf8');
          pct = Math.round((Number(raw) / Math.max(1, Number(max))) * 100);
        } catch {
          pct = null;
        }
      }
      if (pct == null) {
        const machine = await run('brightnessctl', ['-m']).catch(() => null);
        pct = machine
          ? Number.parseInt(String(machine).trim().split('\n')[0]?.split(',')[3]?.replace('%', ''), 10)
          : null;
      }
      if (Number.isFinite(pct) && pct !== 0) {
        await run('brightnessctl', ['set', '0']).catch(() => {});
        return 'clamped';
      }
      return 'ok';
    }
    // gamma method: brightness keys don't touch gamma, but monitor changes
    // might — cheap re-assert keeps the ramp pinned at 0.
    for (const out of state.outputs ?? []) {
      await run('xrandr', ['--output', out, '--brightness', '0']).catch(() => {});
    }
    return 'ok';
  } catch {
    return 'ok'; // never let the guard itself crash anything
  }
}

/** Arm the guard (idempotent). Interval is small: a keypress lasts < 1s. */
export function startShadeGuard(opts = {}) {
  const { run, stateFile, readPct, now } = stateOpts(opts);
  stopShadeGuard();
  const state = loadShadeState(stateFile);
  if (!state?.enabled) return false;
  guardMeta = { stateFile };
  const tick = () => shadeGuardTick({ run, stateFile, readPct, now }).catch(() => {});
  tick(); // clamp immediately on arming
  guardTimer = setInterval(tick, opts.intervalMs ?? 600);
  guardTimer.unref?.(); // never hold the process open
  return true;
}

/**
 * Stealth-aware brightness for /pc brightness while shades are ON: the panel
 * stays black (the guard enforces it) and the command adjusts only the SAVED
 * level that /shades off will restore. Returns null when shades are off (the
 * caller then runs the normal brightness command).
 */
export async function shadeAwareBrightness(action, value, opts = {}) {
  const { stateFile, now } = stateOpts(opts);
  const state = loadShadeState(stateFile);
  if (!state?.enabled) return null;
  const clamp = (n) => Math.min(100, Math.max(0, Math.round(n)));
  let pct = state.savedPct ?? 50;
  if (action === 'get') {
    return `🕶️ Shades ON — panel *0%* (stealth, guard locked). Saved level: *${pct}%* — yahi \`/shades off\` pe milega.`;
  }
  if (action === 'up') pct = clamp(pct + 5);
  else if (action === 'down') pct = clamp(pct - 5);
  else if (action === 'set') pct = clamp(Number(value) || 0);
  else return `🕶️ Shades ON — stealth mode me brightness sirf up|down|<0-100>|get.`;
  state.savedPct = pct;
  state.savedRaw = null; // restore now percent-based
  saveShadeState(state, stateFile);
  return `🕶️ *Stealth mode* — screen *BLACK* hi rahega 🛡️. Saved brightness → *${pct}%* (ye \`/shades off\` pe apply hoga).`;
}
