// pccontrol.js — direct Fedora/Linux PC control from WhatsApp, no Observer
// app required. Everything runs through execFile with fixed argv (never a
// shell string), so a WhatsApp message cannot smuggle shell syntax into the PC.
//
// Two tiers (enforced in commands.js, not here):
//   tier 1 (always on): screenshot, volume, brightness, media, notify, open
//     (allowlisted apps/URLs), clipboard, lock, find/get files under $HOME.
//   tier 2 (ALLOW_PC_CONTROL=true): keyboard/mouse input and power actions.
//
// Fedora desktop reality: screenshots/input are session-technology dependent.
// Wayland (Fedora default) deliberately restricts them; each function tries the
// right tools for the session and fails with the exact dnf package to install.
// Input on Wayland uses ydotool+ydotoold (uinput); on X11, xdotool.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { imageStats } from './imaging.js';
import { trackScreenshot } from './screenshots.js';

const execFileAsync = promisify(execFile);
const RUN_TIMEOUT = 10_000;

/**
 * Real display sockets on this machine.
 *
 * The agent normally runs as a systemd --user service, which may have been
 * started at boot (linger) *before* the desktop exported WAYLAND_DISPLAY /
 * DISPLAY. Guessing "wayland-0" then either fails outright or — worse — points
 * at the wrong compositor and yields a black screenshot. So we look at the
 * actual sockets under /run/user/<uid> and /tmp/.X11-unix.
 */
let socketCache = { at: 0, value: null };

export function detectSockets({ force = false } = {}) {
  if (!force && socketCache.value && Date.now() - socketCache.at < 5_000) return socketCache.value;
  const uid = typeof os.userInfo().uid === 'number' ? os.userInfo().uid : 1000;
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  let wayland = null;
  try {
    const socks = fs.readdirSync(runtimeDir)
      .filter((name) => /^wayland-\d+$/.test(name))
      .sort();
    wayland = socks.at(-1) ?? null; // a second session usually means wayland-1
  } catch { /* no runtime dir */ }

  let x11 = null;
  try {
    const socks = fs.readdirSync('/tmp/.X11-unix')
      .filter((name) => /^X\d+$/.test(name))
      .map((name) => Number.parseInt(name.slice(1), 10))
      .sort((a, b) => a - b);
    if (socks.length) x11 = `:${socks.at(-1)}`;
  } catch { /* no X */ }

  socketCache = { at: Date.now(), value: { wayland, x11, runtimeDir } };
  return socketCache.value;
}

/** Graphical-session environment, correct even for a boot-time user service. */
export function displayEnv() {
  const env = { ...process.env };
  const sockets = detectSockets();
  env.XDG_RUNTIME_DIR ||= sockets.runtimeDir;
  env.DBUS_SESSION_BUS_ADDRESS ||= `unix:path=${env.XDG_RUNTIME_DIR}/bus`;
  // Point at sockets that actually exist instead of guessing wayland-0/:0.
  if (sockets.wayland) {
    if (!process.env.WAYLAND_DISPLAY) env.WAYLAND_DISPLAY = sockets.wayland;
  } else {
    delete env.WAYLAND_DISPLAY; // X11-only or headless
  }
  if (sockets.x11) {
    if (!process.env.DISPLAY) env.DISPLAY = sockets.x11;
  } else {
    delete env.DISPLAY;
  }
  // Apps launched from a boot-time service otherwise can't tell whether they
  // are on Wayland or X11 and fall back to the wrong toolkit.
  if (!env.XDG_SESSION_TYPE) env.XDG_SESSION_TYPE = sockets.wayland ? 'wayland' : sockets.x11 ? 'x11' : 'tty';
  return env;
}

export function sessionInfo(env = displayEnv()) {
  const waylandSocket = env.WAYLAND_DISPLAY?.startsWith('/')
    ? env.WAYLAND_DISPLAY
    : path.join(env.XDG_RUNTIME_DIR ?? '', env.WAYLAND_DISPLAY ?? '');
  const x11Num = (env.DISPLAY || ':0').replace(/^:/, '').split('.')[0];
  const x11Socket = `/tmp/.X11-unix/X${x11Num}`;
  const wayland = Boolean(env.WAYLAND_DISPLAY) && fs.existsSync(waylandSocket);
  const x11 = fs.existsSync(x11Socket);
  const declared = (process.env.XDG_SESSION_TYPE || '').toLowerCase();
  const type = wayland ? 'wayland' : x11 ? 'x11' : declared || 'headless';
  return {
    type,
    wayland,
    x11,
    graphical: wayland || x11,
    waylandDisplay: wayland ? env.WAYLAND_DISPLAY : null,
    display: x11 ? env.DISPLAY : null,
    runtimeDir: env.XDG_RUNTIME_DIR,
  };
}

function hasGraphicalSession(env = displayEnv()) {
  return sessionInfo(env).graphical;
}

export function findBin(name, env = process.env) {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* next */ }
  }
  return null;
}

const NO_SESSION = 'No graphical session found. Log in to the Fedora desktop on the PC first — if the agent auto-started at boot (linger), restart it after login: systemctl --user restart observer-whatsapp-agent';

async function run(bin, args, opts = {}) {
  // execFile has no `input` option: clipboard writes need a real stdin pipe.
  if (opts.input !== undefined && opts.input !== null) {
    return await new Promise((resolve, reject) => {
      const child = spawn(bin, args, { env: displayEnv() });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* noop */ }
        reject(Object.assign(new Error(`timed out after ${(opts.timeout ?? RUN_TIMEOUT) / 1000}s`), { code: 'ETIMEDOUT' }));
      }, opts.timeout ?? RUN_TIMEOUT);
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve(stdout);
        reject(Object.assign(new Error(stderr.trim() || `${bin} exited with ${code}`), { code, stderr, stdout }));
      });
      if (child.stdin) child.stdin.end(String(opts.input));
    });
  }
  const { stdout } = await execFileAsync(bin, args, {
    timeout: opts.timeout ?? RUN_TIMEOUT,
    env: displayEnv(),
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

/** Try candidates in order. All-missing → `missingMsg`; otherwise last real error. */
async function tryBins(attempts, missingMsg) {
  const failures = [];
  for (const [bin, args, opts] of attempts) {
    try {
      return await run(bin, args, opts);
    } catch (err) {
      failures.push({ bin, err });
    }
  }
  if (failures.every(({ err }) => err.code === 'ENOENT')) throw new Error(missingMsg);
  const real = failures.filter(({ err }) => err.code !== 'ENOENT').at(-1);
  const detail = String(real.err.stderr ?? real.err.message ?? '').trim().split('\n').at(-1)?.slice(0, 220);
  throw new Error(`${real.bin} failed${detail ? `: ${detail}` : ''}`);
}

// ── parsers (exported for tests) ──────────────────────────────────────────────

export function parseWpctlVolume(text) {
  const m = String(text ?? '').match(/Volume:\s*([\d.]+)(\s*\[MUTED\])?/i);
  if (!m) return null;
  return { percent: Math.round(Number(m[1]) * 100), muted: Boolean(m[2]) };
}

export function parsePactlVolume(text) {
  const m = String(text ?? '').match(/(\d+)%/);
  return m ? Number.parseInt(m[1], 10) : null;
}

export function parseBrightnessMachine(text) {
  // brightnessctl -m: 'intel_backlight,backlight,937,47%,2000'
  const pct = String(text ?? '').trim().split('\n')[0]?.split(',')[3]?.replace('%', '');
  const n = Number.parseInt(pct, 10);
  return Number.isFinite(n) ? n : null;
}

const KEYCODES = {
  esc: 1, escape: 1, '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10, '0': 11,
  minus: 12, equal: 13, backspace: 14, tab: 15,
  q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25,
  enter: 28, return: 28, ctrl: 29, control: 29,
  a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38,
  shift: 42, z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50,
  comma: 51, dot: 52, slash: 53, alt: 56, space: 57, capslock: 58,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68, f11: 87, f12: 88,
  home: 102, up: 103, pageup: 104, left: 105, right: 106, end: 107, down: 108, pagedown: 109,
  insert: 110, delete: 111, del: 111, super: 125, win: 125, meta: 125, menu: 139,
};

/** "ctrl+l" -> ydotool key argv ["29:1","38:1","38:0","29:0"] (press in order, release reversed). */
export function ydotoolKeyArgs(combo) {
  const parts = String(combo ?? '').toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error('empty key combo');
  const codes = parts.map((part) => {
    const code = KEYCODES[part];
    if (code == null) throw new Error(`I don't know the key "${part}". Common ones: ctrl, alt, shift, super, a-z, 0-9, enter, esc, tab, space, backspace, delete, home, end, pageup, pagedown, arrows (up/down/left/right), f1-f12.`);
    return code;
  });
  return [...codes.map((c) => `${c}:1`), ...codes.reverse().map((c) => `${c}:0`)];
}

const XDOTOOL_SPECIALS = { enter: 'Return', return: 'Return', esc: 'Escape', escape: 'Escape', backspace: 'BackSpace', pageup: 'Page_Up', pagedown: 'Page_Down', del: 'Delete', delete: 'Delete', super: 'super', win: 'super', space: 'space', tab: 'Tab' };
export function normalizeKeyForXdotool(combo) {
  return String(combo ?? '')
    .split('+')
    .map((part) => XDOTOOL_SPECIALS[part.trim().toLowerCase()] ?? part.trim())
    .join('+');
}

// ── screenshot ────────────────────────────────────────────────────────────────
//
// Why screenshots come out black: on Wayland (Fedora's default) a compositor
// only lets a client capture the screen through xdg-desktop-portal. X11-era
// tools (gnome-screenshot, scrot, maim, ImageMagick's import, GNOME shell's
// Screenshot API) still *run*, but what they hand back is a black frame — the
// classic "it says success and I get a black image". grim works on wlroots
// (Sway/Hyprland), not on GNOME.
//
// So: try the portal first on Wayland, verify every capture is not blank, and
// keep trying until we get real pixels. If nothing produces real pixels, say
// exactly which tool failed and why instead of sending a black rectangle.

const PORTAL_DEST = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
// NOTE: the interface is org.freedesktop.portal.Screenshot — NOT
// org.freedesktop.portal.Desktop.Screenshot. Getting this wrong produces
// "UnknownMethod: No such interface ... on object at path", which looks exactly
// like a broken portal but is just a bad method name.
const PORTAL_SCREENSHOT_IFACE = 'org.freedesktop.portal.Screenshot';

/**
 * Extract the file URI from a portal Response signal.
 *
 * gdbus monitor prints GVariant text, and the exact spelling varies between
 * glib versions:
 *   ... Request.Response (uint32 0, {'uri': <'file:///home/u/Pictures/x.png'>})
 *   ... Request.Response (uint32 0, @a{sv} {'uri': <'file:///…'>})
 *   ... Request.Response (uint32 2, {})
 * So: parse the code loosely, then take any file:// URI in the payload.
 */
export function parsePortalScreenshotResponse(text) {
  const body = String(text ?? '');
  // Signals carry the interface name (org.freedesktop.portal.Request.Response);
  // accept a bare "Response (uint32 …" too so older/newer spellings both work.
  const responseMatch = body.match(/(?:[\w.]+\.)?Response\s*\(\s*uint32\s+(\d+)/);
  if (!responseMatch) return null;
  const code = Number.parseInt(responseMatch[1], 10);
  const uriMatch = body.match(/['"]uri['"]\s*:\s*<*\s*['"]([^'">]+)['"]/)
    ?? body.match(/file:\/\/[^'"<>\s]+/);
  let uri = uriMatch ? (uriMatch[1] ?? uriMatch[0]) : null;
  if (uri && !uri.startsWith('file://')) uri = null;
  return {
    code,
    ok: code === 0 && Boolean(uri),
    cancelled: code === 1,
    denied: code === 2,
    uri,
    path: uri ? decodeURIComponent(uri.replace(/^file:\/\//, '')) : null,
  };
}

/** Where GNOME/KDE put screenshots: the XDG pictures dir (+ common variants). */
export function picturesDirs(env = process.env) {
  const home = os.homedir();
  const dirs = [];
  // ~/.config/user-dirs.dirs has the real localized path (e.g. ~/Pictures).
  try {
    const text = fs.readFileSync(path.join(home, '.config', 'user-dirs.dirs'), 'utf8');
    const match = text.match(/^XDG_PICTURES_DIR="?([^"\n]+)"?/m);
    if (match) dirs.push(match[1].replace(/^\$HOME/, home));
  } catch { /* no user-dirs */ }
  if (env.XDG_PICTURES_DIR) dirs.push(env.XDG_PICTURES_DIR);
  dirs.push(path.join(home, 'Pictures'), path.join(home, 'Pictures', 'Screenshots'), path.join(home, 'Desktop'));
  return [...new Set(dirs)].filter((dir) => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } });
}

const SCREENSHOT_NAME = /^(Screenshot|Screenshot from|Screenshot_|Screen ?shot|Bildschirmfoto|Ekran)/i;

/** Any screenshot-looking file created after `sinceMs` (newest first). */
export function findNewScreenshot(sinceMs, dirs = picturesDirs()) {
  const found = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/\.(png|jpg|jpeg)$/i.test(name)) continue;
      if (!SCREENSHOT_NAME.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        // 250ms slack for coarse filesystem timestamps, not enough to pick up
        // an older screenshot from a previous request.
        if (stat.isFile() && stat.size > 0 && stat.mtimeMs >= sinceMs - 250) found.push({ path: full, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch { /* raced with deletion */ }
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found[0] ?? null;
}

/** Wait until a file exists, is non-empty and its size stopped changing. */
export async function waitForCompleteFile(file, { timeoutMs = 5_000, stepMs = 150 } = {}) {
  const started = Date.now();
  let lastSize = -1;
  while (Date.now() - started < timeoutMs) {
    try {
      const stat = fs.statSync(file);
      if (stat.size > 0 && stat.size === lastSize) return true;
      lastSize = stat.size;
    } catch { /* not there yet */ }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  try { return fs.statSync(file).size > 0; } catch { return false; }
}

/**
 * Is the Screenshot interface actually exported right now?
 * "No such interface" means the portal is running without a desktop backend
 * (usually: xdg-desktop-portal-gnome not installed, or the backend died).
 */
export async function portalScreenshotAvailable(env = displayEnv()) {
  if (!findBin('gdbus', env)) return { available: false, reason: 'gdbus is not installed (sudo dnf install glib2)' };
  try {
    const out = await run('gdbus', [
      'introspect', '--session', '--dest', PORTAL_DEST, '--object-path', PORTAL_PATH,
    ], { timeout: 6_000 });
    const hasScreenshot = new RegExp(`interface\\s+${PORTAL_SCREENSHOT_IFACE.replace(/\./g, '\\.')}\\b`).test(out);
    const interfaces = [...out.matchAll(/interface\s+([\w.]+)/g)].map((m) => m[1]);
    return {
      available: hasScreenshot,
      interfaces,
      reason: hasScreenshot
        ? 'Screenshot interface present'
        : 'The portal is running but has no Screenshot interface — its GNOME backend (xdg-desktop-portal-gnome) is missing or not running.',
    };
  } catch (err) {
    const detail = String(err.stderr || err.message || '').trim().split('\n').at(-1)?.slice(0, 160);
    return {
      available: false,
      reason: `Could not reach xdg-desktop-portal (${detail || 'no answer'}) — is xdg-desktop-portal installed and running?`,
    };
  }
}

/**
 * Screenshot through xdg-desktop-portal (the only supported path on GNOME
 * Wayland; also works on KDE and X11).
 *
 * Two independent ways of learning the result, because each one alone is
 * fragile in practice:
 *   1. the async Response signal on the request handle, and
 *   2. the file the portal writes into the Pictures folder.
 * (2) also covers the case where the owner takes longer than the timeout to
 * click "Allow" — we still pick the screenshot up once it appears.
 *
 * The monitor deliberately watches the WHOLE session bus instead of
 * `--dest org.freedesktop.portal.Desktop`: the portal is D-Bus activated, so
 * filtering by destination silently misses signals when the service starts up
 * as part of our own call.
 */
async function portalScreenshot(env, { timeoutMs = 60_000 } = {}) {
  if (!findBin('gdbus', env)) throw Object.assign(new Error('gdbus is not installed (sudo dnf install glib2)'), { code: 'ENOENT' });
  const token = `obs${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const startedAt = Date.now();
  const dirs = picturesDirs(env);

  const child = spawn('gdbus', ['monitor', '--session'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '';
  let settled = false;
  let watcher = null;

  const result = new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (watcher) clearInterval(watcher);
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      fn(value);
    };
    const timer = setTimeout(async () => {
      // Last chance: the dialog may have been approved right at the deadline.
      const late = findNewScreenshot(startedAt, dirs);
      if (late) return finish(resolve, late.path);
      finish(reject, Object.assign(
        new Error(`the portal did not answer in ${Math.round(timeoutMs / 1000)}s. If a "Allow screenshot?" dialog is (or was) open on the PC, approve it and tick "Always allow", then retry — or raise PORTAL_TIMEOUT_MS in .env. Check: systemctl --user status xdg-desktop-portal-gnome`),
        { code: 'ETIMEDOUT' },
      ));
    }, timeoutMs);

    // Path 2: the portal saves the screenshot to ~/Pictures (or XDG_PICTURES_DIR).
    watcher = setInterval(() => {
      const hit = findNewScreenshot(startedAt, dirs);
      if (hit) finish(resolve, hit.path);
    }, 400);
    watcher.unref?.();

    const onData = (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes('Request.Response')) return;
      const parsed = parsePortalScreenshotResponse(buffer);
      if (!parsed) return;
      if (parsed.ok && parsed.path) return finish(resolve, parsed.path);
      if (parsed.cancelled) return finish(reject, new Error('you cancelled the screenshot dialog on the PC'));
      if (parsed.denied) return finish(reject, new Error('the portal denied the screenshot (dialog dismissed)'));
      return finish(reject, new Error(`portal refused the screenshot (response code ${parsed.code})`));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => finish(reject, Object.assign(err, { code: err.code ?? 'EPORTAL' })));
  });
  result.catch(() => {});

  await new Promise((resolve) => setTimeout(resolve, 350));
  try {
    await run('gdbus', [
      'call', '--session', '--dest', PORTAL_DEST, '--object-path', PORTAL_PATH,
      '--method', `${PORTAL_SCREENSHOT_IFACE}.Screenshot`,
      '', `{'handle_token': <'${token}'>, 'interactive': <false>, 'modal': <false>}`,
    ], { timeout: 20_000 });
  } catch (err) {
    if (watcher) clearInterval(watcher);
    settled = true;
    try { child.kill('SIGKILL'); } catch { /* noop */ }
    const detail = String(err.stderr || err.message || '');
    if (/UnknownMethod|No such interface/i.test(detail) && /Screenshot/i.test(detail)) {
      err.message = 'the portal is running but its Screenshot interface is missing — install the GNOME backend: sudo dnf install xdg-desktop-portal xdg-desktop-portal-gnome && systemctl --user restart xdg-desktop-portal-gnome xdg-desktop-portal';
    }
    throw err;
  }
  return result;
}

/**
 * Every capture path we know, best-first for the current session.
 *
 * On Wayland we only use paths that can actually work: the portal, grim
 * (wlroots), spectacle (KDE). The X11 tools (scrot/maim/import/gnome-screenshot)
 * exit 0 with a black frame there, so trying them only adds delay and confusing
 * error text.
 */
function screenshotAttempts(file, env, portalMs = 60_000) {
  const session = sessionInfo(env);
  const attempts = [];
  if (session.wayland) {
    attempts.push({
      label: 'xdg-desktop-portal',
      fn: async () => {
        const avail = await portalScreenshotAvailable(env);
        if (!avail.available) throw new Error(avail.reason);
        return portalScreenshot(env, { timeoutMs: portalMs });
      },
    });
    attempts.push({ label: 'grim', fn: async () => { await run('grim', [file], { timeout: 12_000 }); return file; } });
    attempts.push({ label: 'spectacle', fn: async () => { await run('spectacle', ['-b', '-n', '-o', file], { timeout: 15_000 }); return file; } });
    return attempts;
  }
  // X11 (or XWayland): the classic tools, GNOME shell API first.
  attempts.push({ label: 'gnome-shell', fn: async () => {
    await run('gdbus', ['call', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/org/gnome/Shell', '--method', 'org.gnome.Shell.Screenshot.Screenshot', 'false', 'false', file], { timeout: 12_000 });
    return file;
  } });
  attempts.push({ label: 'gnome-screenshot', fn: async () => { await run('gnome-screenshot', ['-f', file], { timeout: 12_000 }); return file; } });
  attempts.push({ label: 'spectacle', fn: async () => { await run('spectacle', ['-b', '-n', '-o', file], { timeout: 15_000 }); return file; } });
  attempts.push({ label: 'scrot', fn: async () => { await run('scrot', ['--silent', file], { timeout: 12_000 }); return file; } });
  attempts.push({ label: 'maim', fn: async () => { await run('maim', [file], { timeout: 12_000 }); return file; } });
  attempts.push({ label: 'import', fn: async () => { await run('import', ['-window', 'root', file], { timeout: 12_000 }); return file; } });
  return attempts;
}

/** Actionable text for a Wayland failure, based on what the portal said. */
async function waylandHint(env, tried) {
  const portal = await portalScreenshotAvailable(env);
  const lines = [`Screen capture is being blocked by Wayland (this is a ${process.env.XDG_CURRENT_DESKTOP || 'Wayland'} session).`];
  if (!portal.available) {
    lines.push(`Portal: ${portal.reason}`);
    lines.push('Fix (copy-paste on the PC):');
    if (/gdbus/i.test(portal.reason)) lines.push('  sudo dnf install glib2');
    lines.push('  sudo dnf install xdg-desktop-portal xdg-desktop-portal-gnome');
    lines.push('  systemctl --user restart xdg-desktop-portal-gnome xdg-desktop-portal');
    lines.push('  gdbus introspect --session --dest org.freedesktop.portal.Desktop --object-path /org/freedesktop/portal/desktop | grep -i screenshot');
    lines.push('The last command must list org.freedesktop.portal.Screenshot.');
  } else {
    lines.push('The portal has its Screenshot interface, so it is a permission/timeout problem: approve the "Allow screenshot?" dialog on the PC screen (GNOME asks once — tick "Always allow"), then retry.');
  }
  lines.push(`Tried: ${tried}`);
  return lines.join('\n');
}

export async function captureScreenshot({ portalTimeoutMs } = {}) {
  const env = displayEnv();
  const session = sessionInfo(env);
  if (!session.graphical) throw new Error(NO_SESSION);
  const portalMs = Number(portalTimeoutMs ?? process.env.PORTAL_TIMEOUT_MS ?? 60_000) || 60_000;

  const failures = [];
  const file = path.join(os.tmpdir(), `observer-shot-${Date.now()}.png`);
  const attempts = screenshotAttempts(file, env, portalMs);
  for (const attempt of attempts) {
    let produced = null;
    try {
      produced = await attempt.fn();
      if (produced) await waitForCompleteFile(produced, { timeoutMs: 4_000 });
      const data = fs.existsSync(produced) ? fs.readFileSync(produced) : null;
      if (!data || !data.length) {
        failures.push({ label: attempt.label, reason: 'produced no file' });
        continue;
      }
      const stats = imageStats(data);
      if (stats.blank) {
        // The classic Wayland failure: exit code 0, black rectangle.
        failures.push({ label: attempt.label, reason: `returned a black image (${stats.width}×${stats.height})` });
        try { fs.unlinkSync(produced); } catch { /* noop */ }
        continue;
      }
      if (produced === file) {
        // Our own temp copy: the caller only needs the Buffer, so the file is
        // dead the moment it is read. No reason to wait for the janitor.
        try { fs.unlinkSync(file); } catch { /* noop */ }
      } else if (produced) {
        // The portal wrote a real file into ~/Pictures. Track it so the
        // janitor deletes it a few minutes later (never the owner's files).
        trackScreenshot(produced, { kind: 'pictures' });
      }
      return data;
    } catch (err) {
      failures.push({
        label: attempt.label,
        missing: err.code === 'ENOENT',
        reason: String(err.stderr || err.message || '').trim().split('\n').at(-1)?.slice(0, 140) ?? 'failed',
      });
    }
  }
  try { fs.unlinkSync(file); } catch { /* never created */ }
  const tried = failures.map((f) => (f.missing ? `${f.label}: not installed` : `${f.label}: ${f.reason}`)).join(' · ');
  if (session.type === 'wayland') throw new Error(await waylandHint(env, tried));
  throw new Error([
    'No screenshot tool produced a usable image.',
    `Tried: ${tried}.`,
    'Fix: sudo dnf install gnome-screenshot scrot maim   (or kde-spectacle on KDE).',
  ].join('\n'));
}

// ── sound / brightness / media ───────────────────────────────────────────────

export async function volume(action, value) {
  const missing = 'No wpctl/pactl found. Fedora Workstation (PipeWire+WirePlumber) ships wpctl by default; otherwise: sudo dnf install wireplumber pipewire-pulseaudio';
  if (action === 'get') {
    try {
      const v = parseWpctlVolume(await run('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@']));
      if (v) return `🔊 Volume: *${v.percent}%*${v.muted ? ' (muted)' : ''}`;
      throw Object.assign(new Error('unparsable'), { code: 'ENOENT' });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const pct = parsePactlVolume(await tryBins([['pactl', ['get-sink-volume', '@DEFAULT_SINK@']]], missing));
      return `🔊 Volume: *${pct ?? '?'}%*`;
    }
  }
  const wpctlArgs = {
    up: ['set-volume', '@DEFAULT_AUDIO_SINK@', '5%+'],
    down: ['set-volume', '@DEFAULT_AUDIO_SINK@', '5%-'],
    mute: ['set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle'],
    set: ['set-volume', '@DEFAULT_AUDIO_SINK@', `${Math.min(Math.max(Number(value) || 0, 0), 100)}%`],
  }[action];
  const pactlArgs = {
    up: ['set-sink-volume', '@DEFAULT_SINK@', '+5%'],
    down: ['set-sink-volume', '@DEFAULT_SINK@', '-5%'],
    mute: ['set-sink-mute', '@DEFAULT_SINK@', 'toggle'],
    set: ['set-sink-volume', '@DEFAULT_SINK@', `${Math.min(Math.max(Number(value) || 0, 0), 100)}%`],
  }[action];
  await tryBins([['wpctl', wpctlArgs], ['pactl', pactlArgs]], missing);
  return `${action === 'mute' ? '🔇 Mute toggled.' : await volume('get')}`;
}

export async function brightness(action, value) {
  const missing = 'brightnessctl not found: sudo dnf install brightnessctl (if it then says permission denied: sudo usermod -aG video $USER, log out and back in)';
  if (action === 'get') {
    const pct = parseBrightnessMachine(await tryBins([['brightnessctl', ['-m']]], missing));
    return `☀️ Brightness: *${pct ?? '?'}%*`;
  }
  const arg = { up: '5%+', down: '5%-', set: `${Math.min(Math.max(Number(value) || 0, 1), 100)}%` }[action];
  try {
    await run('brightnessctl', ['set', arg]);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(missing);
    if (/permission|not permitted/i.test(`${err.stderr ?? ''} ${err.message}`)) {
      throw new Error('Permission denied writing brightness. Usual Fedora fix: sudo usermod -aG video $USER, then log out and back in (or reboot).');
    }
    throw err;
  }
  return brightness('get');
}

export async function media(action) {
  const missing = 'playerctl not found: sudo dnf install playerctl';
  const map = { play: 'play', pause: 'pause', toggle: 'play-pause', next: 'next', prev: 'previous', previous: 'previous', stop: 'stop' };
  if (action === 'status') {
    const out = (await tryBins([['playerctl', ['metadata', '--format', '{{playerName}}: {{artist}} — {{title}} ({{status}})']]], missing)).trim();
    return `🎵 ${out || 'Nothing is playing (or no MPRIS player is running).'}`;
  }
  await tryBins([['playerctl', [map[action] ?? 'play-pause']]], missing);
  return { play: '▶️ Playing', pause: '⏸️ Paused', toggle: '⏯️ Toggled play/pause', next: '⏭️ Next track', prev: '⏮️ Previous track', stop: '⏹️ Stopped' }[action] ?? '🎵 Done';
}

// ── desktop actions ───────────────────────────────────────────────────────────

export async function lockSession() {
  await tryBins(
    [['loginctl', ['lock-session']], ['xdg-screensaver', ['lock']], ['gnome-screensaver-command', ['-l']]],
    'No lock tool found (loginctl should exist on Fedora — is a graphical session running?).',
  );
  return '🔒 Screen locked.';
}

export async function desktopNotify(text) {
  await tryBins(
    [['notify-send', ['PSD_Ai (Observer Agent)', String(text).slice(0, 256)]]],
    'notify-send not found: sudo dnf install libnotify',
  );
  return '🔔 Notification shown on the PC.';
}

function launchDetached(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { detached: true, stdio: 'ignore', env: displayEnv() });
    let settled = false;
    child.once('error', (err) => { if (!settled) { settled = true; reject(err); } });
    setTimeout(() => { if (!settled) { settled = true; child.unref(); resolve(); } }, 350);
  });
}

const APP_ALIASES = {
  firefox: ['firefox', 'org.mozilla.firefox'],
  browser: ['firefox', 'org.mozilla.firefox'],
  chrome: ['google-chrome', 'google-chrome'],
  chromium: ['chromium', 'org.chromium.Chromium'],
  files: ['nautilus', 'org.gnome.Nautilus'],
  terminal: ['ptyxis', 'org.gnome.Ptyxis', 'kgx', 'org.gnome.Console', 'gnome-terminal', 'org.gnome.Terminal', 'konsole', 'org.kde.konsole'],
  settings: ['gnome-control-center', 'org.gnome.Settings', 'systemsettings', 'org.kde.systemsettings'],
  calculator: ['gnome-calculator', 'org.gnome.Calculator', 'kcalc', 'org.kde.kcalc'],
  calc: ['gnome-calculator', 'org.gnome.Calculator'],
  editor: ['gnome-text-editor', 'org.gnome.TextEditor', 'gedit', 'org.gnome.gedit', 'kwrite', 'org.kde.kwrite'],
  code: ['code', 'com.visualstudio.code', 'codium', 'com.vscodium.codium'],
  software: ['gnome-software', 'org.gnome.Software'],
  'software center': ['gnome-software', 'org.gnome.Software'],
};

export async function openTarget(target) {
  const trimmed = String(target ?? '').trim();
  if (!trimmed) throw new Error('usage: /pc open <app or https://link> — apps: ' + Object.keys(APP_ALIASES).join(', '));
  if (!hasGraphicalSession()) throw new Error(NO_SESSION);
  if (/^https?:\/\//i.test(trimmed)) {
    // Order matters: xdg-open is the polite way, but it is missing on minimal
    // installs, and some desktops return 0 without actually opening anything.
    const openers = [];
    const xdg = findBin('xdg-open');
    if (xdg) openers.push([xdg, [trimmed], 'xdg-open']);
    const gio = findBin('gio');
    if (gio) openers.push([gio, ['open', trimmed], 'gio open']);
    for (const browser of ['firefox', 'chromium', 'chromium-browser', 'google-chrome', 'brave-browser']) {
      const bin = findBin(browser);
      if (bin) openers.push([bin, [trimmed], browser]);
    }
    if (!openers.length) {
      throw new Error('No browser opener found. Install one: sudo dnf install firefox xdg-utils  (then check: xdg-open https://example.com)');
    }
    const errors = [];
    for (const [bin, args, label] of openers) {
      try {
        await launchDetached(bin, args);
        return `🌐 Opened ${trimmed} in the PC's browser (${label}).`;
      } catch (err) {
        errors.push(`${label}: ${err.code === 'ENOENT' ? 'not installed' : err.message}`);
      }
    }
    throw new Error(`Could not open a browser for ${trimmed}.\n${errors.join('\n')}\nFix: sudo dnf install firefox xdg-utils`);
  }
  const candidates = APP_ALIASES[trimmed.toLowerCase()];
  if (!candidates) throw new Error(`I only open allowlisted apps (or http links): ${Object.keys(APP_ALIASES).join(', ')}. For anything else use /observer or the gated /run.`);
  for (let i = 0; i < candidates.length; i += 2) {
    const bin = findBin(candidates[i]);
    const desktopId = candidates[i + 1];
    if (desktopId && findBin('gtk-launch')) {
      try { await launchDetached('gtk-launch', [desktopId]); return `✅ Opened ${trimmed} on the PC.`; } catch { /* try binary */ }
    }
    if (bin) { await launchDetached(bin, []); return `✅ Opened ${trimmed} on the PC.`; }
  }
  throw new Error(`${trimmed} isn't installed/found on this PC (looked for: ${candidates.filter((_, i) => i % 2 === 0).join(', ')}).`);
}

// ── keyboard / mouse (tier 2) ────────────────────────────────────────────────

const INPUT_MISSING = 'No keyboard/mouse tool found. Wayland (GNOME/KDE): sudo dnf install ydotool && sudo systemctl enable --now ydotool — the daemon (ydotoold) is what actually presses keys. X11: sudo dnf install xdotool';

/** Where ydotool's daemon listens (distro/package dependent). */
export function ydotoolSocket() {
  const explicit = process.env.YDOTOOL_SOCKET;
  if (explicit) return explicit;
  const candidates = ['/tmp/.ydotool_socket', '/run/ydotoold/socket', '/var/run/.ydotool_socket'];
  const hit = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  return hit ?? null;
}

/** Facts for /doctor: which input path would actually work right now. */
export function inputDiagnostics() {
  const socket = ydotoolSocket();
  let uinput = false;
  try { uinput = fs.existsSync('/dev/uinput'); } catch { /* noop */ }
  const session = sessionInfo();
  return {
    session: session.type,
    ydotool: Boolean(findBin('ydotool')),
    ydotoolDaemon: Boolean(socket),
    ydotoolSocket: socket,
    wtype: Boolean(findBin('wtype')),
    xdotool: Boolean(findBin('xdotool')),
    uinput,
  };
}

function inputToolOrder() {
  const session = sessionInfo().type;
  if (session === 'x11') return ['xdotool', 'ydotool', 'wtype'];
  // Wayland: ydotool (uinput, works on GNOME/KDE/wlroots) → wtype (wlroots only)
  // → xdotool (XWayland apps only).
  return ['ydotool', 'wtype', 'xdotool'];
}

async function runInput(builders) {
  const failures = [];
  for (const tool of inputToolOrder()) {
    const build = builders[tool];
    if (!build) continue;
    try {
      const spec = typeof build === 'function' ? build() : build;
      const args = Array.isArray(spec) ? spec : spec.args;
      const input = Array.isArray(spec) ? undefined : spec.input;
      await run(tool, args, input === undefined ? {} : { input, timeout: 30_000 });
      return tool;
    } catch (err) {
      failures.push({ tool, err });
    }
  }
  if (failures.every(({ err }) => err.code === 'ENOENT')) throw new Error(INPUT_MISSING);
  const real = failures.filter(({ err }) => err.code !== 'ENOENT').at(-1);
  const raw = (real.err.stderr || real.err.message || '').toString().trim().split('\n').at(-1)?.slice(0, 160) ?? '';
  let hint = '';
  if (real.tool === 'ydotool') {
    const diag = inputDiagnostics();
    hint = diag.ydotoolDaemon
      ? ' ydotool is installed and its daemon is running, so this is a one-off failure — try again.'
      : ' ydotool needs its daemon: sudo systemctl enable --now ydotool (unit is sometimes named ydotoold). Check with: systemctl status ydotool.';
  } else if (real.tool === 'xdotool') {
    hint = ' On Wayland xdotool can only type into XWayland apps — install ydotool for everything else.';
  } else if (real.tool === 'wtype') {
    hint = ' wtype only works on wlroots compositors (Sway/Hyprland), not GNOME/KDE.';
  }
  throw new Error(`${real.tool} failed${raw ? `: ${raw}` : ''}.${hint}`);
}

/**
 * Split text for typing. No more arbitrary 500-character ceiling: ydotool gets
 * the text in argv chunks (long single arguments are slow and, on some builds,
 * silently truncated), preferring word boundaries so a word isn't cut in two.
 * Exported so the chunking itself is unit-tested without a desktop.
 */
export function splitForTyping(text, size = 180) {
  const limit = Math.max(20, Math.min(Number(size) || 180, 1_000));
  const source = String(text ?? '');
  const chunks = [];
  let rest = source;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(' ', limit);
    // Break *after* the space (keep it) so no character is ever dropped.
    if (cut >= Math.floor(limit * 0.6)) cut += 1;
    else cut = limit; // no usable space nearby: hard cut
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

const MAX_TYPE_CHARS = 40_000;

export async function typeText(text) {
  const payload = String(text ?? '').slice(0, MAX_TYPE_CHARS);
  if (!payload) throw new Error('usage: /pc type <text>');
  if (!hasGraphicalSession()) throw new Error(NO_SESSION);

  const chunks = splitForTyping(payload, process.env.TYPE_CHUNK_CHARS ?? 180);
  let used = null;
  for (const [index, chunk] of chunks.entries()) {
    used = await runInput({
      ydotool: ['type', chunk],
      wtype: ['--', chunk],
      // xdotool reads stdin with --file -, so no argv limits at all.
      xdotool: () => ({ args: ['type', '--clearmodifiers', '--file', '-'], input: chunk }),
    });
    // Give the target app a moment between chunks (large pastes in browsers,
    // editors and Electron apps otherwise drop characters).
    if (index < chunks.length - 1) await new Promise((r) => setTimeout(r, Number(process.env.TYPE_CHUNK_DELAY_MS ?? 60)));
  }
  const via = chunks.length > 1 ? `${chunks.length} chunks via ${used}` : `via ${used}`;
  return `⌨️ Typed ${payload.length} characters ${via}.`;
}

/**
 * Long text, instantly: put it on the clipboard and press Ctrl+V.
 * Much faster and more reliable than typing thousands of key events, and it
 * keeps newlines/Unicode intact.
 */
export async function pasteText(text) {
  const payload = String(text ?? '');
  if (!payload) throw new Error('usage: /pc paste <text>');
  if (!hasGraphicalSession()) throw new Error(NO_SESSION);
  await clipboardSet(payload);
  // Small delay so the clipboard owner is ready before the paste keystroke.
  await new Promise((r) => setTimeout(r, 120));
  const used = await runInput({
    ydotool: ['key', ...ydotoolKeyArgs('ctrl+v')],
    wtype: ['-k', 'ctrl+v'],
    xdotool: ['key', '--clearmodifiers', 'ctrl+v'],
  });
  return `📋 Pasted ${payload.length} characters (clipboard + Ctrl+V via ${used}).`;
}

export async function keyCombo(combo) {
  if (!combo) throw new Error('usage: /pc key ctrl+l · alt+tab · super · enter');
  if (!hasGraphicalSession()) throw new Error(NO_SESSION);
  const used = await runInput({
    ydotool: ['key', ...ydotoolKeyArgs(combo)],
    wtype: ['-k', String(combo).toLowerCase().replace(/\s+/g, '')],
    xdotool: ['key', '--clearmodifiers', normalizeKeyForXdotool(combo)],
  });
  return `⌨️ Sent key "${combo}" via ${used}.`;
}

export async function click(x, y, button = 'left', repeat = 1) {
  if (!hasGraphicalSession()) throw new Error(NO_SESSION);
  const times = Math.min(Math.max(Number.parseInt(repeat, 10) || 1, 1), 3);
  const hasCoords = Number.isFinite(x) && Number.isFinite(y);
  const failures = [];
  for (const tool of inputToolOrder()) {
    try {
      if (tool === 'ydotool') {
        if (hasCoords) await run('ydotool', ['mousemove', '--absolute', '-x', String(x), '-y', String(y)]);
        await run('ydotool', ['click', button === 'right' ? '0xC1' : button === 'middle' ? '0xC2' : '0xC0']);
        for (let i = 1; i < times; i++) await run('ydotool', ['click', button === 'right' ? '0xC1' : button === 'middle' ? '0xC2' : '0xC0']);
      } else {
        if (hasCoords) await run('xdotool', ['mousemove', String(x), String(y)]);
        await run('xdotool', ['click', '--repeat', String(times), '--delay', '80', button === 'right' ? '3' : button === 'middle' ? '2' : '1']);
      }
      return `🖱️ ${times > 1 ? `${times}× ` : ''}${button} click${hasCoords ? ` at ${x},${y}` : ' at the cursor'} via ${tool}.`;
    } catch (err) { failures.push({ tool, err }); }
  }
  if (failures.every(({ err }) => err.code === 'ENOENT')) throw new Error(INPUT_MISSING);
  const real = failures.filter(({ err }) => err.code !== 'ENOENT').at(-1);
  throw new Error(`${real.tool} click failed: ${(real.err.stderr || real.err.message || '').toString().trim().split('\n').at(-1)?.slice(0, 160)}`);
}

/** Move the pointer (absolute coordinates). */
export async function moveMouse(x, y) {
  if (!hasGraphicalSession()) throw new Error(NO_SESSION);
  const hasCoords = Number.isFinite(x) && Number.isFinite(y);
  if (!hasCoords) throw new Error('usage: /pc mousemove 640 400  (screen pixels)');
  const failures = [];
  for (const tool of inputToolOrder()) {
    try {
      if (tool === 'ydotool') await run('ydotool', ['mousemove', '--absolute', '-x', String(x), '-y', String(y)]);
      else if (tool === 'xdotool') await run('xdotool', ['mousemove', String(x), String(y)]);
      else continue; // wtype has no pointer support
      return `🖱️ Moved the pointer to ${x},${y} via ${tool}.`;
    } catch (err) { failures.push({ tool, err }); }
  }
  if (failures.every(({ err }) => err.code === 'ENOENT')) throw new Error(INPUT_MISSING);
  const real = failures.filter(({ err }) => err.code !== 'ENOENT').at(-1);
  throw new Error(`${real.tool} mousemove failed: ${(real.err.stderr || real.err.message || '').toString().trim().split('\n').at(-1)?.slice(0, 160)}`);
}

/**
 * Press, move, release — a real drag (sliders, selecting text, moving windows).
 * xdotool is the only input tool with separate button-down/up, so on a pure
 * ydotool/wtype setup this reports exactly that instead of faking a click.
 */
export async function dragMouse(x1, y1, x2, y2) {
  if (!hasGraphicalSession()) throw new Error(NO_SESSION);
  const coords = [x1, y1, x2, y2].map(Number);
  if (!coords.every(Number.isFinite)) throw new Error('usage: /pc drag <x1> <y1> <x2> <y2>');
  const [left, top, right, bottom] = coords;
  if (!findBin('xdotool')) {
    throw new Error('drag ke liye xdotool chahiye (ydotool me button hold nahi hota): sudo dnf install xdotool');
  }
  const xd = findBin('xdotool');
  await run(xd, ['mousemove', String(left), String(top)]);
  await run(xd, ['mousedown', '1']);
  try {
    // Several small steps so apps see a real drag, not a teleport.
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const x = Math.round(left + ((right - left) * i) / steps);
      const y = Math.round(top + ((bottom - top) * i) / steps);
      await run(xd, ['mousemove', String(x), String(y)]);
      await new Promise((r) => setTimeout(r, 25));
    }
  } finally {
    await run(xd, ['mouseup', '1']);
  }
  return `🖱️ Dragged ${left},${top} → ${right},${bottom} via xdotool.`;
}

/** Scroll the wheel: positive = down. */
export async function scrollMouse(direction = 'down', amount = 3) {
  if (!hasGraphicalSession()) throw new Error(NO_SESSION);
  const dir = String(direction ?? 'down').toLowerCase();
  const clicks = Math.min(Math.max(Number.parseInt(amount, 10) || 3, 1), 25);
  const isUp = ['up', 'upar', 'oopar'].includes(dir);
  const failures = [];
  for (const tool of inputToolOrder()) {
    try {
      if (tool === 'ydotool') {
        // ydotool click codes: 0x40 = wheel up, 0x41 = wheel down.
        for (let i = 0; i < clicks; i++) await run('ydotool', ['click', isUp ? '0x40' : '0x41']);
      } else if (tool === 'xdotool') {
        for (let i = 0; i < clicks; i++) await run('xdotool', ['click', isUp ? '4' : '5']);
      } else {
        continue;
      }
      return `🖱️ Scrolled ${isUp ? 'up' : 'down'} ${clicks} step(s) via ${tool}.`;
    } catch (err) { failures.push({ tool, err }); }
  }
  if (failures.every(({ err }) => err.code === 'ENOENT')) throw new Error(INPUT_MISSING);
  const real = failures.filter(({ err }) => err.code !== 'ENOENT').at(-1);
  throw new Error(`${real.tool} scroll failed: ${(real.err.stderr || real.err.message || '').toString().trim().split('\n').at(-1)?.slice(0, 160)}`);
}

// ── clipboard ─────────────────────────────────────────────────────────────────

export async function clipboardGet() {
  const out = await tryBins(
    [['wl-paste', ['--no-newline']], ['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['--clipboard', '--output']]],
    'No clipboard tool found. Wayland: sudo dnf install wl-clipboard · X11: sudo dnf install xclip',
  );
  const text = String(out).slice(0, 2000);
  return text ? `📋 PC clipboard:\n\n${text}` : '📋 PC clipboard is empty (or holds non-text).';
}

export async function clipboardSet(text) {
  const payload = String(text ?? '');
  if (!payload) throw new Error('usage: /pc clipset <text>');
  await tryBins(
    [['wl-copy', [], { input: payload }], ['xclip', ['-selection', 'clipboard', '-i'], { input: payload }], ['xsel', ['--clipboard', '--input'], { input: payload }]],
    'No clipboard tool found. Wayland: sudo dnf install wl-clipboard · X11: sudo dnf install xclip',
  );
  return '📋 Copied to the PC clipboard.';
}

// ── processes / files ────────────────────────────────────────────────────────

export async function topProcesses() {
  const out = await run('ps', ['-eo', 'pid,comm,%cpu,%mem', '--sort=-%cpu']);
  const lines = out.trim().split('\n').slice(0, 11);
  return `📊 *Top processes (CPU)*\n\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '__pycache__', '.local']);
const BLOCKED_PARTS = ['.ssh', '.gnupg', 'auth_info', path.join('.local', 'share', 'keyrings')];

export function resolveHomeFile(input) {
  const home = os.homedir();
  let wanted = String(input ?? '').trim();
  if (!wanted) return { ok: false, reason: 'usage: /pc get <path under your home folder>' };
  if (wanted === '~') wanted = home;
  else if (wanted.startsWith('~/')) wanted = path.join(home, wanted.slice(2));
  const absolute = path.isAbsolute(wanted) ? path.normalize(wanted) : path.join(home, wanted);
  let real;
  let homeReal;
  try {
    real = fs.realpathSync(absolute);
    homeReal = fs.realpathSync(home);
  } catch {
    return { ok: false, reason: `"${path.basename(absolute)}" doesn't exist under your home folder.` };
  }
  if (real !== homeReal && !real.startsWith(homeReal + path.sep)) {
    return { ok: false, reason: 'That path is outside your home folder — I only fetch files from under $HOME.' };
  }
  const relative = path.relative(homeReal, real);
  if (BLOCKED_PARTS.some((blocked) => relative === blocked || relative.startsWith(blocked + path.sep) || relative.split(path.sep).includes('auth_info'))) {
    return { ok: false, reason: 'That folder is blocked on purpose (keys / WhatsApp login live there).' };
  }
  return { ok: true, file: real };
}

export async function findFiles(query, { maxResults = 20, maxVisited = 25_000, maxDepth = 5 } = {}) {
  const needle = String(query ?? '').toLowerCase().trim();
  if (!needle) throw new Error('usage: /pc find <part of filename>');
  const home = os.homedir();
  const results = [];
  let visited = 0;
  async function walk(dir, depth) {
    if (depth > maxDepth || visited > maxVisited || results.length >= maxResults) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (visited++ > maxVisited || results.length >= maxResults) return;
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name.toLowerCase().includes(needle)) results.push(path.relative(home, full));
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
    }
  }
  await walk(home, 0);
  return results;
}

// ── power (tier 2, confirmation handled in commands.js) ─────────────────────

const POWER = { shutdown: 'poweroff', poweroff: 'poweroff', reboot: 'reboot', restart: 'reboot', suspend: 'suspend', sleep: 'suspend' };

let powerHook = null;
/** Register a callback invoked immediately when schedulePower() is called. */
export function setPowerHook(fn) {
  powerHook = typeof fn === 'function' ? fn : null;
}

/** Fires the power action 5 s later so the WhatsApp confirmation/sleeping message can send first. */
export function schedulePower(action) {
  const verb = POWER[action];
  if (!verb) throw new Error(`unknown power action "${action}"`);
  if (powerHook) {
    Promise.resolve().then(() => powerHook(action, verb)).catch(() => {});
  }
  setTimeout(() => {
    execFile('systemctl', [verb], { env: displayEnv() }, (err) => {
      if (err) console.error(`[pc] power action ${verb} failed: ${err.message}`);
    });
  }, 5_000);
  return verb;
}

export const PC_CONTROL_INSTALL_HINT =
  'sudo dnf install grim gnome-screenshot scrot playerctl brightnessctl ydotool xdotool wl-clipboard libnotify';
