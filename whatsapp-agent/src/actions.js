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
import * as solver from './solver.js';
import * as finder from './elementfinder.js';
import * as tools from './tools.js';
import * as autopilot from './autopilot.js';
import * as hands from './hands.js';
import * as mem from './memory.js';
import * as reach from './reach.js';
import * as grounding from './grounding.js';
import { StoppedError, isStoppedError } from './cancel.js';
import * as tts from './tts.js';
import { runDoctor } from './doctor.js';
import { createProgress, describeHandsStep } from './progress.js';
import { noteOfflineAnnounced } from './lifecycle.js';
import { ensureProfile, addLesson } from './persona.js';
import {
  resolveRecipient,
  addContact,
  removeContact,
  formatContactsList,
  recordGuestAudit,
  recordGuestChatTurn,
} from './guests.js';
import {
  resolveOwnerLocation,
  setOwnerLocation,
  searchNearbyPlaces,
  formatOwnerLocationCard,
} from './location.js';
import {
  normalizeKeyword,
  validateKeyword,
  parseLearnCommands,
  formatLearned,
  formatLearnedStep,
} from './learn.js';
import {
  startActionRecording,
  stopActionRecording,
  cancelActionRecording,
  formatActionRecorderStatus,
  saveLastRecordingAsCommand,
} from './actionrecorder.js';

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

export function createActions({
  config, store, log = console, journal = null, notify = null, harness = null, sendToNumber = null,
}) {
  let sendWhatsappTo = typeof sendToNumber === 'function' ? sendToNumber : null;
  let outboundStamps = [];
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
    // ── DeepSeek Harness full-power coding / shell / repo engine ────────────
    ...(harness ? [{
      name: 'dsh_run',
      level: 'full',
      label: 'DeepSeek Harness agent task',
      description: 'Delegate multi-step coding, shell scripting, repository edits, debugging, or system automation to the full-power DeepSeek Harness (`@deepseek-ai/dsh`) Linux agent.',
      params: {
        task: { type: 'string', description: 'Detailed task instructions for DeepSeek Harness', required: true },
        cwd: { type: 'string', description: 'Optional working directory path on Linux' },
      },
      run: async ({ task, cwd }, ctx = {}) => {
        const res = await harness.runTask(String(task ?? ''), {
          cwd,
          signal: ctx.signal,
          onProgress: notify ? (msg) => notify(msg) : null,
        });
        return `🚀 *DeepSeek Harness*\n\n${res.text}\n\n_Session \`${String(res.sessionId).slice(0, 8)}\` · ${res.toolCalls.length} tool call(s)_`;
      },
    }] : []),

    // ── JARVIS voice ────────────────────────────────────────────────────────
    {
      name: 'speak_text', level: 'safe', label: 'Speak aloud (JARVIS)',
      description: 'Say a sentence aloud in the JARVIS voice, verbatim — use ONLY when the owner explicitly asks you to read/announce/say something (e.g. "read this paragraph", "announce: dinner is ready"). In a voice call your normal final reply is already spoken, so do not wrap ordinary replies in speak_text. Keep it under ~300 words.',
      params: { text: { type: 'string', description: 'The exact words to speak', required: true } },
      run: async ({ text }) => {
        const clean = String(text ?? '').trim().slice(0, 2000);
        if (!clean) return '🔊 (kuch bolne ko nahi mila)';
        return `🔊 ${clean}`;
      },
    },
    {
      name: 'schedule_jarvis_call', level: 'standard', label: 'Schedule a JARVIS call',
      description: 'Schedule JARVIS to CALL the owner on WhatsApp at a set time and speak an update — use when the owner says things like "call me at 6pm and tell me", "shaam ko call karke update dena", "remind me by call at 9". `when` uses the reminder grammar: "in 30m", "at 18:30", "tomorrow 9am". `message` is what JARVIS should say; if the update should be live data, make message a slash command like "/brief" or "/system" — it runs at call time and the result is spoken. One-shot (not recurring).',
      params: {
        when: { type: 'string', description: 'When to call: "in 30m" | "at 18:30" | "tomorrow 9am"', required: true },
        message: { type: 'string', description: 'What to speak on the call, or a /command whose fresh output should be spoken', required: true },
      },
      confirmText: ({ when, message }) => `Schedule a JARVIS call (${when}) to say: “${String(message).slice(0, 80)}”`,
      run: async ({ when, message }) => {
        const whenStr = String(when ?? '').trim();
        // parseWhen clock forms ("at 18:30") need trailing text — supply a dummy.
        const parsed = tools.parseWhen(whenStr) ?? tools.parseWhen(`${whenStr} scheduled call`);
        if (!parsed) return `⏰ I couldn't understand the time "${when}". Try "in 30m", "at 18:30" or "tomorrow 9am".`;
        const item = store.addCallSchedule(String(message ?? '').trim() || 'You asked me to call you now, Sir.', parsed.dueTs);
        return `📞 Scheduled, Sir — I shall call you on ${new Date(item.dueTs).toLocaleString('en-IN', { timeZone: config.timezone ?? 'Asia/Kolkata' })} and ${item.text.startsWith('/') ? `report the fresh output of ${item.text}` : `say: "${item.text.slice(0, 120)}"`}. (See or cancel: /callat)`;
      },
    },

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
      run: async ({ app }, ctx) => {
        if (/^https?:\/\//i.test(String(app ?? '').trim())) return pc.openTarget(String(app).trim());
        const target = mem.resolvePreferredApp(store, app, { bypassSaved: Boolean(ctx?.bypassSaved) });
        return (await apps.launchApp(target)).text;
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
      name: 'computer_use', level: 'standard', label: 'Control the screen',
      description:
        'Do a visual task on the PC like a human: look at the screenshot, then click / type / scroll, '
        + 'and look again after every step (up to 8 steps). Use for anything that needs the GUI — playing a '
        + 'video, using a website, changing a setting, driving an app that has no CLI. Prefer a direct tool '
        + '(open_app, download_url, write_file, …) when one can do it exactly.',
      params: {
        task: { type: 'string', description: 'What to accomplish, in plain language (Hinglish fine)', required: true },
        max_steps: { type: 'integer', description: 'Step budget (default 8, max 20)' },
      },
      run: async ({ task, max_steps }, ctx) => {
        const progress = notify ? createProgress({ send: notify, label: 'Hands', total: max_steps ?? config.handsMaxSteps ?? 8, log }) : null;
        const result = await hands.runHands(task, {
          config, log, maxSteps: max_steps, signal: ctx?.signal,
          onStep: progress
            ? (entry) => {
              if (entry?.ok === false) return;
              const { action, detail } = describeHandsStep(entry?.action ?? entry ?? {});
              progress.step({ n: entry?.step ?? null, action, detail }).catch(() => {});
            }
            : undefined,
        });
        if (result.stopped) throw new StoppedError('Hands');
        return { text: result.text, image: result.image };
      },
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
        noteOfflineAnnounced(store, act);
        pc.schedulePower(act);
        const verb = { shutdown: 'Shutting down', poweroff: 'Shutting down', reboot: 'Rebooting', restart: 'Rebooting', suspend: 'Suspending', sleep: 'Suspending' }[act];
        return `😴 *Agent is sleeping* — ⏻ ${verb} in 5 seconds. See you on the other side 👋`;
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
      run: async ({ path: p, text, append }) => {
        const write = () => files.writeTextFile(p, text, { extraRoots, append: Boolean(append) });
        return journal ? journal.wrapWrite(p, write, { append: Boolean(append) }) : write();
      },
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
      run: async ({ path: p }) => {
        const del = () => files.deletePath(p, { extraRoots });
        let dir = false;
        try { dir = fs.statSync(files.resolvePath(p, { extraRoots }).path).isDirectory(); } catch { /* new */ }
        return journal ? journal.wrapDelete(files.resolvePath(p, { extraRoots }).path ?? p, del, { isDirectory: dir }) : del();
      },
    },
    {
      name: 'move_path', level: 'standard', label: 'Move/rename',
      description: 'Move or rename a file or folder inside the allowed folders.',
      params: {
        from: { type: 'string', description: 'Source path', required: true },
        to: { type: 'string', description: 'Destination path', required: true },
      },
      run: async ({ from, to }) => {
        const move = () => files.movePath(from, to, { extraRoots });
        const a = files.resolvePath(from, { extraRoots, mustExist: true });
        const b = files.smartHomePath(to);
        return journal && a.ok ? journal.wrapMove(a.path, b, move) : move();
      },
    },
    {
      name: 'copy_path', level: 'standard', label: 'Copy',
      description: 'Copy a file or folder.',
      params: {
        from: { type: 'string', description: 'Source path', required: true },
        to: { type: 'string', description: 'Destination path', required: true },
      },
      run: async ({ from, to }) => {
        const copy = () => files.copyPath(from, to, { extraRoots });
        const b = files.smartHomePath(to);
        return journal ? journal.wrapCopy(from, b, copy) : copy();
      },
    },
    {
      name: 'make_dir', level: 'standard', label: 'Create folder',
      description: 'Create a folder (including parents).',
      params: { path: { type: 'string', description: 'Folder path', required: true } },
      run: async ({ path: p }) => {
        const mk = () => files.makeDir(p, { extraRoots });
        return journal ? journal.wrapMkdir(files.smartHomePath(p), mk) : mk();
      },
    },
    {
      name: 'zip_paths', level: 'standard', label: 'Zip files',
      description: 'Create a zip archive from one or more files/folders.',
      params: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Files/folders to zip', required: true },
        output: { type: 'string', description: 'Output .zip path (optional)' },
      },
      run: async ({ paths, output }) => {
        const zip = () => files.zipPaths(paths, output, { extraRoots });
        if (!journal) return zip();
        const out = await zip();
        // files.zipPaths returns the archive path text; journal the file it made.
        const created = output ? files.smartHomePath(output) : null;
        if (created) journal.record({ kind: 'zip', out: created, undoable: true, label: `zip ${path.basename(created)}` });
        return out;
      },
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
      run: async ({ url, path: p }, ctx) => files.downloadUrl(url, p, { extraRoots, signal: ctx?.signal }),
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
      run: async ({ seconds }, ctx) => systemx.recordScreen(seconds, { signal: ctx?.signal }),
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
      name: 'autopilot', level: 'standard', label: 'Autopilot',
      description: 'One-command UI automation: open an app, click buttons by visible label (OCR), type, press enter, wait, screenshot. Use for "open agent and click battle then agent and ask how to use ai". Pipe syntax is most reliable: "open agent | tap battle | tap agent | type how to use ai | key enter | screenshot". Also accepts natural language.',
      params: { task: { type: 'string', description: 'Task: pipe steps or natural language, e.g. "open agent | tap battle | tap agent | type hello | key enter | screenshot"', required: true } },
      run: async ({ task }, ctx) => autopilot.runAutopilot(task, { config, log, signal: ctx?.signal }),
    },
    {
      name: 'remember_fact', level: 'safe', label: 'Remember fact',
      description: 'Remember or update a long-term fact, owner name (mera naam), preference, or custom rule in persistent memory. Automatically overwrites any older saved value for the same key.',
      params: { text: { type: 'string', description: 'The fact or rule to remember/update', required: true } },
      run: async ({ text }) => {
        const value = String(text ?? '').trim();
        if (!value) throw new Error('nothing to remember');
        const rule = mem.parseRuleStatement(value);
        if (rule) {
          if (rule.kind === 'directive') {
            mem.rememberFact(store, `owner_priority_rule: ${rule.value}`, { explicit: true });
            return '🧠 Remembered. I\'ll keep it in mind in our chats.';
          }
          if (rule.kind === 'fact') {
            const r = mem.rememberFact(store, rule.text, { explicit: true });
            return r?.reply ?? '🧠 Remembered. I\'ll keep it in mind in our chats.';
          }
          const r = mem.addRule(store, rule);
          return r?.reply ?? '🧠 Remembered. I\'ll keep it in mind in our chats.';
        }
        const res = mem.rememberFact(store, value, { explicit: true });
        return res?.reply ?? '🧠 Remembered. I\'ll keep it in mind in our chats.';
      },
    },
    {
      name: 'update_owner_profile',
      level: 'safe',
      label: 'Learn owner behavior / preference / goal / lesson',
      description: 'Save a learned insight about the owner\'s behavior, personality trait, preference/like, dislike, active goal/project, or a lesson on how PSD_Ai should communicate and help them better.',
      params: {
        kind: { type: 'string', enum: ['trait', 'preference', 'dislike', 'goal', 'lesson'], description: 'Category of insight to learn', required: true },
        text: { type: 'string', description: 'Concise description of the trait, preference, goal, or behavioral lesson', required: true },
      },
      run: async ({ kind, text }) => {
        const cleanText = String(text ?? '').trim();
        if (!cleanText) throw new Error('empty insight');
        const profile = ensureProfile(store);
        const k = String(kind ?? 'lesson').toLowerCase();
        if (k === 'trait') {
          if (!profile.traits.includes(cleanText)) profile.traits.push(cleanText);
        } else if (k === 'preference') {
          profile.preferences.push({ text: cleanText, ts: Date.now(), source: 'agent' });
        } else if (k === 'dislike') {
          profile.dislikes.push({ text: cleanText, ts: Date.now(), source: 'agent' });
        } else if (k === 'goal') {
          profile.goals.push({ text: cleanText, ts: Date.now(), status: 'active' });
        } else {
          addLesson(profile, cleanText, 'agent_tool');
        }
        store.save?.();
        return `🧠 Learned (${k}): *${cleanText}*`;
      },
    },

    // ── shell (the one big switch) ──────────────────────────────────────────
    {
      name: 'run_shell', level: 'full', destructive: true, requiresShell: true, label: 'Run shell command',
      description: 'Run a shell command on the PC and return its output. Requires ALLOW_SHELL=true and the owner\'s SHELL_PIN. Use for anything not covered by other tools (package installs, git, ffmpeg, scripts).',
      params: { command: { type: 'string', description: 'The shell command', required: true } },
      confirmText: ({ command }) => `Run shell command:\n${short(command, 300)}`,
      run: async ({ command }, ctx) => {
        const cmd = String(command ?? '').trim();
        if (!cmd) throw new Error('empty command');
        const timeout = config.shellTimeoutMs ?? 20_000;
        try {
          const { stdout, stderr } = await execFileAsync('/bin/bash', ['-lc', cmd], {
            timeout,
            maxBuffer: 4 * 1024 * 1024,
            cwd: os.homedir(),
            env: pc.displayEnv(),
            // /stop kills the child process tree (SIGTERM from Node).
            ...(ctx?.signal ? { signal: ctx.signal } : {}),
          });
          const out = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim().slice(0, MAX_OUT);
          return `💻 \`${cmd}\`\n\`\`\`\n${out || '(no output)'}\n\`\`\``;
        } catch (err) {
          if (ctx?.signal?.aborted || err.name === 'AbortError') throw new StoppedError('Shell');
          const out = `${err.stdout ?? ''}${err.stderr ? `\n${err.stderr}` : ''}`.trim().slice(0, MAX_OUT);
          if (err.killed) throw new Error(`Command timed out after ${timeout / 1000}s.`);
          return `💻 \`${cmd}\`\n\`\`\`\n${out || err.message}\n\`\`\``;
        }
      },
    },
    {
      name: 'solve_question',
      level: 'safe',
      label: 'Solve question image / screen / text with 100% Python+Vision verification',
      description: 'Accurately solve exam, math, physics, chemistry, coding, SQL, or MCQ questions from an image path, live PC screen (`source: "screen"`), or direct question text, verifying calculations with Python/SymPy/compilers and an independent auditor.',
      params: {
        source: { type: 'string', description: '"screen", a file path under home/downloads, or omit when passing `question`' },
        question: { type: 'string', description: 'Optional question text or instructions (e.g. "Solve Q2 & Q3 step by step")' },
      },
      async run({ source = '', question = '' }, ctx) {
        const src = String(source ?? '').trim();
        if (src === 'screen') {
          const shot = await pc.captureScreenshot({ portalTimeoutMs: config.portalTimeoutMs });
          const res = await solver.solveQuestionImage(config, shot, {
            caption: question || 'Solve every question on screen accurately.',
            autoDetect: false,
            log,
            signal: ctx?.signal ?? null,
          });
          if (!res.ok) throw new Error(res.error || 'Could not solve screen question');
          return { image: shot, text: res.text };
        }
        if (src) {
          const resolved = files.resolvePath(src, { extraRoots: [config.downloadsDir, ...(config.filesExtraRoots ?? [])], mustExist: true });
          if (!resolved.ok) throw new Error(resolved.reason);
          const buf = fs.readFileSync(resolved.path);
          const res = await solver.solveQuestionImage(config, buf, {
            caption: question,
            autoDetect: false,
            savedPath: resolved.path,
            log,
            signal: ctx?.signal ?? null,
          });
          if (!res.ok) throw new Error(res.error || 'Could not solve image');
          return res.text;
        }
        const res = await solver.solveQuestionText(config, question, { log, signal: ctx?.signal ?? null });
        if (!res.ok) throw new Error(res.error || 'Could not solve question');
        return res.text;
      },
    },

    // ── Agent-Reach × Agent-S Deterministic Internet & Desktop Grounding ─────
    {
      name: 'web_search',
      level: 'safe',
      label: 'Web Search (Agent-Reach)',
      description: 'Search the web deterministically via Agent-Reach (Exa MCP / DuckDuckGo / Wikipedia / HackerNews) and return structured results with titles, URLs, and snippets. Always prefer this over opening a browser and guessing clicks.',
      params: {
        query: { type: 'string', description: 'Search query', required: true },
        limit: { type: 'integer', description: 'Max results (default 6)' },
      },
      run: async ({ query, limit }) => (await reach.webSearch(query, { limit: limit ?? 6 })).text,
    },
    {
      name: 'read_url',
      level: 'safe',
      label: 'Read URL (Agent-Reach)',
      description: 'Read any public URL cleanly as Markdown via Agent-Reach (Jina Reader + YouTube transcript + GitHub repo/issue + Twitter/X + Reddit + RSS). Never open a browser just to read a webpage.',
      params: {
        url: { type: 'string', description: 'Public http(s) URL to read', required: true },
      },
      run: async ({ url }) => (await reach.reachUrl(url)).text,
    },
    {
      name: 'youtube_info',
      level: 'safe',
      label: 'YouTube Search / Transcript / Direct Play',
      description: 'Search YouTube videos, extract full subtitle transcripts/metadata via yt-dlp/Agent-Reach, or play a video directly in the browser without blind UI clicking (`mode="play"`).',
      params: {
        query: { type: 'string', description: 'YouTube URL, video ID, or search query', required: true },
        mode: { type: 'string', enum: ['search', 'transcript', 'play'], description: 'search = list videos, transcript = extract subtitles/details, play = open top video directly in browser' },
      },
      run: async ({ query, mode = 'search' }) => {
        const q = String(query ?? '').trim();
        const isUrl = /^https?:\/\//i.test(q) || Boolean(reach.extractYoutubeId(q));
        if (mode === 'play') {
          if (isUrl) {
            const id = reach.extractYoutubeId(q);
            const url = id ? `https://www.youtube.com/watch?v=${id}` : q;
            await pc.openTarget(url);
            return `🎬 Opened YouTube video directly: ${url}`;
          }
          const s = await reach.youtubeSearch(q, { limit: 1 });
          const top = s.videos?.[0];
          if (!top) throw new Error(`No YouTube video found for "${q}"`);
          await pc.openTarget(top.url);
          return `🎬 *Playing on YouTube:* *${top.title}*\n🔗 ${top.url}\n_(Opened exact video URL directly — zero coordinate guessing)_`;
        }
        if (mode === 'transcript' || isUrl) {
          const r = await reach.reachUrl(isUrl && !/^https?:\/\//i.test(q) ? `https://www.youtube.com/watch?v=${q}` : q);
          return r.text;
        }
        const s = await reach.youtubeSearch(q, { limit: 5 });
        if (!s.videos.length) return `🎬 YouTube pe "${q}" ke liye koi video nahi mila.`;
        const lines = s.videos.map((v, i) => (
          `${i + 1}. *${v.title}*${v.duration ? ` (${v.duration})` : ''}${v.channel ? ` — _${v.channel}_` : ''}\n   🔗 ${v.url}`
        ));
        return `🎬 *YouTube Search: "${q}"* _(${s.backend})_\n\n${lines.join('\n\n')}`;
      },
    },
    {
      name: 'github_lookup',
      level: 'safe',
      label: 'GitHub Lookup (Agent-Reach)',
      description: 'Search GitHub repositories, inspect an owner/repo (stars, description, README), or read an issue/PR via gh CLI or GitHub REST API.',
      params: {
        query: { type: 'string', description: 'Search query, owner/repo slug, or GitHub URL', required: true },
        mode: { type: 'string', enum: ['auto', 'search', 'repo', 'issue', 'pr'], description: 'Lookup mode (default auto)' },
      },
      run: async ({ query, mode = 'auto' }) => (await reach.githubLookup(query, { mode })).text,
    },
    {
      name: 'social_lookup',
      level: 'safe',
      label: 'Community & Social Lookup (Agent-Reach)',
      description: 'Search or read discussions on Reddit, Twitter/X, HackerNews, V2EX, StackOverflow, or RSS feeds via Agent-Reach.',
      params: {
        platform: { type: 'string', enum: ['reddit', 'twitter', 'hackernews', 'v2ex', 'stackoverflow', 'rss'], required: true },
        query: { type: 'string', description: 'Search query or URL', required: true },
      },
      run: async ({ platform, query }) => {
        const p = String(platform ?? '').toLowerCase();
        if (p === 'reddit') return (await reach.redditLookup(query)).text;
        if (p === 'twitter') return (await reach.twitterLookup(query)).text;
        if (p === 'hackernews') return (await reach.hackerNewsLookup(query)).text;
        if (p === 'v2ex') return (await reach.v2exLookup(query)).text;
        if (p === 'stackoverflow') return (await reach.stackOverflowLookup(query)).text;
        if (p === 'rss') return (await reach.rssLookup(query)).text;
        throw new Error(`Unsupported platform: ${platform}`);
      },
    },
    {
      name: 'reach_research',
      level: 'safe',
      label: 'Deep Multi-Platform Research (Agent-Reach)',
      description: 'Research any topic in parallel across Web Search, GitHub, HackerNews, Reddit, and StackOverflow and return a synthesized report with real URLs.',
      params: {
        topic: { type: 'string', description: 'Topic or question to research across platforms', required: true },
      },
      run: async ({ topic }) => (await reach.reachResearch(topic)).text,
    },
    {
      name: 'reach_doctor',
      level: 'safe',
      label: 'Agent-Reach Channel Doctor',
      description: 'Check the live status and active backends of all Agent-Reach internet channels and Agent-S desktop grounding tools.',
      params: {},
      run: async () => (await reach.reachDoctor()).text,
    },
    {
      name: 'inspect_ui',
      level: 'safe',
      label: 'Inspect Desktop UI Elements (Agent-S Grounding)',
      description: 'Inspect the active window and list clickable UI elements on the desktop with exact coordinates from the Linux AT-SPI accessibility tree and OCR (no pixel guessing).',
      params: {},
      run: async () => {
        const desktop = await grounding.inspectDesktopElements({ timeoutMs: 2500 });
        let ocrWords = [];
        try {
          const shot = await pc.captureScreenshot({ portalTimeoutMs: Math.min(config?.portalTimeoutMs ?? 15_000, 15_000) });
          ocrWords = await finder.ocrScreenshot(shot);
        } catch { /* optional */ }
        const winLine = desktop.window?.title
          ? `🪟 *Active Window:* ${desktop.window.title}${desktop.window.app ? ` (${desktop.window.app})` : ''}`
          : '🪟 *Active Window:* (unknown / Wayland)';
        const atspiLines = (desktop.elements || []).slice(0, 35).map((el, i) => (
          `• #${i} [${el.role}] *"${el.name || el.description}"* @ \`${el.x},${el.y}\`${el.focused ? ' 🎯' : ''}`
        ));
        const ocrLines = ocrWords.slice(0, 30).map((w, i) => (
          `• W${i} *"${w.text}"* @ \`${Math.round(w.left + w.width / 2)},${Math.round(w.top + w.height / 2)}\``
        ));
        return [
          '🧭 *Agent-S Desktop UI Grounding Inspector*',
          winLine,
          '',
          atspiLines.length
            ? `*AT-SPI Accessibility Widgets (${desktop.elements.length}):*\n${atspiLines.join('\n')}`
            : '_AT-SPI widget tree empty or unavailable — using OCR boxes_',
          ocrLines.length
            ? `\n*OCR Text Boxes (${ocrWords.length}):*\n${ocrLines.join('\n')}`
            : '',
          '',
          '_Click any element deterministically: `/tap <label>` or `/tap <x> <y>`_',
        ].filter(Boolean).join('\n');
      },
    },

    // ── Controlled Multi-User Outbound Messaging & Contacts (Owner-Only) ───
    {
      name: 'send_whatsapp',
      level: 'standard',
      label: 'Send WhatsApp message to another person',
      description: 'Send a WhatsApp message to any phone number (e.g. 9876543210 or +919876543210), saved contact name (e.g. "Rahul"), or "last" (to reply to the last guest who messaged). Strictly owner-only and rate-limited.',
      params: {
        to: { type: 'string', description: 'Recipient phone number, saved contact name, or "last"', required: true },
        text: { type: 'string', description: 'Message text to send on WhatsApp', required: true },
      },
      run: async ({ to, text }, ctx = {}) => {
        if (ctx?.isOwner === false || ctx?.guest) {
          throw new Error('Blocked: only the owner can send outbound WhatsApp messages.');
        }
        const msgText = String(text ?? '').trim();
        if (!msgText) throw new Error('Message text is empty.');
        const resolved = resolveRecipient(store, config, to);
        if (!resolved.ok) throw new Error(resolved.reason);

        const now = Date.now();
        const maxPerMin = Math.max(1, Number(config.outboundRateLimitPerMinute ?? 12) || 12);
        outboundStamps = outboundStamps.filter((t) => now - t < 60_000);
        if (outboundStamps.length >= maxPerMin) {
          throw new Error(`Outbound rate limit reached (${maxPerMin} messages/min). Try again in a minute.`);
        }
        outboundStamps.push(now);

        if (typeof sendWhatsappTo === 'function') {
          await sendWhatsappTo(resolved.number, msgText);
        } else {
          store?.bump?.('outboundToOthers');
        }
        recordGuestChatTurn(store, resolved.number, 'assistant', msgText, { name: resolved.name });
        recordGuestAudit(store, {
          from: resolved.number,
          name: resolved.name,
          kind: 'outbound',
          text: msgText,
        });
        return `📤 *WhatsApp Message Sent*\n• To: *${resolved.name}* (\`+${resolved.number}\`)\n• Message: "${msgText}"`;
      },
    },
    {
      name: 'manage_contacts',
      level: 'safe',
      label: 'Manage WhatsApp contacts',
      description: 'Add, delete, or list saved WhatsApp contacts so the owner can message people by name.',
      params: {
        action: { type: 'string', enum: ['list', 'add', 'delete'], description: 'Operation to perform (default list)' },
        name: { type: 'string', description: 'Contact name when adding or deleting' },
        number: { type: 'string', description: 'Phone number when adding a contact' },
      },
      run: async ({ action = 'list', name = '', number = '' }, ctx = {}) => {
        if (ctx?.isOwner === false || ctx?.guest) {
          throw new Error('Blocked: only the owner can manage contacts.');
        }
        const act = String(action || 'list').toLowerCase();
        if (act === 'add') {
          const res = addContact(store, name, number, config);
          if (!res.ok) throw new Error(res.reason);
          return `📇 Contact saved: *${res.contact.name}* (\`+${res.contact.number}\`).`;
        }
        if (act === 'delete' || act === 'del' || act === 'remove') {
          const res = removeContact(store, name || number, config);
          if (!res.ok) throw new Error(res.reason);
          return `🗑️ Deleted contact *${res.removed.name}* (\`+${res.removed.number}\`).`;
        }
        return formatContactsList(store, config);
      },
    },
    {
      name: 'my_location',
      level: 'safe',
      label: 'Get or set owner location',
      description: 'Get, refresh, or set the owner\'s current location (city, address, GPS coordinates, Google Maps link). Strictly owner-only.',
      params: {
        action: { type: 'string', enum: ['get', 'refresh', 'set'], description: 'get = current location, refresh = re-detect via IP, set = set city/address/coordinates' },
        place: { type: 'string', description: 'City, address, or "lat,lon" when action="set"' },
      },
      run: async ({ action = 'get', place = '' }, ctx = {}) => {
        if (ctx?.isOwner === false || ctx?.guest) {
          throw new Error('Blocked: owner location is strictly private.');
        }
        const act = String(action || 'get').toLowerCase();
        if (act === 'set' || place) {
          const res = await setOwnerLocation(store, config, place);
          if (!res.ok) throw new Error(res.reason);
          return formatOwnerLocationCard(store, config, res.location);
        }
        const res = await resolveOwnerLocation(store, config, { forceRefresh: act === 'refresh', allowNetwork: true });
        if (!res.ok) throw new Error(res.reason);
        return formatOwnerLocationCard(store, config, res.location);
      },
    },
    {
      name: 'nearby_places',
      level: 'safe',
      label: 'Search places near owner location',
      description: 'Find nearby cafes, restaurants, ATMs, hospitals, gyms, or any place around the owner\'s current location with distance in km and Google Maps links.',
      params: {
        query: { type: 'string', description: 'What to search nearby (e.g. "cafe", "hospital", "atm", "gym")', required: true },
      },
      run: async ({ query }, ctx = {}) => {
        if (ctx?.isOwner === false || ctx?.guest) {
          throw new Error('Blocked: owner location is strictly private.');
        }
        const res = await searchNearbyPlaces(store, config, query);
        if (!res.ok) throw new Error(res.reason);
        return res.text;
      },
    },
    {
      name: 'create_custom_command',
      level: 'safe',
      label: 'Create custom /command',
      description: 'Create or update a persistent custom command (e.g. /study, /morning, /work) from the owner\'s natural-language instructions or slash steps so the owner can run that task anytime with `/name` or `name`.',
      params: {
        name: { type: 'string', description: 'Command keyword without slash (e.g. "study", "morning", "gaming")', required: true },
        task: { type: 'string', description: 'Task description or chain of commands (e.g. "open chrome and set volume to 30 and take a screenshot" or "/open chrome | /pc volume 30")', required: true },
      },
      run: async ({ name, task }, ctx = {}) => {
        if (ctx?.isOwner === false || ctx?.guest) {
          throw new Error('Blocked: only the owner can create custom commands.');
        }
        const keyword = normalizeKeyword(name);
        const err = validateKeyword(keyword);
        if (err) throw new Error(err);
        const taskStr = String(task || store.getLastOwnerTask() || '').trim();
        const commands = parseLearnCommands(taskStr);
        if (!commands || !commands.length) {
          throw new Error('Could not parse command steps. Specify what the command should do.');
        }
        const entry = store.addLearned(keyword, commands, taskStr);
        const steps = entry.commands.map(formatLearnedStep).join(' → ');
        return (
          `🧠 *Custom Command Created:* \`/${entry.keyword}\`\n` +
          `📋 *Task Steps:* ${steps}\n\n` +
          `Ab aap kabhi bhi \`/${entry.keyword}\` ya sirf \`${entry.keyword}\` bhejoge to main yahi task execute karunga!`
        );
      },
    },
    {
      name: 'list_custom_commands',
      level: 'safe',
      label: 'List custom commands',
      description: 'List all custom `/commands` and trigger rules created by the owner.',
      params: {},
      run: async (_args, ctx = {}) => {
        if (ctx?.isOwner === false || ctx?.guest) {
          throw new Error('Blocked: only the owner can view custom commands.');
        }
        const learned = store.listLearned();
        const rules = store.data?.rules ?? [];
        if (!learned.length && !rules.length) {
          return '📭 Abhi koi custom command saved nahi hai.';
        }
        const lines = [];
        if (learned.length) {
          lines.push(`🧠 *Custom Commands (${learned.length}):*`);
          learned.forEach((l, i) => lines.push(`${i + 1}. ${formatLearned(l)}`));
        }
        if (rules.length) {
          if (lines.length) lines.push('');
          lines.push(`⚡ *Custom Trigger Rules (${rules.length}):*`);
          rules.forEach((r, i) => lines.push(`${i + 1}. "${r.trigger}" → ${r.action}`));
        }
        return lines.join('\n');
      },
    },
    {
      name: 'delete_custom_command',
      level: 'safe',
      label: 'Delete custom command',
      description: 'Delete a saved custom `/command` by name.',
      params: {
        name: { type: 'string', description: 'Command keyword to remove (e.g. "study")', required: true },
      },
      run: async ({ name }, ctx = {}) => {
        if (ctx?.isOwner === false || ctx?.guest) {
          throw new Error('Blocked: only the owner can delete custom commands.');
        }
        const keyword = normalizeKeyword(name);
        if (store.deleteLearned(keyword)) {
          return `🗑️ Removed custom command \`/${keyword}\`.`;
        }
        return `⚠️ Custom command \`/${keyword}\` nahi mila.`;
      },
    },
    {
      name: 'record_pc_actions',
      level: 'safe',
      label: 'Record & learn owner PC actions',
      description: 'Start or stop recording the actions the owner performs on their PC (opening apps, switching windows, clicking UI elements, typing, volume changes) and save them as a reusable `/command` so the agent can repeat them anytime.',
      params: {
        action: { type: 'string', description: '"start" | "stop" | "cancel" | "status" | "save_as"', required: true },
        name: { type: 'string', description: 'Optional command keyword to save the recorded actions under (e.g. "morning", "setup", "work")' },
      },
      run: async ({ action = 'status', name = '' }, ctx = {}) => {
        if (ctx?.isOwner === false || ctx?.guest) {
          throw new Error('Blocked: only the owner can record or replay PC actions.');
        }
        const act = String(action || 'status').toLowerCase();
        if (act === 'start' || act === 'record' || act === 'begin') {
          const res = await startActionRecording(store, config, { name });
          return res.text;
        }
        if (act === 'stop' || act === 'save' || act === 'finish') {
          const res = await stopActionRecording(store, { name });
          if (!res.ok) return `⚠️ ${res.reason}`;
          return res.text;
        }
        if (act === 'cancel' || act === 'abort') {
          return cancelActionRecording(store).text;
        }
        if (act === 'save_as' && name) {
          const res = saveLastRecordingAsCommand(store, name);
          if (!res.ok) return `⚠️ ${res.reason}`;
          return res.text;
        }
        return formatActionRecorderStatus(store);
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
    if (ctx?.isOwner === false || ctx?.guest === true) {
      return {
        ok: false,
        blocked: true,
        text: '🔒 *Command Blocked:* All actions and commands are strictly reserved for the owner.',
      };
    }
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
      // A /stop is not a failure: any rejection while the signal is aborted
      // (curl killed, ffmpeg killed, fetch aborted) travels up so the command
      // reply is suppressed and only /stop answers.
      if (isStoppedError(err) || ctx?.signal?.aborted) throw new StoppedError(name);
      log.warn?.(`[actions] ${name} failed: ${err.message}`);
      return { ok: false, text: `⚠️ ${err.message}` };
    }
  }

  /** Run a parked destructive action after the owner said yes. */
  async function runPending(ctx = {}) {
    if (ctx?.isOwner === false || ctx?.guest === true) {
      return { ok: false, blocked: true, text: '🔒 *Command Blocked:* Only the owner can confirm actions.' };
    }
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

  return {
    registry,
    toolSchemas,
    execute,
    runPending,
    clearPending,
    accessReport,
    describe,
    level,
    setSendToNumber: (fn) => { sendWhatsappTo = typeof fn === 'function' ? fn : null; },
  };
}
