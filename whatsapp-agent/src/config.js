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

/**
 * Dashboard PIN for the mobile app. Env wins; otherwise a 6-digit PIN is
 * generated once and kept in data/dashboard-pin.txt (mode 600). It only ever
 * unlocks this PC's own bridge, and only from your LAN.
 */
function resolveDashboardPin(dataDir, fromEnv) {
  if (fromEnv) return String(fromEnv);
  const file = path.join(dataDir, 'dashboard-pin.txt');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch { /* first run */ }
  const pin = String(crypto.randomInt(100000, 1000000));
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, pin, { mode: 0o600 });
  } catch { /* read-only fs: PIN still works for this run */ }
  return pin;
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

    // 0.0.0.0 = the phone app on your Wi-Fi can reach it (PIN/token protected).
    // 127.0.0.1 = PC-only; use that if you never want LAN access.
    host: e.HOST || '0.0.0.0',
    port: int(e.PORT, 8787),
    timezone: e.TIMEZONE || 'Asia/Kolkata',

    aiProvider: (e.AI_PROVIDER || 'auto').toLowerCase(),
    ollamaUrl: (e.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
    ollamaModel: e.OLLAMA_MODEL || 'llama3.2',
    ollamaVisionModel: e.OLLAMA_VISION_MODEL || '',
    // ── Cloud free tiers (optional, but nice: fast + vision) ───────────────
    // Groq killed Llama 3.1 8B / 3.3 70B on the free tier on 16 Aug 2026 —
    // they are enterprise-only now. The free catalogue is gpt-oss + Qwen3.8:
    //   small : openai/gpt-oss-20b     (30 rpm · 1k/day · 8k TPM)
    //   big   : openai/gpt-oss-120b    (30 rpm · 1k/day · 8k TPM)
    //   vision: qwen/qwen3.8-27b       (only vision model on the free tier)
    // Override any of them from .env (GROQ_MODEL, GROQ_MODEL_SMALL,
    // GROQ_VISION_MODEL). Set GROQ_VISION_MODEL= (empty) to switch it off.
    groqApiKey: e.GROQ_API_KEY || '',
    groqModel: e.GROQ_MODEL || 'openai/gpt-oss-120b',
    groqModelSmall: e.GROQ_MODEL_SMALL || 'openai/gpt-oss-20b',
    groqVisionModel: e.GROQ_VISION_MODEL === undefined ? 'qwen/qwen3.8-27b' : e.GROQ_VISION_MODEL,
    groqBaseUrl: (e.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
    geminiApiKey: e.GEMINI_API_KEY || '',
    geminiModel: e.GEMINI_MODEL || 'gemini-2.0-flash',
    // OpenRouter free models. Gemma 4 31B is free, vision-capable and speaks
    // tool calls (262K ctx); `openrouter/free` (their auto-router) also works.
    openrouterApiKey: e.OPENROUTER_API_KEY || '',
    openrouterModel: e.OPENROUTER_MODEL || 'google/gemma-4-31b-it:free',
    openrouterVisionModel: e.OPENROUTER_VISION_MODEL || '',
    openrouterBaseUrl: (e.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),

    // ── workload routing (router.js) ───────────────────────────────────────
    // Optional extra sizes per provider. Empty = the main model covers them.
    // Local small model for one-liners (fast + light on the CPU):
    //   OLLAMA_MODEL_SMALL=llama3.2:1b
    //   OLLAMA_MODEL_HEAVY=qwen2.5:14b
    ollamaModelSmall: e.OLLAMA_MODEL_SMALL || '',
    // ── Local OpenAI-compatible servers (llama.cpp, LM Studio, vLLM) ───────
    // This is how any Hugging Face GGUF model gets used: llama-server exposes
    // /v1/chat/completions, and the agent talks to it like any other brain.
    // Nothing leaves the PC — no key, no quota, no cloud.
    //   LOCAL_API_URL=http://127.0.0.1:8080/v1
    //   LOCAL_MODEL=unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL
    // Optional extra endpoints for the workload router (tiny jobs on a small
    // model, heavy jobs on a big one, photos on a vision model):
    //   LOCAL_API_URL_SMALL / LOCAL_API_URL_HEAVY / LOCAL_API_URL_VISION
    localApiUrl: (e.LOCAL_API_URL || '').replace(/\/$/, ''),
    localApiUrlSmall: (e.LOCAL_API_URL_SMALL || '').replace(/\/$/, ''),
    localApiUrlHeavy: (e.LOCAL_API_URL_HEAVY || '').replace(/\/$/, ''),
    localApiUrlVision: (e.LOCAL_API_URL_VISION || '').replace(/\/$/, ''),
    localModel: e.LOCAL_MODEL || 'local-model',
    localModelSmall: e.LOCAL_MODEL_SMALL || '',
    localModelHeavy: e.LOCAL_MODEL_HEAVY || '',
    localModelVision: e.LOCAL_MODEL_VISION || '',
    localApiKey: e.LOCAL_API_KEY || 'local',
    ollamaModelHeavy: e.OLLAMA_MODEL_HEAVY || '',
    geminiModelHeavy: e.GEMINI_MODEL_HEAVY || '',
    // local (default) = free/private first · cloud = fastest cloud first ·
    // balanced = local for light work, cloud for heavy work.
    routerPrefer: (e.ROUTER_PREFER || 'local').toLowerCase(),
    // A failing brain is skipped for this long, doubling on each repeat
    // failure (cap = MODEL_COOLDOWN_MAX_MS) so WhatsApp never waits for it.
    modelCooldownMs: int(e.MODEL_COOLDOWN_MS, 120_000),
    modelCooldownMaxMs: int(e.MODEL_COOLDOWN_MAX_MS, 1_800_000),
    // Power budget: how many "heavy" (big-model) calls are allowed per hour.
    maxHeavyPerHour: int(e.MAX_HEAVY_PER_HOUR, 12),
    heavyWindowMs: int(e.HEAVY_WINDOW_MS, 3_600_000),
    aiTimeoutMs: int(e.AI_TIMEOUT_MS, 60_000),

    // Automation safety: older builds clicked hard-coded screen coordinates
    // when OCR missed a button. Off by default — blind clicking can hit
    // anything. Turn on only if you know your screen layout.
    allowBlindClicks: bool(e.ALLOW_BLIND_CLICKS, false),
    // Show "🧠 standard · llama3.2 · 3 steps" under AI replies. Off by default
    // for normal chat; /agent always shows it (so "done" is provable).
    showRoutingFooter: bool(e.SHOW_ROUTING_FOOTER, false),

    forwardToObserver: bool(e.FORWARD_TO_OBSERVER, false),
    observerWaitMs: int(e.OBSERVER_WAIT_MS, 90_000),

    // How much of the PC this agent may touch.
    //   safe     = read-only (status, screenshot, lookups)
    //   standard = apps, files, Wi-Fi, input, downloads, OCR … (destructive
    //              actions ask for confirmation)
    //   full     = standard + power (shutdown/reboot/suspend), always with a
    //              confirmation prompt. Shell stays separately opt-in.
    accessLevel: (e.ACCESS_LEVEL || 'full').toLowerCase(),
    filesExtraRoots: (e.FILES_EXTRA_ROOTS || '').split(',').map((s) => s.trim()).filter(Boolean),
    confirmTtlMs: int(e.CONFIRM_TTL_MS, 120_000),
    // Free AI tool-calling: plain language → real actions on the PC.
    agentTools: bool(e.AGENT_TOOLS, true),
    maxAgentSteps: int(e.MAX_AGENT_STEPS, 6),
    // Local models have small contexts: send only the ~20 most relevant tools
    // and give Ollama a real context window.
    agentToolLimit: int(e.AGENT_TOOL_LIMIT, 20),
    ollamaNumCtx: int(e.OLLAMA_NUM_CTX, 8192),

    allowShell: bool(e.ALLOW_SHELL, false),
    shellPin: e.SHELL_PIN || '',
    shellTimeoutMs: int(e.SHELL_TIMEOUT_MS, 20_000),
    // Tier-2 PC control (keyboard/mouse + power). Tier 1 (screenshot, volume,
    // brightness, media, open, clipboard, lock, files) is always on.
    // Defaults on now because the agent is owner-only and full access was
    // explicitly asked for; set ALLOW_PC_CONTROL=false to refuse input.
    // CONTROL_PIN is an optional extra gate: /pc type <PIN> <text>, …
    allowPcControl: bool(e.ALLOW_PC_CONTROL, true),
    controlPin: e.CONTROL_PIN || '',
    allowSimulate: bool(e.ALLOW_SIMULATE, false) || dryRun,
    // Fedora/GNOME desktop convenience: pop the linking QR open in the image
    // viewer on first run. Headless boxes (no DISPLAY/WAYLAND_DISPLAY) skip it
    // automatically; OPEN_QR=false disables it everywhere.
    openQr: bool(e.OPEN_QR, true),
    // If the agent phone unlinks this device (or WhatsApp logs the session
    // out), the saved creds are permanently dead — they can never log in
    // again. Default behaviour: archive the dead login next to authDir
    // (auth_info_loggedout_<timestamp>/, never auto-deleted) and start a
    // fresh link automatically, so a new QR appears and the owner just scans
    // again. AUTO_RELINK=false restores the manual flow (stop the agent,
    // remove authDir, restart) or ./scripts/relink-whatsapp.sh.
    autoRelink: bool(e.AUTO_RELINK, true),

    // Screen/document reading (all local, free).
    // How long the Wayland screenshot dialog may stay open before we give up.
    // Generous by default: the owner may be away from the PC when asking for a
    // screenshot from WhatsApp, and the portal keeps the image on disk anyway.
    portalTimeoutMs: int(e.PORTAL_TIMEOUT_MS, 60_000),
    ocrLangs: e.OCR_LANGS || 'eng',
    // TTS (offline, free) — only on explicit /voicereply. Special calm voice, tez thi to 150→135
    ttsEngine: (e.TTS_ENGINE || 'auto').toLowerCase(),
    ttsVoice: e.TTS_VOICE || 'special',
    ttsLang: e.TTS_LANG || 'auto',
    ttsSpeed: int(e.TTS_SPEED, 135),
    piperBin: e.PIPER_BIN || '',
    piperModel: e.PIPER_MODEL || '',
    // Voice notes → text. Groq free tier if GROQ_API_KEY is set, otherwise a
    // local whisper.cpp binary + model file (fully offline).
    whisperBin: e.WHISPER_BIN || '',
    whisperModel: e.WHISPER_MODEL || '',
    whisperModelGroq: e.WHISPER_MODEL_GROQ || 'whisper-large-v3-turbo',
    whisperLanguage: e.WHISPER_LANGUAGE || 'auto',

    dataDir,
    authDir: path.resolve(ROOT, e.AUTH_DIR || 'auth_info'),
    downloadsDir: path.join(dataDir, 'downloads'),
    sharedDir: path.join(dataDir, 'shared'),
    storeFile: path.join(dataDir, 'store.json'),
    qrPngFile: path.join(dataDir, 'qr.png'),
  };
  config.bridgeToken = resolveBridgeToken(dataDir, e.BRIDGE_TOKEN || '');
  config.dashboardPin = resolveDashboardPin(dataDir, e.DASHBOARD_PIN || '');

  const problems = [];
  if (!/^\d{10,15}$/.test(config.ownerNumber)) problems.push(`OWNER_NUMBER looks wrong: "${config.ownerNumber || '(empty)'}"`);
  if (!/^\d{10,15}$/.test(config.agentNumber)) problems.push(`AGENT_NUMBER looks wrong: "${config.agentNumber || '(empty)'}"`);
  if (config.ownerNumber && config.ownerNumber === config.agentNumber) {
    problems.push('OWNER_NUMBER and AGENT_NUMBER are the same. The agent needs its own WhatsApp number, otherwise it would talk to itself.');
  }
  if (config.allowShell && !config.shellPin) problems.push('ALLOW_SHELL=true but SHELL_PIN is empty. Set a PIN or turn ALLOW_SHELL off.');
  if (!['safe', 'standard', 'full'].includes(config.accessLevel)) problems.push(`ACCESS_LEVEL must be safe, standard or full (got "${config.accessLevel}").`);
  if (!['auto', 'local', 'ollama', 'groq', 'gemini', 'openrouter', 'none'].includes(config.aiProvider)) {
    problems.push(`AI_PROVIDER must be auto, local, ollama, groq, gemini, openrouter or none (got "${config.aiProvider}").`);
  }
  if (!['local', 'cloud', 'balanced'].includes(config.routerPrefer)) {
    problems.push(`ROUTER_PREFER must be local, cloud or balanced (got "${config.routerPrefer}").`);
  }
  if (problems.length) {
    throw new Error(`Configuration problem(s):\n  - ${problems.join('\n  - ')}`);
  }
  return config;
}
