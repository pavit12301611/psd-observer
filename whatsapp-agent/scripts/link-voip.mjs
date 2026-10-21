#!/usr/bin/env node
// link-voip.mjs — one-time QR link for the WhatsApp CALL-ANSWERING device.
//
// The VoIP engine (baileys-caller) holds its own linked-device session,
// separate from the messaging login: scan this QR with the AGENT phone
// (WhatsApp → Linked devices → Link a device). WhatsApp allows up to 4
// companion devices, so messaging (auth_info) + calling (auth_info_voip)
// happily coexist on the same agent number.
//
// Run by:  bash scripts/observer.sh voice link-voip
// Or:      node scripts/link-voip.mjs [authDir]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const authDir = path.resolve(root, process.argv[2] || 'auth_info_voip');

async function loadEngine() {
  try {
    const mod = await import('baileys-caller');
    if (mod?.VoipClient) return mod;
  } catch { /* try the standalone install dir */ }
  const local = path.join(os.homedir(), '.local/share/observer-voip/baileys-caller/dist/index.mjs');
  if (fs.existsSync(local)) {
    const mod = await import(pathToFileURL(local).href);
    if (mod?.VoipClient) return mod;
  }
  return null;
}

const engine = await loadEngine();
if (!engine) {
  console.error('\n❌ VoIP engine (baileys-caller) nahi mila.');
  console.error('   Pehle install karo:  bash scripts/observer.sh voice call-engine\n');
  process.exit(1);
}

fs.mkdirSync(authDir, { recursive: true });
console.info(`\n📞 VoIP device link — auth: ${authDir}`);
console.info('   AGENT phone se scan karo: WhatsApp → Linked devices → Link a device');
console.info('   (Ye messaging wale login se alag, doosra companion device hai.)\n');

const client = new engine.VoipClient({ authDir });
try {
  await client.connect();
} catch (err) {
  console.error(`\n❌ Connect fail: ${err.message}\n`);
  process.exit(1);
}

// creds.json appearing = linked. Give the socket a few seconds to settle.
const linked = fs.existsSync(path.join(authDir, 'creds.json'));
await new Promise((r) => setTimeout(r, 3000));
try { client.disconnect(); } catch { /* done */ }
if (linked) {
  console.info('\n✅ VoIP device linked! Ab observer.sh WA_CALL_ANSWER=true set karke service restart karega.');
  console.info('   Uske baad agent number pe WhatsApp voice call karo — JARVIS uthayega. 📞\n');
  process.exit(0);
}
console.error('\n⚠️ creds.json nahi bana — scan complete nahi hua. Phir se try karo: bash scripts/observer.sh voice link-voip\n');
process.exit(2);
