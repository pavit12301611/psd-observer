#!/usr/bin/env node
// index.js — entry point. `npm start` (real WhatsApp) or `npm run demo`
// (--dry-run: bridge + dashboard + command engine, no WhatsApp connection).
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { Store, startReminderLoop } from './store.js';
import { Mailbox } from './mailbox.js';
import { createAgent } from './commands.js';
import { createWhatsApp } from './whatsapp.js';
import { createBridgeServer } from './server.js';
import { distroPrettyName } from './tools.js';
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
});

const whatsapp = createWhatsApp({ config, store, agent, log: console });
const bridge = createBridgeServer({
  config,
  store,
  whatsapp,
  mailbox,
  actions: agent.actions,
  runOwner: (text) => whatsapp.runOwner(text),
  log: console,
});
const stopReminders = startReminderLoop(store, (text) => whatsapp.sendToOwner(text), console);

console.info('👁️  Observer WhatsApp Agent — free, native WhatsApp + phone app');
console.info(`   Owner (only listener): +${config.ownerNumber}`);
console.info(`   Agent WhatsApp number: +${config.agentNumber}`);
console.info(`   Mode: ${dryRun ? 'DRY-RUN (no WhatsApp connection)' : config.usePairingCode ? 'link by pairing code' : 'link by QR scan'}`);
console.info(`   AI: ${config.aiProvider} (Ollama ${config.ollamaModel} @ ${config.ollamaUrl}) · tools ${config.agentTools ? 'on' : 'off'}`);
console.info(`   Access level: ${config.accessLevel} · full PC control (Observer app optional)`);
console.info(`   Shell: ${config.allowShell ? 'enabled (PIN)' : 'off (ALLOW_SHELL=false)'}`);
const distroLine = distroPrettyName();
if (distroLine) console.info(`   OS: ${distroLine}`);
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
await whatsapp.start();

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
function shutdown() {
  console.info('\n[agent] shutting down…');
  stopReminders();
  whatsapp.stop();
  bridge.stop();
  store.saveNow();
  process.exit(0);
}
