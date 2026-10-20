#!/usr/bin/env node
// index.js — entry point. `npm start` (real WhatsApp) or `npm run demo`
// (--dry-run: bridge + dashboard + command engine, no WhatsApp connection).
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { Store, startReminderLoop } from './store.js';
import { startCronLoop } from './cron.js';
import { Mailbox } from './mailbox.js';
import { createAgent } from './commands.js';
import { createWhatsApp } from './whatsapp.js';
import { createBridgeServer } from './server.js';
import { announceUpdate, brainSummary } from './updates.js';
import { startWatchLoop } from './watch.js';
import { startShotJanitor } from './screenshots.js';
import { distroPrettyName } from './tools.js';
import { sessionInfo, inputDiagnostics } from './pccontrol.js';
import { routerFor } from './router.js';
import os from 'node:os';

// Set by systemd for every service (user services included on Fedora).
const underSystemd = Boolean(process.env.INVOCATION_ID || process.env.NOTIFY_SOCKET);

const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';

let config;
try {
  config = loadConfig({ dryRun });
} catch (err) {
  console.error(`\n❌ ${err.message}\n`);
  process.exit(1);
}

for (const dir of [config.dataDir, config.downloadsDir, config.sharedDir]) fs.mkdirSync(dir, { recursive: true });

const store = new Store(config.storeFile);
store.data.stats.startedAt = Date.now(); // uptime = this process, not first-ever run
const mailbox = new Mailbox({ waitMs: config.observerWaitMs });

const agent = createAgent({
  config,
  store,
  log: console,
  forwardToObserver: (text) => mailbox.forwardToObserver(text),
  observerOnline: () => mailbox.observerOnline(),
  // Live "step 2/8" lines and watch alerts come out of the agent itself, not
  // as a reply — this is the only channel for unsolicited messages.
  notify: (message) => whatsapp.sendToOwner(message),
});

const whatsapp = createWhatsApp({
  config, store, agent, log: console,
  // Runs on every successful WhatsApp connect; announceUpdate() is idempotent
  // (it compares against store.lastVersion), so reconnects stay quiet.
  onConnected: () => announceUpdate({
    config,
    store,
    log: console,
    send: (text) => whatsapp.sendToOwner(text),
    brains: brainSummary(routerFor(config, console).catalog),
  }),
});
const bridge = createBridgeServer({
  config,
  store,
  whatsapp,
  mailbox,
  actions: agent.actions,
  harness: agent.harness,
  runOwner: (text) => whatsapp.runOwner(text),
  log: console,
});
const stopReminders = startReminderLoop(store, (text) => whatsapp.sendToOwner(text), console);
// Scheduled jobs that are commands ("/brief") run through the agent, exactly
// like typing them — one code path, same safety gates.
const stopCron = startCronLoop(
  store,
  (text) => whatsapp.sendToOwner(text),
  console,
  (text) => agent.handle(text, { source: 'cron' }),
);
// Screenshots are disposable: the janitor deletes every capture after a few
// minutes (default 4). Uses the agent's own ledger so /shots shows the truth.
const stopShots = startShotJanitor({ config, log: console, janitor: agent.shots });
// /watch: screen-condition watchers, checked on their own timers.
const stopWatch = startWatchLoop({
  config,
  store,
  send: (message) => whatsapp.sendToOwner(message),
  log: console,
});

console.info('👁️  Observer WhatsApp Agent — free, native WhatsApp + phone app');
console.info(`   Owner (only listener): +${config.ownerNumber}`);
console.info(`   Agent WhatsApp number: +${config.agentNumber}`);
console.info(`   Mode: ${dryRun ? 'DRY-RUN (no WhatsApp connection)' : config.usePairingCode ? 'link by pairing code' : 'link by QR scan'}`);
console.info(`   AI: ${config.aiProvider} (Ollama ${config.ollamaModel} @ ${config.ollamaUrl}) · tools ${config.agentTools ? 'on' : 'off'}`);
{
  const catalog = routerFor(config, console).catalog;
  const localCount = catalog.filter((m) => m.local).length;
  console.info(`   Brains: ${catalog.length || 'none'} (${localCount} local) · routing prefers ${config.routerPrefer} · heavy ${config.maxHeavyPerHour || '∞'}/hour`);
  if (!catalog.length) console.info('   No AI brain yet: install Ollama (free) or set GROQ_API_KEY / GEMINI_API_KEY — direct commands still work.');
}
console.info(`   Access level: ${config.accessLevel} · full PC control (Observer app optional)`);
console.info(`   Shell: ${config.allowShell ? 'enabled (PIN)' : 'off (ALLOW_SHELL=false)'}`);
console.info(`   Cron jobs: ${store.listCronJobs().length} recurring · TTS: ${config.ttsEngine}`);
const distroLine = distroPrettyName();
if (distroLine) console.info(`   OS: ${distroLine}`);
// Say up-front whether screen control can work at all in this session — this
// is the #1 reason "it can't operate my PC" (boot-time service, no desktop yet).
const session = sessionInfo();
const input = inputDiagnostics();
console.info(`   Desktop: ${session.graphical ? `${session.type} session detected` : 'none detected yet — log in on the PC, then restart the service'}`
  + ` · keyboard/mouse: ${input.ydotoolDaemon ? 'ydotool ready' : input.xdotool ? 'xdotool' : input.wtype ? 'wtype' : 'not available (run ./scripts/fix-desktop.sh)'}`);
if (!session.graphical || !(input.ydotoolDaemon || input.xdotool || input.wtype)) {
  console.info('   If screenshots/typing fail, send /doctor on WhatsApp — it prints the exact fix.');
}
if (underSystemd) console.info('   Running under systemd — logs: journalctl --user -u observer-whatsapp-agent -f');

const lanIps = Object.values(os.networkInterfaces()).flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal)
  .map((n) => n.address);
const appHost = config.host === '0.0.0.0' ? (lanIps[0] ?? 'PC-IP') : config.host;
console.info('');
console.info(`   📱 Phone app: http://${appHost}:${config.port}/   (PIN: ${config.dashboardPin})`);
if (config.host === '0.0.0.0') {
  console.info(`   LAN IPs: ${lanIps.join(', ') || 'none'} — same Wi-Fi as the phone.`);
  console.info('   Only your PIN/token opens it. HOST=127.0.0.1 in .env restricts it to this PC.');
}
console.info('');

try {
  await bridge.start();
} catch (err) {
  console.error(`\n❌ ${err.message}\n`);
  process.exit(1);
}
if (config.dshAutoStartWeb && agent.harness) {
  agent.harness.startWeb().then((ws) => {
    console.info(`   🚀 DeepSeek Harness Web UI: ${ws.localUrl}`);
    if (ws.lanUrls?.length) console.info(`   📱 Phone / LAN Harness UI : ${ws.lanUrls[0]}`);
  }).catch((err) => {
    console.warn(`   ⚠️ Could not auto-start dsh web: ${err.message}`);
  });
} else if (agent.harness) {
  const hs = agent.harness.status();
  console.info(`   🚀 DeepSeek Harness: ${hs.installed ? `installed (${hs.version}) · /dsh <task> · /dsh web` : 'auto-installs on first /dsh or /dsh install'}`);
}
await whatsapp.start();

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
async function shutdown() {
  console.info('\n[agent] shutting down…');
  stopReminders();
  stopCron();
  stopWatch();
  stopShots();
  whatsapp.stop();
  bridge.stop();
  await agent.harness?.close?.().catch(() => {});
  store.saveNow();
  process.exit(0);
}
