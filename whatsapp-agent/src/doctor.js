// doctor.js — "/doctor": tell the owner *exactly* why something on this PC
// doesn't work, in plain language, with the command that fixes it.
//
// This exists because "it can't control my whole computer" almost always means
// one of a handful of Fedora realities: Wayland blocking screenshots, the
// ydotool daemon not running, a missing dnf package, or the agent running
// outside a graphical session. Instead of guessing, we test the real thing
// (take a screenshot, inspect it) and report.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import * as pc from './pccontrol.js';
import { imageStats } from './imaging.js';
import { humanSize } from './files.js';

const execFileAsync = promisify(execFile);

const BINARIES = [
  ['grim', 'Wayland screenshots (wlroots/Sway)', 'grim'],
  ['gnome-screenshot', 'GNOME screenshots', 'gnome-screenshot'],
  ['gdbus', 'Wayland screenshot portal + GNOME shell API', 'glib2'],
  ['wl-copy', 'clipboard read/write', 'wl-clipboard'],
  ['ydotool', 'keyboard/mouse on Wayland (GNOME/KDE)', 'ydotool'],
  ['xdotool', 'keyboard/mouse on X11', 'xdotool'],
  ['wpctl', 'volume', 'wireplumber'],
  ['brightnessctl', 'screen brightness', 'brightnessctl'],
  ['playerctl', 'music play/pause/next', 'playerctl'],
  ['wmctrl', 'list/focus/close windows (X11 only)', 'wmctrl'],
  ['tesseract', 'OCR (read text on screen / in photos)', 'tesseract'],
  ['ffmpeg', 'screen recording', 'ffmpeg'],
  ['pdftotext', 'reading PDFs', 'poppler-utils'],
  ['zip', 'zip/unzip files', 'zip'],
  ['nmcli', 'Wi-Fi control', 'NetworkManager'],
  ['bluetoothctl', 'Bluetooth', 'bluez'],
  ['notify-send', 'desktop notifications', 'libnotify'],
];

function osPretty() {
  try {
    const text = fs.readFileSync('/etc/os-release', 'utf8');
    const match = text.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
    return match ? match[1] : os.type();
  } catch {
    return os.type();
  }
}

async function ollamaState(config) {
  if (!config.ollamaUrl) return { reachable: false, models: [], detail: 'no OLLAMA_URL' };
  try {
    const res = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { reachable: false, models: [], detail: `HTTP ${res.status}` };
    const data = await res.json();
    const models = (data.models ?? []).map((m) => m.name);
    return { reachable: true, models, detail: `${models.length} model(s)` };
  } catch (err) {
    return { reachable: false, models: [], detail: err.message };
  }
}

function diskFree() {
  try {
    const { bavail, bsize } = fs.statfsSync(os.homedir());
    return humanSize(bavail * bsize);
  } catch {
    return null;
  }
}

// Emoji already separates the parts; parentheses keep the *bold* readable.
const line = (icon, title, detail, fix) => `${icon} *${title}* — ${detail}${fix ? `\n   _Fix:_ ${fix}` : ''}`;

/**
 * Build the report. `config` is the agent config; `ctx` may carry the WhatsApp
 * status string. Returns WhatsApp-ready text.
 */
export async function runDoctor({ config, ctx = {}, log = console } = {}) {
  const session = pc.sessionInfo();
  const input = pc.inputDiagnostics();
  const checks = [];

  // ── 1. Wayland screenshot reality ─────────────────────────────────────────
  let shot = null;
  if (!session.graphical) {
    checks.push({
      icon: '❌',
      title: 'No desktop session',
      detail: 'The agent sees no Wayland/X11 socket, so it cannot see or control the screen at all.',
      fix: 'Log in on the PC\'s screen, then: systemctl --user restart observer-whatsapp-agent',
    });
  } else {
    try {
      const buffer = await pc.captureScreenshot();
      const stats = imageStats(buffer);
      shot = stats;
      checks.push({
        icon: '✅',
        title: 'Screenshot',
        detail: `${stats.unknown ? 'captured' : `${stats.width}×${stats.height}, brightness ${stats.mean}/255`}`,
      });
    } catch (err) {
      checks.push({ icon: '❌', title: 'Screenshot', detail: err.message.split('\n').slice(0, 3).join(' ') });
    }
  }

  // ── 2. Keyboard & mouse ───────────────────────────────────────────────────
  if (input.ydotool && input.ydotoolDaemon) {
    checks.push({ icon: '✅', title: 'Keyboard/mouse', detail: `ydotool daemon ready (${session.type})` });
  } else if (input.ydotool && !input.ydotoolDaemon) {
    checks.push({
      icon: '⚠️',
      title: 'Keyboard/mouse',
      detail: 'ydotool is installed but its daemon is not running — typing/clicking will fail.',
      fix: 'sudo systemctl enable --now ydotool   (unit may be: ydotoold)',
    });
  } else if (input.xdotool && session.type === 'x11') {
    checks.push({ icon: '✅', title: 'Keyboard/mouse', detail: 'xdotool (X11 session)' });
  } else if (input.wtype) {
    checks.push({ icon: '✅', title: 'Keyboard/mouse', detail: 'wtype (wlroots)' });
  } else {
    checks.push({
      icon: '❌',
      title: 'Keyboard/mouse',
      detail: `No working input tool${session.type === 'wayland' ? ' on Wayland' : ''} — typing, clicking and shortcuts are unavailable.`,
      fix: 'sudo dnf install ydotool && sudo systemctl enable --now ydotool',
    });
  }

  // ── 3. Packages ───────────────────────────────────────────────────────────
  const missing = [];
  for (const [bin, purpose, pkg] of BINARIES) {
    if (pc.findBin(bin)) continue;
    // gdbus/Wayland bits are pointless to demand on X11, and vice versa.
    if (bin === 'grim' && session.type === 'x11') continue;
    if (bin === 'xdotool' && session.type === 'wayland' && input.ydotool) continue;
    if (bin === 'ydotool' && session.type === 'x11' && input.xdotool) continue;
    if (bin === 'wmctrl' && session.type === 'wayland') continue; // can't work on GNOME Wayland anyway
    missing.push({ bin, purpose, pkg });
  }
  if (missing.length) {
    checks.push({
      icon: '⚠️',
      title: `${missing.length} optional tool(s) missing`,
      detail: missing.map((m) => `${m.bin} (${m.purpose})`).join(', '),
      fix: `sudo dnf install ${[...new Set(missing.map((m) => m.pkg))].join(' ')}`,
    });
  } else {
    checks.push({ icon: '✅', title: 'PC toolkit', detail: 'every tool this agent uses is installed' });
  }

  // ── 4. AI brain ───────────────────────────────────────────────────────────
  const ollama = await ollamaState(config);
  const cloudKey = config.groqApiKey ? 'Groq' : config.geminiApiKey ? 'Gemini' : config.openrouterApiKey ? 'OpenRouter' : null;
  if (ollama.reachable) {
    const hasModel = ollama.models.some((m) => m.split(':')[0] === config.ollamaModel.split(':')[0]);
    checks.push({
      icon: hasModel ? '✅' : '⚠️',
      title: 'AI (Ollama)',
      detail: hasModel
        ? `${config.ollamaModel} ready — free chat + multi-step tasks + OCR answers`
        : `Ollama is up but "${config.ollamaModel}" isn't pulled (have: ${ollama.models.slice(0, 4).join(', ') || 'none'})`,
      fix: hasModel ? null : `ollama pull ${config.ollamaModel}`,
    });
  } else if (cloudKey) {
    checks.push({ icon: '✅', title: 'AI', detail: `${cloudKey} free tier (Ollama not running: ${ollama.detail})` });
  } else {
    checks.push({
      icon: '⚠️',
      title: 'AI brain',
      detail: 'No Ollama and no free API key — built-in commands and Hinglish intents still work, but free-form chat and multi-step tasks do not.',
      fix: 'sudo dnf install ollama && sudo systemctl enable --now ollama && ollama pull llama3.2',
    });
  }

  // ── 5. Access + WhatsApp ──────────────────────────────────────────────────
  checks.push({
    icon: 'ℹ️',
    title: 'Access',
    detail: `level ${config.accessLevel} · shell ${config.allowShell ? 'ON (PIN)' : 'off'} · input ${config.allowPcControl ? 'on' : 'OFF (ALLOW_PC_CONTROL=false)'}`,
    fix: config.allowPcControl ? null : 'set ALLOW_PC_CONTROL=true in whatsapp-agent/.env',
  });
  if (ctx.waStatus) checks.push({ icon: 'ℹ️', title: 'WhatsApp', detail: String(ctx.waStatus) });
  const free = diskFree();
  if (free) checks.push({ icon: 'ℹ️', title: 'Disk free', detail: `${free} in ${os.homedir()}` });

  // ── 6. Compose ────────────────────────────────────────────────────────────
  const fails = checks.filter((c) => c.icon === '❌');
  const warns = checks.filter((c) => c.icon === '⚠️');
  const oks = checks.filter((c) => c.icon === '✅');

  const head = fails.length
    ? '🩺 *Doctor* — kuch cheezein band hain, neeche fix likha hai'
    : warns.length
      ? '🩺 *Doctor* — sab chal raha hai, thodi optional cheezein missing hain'
      : '🩺 *Doctor* — sab theek hai ✅';

  const meta = [
    `OS: ${osPretty()} · session: ${session.type}${session.waylandDisplay ? ` (${session.waylandDisplay})` : ''}${session.display ? ` (${session.display})` : ''}`,
    shot && !shot.unknown ? `Screen: ${shot.width}×${shot.height}` : null,
  ].filter(Boolean).join('\n');

  const sections = [];
  const render = (list) => list.map((c) => line(c.icon, c.title, c.detail, c.fix)).join('\n');
  if (fails.length) sections.push(`❌ *Fix these first*\n${render(fails)}`);
  if (warns.length) sections.push(`⚠️ *Optional / next*\n${render(warns)}`);
  if (oks.length) sections.push(`✅ *Working*\n${render(oks)}`);

  const tail = fails.length
    ? '\n\n_Details: /help · Fedora guide: FEDORA.md · logs: journalctl --user -u observer-whatsapp-agent -f_'
    : '\n\n_Sab commands: /help_';
  return `${head}\n${meta}\n\n${sections.join('\n\n')}${tail}`.slice(0, 3900);
}

export { ollamaState, osPretty };
