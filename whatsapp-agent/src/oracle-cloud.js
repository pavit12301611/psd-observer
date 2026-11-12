#!/usr/bin/env node
// Minimal Oracle mode: WhatsApp and one local model, never cloud VM PC actions.
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { callDirectModel } from './ai.js';
import { createWhatsApp } from './whatsapp.js';
import { sendPcCommand, validateRelaySettings } from './oracle-relay.js';
import { createOracleAgent } from './oracle-agent.js';

const config = loadConfig();
const host = process.env.ORACLE_RELAY_HOST || '';
const port = Number(process.env.ORACLE_RELAY_PORT || 8790);
const token = process.env.ORACLE_RELAY_TOKEN || '';
validateRelaySettings(host, token);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid ORACLE_RELAY_PORT');
if (!process.env.LOCAL_API_URL || !process.env.LOCAL_MODEL) throw new Error('Set LOCAL_API_URL and LOCAL_MODEL for the single Oracle model.');
const modelUrl = new URL(config.localApiUrl);
if (!['http:', 'https:'].includes(modelUrl.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(modelUrl.hostname) || modelUrl.username || modelUrl.password) throw new Error('LOCAL_API_URL must point to a model on Oracle loopback.');
Object.assign(config, { aiProvider: 'llamacpp', localApiUrlSmall: '', localApiUrlHeavy: '', localApiUrlVision: '', needleEnabled: false, layaEnabled: false, guestMode: 'off', voiceCall: false, whatsappVoiceReplies: false, oracleTextOnly: true });
for (const dir of [config.dataDir, config.downloadsDir, config.sharedDir]) fs.mkdirSync(dir, { recursive: true });
const store = new Store(config.storeFile);
const agent = createOracleAgent({
  sendCommand: (text) => sendPcCommand({ host, port, token, text }),
  askModel: async (text) => {
    const result = await callDirectModel({ provider: 'local', model: config.localModel, baseUrl: config.localApiUrl, apiKey: config.localApiKey }, config, [
      { role: 'system', content: 'You are a helpful conversational assistant. You have no access to the user computer and cannot execute commands. Never claim you performed any action.' },
      { role: 'user', content: text },
    ], { maxTokens: 512 });
    return result.text;
  },
});
const wa = createWhatsApp({ config, store, agent });
await wa.start();
console.log('Oracle mode started. Link WhatsApp with the QR in the log.');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { wa.stop(); store.saveNow(); process.exit(0); });
