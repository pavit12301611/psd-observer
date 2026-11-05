// config.js — every knob PSD has, in one place, resolved once at boot.
//
// Nothing here is secret by default: PSD is meant to run on the owner's own
// Fedora workstation, bound to 0.0.0.0 so the phone and the GNOME extension can
// reach it, and protected by a bearer token that is generated on first run.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
};
const int = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};
const list = (value) => String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const trimSlash = (value) => String(value ?? '').replace(/\/+$/, '');

/** Home-relative expansion so PSD_*_DIR=~/x works from a shell and systemd. */
export function expandHome(value) {
  if (!value) return value;
  return value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value;
}

function ensureToken(dataDir, fromEnv) {
  if (fromEnv) return fromEnv;
  const file = path.join(dataDir, 'token.txt');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch { /* first run */ }
  const token = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, token, { mode: 0o600 });
  } catch { /* read-only fs: the token still works for this run */ }
  return token;
}

/**
 * The WhatsApp agent keeps its bridge token in its own data dir. PSD is usually
 * installed next to it, so it can pick that token up and talk to the agent with
 * no copy-pasting. An explicit PSD_WHATSAPP_TOKEN always wins.
 */
function discoverWhatsAppToken(explicit) {
  if (explicit) return explicit;
  const candidates = [
    path.join(ROOT, '..', 'whatsapp-agent', 'data', 'bridge-token.txt'),
    path.join(os.homedir(), '.local', 'share', 'observer-whatsapp-agent', 'bridge-token.txt'),
  ];
  for (const file of candidates) {
    try {
      const token = fs.readFileSync(file, 'utf8').trim();
      if (token) return token;
    } catch { /* not installed there */ }
  }
  return '';
}

export function loadConfig({ env = process.env } = {}) {
  const dataDir = expandHome(env.PSD_DATA_DIR) ||
    path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'psd');
  const agent = (env.PSD_AGENT || 'psd').trim().toLowerCase();
  const engine = (env.PSD_ENGINE || 'auto').trim().toLowerCase();
  const access = (env.PSD_ACCESS || 'standard').trim().toLowerCase();

  const config = {
    version: VERSION,
    dataDir,
    agentDir: expandHome(env.PSD_AGENT_DIR) || path.join(ROOT, 'agents'),
    configFile: path.join(dataDir, 'config.json'),
    memoryFile: path.join(dataDir, 'memory.json'),
    runFile: path.join(dataDir, 'runs.jsonl'),
    webDir: path.join(ROOT, 'web'),

    host: env.PSD_HOST || '0.0.0.0',
    port: int(env.PSD_PORT, 7788),
    token: '',
    trustLoopback: bool(env.PSD_TRUST_LOOPBACK, true),
    // Empty = no cross-origin browser access at all (same-origin app only).
    // Authentication is a token in a header or the query string.
    corsOrigin: env.PSD_CORS_ORIGIN || '',

    engine,
    // Ollama is the zero-configuration default on Fedora: it is what the
    // OpenJarvis installer and the WhatsApp agent already use.
    ollamaUrl: trimSlash(env.PSD_OLLAMA_URL || 'http://127.0.0.1:11434'),
    openaiUrl: trimSlash(env.PSD_OPENAI_URL || ''),
    openaiKey: env.PSD_OPENAI_KEY || '',
    model: env.PSD_MODEL || '',
    smallModel: env.PSD_MODEL_SMALL || '',
    // A running `jarvis serve` speaks OpenAI at /v1. Point PSD at it and PSD
    // gains OpenJarvis' whole engine catalogue as a fallback brain.
    openjarvisUrl: trimSlash(env.PSD_OPENJARVIS_URL || ''),
    openjarvisModel: env.PSD_OPENJARVIS_MODEL || '',
    requestTimeoutMs: int(env.PSD_REQUEST_TIMEOUT_MS, 120_000),
    maxSteps: Math.max(1, Math.min(12, int(env.PSD_MAX_STEPS, 6))),
    temperature: Number(env.PSD_TEMPERATURE ?? 0.2),
    maxHistory: Math.max(2, Math.min(40, int(env.PSD_MAX_HISTORY, 24))),

    agent,
    access,
    skills: bool(env.PSD_SKILLS, true),
    shell: bool(env.PSD_SHELL, false),
    shellPin: env.PSD_SHELL_PIN || '',
    allowRoots: list(env.PSD_ALLOW_ROOTS).map(expandHome),
    confirmTtlMs: Math.max(15_000, int(env.PSD_CONFIRM_TTL_MS, 180_000)),
    toolTimeoutMs: Math.max(500, int(env.PSD_TOOL_TIMEOUT_MS, 20_000)),

    whatsappUrl: trimSlash(env.PSD_WHATSAPP_URL || 'http://127.0.0.1:8787'),
    whatsappToken: discoverWhatsAppToken(env.PSD_WHATSAPP_TOKEN || ''),
    whatsappBridge: bool(env.PSD_WHATSAPP_BRIDGE, true),
    notchBus: env.PSD_NOTCH_BUS || 'io.github.pavit12301611.Notch',
    notchPath: env.PSD_NOTCH_PATH || '/io/github/pavit12301611/Notch',

    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    startedAt: Date.now(),
  };
  config.token = ensureToken(dataDir, env.PSD_TOKEN || '');
  return config;
}

/** Which brain actually answers. Resolved at boot, re-checked by /psd/status. */
export function enginePlan(config) {
  const plan = [];
  if (config.engine === 'openai' || (config.engine === 'auto' && config.openaiUrl)) {
    if (config.openaiUrl) plan.push({ kind: 'openai', id: 'openai', url: config.openaiUrl, model: config.model });
  }
  if (config.engine === 'openjarvis' || (config.engine === 'auto' && config.openjarvisUrl)) {
    if (config.openjarvisUrl) {
      plan.push({
        kind: 'openai', id: 'openjarvis',
        url: config.openjarvisUrl.replace(/\/v1$/, '') + '/v1',
        model: config.openjarvisModel || config.model,
      });
    }
  }
  if (['auto', 'ollama', 'local'].includes(config.engine)) {
    plan.push({ kind: 'ollama', id: 'ollama', url: config.ollamaUrl, model: config.model });
  }
  // No model at all is a supported mode, not an error: PSD still opens apps,
  // reports the system, talks to the notch and researches the web through the
  // intent layer. An LLM just makes it understand arbitrary phrasing.
  plan.push({ kind: 'intents', id: 'intents', model: 'offline-intents' });
  return plan;
}
