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

const execFileAsync = promisify(execFile);
const RUN_TIMEOUT = 10_000;

/** Graphical-session environment, with fallbacks for systemd --user services
 *  started at boot (linger) before the desktop exported its variables. */
export function displayEnv() {
  const env = { ...process.env };
  const uid = typeof os.userInfo().uid === 'number' ? os.userInfo().uid : 1000;
  env.XDG_RUNTIME_DIR ||= `/run/user/${uid}`;
  env.DBUS_SESSION_BUS_ADDRESS ||= `unix:path=${env.XDG_RUNTIME_DIR}/bus`;
  env.WAYLAND_DISPLAY ||= 'wayland-0';
  env.DISPLAY ||= ':0';
  return env;
}

function hasGraphicalSession(env = displayEnv()) {
  const waylandSocket = env.WAYLAND_DISPLAY?.startsWith('/')
    ? env.WAYLAND_DISPLAY
    : path.join(env.XDG_RUNTIME_DIR, env.WAYLAND_DISPLAY || 'wayland-0');
  const x11Socket = `/tmp/.X11-unix/X${(env.DISPLAY || ':0').replace(/^:/, '').split('.')[0]}`;
  return fs.existsSync(waylandSocket) || fs.existsSync(x11Socket);
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
  const { stdout } = await execFileAsync(bin, args, {
    timeout: opts.timeout ?? RUN_TIMEOUT,
    env: displayEnv(),
    input: opts.input,
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

export async function captureScreenshot() {
  if (!hasGraphicalSession()) throw new Error(NO_SESSION);
  const file = path.join(os.tmpdir(), `observer-shot-${Date.now()}.png`);
  const attempts = [
    ['grim', [file]],                                                              // wlroots/Sway/Hyprland (not GNOME)
    ['gdbus', ['call', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/org/gnome/Shell', '--method', 'org.gnome.Shell.Screenshot.Screenshot', 'false', 'false', file]], // GNOME
    ['spectacle', ['-b', '-n', '-o', file]],                                       // KDE Plasma
    ['gnome-screenshot', ['-f', file]],                                            // GNOME on X11 / older
    ['scrot', [file]],                                                             // X11
    ['maim', [file]],                                                              // X11
    ['import', ['-window', 'root', file]],                                         // ImageMagick, X11
  ];
  const failures = [];
  try {
    for (const [bin, args] of attempts) {
      try {
        await run(bin, args, { timeout: 12_000 });
        if (fs.existsSync(file) && fs.statSync(file).size > 0) return fs.readFileSync(file);
        failures.push(`${bin}: produced no file`);
      } catch (err) {
        failures.push(err.code === 'ENOENT' ? `${bin}: not installed` : `${bin}: ${(err.stderr || err.message || '').toString().trim().split('\n').at(-1)?.slice(0, 120)}`);
      }
    }
  } finally {
    try { fs.unlinkSync(file); } catch { /* either read already or never created */ }
  }
  const session = process.env.XDG_SESSION_TYPE || 'wayland?';
  throw new Error(
    `Couldn't capture the screen in this ${session} session. Tried: ${failures.join(' · ')}.\n` +
    `Fix on Fedora: sudo dnf install grim gnome-screenshot scrot  (KDE: kde-spectacle). ` +
    `GNOME+Wayland is the strictest — /screen via Observer (browser capture) is the reliable path there.`,
  );
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
    [['notify-send', ['Observer WhatsApp Agent', String(text).slice(0, 256)]]],
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
    await launchDetached(findBin('xdg-open') ?? 'xdg-open', [trimmed]);
    return `🌐 Opened ${trimmed} in the PC's browser.`;
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

const INPUT_MISSING = 'No input tool found. Fedora/Wayland: sudo dnf install ydotool && sudo systemctl enable --now ydotool (daemon: ydotoold). X11 sessions: sudo dnf install xdotool';

function inputToolOrder() {
  const session = (process.env.XDG_SESSION_TYPE ?? '').toLowerCase();
  const waylandFirst = session !== 'x11';
  return waylandFirst ? ['ydotool', 'xdotool'] : ['xdotool', 'ydotool'];
}

async function runInput(builders) {
  const failures = [];
  for (const tool of inputToolOrder()) {
    const args = builders[tool];
    if (!args) continue;
    try {
      await run(tool, args);
      return tool;
    } catch (err) {
      failures.push({ tool, err });
    }
  }
  if (failures.every(({ err }) => err.code === 'ENOENT')) throw new Error(INPUT_MISSING);
  const real = failures.filter(({ err }) => err.code !== 'ENOENT').at(-1);
  const hint = real.tool === 'ydotool' ? ' Is the daemon running? sudo systemctl enable --now ydotool (or: ydotoold).' : ' On Wayland, xdotool only reaches XWayland apps — ydotool is the reliable path.';
  throw new Error(`${real.tool} failed: ${(real.err.stderr || real.err.message || '').toString().trim().split('\n').at(-1)?.slice(0, 160)}.${hint}`);
}

export async function typeText(text) {
  const payload = String(text ?? '').slice(0, 500);
  if (!payload) throw new Error('usage: /pc type <text>');
  if (!hasGraphicalSession()) throw new Error(NO_SESSION);
  const used = await runInput({
    ydotool: ['type', payload],
    xdotool: ['type', '--clearmodifiers', '--', payload],
  });
  return `⌨️ Typed ${payload.length} characters via ${used}.`;
}

export async function keyCombo(combo) {
  if (!combo) throw new Error('usage: /pc key ctrl+l · alt+tab · super · enter');
  if (!hasGraphicalSession()) throw new Error(NO_SESSION);
  const used = await runInput({
    ydotool: ['key', ...ydotoolKeyArgs(combo)],
    xdotool: ['key', '--clearmodifiers', normalizeKeyForXdotool(combo)],
  });
  return `⌨️ Sent key "${combo}" via ${used}.`;
}

export async function click(x, y, button = 'left') {
  if (!hasGraphicalSession()) throw new Error(NO_SESSION);
  const hasCoords = Number.isFinite(x) && Number.isFinite(y);
  const failures = [];
  for (const tool of inputToolOrder()) {
    try {
      if (tool === 'ydotool') {
        if (hasCoords) await run('ydotool', ['mousemove', '--absolute', '-x', String(x), '-y', String(y)]);
        await run('ydotool', ['click', button === 'right' ? '0xC1' : button === 'middle' ? '0xC2' : '0xC0']);
      } else {
        if (hasCoords) await run('xdotool', ['mousemove', String(x), String(y)]);
        await run('xdotool', ['click', button === 'right' ? '3' : button === 'middle' ? '2' : '1']);
      }
      return `🖱️ ${button} click${hasCoords ? ` at ${x},${y}` : ' at the cursor'} via ${tool}.`;
    } catch (err) { failures.push({ tool, err }); }
  }
  if (failures.every(({ err }) => err.code === 'ENOENT')) throw new Error(INPUT_MISSING);
  const real = failures.filter(({ err }) => err.code !== 'ENOENT').at(-1);
  throw new Error(`${real.tool} click failed: ${(real.err.stderr || real.err.message || '').toString().trim().split('\n').at(-1)?.slice(0, 160)}`);
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

/** Fires the power action 5 s later so the WhatsApp confirmation can send first. */
export function schedulePower(action) {
  const verb = POWER[action];
  if (!verb) throw new Error(`unknown power action "${action}"`);
  setTimeout(() => {
    execFile('systemctl', [verb], { env: displayEnv() }, (err) => {
      if (err) console.error(`[pc] power action ${verb} failed: ${err.message}`);
    });
  }, 5_000);
  return verb;
}

export const PC_CONTROL_INSTALL_HINT =
  'sudo dnf install grim gnome-screenshot scrot playerctl brightnessctl ydotool xdotool wl-clipboard libnotify';
