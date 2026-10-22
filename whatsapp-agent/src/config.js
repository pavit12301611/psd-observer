// config.js — tiny .env loader (no dotenv dependency) + validated settings.
import fs from 'node:fs';
import os from 'node:os';
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

const float = (v, fallback) => {
  const n = Number.parseFloat(String(v ?? ''));
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

export function loadConfig({ dryRun = false, env = null } = {}) {
  if (!env) loadDotEnv();
  const e = env ?? process.env;

  const dataDir = path.resolve(ROOT, e.DATA_DIR || 'data');
  const config = {
    dryRun,
    agentName: (e.AGENT_NAME || 'PSD_Ai').trim() || 'PSD_Ai',
    // The owner's two numbers are the shipped defaults so it works out of the
    // box; either can be overridden in a private .env (gitignored).
    ownerNumber: normalizeNumber(e.OWNER_NUMBER || '919528923866'),
    agentNumber: normalizeNumber(e.AGENT_NUMBER || '918859555795'),
    strictAgentNumber: bool(e.STRICT_AGENT_NUMBER, false),
    usePairingCode: bool(e.USE_PAIRING_CODE, false),
    deviceName: e.DEVICE_NAME || 'Observer Agent',
    // Controlled multi-user / guest messaging (src/guests.js):
    //   approval = (DEFAULT) Every non-owner message is sent to the OWNER with
    //              sender name/number, exact timestamp, their message, and the
    //              proposed AI reply so the owner can say `yes`, `no`, or
    //              `no send this instead: <text>`
    //   all      = anyone (except blocked) gets automatic safe AI replies; ALL
    //              `/` and natural-language commands remain 100% owner-only
    //   contacts = only saved contacts (/contact) & /allow-ed numbers can chat
    //   off      = silent owner-only mode for incoming messages
    guestMode: (e.GUEST_MODE || 'approval').toLowerCase(),
    guestApproval: e.GUEST_APPROVAL !== undefined ? bool(e.GUEST_APPROVAL, true) : undefined,
    guestRateLimitPerMinute: int(e.GUEST_RATE_LIMIT_PER_MIN, 6),
    guestNotifyMessages: bool(e.GUEST_NOTIFY_MESSAGES, true),
    guestNotifyBlocked: bool(e.GUEST_NOTIFY_BLOCKED, true),
    outboundRateLimitPerMinute: int(e.OUTBOUND_RATE_LIMIT_PER_MIN, 12),

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
    geminiModel: e.GEMINI_MODEL || 'gemini-3.8-flash',
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
    // Wikipedia grounding & training (src/wiki.js): before answering factual
    // questions the AI chat is fed a verified Wikipedia summary, and every
    // fetch is learned for instant offline answers (the "training" loop).
    //   WIKI_GROUNDING=on (default) | offline (learned/built-in only) | off
    //   WIKI_BASE_URL=…   (tests/mirrors; default https://en.wikipedia.org)
    //   WIKI_TIMEOUT_MS=3500
    wikiGrounding: e.WIKI_GROUNDING === 'off' ? false : e.WIKI_GROUNDING === 'offline' ? 'offline' : true,
    wikiBaseUrl: e.WIKI_BASE_URL || '',
    wikiTimeoutMs: int(e.WIKI_TIMEOUT_MS, 3500),
    // Multi-agent fleet (src/agents.js): tag replies with the answering bot
    // ("— 🧑‍💻 CodeBot"). AGENT_TAG=off for plain replies.
    agentTag: bool(e.AGENT_TAG, true),
    // Power budget: how many "heavy" (big-model) calls are allowed per hour.
    maxHeavyPerHour: int(e.MAX_HEAVY_PER_HOUR, 12),
    heavyWindowMs: int(e.HEAVY_WINDOW_MS, 3_600_000),
    aiTimeoutMs: int(e.AI_TIMEOUT_MS, 60_000),

    // Automation safety: older builds clicked hard-coded screen coordinates
    // when OCR missed a button. Off by default — blind clicking can hit
    // anything. Turn on only if you know your screen layout.
    allowBlindClicks: bool(e.ALLOW_BLIND_CLICKS, false),
    // ── "hands" (src/hands.js): look-at-screen → click/type loop ───────────
    // One screenshot per step, one vision call per step. 8 steps is enough for
    // "YouTube kholo aur lofi chalao" without burning the whole free tier.
    handsMaxSteps: int(e.HANDS_MAX_STEPS, 8),
    handsMaxSeconds: int(e.HANDS_MAX_SECONDS, 240),
    handsStepDelayMs: int(e.HANDS_STEP_DELAY_MS, 550),
    // Screenshots are downscaled to this width (JPEG) before leaving the PC:
    // smaller = fewer vision tokens = faster steps, and a 4K screen still fits
    // Groq's 4MB image limit.
    handsImageWidth: int(e.HANDS_IMAGE_WIDTH, 1024),
    handsJpegQuality: int(e.HANDS_JPEG_QUALITY, 70),
    // Screen control is vision-first: the model reads the screenshot itself.
    // Set true to also OCR every frame and hand the model a word table (more
    // exact for dense text UI, but ~1-2s slower per step).
    handsUseOcr: bool(e.HANDS_USE_OCR, false),
    // Screenshots are for sending, not keeping: every capture is deleted after
    // this many minutes (default 4). SCREENSHOT_CLEANUP=false turns it off.
    screenshotTtlMinutes: Number(e.SCREENSHOT_TTL_MINUTES ?? 4) || 4,
    screenshotCleanup: bool(e.SCREENSHOT_CLEANUP, true),
    handsMaxTokens: int(e.HANDS_MAX_TOKENS, 512),
    // Which vision provider the screen loop prefers: auto | gemini | groq |
    // openrouter | local | ollama. auto = Gemini Flash → Groq → OpenRouter →
    // local → Ollama.
    screenProvider: (e.SCREEN_PROVIDER || 'auto').toLowerCase(),
    // Local vision is preferred; when there is none, cloud vision is allowed.
    // ALLOW_CLOUD_SCREEN=false keeps every screenshot on the PC (and hands
    // only works if OLLAMA_VISION_MODEL / LOCAL_API_URL_VISION is set).
    allowCloudScreen: bool(e.ALLOW_CLOUD_SCREEN, true),
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
    // Automatic "😴 Agent is sleeping" WhatsApp message before the PC shuts
    // down, suspends, or the service stops. Active by default; disable with
    // OFFLINE_NOTIFY=false or `/sleepnotify off`.
    offlineNotify: bool(e.OFFLINE_NOTIFY, true),
    offlineMessage: (e.OFFLINE_MESSAGE || '').trim(),
    offlineTimeoutMs: int(e.OFFLINE_TIMEOUT_MS, 3_500),

    // Screen/document reading (all local, free).
    // How long the Wayland screenshot dialog may stay open before we give up.
    // Generous by default: the owner may be away from the PC when asking for a
    // screenshot from WhatsApp, and the portal keeps the image on disk anyway.
    portalTimeoutMs: int(e.PORTAL_TIMEOUT_MS, 60_000),
    ocrLangs: e.OCR_LANGS || 'eng',
    // ── JARVIS voice (3.0): neural British butler, offline-first ─────────────
    // Engine order (tts.js): XTTS clone → Piper en_GB neural → Edge en-GB-Ryan
    // → espeak robot. One-command setup: bash scripts/observer.sh voice setup
    ttsEngine: (e.TTS_ENGINE || 'auto').toLowerCase(),
    ttsVoice: e.TTS_VOICE || 'jarvis',
    ttsLang: e.TTS_LANG || 'auto',
    ttsSpeed: e.TTS_SPEED ? int(e.TTS_SPEED, 140) : null, // null = preset decides
    ttsFx: (e.TTS_FX || 'jarvis').toLowerCase(), // jarvis | none (ffmpeg polish)
    jarvisPitch: float(e.JARVIS_PITCH, 0), // 0 = natural, 0.94 = a shade deeper
    jarvisPersona: bool(e.JARVIS_PERSONA, true),
    jarvisAddress: e.JARVIS_ADDRESS || 'Sir',
    // JARVIS speaks ENGLISH ONLY (the owner can still speak Hindi/Hinglish —
    // he is understood; the British voice just never tries Hindi, badly).
    jarvisEnglishOnly: bool(e.JARVIS_ENGLISH_ONLY, true),
    piperBin: e.PIPER_BIN || '',
    piperModel: e.PIPER_MODEL || '',
    piperLengthScale: float(e.PIPER_LENGTH_SCALE, 1.05), // >1 = slower, measured
    piperNoiseScale: float(e.PIPER_NOISE_SCALE, 0.55),
    piperNoiseWScale: float(e.PIPER_NOISE_W_SCALE, 0.7),
    edgeTtsBin: e.EDGE_TTS_BIN || '',
    edgeTtsVoice: e.EDGE_TTS_VOICE || '',
    edgeTtsVoiceHindi: e.EDGE_TTS_VOICE_HINDI || 'hi-IN-MadhurNeural',
    // True voice CLONE (optional, advanced): a local Coqui XTTS server
    // (daswer123/xtts-api-server) + your reference clip. See VOICE.md.
    xttsUrl: (e.XTTS_URL || '').replace(/\/$/, ''),
    xttsSpeaker: e.XTTS_SPEAKER || '',
    voiceDir: path.resolve(ROOT, e.VOICE_DIR || path.join(os.homedir(), '.local/share/observer-voice')),
    // Voice notes / calls → text. SPEED FIRST since 3.1.11: when a Groq key
    // exists, its Whisper large-v3 (API) transcribes — ~10x faster than the
    // local base model AND far better at Hinglish. Local whisper.cpp stays
    // as the automatic offline backup. STT_ENGINE=local pins it to offline.
    sttEngine: (e.STT_ENGINE || 'auto').toLowerCase(), // auto|api|local
    sttTimeoutMs: int(e.STT_TIMEOUT_MS, 20_000),
    whisperBin: e.WHISPER_BIN || '',
    whisperModel: e.WHISPER_MODEL || '',
    whisperModelPy: e.WHISPER_MODEL_PY || 'base',
    whisperModelGroq: e.WHISPER_MODEL_GROQ || 'whisper-large-v3',
    whisperLanguage: e.WHISPER_LANGUAGE || 'auto',

    // ── Voice calls (3.0) ────────────────────────────────────────────────────
    // Phone-app live call + WhatsApp voice-note call mode.
    voiceCall: bool(e.VOICE_CALL, true),
    voiceMaxSpokenChars: int(e.VOICE_MAX_SPOKEN_CHARS, 340),
    voiceSilenceEndMs: int(e.VOICE_SILENCE_END_MS, 600),
    // Live calls: turn itna lamba ja raha ho to JARVIS khali chuppi ki jagah
    // ek chhota "One moment, Sir." bol deta hai (3.1.11 speed pass).
    waCallFiller: bool(e.WA_CALL_FILLER, true),
    waCallFillerMs: int(e.WA_CALL_FILLER_MS, 1400),
    // WhatsApp: also send a JARVIS voice note with every text reply.
    whatsappVoiceReplies: bool(e.WHATSAPP_VOICE_REPLIES, false),
    // REAL WhatsApp voice-call answering (experimental VoIP engine,
    // src/wavoip.js). Needs a second linked device + ffmpeg. Setup:
    //   bash scripts/observer.sh voice call-engine
    // Until then, an incoming owner call falls back per WA_CALL_FALLBACK.
    waCallAnswer: bool(e.WA_CALL_ANSWER, false),
    // WASM call-setup logs in the journal ([voip-wasm:…], keyword-filtered by
    // the engine) — THIS is where a silently-dropped call explains itself.
    waVoipDebug: bool(e.WA_VOIP_DEBUG, true),
    waVoipLogLevel: String(e.WA_VOIP_LOG_LEVEL ?? '').trim(), // '2' = unfiltered WASM firehose (forensics)
    // Raw JSON of WASM AB-prop overrides, forwarded to the engine before it
    // loads (CALL_WASM_AB_PROPS_JSON). E.g. WA_VOIP_AB_PROPS={"enable_fast_call_setup_callee_v2":false}
    waVoipAbProps: String(e.WA_VOIP_AB_PROPS ?? '').trim(),
    waCallFallback: (e.WA_CALL_FALLBACK || 'voice-session').toLowerCase(), // voice-session|ignore|reject
    waCallFallbackDelayMs: int(e.WA_CALL_FALLBACK_DELAY_MS, 12_000),
    waCallUnknown: (e.WA_CALL_UNKNOWN || 'ignore').toLowerCase(), // ignore|reject
    waCallMaxMinutes: int(e.WA_CALL_MAX_MINUTES, 15),
    voipEnginePath: e.VOIP_ENGINE_PATH || '',

    // ── DeepSeek Harness (`@deepseek-ai/dsh`) full-power Linux integration ──
    deepseekApiKey: e.DEEPSEEK_API_KEY || '',
    deepseekModel: e.DEEPSEEK_MODEL || 'deepseek-chat',
    deepseekBaseUrl: (e.DEEPSEEK_BASE_URL || '').replace(/\/$/, ''),
    // ── Ultra-Accuracy Question Image Solver (`src/solver.js`) ─────────────
    solverAutoImages: bool(e.SOLVER_AUTO_IMAGES, true),
    solverAutoBootstrap: bool(e.SOLVER_AUTO_BOOTSTRAP, true),
    solverVenvDir: e.OBSERVER_SOLVER_VENV || '',
    dshHome: e.DSH_HOME || '',
    dshBin: e.DSH_BIN || '',
    dshNodeBin: e.DSH_NODE_BIN || '',
    dshInstallDir: e.DSH_INSTALL_DIR || '',
    dshAutoInstall: bool(e.DSH_AUTO_INSTALL, true),
    dshAutoStartWeb: bool(e.DSH_AUTO_START_WEB, false),
    dshAutoRoute: bool(e.DSH_AUTO_ROUTE, false) || ['dsh', 'harness'].includes((e.AI_PROVIDER || '').toLowerCase()),
    dshPermissionMode: e.DSH_PERMISSION_MODE || 'danger-full-access',
    dshModel: e.DSH_MODEL || '',
    dshWorkdir: e.DSH_WORKDIR || '',
    dshWebPort: int(e.DSH_WEB_PORT, 3080),
    dshRemotePort: int(e.DSH_REMOTE_PORT, 3081),
    dshTrustedHosts: (e.DSH_TRUSTED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean),
    dshCustomBaseUrl: (e.DSH_CUSTOM_BASE_URL || '').replace(/\/$/, ''),
    dshCustomApiKey: e.DSH_CUSTOM_API_KEY || '',
    dshCustomModel: e.DSH_CUSTOM_MODEL || '',
    dshTaskTimeoutMs: int(e.DSH_TASK_TIMEOUT_MS, 600_000),

    dataDir,
    authDir: path.resolve(ROOT, e.AUTH_DIR || 'auth_info'),
    // The WhatsApp call engine (baileys-caller) needs its OWN linked device.
    voipAuthDir: path.resolve(ROOT, e.VOIP_AUTH_DIR || 'auth_info_voip'),
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
  if (!['auto', 'local', 'ollama', 'groq', 'gemini', 'openrouter', 'dsh', 'harness', 'none'].includes(config.aiProvider)) {
    problems.push(`AI_PROVIDER must be auto, local, ollama, groq, gemini, openrouter, dsh, harness or none (got "${config.aiProvider}").`);
  }
  if (!['local', 'cloud', 'balanced'].includes(config.routerPrefer)) {
    problems.push(`ROUTER_PREFER must be local, cloud or balanced (got "${config.routerPrefer}").`);
  }
  if (problems.length) {
    throw new Error(`Configuration problem(s):\n  - ${problems.join('\n  - ')}`);
  }
  return config;
}
