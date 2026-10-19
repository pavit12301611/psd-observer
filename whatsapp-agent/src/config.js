// config.js — tiny .env loader (no dotenv dependency) + validated settings.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeNumber } from './allowlist.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadDotEnv(file = path.join(ROOT, '.env')) {
  let raw;
  try {
  raw = fs.readFileSync(file, 'utf8');
  } catch {
    return; // no .env is fine: built-in defaults below cover the owner's setup
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value; // real env wins over .env
  }
}

const bool = (v, fallback = false) =>
  v == null || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

const int = (v, fallback) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
};

/** Bridge token: env, else a persisted random one (the bridge is loopback, this is belt & braces). */
function resolveBridgeToken(dataDir, fromEnv) {
  if (fromEnv) return fromEnv;
  const file = path.join(dataDir, 'bridge-token.txt');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch { /* first run */ }
  const token = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, token, { mode: 0o600 });
  } catch { /* read-only fs: token still works for this run */ }
  return token;
}

export function loadConfig({ dryRun = false } = {}) {
  loadDotEnv();
  const e = process.env;

  const dataDir = path.resolve(ROOT, e.DATA_DIR || 'data');
  const config = {
    dryRun,
    // The owner's two numbers are the shipped defaults so it works out of the
    // box; either can be overridden in a private .env (gitignored).
    ownerNumber: normalizeNumber(e.OWNER_NUMBER || '919528923866'),
    agentNumber: normalizeNumber(e.AGENT_NUMBER || '918859555795'),
    strictAgentNumber: bool(e.STRICT_AGENT_NUMBER, false),
    usePairingCode: bool(e.USE_PAIRING_CODE, false),
    deviceName: e.DEVICE_NAME || 'Observer Agent',

    host: e.HOST || '127.0.0.1',
    port: int(e.PORT, 8787),
    timezone: e.TIMEZONE || 'Asia/Kolkata',

    aiProvider: (e.AI_PROVIDER || 'auto').toLowerCase(),
    ollamaUrl: (e.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
    ollamaModel: e.OLLAMA_MODEL || 'llama3.2',
    ollamaVisionModel: e.OLLAMA_VISION_MODEL || '',
    groqApiKey: e.GROQ_API_KEY || '',
    groqModel: e.GROQ_MODEL || 'llama-3.3-70b-versatile',
    geminiApiKey: e.GEMINI_API_KEY || '',
    geminiModel: e.GEMINI_MODEL || 'gemini-2.0-flash',
    openrouterApiKey: e.OPENROUTER_API_KEY || '',
    openrouterModel: e.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',

    forwardToObserver: bool(e.FORWARD_TO_OBSERVER, false),
    observerWaitMs: int(e.OBSERVER_WAIT_MS, 90_000),

    allowShell: bool(e.ALLOW_SHELL, false),
    shellPin: e.SHELL_PIN || '',
    allowSimulate: bool(e.ALLOW_SIMULATE, false) || dryRun,

    dataDir,
    authDir: path.resolve(ROOT, e.AUTH_DIR || 'auth_info'),
    downloadsDir: path.join(dataDir, 'downloads'),
    sharedDir: path.join(dataDir, 'shared'),
    storeFile: path.join(dataDir, 'store.json'),
    qrPngFile: path.join(dataDir, 'qr.png'),
  };
  config.bridgeToken = resolveBridgeToken(dataDir, e.BRIDGE_TOKEN || '');

  const problems = [];
  if (!/^\d{10,15}$/.test(config.ownerNumber)) problems.push(`OWNER_NUMBER looks wrong: "${config.ownerNumber || '(empty)'}"`);
  if (!/^\d{10,15}$/.test(config.agentNumber)) problems.push(`AGENT_NUMBER looks wrong: "${config.agentNumber || '(empty)'}"`);
  if (config.ownerNumber && config.ownerNumber === config.agentNumber) {
    problems.push('OWNER_NUMBER and AGENT_NUMBER are the same. The agent needs its own WhatsApp number, otherwise it would talk to itself.');
  }
  if (config.allowShell && !config.shellPin) problems.push('ALLOW_SHELL=true but SHELL_PIN is empty. Set a PIN or turn ALLOW_SHELL off.');
  if (problems.length) {
    throw new Error(`Configuration problem(s):\n  - ${problems.join('\n  - ')}`);
  }
  return config;
}
