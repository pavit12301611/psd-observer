// systemx.js — the extra system-level actions that make the PC feel like a
// remote assistant: Wi-Fi, Bluetooth, services, processes, webcam, screen
// recording, notifications.
//
// Everything is execFile with fixed argv. Missing tools produce the exact dnf
// install line. Commands that need root say so honestly instead of pretending.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { findBin, displayEnv } from './pccontrol.js';
import { humanSize } from './files.js';

const execFileAsync = promisify(execFile);
const RUN_TIMEOUT = 10_000;

async function run(bin, args, opts = {}) {
  const { stdout, stderr } = await execFileAsync(bin, args, {
    timeout: opts.timeout ?? RUN_TIMEOUT,
    env: displayEnv(),
    maxBuffer: 4 * 1024 * 1024,
    ...opts,
  });
  return `${stdout}${stdout && stderr ? '\n' : ''}${stderr}`.trim();
}

// ── Wi-Fi (NetworkManager) ────────────────────────────────────────────────────

async function nmcli() {
  const bin = findBin('nmcli');
  if (!bin) throw new Error('Wi-Fi control needs NetworkManager: sudo dnf install NetworkManager (nmcli)');
  return bin;
}

export async function wifiStatus() {
  const bin = await nmcli();
  const enabledRaw = await run(bin, ['-t', '-f', 'WIFI', 'general']).catch(() => '');
  const enabled = /enabled/i.test(enabledRaw) && !/disabled/i.test(enabledRaw);
  const list = await run(bin, ['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'dev', 'wifi', 'list']).catch(() => '');
  const active = list.split('\n').map((l) => l.split(':')).find((parts) => parts[0] === '*');
  const line = active ? `📶 *${active[1]}* · ${active[2]}% · ${active[3] || 'open'}` : '📶 Not connected to any Wi-Fi network.';
  return `${line}\nRadio: ${enabled ? 'on' : 'off'}\n\n/networks lists nearby · /wifi on|off · /wifi connect <SSID> [password]`;
}

export async function wifiSet(action) {
  const bin = await nmcli();
  if (action === 'on' || action === 'off') {
    await run(bin, ['radio', 'wifi', action]);
    return action === 'on' ? '📶 Wi-Fi turned on.' : '📴 Wi-Fi turned off. (I\'m still reachable on WhatsApp through mobile data? The PC is offline now.)';
  }
  if (action === 'status') return wifiStatus();
  if (action === 'list') {
    const out = await run(bin, ['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'dev', 'wifi', 'list']);
    const rows = out.split('\n').map((l) => l.split(':')).filter((p) => p[1]);
    if (!rows.length) return '📶 No networks found. Is Wi-Fi turned on? /wifi on';
    return '📶 *Nearby networks*\n\n' + rows.slice(0, 15).map((p) => `${p[0] === '*' ? '✅' : '•'} ${p[1]} (${p[2]}%${p[3] ? `, ${p[3]}` : ''})`).join('\n') +
      '\n\nJoin: /wifi connect <SSID> [password]';
  }
  throw new Error('usage: /wifi on|off|status|list|connect <SSID> [password]');
}

export async function wifiConnect(ssid, password) {
  const bin = await nmcli();
  const name = String(ssid ?? '').trim();
  if (!name) throw new Error('usage: /wifi connect <SSID> [password]');
  const args = ['dev', 'wifi', 'connect', name];
  if (password) args.push('password', String(password));
  try {
    const out = await run(bin, args, { timeout: 45_000 });
    return `📶 Connected to *${name}*.\n${out.split('\n').slice(-2).join('\n')}`;
  } catch (err) {
    const msg = String(err.stderr || err.message || '').slice(-400);
    throw new Error(`Couldn't join "${name}": ${msg}\nIf it says "not authorized", join it once from the Fedora desktop, or run the agent as a user with NetworkManager permission.`);
  }
}

// ── Bluetooth ────────────────────────────────────────────────────────────────

export async function bluetoothStatus() {
  const bin = findBin('bluetoothctl');
  if (!bin) throw new Error('Bluetooth needs bluez: sudo dnf install bluez');
  const show = await run(bin, ['show']).catch(() => '');
  const powered = /Powered:\s*yes/i.test(show);
  const name = show.match(/Name:\s*(.+)/)?.[1]?.trim();
  const devices = await run(bin, ['devices']).catch(() => '');
  const lines = devices.split('\n').filter(Boolean).slice(0, 10).map((l) => {
    const m = l.match(/^Device\s+(\S+)\s+(.*)$/);
    return m ? `• ${m[2]} (${m[1]})` : null;
  }).filter(Boolean);
  return `🔵 Bluetooth: *${powered ? 'on' : 'off'}*${name ? ` · ${name}` : ''}\n${lines.length ? `\nPaired:\n${lines.join('\n')}` : '\nNo paired devices.'}`;
}

export async function bluetoothSet(action) {
  const bin = findBin('bluetoothctl');
  if (!bin) throw new Error('Bluetooth needs bluez: sudo dnf install bluez');
  if (action === 'on' || action === 'off') {
    await run(bin, ['power', action]).catch((err) => {
      const msg = String(err.stderr || err.message);
      if (/not available|no default controller/i.test(msg)) throw new Error('This PC has no Bluetooth adapter (or it is rfkill-blocked: sudo rfkill unblock bluetooth).');
      throw err;
    });
    return action === 'on' ? '🔵 Bluetooth on.' : '🔵 Bluetooth off.';
  }
  return bluetoothStatus();
}

// ── systemd services ─────────────────────────────────────────────────────────

function serviceName(raw) {
  const name = String(raw ?? '').trim();
  if (!/^[\w@.:-]+$/.test(name)) throw new Error('usage: /svc status <name> · /svc restart <name>  (simple service names only)');
  return name;
}

export async function serviceStatus(raw) {
  const name = serviceName(raw);
  let out = '';
  try { out = await run('systemctl', ['--user', 'status', name, '--no-pager', '-n', '4']); }
  catch (err) { out = String(err.stdout || err.stderr || err.message); }
  if (!out || /could not be found|not found/i.test(out)) {
    try { out = await run('systemctl', ['status', name, '--no-pager', '-n', '4']); }
    catch (err) { out = String(err.stdout || err.stderr || err.message); }
  }
  const state = out.match(/Active:\s*(\S+)\s*\(([^)]*)\)/);
  return `⚙️ *${name}*: ${state ? `${state[1]} (${state[2]})` : 'unknown'}\n\`\`\`\n${out.split('\n').slice(0, 12).join('\n').slice(0, 1500)}\n\`\`\``;
}

export async function serviceRestart(raw) {
  const name = serviceName(raw);
  try {
    await run('systemctl', ['--user', 'restart', name], { timeout: 60_000 });
    return `⚙️ Restarted *${name}* (user service).`;
  } catch (userErr) {
    try {
      await run('systemctl', ['restart', name], { timeout: 60_000 });
      return `⚙️ Restarted *${name}* (system service).`;
    } catch {
      throw new Error(`Couldn't restart "${name}". System services need root: \`sudo systemctl restart ${name}\` — or enable /run and do it from here.`);
    }
  }
}

// ── processes ────────────────────────────────────────────────────────────────

export async function killProcess(query, signal = 'TERM') {
  const needle = String(query ?? '').trim();
  if (!needle) throw new Error('usage: /kill <process name>');
  if (needle.length < 3) throw new Error('Give at least 3 characters so I don\'t kill something random.');
  const pgrep = findBin('pgrep');
  if (!pgrep) throw new Error('pgrep not found (procps-ng): sudo dnf install procps-ng');
  const out = await run(pgrep, ['-f', '--', needle]).catch(() => '');
  const pids = out.split('\n').map((s) => Number.parseInt(s, 10)).filter((n) => Number.isFinite(n) && n > 1 && n !== process.pid);
  if (!pids.length) return `🔎 No running process matches "${needle}".`;
  const killed = [];
  for (const pid of pids.slice(0, 10)) {
    try { process.kill(pid, signal === 'KILL' ? 'SIGKILL' : 'SIGTERM'); killed.push(pid); } catch { /* gone */ }
  }
  return `🛑 Sent SIG${signal} to ${killed.length} process(es) matching "${needle}" (PID ${killed.join(', ')}).${signal === 'TERM' ? '\nStill alive? /kill!' : ''}`;
}

// ── webcam / screen recording ────────────────────────────────────────────────

export async function webcamPhoto() {
  const file = path.join(os.tmpdir(), `observer-cam-${Date.now()}.jpg`);
  const ffmpeg = findBin('ffmpeg');
  const fswebcam = findBin('fswebcam');
  if (!ffmpeg && !fswebcam) throw new Error('Webcam capture needs ffmpeg: sudo dnf install ffmpeg');
  try {
    if (ffmpeg) {
      await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'v4l2', '-i', '/dev/video0', '-frames:v', '1', '-y', file], { timeout: 20_000, env: displayEnv() });
    } else {
      await execFileAsync(fswebcam, ['-d', '/dev/video0', '--no-banner', file], { timeout: 20_000, env: displayEnv() });
    }
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error('empty capture');
    return { image: fs.readFileSync(file), text: '📸 Webcam photo from your PC' };
  } catch (err) {
    const msg = String(err.stderr || err.message || '');
    if (/no such file|not found|cannot open/i.test(msg)) throw new Error('No webcam found (/dev/video0). Is one connected and not in use?');
    throw new Error(`Webcam capture failed: ${msg.split('\n').slice(-1)[0].slice(0, 200)}`);
  } finally {
    try { fs.unlinkSync(file); } catch { /* noop */ }
  }
}

/** Record the screen for N seconds and return an MP4 buffer (≤ 50 MB). */
export async function recordScreen(seconds = 10) {
  const secs = Math.min(Math.max(Number(seconds) || 10, 2), 120);
  const file = path.join(os.tmpdir(), `observer-rec-${Date.now()}.mp4`);
  const wayland = (process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland';
  const ffmpeg = findBin('ffmpeg');
  const wf = findBin('wf-recorder');
  try {
    if (wayland && wf) {
      await new Promise((resolve, reject) => {
        const child = spawn(wf, ['-f', file, '-y'], { env: displayEnv(), stdio: 'ignore' });
        const timer = setTimeout(() => { try { child.kill('SIGINT'); } catch { /* noop */ } }, secs * 1000);
        child.once('error', (err) => { clearTimeout(timer); reject(err); });
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    } else if (ffmpeg) {
      const display = process.env.DISPLAY || ':0';
      const size = await screenSize();
      await execFileAsync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-video_size', size,
        '-i', display, '-t', String(secs), '-pix_fmt', 'yuv420p', '-y', file,
      ], { timeout: (secs + 30) * 1000, env: displayEnv() });
    } else {
      throw new Error('Screen recording needs ffmpeg (X11) or wf-recorder (Wayland): sudo dnf install ffmpeg wf-recorder');
    }
    if (!fs.existsSync(file) || fs.statSync(file).size < 1024) throw new Error('recording produced no video (Wayland? install wf-recorder)');
    const size = fs.statSync(file).size;
    if (size > 50 * 1024 * 1024) throw new Error(`Recording is ${humanSize(size)} — too big for WhatsApp. Record fewer seconds.`);
    return { video: fs.readFileSync(file), text: `🎥 Screen recording (${secs}s, ${humanSize(size)})` };
  } finally {
    try { fs.unlinkSync(file); } catch { /* noop */ }
  }
}

async function screenSize() {
  const xrandr = findBin('xrandr');
  if (xrandr) {
    try {
      const out = await run(xrandr, ['--current'], { timeout: 5_000 });
      const m = out.match(/current\s+(\d+)\s*x\s*(\d+)/);
      if (m) return `${m[1]}x${m[2]}`;
    } catch { /* fall through */ }
  }
  return '1920x1080';
}

// ── notifications ────────────────────────────────────────────────────────────

export async function notify(text, title = 'Observer Agent') {
  const message = String(text ?? '').trim();
  if (!message) throw new Error('usage: /notify <text>');
  const bin = findBin('notify-send');
  if (!bin) throw new Error('Desktop notifications need libnotify: sudo dnf install libnotify');
  await execFileAsync(bin, [title, message.slice(0, 1000)], { timeout: 5_000, env: displayEnv() });
  return '🔔 Notification sent to the PC.';
}

// ── extras ───────────────────────────────────────────────────────────────────

export async function uptimeInfo() {
  let boot = '';
  try {
    const since = await run('uptime', ['-p']);
    boot = since;
  } catch { /* noop */ }
  return `⏱️ PC ${boot || `up ${(os.uptime() / 3600).toFixed(1)} h`} · load ${os.loadavg()[0].toFixed(2)}`;
}

export async function audioStatus() {
  const wpctl = findBin('wpctl');
  if (!wpctl) return '🔊 Install wireplumber for volume status (wpctl).';
  const out = await run(wpctl, ['get-volume', '@DEFAULT_AUDIO_SINK@']).catch(() => '');
  const m = out.match(/Volume:\s*([\d.]+)/);
  return m ? `🔊 Volume ${Math.round(Number(m[1]) * 100)}%${/MUTED/.test(out) ? ' (muted)' : ''}` : '🔊 Volume status unavailable.';
}
