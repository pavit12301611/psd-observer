#!/usr/bin/env node
// Run on the owner's desktop, not on Oracle.
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { createAgent } from './commands.js';
import { createPcRelay } from './oracle-relay.js';

const config = loadConfig();
// No provider, shell, or autonomous tool loop on the PC in this mode.
Object.assign(config, { aiProvider: 'none', needleEnabled: false, layaEnabled: false, allowShell: false });
for (const dir of [config.dataDir, config.downloadsDir, config.sharedDir]) fs.mkdirSync(dir, { recursive: true });
const store = new Store(config.storeFile);
const agent = createAgent({ config, store });
const host = process.env.ORACLE_RELAY_HOST || '';
const port = Number(process.env.ORACLE_RELAY_PORT || 8790);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid ORACLE_RELAY_PORT');
const relay = createPcRelay({ host, port, token: process.env.ORACLE_RELAY_TOKEN, execute: text => agent.handle(text, { source: 'oracle-relay', isOwner: true }) });
await relay.start();
console.log(`PC connector listening on ${host}:${port} (private network only).`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await relay.stop(); store.saveNow(); process.exit(0); });
