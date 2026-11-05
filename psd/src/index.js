#!/usr/bin/env node
// index.js — PSD boots here.
//
// Boot order matters for perceived speed: the HTTP server is listening before
// the model is probed, so the notch is usable the instant the service starts.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, enginePlan, VERSION } from './config.js';
import { createBus } from './bus.js';
import { Memory } from './memory.js';
import { createEngine } from './engine.js';
import { createNotch } from './notch.js';
import { createWhatsApp } from './whatsapp.js';
import { createTools, systemSnapshot } from './tools.js';
import { createAgentLibrary } from './agents.js';
import { createRouter } from './router.js';
import { createServer } from './server.js';
import { createOpenAICompat } from './whatsapp-bridge.js';

const args = new Set(process.argv.slice(2));
const quiet = args.has('--quiet');

export async function start({ port = null } = {}) {
  const config = loadConfig();
  if (port) config.port = Number(port);
  fs.mkdirSync(config.dataDir, { recursive: true });

  const bus = createBus();
  const memory = new Memory(config);
  const agents = createAgentLibrary(config);
  agents.load({ force: true });

  const plan = enginePlan(config);
  config.plan = plan;
  const engine = createEngine(config);
  const notch = createNotch(config);
  const whatsapp = createWhatsApp(config);
  const tools = createTools({ config, memory, notch, whatsapp, bus });
  const router = createRouter({ config, engine, tools, memory, agents, notch, whatsapp, bus });

  const openai = createOpenAICompat({ router, tools, agents, config });
  const web = createServer({ config, engine, tools, memory, agents, notch, whatsapp, router, openai, registry: tools.registry, bus });
  const address = await web.listen();

  if (!quiet) {
    const agent = agents.agent(config.agent);
    console.log('');
    console.log(`  ◆ PSD ${VERSION} — personal agent, on your machine`);
    console.log(`   Agent:   ${agent?.name ?? config.agent}${agent?.description ? ` — ${agent.description}` : ''}`);
    console.log(`   Skills:  ${agents.skills.length} · Tools: ${tools.accessReport().tools} (access: ${tools.accessReport().level})`);
    console.log(`   Listening: http://${config.host === '0.0.0.0' ? os.hostname() : config.host}:${config.port}`);
    console.log(`   Token:   ${config.token}`);
    console.log(`   Notch:   ${config.notchBus} · WhatsApp bridge: ${config.whatsappUrl}`);
    console.log(`   Data:    ${config.dataDir}`);
    console.log('');
  }

  // Probe the brain in the background — never block the server on it.
  engine.probe().then((probe) => {
    if (quiet) return;
    if (probe.brain) console.log(`   🧠 Brain: ${probe.brain} · ${probe.model} (${probe.latencyMs}ms)`);
    else console.log('   🧠 No model yet — offline intents are live. `ollama pull qwen3:8b` or set PSD_OPENAI_URL.');
    for (const brain of probe.brains) if (!brain.ok) console.log(`      ✗ ${brain.id}: ${brain.error}`);
  }).catch(() => {});

  notch.probe().then((ok) => {
    if (ok) notch.status({ state: 'idle', ready: true }).catch(() => {});
    else if (!quiet) console.log('   ◻ Notch extension not answering on D-Bus — events will wait in the ring (/psd/notch).');
  }).catch(() => {});

  // ── reminders ────────────────────────────────────────────────────────────
  const reminderTimer = setInterval(async () => {
    for (const reminder of memory.dueReminders()) {
      memory.completeReminder(reminder.id);
      const line = `⏰ ${reminder.text}`;
      tools.byName.get('notification')?.run({ title: 'PSD reminder', body: reminder.text }).catch(() => {});
      await notch.show({ title: 'Reminder', body: reminder.text, tab: 'alerts', open: true });
      await whatsapp.send(line);
      bus({ type: 'reminder', text: reminder.text, id: reminder.id });
    }
  }, 15_000);
  reminderTimer.unref?.();

  // ── whatsapp reconnection + queued sends ─────────────────────────────────
  const whatsappTimer = setInterval(() => {
    whatsapp.status().then((status) => { if (status) whatsapp.flush().catch(() => {}); }).catch(() => {});
  }, 30_000);
  whatsappTimer.unref?.();

  // ── live system mirror for the notch's System tab ────────────────────────
  const systemTimer = setInterval(async () => {
    if (!notch.info.available) return;
    try { await notch.system(await systemSnapshot()); } catch { /* notch closed */ }
  }, 20_000);
  systemTimer.unref?.();

  const shutdown = async (signal) => {
    clearInterval(reminderTimer);
    clearInterval(whatsappTimer);
    clearInterval(systemTimer);
    if (!quiet) console.log(`\n[psd] ${signal} — shutting down.`);
    await web.close().catch(() => {});
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { shutdown(signal); });

  return { config, web, engine, tools, memory, agents, notch, whatsapp, router, openai, bus, address };
}

/** A failure the owner can act on, not a stack trace. */
function explain(err, config) {
  if (err?.code === 'EADDRINUSE') {
    const port = config?.port ?? 7788;
    return [
      `port ${port} is already in use — another PSD (or something else) has it.`,
      '',
      '  if it is an older PSD:',
      '    systemctl --user stop psd-agent      # or: pkill -f "src/index.js"',
      '',
      '  or run this one somewhere else:',
      '    PSD_PORT=7790 psd serve',
      '    # or add PSD_PORT=7790 to ~/.config/psd/env',
    ].join('\n');
  }
  if (err?.code === 'EACCES') return `cannot bind port — ports below 1024 need root. Use PSD_PORT=7788.`;
  return err?.message ?? String(err);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const portArg = process.argv.find((a) => a.startsWith('--port='));
  start({ port: portArg ? portArg.split('=')[1] : null }).catch((err) => {
    const config = (() => { try { return loadConfig(); } catch { return null; } })();
    console.error(`\n✗ PSD did not start: ${explain(err, config)}\n`);
    process.exit(1);
  });
}
