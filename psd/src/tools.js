// tools.js — PSD's hands. One registry, three permission levels, and a
// confirmation gate for anything that cannot be undone.
//
// Shape follows OpenJarvis' BaseTool/spec contract (name, description, JSON
// parameters, execute) so the same registry can be exported as MCP tools, fed
// to any OpenAI-compatible model, or called straight from the notch, the phone
// app, WhatsApp and `psd run`.
//
// Deliberate design rules:
//   * every command is execFile (argv array), never a shell string
//   * every call has a hard timeout and a bounded output
//   * reading secrets is blocked, writing outside allowed roots is blocked
//   * destructive tools park themselves in a pending queue until the owner says
//     yes — the model cannot confirm on the owner's behalf

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const LEVELS = { safe: 0, standard: 1, full: 2 };
const MAX_OUT = 6000;

const MODIFIERS = { ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'alt', meta: 'logo', super: 'logo', win: 'logo', cmd: 'logo' };
const KEY_NAMES = {
  enter: 'Return', return: 'Return', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'space',
  backspace: 'BackSpace', delete: 'Delete', del: 'Delete', up: 'Up', down: 'Down', left: 'Left',
  right: 'Right', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next', volumeup: 'XF86AudioRaiseVolume',
  volumedown: 'XF86AudioLowerVolume', mute: 'XF86AudioMute', playpause: 'XF86AudioPlay',
};
const KEYCODES = {
  Escape: 1, Tab: 15, BackSpace: 14, Return: 28, ctrl: 29, shift: 42, alt: 56, logo: 125,
  space: 57, Delete: 111, Home: 102, Up: 103, Prior: 104, Left: 105, Right: 106, End: 107,
  Down: 108, Next: 109, Insert: 110,
};

const SECRET_PATTERNS = [
  /\/\.ssh\/(id_|.*_key)/i, /\/\.gnupg\//i, /\/\.aws\/credentials/i, /\/\.netrc$/i,
  /\/\.kube\/config$/i, /\/\.config\/(chrome|chromium|google-chrome|BraveSoftware)\//i,
  /\/\.mozilla\/firefox\/.*(logins|cookies|key[0-9])/i, /\/\.local\/share\/keyrings?\//i,
];

export function humanBytes(bytes) {
  const n = Number(bytes) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let value = n;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function shorten(text, limit = MAX_OUT) {
  const value = typeof text === 'string' ? text : JSON.stringify(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}\n… (${value.length - limit} chars trimmed)` : value;
}

function isSecret(target) {
  const resolved = path.resolve(String(target || ''));
  return SECRET_PATTERNS.some((re) => re.test(resolved));
}

function rootsFor(config) {
  const home = os.homedir();
  const roots = [home, '/tmp', path.join(home, '.local', 'share', 'psd')];
  for (const extra of config.allowRoots ?? []) if (extra) roots.push(extra);
  return [...new Set(roots)];
}

function resolveUserPath(input, config, { mustExist = false } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('A path is required.');
  if (raw.includes('\0')) throw new Error('Invalid path.');
  const expanded = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  const resolved = path.resolve(expanded);
  if (isSecret(resolved)) throw new Error('That path holds credentials. PSD will not read or write it.');
  const roots = rootsFor(config);
  const inside = roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!inside) throw new Error(`Outside the allowed roots (${roots.join(', ')}). Add it to PSD_ALLOW_ROOTS if it is really yours.`);
  if (mustExist && !fs.existsSync(resolved)) throw new Error(`Not found: ${resolved}`);
  return resolved;
}

async function run(cmd, args, { timeout = 15_000, cwd = os.homedir(), input = null, env = {} } = {}) {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    timeout, cwd, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', input: input ?? undefined,
    env: { ...process.env, ...env },
  }).catch((err) => {
    if (err.killed || err.signal) throw new Error(`${cmd} timed out after ${timeout}ms`);
    const message = (err.stderr || err.stdout || err.message || '').toString().trim();
    throw new Error(`${cmd} failed: ${message.slice(0, 500) || 'no output'}`);
  });
  return { stdout: stdout ?? '', stderr: stderr ?? '' };
}

async function which(binary) {
  try { await run('sh', ['-lc', `command -v ${binary}`], { timeout: 4000 }); return true; } catch { return false; }
}

async function gsettings(schema, key, value) {
  if (value === undefined) {
    const { stdout } = await run('gsettings', ['get', schema, key], { timeout: 5000 });
    return stdout.trim();
  }
  await run('gsettings', ['set', schema, key, String(value)], { timeout: 5000 });
  return String(value);
}

function readDesktopEntries() {
  const dirs = [
    path.join(os.homedir(), '.local', 'share', 'applications'),
    '/usr/share/applications',
    '/usr/local/share/applications',
    '/var/lib/flatpak/exports/share/applications',
    path.join(os.homedir(), '.local', 'share', 'flatpak', 'exports', 'share', 'applications'),
    '/var/lib/snapd/desktop/applications',
  ];
  const apps = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.desktop')) continue;
      try {
        const text = fs.readFileSync(path.join(dir, name), 'utf8');
        const section = text.split(/^\[Desktop Entry\]$/m)[1]?.split(/^\[/m)[0] ?? '';
        const field = (key) => section.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
        if (/^(true)$/i.test(field('NoDisplay')) || /^(true)$/i.test(field('Hidden'))) continue;
        const label = field('Name');
        if (!label) continue;
        apps.push({
          id: name.replace(/\.desktop$/, ''),
          name: label,
          generic: field('GenericName'),
          keywords: field('Keywords'),
          exec: field('Exec'),
          terminal: /^true$/i.test(field('Terminal')),
        });
      } catch { /* unreadable entry */ }
    }
  }
  // Later dirs can shadow earlier ones (user entries win); keep the first.
  const seen = new Set();
  return apps.filter((app) => (seen.has(app.id) ? false : (seen.add(app.id), true)));
}

function matchApp(query, apps) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  const score = (app) => {
    const name = app.name.toLowerCase();
    if (name === q) return 100;
    if (app.id.toLowerCase() === q) return 95;
    if (name.startsWith(q)) return 80;
    if (name.includes(q)) return 60;
    if (app.id.toLowerCase().includes(q)) return 50;
    if ((app.generic || '').toLowerCase().includes(q)) return 40;
    if ((app.keywords || '').toLowerCase().split(';').some((k) => k && q.includes(k))) return 20;
    return 0;
  };
  return apps.map((app) => ({ app, score: score(app) })).filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score).map((x) => x.app);
}

function cpuSample() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/).slice(1).map(Number);
    const idle = line[3] + (line[4] || 0);
    const total = line.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch { return null; }
}

function memSample() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = (key) => Number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] ?? 0);
    const total = kb('MemTotal');
    const available = kb('MemAvailable') || kb('MemFree');
    return { total, used: total - available, available };
  } catch { return null; }
}

function batterySample() {
  try {
    const base = '/sys/class/power_supply';
    for (const entry of fs.readdirSync(base)) {
      const type = fs.readFileSync(path.join(base, entry, 'type'), 'utf8').trim();
      if (type !== 'Battery') continue;
      const read = (key) => {
        try { return fs.readFileSync(path.join(base, entry, key), 'utf8').trim(); } catch { return ''; }
      };
      return { percent: Number(read('capacity')) || null, status: read('status') || 'Unknown' };
    }
  } catch { /* desktop */ }
  return null;
}

/** One snapshot the notch clock line and /psd/status both use. */
export async function systemSnapshot() {
  const mem = memSample();
  const battery = batterySample();
  let cpu = null;
  const first = cpuSample();
  if (first) {
    await new Promise((r) => setTimeout(r, 120));
    const second = cpuSample();
    if (second) {
      const dTotal = second.total - first.total;
      const dIdle = second.idle - first.idle;
      cpu = dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : null;
    }
  }
  let uptime = null;
  try { uptime = Math.round(os.uptime()); } catch { /* noop */ }
  let ip = '';
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (name === 'lo') continue;
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) { ip = addr.address; break; }
    }
    if (ip) break;
  }
  return {
    cpu,
    mem: mem ? Math.round((mem.used / mem.total) * 100) : null,
    memUsed: mem ? mem.used * 1024 : null,
    memTotal: mem ? mem.total * 1024 : null,
    battery,
    uptime,
    hostname: os.hostname(),
    kernel: os.release(),
    load: os.loadavg().map((n) => Math.round(n * 100) / 100),
    ip,
  };
}

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

/**
 * @param {{config: object, memory: import('./memory.js').Memory,
 *          notch: import('./notch.js').NotchBridge,
 *          whatsapp: object, bus: Function}} deps
 */
export function createTools({ config, memory, notch, whatsapp, bus = () => {} }) {
  const level = () => (config.access in LEVELS ? config.access : 'standard');

  const pending = {
    queue: new Map(),
    park(name, args) {
      const id = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 12);
      this.queue.set(id, { id, name, args, at: Date.now(), expires: Date.now() + config.confirmTtlMs });
      bus({ type: 'approval', id, name, args, text: describeAction(name, args) });
      return { needsConfirmation: true, id, text: describeAction(name, args) };
    },
    take(id) {
      const item = this.queue.get(id);
      this.queue.delete(id);
      if (!item) throw new Error('That confirmation expired or was already used.');
      if (Date.now() > item.expires) throw new Error('That confirmation expired. Ask again.');
      return item;
    },
    list() {
      const now = Date.now();
      for (const [id, item] of this.queue) if (item.expires < now) this.queue.delete(id);
      return [...this.queue.values()];
    },
  };

  function describeAction(name, args) {
    const bits = Object.entries(args ?? {})
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${shorten(String(v), 60).replace(/\n/g, ' ')}`);
    return `${name} ${bits.join(' ')}`.trim();
  }

  const apps = () => readDesktopEntries();

  /** Ordered worst-case-friendly registry. */
  const registry = [
    // ── Apps & desktop ──────────────────────────────────────────────────────
    {
      name: 'open_app', level: 'standard', label: 'Open an application',
      description: 'Launch an installed desktop application by name (e.g. "chrome", "code", "spotify"). Use list_apps if unsure of the name.',
      params: { name: { type: 'string', description: 'Application name', required: true } },
      async run({ name }) {
        const matches = matchApp(name, apps());
        if (!matches.length) {
          return `No installed app matches "${name}". Send /psd/apps or call list_apps to see the list.`;
        }
        const target = matches[0];
        const errors = [];
        for (const argv of [
          ['gtk-launch', [target.id]],
          ['gio', ['launch', path.join('/usr/share/applications', `${target.id}.desktop`)]],
          ['setsid', ['-f', 'sh', '-c', `gtk-launch ${JSON.stringify(target.id)} >/dev/null 2>&1`]],
        ]) {
          try {
            await run(argv[0], argv[1], { timeout: 8000 });
            return `Opened ${target.name} (${target.id}).`;
          } catch (err) { errors.push(err.message); }
        }
        throw new Error(`Could not launch ${target.name}. ${errors[0] ?? ''}`);
      },
    },
    {
      name: 'list_apps', level: 'safe', label: 'List installed apps',
      description: 'List installed desktop applications. Useful before open_app.',
      params: { query: { type: 'string', description: 'Optional filter' } },
      async run({ query }) {
        const list = apps();
        const filtered = query ? matchApp(query, list) : list;
        const names = filtered.slice(0, 120).map((a) => a.name);
        return names.length ? `${filtered.length} app(s): ${names.join(', ')}` : 'No apps matched.';
      },
    },
    {
      name: 'list_windows', level: 'safe', label: 'List open windows',
      description: 'List currently open windows so you can see what the owner is doing.',
      params: {},
      async run() {
        if (await which('wmctrl')) {
          const { stdout } = await run('wmctrl', ['-l'], { timeout: 6000 });
          const lines = stdout.split('\n').map((l) => l.split(/\s+/).slice(3).join(' ').trim()).filter(Boolean);
          return lines.length ? `${lines.length} window(s): ${lines.join(' | ')}` : 'No windows open.';
        }
        try {
          const gdbus = await run('gdbus', ['call', '--session', '--dest', 'org.gnome.Shell',
            '--object-path', '/org/gnome/Shell', '--method', 'org.gnome.Shell.Eval',
            'global.display.list_all_windows().map(w=>({t:w.get_title(),c:w.get_wm_class()})).filter(w=>w.t)'], { timeout: 8000 });
          const raw = gdbus.stdout.match(/\((true|false), '(.*)'\)/s)?.[2];
          if (raw) {
            const list = JSON.parse(raw.replace(/\\"/g, '"'));
            return list.length ? `${list.length} window(s): ${list.map((w) => w.t).join(' | ')}` : 'No windows open.';
          }
        } catch { /* shell eval is disabled by default on GNOME 44+ */ }
        return 'Window listing needs wmctrl (`sudo dnf install wmctrl`) or GNOME unsafe-mode for Shell eval.';
      },
    },
    {
      name: 'focus_window', level: 'standard', label: 'Focus a window',
      description: 'Bring a window to the front by part of its title.',
      params: { title: { type: 'string', description: 'Part of the window title', required: true } },
      async run({ title }) {
        if (!(await which('wmctrl'))) throw new Error('wmctrl is not installed (sudo dnf install wmctrl).');
        const { stdout } = await run('wmctrl', ['-l'], { timeout: 6000 });
        const match = stdout.split('\n').find((line) => line.toLowerCase().includes(String(title).toLowerCase()));
        if (!match) throw new Error(`No window matching "${title}".`);
        const id = match.split(/\s+/)[0];
        await run('wmctrl', ['-a', id], { timeout: 6000 });
        return `Focused: ${match.split(/\s+/).slice(3).join(' ')}`;
      },
    },

    // ── Screen ──────────────────────────────────────────────────────────────
    {
      name: 'screenshot', level: 'safe', label: 'Take a screenshot', shot: true,
      description: 'Capture the current screen. Returns an image the owner can see; only take one when asked or when it is real evidence.',
      params: { region: { type: 'string', description: 'Optional: "screen" (default) or a gnome-screenshot area' } },
      async run() {
        const file = path.join('/tmp', `psd-shot-${Date.now()}.png`);
        const tries = [
          ['grim', [file]],
          ['gnome-screenshot', ['-f', file]],
          ['spectacle', ['-b', '-n', '-o', file]],
        ];
        for (const [cmd, args] of tries) {
          if (!(await which(cmd))) continue;
          try {
            await run(cmd, args, { timeout: 12_000 });
            if (fs.existsSync(file) && fs.statSync(file).size > 2048) {
              const base64 = fs.readFileSync(file).toString('base64');
              setTimeout(() => { try { fs.unlinkSync(file); } catch { /* gone */ } }, 30_000);
              return { text: 'Screenshot captured.', image: base64, file };
            }
          } catch { /* try the next tool */ }
        }
        throw new Error('No screenshot tool worked. Install grim (`sudo dnf install grim`) and run ./scripts/psd.sh fix.');
      },
    },
    {
      name: 'type_text', level: 'standard', label: 'Type text',
      description: 'Type text into the focused window as if the owner typed it.',
      params: { text: { type: 'string', description: 'Text to type', required: true } },
      async run({ text }) {
        const value = String(text ?? '').slice(0, 4000);
        if (!value) throw new Error('Nothing to type.');
        if (await which('ydotool')) {
          await run('ydotool', ['type', '--', value], { timeout: 20_000 });
          return `Typed ${value.length} characters.`;
        }
        if (await which('wtype')) {
          await run('wtype', ['--', value], { timeout: 20_000 });
          return `Typed ${value.length} characters.`;
        }
        throw new Error('No input tool. Install ydotool or wtype (`sudo dnf install ydotool wtype`).');
      },
    },
    {
      name: 'press_key', level: 'standard', label: 'Press a key',
      description: 'Press a key or shortcut in the focused window, e.g. "Return", "ctrl+l", "super+d", "alt+Tab".',
      params: { key: { type: 'string', description: 'Key or combo', required: true } },
      async run({ key }) {
        const combo = String(key ?? '').trim().toLowerCase();
        if (!/^[a-z0-9+ -]{1,40}$/.test(combo)) throw new Error('Invalid key combination.');
        const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
        const mods = parts.filter((p) => MODIFIERS[p]);
        const keys = parts.filter((p) => !MODIFIERS[p]);
        if (!keys.length) throw new Error('A key (not just a modifier) is required.');
        if (await which('wtype')) {
          const args = [];
          for (const mod of mods) args.push('-M', MODIFIERS[mod]);
          for (const k of keys) args.push('-k', KEY_NAMES[k] ?? k);
          for (const mod of mods.reverse()) args.push('-m', MODIFIERS[mod]);
          await run('wtype', args, { timeout: 10_000 });
          return `Pressed ${combo}.`;
        }
        if (await which('ydotool')) {
          // ydotool takes Linux keycodes: press modifiers, tap keys, release.
          const seq = [];
          for (const mod of mods) seq.push(`${KEYCODES[MODIFIERS[mod]] ?? 29}:1`);
          for (const k of keys) {
            const code = KEYCODES[KEY_NAMES[k] ?? k] ?? KEYCODES[k];
            if (!code) throw new Error(`Unknown key "${k}" for ydotool. Try wtype instead.`);
            seq.push(`${code}:1`, `${code}:0`);
          }
          for (const mod of mods.reverse()) seq.push(`${KEYCODES[MODIFIERS[mod]] ?? 29}:0`);
          await run('ydotool', ['key', ...seq], { timeout: 10_000 });
          return `Pressed ${combo}.`;
        }
        throw new Error('No input tool. Install wtype or ydotool (`sudo dnf install wtype ydotool`).');
      },
    },
    {
      name: 'click', level: 'standard', label: 'Click the mouse',
      description: 'Move the pointer and click. Coordinates are pixels on the primary monitor.',
      params: {
        x: { type: 'number', description: 'X pixel', required: true },
        y: { type: 'number', description: 'Y pixel', required: true },
        button: { type: 'string', description: 'left|right|middle' },
      },
      async run({ x, y, button = 'left' }) {
        const px = Math.round(Number(x));
        const py = Math.round(Number(y));
        if (!Number.isFinite(px) || !Number.isFinite(py) || px < 0 || py < 0) throw new Error('Valid x and y pixels are required.');
        const map = { left: '1', right: '3', middle: '2' };
        const code = map[String(button).toLowerCase()] ?? '1';
        if (!(await which('ydotool'))) throw new Error('Clicking needs ydotool (`sudo dnf install ydotool`).');
        await run('ydotool', ['mousemove', '--absolute', '-x', String(px), '-y', String(py)], { timeout: 8000 });
        await run('ydotool', ['click', code], { timeout: 8000 });
        return `Clicked ${button} at ${px},${py}.`;
      },
    },

    // ── System ──────────────────────────────────────────────────────────────
    {
      name: 'system_status', level: 'safe', label: 'System status',
      description: 'CPU, memory, battery, uptime, load and IP of this Fedora machine.',
      params: {},
      async run() {
        const snap = await systemSnapshot();
        return [
          `Host: ${snap.hostname} (${snap.kernel})`,
          `CPU: ${snap.cpu ?? '—'}%`, `Memory: ${snap.mem ?? '—'}% (${humanBytes(snap.memUsed)} / ${humanBytes(snap.memTotal)})`,
          snap.battery?.percent != null ? `Battery: ${snap.battery.percent}% (${snap.battery.status})` : '',
          `Load: ${snap.load.join(' / ')}`, `IP: ${snap.ip || 'no LAN IP'}`,
          `Uptime: ${snap.uptime != null ? `${Math.floor(snap.uptime / 3600)}h ${Math.floor((snap.uptime % 3600) / 60)}m` : '—'}`,
        ].filter(Boolean).join('\n');
      },
    },
    {
      name: 'disk_space', level: 'safe', label: 'Disk space',
      description: 'Free and total space for the owner\'s home and root filesystems.',
      params: {},
      async run() {
        const lines = [];
        for (const target of ['/', os.homedir()]) {
          try {
            const s = fs.statfsSync(target);
            const total = s.blocks * s.bsize;
            const free = s.bavail * s.bsize;
            lines.push(`${target}: ${humanBytes(free)} free of ${humanBytes(total)} (${Math.round((1 - free / total) * 100)}% used)`);
          } catch { /* skip */ }
        }
        return lines.join('\n') || 'Could not read disk information.';
      },
    },
    {
      name: 'volume', level: 'standard', label: 'Change the volume',
      description: 'Set, raise, lower or mute the default audio volume.',
      params: {
        action: { type: 'string', description: 'up|down|mute|set|get', required: true },
        value: { type: 'number', description: 'For action=set, 0-100' },
      },
      async run({ action, value }) {
        const word = String(action ?? '').toLowerCase();
        if (await which('wpctl')) {
          const target = '@DEFAULT_AUDIO_SINK@';
          if (word === 'mute') await run('wpctl', ['set-mute', target, 'toggle']);
          else if (word === 'up') await run('wpctl', ['set-volume', target, '5%+']);
          else if (word === 'down') await run('wpctl', ['set-volume', target, '5%-']);
          else if (word === 'set') await run('wpctl', ['set-volume', target, `${Math.max(0, Math.min(150, Number(value) || 50))}%`]);
          else {
            const { stdout } = await run('wpctl', ['get-volume', target]);
            return `Volume: ${stdout.trim()}`;
          }
          const { stdout } = await run('wpctl', ['get-volume', target]);
          return `Volume: ${stdout.trim()}`;
        }
        if (await which('pactl')) {
          const map = { up: '+5%', down: '-5%', mute: 'toggle' };
          if (word === 'set') await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${Number(value) || 50}%`]);
          else await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', map[word] ?? '+0%']);
          return `Volume ${word}.`;
        }
        throw new Error('No audio control found (wpctl/pactl).');
      },
    },
    {
      name: 'media_control', level: 'standard', label: 'Control music',
      description: 'Play, pause, play-pause, next, previous or report the current track.',
      params: { action: { type: 'string', description: 'play|pause|play-pause|next|previous|status|stop', required: true } },
      async run({ action }) {
        const word = String(action ?? 'status').toLowerCase();
        if (!(await which('playerctl'))) throw new Error('playerctl is not installed (sudo dnf install playerctl).');
        if (word === 'status') {
          const { stdout } = await run('playerctl', ['metadata', '--format', '{{status}}|{{artist}}|{{title}}|{{playerName}}'], { timeout: 6000 });
          const [status, artist, title, player] = stdout.trim().split('|');
          return `${player || 'player'}: ${title || 'nothing'}${artist ? ` — ${artist}` : ''} (${status || 'unknown'})`;
        }
        await run('playerctl', [word === 'play-pause' ? 'play-pause' : word], { timeout: 6000 });
        return `Music: ${word}.`;
      },
    },
    {
      name: 'wifi', level: 'standard', label: 'Wi-Fi',
      description: 'Turn Wi-Fi on/off, list networks, or report the current connection.',
      params: { action: { type: 'string', description: 'status|on|off|list', required: true } },
      async run({ action }) {
        const word = String(action ?? 'status').toLowerCase();
        if (word === 'on' || word === 'off') {
          await run('nmcli', ['radio', 'wifi', word], { timeout: 15_000 });
          return `Wi-Fi turned ${word}.`;
        }
        if (word === 'list') {
          const { stdout } = await run('nmcli', ['-t', '-f', 'SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', 'no'], { timeout: 20_000 });
          const rows = stdout.split('\n').filter(Boolean).slice(0, 15);
          return rows.length ? rows.map((r) => r.replace(/:/g, ' · ')).join('\n') : 'No networks visible.';
        }
        const { stdout } = await run('nmcli', ['-t', '-f', 'ACTIVE,SSID,SIGNAL', 'device', 'wifi'], { timeout: 10_000 });
        const active = stdout.split('\n').find((l) => l.startsWith('yes'));
        return active ? `Connected: ${active.split(':').slice(1).join(' · ')}` : 'Wi-Fi is off or not connected.';
      },
    },
    {
      name: 'bluetooth', level: 'standard', label: 'Bluetooth',
      description: 'Turn Bluetooth on/off or report it.',
      params: { action: { type: 'string', description: 'status|on|off', required: true } },
      async run({ action }) {
        const word = String(action ?? 'status').toLowerCase();
        if (word === 'on' || word === 'off') {
          await run('bluetoothctl', ['power', word], { timeout: 10_000 });
          return `Bluetooth ${word}.`;
        }
        const { stdout } = await run('bluetoothctl', ['show'], { timeout: 8000 });
        const powered = stdout.match(/Powered:\s+(yes|no)/i)?.[1] ?? 'unknown';
        return `Bluetooth powered: ${powered}`;
      },
    },
    {
      name: 'notification', level: 'safe', label: 'Send a desktop notification',
      description: 'Show a desktop notification on the PC. The notch picks it up as a peek.',
      params: {
        title: { type: 'string', description: 'Title', required: true },
        body: { type: 'string', description: 'Body text' },
      },
      async run({ title, body = '' }) {
        try { await run('notify-send', ['-a', 'PSD', '-i', 'io.github.pavit12301611.Notch', String(title), String(body)], { timeout: 6000 }); }
        catch { throw new Error('notify-send is missing (sudo dnf install libnotify).'); }
        return 'Notification sent.';
      },
    },
    {
      name: 'do_not_disturb', level: 'standard', label: 'Do Not Disturb',
      description: 'Turn GNOME Do Not Disturb (banner suppression) on or off.',
      params: { enabled: { type: 'boolean', description: 'true = silence banners', required: true } },
      async run({ enabled }) {
        const on = Boolean(enabled);
        await gsettings('org.gnome.desktop.notifications', 'show-banners', on ? 'false' : 'true');
        await notch.push({ type: 'dnd', enabled: on });
        return `Do Not Disturb ${on ? 'on' : 'off'}.`;
      },
    },
    {
      name: 'dark_mode', level: 'standard', label: 'Dark mode',
      description: 'Switch the GNOME colour scheme between dark and light.',
      params: { enabled: { type: 'boolean', description: 'true = dark', required: true } },
      async run({ enabled }) {
        await gsettings('org.gnome.desktop.interface', 'color-scheme', enabled ? 'prefer-dark' : 'default');
        await notch.push({ type: 'theme', dark: Boolean(enabled) });
        return `Dark mode ${enabled ? 'on' : 'off'}.`;
      },
    },
    {
      name: 'night_light', level: 'standard', label: 'Night light',
      description: 'Turn GNOME Night Light on or off.',
      params: { enabled: { type: 'boolean', required: true } },
      async run({ enabled }) {
        await gsettings('org.gnome.settings-daemon.plugins.color', 'night-light-enabled', String(Boolean(enabled)));
        return `Night light ${enabled ? 'on' : 'off'}.`;
      },
    },
    {
      name: 'lock_screen', level: 'standard', label: 'Lock the screen', destructive: true,
      description: 'Lock the session immediately.',
      params: {},
      async run() {
        await run('loginctl', ['lock-session'], { timeout: 6000 }).catch(async () => {
          await run('gdbus', ['call', '--session', '--dest', 'org.gnome.ScreenSaver', '--object-path', '/org/gnome/ScreenSaver',
            '--method', 'org.gnome.ScreenSaver.Lock'], { timeout: 6000 });
        });
        return 'Screen locked.';
      },
    },
    {
      name: 'power', level: 'full', label: 'Power action', destructive: true, requiresShell: false,
      description: 'Reboot, power off, suspend, or log out. Always asks the owner first.',
      params: { action: { type: 'string', description: 'reboot|poweroff|suspend|logout|hibernate', required: true } },
      async run({ action }) {
        const word = String(action ?? '').toLowerCase();
        const commands = {
          reboot: ['systemctl', ['reboot']],
          poweroff: ['systemctl', ['poweroff']],
          shutdown: ['systemctl', ['poweroff']],
          suspend: ['systemctl', ['suspend']],
          hibernate: ['systemctl', ['hibernate']],
          logout: ['gnome-session-quit', ['--logout', '--no-prompt']],
        };
        const entry = commands[word];
        if (!entry) throw new Error(`Unknown power action "${action}".`);
        await run(entry[0], entry[1], { timeout: 8000 });
        return `Running ${word}.`;
      },
    },

    // ── Files ───────────────────────────────────────────────────────────────
    {
      name: 'list_dir', level: 'safe', label: 'List a folder',
      description: 'List files in a folder inside the owner\'s home.',
      params: { path: { type: 'string', description: 'Folder path', required: true } },
      async run({ path: target }) {
        const dir = resolveUserPath(target, config, { mustExist: true });
        if (!fs.statSync(dir).isDirectory()) throw new Error(`${dir} is a file.`);
        const entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 200);
        const lines = entries.map((entry) => {
          if (entry.isDirectory()) return `📁 ${entry.name}/`;
          try {
            const stat = fs.statSync(path.join(dir, entry.name));
            return `📄 ${entry.name} (${humanBytes(stat.size)})`;
          } catch { return `📄 ${entry.name}`; }
        });
        return `${dir}\n${lines.join('\n') || '(empty)'}`;
      },
    },
    {
      name: 'find_files', level: 'safe', label: 'Find files',
      description: 'Search the home folder for files by name.',
      params: {
        query: { type: 'string', description: 'Name or part of the name', required: true },
        path: { type: 'string', description: 'Where to search (default: home)' },
      },
      async run({ query, path: start }) {
        const root = start ? resolveUserPath(start, config, { mustExist: true }) : os.homedir();
        const { stdout } = await run('find', [root, '-maxdepth', '6', '-iname', `*${String(query).replace(/[^\w.\- *]/g, '')}*`,
          '-not', '-path', '*/.*', '-printf', '%p\n'], { timeout: 20_000 }).catch(() => ({ stdout: '' }));
        const found = stdout.split('\n').filter(Boolean).slice(0, 40);
        return found.length ? `${found.length} match(es):\n${found.join('\n')}` : `No files matching "${query}" under ${root}.`;
      },
    },
    {
      name: 'read_file', level: 'safe', label: 'Read a file',
      description: 'Read a text file inside the owner\'s home.',
      params: { path: { type: 'string', required: true }, max_bytes: { type: 'number', description: 'Default 8000' } },
      async run({ path: target, max_bytes }) {
        const file = resolveUserPath(target, config, { mustExist: true });
        const limit = Math.max(200, Math.min(64_000, Number(max_bytes) || 8000));
        const stat = fs.statSync(file);
        if (stat.isDirectory()) throw new Error('That is a folder — use list_dir.');
        if (stat.size > 8 * 1024 * 1024) throw new Error('File is larger than 8 MB.');
        const buffer = fs.readFileSync(file);
        if (buffer.includes(0)) throw new Error('That looks like a binary file.');
        return shorten(buffer.toString('utf8').slice(0, limit));
      },
    },
    {
      name: 'write_file', level: 'standard', label: 'Write a file',
      description: 'Create or overwrite a text file inside the owner\'s home. Existing files are backed up first.',
      params: {
        path: { type: 'string', required: true },
        content: { type: 'string', required: true },
      },
      async run({ path: target, content }) {
        const file = resolveUserPath(target, config);
        if (fs.existsSync(file) && fs.statSync(file).isDirectory()) throw new Error('That is a folder.');
        if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.psd-backup-${Date.now()}`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, String(content ?? ''), 'utf8');
        return `Wrote ${humanBytes(Buffer.byteLength(String(content ?? '')))} to ${file}.`;
      },
    },
    {
      name: 'clipboard_write', level: 'standard', label: 'Copy to clipboard',
      description: 'Put text on the GNOME clipboard.',
      params: { text: { type: 'string', required: true } },
      async run({ text }) {
        if (!(await which('wl-copy'))) throw new Error('wl-clipboard is missing (sudo dnf install wl-clipboard).');
        await run('wl-copy', [String(text ?? '')], { timeout: 8000 });
        return 'Copied to clipboard.';
      },
    },
    {
      name: 'clipboard_read', level: 'standard', label: 'Read the clipboard',
      description: 'Read the current clipboard text.',
      params: {},
      async run() {
        if (!(await which('wl-paste'))) throw new Error('wl-clipboard is missing (sudo dnf install wl-clipboard).');
        const { stdout } = await run('wl-paste', ['--no-newline'], { timeout: 8000 });
        return stdout ? shorten(stdout, 4000) : '(clipboard is empty or holds an image)';
      },
    },

    // ── Shell (opt-in, PIN-gated) ────────────────────────────────────────────
    {
      name: 'shell', level: 'full', label: 'Run a shell command', requiresShell: true, destructive: true,
      description: 'Run a bash command on the PC. Only available when PSD_SHELL=true and the owner approves it.',
      params: { command: { type: 'string', required: true }, cwd: { type: 'string' } },
      async run({ command, cwd }) {
        const workdir = cwd ? resolveUserPath(cwd, config, { mustExist: true }) : os.homedir();
        const { stdout, stderr } = await run('bash', ['-lc', String(command).slice(0, 4000)], { timeout: 60_000, cwd: workdir });
        return shorten([stdout.trim(), stderr.trim()].filter(Boolean).join('\n') || '(no output)');
      },
    },

    // ── Web & research ──────────────────────────────────────────────────────
    {
      name: 'web_search', level: 'safe', label: 'Search the web',
      description: 'Search the web and get titles, URLs and snippets. Use this instead of guessing facts.',
      params: { query: { type: 'string', required: true }, limit: { type: 'number', description: 'Default 5' } },
      async run({ query, limit }) {
        const count = Math.max(1, Math.min(10, Number(limit) || 5));
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(String(query))}`;
        const res = await fetch(url, {
          headers: { 'user-agent': 'Mozilla/5.0 (X11; Fedora; Linux x86_64) PSD/1.0', accept: 'text/html' },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`Search failed (${res.status}).`);
        const html = await res.text();
        const blocks = html.split(/class="result results_links/).slice(1, count + 1);
        const results = blocks.map((block) => {
          const title = stripHtml(block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '');
          const link = block.match(/class="result__a"[^>]*href="([^"]+)"/)?.[1] ?? '';
          const clean = link.startsWith('//duckduckgo.com/l/?uddg=')
            ? decodeURIComponent(link.split('uddg=')[1].split('&')[0])
            : link;
          const snippet = stripHtml(block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '');
          return title ? `• ${title}\n  ${clean}\n  ${snippet.slice(0, 220)}` : '';
        }).filter(Boolean);
        return results.length ? results.join('\n') : `No results for "${query}".`;
      },
    },
    {
      name: 'read_url', level: 'safe', label: 'Read a web page',
      description: 'Fetch a web page and return its readable text.',
      params: { url: { type: 'string', required: true }, max_chars: { type: 'number', description: 'Default 6000' } },
      async run({ url, max_chars }) {
        const target = String(url ?? '').trim();
        if (!/^https?:\/\//i.test(target)) throw new Error('Only http(s) URLs can be read.');
        const res = await fetch(target, {
          headers: { 'user-agent': 'Mozilla/5.0 (X11; Fedora; Linux x86_64) PSD/1.0' },
          redirect: 'follow', signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${target}`);
        const type = res.headers.get('content-type') || '';
        const raw = await res.text();
        if (type.includes('json')) return shorten(raw, Number(max_chars) || 6000);
        return shorten(stripHtml(raw), Math.max(500, Math.min(30_000, Number(max_chars) || 6000)));
      },
    },

    // ── Memory ──────────────────────────────────────────────────────────────
    {
      name: 'remember', level: 'safe', label: 'Remember a fact',
      description: 'Store a durable fact or preference about the owner (name, city, preferred editor, project paths…).',
      params: {
        key: { type: 'string', description: 'Short slot name, e.g. "preferred browser"', required: true },
        value: { type: 'string', description: 'The fact', required: true },
      },
      async run({ key, value }) {
        memory.remember(String(key), String(value));
        return `Remembered ${key} = ${value}.`;
      },
    },
    {
      name: 'recall', level: 'safe', label: 'Recall a fact',
      description: 'Look up what PSD remembers about the owner.',
      params: { query: { type: 'string', description: 'Empty = everything' } },
      async run({ query }) {
        return memory.recall(String(query ?? ''));
      },
    },
    {
      name: 'remind', level: 'safe', label: 'Set a reminder',
      description: 'Set a reminder. `when` accepts "10m", "2h", "18:30", or an ISO date. PSD notifies the PC, the notch and WhatsApp.',
      params: {
        text: { type: 'string', required: true },
        when: { type: 'string', description: 'e.g. 25m, 2h, 18:30, 2026-11-06T09:00', required: true },
      },
      async run({ text, when }) {
        const at = parseWhen(when);
        if (!at) throw new Error('Could not read that time. Use 25m, 2h, 18:30 or an ISO timestamp.');
        const id = memory.addReminder(String(text), at);
        return `Reminder set for ${new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} (${id.slice(0, 6)}): ${text}`;
      },
    },
    {
      name: 'list_reminders', level: 'safe', label: 'List reminders',
      description: 'List pending reminders.',
      params: {},
      async run() {
        const list = memory.reminders();
        if (!list.length) return 'No reminders pending.';
        return list.map((r) => `• ${new Date(r.at).toLocaleString('en-IN')} — ${r.text}`).join('\n');
      },
    },

    // ── PSD surfaces (notch, WhatsApp) ──────────────────────────────────────
    {
      name: 'notch_show', level: 'safe', label: 'Show something in the notch',
      description: 'Push a short message into the GNOME notch: title, body, and an optional tab to open (chat, system, music, alerts).',
      params: {
        title: { type: 'string', required: true },
        body: { type: 'string' },
        tab: { type: 'string', description: 'chat|system|music|alerts' },
        open: { type: 'boolean', description: 'Expand the notch now' },
      },
      async run({ title, body = '', tab, open }) {
        const delivered = await notch.show({ title: String(title), body: String(body), tab, open: Boolean(open) });
        return delivered ? 'Shown in the notch.' : 'The notch is not running; the message was queued for when it opens.';
      },
    },
    {
      name: 'notch_state', level: 'safe', label: 'Read the notch state',
      description: 'Read what the notch currently displays (tab, expanded, track, unread alerts).',
      params: {},
      async run() {
        const state = await notch.state();
        return state ? JSON.stringify(state) : 'The notch extension is not answering on the session bus.';
      },
    },
    {
      name: 'whatsapp_send', level: 'standard', label: 'Message the owner on WhatsApp',
      description: 'Send a WhatsApp message to the owner through the linked agent. Only the owner can be messaged.',
      params: { text: { type: 'string', required: true } },
      async run({ text }) {
        const result = await whatsapp.send(String(text));
        return result.ok ? 'Sent to the owner on WhatsApp.' : `WhatsApp not sent: ${result.error}`;
      },
    },
  ];

  const byName = new Map(registry.map((tool) => [tool.name, tool]));

  /**
   * The advertised list. A tool above the current access level is still shown,
   * because hiding it makes the model hallucinate alternatives; it is simply
   * refused at execute time with the reason.
   */
  function schemas() {
    return registry
      .filter((tool) => !tool.requiresShell || config.shell)
      .map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: `${tool.description}${tool.destructive ? ' (asks the owner to confirm)' : ''}${LEVELS[tool.level] > LEVELS[level()] ? ` (needs PSD_ACCESS=${tool.level})` : ''}`,
          parameters: {
            type: 'object',
            properties: Object.fromEntries(Object.entries(tool.params ?? {}).map(([key, schema]) => {
              const { required, ...rest } = schema;
              return [key, rest];
            })),
            required: Object.entries(tool.params ?? {}).filter(([, schema]) => schema.required).map(([key]) => key),
            additionalProperties: false,
          },
        },
      }));
  }

  /** OpenAI/ollama style flat list for models that prefer the older shape. */
  function flatSchemas() {
    return schemas().map((entry) => ({ name: entry.function.name, description: entry.function.description, parameters: entry.function.parameters }));
  }

  async function execute(name, args = {}, ctx = {}) {
    const tool = byName.get(name);
    if (!tool) return { ok: false, name, text: `Unknown tool "${name}".` };
    if (LEVELS[tool.level] > LEVELS[level()]) {
      return { ok: false, name, text: `"${tool.label ?? name}" needs PSD_ACCESS=${tool.level} (currently ${level()}).` };
    }
    if (tool.requiresShell && !config.shell) {
      return { ok: false, name, text: 'Shell is off. Set PSD_SHELL=true and PSD_SHELL_PIN=<pin> to enable it.' };
    }
    if (tool.destructive && !ctx.confirmed) {
      const parked = pending.park(name, args);
      return { ok: false, name, needsConfirmation: true, approvalId: parked.id, text: parked.text };
    }
    const started = Date.now();
    try {
      const result = await Promise.race([
        tool.run(args ?? {}, ctx),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`"${name}" did not finish within ${config.toolTimeoutMs}ms`)), config.toolTimeoutMs)),
      ]);
      const ms = Date.now() - started;
      if (typeof result === 'string') return { ok: true, name, text: result, ms };
      if (result && typeof result === 'object') return { ok: true, name, text: result.text ?? '', ms, ...result, name };
      return { ok: true, name, text: String(result ?? 'Done.'), ms };
    } catch (err) {
      return { ok: false, name, text: err.message, ms: Date.now() - started };
    }
  }

  async function approve(id) {
    const item = pending.take(id);
    return execute(item.name, item.args, { confirmed: true, source: 'approval' });
  }

  return {
    registry, schemas, flatSchemas, execute, approve,
    pending, level,
    byName,
    describe: describeAction,
    accessReport: () => ({
      level: level(),
      tools: registry.length,
      byLevel: registry.reduce((acc, tool) => { acc[tool.level] = (acc[tool.level] ?? 0) + 1; return acc; }, {}),
      shell: config.shell,
      pending: pending.list().length,
    }),
  };
}

/**
 * Turn what a person types into an epoch timestamp.
 *
 * Accepts, case- and space-insensitively:
 *   "25m" "2h" "3 days"          relative, abbreviated or spelled out
 *   "in 10 minutes" "after 2 hrs"
 *   "18:30" "6:30pm" "at 6:30"   clock time (rolls to tomorrow if already past)
 *   "tomorrow 9am" "today 6pm"   day word + time
 *   "noon" "midnight"            named times
 *   ISO timestamps and anything Date.parse understands
 *
 * Why this is explicit rather than delegated to Date.parse: Date.parse handles
 * `25m` and `18:30` (via the two branches above) but quietly returns NaN for
 * "10 minutes", "2 hours" and "tomorrow 9am" — the exact phrasings people use
 * when setting a reminder from the notch. It also parses a bare "6:30" as a time
 * *today*, silently in the past, so clock times are handled here instead.
 *
 * @returns {number|null} ms since epoch, or null when it cannot be read
 */
export function parseWhen(input) {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return null;

  // Strip the filler words people add without thinking.
  const text = raw
    .replace(/^(?:in|after|at|by|on)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;

  const UNIT_MS = {
    s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
    m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
    h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
    d: 86_400_000, day: 86_400_000, days: 86_400_000,
  };
  const AMOUNT = '\\d+(?:\\.\\d+)?';
  const UNIT = '(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)';

  // ── relative: "25m", "10 minutes", "1.5 hours" ───────────────────────────
  const rel = text.match(new RegExp(`^${AMOUNT}\\s*${UNIT}$`));
  if (rel) {
    const n = Number(text.match(new RegExp(`^(${AMOUNT})`))[1]);
    const ms = UNIT_MS[rel[1]];
    if (!ms) return null;
    return Date.now() + n * ms;
  }

  // ── a day word, optionally followed by a time: "tomorrow 9am", "today 18:00" ──
  const dayWord = text.match(/^(today|tonight|tomorrow|tmrw|tmw)\b\s*(.*)$/);
  if (dayWord) {
    const rest = dayWord[2].trim();
    const base = new Date();
    if (dayWord[1] === 'tomorrow' || dayWord[1] === 'tmrw' || dayWord[1] === 'tmw')
      base.setDate(base.getDate() + 1);
    const time = rest ? clockParts(rest) : null;
    if (rest && !time) return null;
    if (time) {
      base.setHours(time.hours, time.minutes, 0, 0);
      if (dayWord[1] === 'tonight' && time.hours < 12) base.setHours(time.hours + 12);
      return base.getTime();
    }
    // No time given: "tomorrow" means 9am, "tonight" means 8pm, "today" means now.
    if (dayWord[1] === 'tonight') base.setHours(20, 0, 0, 0);
    else if (dayWord[1] !== 'today') base.setHours(9, 0, 0, 0);
    return base.getTime();
  }

  // ── named times ──────────────────────────────────────────────────────────
  if (text === 'noon' || text === 'midday') return nextClock(12, 0);
  if (text === 'midnight') return nextClock(0, 0);
  if (text === 'morning') return nextClock(9, 0);
  if (text === 'evening') return nextClock(20, 0);

  // ── clock time: "18:30", "6:30pm", "6pm", "6:30 pm" ──────────────────────
  const time = clockParts(text);
  if (time) return nextClock(time.hours, time.minutes);

  // ── anything else: let the platform try (ISO dates, "2026-11-06 09:00") ──
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;

  /** "6:30pm" / "18:30" / "6 pm" → {hours, minutes} in 24h, or null. */
  function clockParts(value) {
    const match = String(value).trim()
      .match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (!match) return null;
    let hours = Number(match[1]);
    const minutes = Number(match[2] ?? 0);
    const meridiem = match[3]?.toLowerCase();
    if (minutes > 59) return null;
    if (meridiem) {
      if (hours < 1 || hours > 12) return null;
      if (meridiem === 'pm' && hours !== 12) hours += 12;
      if (meridiem === 'am' && hours === 12) hours = 0;
    } else if (hours > 23) {
      return null;
    }
    return {hours, minutes};
  }

  /**
   * A bare clock time means "the next time it is that o'clock" — setting a
   * reminder for 6:30 at 7pm should ring tomorrow morning, not an hour ago.
   */
  function nextClock(hours, minutes) {
    const now = new Date();
    const at = new Date(now);
    at.setHours(hours, minutes, 0, 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at.getTime();
  }
}
