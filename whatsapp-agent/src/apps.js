// apps.js — find and launch ANY installed desktop app (not just a fixed
// allowlist), and manage its windows.
//
// Linux desktops describe apps with .desktop files. We read the standard
// locations (user, system, Flatpak, Snap) and match what the owner types in
// Hinglish/English ("chrome kholo", "open vs code", "band karo spotify").
//
// Launching always goes through execFile/spawn with an argv array — never a
// shell string — so an app name from WhatsApp cannot smuggle shell syntax.
// Commands are taken only from the trusted .desktop files on disk.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { displayEnv, findBin } from './pccontrol.js';

const execFileAsync = promisify(execFile);
const RUN_TIMEOUT = 8_000;

/** Split an Exec= line into argv, honouring quotes and backslash escapes. */
export function splitExec(exec) {
  const out = [];
  let current = '';
  let quote = null;
  let had = false;
  for (let i = 0; i < String(exec ?? '').length; i++) {
    const ch = exec[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === '\\' && i + 1 < exec.length) { current += exec[++i]; continue; }
      current += ch;
      had = true;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; had = true; continue; }
    if (ch === '\\' && i + 1 < exec.length) { current += exec[++i]; had = true; continue; }
    if (/\s/.test(ch)) {
      if (had) { out.push(current); current = ''; had = false; }
      continue;
    }
    current += ch;
    had = true;
  }
  if (had) out.push(current);
  // Drop desktop-entry field codes (%u %f %F %U %i %c %k …).
  const cleaned = out.filter((part) => !/^%[a-zA-Z]$/.test(part));
  // `env VAR=value prog args` → prog args
  if (cleaned[0] === 'env') {
    let idx = 1;
    while (idx < cleaned.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(cleaned[idx])) idx++;
    return cleaned.slice(idx);
  }
  return cleaned;
}

/** Parse a .desktop file. Returns null for non-app / hidden entries. */
export function parseDesktopEntry(text) {
  const entry = {};
  let group = '';
  let inDesktop = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      group = trimmed.slice(1, -1);
      inDesktop = group === 'Desktop Entry';
      continue;
    }
    if (!inDesktop) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    entry[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  if (!entry.Type || entry.Type !== 'Application') return null;
  if (/^(true|1)$/i.test(entry.NoDisplay ?? '') || /^(true|1)$/i.test(entry.Hidden ?? '')) return null;
  if (!entry.Exec) return null;
  // Only English names are used to keep matching predictable.
  const name = entry.Name;
  if (!name) return null;
  return {
    name,
    comment: entry.Comment ?? '',
    exec: entry.Exec,
    icon: entry.Icon ?? '',
    terminal: /^(true|1)$/i.test(entry.Terminal ?? ''),
    categories: entry.Categories ?? '',
    wmClass: entry.StartupWMClass ?? '',
    keywords: entry.Keywords ?? '',
  };
}

/** Standard application directories, most-specific first. */
export function appDirs(env = process.env) {
  const home = os.homedir();
  const xdgData = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return [
    path.join(xdgData, 'applications'),
    path.join(home, '.local', 'share', 'flatpak', 'exports', 'share', 'applications'),
    '/var/lib/flatpak/exports/share/applications',
    '/var/lib/snapd/desktop/applications',
    ...(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean).map((d) => path.join(d, 'applications')),
  ];
}

let cache = { at: 0, apps: [] };

/** All launchable desktop apps. Cached for 60 s (installs are rare, /apps is not). */
export function discoverApps({ dirs = appDirs(), force = false } = {}) {
  if (!force && Date.now() - cache.at < 60_000) return cache.apps;
  const seen = new Set();
  const apps = [];
  for (const dir of dirs) {
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith('.desktop')) continue;
      const id = file.replace(/\.desktop$/, '');
      if (seen.has(id)) continue;
      let parsed;
      try { parsed = parseDesktopEntry(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      if (!parsed) continue;
      seen.add(id);
      apps.push({ id, ...parsed });
    }
  }
  apps.sort((a, b) => a.name.localeCompare(b.name));
  cache = { at: Date.now(), apps };
  return apps;
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Match a free-text app name ("vs code", "chrome") against installed apps. */
export function matchApp(query, apps = discoverApps()) {
  const q = norm(query);
  if (!q) return null;
  const qTokens = q.split(' ').filter(Boolean);
  let best = null;
  for (const app of apps) {
    const name = norm(app.name);
    const id = norm(app.id);
    const keywords = norm(app.keywords);
    let score = 0;
    if (name === q || id === q) score = 100;
    else if (name.startsWith(q) || id.startsWith(q)) score = 80;
    else if (name.includes(q) || id.includes(q)) score = 60;
    else if (qTokens.length && qTokens.every((t) => name.includes(t) || id.includes(t) || keywords.includes(t))) score = 40;
    else {
      // "code" should still find "Visual Studio Code"
      const nameTokens = name.split(' ');
      if (qTokens.some((t) => t.length >= 3 && nameTokens.some((n) => n.startsWith(t)))) score = 20;
    }
    if (score > (best?.score ?? 0)) best = { app, score };
  }
  return best ? best.app : null;
}

/** Best-effort list for /apps: drops duplicates by name and CLI-only noise. */
export function appList(apps = discoverApps(), limit = 80) {
  const seen = new Set();
  const out = [];
  for (const app of apps) {
    const key = app.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(app);
    if (out.length >= limit) break;
  }
  return out;
}

async function tryLaunch(argv) {
  if (!argv?.length) throw new Error('empty command');
  await new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      detached: true,
      stdio: 'ignore',
      env: displayEnv(),
    });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

/**
 * Launch an installed app by name. Tries the trusted .desktop file first
 * (gtk-launch, works on GNOME + KDE), then its Exec line, then a binary of
 * the same name if the user typed an exact command.
 */
export async function launchApp(query) {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) throw new Error('usage: /open <app name>  (e.g. /open chrome, /open vs code)');
  if (/[;&|`$><\n]/.test(trimmed)) throw new Error('App names cannot contain shell characters.');
  if (!/^https?:\/\//i.test(trimmed)) {
    const app = matchApp(trimmed);
    if (app) {
      const launcher = findBin('gtk-launch');
      if (launcher) {
        try {
          await tryLaunch([launcher, app.id]);
          return { text: `🚀 Opened *${app.name}* on the PC.`, app: app.name };
        } catch { /* fall through to Exec */ }
      }
      const argv = splitExec(app.exec);
      if (argv.length) {
        const bin = findBin(argv[0]) ?? (path.isAbsolute(argv[0]) && fs.existsSync(argv[0]) ? argv[0] : null);
        if (bin) {
          await tryLaunch([bin, ...argv.slice(1)]);
          return { text: `🚀 Opened *${app.name}* on the PC.`, app: app.name };
        }
      }
      if (app.terminal) {
        // Terminal apps need a terminal emulator; gtk-launch handles this on a
        // real desktop, so reaching here means the desktop is missing.
        throw new Error(`${app.name} is a terminal app and no app launcher worked. Install gtk-launch/desktop integration.`);
      }
      throw new Error(`Found *${app.name}* but couldn't start it (its command is missing on this PC).`);
    }
  }
  // Exact binary fallback (e.g. "firefox" where no .desktop file exists).
  const direct = findBin(trimmed.split(/\s+/)[0]);
  if (direct && /^[\w.+-]+$/.test(trimmed)) {
    await tryLaunch([direct]);
    return { text: `🚀 Launched \`${trimmed}\` on the PC.`, app: trimmed };
  }
  const apps = appList(discoverApps(), 12).map((a) => `• ${a.name}`).join('\n');
  throw new Error(`I couldn't find an app called "${trimmed}". /apps shows what's installed. A few:\n${apps}`);
}

/** Read `wmctrl -l` output → [{id, desktop, host, title}]. */
export function parseWmctrl(text) {
  return String(text ?? '').split(/\r?\n/).map((line) => {
    const m = line.match(/^(0x[0-9a-f]+)\s+(-?\d+)\s+(\S+)\s+(.*)$/i);
    return m ? { id: m[1], desktop: Number(m[2]), host: m[3], title: m[4].trim() } : null;
  }).filter(Boolean);
}

export async function listWindows() {
  if (!findBin('wmctrl')) {
    throw new Error('Window control needs wmctrl: sudo dnf install wmctrl (works on X11; GNOME Wayland blocks listing). Everything else works without it.');
  }
  const { stdout } = await execFileAsync('wmctrl', ['-l'], { timeout: RUN_TIMEOUT, env: displayEnv() });
  const windows = parseWmctrl(stdout).filter((w) => w.title && w.title !== 'N/A');
  if (!windows.length) return '🪟 No named windows found.';
  return '🪟 *Open windows*\n\n' + windows.map((w, i) => `${i + 1}. ${w.title}`).join('\n') +
    '\n\nFocus one: /focus <part of title> · close: /close window <part of title>';
}

export async function windowAction(action, title) {
  const query = String(title ?? '').trim();
  if (!query) throw new Error('usage: /focus <part of a window title>');
  if (!findBin('wmctrl')) throw new Error('Window control needs wmctrl: sudo dnf install wmctrl');
  if (action === 'focus') {
    await execFileAsync('wmctrl', ['-a', query], { timeout: RUN_TIMEOUT, env: displayEnv() });
    return `🪟 Focused the window matching "${query}".`;
  }
  if (action === 'close') {
    await execFileAsync('wmctrl', ['-c', query], { timeout: RUN_TIMEOUT, env: displayEnv() });
    return `🪟 Asked the window matching "${query}" to close.`;
  }
  throw new Error(`unknown window action ${action}`);
}

/**
 * Close an app: ask its window to close (graceful, via wmctrl) and only then
 * fall back to SIGTERM on matching processes. Owner-only chat still gets a
 * confirmation prompt before this runs (see actions.js).
 */
export async function closeApp(query) {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) throw new Error('usage: /close <app name>');
  const app = matchApp(trimmed);
  const label = app?.name ?? trimmed;
  const windowTitles = [app?.name, app?.wmClass].filter(Boolean);

  if (findBin('wmctrl')) {
    for (const title of windowTitles) {
      try {
        await execFileAsync('wmctrl', ['-c', title], { timeout: RUN_TIMEOUT, env: displayEnv() });
        return `🪟 Asked *${label}* to close (window close request — saves its work if it can).`;
      } catch { /* try next */ }
    }
  }

  const argv = app ? splitExec(app.exec) : [trimmed];
  const binName = argv[0] ? path.basename(argv[0]) : trimmed;
  if (!/^[\w.+-]+$/.test(binName)) throw new Error(`I couldn't identify "${trimmed}" as a running app. /windows lists open windows.`);
  const pgrep = findBin('pgrep');
  if (!pgrep) throw new Error('Closing apps needs pgrep: sudo dnf install procps-ng');
  const out = await execFileAsync(pgrep, ['-f', '--', binName], { timeout: RUN_TIMEOUT }).then((r) => r.stdout).catch(() => '');
  const pids = out.split('\n').map((s) => Number.parseInt(s, 10)).filter((n) => Number.isFinite(n) && n > 1 && n !== process.pid);
  if (!pids.length) return `🔎 *${label}* doesn't look like it's running.`;
  let killed = 0;
  for (const pid of pids.slice(0, 8)) {
    try { process.kill(pid, 'SIGTERM'); killed++; } catch { /* gone */ }
  }
  return `🛑 Asked ${killed} *${label}* process(es) to quit.`;
}
