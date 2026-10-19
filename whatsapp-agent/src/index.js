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
const bridge = createBridgeServer({ config, store, whatsapp, mailbox, log: console });
const stopReminders = startReminderLoop(store, (text) => whatsapp.sendToOwner(text), console);

console.info('');
console.info('👁️  Observer WhatsApp Agent — free native WhatsApp');
console.info(`   Owner (only listener): +${config.ownerNumber}`);
console.info(`   Agent WhatsApp number: +${config.agentNumber}`);
console.info(`   Mode: ${dryRun ? 'DRY-RUN (no WhatsApp connection)' : config.usePairingCode ? 'link by pairing code' : 'link by QR scan'}`);
console.info(`   AI: ${config.aiProvider} (Ollama ${config.ollamaModel} @ ${config.ollamaUrl})`);
console.info(`   Forward plain messages to Observer tab: ${config.forwardToObserver}`);
console.info('');

await bridge.start();
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
