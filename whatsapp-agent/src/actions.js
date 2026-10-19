// actions.js — ONE registry of everything the agent can do on the PC.
//
// It is the single source of truth for three callers:
//   • slash commands in commands.js           (/open, /wifi, /zip …)
//   • offline intents in nlp.js               ("chrome kholo", "wifi off")
//   • the AI tool-calling loop in agentloop.js ("plan my trip and download
//     the tickets into ~/Documents")
//
// Every action declares its permission level (safe / standard / full) and
// whether it is destructive. Destructive actions never run straight away: the
// registry parks them in store.data.pending and the owner has to confirm with
// "haan"/"yes" (or /yes) within two minutes. Shell is separately gated by
// ALLOW_SHELL + SHELL_PIN because it is the one action that can undo anything.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as pc from './pccontrol.js';
import * as apps from './apps.js';
import * as files from './files.js';
import * as systemx from './systemx.js';
import * as ocr from './ocr.js';
import * as finder from './elementfinder.js';
import * as tools from './tools.js';
import { runDoctor } from './doctor.js';

const execFileAsync = promisify(execFile);
const LEVELS = { safe: 0, standard: 1, full: 2 };
const MAX_OUT = 3500;

const clampPct = (v) => Math.min(Math.max(Number.parseInt(v, 10) || 0, 0), 100);
const short = (v, n = 60) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/** Human one-liner shown before a destructive action. */
function describe(entry, args) {
  if (entry.confirmText) return entry.confirmText(args);
  const bits = Object.entries(args ?? {}).filter(([, v]) => v !== undefined && v !== '');
  return `${entry.label ?? entry.name} ${bits.map(([k, v]) => `${k}=${short(v)}`).join(' ')}`.trim();
}

export function createActions({ config, store, log = console }) {
  const extraRoots = config.filesExtraRoots ?? [];
  const level = () => (config.accessLevel in LEVELS ? config.accessLevel : 'full');
  const audioAction = (w) => {
    const word = String(w ?? '').toLowerCase();
    if (['up', '+', 'increase', 'raise', 'badhao', 'badha'].includes(word)) return 'up';
    if (['down', '-', 'decrease', 'lower', 'kam'].includes(word)) return 'down';
    if (['mute', 'unmute', 'toggle'].includes(word)) return 'mute';
    return 'get';
  };

  const registry = [
    // ── apps & windows ──────────────────────────────────────────────────────
    {
      name: 'list_apps', level: 'safe', label: 'List installed apps',
      description: 'List installed desktop applications on the PC.',
      params: {},
      run: async () => {
        const list = apps.appList(apps.discoverApps(), 120);
        if (!list.length) return 'No .desktop applications found. (Is this a server without a desktop?)';
        return `🚀 *Installed apps (${list.length})*\n\n${list.map((a) => `• ${a.name}`).join('\n')}\n\nOpen one: /open <name>`;
      },
    },
    {
      name: 'open_app', level: 'standard', label: 'Open app',
      description: 'Open/launch an installed application by name, e.g. "chrome", "vs code", "spotify". Also accepts a URL.',
      params: { app: { type: 'string', description: 'App name, or a URL to open in the browser', required: true } },
      confirmText: ({ app }) => `Open “${app}” on the PC`,
      run: async ({ app }) => {
        if (/^https?:\/\//i.test(String(app ?? '').trim())) return pc.openTarget(String(app).trim());
        return (await apps.launchApp(app)).text;
      },
    },
    {
      name: 'close_app', level: 'standard', destructive: true, label: 'Close app',
      description: 'Close/quit a running application (may lose unsaved work; owner confirms first).',
      params: { app: { type: 'string', description: 'App name or window title', required: true } },
      confirmText: ({ app }) => `Close “${app}” (unsaved work could be lost)`,
      run: async ({ app }) => apps.closeApp(app),
    },
    {
      name: 'list_windows', level: 'safe', label: 'List windows',
      description: 'List open windows on the desktop (X11).',
      params: {},
      run: async () => apps.listWindows(),
    },
    {
      name: 'focus_window', level: 'standard', label: 'Focus window',
      description: 'Bring a window to the front by (part of) its title.',
      params: { title: { type: 'string', description: 'Part of the window title', required: true } },
      run: async ({ title }) => apps.windowAction('focus', title),
    },

    // ── screen ──────────────────────────────────────────────────────────────
    {
      name: 'screenshot', level: 'safe', label: 'Screenshot',
      description: 'Capture the PC screen and send it to the owner as an image.',
      params: {},
      run: async () => {
        const image = await pc.captureScreenshot({ portalTimeoutMs: config.portalTimeoutMs });
        return { image, text: `🖥️ Screenshot · ${new Date().toLocaleTimeString('en-IN', { timeZone: config.timezone ?? 'Asia/Kolkata' })}` };
      },
    },
    {
      name: 'look_at_screen', level: 'standard', label: 'Look at screen',
      description: 'Take a screenshot, OCR it and answer a question about what is on the screen right now. Use for "what is on my screen", "read this error", "summarise this page".',
      params: { question: { type: 'string', description: 'What to answer about the screen (optional)' } },
      run: async ({ question }) => ocr.lookAtScreen(config, question ?? '', log),
    },
    {
      name: 'ocr_screen', level: 'standard', label: 'OCR screen',
      description: 'Return the raw text OCR can read on the screen (no AI).',
      params: {},
      run: async () => {
        const { text } = await ocr.ocrScreen(config);
        return text
          ? `🔎 *Text on screen*\n\`\`\`\n${text.slice(0, 3000)}${text.length > 3000 ? '\n…' : ''}\n\`\`\``
          : '🔎 I couldn\'t read any text on the screen.';
      },
    },

    // ── sound / display / media ─────────────────────────────────────────────
    {
      name: 'volume', level: 'safe', label: 'Volume',
      description: 'Get or set the PC volume, or mute it.',
      params: {
        action: { type: 'string', enum: ['get', 'set', 'up', 'down', 'mute'], description: 'What to do (default get)' },
        value: { type: 'number', description: 'Percent 0-100 when action=set' },
      },
      run: async ({ action, value }) => pc.volume(audioAction(action ?? 'get'), value == null ? undefined : clampPct(value)),
    },
    {
      name: 'brightness', level: 'safe', label: 'Brightness',
      description: 'Get or set the screen brightness.',
      params: {
        action: { type: 'string', enum: ['get', 'set', 'up', 'down'], description: 'What to do (default get)' },
        value: { type: 'number', description: 'Percent 0-100 when action=set' },
      },
      run: async ({ action, value }) => {
        const act = audioAction(action ?? 'get');
        return pc.brightness(act === 'mute' ? 'get' : act, value == null ? undefined : clampPct(value));
      },
    },
    {
      name: 'media', level: 'safe', label: 'Media',
      description: 'Control the PC music/video player over MPRIS (play, pause, next, prev, stop, status).',
      params: { action: { type: 'string', enum: ['play', 'pause', 'toggle', 'next', 'prev', 'stop', 'status'], required: true } },
      run: async ({ action }) => {
        const act = String(action ?? 'status').toLowerCase();
        const map = { previous: 'prev', resume: 'play' };
        const allowed = ['play', 'pause', 'toggle', 'next', 'prev', 'stop', 'status'];
        if (!allowed.includes(map[act] ?? act)) throw new Error('usage: play|pause|next|prev|stop|status');
        return pc.media(map[act] ?? act);
      },
    },
    {
      name: 'notify', level: 'safe', label: 'Desktop notification',
      description: 'Show a desktop notification on the PC.',
      params: { text: { type: 'string', description: 'Notification text', required: true } },
      run: async ({ text }) => systemx.notify(text),
    },
    {
      name: 'lock_screen', level: 'safe', label: 'Lock screen',
      description: 'Lock the PC session.',
      params: {},
      run: async () => pc.lockSession(),
    },
    {
      name: 'clipboard_get', level: 'safe', label: 'Read clipboard',
      description: 'Read the PC clipboard text.',
      params: {},
      run: async () => pc.clipboardGet(),
    },
    {
      name: 'clipboard_set', level: 'safe', label: 'Write clipboard',
      description: 'Copy text to the PC clipboard.',
      params: { text: { type: 'string', description: 'Text to copy', required: true } },
      run: async ({ text }) => pc.clipboardSet(text),
    },

    // ── network ─────────────────────────────────────────────────────────────
    {
      name: 'wifi', level: 'standard', label: 'Wi-Fi',
      description: 'Check, turn on/off, list or join Wi-Fi networks.',
      params: {
        action: { type: 'string', enum: ['status', 'on', 'off', 'list', 'connect'], required: true },
        ssid: { type: 'string', description: 'Network name when action=connect' },
        password: { type: 'string', description: 'Network password when action=connect' },
      },
      run: async ({ action, ssid, password }) => {
        const act = String(action ?? 'status').toLowerCase();
        if (act === 'connect') return systemx.wifiConnect(ssid, password);
        if (act === 'status') return systemx.wifiStatus();
        return systemx.wifiSet(act);
      },
    },
    {
      name: 'bluetooth', level: 'standard', label: 'Bluetooth',
      description: 'Check, turn on/off Bluetooth.',
      params: { action: { type: 'string', enum: ['status', 'on', 'off'], required: true } },
      run: async ({ action }) => {
        const act = String(action ?? 'status').toLowerCase();
        return act === 'status' ? systemx.bluetoothStatus() : systemx.bluetoothSet(act);
      },
    },
    {
      name: 'network_info', level: 'safe', label: 'Network info',
      description: 'LAN IP addresses and hostname of the PC.',
      params: {},
      run: async () => {
        const nets = Object.entries(os.networkInterfaces())
          .flatMap(([name, list]) => (list ?? []).map((n) => ({ name, ...n })))
          .filter((n) => n.family === 'IPv4' && !n.internal);
        return `🌐 *${os.hostname()}*\n${nets.map((n) => `• ${n.name}: \`${n.address}\``).join('\n') || 'No LAN IPv4 address.'}`;
      },
    },

    // ── system ──────────────────────────────────────────────────────────────
    {
      name: 'doctor', level: 'safe', label: 'Diagnose the PC',
      description: 'Self-check: is the screenshot, keyboard/mouse, OCR, AI and every required tool working? Explains each failure with the exact fix command.',
      params: {},
      run: async (_args, ctx = {}) => runDoctor({ config, ctx, log }),
    },
    {
      name: 'system_status', level: 'safe', label: 'System status',
      description: 'CPU/RAM/disk/uptime/battery summary of the PC.',
      params: {},
      run: async () => `${tools.systemInfo(store.data.stats.startedAt)}\n${await systemx.audioStatus()}`,
    },
    {
      name: 'disk_space', level: 'safe', label: 'Disk space',
      description: 'Free and total disk space.',
      params: {},
      run: async () => {
        const s = fs.statfsSync(config.dataDir);
        const total = s.blocks * s.bsize;
        const free = s.bavail * s.bsize;
        return `💾 Disk: *${(free / 1024 ** 3).toFixed(1)} GB free* of ${(total / 1024 ** 3).toFixed(1)} GB (${Math.round(((total - free) / total) * 100)}% used)`;
      },
    },
    {
      name: 'battery', level: 'safe', label: 'Battery',
      description: 'Battery percentage/status of the PC.',
      params: {},
      run: async () => tools.batteryStatus() ?? '🔌 No battery found — this PC/VM reports none (normal for desktops).',
    },
    {
      name: 'processes', level: 'safe', label: 'Top processes',
      description: 'List the processes using the most CPU.',
      params: {},
      run: async () => pc.topProcesses(),
    },
    {
      name: 'kill_process', level: 'standard', destructive: true, label: 'Kill process',
      description: 'Terminate a running process by name (owner confirms first).',
      params: { name: { type: 'string', description: 'Process name to kill', required: true } },
      confirmText: ({ name }) => `Kill process “${name}”`,
      run: async ({ name }) => systemx.killProcess(name),
    },
    {
      name: 'service_status', level: 'safe', label: 'Service status',
      description: 'Check a systemd service (user or system).',
      params: { name: { type: 'string', description: 'Service name', required: true } },
      run: async ({ name }) => systemx.serviceStatus(name),
    },
    {
      name: 'service_restart', level: 'standard', destructive: true, label: 'Restart service',
      description: 'Restart a systemd service (owner confirms first).',
      params: { name: { type: 'string', description: 'Service name', required: true } },
      confirmText: ({ name }) => `Restart service “${name}”`,
      run: async ({ name }) => systemx.serviceRestart(name),
    },
    {
      name: 'power', level: 'full', destructive: true, label: 'Power',
      description: 'Shut down, reboot or suspend the PC (owner confirms first; you go offline).',
      params: { action: { type: 'string', enum: ['shutdown', 'reboot', 'suspend'], required: true } },
      confirmText: ({ action }) => `${{ shutdown: 'Shut down', reboot: 'Reboot', suspend: 'Suspend' }[action] ?? action} the PC (unsaved work can be lost)`,
      run: async ({ action }) => {
        const act = String(action ?? '').toLowerCase();
        if (!['shutdown', 'poweroff', 'reboot', 'restart', 'suspend', 'sleep'].includes(act)) throw new Error('usage: shutdown|reboot|suspend');
        pc.schedulePower(act);
        const verb = { shutdown: 'Shutting down', poweroff: 'Shutting down', reboot: 'Rebooting', restart: 'Rebooting', suspend: 'Suspending', sleep: 'Suspending' }[act];
        return `⏻ ${verb} in 5 seconds. See you on the other side 👋`;
      },
    },

    // ── files ───────────────────────────────────────────────────────────────
    {
      name: 'list_dir', level: 'safe', label: 'List folder',
      description: 'List files/folders inside a directory (default: home).',
      params: { path: { type: 'string', description: 'Folder path (default ~)' } },
      run: async ({ path: p }) => files.listDirectory(p || '~', { extraRoots }),
    },
    {
      name: 'read_file', level: 'safe', label: 'Read file',
      description: 'Read a text file, PDF or DOCX on the PC and return its text.',
      params: { path: { type: 'string', description: 'File path', required: true } },
      run: async ({ path: p }) => {
        const resolved = files.resolvePath(p, { extraRoots, mustExist: true });
        if (!resolved.ok) throw new Error(resolved.reason);
        const stat = fs.statSync(resolved.path);
        if (stat.isDirectory()) return files.listDirectory(resolved.path, { extraRoots });
        const ext = path.extname(resolved.path).toLowerCase();
        if (!/\.(txt|md|markdown|csv|tsv|json|log|ya?ml|xml|html?|css|js|ts|jsx|tsx|py|sh|rs|go|java|c|cpp|h|ini|conf|env|sql|pdf|docx)$/.test(ext)) {
          return files.readTextFile(resolved.path, { extraRoots });
        }
        if (ext === '.pdf' || ext === '.docx') {
          const text = await ocr.extractDocumentText(fs.readFileSync(resolved.path), path.basename(resolved.path), files.mimeFor(resolved.path));
          return text
            ? `📄 *${path.basename(resolved.path)}*\n\`\`\`\n${text.slice(0, 6000)}${text.length > 6000 ? '\n…' : ''}\n\`\`\``
            : '📄 I couldn\'t extract any text from that file.';
        }
        return files.readTextFile(resolved.path, { extraRoots });
      },
    },
    {
      name: 'write_file', level: 'standard', label: 'Write file',
      description: 'Create or overwrite a text file under the home folder. Set append=true to add to the end.',
      params: {
        path: { type: 'string', description: 'File path', required: true },
        text: { type: 'string', description: 'Contents to write', required: true },
        append: { type: 'boolean', description: 'Append instead of overwrite' },
      },
      run: async ({ path: p, text, append }) => files.writeTextFile(p, text, { extraRoots, append: Boolean(append) }),
    },
    {
      name: 'search_files', level: 'safe', label: 'Search files',
      description: 'Find files by name under the home folder (or a given folder).',
      params: {
        query: { type: 'string', description: 'Part of the filename', required: true },
        path: { type: 'string', description: 'Folder to search (default ~)' },
      },
      run: async ({ query, path: p }) => files.searchFiles(query, { extraRoots, root: p || '~' }),
    },
    {
      name: 'delete_path', level: 'standard', destructive: true, label: 'Delete file/folder',
      description: 'Delete a file or folder (moved to trash when possible; owner confirms first).',
      params: { path: { type: 'string', description: 'File or folder path', required: true } },
      confirmText: ({ path: p }) => `Delete ${p}`,
      run: async ({ path: p }) => files.deletePath(p, { extraRoots }),
    },
    {
      name: 'move_path', level: 'standard', label: 'Move/rename',
      description: 'Move or rename a file or folder inside the allowed folders.',
      params: {
        from: { type: 'string', description: 'Source path', required: true },
        to: { type: 'string', description: 'Destination path', required: true },
      },
      run: async ({ from, to }) => files.movePath(from, to, { extraRoots }),
    },
    {
      name: 'copy_path', level: 'standard', label: 'Copy',
      description: 'Copy a file or folder.',
      params: {
        from: { type: 'string', description: 'Source path', required: true },
        to: { type: 'string', description: 'Destination path', required: true },
      },
      run: async ({ from, to }) => files.copyPath(from, to, { extraRoots }),
    },
    {
      name: 'make_dir', level: 'standard', label: 'Create folder',
      description: 'Create a folder (including parents).',
      params: { path: { type: 'string', description: 'Folder path', required: true } },
      run: async ({ path: p }) => files.makeDir(p, { extraRoots }),
    },
    {
      name: 'zip_paths', level: 'standard', label: 'Zip files',
      description: 'Create a zip archive from one or more files/folders.',
      params: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Files/folders to zip', required: true },
        output: { type: 'string', description: 'Output .zip path (optional)' },
      },
      run: async ({ paths, output }) => files.zipPaths(paths, output, { extraRoots }),
    },
    {
      name: 'unzip_path', level: 'standard', label: 'Unzip',
      description: 'Extract a .zip archive.',
      params: {
        path: { type: 'string', description: 'Zip file path', required: true },
        dest: { type: 'string', description: 'Destination folder (optional)' },
      },
      run: async ({ path: p, dest }) => files.unzipPath(p, { extraRoots, dest }),
    },
    {
      name: 'download_url', level: 'standard', label: 'Download URL',
      description: 'Download a file from an http(s) link straight to the PC.',
      params: {
        url: { type: 'string', description: 'The link', required: true },
        path: { type: 'string', description: 'Save to this path (optional, default ~/Downloads)' },
      },
      run: async ({ url, path: p }) => files.downloadUrl(url, p, { extraRoots }),
    },
    {
      name: 'send_file', level: 'standard', label: 'Send file',
      description: 'Send a file from the PC to the owner on WhatsApp.',
      params: { path: { type: 'string', description: 'File path', required: true } },
      run: async ({ path: p }) => files.fileReply(p, { extraRoots }),
    },

    // ── capture ─────────────────────────────────────────────────────────────
    {
      name: 'webcam_photo', level: 'standard', label: 'Webcam photo',
      description: 'Take a photo with the PC webcam and send it.',
      params: {},
      run: async () => systemx.webcamPhoto(),
    },
    {
      name: 'record_screen', level: 'standard', label: 'Record screen',
      description: 'Record the screen for N seconds and send the video.',
      params: { seconds: { type: 'number', description: 'Duration in seconds (2-120, default 10)' } },
      run: async ({ seconds }) => systemx.recordScreen(seconds),
    },

    // ── input ───────────────────────────────────────────────────────────────
    {
      name: 'type_text', level: 'standard', label: 'Type text',
      description: 'Type text into whatever window is focused on the PC. Long text is typed in chunks; use paste_text for very long text or multi-line content.',
      params: {
        text: { type: 'string', description: 'Text to type', required: true },
        method: { type: 'string', enum: ['type', 'paste'], description: 'type = key events (default), paste = clipboard + Ctrl+V (fast, unlimited length)' },
      },
      run: async ({ text, method }) => (method === 'paste' ? pc.pasteText(text) : pc.typeText(text)),
    },
    {
      name: 'paste_text', level: 'standard', label: 'Paste text',
      description: 'Put text on the PC clipboard and press Ctrl+V in the focused window. Best for long or multi-line text.',
      params: { text: { type: 'string', description: 'Text to paste', required: true } },
      run: async ({ text }) => pc.pasteText(text),
    },
    {
      name: 'press_keys', level: 'standard', label: 'Press keys',
      description: 'Press a key combination on the PC, e.g. "ctrl+l", "alt+tab", "super", "enter".',
      params: { combo: { type: 'string', description: 'Key combo', required: true } },
      run: async ({ combo }) => pc.keyCombo(combo),
    },
    {
      name: 'click', level: 'standard', label: 'Click',
      description: 'Click at screen coordinates, or click a visible UI element by its label (OCR).',
      params: {
        x: { type: 'number', description: 'X coordinate (optional)' },
        y: { type: 'number', description: 'Y coordinate (optional)' },
        label: { type: 'string', description: 'Visible button/field label to find and click' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        clicks: { type: 'number', description: 'How many times to click (1-3, default 1)' },
      },
      run: async ({ x, y, label, button, clicks }) => {
        if (label) {
          const hit = await finder.locateOnScreen(config, label, log);
          await pc.click(hit.x, hit.y, button ?? 'left', clicks ?? 1);
          return `🖱️ Clicked *${hit.matched}* at ${hit.x},${hit.y} (found by ${hit.source === 'ocr' ? `OCR ${hit.confidence}%` : 'vision'}).`;
        }
        if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) throw new Error('click needs x and y, or a visible label');
        return pc.click(Number(x), Number(y), button ?? 'left', clicks ?? 1);
      },
    },
    {
      name: 'move_mouse', level: 'standard', label: 'Move mouse',
      description: 'Move the mouse pointer to screen coordinates.',
      params: {
        x: { type: 'number', description: 'X coordinate', required: true },
        y: { type: 'number', description: 'Y coordinate', required: true },
      },
      run: async ({ x, y }) => pc.moveMouse(Number(x), Number(y)),
    },
    {
      name: 'scroll', level: 'standard', label: 'Scroll',
      description: 'Scroll the wheel up or down on the PC.',
      params: {
        direction: { type: 'string', enum: ['up', 'down'], description: 'up or down (default down)' },
        amount: { type: 'number', description: 'Steps (1-25, default 3)' },
      },
      run: async ({ direction, amount }) => pc.scrollMouse(direction ?? 'down', amount ?? 3),
    },

    // ── free lookups (no keys, no accounts) ─────────────────────────────────
    {
      name: 'weather', level: 'safe', label: 'Weather',
      description: 'Current weather and a 3-day forecast for a city (Open-Meteo, free).',
      params: { city: { type: 'string', description: 'City name', required: true } },
      run: async ({ city }) => tools.weather(city),
    },
    {
      name: 'wikipedia', level: 'safe', label: 'Wikipedia',
      description: 'Look up a topic on Wikipedia.',
      params: { topic: { type: 'string', description: 'Topic', required: true } },
      run: async ({ topic }) => tools.wiki(topic),
    },
    {
      name: 'news', level: 'safe', label: 'News',
      description: 'Latest news headlines (India by default, or a topic).',
      params: { topic: { type: 'string', description: 'Optional topic' } },
      run: async ({ topic }) => tools.news(topic ?? ''),
    },
    {
      name: 'read_webpage', level: 'safe', label: 'Read webpage',
      description: 'Download a web page and return its readable text, so you can summarise or answer questions about it.',
      params: { url: { type: 'string', description: 'http(s) link', required: true } },
      run: async ({ url }) => {
        const page = await tools.fetchPageText(url, 16_000);
        return `🌐 *${page.title}*\n\n${page.text.slice(0, 6000)}${page.text.length > 6000 ? '\n…' : ''}`;
      },
    },
    {
      name: 'calculate', level: 'safe', label: 'Calculator',
      description: 'Calculate an arithmetic expression safely (sqrt, %, ^…).',
      params: { expression: { type: 'string', description: 'e.g. 45*12 + sqrt(81)', required: true } },
      run: async ({ expression }) => `🧮 ${expression} = *${tools.calc(expression)}*`,
    },

    // ── owner data (notes/todos/reminders) ──────────────────────────────────
    {
      name: 'add_reminder', level: 'safe', label: 'Add reminder',
      description: 'Set a reminder that fires on WhatsApp. `when` is natural language: "in 10 minutes", "tomorrow 9am", "at 18:30".',
      params: {
        text: { type: 'string', description: 'What to remind about', required: true },
        when: { type: 'string', description: 'When, e.g. "in 10 minutes"', required: true },
      },
      run: async ({ text, when }) => {
        const parsed = tools.parseWhen(`${when} ${text}`);
        if (!parsed || !parsed.rest) throw new Error('I couldn\'t understand that time. Try "in 10 minutes", "tomorrow 9am", "at 18:30".');
        const r = store.addReminder(parsed.rest, parsed.dueTs);
        return `⏰ Reminder #${r.id}: *${r.text}* — ${tools.formatDateTime(r.dueTs, config.timezone ?? 'Asia/Kolkata')}`;
      },
    },
    {
      name: 'list_reminders', level: 'safe', label: 'List reminders',
      description: 'List upcoming reminders.',
      params: {},
      run: async () => {
        if (!store.data.reminders.length) return '⏰ No reminders set.';
        return '⏰ *Reminders*\n\n' + store.data.reminders.map((r) => `#${r.id} · ${tools.formatDateTime(r.dueTs, config.timezone ?? 'Asia/Kolkata')} — ${r.text}`).join('\n');
      },
    },
    {
      name: 'add_todo', level: 'safe', label: 'Add to-do',
      description: 'Add an item to the owner\'s to-do list.',
      params: { text: { type: 'string', description: 'Task', required: true } },
      run: async ({ text }) => { const t = store.addTodo(text); return `✅ Added to-do #${t.id}: ${t.text}`; },
    },
    {
      name: 'list_todos', level: 'safe', label: 'List to-dos',
      description: 'List to-dos.',
      params: {},
      run: async () => {
        if (!store.data.todos.length) return '✅ To-do list is empty.';
        return '✅ *To-dos*\n\n' + store.data.todos.map((t) => `#${t.id} ${t.done ? '✔️' : '▫️'} ${t.text}`).join('\n');
      },
    },
    {
      name: 'complete_todo', level: 'safe', label: 'Complete to-do',
      description: 'Mark a to-do as done by its number.',
      params: { id: { type: 'number', description: 'To-do number', required: true } },
      run: async ({ id }) => {
        const t = store.setTodoDone(Number(id), true);
        if (!t) throw new Error(`no to-do #${id}`);
        return `✔️ Done: ${t.text}`;
      },
    },
    {
      name: 'add_note', level: 'safe', label: 'Add note',
      description: 'Save a note.',
      params: { text: { type: 'string', description: 'Note text', required: true } },
      run: async ({ text }) => { const n = store.addNote(text); return `📝 Saved note #${n.id}.`; },
    },
    {
      name: 'list_notes', level: 'safe', label: 'List notes',
      description: 'List saved notes.',
      params: {},
      run: async () => (store.data.notes.length
        ? '📝 *Notes*\n\n' + store.data.notes.map((n) => `#${n.id} · ${n.text}`).join('\n')
        : '📝 No notes yet.'),
    },
    {
      name: 'remember_fact', level: 'safe', label: 'Remember fact',
      description: 'Remember a long-term fact about the owner, used by the AI in future chats.',
      params: { text: { type: 'string', description: 'The fact', required: true } },
      run: async ({ text }) => {
        const value = String(text ?? '').trim();
        if (!value) throw new Error('nothing to remember');
        store.data.facts[value.slice(0, 48)] = value;
        store.save();
        return '🧠 Remembered. I\'ll keep it in mind in our chats.';
      },
    },

    // ── shell (the one big switch) ──────────────────────────────────────────
    {
      name: 'run_shell', level: 'full', destructive: true, requiresShell: true, label: 'Run shell command',
      description: 'Run a shell command on the PC and return its output. Requires ALLOW_SHELL=true and the owner\'s SHELL_PIN. Use for anything not covered by other tools (package installs, git, ffmpeg, scripts).',
      params: { command: { type: 'string', description: 'The shell command', required: true } },
      confirmText: ({ command }) => `Run shell command:\n${short(command, 300)}`,
      run: async ({ command }) => {
        const cmd = String(command ?? '').trim();
        if (!cmd) throw new Error('empty command');
        const timeout = config.shellTimeoutMs ?? 20_000;
        try {
          const { stdout, stderr } = await execFileAsync('/bin/bash', ['-lc', cmd], {
            timeout,
            maxBuffer: 4 * 1024 * 1024,
            cwd: os.homedir(),
            env: pc.displayEnv(),
          });
          const out = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim().slice(0, MAX_OUT);
          return `💻 \`${cmd}\`\n\`\`\`\n${out || '(no output)'}\n\`\`\``;
        } catch (err) {
          const out = `${err.stdout ?? ''}${err.stderr ? `\n${err.stderr}` : ''}`.trim().slice(0, MAX_OUT);
          if (err.killed) throw new Error(`Command timed out after ${timeout / 1000}s.`);
          return `💻 \`${cmd}\`\n\`\`\`\n${out || err.message}\n\`\`\``;
        }
      },
    },
  ];

  const byName = new Map(registry.map((entry) => [entry.name, entry]));

  /** Tool schema array for the AI (level-filtered). */
  function toolSchemas() {
    const current = LEVELS[level()];
    return registry
      .filter((entry) => LEVELS[entry.level] <= current)
      .filter((entry) => !entry.requiresShell || config.allowShell)
      .map((entry) => ({
        name: entry.name,
        description: entry.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(Object.entries(entry.params ?? {}).map(([key, schema]) => {
            const { required, ...rest } = schema;
            return [key, rest];
          })),
          required: Object.entries(entry.params ?? {}).filter(([, schema]) => schema.required).map(([key]) => key),
          additionalProperties: false,
        },
      }));
  }

  function accessReport() {
    const current = level();
    const counts = { safe: 0, standard: 0, full: 0 };
    for (const entry of registry) counts[entry.level] += 1;
    return {
      level: current,
      actions: registry.length,
      byLevel: counts,
      shell: Boolean(config.allowShell),
      shellPin: Boolean(config.shellPin),
      pcControl: Boolean(config.allowPcControl),
    };
  }

  /**
   * Execute an action. Returns
   *   { ok, text, image?, document?, video?, needsConfirmation? }
   * and never throws for expected failures.
   */
  async function execute(name, args = {}, ctx = {}) {
    const entry = byName.get(name);
    if (!entry) return { ok: false, text: `🤖 I don't know the action "${name}".` };
    if (LEVELS[entry.level] > LEVELS[level()]) {
      return { ok: false, text: `🔒 *${entry.label ?? name}* needs ACCESS_LEVEL=${entry.level} in whatsapp-agent/.env (currently ${level()}).` };
    }
    if (entry.requiresShell) {
      if (!config.allowShell) {
        return { ok: false, text: '🔒 Shell is OFF (ALLOW_SHELL=false). That\'s the one action that can undo anything, so it stays opt-in: set ALLOW_SHELL=true and SHELL_PIN=<pin> in whatsapp-agent/.env, then restart. Everything else (apps, files, Wi-Fi, OCR, input, power…) already works without it.' };
      }
      if (config.shellPin && !ctx.shellPinOk) {
        return { ok: false, text: '🔒 Shell needs your PIN. Send it as a prefix: `/run <PIN> <command>` (or put the PIN first in a plain-language request).' };
      }
    }
    const safeArgs = args && typeof args === 'object' ? args : {};
    if (entry.destructive && !ctx.confirmed) {
      const text = describe(entry, safeArgs);
      store.data.pending = { name, args: safeArgs, ts: Date.now(), text };
      store.save();
      return {
        ok: false,
        needsConfirmation: true,
        text: `⚠️ *Confirm:* ${text}\n\nReply *haan* / *yes* within 2 minutes to do it, or *nahi* to cancel. It is not done yet.`,
      };
    }
    try {
      const result = await entry.run(safeArgs, ctx);
      if (result == null) return { ok: true, text: '✅ Done.' };
      if (typeof result === 'string') return { ok: true, text: result };
      return { ok: true, ...result };
    } catch (err) {
      log.warn?.(`[actions] ${name} failed: ${err.message}`);
      return { ok: false, text: `⚠️ ${err.message}` };
    }
  }

  /** Run a parked destructive action after the owner said yes. */
  async function runPending(ctx = {}) {
    const pending = store.data.pending;
    if (!pending) return { ok: false, text: 'Nothing is waiting for confirmation.' };
    store.data.pending = null;
    store.save();
    if (Date.now() - pending.ts > (config.confirmTtlMs ?? 120_000)) {
      return { ok: false, text: '⌛ That confirmation expired (2 minutes) — ask me again and nothing was changed.' };
    }
    return execute(pending.name, pending.args, { ...ctx, confirmed: true });
  }

  function clearPending() {
    if (store.data.pending) {
      store.data.pending = null;
      store.save();
    }
  }

  return { registry, toolSchemas, execute, runPending, clearPending, accessReport, describe, level };
}
