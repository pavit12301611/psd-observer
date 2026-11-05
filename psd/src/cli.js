#!/usr/bin/env node
// cli.js — `psd` on the command line. Same brain as the notch and the phone.
//
//   psd                  interactive chat
//   psd "open chrome"    one-shot
//   psd ask "…"          one-shot (explicit)
//   psd tool <name> [json]
//   psd status           daemon + brain + surfaces
//   psd doctor           what works, what is missing, the exact fix
//   psd token            print the API token
//   psd agents|skills    what is installed
//   psd approve <id>     confirm a parked destructive action

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig, VERSION } from './config.js';

const args = process.argv.slice(2);
const command = args[0] ?? '';

function base() {
  const config = loadConfig();
  return { config, url: `http://127.0.0.1:${config.port}`, token: config.token };
}

async function call(config, path, { method = 'GET', body = null, timeout = 180_000 } = {}) {
  const res = await fetch(`http://127.0.0.1:${config.port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-psd-token': config.token },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: { text } }; }
}

async function daemon(config) {
  try {
    const { data } = await call(config, '/health', { timeout: 2500 });
    return data;
  } catch { return null; }
}

function print(status, data) {
  if (status >= 400 && data?.error) {
    console.error(`✗ ${data.detail || data.error}`);
    process.exit(1);
  }
}

// ── status ─────────────────────────────────────────────────────────────────
async function showStatus() {
  const { config } = base();
  const health = await daemon(config);
  if (!health) {
    console.log('✗ The PSD daemon is not running on this port.');
    console.log(`  Start it:  psd serve        (or: systemctl --user start psd-agent)`);
    console.log(`  Port:      ${config.port}   Data: ${config.dataDir}`);
    return;
  }
  const { data } = await call(config, '/psd/status?probe=1');
  const line = (key, value) => console.log(`  ${key.padEnd(11)} ${value}`);
  console.log(`\n  ◆ PSD ${data.version} — ${data.agentName ?? 'psd'}`);
  line('host', `${data.host} · ${data.platform}`);
  line('uptime', `${data.uptimeSec}s`);
  line('brain', data.brain.healthy ? `${data.brain.model} (${data.brain.active})` : 'offline intents only');
  for (const brain of data.brain.brains ?? []) {
    line(`  ${brain.id}`, brain.ok ? `ok · ${brain.model ?? ''}` : `✗ ${brain.error}`);
  }
  line('notch', data.surfaces.notch.available ? 'connected' : `not connected (${data.surfaces.notch.lastError || 'extension off'})`);
  line('whatsapp', data.surfaces.whatsapp.linked ? `linked · ${data.surfaces.whatsapp.whatsapp}` : `not linked (${data.surfaces.whatsapp.lastError || 'agent not running'})`);
  line('access', `${data.access.level} · ${data.access.tools} tools · shell ${data.access.shell ? 'on' : 'off'}`);
  line('agents', (data.agents ?? []).map((a) => a.id).join(', '));
  line('skills', (data.skills ?? []).map((s) => s.id).join(', ') || 'none');
  line('system', `cpu ${data.system?.cpu ?? '—'}% · mem ${data.system?.mem ?? '—'}% · battery ${data.system?.battery?.percent ?? 'AC'}`);
  console.log('');
}

// ── doctor ─────────────────────────────────────────────────────────────────
async function doctor() {
  const { config } = base();
  const checks = [];
  const add = (name, ok, detail, fix = '') => checks.push({ name, ok, detail, fix });

  add('node', true, process.version);
  add('data dir', fs.existsSync(config.dataDir), config.dataDir, `mkdir -p ${config.dataDir}`);

  const health = await daemon(config);
  add('daemon', Boolean(health), health ? `http://127.0.0.1:${config.port}` : 'not running', 'psd serve   # or: systemctl --user start psd-agent');

  if (health) {
    const { data } = await call(config, '/psd/status?probe=1');
    const brains = data.brain.brains ?? [];
    // A model is optional: intents answer most desk questions in milliseconds.
    // The check passes as long as one brain answers — say which one.
    const modelBrains = brains.filter((b) => b.ok && b.kind !== 'intents');
    const intents = brains.find((b) => b.kind === 'intents');
    add('brain', modelBrains.length > 0 || Boolean(intents),
      modelBrains.length > 0
        ? `${modelBrains[0].model || modelBrains[0].id} via ${modelBrains[0].id}`
        : 'no model — offline intents answer tool questions (10–150 ms)',
      modelBrains.length > 0 ? '' : 'ollama pull qwen3:8b   # optional: free-form questions');
    add('notch d-bus', data.surfaces.notch.available, data.surfaces.notch.available ? `gdbus ${config.notchBus}` : (data.surfaces.notch.lastError || 'silent'),
      'gnome-extensions enable notch@pavit12301611.github.io');
    add('whatsapp bridge', data.surfaces.whatsapp.linked || Boolean(data.surfaces.whatsapp.tokenConfigured),
      data.surfaces.whatsapp.linked ? `linked to +${data.surfaces.whatsapp.agent}` : (data.surfaces.whatsapp.lastError || 'no token found'),
      'Start the WhatsApp agent, or set PSD_WHATSAPP_URL + PSD_WHATSAPP_TOKEN');
  }

  for (const [name, binary, why, pkg] of [
    ['gdbus', 'gdbus', 'notch push + notifications', 'glib2'],
    ['notify-send', 'notify-send', 'desktop notifications', 'libnotify'],
    ['grim', 'grim', 'Wayland screenshots', 'grim'],
    ['wmctrl', 'wmctrl', 'window list/focus', 'wmctrl'],
    ['ydotool', 'ydotool', 'typing and clicking', 'ydotool'],
    ['wl-copy', 'wl-copy', 'clipboard', 'wl-clipboard'],
    ['playerctl', 'playerctl', 'music control', 'playerctl'],
    ['wpctl', 'wpctl', 'volume', 'wireplumber-utils'],
    ['gsettings', 'gsettings', 'dark mode / night light / DND', 'glib2'],
  ]) {
    const found = await new Promise((resolve) => {
      import('node:child_process').then(({ execFile }) => {
        execFile('sh', ['-lc', `command -v ${binary}`], { timeout: 3000 }, (err) => resolve(!err));
      });
    });
    add(name, found, found ? 'installed' : 'missing', found ? '' : `sudo dnf install ${pkg}   # ${why}`);
  }

  console.log(`\n  PSD doctor — ${VERSION}\n`);
  let failures = 0;
  for (const check of checks) {
    const mark = check.ok ? '✓' : '✗';
    console.log(`  ${mark} ${check.name.padEnd(16)} ${check.detail}`);
    if (!check.ok) {
      failures += 1;
      if (check.fix) console.log(`     → ${check.fix}`);
    }
  }
  console.log(`\n  ${checks.length - failures}/${checks.length} checks passed${failures ? ` — ${failures} to fix` : ' — nothing to fix'}\n`);
}

// ── one-shot / interactive ─────────────────────────────────────────────────
async function ask(text, { source = 'cli', json = false } = {}) {
  const { config } = base();
  const health = await daemon(config);
  if (!health) {
    console.error('✗ PSD is not running. Start it with `psd serve` (or `systemctl --user start psd-agent`).');
    process.exit(1);
  }
  const { data } = await call(config, '/psd/chat', { method: 'POST', body: { text, source } });
  if (json) return console.log(JSON.stringify(data, null, 2));
  console.log(data.text ?? '');
  if (data.toolsUsed?.length) console.log(`\n  ${data.path} · ${data.toolsUsed.join(', ')} · ${data.ms}ms`);
}

async function repl() {
  const { config } = base();
  const health = await daemon(config);
  if (!health) {
    console.error('✗ PSD is not running. Start it with `psd serve` in another terminal.');
    process.exit(1);
  }
  console.log(`\n  ◆ PSD ${VERSION} — type a message, /help for commands, /exit to quit.\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '  › ' });
  const askOnce = (question) => new Promise((resolve) => rl.question(question, resolve));
  rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) { rl.prompt(); continue; }
    if (['/exit', '/quit', 'exit', 'quit'].includes(line)) break;
    if (line === '/status') { await showStatus(); rl.prompt(); continue; }
    if (line === '/help') {
      console.log('  /status  daemon, brain, surfaces\n  /exit    quit\n  anything else is a message to PSD.');
      rl.prompt(); continue;
    }
    const { data } = await call(config, '/psd/chat', { method: 'POST', body: { text: line, source: 'cli' } });
    const banner = data.path && data.path !== 'quick' ? `  [${data.path}${data.toolsUsed?.length ? ` · ${data.toolsUsed.join(', ')}` : ''} · ${data.ms}ms]` : '';
    console.log(`\n  ${String(data.text ?? '').split('\n').join('\n  ')}\n`);
    if (banner) console.log(`${banner}\n`);
    if (data.needsConfirmation) {
      const answer = (await askOnce('  approve? [y/N] ')).trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') {
        const { data: approved } = await call(config, '/psd/approve', { method: 'POST', body: { id: data.approvalId } });
        console.log(`  ${approved.text ?? ''}`);
      } else {
        await call(config, '/psd/approve', { method: 'POST', body: { id: data.approvalId, approve: false } });
        console.log('  cancelled.');
      }
    }
    rl.prompt();
  }
  rl.close();
  console.log('');
}

// ── entry ──────────────────────────────────────────────────────────────────
const rest = args.slice(1);
switch (command) {
  case '': case 'chat': case 'repl':
    await repl();
    break;
  case 'ask': case 'run': case '-c': case '--ask':
    await ask(rest.join(' '), { json: args.includes('--json') });
    break;
  case 'serve': case 'start': {
    const { start } = await import('./index.js');
    await start();
    break;
  }
  case 'status': case 'st':
    await showStatus();
    break;
  case 'doctor': case 'check':
    await doctor();
    break;
  case 'token': {
    const { config } = base();
    console.log(config.token);
    break;
  }
  case 'url': {
    const { config } = base();
    const ip = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    console.log(`http://${ip ?? '127.0.0.1'}:${config.port}/?token=${config.token}`);
    break;
  }
  case 'agents': case 'skills': {
    const { createAgentLibrary } = await import('./agents.js');
    const { config } = base();
    const library = createAgentLibrary(config);
    library.load({ force: true });
    console.log(`\n  Agents (${library.agents.length})`);
    for (const agent of library.agents) console.log(`  · ${agent.id.padEnd(14)} ${agent.description}`);
    console.log(`\n  Skills (${library.skills.length})`);
    for (const skill of library.skills) console.log(`  · ${skill.id.padEnd(14)} ${skill.description}`);
    console.log('');
    break;
  }
  case 'tools': {
    const { createTools } = await import('./tools.js');
    const { createNotch } = await import('./notch.js');
    const { createWhatsApp } = await import('./whatsapp.js');
    const { Memory } = await import('./memory.js');
    const { config } = base();
    const memory = new Memory(config);
    const tools = createTools({ config, memory, notch: createNotch(config), whatsapp: createWhatsApp(config) });
    console.log(`\n  Access ${tools.level()} · ${tools.registry.length} tools\n`);
    for (const tool of tools.registry) {
      const gate = tool.destructive ? ' (confirm)' : tool.requiresShell ? ' (shell)' : '';
      console.log(`  · ${tool.name.padEnd(18)} ${tool.level.padEnd(9)} ${tool.description.split('.')[0]}${gate}`);
    }
    console.log('');
    break;
  }
  case 'tool': {
    const { config } = base();
    const name = rest[0];
    if (!name) { console.error('usage: psd tool <name> [json-args]'); process.exit(1); }
    let toolArgs = {};
    if (rest[1]) { try { toolArgs = JSON.parse(rest.slice(1).join(' ')); } catch { console.error('args must be JSON'); process.exit(1); } }
    const { data } = await call(config, '/psd/tool', { method: 'POST', body: { tool: name, args: toolArgs } });
    console.log(data.text ?? JSON.stringify(data, null, 2));
    break;
  }
  case 'approve': {
    const { config } = base();
    if (!rest[0]) { console.error('usage: psd approve <id>'); process.exit(1); }
    const { data } = await call(config, '/psd/approve', { method: 'POST', body: { id: rest[0] } });
    console.log(data.text ?? JSON.stringify(data, null, 2));
    break;
  }
  case 'notify': {
    const { config } = base();
    const { data } = await call(config, '/psd/notch/message', {
      method: 'POST',
      body: { kind: 'card', title: 'PSD', body: rest.join(' ') || 'hello from the terminal', tab: 'chat', open: true },
    });
    console.log(data.delivered ? 'shown in the notch' : 'queued — the notch extension is not answering');
    break;
  }
  case 'version': case '--version': case '-v':
    console.log(VERSION);
    break;
  case 'help': case '--help': case '-h':
  default:
    console.log(`
  PSD ${VERSION} — personal agent for the notch, the phone and WhatsApp

  psd                      interactive chat
  psd "open chrome"        one-shot message
  psd ask "…"  [--json]    one-shot, machine-readable with --json
  psd serve                run the daemon in the foreground
  psd status               daemon, brain, surfaces, system
  psd doctor               what works here, and the exact fix for what does not
  psd tool <name> [json]   run one tool directly
  psd approve <id>         confirm a parked destructive action
  psd notify "text"        push a card into the notch now
  psd agents | skills      list installed agents and skills
  psd tools                list tools with their permission level
  psd token | url          the API token / the phone-app URL
  psd version

  Docs: psd/README.md
`);
    break;
}
