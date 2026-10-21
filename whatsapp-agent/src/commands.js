// commands.js — the agent's behaviour: slash commands, plain-language
// intents, AI chat, and forwarding to Observer. Pure of WhatsApp: it takes
// text and returns a reply object, so it is fully testable offline.
//
// Reply shape: string, or { text?, image?: Buffer, document?: {buffer,
// fileName, mimetype}, sticker?: Buffer, poll?: {name, values} }

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import QRCode from 'qrcode';
import * as tools from './tools.js';
import * as learn from './learn.js';
import * as cron from './cron.js';
import * as tts from './tts.js';
import * as autopilot from './autopilot.js';
import { describeSite } from './sites.js';
import * as hands from './hands.js';
import { tasks as globalTasks, isStopCommand, isStoppedError } from './cancel.js';
import * as ai from './ai.js';
import * as pc from './pccontrol.js';
import * as finder from './elementfinder.js';
import { createActions } from './actions.js';
import { createAgentLoop } from './agentloop.js';
import { routerFor, looksLikeWebTask, estimateComplexity } from './router.js';
import { parseIntent } from './nlp.js';
import { runDoctor } from './doctor.js';
import * as watch from './watch.js';
import * as macro from './macro.js';
import * as brief from './brief.js';
import { createJournal, undoReply } from './journal.js';
import { usageReport } from './usage.js';
import { createProgress, describeHandsStep } from './progress.js';
import { createShotJanitor, describeJanitor, cleanNow, cleanupReply } from './screenshots.js';
import { createHarness } from './harness.js';
import * as solver from './solver.js';
import { createVoiceCall } from './voicecall.js';
import { jarvisGreeting, spokenSummary } from './jarvis.js';
import * as mem from './memory.js';
import * as reach from './reach.js';
import * as grounding from './grounding.js';

const execAsync = promisify(exec);
const HELP = `🤖 *PSD_Ai (Observer WhatsApp Agent)* — free, owner-only, full PC control
_No Observer app needed. No paid API. Everything runs on your own PC._

*Just talk (English / Hindi / Hinglish)*
• “chrome kholo” · “screenshot bhej do” · “awaaz kam karo”
• “wifi off karo” · “screen pe kya hai” · “thesis.pdf dhundo”
• “download <link>” · “10 second screen record karo” · “type karo hello”
• /agent <task> — samajhta hai aur PC pe *karke* dikhata hai (verified, no fake "done")
• /brains — kaun sa model kab use hota hai (live health + power budget)
• /model — brains ka setup/status (local + cloud)
• 100% local chahiye? ./scripts/observer.sh models recommend — Hugging Face GGUF, koi cloud nahi
• Cloud free brain (Groq/OpenRouter): ./scripts/observer.sh keys groq gsk_... — AI-KEYS.md

*Apps & windows*
• /apps · /open <app> · /close <app> · /windows · /focus <title>
*PC control*
• /screenshot · /look [question] · /ocr · /pc status|disk|ip|battery|top
• /pc volume up|down|mute|50 · /pc brightness 70 · /pc media pause|next
• /pc type <text> · /pc paste <long text> · /pc key ctrl+l · /pc click [x y] [double]
• /pc mousemove <x> <y> · /pc scroll [up|down] [steps] · /pc lock
• /stop — chal raha kaam turant roko (browser/app khula rahega; stacked kaam bhi)
• /resume — /stop ke baad wahin se shuru (zero se nahi)
• /tap <x y | 50% 40% | Login> — screen pe seedha click (naya screenshot saath)
• /webcam · /record [seconds] · /notify <text> · /pc locate <button>
*Network*
• /wifi [status|on|off|list] · /wifi connect <SSID> [password]
• /bt [on|off|status] · /svc status|restart <service> · /kill <process>
*Files (anywhere under your home)*
• /ls [path] · /read <path> · /write <path> | <text> · /send <path>
• /find <name> · /zip <path> · /unzip <path> · /download <url> [path] · /rm <path>
• /mv <from> | <to> · /cp <from> | <to> · /mkdir <folder>
*🌐 Agent-Reach × Agent-S (3.2.0 — Deterministic Internet & PC Grounding)*
• /reach [doctor] — 16+ internet channels + AT-SPI desktop grounding health report
• /reach <url> — Read any webpage, YouTube transcript, GitHub repo, Tweet, or Reddit post
• /reach search <query> · /reach research <topic> — Multi-platform parallel research
• /yt [play|transcript] <query or url> — YouTube search, full transcript, or direct video play
• /gh <query or owner/repo> · /reddit <query> · /hn [query]
• /ui — Inspect live AT-SPI desktop widgets + OCR bounding boxes (zero coordinate guessing)

*🧠 Ultra-Accuracy Question Image Solver (2.10.0 — 100% Verified)*
• Bas WhatsApp pe *question photo / screenshot / PDF* bhej do — auto-detect + solve!
• /solve [instructions] — attached ya pichli photo ke saare questions 100% verify karke solve karo
• /solve screen [instructions] — laptop screen pe khule online test / LeetCode / PDF question ko solve karo
• /solve <question text> — typed math / physics / code / SQL / GK question full Python+Audit check ke saath
• /solve status · /solve setup — SymPy + NumPy + Pillow + OCR + Vision readiness check

*🚀 DeepSeek Harness (2.9.0 — Full Linux Coding & System Agent)*
• /dsh <task> — poora DeepSeek Harness power (bash + coding + files + subagents + WhatsApp MCP!)
• /dsh auto on|off — har WhatsApp message seedha DeepSeek Harness se chalao
• /dsh web [open|stop|desktop] — Fedora browser/desktop aur phone pe official DeepSeek Harness UI
• /dsh install · /dsh status · /dsh key <sk-...> · /dsh model [provider/model]
• /dsh cd <folder> · /dsh new [task] · /dsh sessions · /dsh use <id> · /dsh mode full|safe|readonly

*Naye (2.8.0)*
• /undo — pichhla file kaam wapas (write/move/copy/delete/mkdir/zip) · /undo list
• /usage — aaj ka AI quota: kaun sa brain kitna kharch, 80% pe warning
• /shots — screenshot auto-delete (default 4 min) · /shots clean — abhi saaf
• /watch <condition> — "jab ye ho jaye to batao" (screenshot + vision) · /watch list|stop
• /teach start <naam> → commands karo → /teach stop → phir /<naam>
• /brief — aaj ka poora brief; /brief on 9am — roz subah khud bhejega
• /remote — kahin se bhi control (WhatsApp se ya phone app se)

*Do things*
• /remind in 10m <text> · /todo add <text> · /note <text> · /remember <fact>
• /cron add every 10m <text> · /cron add roz 9 baje <text> · /cron list|del
• /voicereply <text> — JARVIS ki awaaz me voice note · /call on — har jawab voice me
• /callme — JARVIS tumhe WhatsApp call kare · /callat at 18:30 /brief — set time pe JARVIS ki update-call · /voice — voice status
• /auto <task> — UI autopilot (verified): open chrome | tap Search | type hello | key enter | screenshot
• /arena <prompt> — arena.ai/agent kholo, prompt type karo, jawab padho (screenshot proof ke saath)
• /use <task> — *haath*: screen dekho → click/type/scroll → dobara dekho (8 steps, screenshot proof)
• /stop — jo chal raha hai wahi rukta hai (partial steps batata hai) · naya: update ka message khud aata hai
• /learn <keyword> <cmds> — e.g. /learn work open chrome | open slack | open code  — then just /work  ·  /learn list|del
• /weather · /wiki · /news · /calc · /unit · /currency · /url · /qr
• /observer <task> (optional Observer app) · /screen
*Safety*
• /doctor — kya kaam nahi kar raha, aur exact fix (screenshot/input/AI)
• /access — what is allowed · /yes · /no (destructive actions ask first)
• /run <PIN> <command> — shell, only if ALLOW_SHELL=true

_Built-in commands work with no AI at all. Local Ollama makes conversation + multi-step tasks unlimited and offline._`;

const num = (s) => Number.parseInt(String(s ?? ''), 10);

export function createAgent({
  config, store, log = console, forwardToObserver = async () => null, observerOnline = () => false,
  taskRegistry = globalTasks, notify = null,
}) {
  const tz = config.timezone;
  // The signal of whatever command is running right now. Commands are
  // serialized (isProcessing), so one slot is enough; /stop does not use it.
  let activeSignal = null;
  // Unsolicited messages (live progress, watch alerts). index.js wires this to
  // WhatsApp; in tests it stays a no-op so nothing ever sends by accident.
  const notifyOwner = typeof notify === 'function' ? notify : async () => false;
  const journal = createJournal({ config, log });
  // Same janitor instance the background loop uses, so /shots and the timer
  // agree on one ledger.
  const shots = createShotJanitor({ config, log });
  const harness = createHarness({ config, store, log });
  const actions = createActions({ config, store, log, journal, notify: notifyOwner, harness });
  const agentLoop = createAgentLoop({ config, store, actions, log });
  // Real WhatsApp call answering (src/wavoip.js) is attached by index.js —
  // it needs the WhatsApp layer's owner-LID knowledge, which commands.js
  // deliberately does not own.
  let waVoip = null;
  // ONE voice brain for the real WhatsApp call, the phone-app call and
  // WhatsApp voice notes: speech → this same handle() → JARVIS voice back.
  const voice = createVoiceCall({
    config,
    store,
    log,
    runText: (text) => handle(text, { source: 'voicecall', voice: true, waStatus: () => 'voice call' }),
    speak: (text) => tts.synthesize(text, config, log),
    hasPending: () => Boolean(store.data.pending),
    stopAll: () => stopCommand(),
  });
  const router = routerFor(config, log);
  // /usage needs per-call counts; the router owns the calls, the store owns
  // persistence, so the hook joins them (and never throws into a model call).
  try { router.setRecordHook?.((modelId, info) => usage.noteUsage(store, modelId, info)); } catch { /* older router */ }

  /** Execute an action and shape it into a WhatsApp reply object. */
  function toReply(result) {
    if (typeof result === 'string') return result;
    if (!result) return '✅ Done.';
    const out = {};
    if (result.text) out.text = result.text;
    if (result.image) out.image = result.image;
    if (result.extraImages) out.extraImages = result.extraImages;
    if (result.document) out.document = result.document;
    if (result.video) out.video = result.video;
    if (result.audio) out.audio = result.audio;
    if (result.mimetype) out.mimetype = result.mimetype;
    if (result.ptt != null) out.ptt = result.ptt;
    return Object.keys(out).length ? out : '✅ Done.';
  }
  const act = async (name, args = {}, ctx = {}) => {
    const result = await actions.execute(name, args, { signal: activeSignal, ...ctx });
    // Text-only results stay strings (friendlier for WhatsApp + existing code);
    // media results keep their reply object.
    if (result && typeof result === 'object' && !result.image && !result.extraImages
        && !result.document && !result.video && !result.audio) {
      return result.text ?? (result.ok ? '✅ Done.' : "⚠️ That didn't work.");
    }
    return toReply(result);
  };

  async function handleDsh(args, ctx = {}) {
    const raw = String(args ?? '').trim();
    const [subRaw, ...restParts] = raw.split(/\s+/);
    const sub = (subRaw || '').toLowerCase();
    const rest = raw.slice(subRaw ? subRaw.length : 0).trim();
    const media = ctx?.mediaMeta;

    if (!raw || sub === 'status') {
      const s = harness.status();
      const lines = [
        `🚀 *DeepSeek Harness* — ${s.installed ? `✅ ready (${s.version})` : '📦 install pending (`/dsh install`)'}`,
        `• Runtime: ${s.sdkRunning ? '🟢 warm SDK daemon active' : '⚪ idle (starts automatically on first task)'}`,
        `• Primary mode: ${s.autoRoute ? '*ON* (every WhatsApp message uses DSH)' : 'off (use `/dsh <task>` or `/dsh auto on`)'}`,
        `• Permission: \`${s.permissionMode}\` · Node: \`${s.nodeVersion || 'auto'}\``,
        `• Brain: \`${s.selectedModel}\``,
        `• Folder: \`${s.cwd}\``,
        `• Session: ${s.activeSessionId ? `\`${s.activeSessionId.slice(0, 12)}\`` : '_new session on next prompt_'}`,
        s.web.running
          ? `• Web UI (PC): ${s.web.localUrl}${s.web.lanUrls?.length ? `\n• Web UI (Phone/LAN): ${s.web.lanUrls[0]}` : ''}`
          : '• Web UI: stopped — `/dsh web` to launch official UI',
        '',
        '*Quick commands*',
        '• `/dsh <task>` — full coding, bash, files, subagents & WhatsApp MCP',
        '• `/dsh auto on` — har WhatsApp message seedha DeepSeek Harness se',
        '• `/dsh web open` — Fedora PC pe official DeepSeek Harness window kholo',
        '• `/dsh web desktop` — Fedora App Grid me native *DeepSeek Harness* icon jodo',
        '• `/dsh cd ~/project` · `/dsh new` · `/dsh sessions` · `/dsh model`',
      ];
      return lines.join('\n');
    }

    if ((sub === 'install' || sub === 'setup' || sub === 'upgrade') && !rest) {
      const res = await harness.install({
        force: sub === 'upgrade',
        onProgress: (msg) => notifyOwner(msg),
      });
      return [
        `✅ *DeepSeek Harness ${res.alreadyInstalled ? 'ready' : 'installed'}!*`,
        `• Version: \`${res.version}\``,
        `• Binary: \`${res.dshBin}\``,
        `• Node: \`v${res.nodeVersion}\``,
        '',
        'Ab bhejo: `/dsh <apna kaam>` ya `/dsh web` ya `/dsh auto on` 🚀',
      ].join('\n');
    }

    if (sub === 'key' && rest) {
      const s = await harness.setApiKey(rest);
      return `🔑 *DeepSeek API key saved* (\`~/.dsh/.credentials.yaml\`, \`0600\`).\nActive brain: \`${s.selectedModel}\`\nTry: \`/dsh build a status script and send output\``;
    }

    if (sub === 'model' || sub === 'models') {
      if (!rest) {
        const s = harness.status();
        const avail = s.availableModels.length
          ? s.availableModels.map((m) => `• \`${m}\``).join('\n')
          : '• _(No API key configured yet — run `/dsh key sk-...`, sign into DeepSeek Account via `/dsh web`, or add Groq/OpenRouter/Local model)_';
        return `🧠 *DeepSeek Harness Brains*\nCurrent: \`${s.selectedModel}\`\n\n*Configured models*\n${avail}\n\nSwitch: \`/dsh model deepseek/deepseek-reasoner\` or \`/dsh model auto\``;
      }
      const next = harness.setModel(rest);
      return `🧠 DeepSeek Harness model set to \`${next}\`.`;
    }

    if (sub === 'mode') {
      if (!rest) return '🔐 Usage: `/dsh mode full` (danger-full-access) · `/dsh mode safe` (workspace-write) · `/dsh mode readonly`';
      const next = await harness.setPermissionMode(rest);
      return `🔐 DeepSeek Harness permission mode → \`${next}\` (SDK runtime restarted).`;
    }

    if (sub === 'auto') {
      const flag = /^(on|true|1|yes|haan|chalu)$/i.test(rest || 'on');
      const off = /^(off|false|0|no|band)$/i.test(rest);
      const enabled = harness.setAutoRoute(off ? false : flag);
      return enabled
        ? '🚀 *DeepSeek Harness Auto Mode: ON*\nAb aapka har normal WhatsApp message seedha full-power DeepSeek Harness agent (`bash` + coding + subagents + Fedora MCP) me jayega!\n_(Band karne ke liye `/dsh auto off`)_'
        : '👍 *DeepSeek Harness Auto Mode: OFF*\nNormal chat Observer router pe wapas aa gaya. Jab bhi full power chahiye ho, `/dsh <task>` likho.';
    }

    if (sub === 'cd' || sub === 'workdir' || sub === 'dir') {
      if (!rest) return `📂 Current folder: \`${harness.status().cwd}\`\nChange: \`/dsh cd ~/projects/my-app\``;
      const next = harness.setWorkdir(rest);
      return `📂 DeepSeek Harness working folder → \`${next}\``;
    }

    if (sub === 'sessions' || sub === 'list') {
      const s = harness.status();
      if (!s.sessions.length) return '🗂️ Abhi koi saved WhatsApp DSH session nahi hai. `/dsh <task>` bhejo!';
      return [
        '🗂️ *Recent DeepSeek Harness Sessions*',
        ...s.sessions.slice(0, 12).map((item, idx) => (
          `${item.id === s.activeSessionId ? '👉' : `${idx + 1}.`} \`${item.id.slice(0, 12)}\` — ${item.title || 'Session'} _(${item.turns || 1} turns · \`${item.cwd}\`)_`
        )),
        '',
        'Switch: `/dsh use <id>` · Fresh session: `/dsh new`',
      ].join('\n');
    }

    if ((sub === 'use' || sub === 'resume') && rest) {
      const hit = harness.useSession(rest);
      return `🔄 Switched to DeepSeek Harness session \`${hit.id}\` (${hit.title}). Ab seedha agla message bhejo!`;
    }

    if (sub === 'new' || sub === 'reset') {
      harness.resetSession();
      if (!rest) return '✨ Fresh DeepSeek Harness session ready! Ab `/dsh <task>` bhejo.';
      return handleDsh(rest, ctx);
    }

    if (sub === 'web') {
      const action = (restParts[0] || 'start').toLowerCase();
      if (action === 'stop' || action === 'off' || action === 'band') {
        await harness.stopWeb();
        return '🛑 DeepSeek Harness Web UI stopped.';
      }
      if (action === 'desktop' || action === 'app') {
        const res = await harness.installDesktopLauncher();
        return [
          '🖥️ *DeepSeek Harness Desktop App Installed!*',
          `• Launcher: \`${res.desktopFile}\``,
          `• PC URL: ${res.web.localUrl}`,
          ...(res.web.lanUrls?.length ? [`• Phone/LAN URL: ${res.web.lanUrls[0]}`] : []),
          '',
          'Ab Fedora Activities / App Grid me **DeepSeek Harness** search karke native app window me khol sakte ho!',
        ].join('\n');
      }
      const ws = await harness.startWeb({ onProgress: (msg) => notifyOwner(msg) });
      if (action === 'open' || action === 'kholo') {
        try { await pc.openTarget(ws.localUrl); } catch { /* headless fallback */ }
      }
      return [
        '🌐 *DeepSeek Harness Official Web UI Running!*',
        `• 🖥️ Fedora PC: ${ws.localUrl}`,
        ...(ws.lanUrls?.length ? [`• 📱 Phone / Tailscale: ${ws.lanUrls[0]}`] : []),
        '',
        '_Tip: WhatsApp sessions aur Web UI sessions ek hi `~/.dsh` share karte hain — dono jagah live dikhenge!_',
      ].join('\n');
    }

    // ── Full-power task execution inside DeepSeek Harness ──────────────────
    const images = [];
    const attachedFiles = [];
    if (media?.buffer && media.mediaKind === 'image') {
      images.push({ buffer: media.buffer, mimeType: media.mimeType || 'image/jpeg' });
    }
    if (media?.savedPath) {
      attachedFiles.push({ path: media.savedPath, mimeType: media.mimeType || '' });
    }

    const out = await harness.runTask(raw, {
      images,
      files: attachedFiles,
      signal: activeSignal,
      onProgress: (stepLine) => notifyOwner(stepLine),
    });

    const footer = `\n\n_⚡ DeepSeek Harness · session \`${String(out.sessionId).slice(0, 8)}\`${out.toolCalls.length ? ` · ${out.toolCalls.length} tool(s)` : ''}_`;
    return `${out.text}${footer}`;
  }

  // ── individual commands ──────────────────────────────────────────────────

  function remind(args) {
    if (!args || args === 'list') return listReminders();
    const del = args.match(/^del(?:ete)?\s+(\d+)$/i);
    if (del) return store.deleteReminder(num(del[1])) ? `🗑️ Reminder #${del[1]} deleted.` : `No reminder #${del[1]}. See /reminders`;
    const parsed = tools.parseWhen(args);
    if (!parsed || !parsed.rest) {
      return '⏰ I didn\'t get the time. Try:\n/remind in 10m drink water\n/remind at 18:30 gym\n/remind tomorrow 9am standup';
    }
    const r = store.addReminder(parsed.rest, parsed.dueTs);
    return `⏰ Done — I'll remind you about *${r.text}* on ${tools.formatDateTime(r.dueTs, tz)} (in ${tools.humanDuration(r.dueTs - Date.now())}).`;
  }

  function listReminders() {
    if (!store.data.reminders.length) return '⏰ No reminders set. Try: /remind in 10m drink water';
    return '⏰ *Reminders*\n\n' + store.data.reminders.map((r) => `#${r.id} · ${tools.formatDateTime(r.dueTs, tz)} — ${r.text}`).join('\n');
  }

  // ── cron (recurring scheduled jobs) ──────────────────────────────────────
  function cronCmd(args) {
    const raw = String(args ?? '').trim();
    if (!raw || raw.toLowerCase() === 'list' || raw.toLowerCase() === 'ls') {
      const jobs = store.listCronJobs();
      if (!jobs.length) return '🔁 No scheduled jobs. Add one:\n/cron add every 10m drink water\n/cron add roz 9 baje good morning\n/cron add every Monday at 9am standup';
      return '🔁 *Scheduled jobs*\n\n' + jobs.map((j) => {
        const when = cron.formatSchedule(j.schedule, j.nextDueTs, tz);
        return `#${j.id} · ${when}\n  ${j.text}`;
      }).join('\n\n');
    }
    const del = raw.match(/^(?:del|delete|rm|remove)\s+(\d+)$/i);
    if (del) return store.deleteCronJob(num(del[1])) ? `🗑️ Scheduled job #${del[1]} deleted.` : `No scheduled job #${del[1]}. See /cron list`;
    let addText = raw;
    addText = addText.replace(/^add\s+/i, '');
    const parsed = cron.parseCronSchedule(addText, new Date());
    if (!parsed) {
      return '🔁 I didn\'t get the schedule. Try:\n/cron add every 10m drink water\n/cron add every day at 9am good morning\n/cron add roz 9 baje chai\n/cron add every Monday at 9am standup';
    }
    if (parsed.error) return `⚠️ ${parsed.error}`;
    if (!parsed.rest) return '🔁 Schedule samjha, par message kya hai? e.g. /cron add every 10m drink water';
    const job = store.addCronJob(parsed.rest, parsed.scheduleRaw, parsed.schedule, parsed.nextDueTs);
    return `🔁 Done — scheduled #${job.id}: *${job.text}*\n_${job.scheduleRaw} → ${tools.formatDateTime(job.nextDueTs, tz)} (in ${tools.humanDuration(job.nextDueTs - Date.now())})_`;
  }

  // ── JARVIS voice call centre (/call, /callme, /voice) ─────────────────────

  function callStatusLines() {
    const voip = waVoip?.status?.() ?? null;
    const mode = Boolean(store.data.voiceCallMode || config.whatsappVoiceReplies);
    const nextCall = (store.data.callSchedules ?? [])[0];
    return [
      `• WhatsApp Voice Mode (/call): ${mode ? '*ON* — har jawab JARVIS voice note me' : 'off — /call on se chalu karo'}`,
      voip
        ? `• Asli WhatsApp call uthana: ${voip.connected ? '*READY 📞* — seedha call karo, JARVIS uthayega' : `${voip.enabled ? 'engine on, ' : ''}${voip.hint}`}`
        : '• Asli WhatsApp call uthana: engine attached nahi (setup: `bash scripts/observer.sh voice call-engine`)',
      `• Scheduled call (/callat): ${nextCall ? `agli ${tools.formatDateTime(nextCall.dueTs, tz)} — "${nextCall.text.slice(0, 60)}"` : 'koi nahi — /callat at 18:30 /brief lagao, JARVIS khud call karega'}`,
      `• JARVIS ki boli: *English only*${config.jarvisEnglishOnly === false ? ' (off hai — JARVIS_ENGLISH_ONLY)' : ''} — tum Hindi/Hinglish bol sakte ho, samajhle ga`,
      '• Phone app 📞 Call tab: bolo → command execute → JARVIS jawab (koi setup nahi)',
      '• Voice note bhi bhej sakte ho — transcribe karke wahi command chalega',
    ];
  }

  async function jarvisAudioReply(text) {
    try {
      const result = await tts.synthesize(text, config, log);
      const isOpus = result.mimetype.includes('opus') || result.ext === 'ogg';
      return { audio: result.buffer, mimetype: result.mimetype, ptt: isOpus, text };
    } catch (err) {
      return `${text}\n\n⚠️ _Voice note nahi bana: ${err.message}_`;
    }
  }

  async function callCommand(args) {
    const sub = String(args ?? '').trim().toLowerCase();
    if (/^(on|start|chalu|enable)$/.test(sub)) {
      store.data.voiceCallMode = true;
      store.save();
      const greeting = jarvisGreeting(config);
      const spoken = `${greeting} Voice call mode is now on. Send me a voice note, and consider it done.`;
      const reply = await jarvisAudioReply(spoken);
      const note = [
        '📞 *Voice Call Mode: ON*',
        'Ab har jawab JARVIS ki awaaz me aayega. *Voice note bhejo* — main sun ke command execute kar dunga ("chrome kholo aur screenshot bhej do" chalega).',
        waVoip?.status?.().connected
          ? 'Aur haan — *seedha WhatsApp call bhi kar sakte ho*, main utha lunga. 📞'
          : 'Asli WhatsApp call uthane ke liye ek baar: `bash observer.sh voice call-engine` (WHATSAPP-CALL.md)',
        'Band karne ke liye: /call off',
      ].join('\n');
      return typeof reply === 'string' ? `${note}\n\n${reply}` : { ...reply, text: note };
    }
    if (/^(off|stop|band|disable)$/.test(sub)) {
      store.data.voiceCallMode = false;
      store.save();
      return '📞 Voice Call Mode: OFF — jawab wapas sirf text me aayenge. /call on se kabhi bhi chalu kar lena.';
    }
    return ['📞 *JARVIS Voice Call — status*', ...callStatusLines(), '', tts.ttsStatus(config)].join('\n');
  }

  async function callMeCommand(args) {
    if (!waVoip) {
      return '📞 Sir, outbound WhatsApp call ke liye VoIP engine chahiye.\nSetup (ek baar): `bash scripts/observer.sh voice call-engine` phir `bash scripts/observer.sh voice link-voip`\nTab tak phone app ka 📞 Call tab use karo — wahan main sun bhi sakta hoon, bol bhi.';
    }
    const st = waVoip.status();
    if (!st.connected) return `📞 VoIP engine ready nahi: ${st.hint}`;
    try {
      await waVoip.callOwner(String(args ?? '').trim());
      return '📞 Call kar raha hoon, Sir — phone uthao, JARVIS line par hai.';
    } catch (err) {
      return `⚠️ Call nahi lagi: ${err.message}`;
    }
  }

  // `/callat at 18:30 /brief` — at that time JARVIS CALLS you and speaks the
  // update ("mere set time pe call karke update dein"). Text starting with /
  // runs as a command at fire time; anything else is spoken as-is. Engine
  // off/unreachable → JARVIS voice note + text instead (update never lost).
  function callAtCommand(args) {
    const raw = String(args ?? '').trim();
    const list = () => {
      const items = store.data.callSchedules ?? [];
      if (!items.length) return '📞 Koi scheduled call nahi hai.\nLagao: /callat at 18:30 /brief\nYa: /callat in 30m Dinner ready hai, khana kha lena';
      return ['📞 *Scheduled JARVIS calls*', ...items.map((s) => `#${s.id} · ${tools.formatDateTime(s.dueTs, tz)} — ${s.text}`), '', 'Cancel: /callat del <#>'].join('\n');
    };
    if (!raw || /^list$/i.test(raw)) return list();
    const del = raw.match(/^del(?:ete)?\s+(\d+)$/i);
    if (del) return store.deleteCallSchedule(num(del[1])) ? `🗑️ Scheduled call #${del[1]} cancelled.` : `No scheduled call #${del[1]}. See /callat`;
    const parsed = tools.parseWhen(raw);
    if (!parsed || !parsed.rest) {
      return '⏰ Samay nahi samjha, Sir. Try:\n/callat in 30m <kya bolna hai>\n/callat at 18:30 /brief\n/callat tomorrow 9am Good morning bolke weather bata dena';
    }
    const item = store.addCallSchedule(parsed.rest, parsed.dueTs);
    const isCmd = item.text.trimStart().startsWith('/');
    return `📞 Done, Sir — *${tools.formatDateTime(item.dueTs, tz)}* (in ${tools.humanDuration(item.dueTs - Date.now())}) main khud call karke ${isCmd ? `\`${item.text}\` ka update bolunga` : `ye bolunga: "${item.text}"`}.\n${waVoip?.status?.().connected ? 'VoIP engine ready hai — asli call aayegi.' : '_(VoIP engine abhi ready nahi: waqt pe call na lagi to JARVIS voice note aa jayega. Asli call ke liye: `bash scripts/observer.sh voice call-engine`)_'}\nDekho/cancel: /callat`;
  }

  async function voiceReply(args) {
    const text = String(args ?? '').trim();
    if (!text) return '🔊 Usage: /voicereply <text> — e.g. /voicereply Good evening, Sir\nJARVIS ki awaaz me voice note jayega. Har jawab voice me chahiye? /call on';
    try {
      const result = await tts.synthesize(text, config, log);
      const isOpus = result.mimetype.includes('opus') || result.ext === 'ogg';
      return {
        audio: result.buffer,
        mimetype: result.mimetype,
        ptt: isOpus,
        text: `🔊 ${text.slice(0, 200)}${text.length > 200 ? '…' : ''}`,
      };
    } catch (err) {
      if (/setup nahi|engine nahi|not installed|not found|kaam nahi kiya/i.test(err.message)) {
        return `⚠️ ${err.message}\n\nEk command me asli JARVIS voice: \`bash scripts/observer.sh voice setup\`\nPhir try karo: /voicereply Good evening, Sir`;
      }
      return `⚠️ Voice nahi bana paaya: ${err.message}`;
    }
  }

  // ── learn custom keywords ──────────────────────────────────────────────
  function learnCmd(args) {
    const raw = String(args ?? '').trim();
    if (!raw || raw.toLowerCase() === 'list' || raw.toLowerCase() === 'ls') {
      const all = store.listLearned();
      if (!all.length) return '📚 No learned keywords yet. Teach one:\n/learn work open chrome | open slack | open code\n/learn work chrome, slack, code  (shorthand: each word = app to open)\nThen just type /work';
      return '📚 *Learned keywords*\n\n' + all.map(e => `• /${e.keyword} → ${e.commands.map(c => c.inferredOpen ? c.args : `/${c.cmd}${c.args ? ' '+c.args : ''}`).join(' | ')}`).join('\n');
    }
    // delete forms: del work / delete work / rm work / remove work / unlearn work
    let m = raw.match(/^(?:del|delete|rm|remove|unlearn|forget)\s+([a-z0-9_-]+)$/i);
    if (m) {
      const kw = learn.normalizeKeyword(m[1]);
      return store.deleteLearned(kw) ? `🗑️ /${kw} deleted.` : `No learned keyword /${kw}. See /learn list`;
    }
    // handle "add work ..." prefix
    let addText = raw.replace(/^add\s+/i, '');
    // split keyword from commands: first word is keyword, rest is commands
    const sp = addText.search(/\s/);
    if (sp === -1) {
      return '📚 Usage: /learn <keyword> <commands>\nE.g. /learn work open chrome | open slack | open code\nOr shorthand: /learn work chrome slack vscode';
    }
    const keywordRaw = addText.slice(0, sp).trim();
    const commandsRaw = addText.slice(sp+1).trim();
    if (!commandsRaw) return `📚 /learn ${keywordRaw} — commands kya hai? E.g. /learn ${keywordRaw} open chrome | open slack`;
    const kw = learn.normalizeKeyword(keywordRaw);
    const err = learn.validateKeyword(kw);
    if (err) return `⚠️ ${err}`;
    const cmds = learn.parseLearnCommands(commandsRaw);
    if (!cmds) return '⚠️ Commands samajh nahi aaye. Try:\n/learn work open chrome | open slack\n/learn work chrome, slack, code';
    const entry = store.addLearned(kw, cmds, commandsRaw);
    const steps = cmds.map(c => c.inferredOpen ? c.args : `/${c.cmd}${c.args ? ' '+c.args : ''}`).join(' | ');
    return `📚 Learned /${kw} → ${steps}\nAb bas /${kw} likho aur ye saare kaam ek saath honge.`;
  }

  async function runLearned(keyword, ctx) {
    const entry = store.getLearned(keyword);
    if (!entry) return null;
    const results = [];
    for (const step of entry.commands) {
      // inferredOpen → open_app, else use step.cmd/args
      const cmd = step.inferredOpen ? 'open' : step.cmd;
      const args = step.inferredOpen ? step.args : step.args;
      const r = await handleCommand(cmd, args, ctx);
      const out = typeof r === 'string' ? r : (r?.text ?? '');
      // if media reply, push media handling? For now just text
      if (r && typeof r === 'object' && (r.image || r.audio || r.document || r.video)) {
        // if media, we need to send it — but stacking text join loses media. For /work we mostly open apps (text).
        // We'll send media immediately via a side effect? Instead collect text and if any step returns media, we will return that media reply (last media wins)
        // For simplicity, if any step has media, return it as final; caller will handle stacking text already collected
        // We push text part and note media
        results.push(out || '(media)');
        // TODO: media stacking could be improved to send multiple messages; for now last media will be in final reply
        if (r.image || r.audio || r.document || r.video) {
          // store last media to merge into final
          results._lastMedia = r;
        }
      } else {
        results.push(out);
      }
    }
    const text = `📚 /${keyword} (${entry.commands.length} steps):\n\n` + results.join('\n\n---\n\n');
    const lastMedia = results._lastMedia;
    if (lastMedia) {
      return { ...lastMedia, text };
    }
    return text;
  }

  function todo(args) {
    const [sub, ...rest] = (args || '').split(/\s+/);
    const restText = rest.join(' ');
    if (!args || sub === 'list') {
      if (!store.data.todos.length) return '✅ To-do list is empty. Add: /todo add buy milk';
      return '✅ *To-dos*\n\n' + store.data.todos.map((t) => `#${t.id} ${t.done ? '✔️~~' : '▫️'}${t.text}${t.done ? '~~' : ''}`).join('\n');
    }
    if (sub === 'add' && restText) { const t = store.addTodo(restText); return `✅ Added #${t.id}: ${t.text}`; }
    if ((sub === 'done' || sub === 'undone') && rest[0]) {
      const t = store.setTodoDone(num(rest[0]), sub === 'done');
      return t ? `${t.done ? '✔️ Done' : '↩️ Reopened'}: ${t.text}` : `No to-do #${rest[0]}.`;
    }
    if ((sub === 'del' || sub === 'delete' || sub === 'rm') && rest[0]) {
      return store.deleteTodo(num(rest[0])) ? `🗑️ To-do #${rest[0]} deleted.` : `No to-do #${rest[0]}.`;
    }
    if (sub === 'clear') return `🧹 Cleared ${store.clearDoneTodos()} completed to-do(s).`;
    // "/todo buy milk" = add
    const t = store.addTodo(args);
    return `✅ Added #${t.id}: ${t.text}`;
  }

  function note(args) {
    const del = (args || '').match(/^del(?:ete)?\s+(\d+)$/i);
    if (del) return store.deleteNote(num(del[1])) ? `🗑️ Note #${del[1]} deleted.` : `No note #${del[1]}.`;
    if (!args) return '📝 Usage: /note <text> — see all with /notes';
    const n = store.addNote(args);
    return `📝 Saved note #${n.id}.`;
  }

  function notes() {
    if (!store.data.notes.length) return '📝 No notes yet. Save one: /note gate code is 4321';
    return '📝 *Notes*\n\n' + store.data.notes.map((n) => `#${n.id} · ${n.text}`).join('\n');
  }

  function remember(args, ctx = {}) {
    const text = (args || '').replace(/^that\s+/i, '').trim();
    if (!text) return '🧠 Usage: /remember <thing> — e.g. /remember my bike number is UK04 AB 1234 (ya seedha bolo "mera naam Pavit hai")';
    const parsedRule = mem.parseRuleStatement(text);
    if (parsedRule) {
      if (parsedRule.kind === 'directive') {
        mem.rememberFact(store, `owner_priority_rule: ${parsedRule.value}`, { explicit: true });
        return '🧠 Remembered — bilkul! Jo aap kahenge wohi hoga, chahe pehle se kuch aur save ho. (/memory to see all)';
      }
      if (parsedRule.kind === 'fact') {
        const r = mem.rememberFact(store, parsedRule.text, { explicit: true });
        return r?.reply ?? '🧠 Remembered. I\'ll keep it in mind in our chats. (/memory to see all)';
      }
      const r = mem.addRule(store, parsedRule);
      return r?.reply ?? '🧠 Remembered. I\'ll keep it in mind in our chats. (/memory to see all)';
    }
    const res = mem.rememberFact(store, text, { explicit: true });
    if (res && ctx?.voice && config.jarvisEnglishOnly !== false) {
      if (res.key === 'name') {
        return res.updated
          ? `Very well, ${res.value}. I have updated your name from ${res.previousValue} to ${res.value}.`
          : `Pleasure to meet you, ${res.value}. I shall remember your name.`;
      }
      return `Noted and remembered, ${mem.getOwnerAddress(store, config)}.`;
    }
    return res?.reply ?? '🧠 Remembered. I\'ll keep it in mind in our chats. (/memory to see all)';
  }

  function memory(args = '', ctx = {}) {
    const q = String(args ?? '').trim();
    if (q) {
      const answered = mem.handleMemoryIntent(store, config, q, { voice: Boolean(ctx?.voice) });
      if (answered) return answered;
      const val = mem.getFactValue(store, q);
      if (val) return `🧠 *${mem.canonicalSlot(q).label}*: *${val}*`;
    }
    return mem.formatMemoryList(store);
  }

  // Pending destructive PC actions awaiting "/pc confirm" (60 s window).
  let pendingPower = null;
  let pendingTap = null;
  // A tap whose label smells irreversible asks first (same as power actions).
  const RISKY_TAP = /\b(delete|remove|pay|payment|buy|purchase|checkout|place order|transfer|send money|uninstall|format|erase|factory reset|discard)\b/i;

  const TIER2_OFF =
    '🔒 Input/power PC control is OFF (ALLOW_PC_CONTROL=false) — the safe default even though I only listen to you.\n' +
    'To turn it on, on the PC: set ALLOW_PC_CONTROL=true in whatsapp-agent/.env (optionally CONTROL_PIN=1234), ' +
    'install the tools (sudo dnf install ydotool xdotool, enable the daemon: sudo systemctl enable --now ydotool), ' +
    'then systemctl --user restart observer-whatsapp-agent.\n' +
    'Already working without it: /pc screenshot, volume, brightness, media, open, lock, clipboard, find/get.';

  /** Strip + verify the optional CONTROL_PIN for tier-2 commands. Returns arg text or null (replied). */
  function tier2Gate(rest) {
    if (!config.allowPcControl) return { reply: TIER2_OFF };
    if (!config.controlPin) return { text: rest };
    const m = String(rest ?? '').match(/^(\S+)(?:\s+([\s\S]*))?$/);
    if (!m || m[1] !== config.controlPin) return { reply: '🔒 This PC-control command needs your PIN first, e.g. /pc type 1234 hello · /pc key 1234 ctrl+l · /pc shutdown 1234' };
    return { text: m[2] ?? '' };
  }

  async function handlePc(args) {
    const raw = (args || 'status').trim();
    const [subRaw, ...restParts] = raw.split(/\s+/);
    const sub = subRaw.toLowerCase();
    const rest = restParts.join(' ');
    const value = num(restParts.find((p) => /^\d+$/.test(p)));

    switch (sub) {
      case 'status': case 'info': return tools.systemInfo(store.data.stats.startedAt);
      case 'disk': {
        try {
          const s = fs.statfsSync(config.dataDir);
          const total = s.blocks * s.bsize;
          const free = s.bavail * s.bsize;
          return `💾 Disk: *${(free / 1024 ** 3).toFixed(1)} GB free* of ${(total / 1024 ** 3).toFixed(1)} GB (${Math.round(((total - free) / total) * 100)}% used)`;
        } catch { return '💾 Could not read disk info on this system.'; }
      }
      case 'ip': return tools.systemInfo(store.data.stats.startedAt).split('\n').find((l) => l.startsWith('LAN IP')) ?? 'No LAN IP found.';
      case 'battery': return tools.batteryStatus() ?? '🔌 No battery found — this PC/VM reports none under /sys/class/power_supply (normal for desktops).';
      case 'top': return pc.topProcesses();
      case 'screenshot': case 'shot': {
        const image = await pc.captureScreenshot({ portalTimeoutMs: config.portalTimeoutMs });
        return { image, text: `🖥️ Screenshot · ${new Date().toLocaleTimeString('en-IN', { timeZone: tz })}` };
      }
      case 'volume': case 'vol': {
        const action = !rest ? 'get' : /^\d+$/.test(restParts[0]) ? 'set' : sub2volumeAction(restParts[0]);
        return pc.volume(action, value);
      }
      case 'brightness': case 'bright': {
        let action = !rest ? 'get' : /^\d+$/.test(restParts[0]) ? 'set' : sub2volumeAction(restParts[0]);
        if (action === 'mute') action = 'get';
        return pc.brightness(action, value);
      }
      case 'media': case 'music': {
        const action = (restParts[0] ?? 'status').toLowerCase();
        if (!['play', 'pause', 'toggle', 'next', 'prev', 'previous', 'stop', 'status'].includes(action)) return '🎵 Usage: /pc media play|pause|next|prev|stop|status';
        return pc.media(action);
      }
      case 'open': {
        if (!rest) return '🚀 Usage: /open <app name> — /apps lists everything installed.';
        return act('open_app', { app: mem.resolvePreferredApp(store, rest) });
      }
      case 'close': case 'quit': return act('close_app', { app: rest });
      case 'notify': return rest ? pc.desktopNotify(rest) : '🔔 Usage: /pc notify <text>';
      case 'lock': return pc.lockSession();
      case 'clipboard': case 'clip': return pc.clipboardGet();
      case 'clipset': return pc.clipboardSet(rest);
      case 'find': {
        const found = await pc.findFiles(rest);
        return found.length
          ? '🔎 *Found under ~*\n\n' + found.map((f) => `• ~/${f}`).join('\n') + '\n\nFetch one with /send ~/<path>'
          : `🔎 Nothing under your home folder matches "${rest}".`;
      }
      case 'get': {
        const resolved = pc.resolveHomeFile(rest);
        if (!resolved.ok) return `📂 ${resolved.reason}`;
        const stat = fs.statSync(resolved.file);
        if (stat.isDirectory()) {
          const names = fs.readdirSync(resolved.file).slice(0, 30);
          return `📂 ${resolved.file}\n\n` + (names.map((n) => `• ${n}`).join('\n') || '(empty)');
        }
        if (stat.size > 64 * 1024 * 1024) return '📂 That file is over WhatsApp\'s 64 MB document limit.';
        return { text: `📄 ${path.basename(resolved.file)} (${(stat.size / 1024).toFixed(0)} KB)`, document: { buffer: fs.readFileSync(resolved.file), fileName: path.basename(resolved.file) } };
      }
      case 'locate': case 'findui': {
        const hit = await finder.locateOnScreen(config, rest, log);
        const image = await finder.annotateScreenshot(hit.screenshot, hit.x, hit.y, hit.width, hit.height);
        const pinPrefix = config.controlPin ? '<PIN> ' : '';
        const sourceDesc = hit.source === 'atspi'
          ? `AT-SPI widget [${hit.role || 'widget'}], ${hit.confidence ?? 100}% exact`
          : hit.source === 'ocr'
          ? `OCR text match, ${hit.confidence}% sure`
          : 'vision model';
        return {
          image,
          text: `🎯 Found "${hit.matched}" at *${hit.x}, ${hit.y}* (${sourceDesc}).\nClick it: /pc tap ${pinPrefix}${rest} — or raw: /pc click ${pinPrefix}${hit.x} ${hit.y}`,
        };
      }
      case 'elements': case 'ui': case 'ground':
        return act('inspect_ui');
      // ── tier 2: input + power ──────────────────────────────────────────
      case 'tap': case 'clicktext': case 'taptext': {
        const gate = tier2Gate(rest);
        if (gate.reply) return gate.reply;
        const hit = await finder.locateOnScreen(config, gate.text, log);
        const image = await finder.annotateScreenshot(hit.screenshot, hit.x, hit.y, hit.width, hit.height);
        const where = `"${hit.matched}" at ${hit.x},${hit.y} (${hit.source === 'ocr' ? `OCR ${hit.confidence}%` : 'vision model'})`;
        if (RISKY_TAP.test(gate.text) || RISKY_TAP.test(hit.matched)) {
          pendingTap = { x: hit.x, y: hit.y, matched: hit.matched, expires: Date.now() + 60_000 };
          return { image, text: `⚠️ That click looks irreversible (${where}). Reply */pc confirm* within 60 seconds to click it, or ignore to cancel.` };
        }
        await pc.click(hit.x, hit.y);
        return { image, text: `🖱️ Clicked ${where} — crosshair shows the spot. Send /pc screenshot to see the result.` };
      }
      case 'type': {
        const gate = tier2Gate(rest);
        if (gate.reply) return gate.reply;
        // "/pc type paste <text>" and "/pc paste <text>" use the clipboard.
        if (/^(?:paste|clip)\s+/i.test(gate.text)) return pc.pasteText(gate.text.replace(/^(?:paste|clip)\s+/i, ''));
        return pc.typeText(gate.text);
      }
      case 'paste': {
        const gate = tier2Gate(rest);
        return gate.reply ?? pc.pasteText(gate.text);
      }
      case 'key': {
        const gate = tier2Gate(rest);
        return gate.reply ?? pc.keyCombo(gate.text.trim());
      }
      case 'click': {
        const gate = tier2Gate(rest);
        if (gate.reply) return gate.reply;
        const nums = gate.text.match(/-?\d+/g)?.map(Number) ?? [];
        const button = /right/i.test(gate.text) ? 'right' : /middle/i.test(gate.text) ? 'middle' : 'left';
        const clicks = /double/i.test(gate.text) ? 2 : 1;
        return pc.click(nums[0], nums[1], button, clicks);
      }
      case 'mousemove': case 'move': case 'mouse': {
        const gate = tier2Gate(rest);
        if (gate.reply) return gate.reply;
        const nums = gate.text.match(/-?\d+/g)?.map(Number) ?? [];
        if (nums.length < 2) return '🖱️ Usage: /pc mousemove 640 400';
        return pc.moveMouse(nums[0], nums[1]);
      }
      case 'scroll': {
        const gate = tier2Gate(rest);
        if (gate.reply) return gate.reply;
        const dir = /up|upar|oopar/i.test(gate.text) ? 'up' : 'down';
        const amount = gate.text.match(/(\d+)/)?.[1] ?? 3;
        return pc.scrollMouse(dir, amount);
      }
      case 'shutdown': case 'poweroff': case 'reboot': case 'restart': case 'suspend': case 'sleep': {
        const gate = tier2Gate(rest);
        if (gate.reply) return gate.reply;
        pendingPower = { action: sub, expires: Date.now() + 60_000 };
        const label = { shutdown: 'Shut down', poweroff: 'Shut down', reboot: 'Reboot', restart: 'Reboot', suspend: 'Suspend', sleep: 'Suspend' }[sub];
        return `⚠️ ${label} the PC? Unsaved work on it can be lost, and I'll go offline until it's back.\nReply */pc confirm* within 60 seconds to do it, or ignore this to cancel.`;
      }
      case 'confirm': {
        if (!config.allowPcControl) return TIER2_OFF;
        if (pendingTap && pendingTap.expires >= Date.now()) {
          const { x, y, matched } = pendingTap;
          pendingTap = null;
          await pc.click(x, y);
          return `🖱️ Clicked "${matched}" at ${x},${y} (confirmed). Send /pc screenshot to see the result.`;
        }
        pendingTap = null;
        if (!pendingPower || pendingPower.expires < Date.now()) { pendingPower = null; return 'Nothing is waiting for confirmation.'; }
        const { action } = pendingPower;
        pendingPower = null;
        pc.schedulePower(action);
        return `⏻ ${{ shutdown: 'Shutting down', poweroff: 'Shutting down', reboot: 'Rebooting', restart: 'Rebooting', suspend: 'Suspending', sleep: 'Suspending' }[action]} in 5 seconds. See you on the other side 👋`;
      }
      case 'cancel':
        pendingPower = null;
        pendingTap = null;
        return 'Cancelled — nothing was clicked, PC stays on.';
      default:
        return [
          '🖥️ *PC control* — usage:',
          '/pc screenshot · /pc status · /pc disk · /pc battery · /pc top · /pc ip',
          '/pc volume up|down|mute|50 · /pc brightness up|down|70',
          '/pc media play|pause|next|prev|stop|status',
          '/pc open <any app>   (/apps lists them) · /pc notify <text> · /pc lock',
          '/pc clipset <text> · /pc mousemove <x> <y> · /pc scroll up 5 · /pc find <name>',
          '/pc locate <label> — find a button/field on screen · /pc tap <label> — find + click it 🎯',
          '/pc type <text> · /pc key ctrl+l · /pc click [x y] · /pc suspend|reboot|shutdown' + (config.allowPcControl ? '' : '  (⌨️ tier-2 currently OFF — see ALLOW_PC_CONTROL)'),
        ].join('\n');
    }
  }

  function sub2volumeAction(word) {
    const w = String(word ?? '').toLowerCase();
    if (['up', '+', 'increase', 'raise'].includes(w)) return 'up';
    if (['down', '-', 'decrease', 'lower'].includes(w)) return 'down';
    if (['mute', 'unmute', 'toggle'].includes(w)) return 'mute';
    return 'get';
  }

  function files() {
    let names = [];
    try { names = fs.readdirSync(config.sharedDir).filter((f) => fs.statSync(path.join(config.sharedDir, f)).isFile()); } catch { /* no dir yet */ }
    if (!names.length) return `📂 Shared folder is empty.\nPut files in:\n${config.sharedDir}\nThen /get <filename> sends one to you here.`;
    return '📂 *Shared files*\n\n' + names.map((n) => `• ${n}`).join('\n') + '\n\nSend one with /get <filename>';
  }

  function getFile(name) {
    const base = path.basename(String(name ?? '')); // basename kills ../ traversal by construction
    const file = path.join(config.sharedDir, base);
    if (!base || !fs.existsSync(file)) return `📂 "${base || name}" isn't in the shared folder. /files lists what's there.`;
    const stat = fs.statSync(file);
    if (stat.size > 64 * 1024 * 1024) return '📂 That file is over WhatsApp\'s 64 MB document limit.';
    return { text: `📄 ${base} (${(stat.size / 1024).toFixed(0)} KB)`, document: { buffer: fs.readFileSync(file), fileName: base } };
  }

  async function runShell(args, ctx = {}) {
    if (!config.allowShell) {
      return '🔒 Shell is OFF (ALLOW_SHELL=false). That\'s the safe default — apps, files, Wi-Fi, OCR, input and power already work without it. To enable: ALLOW_SHELL=true + SHELL_PIN=<pin> in whatsapp-agent/.env.';
    }
    let command = String(args ?? '').trim();
    let pinOk = Boolean(ctx.shellPinOk);
    if (config.shellPin && !pinOk) {
      const m = command.match(/^(\S+)\s+([\s\S]+)$/);
      if (!m || m[1] !== config.shellPin) return '🔒 Usage: /run <PIN> <command>  (your PIN is SHELL_PIN in .env)';
      command = m[2];
      pinOk = true;
    }
    if (!command) return '💻 Usage: /run <command>';
    return toReply(await actions.execute('run_shell', { command }, { ...ctx, shellPinOk: pinOk, confirmed: true }));
  }

  async function askObserver(text) {
    if (!observerOnline()) {
      return '🖥️ Observer isn\'t open on the PC right now, so I can\'t use its screen/camera tools.\nOpen Observer there, then send /observer again. (I can still chat and run my own commands.)';
    }
    const reply = await forwardToObserver(text);
    if (!reply) return '🖥️ Observer didn\'t answer in time. It may still be working — its reply will arrive here when ready. Otherwise check the PC.';
    const out = { text: reply.text };
    if (reply.images?.length) {
      out.image = Buffer.from(reply.images[0], 'base64');
      out.extraImages = reply.images.slice(1).map((b64) => Buffer.from(b64, 'base64'));
    }
    return out;
  }

  // ── AI routing helpers (which brain, and prove it) ───────────────────────

  const shortModel = (label) => String(label ?? '').split(' · ').slice(-1)[0] || 'AI';

  /** "🧠 standard · llama3.2 · 3 steps · 1.4s" — proof of what ran. */
  function routeLine(meta, { force = false } = {}) {
    if (!meta?.model) return '';
    if (!force && !config.showRoutingFooter) return '';
    const bits = [`🧠 ${meta.tier ?? '?'}`, shortModel(meta.model)];
    if (meta.toolCalls) bits.push(`${meta.toolCalls} tools`);
    if (meta.steps) bits.push(`${meta.steps} steps`);
    if (meta.ms) bits.push(meta.ms < 1000 ? `${Math.round(meta.ms)}ms` : `${(meta.ms / 1000).toFixed(1)}s`);
    return `\n\n_${bits.join(' · ')}_`;
  }

  function withRoute(reply, meta, { force = false } = {}) {
    const line = routeLine(meta, { force });
    if (!line) return reply;
    if (typeof reply === 'string') return reply + line;
    if (reply && typeof reply === 'object') return { ...reply, text: `${reply.text ?? ''}${line}`.trim() };
    return reply;
  }

  function planPreview(text, plan) {
    return [
      `🗺️ *Plan preview* — "${String(text).slice(0, 90)}"`,
      `Work size: *${plan.tier}* — ${plan.complexity.reasons.join(', ') || 'simple ask'}`,
      `Steps allowed: ${plan.maxSteps} · tools offered: ${plan.toolLimit}`,
      `Needs: ${[plan.needsTools ? 'PC tools' : 'chat only', plan.needsVision ? 'vision' : null].filter(Boolean).join(' + ')}`,
      '',
      '*Brain order (first healthy wins):*',
      ...(plan.candidates.length
        ? plan.candidates.slice(0, 4).map((m, i) => `${i + 1}. ${m.label}`)
        : ['❌ none available — see /brains']),
      ...(plan.notes.length ? ['', `_Note: ${plan.notes.join(' · ')}_`] : []),
      '',
      '_Bhejo bina `--plan` ke — tab actually chalega._',
    ].join('\n');
  }

  function noBrainReply() {
    const catalog = String(config.aiProvider) === 'none' ? [] : router.catalog;
    if (!catalog.length) {
      return [
        '🤖 *Koi free AI brain configured nahi hai* — isliye /agent kuch nahi kar sakta, aur jhooth bhi nahi bolega.',
        '',
        '*Free me chalu karo (ek hi baar):*',
        '`sudo dnf install ollama && sudo systemctl enable --now ollama && ollama pull llama3.2`',
        'ya WhatsApp-agent/.env me free key: GROQ_API_KEY / GEMINI_API_KEY',
        '',
        'Tab tak ye sab bina AI chalte hain:',
        '/open chrome · /screenshot · /look · /ls · /send · /wifi · /pc type hello · /auto …',
      ].join('\n');
    }
    return [
      '⚠️ *Kaam nahi ho paaya — kuch bhi nahi kiya.*',
      '',
      'Sab configured brains fail / cooldown me hain. Dekho:',
      '• /brains — kaun live hai, kaun cooling me',
      '• /doctor — PC side problem',
      '• /brains why <task> — kaunsa model chuna jaata',
    ].join('\n');
  }

  // ── /agent: understand the task, DO it, verify, then report honestly ─────

  const AGENT_USAGE = [
    '🤖 *Usage:* `/agent <task>`',
    '',
    'Ye task ko samajh ke PC pe *actually karta hai* — apps, files, screen, typing, downloads — ',
    'har step verify karta hai, aur jo hua bas wahi batata hai (fake "done" nahi).',
    '',
    '*Examples:*',
    '• /agent download folder saaf karo aur screenshot bhejo',
    '• /agent ~/notes.txt padh ke summary bhejo',
    '• /agent chrome kholo aur github pe psd-observer search karo',
    '• /agent chatgpt pe rust vs go pooch        ← browser task',
    '• /agent --web youtube pe lofi play karo   ← force browser',
    '• /agent --use settings me bluetooth on karo ← force screen control (/use)',
    '• /agent --plan <task>                     ← pehle plan dekho',
    '• /agent --fast <task>                     ← chhota model, power bachao',
    '',
    '_Sirf chat chahiye to seedha message bhejo — /agent ki zaroorat nahi._',
  ].join('\n');

  function parseAgentFlags(raw) {
    let text = String(raw ?? '').trim();
    const flags = { web: false, plan: false, deep: false, fast: false, use: false };
    for (let i = 0; i < 6; i++) {
      const m = text.match(/^--(web|browser|online|plan|deep|heavy|fast|quick|use|hands|screen)\s+/i);
      if (!m) break;
      const key = m[1].toLowerCase();
      if (key === 'browser' || key === 'online') flags.web = true;
      else if (key === 'heavy' || key === 'deep') flags.deep = true;
      else if (key === 'quick') flags.fast = true;
      else if (key === 'hands' || key === 'screen') flags.use = true;
      else flags[key] = true;
      text = text.slice(m[0].length).trim();
    }
    return { text, flags };
  }

  function forceTierFrom(flags) {
    if (flags.deep) return 'heavy';
    if (flags.fast) return 'light';
    return undefined;
  }

  async function runWebTask(text, label = 'Agent', signal = null) {
    const steps = autopilot.buildWebSteps(text);
    if (!steps.length) return null;
    log.info?.(`[agent] browser task: ${steps.map((s) => s.op).join(' → ')}`);
    const result = await autopilot.executeSteps(steps, { config, log, label, signal });
    if (!result || typeof result === 'string') return result;
    const target = steps.find((s) => s.op === 'open')?.target;
    const siteLine = target ? describeSite(target) : null;
    return {
      ...result,
      text: `${result.text}\n\n_🌐 browser · xdg-open + OCR (no AI guesswork)_` +
        `${siteLine ? `\n_${siteLine}_` : ''}`,
    };
  }

  const USE_USAGE = [
    '🖐️ *Usage:* `/use <task>`',
    '',
    'Main screen dekhta hoon, phir *asli* mouse/keyboard se ek-ek step karta hoon — ',
    'aur har step ke baad dobara screen dekhta hoon (jaise insaan karta hai).',
    '',
    '*Examples:*',
    '• /use YouTube kholo aur lofi music chalao',
    '• /use Settings me Wi-Fi on karo',
    '• /use browser me github.com/pavit12301611/psd-observer kholo aur star karo',
    '• /use --steps 12 download page me se latest release download karo',
    '',
    '_Sirf ek command ka kaam ho to /open, /pc type, /pc key fast hain. /use tab jab UI me ghoomna pade._',
  ].join('\n');

  async function runUseTask(raw, signal = null) {
    let text = String(raw ?? '').trim();
    let maxSteps;
    const m = text.match(/^--steps\s+(\d{1,2})\s+/i);
    if (m) {
      maxSteps = Number(m[1]);
      text = text.slice(m[0].length).trim();
    }
    if (!text) return USE_USAGE;
    if ((actions.level?.() ?? 'full') === 'safe') {
      return '🔒 /use ke liye ACCESS_LEVEL=standard ya full chahiye — safe mode sirf padhta hai.';
    }
    const progress = createProgress({
      send: notifyOwner, label: 'Hands', total: maxSteps ?? config.handsMaxSteps ?? 8, log,
    });
    rememberTask({ kind: 'use', text });
    const result = await hands.runHands(text, {
      config, log, maxSteps, signal,
      onStep: (entry) => {
        if (entry?.ok === false) return;
        const { action, detail } = describeHandsStep(entry?.action ?? entry ?? {});
        progress.step({ n: entry?.step ?? null, action, detail }).catch(() => {});
      },
    });
    if (!result) return '⚠️ Hands: koi jawab nahi mila.';
    if (result.ok && !result.stopped) clearTask();
    // Keep `stopped` on the object so handle() can suppress the duplicate reply
    // (the /stop command already told the owner what happened).
    return { text: result.text, image: result.image ?? undefined, stopped: Boolean(result.stopped) };
  }

  async function runArenaPrompt(prompt, signal = null) {
    if (!prompt) return '🌐 Usage: /arena <prompt> — arena.ai/agent kholke prompt poochta hai';
    rememberTask({ kind: 'arena', text: prompt });
    const arenaResult = await autopilot.executeSteps([
      { op: 'open', target: 'https://arena.ai/agent' },
      { op: 'type', text: prompt, submit: true },
      { op: 'wait', ms: 8_000 },
      { op: 'look', question: prompt },
      { op: 'screenshot' },
    ], { config, log, label: 'Arena', signal });
    if (!arenaResult?.stopped) clearTask();
    return arenaResult;
  }

  async function runAgentTask(raw, ctx) {
    if (!raw || !String(raw).trim()) return AGENT_USAGE;
    const { text, flags } = parseAgentFlags(raw);
    if (!text) return AGENT_USAGE;

    // --use: skip every heuristic and hand it to the screen-control loop.
    if (flags.use) return runUseTask(text, ctx.signal);

    const plan = agentLoop.buildPlan(text, { needsTools: true, forceTier: forceTierFrom(flags) });
    if (flags.plan) return planPreview(text, plan);

    // A task that clearly belongs on a website → real browser automation
    // (verified open, no typing into the wrong window).
    const webTask = flags.web || looksLikeWebTask(text);
    if (webTask) {
      const result = await runWebTask(text, 'Agent', ctx.signal);
      if (result) return result;
      if (flags.web) {
        return '🌐 Koi site samajh nahi aayi. Example: `/agent --web chatgpt pe rust vs go pooch`\n' +
          'Taaki main jaanta hoon: chatgpt, gemini, claude, google, youtube, github, wikipedia…';
      }
    }

    if (!agentLoop.enabled) return noBrainReply();

    const reply = await agentLoop.run(text, ctx, { forceTier: forceTierFrom(flags), nudge: true, signal: ctx.signal });
    if (reply != null) return withRoute(reply, agentLoop.lastRun, { force: true });

    const meta = agentLoop.lastRun ?? {};
    if (!router.catalog.length) return noBrainReply();
    return [
      '⚠️ *Kaam nahi ho paaya — kuch bhi nahi kiya.*',
      `_Reason: ${meta.reason || 'brain ne koi usable jawab nahi diya'}_`,
      '',
      `Work size: ${meta.tier ?? plan.tier} · tried: ${plan.candidates.slice(0, 2).map((m) => shortModel(m.label)).join(' → ') || 'none'}`,
      '',
      'Ye try karo:',
      '• /brains — live health + power budget',
      '• /brains why ' + text.slice(0, 40) + ' — routing dekho',
      '• /doctor — PC side problem',
      '• Direct chhote commands: /screenshot · /open chrome · /ls · /pc type hello',
    ].join('\n');
  }

  // ── router ───────────────────────────────────────────────────────────────

  // ── adhoora kaam (for /resume) ───────────────────────────────────────────
  // Only long-running, resumable tasks are remembered. A stop keeps it so the
  // owner can pick up where it broke; a clean finish clears it.
  function rememberTask({ kind, text }) {
    store.data.lastTask = { kind, text: String(text).slice(0, 500), ts: Date.now(), done: false };
    store.save?.();
  }
  function clearTask() {
    if (store.data.lastTask) {
      store.data.lastTask.done = true;
      store.data.lastTask.doneTs = Date.now();
      store.save?.();
    }
  }

  // ── /stop ────────────────────────────────────────────────────────────────
  // Deliberately outside the command dispatcher: it has to work while another
  // command is mid-flight, so it never waits for the queue or the busy flag.
  function labelFor(clean) {
    const m = String(clean).match(/^\/([a-zA-Z]+)/);
    const name = m ? m[1].toLowerCase() : '';
    return ({
      use: 'Hands', hands: 'Hands', arena: 'Arena', agent: 'Agent', do: 'Agent',
      auto: 'Autopilot', autopilot: 'Autopilot', download: 'Download',
      run: 'Shell', record: 'Screen recording', summarize: 'Summary', url: 'Page read',
    })[name] ?? (name ? `/${name}` : 'AI');
  }

  function stopReply(stopped) {
    if (!stopped.length) {
      return '⏹ Abhi koi task nahi chal raha — rokne ko kuch nahi hai.\n_Naya kaam shuru karne ke liye bas message bhejo._';
    }
    const lines = stopped.map((t) => {
      const what = t.detail ? ` — ${t.detail}` : '';
      return `• *${t.label}*${what} · ${tools.humanDuration(t.elapsedMs)}`;
    });
    return [
      `⏹ *Roka gaya* — ${stopped.length} task${stopped.length === 1 ? '' : 's'}`,
      '',
      ...lines,
      '',
      '_Jo step tak hua wahi hua — aage kuch nahi chalega, aur naya browser/app band nahi hoga._',
    ].join('\n');
  }

  function stopCommand() {
    return stopReply(taskRegistry.stopAll('stop'));
  }

  /** A stack like "/arena hi\n/stop" must stop, not wait 30s and then stop. */
  function stopInStack(lines) {
    return lines.some((line) => isStopCommand(line));
  }

  // ── new in 2.8.0 ─────────────────────────────────────────────────────────

  function shotsCommand(args) {
    const raw = String(args ?? '').trim().toLowerCase();
    if (/^(clean|now|clear|delete|saaf|hatao)$/.test(raw)) {
      return cleanupReply(cleanNow(shots));
    }
    return describeJanitor({ config, file: shots.file });
  }

  async function undoCommand(args) {
    const raw = String(args ?? '').trim();
    if (/^(list|ls|journal|history)$/i.test(raw)) return journal.describe();
    const n = Math.min(5, Math.max(1, Number.parseInt(raw || '1', 10) || 1));
    const out = [];
    for (let i = 0; i < n; i++) {
      const result = await journal.undo();
      if (!result.ok) {
        if (!out.length) return undoReply(result);
        out.push(`⚠️ Aur peeche nahi ja sakta — ${result.error ?? result.reason}.`);
        break;
      }
      out.push(undoReply(result));
    }
    if (n > 1) out.push(`_${n} step wapas._`);
    return out.join('\n');
  }

  function watchCommand(args) {
    const parsed = watch.parseWatchArgs(args);
    if (parsed.action === 'list') {
      const all = watch.watchers(store);
      if (!all.length) {
        return [
          '👁️ Koi watch chalu nahi hai. Ek banao:',
          '',
          '• `/watch jab build complete ho jaye`',
          '• `/watch every 2m OTP box khali hai kya`',
          '• `/watch once — jab \'In stock\' dikhe`',
        ].join('\n');
      }
      return `👁️ *Watches* (${all.length})\n\n${all.map(watch.describeWatcher).join('\n')}\n\n_/watch stop <#> · /watch stop all_`;
    }
    if (parsed.action === 'stop') {
      if (parsed.all) {
        const n = watch.clearWatchers(store);
        return n ? `👁️ ${n} watch band kar diye.` : '👁️ Koi watch chalu hi nahi tha.';
      }
      const removed = watch.removeWatcher(store, parsed.id);
      return removed ? `👁️ Watch band — "${removed.condition}"` : `Koi watch #${parsed.id} nahi mila. /watch list dekho.`;
    }
    if (parsed.action === 'invalid') {
      return '👁️ Kya dekhna hai? Example: `/watch jab download complete ho jaye`\nOr: `/watch every 1m screen pe \'Submit\' button dikh raha hai?`';
    }
    const watcher = watch.addWatcher(store, parsed);
    const every = watcher.everyMs >= 60_000 ? `${Math.round(watcher.everyMs / 60_000)}m` : `${Math.round(watcher.everyMs / 1000)}s`;
    return [
      '👁️ *Watch on*',
      `_"${watcher.condition}"_`,
      '',
      `Har ${every} check karunga${watcher.once ? ' — ek baar milne ke baad band' : ' — sach hone pe screenshot bhejunga'}.`,
      'Stop: /watch stop 1 (ya /watch stop all)',
    ].join('\n');
  }

  function teachCommand(args) {
    const parsed = macro.parseTeachArgs(args);
    if (parsed.action === 'start') {
      if (macro.recording(store)) return `🔴 Pehle wali recording chal rahi hai — /teach stop ya /teach cancel karo.\n\n${macro.teachStatusText(store)}`;
      const started = macro.startRecording(store, parsed.name);
      if (!started.ok) return `⚠️ ${started.error}`;
      return [
        `🔴 *Recording shuru* — /${started.name}`,
        '',
        'Ab jo commands tum normally bhejte ho, wahi bhejo (`/open chrome`, `/pc type …`, `/screenshot`).',
        'Sab record hoga. Save: /teach stop · Cancel: /teach cancel',
      ].join('\n');
    }
    if (parsed.action === 'stop') {
      const rec = macro.recording(store);
      const saved = macro.stopRecording(store);
      if (!saved.ok) {
        return `${saved.error}${rec ? `\n\n${macro.teachStatusText(store)}` : ''}`;
      }
      return [
        `✅ *Sikha diya* — /${saved.name} (${saved.steps} steps)`,
        '',
        `Ab bas *${saved.name}* likho (ya /${saved.name}) — poora sequence ek baar me chalega.`,
        '_Steps dekhne ke liye: /learn list_',
      ].join('\n');
    }
    if (parsed.action === 'cancel') {
      return macro.cancelRecording(store) ? '🗑️ Recording cancel — kuch save nahi hua.' : 'Recording chal hi nahi rahi thi.';
    }
    if (parsed.action === 'delete') {
      const kw = learn.normalizeKeyword(parsed.name);
      return store.deleteLearned(kw) ? `🗑️ /${kw} delete ho gaya.` : `/${kw} koi taught macro nahi hai.`;
    }
    // list
    const status = macro.teachStatusText(store);
    if (status) return status;
    const all = store.listLearned();
    if (!all.length) {
      return '📚 Abhi kuch nahi sikhaya. `/teach start morning` bolo, phir apne commands bhejo, phir `/teach stop`.';
    }
    return `📚 *Taught* (${all.length})\n\n${all.map((e) => `• /${e.keyword} — ${e.commands.length} steps`).join('\n')}`;
  }

  async function briefCommand(args) {
    const raw = String(args ?? '').trim();
    if (!raw) return brief.buildBrief({ store, config });
    if (/^(off|band|stop)$/i.test(raw)) {
      return brief.unscheduleBrief(store) ? '🌅 Morning brief band kar diya.' : 'Morning brief already band tha.';
    }
    const time = raw.replace(/^(on|at|set)\s+/i, '').trim() || '9am';
    // The cron parser wants a message after the time ("roz 9 baje <text>"),
    // so the brief itself is that message.
    const clock = /^\d{1,2}$/.test(time) ? `${time} baje` : time;
    const parsed = cron.parseCronSchedule(`roz ${clock} /brief`);
    if (!parsed?.schedule) return '⏰ Time samajh nahi aaya. Example: `/brief on 9am` ya `/brief on 07:30`.';
    const nextDueTs = parsed.nextDueTs ?? cron.computeNextDue(parsed.schedule);
    store.addCronJob('/brief', parsed.scheduleRaw ?? `roz ${clock}`, parsed.schedule, nextDueTs);
    const at = new Date(nextDueTs).toLocaleString('en-IN', { timeZone: tz, hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
    return `🌅 *Morning brief on* — roz ${time}\nPehla: ${at}\n\n_Band karna ho to: /brief off_`;
  }

  async function resumeCommand() {
    const last = store.data.lastTask;
    if (!last?.text) return '📭 Koi adhoora kaam nahi hai. Kuch shuru karo — /use, /arena ya /agent.';
    if (last.done) {
      return `✅ Pichhla kaam poora ho gaya tha (${tools.humanDuration(Date.now() - last.doneTs)} pehle):\n_"${last.text.slice(0, 120)}"_`;
    }
    const when = tools.humanDuration(Date.now() - last.ts);
    const head = `▶️ *Resume* — ${when} pe ruka tha: _${last.text.slice(0, 120)}_\n`;
    if (last.kind === 'use') {
      const out = await runUseTask(last.text, activeSignal);
      return typeof out === 'string' ? head + '\n' + out : { ...out, text: head + '\n' + (out?.text ?? '') };
    }
    if (last.kind === 'arena') return runArenaPrompt(last.text, activeSignal);
    return runAgentTask(last.text, { signal: activeSignal });
  }

  async function tapCommand(args) {
    const raw = String(args ?? '').trim();
    if (!raw) {
      return [
        '👆 *Tap* — screen pe kahin bhi click',
        '',
        '• `/tap 500 320` — exact pixels',
        '• `/tap 50% 40%` — screen ka hissa',
        '• `/tap Login` — text dhoondh ke click',
        '',
        '_Har tap ke baad naya screenshot aata hai — confirm karne ke liye._',
      ].join('\n');
    }
    if ((actions.level?.() ?? 'full') === 'safe') return '🔒 Tap ke liye ACCESS_LEVEL=standard ya full chahiye.';
    try {
      const shot = await pc.captureScreenshot({ portalTimeoutMs: config.portalTimeoutMs });
      const size = finder.pngSize(shot);
      const nums = raw.match(/^(\d+(?:\.\d+)?)\s*%?\s*[, ]\s*(\d+(?:\.\d+)?)\s*%?$/);
      let x;
      let y;
      let how;
      if (nums && size) {
        const px = Number(nums[1]);
        const py = Number(nums[2]);
        const pct = raw.includes('%');
        x = Math.round(pct ? (px / 100) * size.width : px);
        y = Math.round(pct ? (py / 100) * size.height : py);
        if (x < 0 || y < 0 || x >= size.width || y >= size.height) {
          return `⚠️ ${x},${y} screen (${size.width}×${size.height}) ke bahar hai.`;
        }
        how = `tap ${x},${y}${pct ? ` (${px}%, ${py}%)` : ''}`;
      } else {
        const hit = await finder.locateOnScreen(config, raw, log);
        x = hit.x;
        y = hit.y;
        how = `tap "${hit.matched ?? raw}"`;
      }
      await pc.click(x, y);
      await new Promise((r) => setTimeout(r, 400));
      const after = await pc.captureScreenshot({ portalTimeoutMs: config.portalTimeoutMs }).catch(() => null);
      const text = `👆 *${how}* — ${new Date().toLocaleTimeString('en-IN', { timeZone: tz })}`;
      return after ? { image: after, text } : text;
    } catch (err) {
      return `⚠️ Tap nahi hua: ${err.message}`;
    }
  }

  async function handleSolve(args = '', ctx = {}) {
    const raw = String(args ?? '').trim();
    const sub = raw.split(/\s+/)[0]?.toLowerCase() || '';

    if (sub === 'status') {
      const s = await solver.solverStatus(config, log);
      return [
        '🧠 *Ultra-Accuracy Question Solver — Status*',
        `• Ready: ${s.ok ? '✅ Active' : '⚠️ Missing vision/OCR or reasoning model'}`,
        `• HD Image Enhancer (\`sharp\`): ${s.sharp ? '✅' : '—'}`,
        `• Local OCR (\`tesseract\`): ${s.tesseract ? '✅' : '— (optional)'}`,
        `• Scientific Python Venv: ${s.python ? `✅ (${s.python})` : '—'}`,
        `• Symbolic Math (\`SymPy\` + \`NumPy\` + \`Pillow\`): ${s.sympy ? '✅ SymPy' : 'auto'} · ${s.numpy ? '✅ NumPy' : 'auto'} · ${s.pillow ? '✅ Pillow' : 'auto'}`,
        `• Code Runtimes: Node ✅ · Python ${s.python ? '✅' : '—'} · SQLite ✅ · C/C++ ${s.gcc ? '✅' : '—'}`,
        `• Vision Brains: ${s.visionModels.length ? s.visionModels.join(', ') : '(none)'}`,
        `• Reasoning Brains: ${s.reasoningModels.length ? s.reasoningModels.join(', ') : '(none)'}`,
        '',
        '_Tip: Seedha WhatsApp pe question photo / screenshot / PDF bhej do (caption ke bina bhi!) — automatic solve ho jayega._',
      ].join('\n');
    }

    if (sub === 'setup' || sub === 'install') {
      notify?.('⚙️ *Question Solver setup:* Scientific Python venv (`sympy`, `numpy`, `pillow`) verify/install ho raha hai…');
      const py = await solver.ensureSolverPython({ config, autoInstall: true, log });
      const s = await solver.solverStatus(config, log);
      return [
        '✅ *Question Solver Scientific Engine Ready!*',
        `• Python: \`${py.pythonBin || 'not found'}\``,
        `• SymPy: ${py.mods?.sympy ? '✅ Installed' : '— (stdlib high-precision fallback active)'}`,
        `• NumPy: ${py.mods?.numpy ? '✅ Installed' : '—'}`,
        `• Pillow: ${py.mods?.PIL ? '✅ Installed' : '—'}`,
        `• Sharp HD Tiler: ${s.sharp ? '✅ Installed' : '—'}`,
      ].join('\n');
    }

    const onProgress = (msg) => {
      try { notify?.(msg); } catch { /* ignore */ }
    };

    // 1. `/solve screen [instructions]` -> capture live PC screen & solve visible questions!
    if (sub === 'screen' || sub === 'pc' || sub === 'desktop') {
      const note = raw.replace(/^(?:screen|pc|desktop)\s*/i, '').trim();
      const shot = await pc.captureScreenshot({ portalTimeoutMs: config.portalTimeoutMs });
      const res = await solver.solveQuestionImage(config, shot, {
        caption: note || 'Solve every question visible on this screen accurately.',
        autoDetect: false,
        harness,
        onProgress,
        log,
        signal: activeSignal,
      });
      if (!res.ok) return `⚠️ ${res.error || 'Screen question solve failed.'}`;
      return { image: shot, text: res.text };
    }

    // 2. Attached image or document sent directly with `/solve ...` caption
    const media = ctx?.mediaMeta;
    if (media?.buffer) {
      if (media.mediaKind === 'document') {
        const res = await solver.solveQuestionDocument(config, media.buffer, {
          fileName: media.savedAs || 'document',
          mimeType: media.mimeType || '',
          caption: raw,
          harness,
          onProgress,
          log,
          signal: activeSignal,
        });
        return res.ok ? res.text : `⚠️ ${res.error || 'Document question solve failed.'}`;
      }
      const res = await solver.solveQuestionImage(config, media.buffer, {
        caption: raw,
        autoDetect: false,
        savedPath: media.savedPath || '',
        harness,
        onProgress,
        log,
        signal: activeSignal,
      });
      return res.ok ? res.text : `⚠️ ${res.error || 'Image question solve failed.'}`;
    }

    // 3. No attachment, AND either empty `/solve` OR refers to previous photo (`Q3`, `pichli photo`, `hindi me`, etc.)
    const recentMedia = (store.data.downloads ?? []).find((d) => d.kind === 'image' || d.kind === 'document');
    const refersToLastMedia = !raw || /^(?:q\s*\.?\s*\d+|question\s*\d+|all|sab|saare|hindi|english|step|detail|short|option|options|pichli|pichhli|last|previous|ye|is|iss|dubara|recheck|verify)\b/i.test(raw);
    if (recentMedia && refersToLastMedia) {
      const fullPath = path.join(config.downloadsDir, recentMedia.file);
      if (fs.existsSync(fullPath)) {
        const buf = fs.readFileSync(fullPath);
        if (recentMedia.kind === 'document') {
          const res = await solver.solveQuestionDocument(config, buf, {
            fileName: recentMedia.file,
            caption: raw,
            harness,
            onProgress,
            log,
            signal: activeSignal,
          });
          return res.ok ? res.text : `⚠️ ${res.error}`;
        }
        const res = await solver.solveQuestionImage(config, buf, {
          caption: raw,
          autoDetect: false,
          savedPath: fullPath,
          harness,
          onProgress,
          log,
          signal: activeSignal,
        });
        return res.ok ? res.text : `⚠️ ${res.error}`;
      }
    }

    // 4. Direct text question (`/solve Integrate x^2 sin(x) from 0 to pi`)
    if (raw) {
      const res = await solver.solveQuestionText(config, raw, {
        harness,
        onProgress,
        log,
        signal: activeSignal,
      });
      return res.ok ? res.text : `⚠️ ${res.error || 'Could not solve question.'}`;
    }

    return [
      '🧠 *Question Solver — Kaise use karein:*',
      '1. Seedha *question ki photo / screenshot / PDF* WhatsApp pe bhej do (bina caption ke bhi chalega!)',
      '2. `/solve screen` — laptop screen pe jo online test / coding / PDF question khula hai uska answer',
      '3. `/solve <question>` — koi bhi math / physics / coding / SQL / MCQ type karke verified answer pao',
      '4. `/solve status` · `/solve setup` — SymPy + NumPy + Vision status',
    ].join('\n');
  }

  async function handleReach(args = '') {
    const raw = String(args ?? '').trim();
    const [subRaw, ...restParts] = raw.split(/\s+/);
    const sub = (subRaw || '').toLowerCase();
    const rest = raw.slice(subRaw ? subRaw.length : 0).trim();

    if (!raw || sub === 'doctor' || sub === 'status' || sub === 'check') {
      return (await reach.reachDoctor()).text;
    }
    if (sub === 'search' || sub === 's' || sub === 'web') {
      if (!rest) return '🔎 Usage: `/reach search <query>`';
      return (await reach.webSearch(rest)).text;
    }
    if (sub === 'research' || sub === 'deep') {
      if (!rest) return '🧭 Usage: `/reach research <topic>` — searches Web + GitHub + HN + Reddit + StackOverflow in parallel.';
      return (await reach.reachResearch(rest)).text;
    }
    if (sub === 'read' || sub === 'url') {
      if (!rest) return '🌐 Usage: `/reach read <https://url>`';
      return (await reach.reachUrl(rest)).text;
    }
    if (sub === 'yt' || sub === 'youtube') {
      if (!rest) return '🎬 Usage: `/yt <search query or YouTube URL>` · `/yt play <song/video>` · `/yt transcript <url>`';
      const ytSub = (restParts[0] || '').toLowerCase();
      const ytArg = restParts.slice(1).join(' ').trim();
      if ((ytSub === 'play' || ytSub === 'chalao') && ytArg) {
        try {
          return await act('youtube_info', { query: ytArg, mode: 'play' });
        } catch {
          return act('open_app', { app: `https://www.youtube.com/results?search_query=${encodeURIComponent(ytArg)}` });
        }
      }
      if ((ytSub === 'transcript' || ytSub === 'sub' || ytSub === 'subtitles') && ytArg) {
        return act('youtube_info', { query: ytArg, mode: 'transcript' });
      }
      const isUrl = /^https?:\/\//i.test(rest) || Boolean(reach.extractYoutubeId(rest));
      return act('youtube_info', { query: rest, mode: isUrl ? 'transcript' : 'search' });
    }
    if (sub === 'gh' || sub === 'github') {
      if (!rest) return '🐙 Usage: `/gh <search query or owner/repo or GitHub URL>`';
      return (await reach.githubLookup(rest)).text;
    }
    if (sub === 'reddit' || sub === 'rdt') {
      if (!rest) return '👽 Usage: `/reddit <search query or Reddit URL>`';
      return (await reach.redditLookup(rest)).text;
    }
    if (sub === 'x' || sub === 'twitter' || sub === 'tweet') {
      if (!rest) return '🐦 Usage: `/reach x <Tweet URL or search query>`';
      return (await reach.twitterLookup(rest)).text;
    }
    if (sub === 'hn' || sub === 'hackernews') {
      return (await reach.hackerNewsLookup(rest)).text;
    }
    if (sub === 'v2ex') {
      return (await reach.v2exLookup(rest)).text;
    }
    if (sub === 'so' || sub === 'stackoverflow') {
      if (!rest) return '📚 Usage: `/reach so <programming question>`';
      return (await reach.stackOverflowLookup(rest)).text;
    }
    if (sub === 'rss' || sub === 'feed') {
      if (!rest) return '📰 Usage: `/reach rss <feed URL>`';
      return (await reach.rssLookup(rest)).text;
    }

    // Auto-detect URL vs general search query
    if (/^https?:\/\//i.test(raw) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*/i.test(raw)) {
      return (await reach.reachUrl(raw)).text;
    }
    return (await reach.webSearch(raw)).text;
  }

  function remoteCommand() {
    const port = config.port ?? 8787;
    const nets = Object.values(os.networkInterfaces()).flat()
      .filter((n) => n && !n.internal && n.family === 'IPv4').map((n) => n.address);
    const lan = nets[0];
    let pin = null;
    try { pin = fs.readFileSync(path.join(config.dataDir, 'dashboard-pin.txt'), 'utf8').trim(); } catch { /* not created yet */ }
    return [
      '📱 *Kahin se bhi control*',
      '',
      '*1. WhatsApp se (duniya me kahin se — bas internet)*',
      '• `/screenshot` — screen dekho',
      '• `/tap 500 320` ya `/tap Login` — wahin click',
      '• `/pc type …` · `/pc key ctrl+l` · `/use <kaam>`',
      '• `/watch jab … ho jaye` — nazar rakho',
      '',
      '*2. Ghar ke Wi-Fi pe phone app*',
      lan ? `• http://${lan}:${port}/   PIN: ${pin ?? '(console me print hota hai)'}` : '• LAN IP nahi mila — /pc ip dekho',
      '• Live screen + tap ke liye: wahi link, "Screen" tab',
      '',
      '*3. Ghar se bahar (free, private)*',
      '• `./scripts/observer.sh remote` — Tailscale set karta hai (koi port forward nahi)',
      '• Uske baad phone se wahi URL, kahin se bhi',
    ].join('\n');
  }

  async function handleCommand(cmd, args, ctx) {
    switch (cmd) {
      case 'stop': case 'cancel': case 'abort': case 'ruko': return stopCommand();
      case 'undo': case 'journal': return await undoCommand(args);
      case 'shots': case 'screenshots': return shotsCommand(args);
      case 'usage': case 'quota': return usageReport(store, { catalog: router.catalog });
      case 'watch': return watchCommand(args);
      case 'teach': return teachCommand(args);
      case 'brief': return await briefCommand(args);
      case 'resume': return await resumeCommand();
      case 'tap': return await tapCommand(args);
      case 'remote': case 'control': return remoteCommand();
      case 'help': case 'commands': case 'menu': case 'start': return HELP;
      case 'ping': return `🏓 Pong! Agent is alive (uptime ${tools.humanDuration(Date.now() - store.data.stats.startedAt)}).`;
      case 'me': case 'id': case 'whoami':
        return `👤 You (owner): +${config.ownerNumber}\n🤖 Me (agent): +${config.agentNumber}\nI ignore every other number completely.`;
      case 'status': {
        const s = store.data.stats;
        return [
          `🤖 *Agent status*`,
          `Owner: +${config.ownerNumber} · Agent: +${config.agentNumber}`,
          `WhatsApp: ${ctx.waStatus?.() ?? '?'}`,
          `Uptime: ${tools.humanDuration(Date.now() - s.startedAt)}`,
          `Messages: ${s.received} in · ${s.replied} out · ${s.ignoredNonOwner} non-owner ignored`,
          `Data: ${store.data.todos.filter((t) => !t.done).length} open to-dos · ${store.data.notes.length} notes · ${store.data.reminders.length} reminders · ${(store.data.cronJobs ?? []).length} cron jobs · ${(store.data.learned ?? []).length} learned`,
          `Observer bridge: ${observerOnline() ? 'tab connected 🖥️' : 'not needed (agent is standalone)'}`,
          `Access: *${actions.level()}* · ${actions.accessReport().actions} tools · shell ${config.allowShell ? 'ON (PIN)' : 'off'}`,
          `Running now: ${taskRegistry.active().length ? `${taskRegistry.active().map((t) => t.label).join(', ')} (rokne ke liye /stop)` : 'kuch nahi'}`,
          `PC control: tier-1 on (screenshot/volume/…) · input+power ${config.allowPcControl ? `ON ⌨️${config.controlPin ? ' (PIN)' : ''}` : 'off (ALLOW_PC_CONTROL)'}`,
          `Cost so far: ₹0 (native WhatsApp, local tools)`,
        ].join('\n');
      }
      case 'time': return `🕐 ${new Date().toLocaleTimeString('en-IN', { timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })} (${tz})`;
      case 'date': return `📅 ${new Date().toLocaleDateString('en-IN', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`;
      case 'remind': case 'reminder': return remind(args);
      case 'reminders': return listReminders();
      case 'timer': return remind(args);
      case 'cron': case 'schedule': case 'repeat': case 'jobs': return cronCmd(args);
      case 'voicereply': return await voiceReply(args);
      case 'call': case 'voicecall': return await callCommand(args);
      case 'callme': case 'callkaro': return await callMeCommand(args);
      case 'callat': case 'schedulecall': case 'calllater': return callAtCommand(args);
      case 'voice': case 'jarvis': return ['📞 *JARVIS Voice*', ...callStatusLines(), '', tts.ttsStatus(config)].join('\n');
      case 'learn': case 'teach': case 'alias': return learnCmd(args);
      case 'unlearn': case 'undefine': case 'forgetword': return learnCmd(`del ${args}`);
      case 'todo': case 'todos': case 'task': return todo(args);
      case 'note': return note(args);
      case 'notes': return notes();
      case 'remember': return remember(args, ctx);
      case 'memory': return memory(args, ctx);
      case 'forget': {
        const fArg = String(args || '').trim();
        if (/^(?:memory|all|facts|sab)$/i.test(fArg)) {
          store.data.facts = {};
          store.data.factValues = {};
          store.data.rules = [];
          store.save();
          return '🧠 Memorised facts wiped.';
        }
        if (fArg && !/^(?:chat|history)$/i.test(fArg)) {
          const res = mem.forgetFact(store, fArg);
          if (res.ok) return `🧹 Memory se *${res.label}* hata diya.`;
          return `🧠 *${fArg}* naam se kuch memory me save nahi tha.`;
        }
        store.clearHistory();
        return '🧹 Chat memory cleared. Fresh start!';
      }
      case 'model': case 'ai': if (!args) return ai.aiStatus(config); return askAI(args, ctx);
      case 'ask': return args ? askAI(args, ctx) : '💬 Usage: /ask <question> — or just type your question normally.';
      case 'summarize': case 'summarise': case 'tldr': {
        if (!args) return '📄 Usage: /summarize <text or URL>';
        const body = /^https?:\/\//i.test(args.trim()) ? (await tools.fetchPageText(args.trim())).text : args;
        const done = await ai.complete(config, `Summarise this in a short WhatsApp-friendly way with bullet points:\n\n${body.slice(0, 8000)}`, log);
        return done ? `📄 *Summary*\n\n${done.text}` : `${body.slice(0, 1500)}\n\n_(No AI brain reachable for a summary — showing the start instead. See /model)_`;
      }
      case 'improve': case 'rewrite': {
        if (!args) return '✍️ Usage: /improve <your text>';
        const done = await ai.complete(config, `Improve this text (clearer, polite, same language, keep it short). Reply with only the improved text:\n\n${args}`, log);
        return done ? done.text : '✍️ No AI brain reachable right now (see /model). Your text was:\n' + args;
      }
      case 'weather': return args ? tools.weather(args) : '🌤️ Usage: /weather <city> — e.g. /weather Nainital';
      case 'wiki': return args ? tools.wiki(args) : '📚 Usage: /wiki <topic>';
      case 'define': return args ? tools.define(args) : '🔤 Usage: /define <word>';
      case 'news': return tools.news(args || '');
      case 'calc': {
        if (!args) return '🧮 Usage: /calc 45*12 + sqrt(81)';
        const percentOf = args.match(/^([\d.]+)\s*%\s*of\s*([\d.]+)$/i);
        if (percentOf) return `🧮 ${percentOf[1]}% of ${percentOf[2]} = *${(Number(percentOf[1]) / 100) * Number(percentOf[2])}*`;
        return `🧮 ${args} = *${tools.calc(args)}*`;
      }
      case 'unit': case 'convert': {
        const m = (args || '').match(/^(-?[\d.]+)\s*([a-zA-Z°]+)\s+(?:to|in|->)\s*([a-zA-Z°]+)$/);
        return m ? `🔁 ${tools.convertUnit(Number(m[1]), m[2], m[3])}` : '🔁 Usage: /unit 10 km to mi';
      }
      case 'currency': case 'fx': {
        const m = (args || '').match(/^([\d.]+)\s*([A-Za-z]{3})\s+(?:to|in)\s+([A-Za-z]{3})$/);
        return m ? tools.currency(Number(m[1]), m[2], m[3]) : '💱 Usage: /currency 100 USD to INR';
      }
      case 'url': {
        if (!args) return '🌐 Usage: /url <link>';
        const page = await tools.fetchPageText(args.trim());
        const done = await ai.complete(config, `Summarise this web page ("${page.title}") briefly for WhatsApp with bullet points:\n\n${page.text.slice(0, 8000)}`, log);
        return done ? `🌐 *${page.title}*\n\n${done.text}` : `🌐 *${page.title}*\n\n${page.text.slice(0, 1500)}\n\n_(No AI brain for a summary — see /model)_`;
      }
      case 'qr': {
        if (!args) return '🔳 Usage: /qr <text or link>';
        return { image: await QRCode.toBuffer(args, { width: 640, margin: 2 }), text: `🔳 QR for: ${args.slice(0, 200)}` };
      }
      case 'password': case 'pw': return `🔐 \`${tools.generatePassword(num(args) || 16)}\`\n_(generated on your PC, never stored)_`;
      case 'uuid': return `🆔 \`${crypto.randomUUID()}\``;
      case 'shorten': return args ? tools.shorten(args.trim()) : '🔗 Usage: /shorten <url>';
      case 'coin': return Math.random() < 0.5 ? '🪙 Heads' : '🪙 Tails';
      case 'dice': return `🎲 ${1 + Math.floor(Math.random() * 6)}`;
      case 'choose': {
        const options = (args || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
        return options.length > 1 ? `🎯 I pick: *${options[Math.floor(Math.random() * options.length)]}*` : '🎯 Usage: /choose pizza, burger, dosa';
      }
      case 'joke': return `😄 ${tools.joke()}`;
      case 'fact': return tools.fact();
      case 'quote': return tools.quote();
      case 'poll': {
        const parts = (args || '').split('|').map((s) => s.trim()).filter(Boolean);
        return parts.length >= 3
          ? { poll: { name: parts[0], values: parts.slice(1, 13) }, text: undefined }
          : '📊 Usage: /poll Lunch today? | Dosa | Pizza | Thali';
      }
      case 'files': return files();
      case 'get': case 'sendfile': return getFile(args);
      case 'downloads': {
        if (!store.data.downloads.length) return '⬇️ Nothing received yet. Send me a photo/file and I\'ll save it on the PC.';
        return '⬇️ *Recently received*\n\n' + store.data.downloads.slice(0, 10).map((d) => `• ${d.file} (${d.kind}, ${tools.formatDateTime(d.ts, tz)})`).join('\n');
      }
      case 'pc': return handlePc(args);
      case 'system': case 'sysinfo': return handlePc('status');
      case 'observer': case 'obs': return args ? askObserver(args) : '🖥️ Usage: /observer <what to do/look at on the PC>';
      case 'screen': case 'look': case 'lookscreen': {
        // Standalone first: screenshot → OCR → free AI answer. This is what
        // makes /screen work with no Observer app at all. If an Observer tab
        // happens to be connected, it can look too (better at images/games).
        if (observerOnline()) {
          return askObserver(args ? `Look at my screen and answer: ${args}` : 'Look at my screen and tell me briefly what is on it right now. Include a screenshot if you can.');
        }
        return act('look_at_screen', { question: args || '' });
      }
      case 'ocr': return act('ocr_screen');
      case 'screenshot': case 'shot': return act('screenshot');
      case 'webcam': case 'cam': return act('webcam_photo');
      case 'record': case 'screencast': return act('record_screen', { seconds: num(args) || 10 });
      case 'run': case 'exec': case 'shell': return runShell(args, ctx);
      case 'sticker': return '🎨 Send /sticker *with a photo* (as its caption) and I\'ll turn it into a sticker.';

      // ── apps & windows ──────────────────────────────────────────────────
      case 'apps': case 'applications': return act('list_apps');
      case 'windows': case 'tasks': return act('list_windows');
      case 'focus': case 'switch': return act('focus_window', { title: args });
      case 'open': return args ? act('open_app', { app: mem.resolvePreferredApp(store, args, { bypassSaved: Boolean(ctx?.bypassSaved) }) }) : '🚀 Usage: /open <app> — /apps lists installed apps.';
      case 'close': case 'quit': return args ? act('close_app', { app: args }) : '🚪 Usage: /close <app>';

      // ── network & system ────────────────────────────────────────────────
      case 'wifi': {
        const [sub, ...rest] = (args || 'status').split(/\s+/);
        if (sub === 'connect' || sub === 'join') return act('wifi', { action: 'connect', ssid: rest[0], password: rest[1] });
        return act('wifi', { action: sub || 'status' });
      }
      case 'bt': case 'bluetooth': return act('bluetooth', { action: (args || 'status').trim() || 'status' });
      case 'kill': return args ? act('kill_process', { name: args }) : '🛑 Usage: /kill <process name>';
      case 'svc': case 'service': {
        const [sub, name] = (args || '').split(/\s+/);
        if (!name) return '⚙️ Usage: /svc status <name> · /svc restart <name>';
        return sub === 'restart' ? act('service_restart', { name }) : act('service_status', { name });
      }
      case 'notify': return args ? act('notify', { text: args }) : '🔔 Usage: /notify <text>';
      case 'dsh': case 'harness': case 'deepseek': return handleDsh(args, ctx);
      case 'solve': case 'ans': case 'answer': case 'q': return handleSolve(args, ctx);
      case 'reach': case 'agentreach': return handleReach(args);
      case 'yt': case 'youtube': return handleReach(`yt ${args || ''}`.trim());
      case 'gh': case 'github': return handleReach(`gh ${args || ''}`.trim());
      case 'reddit': case 'rdt': return handleReach(`reddit ${args || ''}`.trim());
      case 'hn': case 'hackernews': return handleReach(`hn ${args || ''}`.trim());
      case 'ui': case 'ground': case 'elements': return act('inspect_ui');
      case 'doctor': case 'diag': case 'diagnose': return runDoctor({ config, ctx, log });
      case 'access': {
        const r = actions.accessReport();
        return [
          `🔐 *Access*: ${r.level} · ${r.actions} tools (safe ${r.byLevel.safe}, standard ${r.byLevel.standard}, full ${r.byLevel.full})`,
          `PC input: ${r.pcControl ? 'on' : 'off'} · Shell: ${r.shell ? `on${r.shellPin ? ' (PIN)' : ''}` : 'off'}`,
          `Files: your home folder${config.filesExtraRoots?.length ? ` + ${config.filesExtraRoots.join(', ')}` : ''}`,
          '',
          'Destructive actions (delete, kill, shutdown, close app, shell) always ask for /yes first.',
          'Change the level in whatsapp-agent/.env: ACCESS_LEVEL=safe|standard|full',
        ].join('\n');
      }

      // ── files ───────────────────────────────────────────────────────────
      case 'ls': case 'dir': return act('list_dir', { path: args || '~' });
      case 'read': case 'cat': return args ? act('read_file', { path: args }) : '📄 Usage: /read <path>';
      case 'write': case 'savefile': {
        const append = /^--append\s+/i.test(args || '');
        const body = append ? args.replace(/^--append\s+/i, '') : args;
        const m = String(body ?? '').match(/^([\s\S]+?)\s*(?:\||::)\s*([\s\S]+)$/);
        if (!m) return '💾 Usage: /write <path> | <text>   (add --append to append)';
        return act('write_file', { path: m[1].trim(), text: m[2], append });
      }
      case 'send': case 'getfile': return args ? act('send_file', { path: args }) : '📄 Usage: /send <path>';
      case 'download': case 'dl': {
        const [url, ...rest] = String(args || '').split(/\s+/);
        if (!/^https?:\/\//i.test(url || '')) return '⬇️ Usage: /download <https://link> [save-path]';
        return act('download_url', { url, path: rest.join(' ') || undefined });
      }
      case 'mv': case 'move': case 'rename': {
        const m = String(args ?? '').match(/^([\s\S]+?)\s*(?:\||->|=>| to )\s*([\s\S]+)$/i);
        if (!m) return '📦 Usage: /mv <from> | <to>';
        return act('move_path', { from: m[1].trim(), to: m[2].trim() });
      }
      case 'cp': case 'copy': {
        const m = String(args ?? '').match(/^([\s\S]+?)\s*(?:\||->|=>| to )\s*([\s\S]+)$/i);
        if (!m) return '📋 Usage: /cp <from> | <to>';
        return act('copy_path', { from: m[1].trim(), to: m[2].trim() });
      }
      case 'mkdir': return args ? act('make_dir', { path: args }) : '📁 Usage: /mkdir <folder>';
      case 'zip': {
        if (!args) return '🗜️ Usage: /zip <path> [path2 …]';
        const paths = args.split(/\s*\|\s*/).map((x) => x.trim()).filter(Boolean);
        const output = paths.length === 1 ? `${paths[0].replace(/\/$/, '')}.zip` : undefined;
        return act('zip_paths', { paths, output });
      }
      case 'unzip': return args ? act('unzip_path', { path: args }) : '📂 Usage: /unzip <file.zip>';
      case 'rm': case 'delete': return args ? act('delete_path', { path: args }) : '🗑️ Usage: /rm <path>  (asks for confirmation)';

      // ── agent + confirmations ───────────────────────────────────────────
      case 'auto': case 'autopilot': return args ? autopilot.runAutopilot(args, { config, log, signal: ctx.signal }) : '🤖 Usage: /auto open chrome | tap Search | type hello | key enter | screenshot\nNatural: /auto open chrome and search for today weather then screenshot\nHar step verify hota hai — jo fail hua wahi batata hai.';
      case 'agent': return runAgentTask(args, ctx);
      case 'use': case 'hands': return runUseTask(args, ctx.signal);
      case 'arena': return runArenaPrompt(args, ctx.signal);
      case 'brains': case 'models': case 'router': {
        if (args && /^(why|explain|route)\b/i.test(args)) {
          return router.explainText(args.replace(/^(why|explain|route)\s+/i, '').trim() || 'hello');
        }
        return router.statusText();
      }
      case 'do': {
        if (!args) return '🤖 Usage: /do <task in plain language> — same as /agent but quieter about routing.';
        const reply = await agentLoop.run(args, ctx, { nudge: true });
        if (reply != null) return withRoute(reply, agentLoop.lastRun);
        return agentLoop.enabled ? noBrainReply() : '🤖 No free AI brain reachable. Direct commands still work: /open, /pc, /ls, /wifi… (/brains to fix)';
      }
      case 'yes': case 'haan': return toReply(await actions.runPending(ctx));
      case 'no': case 'nahi': case 'cancel': actions.clearPending(); pendingPower = null; pendingTap = null; return '👍 Cancelled — kuch nahi kiya.';
      case 'link': return '📱 On the PC, open the dashboard URL printed at startup (or http://<PC-IP>:8787/) — it shows the WhatsApp QR while linking.';
      default: {
        const learnedRes = await runLearned(cmd, ctx);
        if (learnedRes != null) return learnedRes;
        return `🤖 I don't know /${cmd} yet.\n\n${HELP.split('\n').slice(0, 6).join('\n')}\n…full list: /help`;
      }
    }
  }

  async function askAI(text, ctx = {}) {
    const result = await ai.chat(config, store, text, log, { voice: Boolean(ctx?.voice) });
    if (result) return result.text;
    // No brain: still try to be useful offline for factual questions.
    const q = text.replace(/^(what is|who is|tell me about)\s+/i, '').replace(/\?$/, '').trim();
    try {
      if (q.length >= 3 && q.length <= 80 && /^(what|who|where|when)/i.test(text)) {
        return `${await tools.wiki(q)}\n\n_(from Wikipedia — local AI is off, see /model)_`;
      }
    } catch { /* fall through to hint */ }
    return ai.NO_BRAIN_HINT;
  }

  /** Execute a user-defined trigger→action rule from `store.data.rules`. */
  async function runCustomRule(rule, ctx = {}) {
    if (!rule) return null;
    if (rule.kind === 'reply') return rule.action;
    const actionText = String(rule.action ?? '').trim();
    if (!actionText) return null;
    const ruleCtx = { ...ctx, bypassSaved: true };

    // Multi-step pipe/semicolon chain ("open chrome | open code")
    if (/[|;\n]/.test(actionText)) {
      const steps = learn.parseLearnCommands(actionText);
      if (steps?.length) {
        const outs = [];
        for (const step of steps) {
          const cmd = step.inferredOpen ? 'open' : step.cmd;
          const r = await handleCommand(cmd, step.args ?? '', ruleCtx);
          outs.push(typeof r === 'string' ? r : (r?.text ?? '✅ Done.'));
        }
        return outs.join('\n\n---\n\n');
      }
    }

    // Slash command ("/brief", "/open brave")
    const slash = actionText.match(/^\/([a-zA-Z]+)\s*([\s\S]*)$/);
    if (slash) return handleCommand(slash[1].toLowerCase(), slash[2].trim(), ruleCtx);

    // Natural-language intent ("brave kholo", "screenshot bhejo", "volume 40")
    const parsed = parseIntent(actionText);
    if (parsed) {
      if (parsed.reply) return parsed.reply;
      return handleCommand(parsed.cmd, parsed.args ?? '', ruleCtx);
    }

    // Single-word or space-separated app shorthand ("brave", "chrome slack")
    const steps = learn.parseLearnCommands(actionText);
    if (steps?.length) {
      const outs = [];
      for (const step of steps) {
        const cmd = step.inferredOpen ? 'open' : step.cmd;
        const r = await handleCommand(cmd, step.args ?? '', ruleCtx);
        outs.push(typeof r === 'string' ? r : (r?.text ?? '✅ Done.'));
      }
      return outs.join('\n\n---\n\n');
    }

    return intent(actionText, ruleCtx);
  }

  /** Natural-language shortcuts. Returns a reply, or undefined to continue to AI/Observer. */
  function intent(text, ctx = {}) {
    let m;
    // Let compound command chains ("todo: X aur note: Y") fall through to the chain runner
    if (/\s+(?:aur|phir|fir|uske\s+baad|and\s+then|then)\s+(?:note|todo|remind|remember|mera|meri|mujhe|open|close|screenshot|volume|awaaz|wifi|bluetooth|\/)/i.test(text)) {
      return undefined;
    }
    if (/^remind me\b/i.test(text)) {
      // "remind me in 5 minutes to drink water" → remind("in 5 minutes to drink water")
      // parseWhen already swallows the "to" after the duration / clock time.
      return remind(text.replace(/^remind me\s+/i, ''));
    }
    if ((m = text.match(/^(?:note(?:\s+kar\s+lo)?\s*[:\-]?\s+|note that\s+)([\s\S]+)$/i))) return note(m[1]);
    if ((m = text.match(/^(?:add\s+(?:a\s+)?todo[:\s]+|todo[:\s]+)(?:add\s+)?([\s\S]+)$/i))) return todo(`add ${m[1]}`);
    if ((m = text.match(/^remember\s+(?:that\s+)?([\s\S]+)$/i))) return remember(m[1], ctx);
    const memReply = mem.handleMemoryIntent(store, config, text, { voice: Boolean(ctx?.voice) });
    if (memReply !== undefined) return memReply;
    if ((m = text.match(/^(?:what(?:'s| is) the )?weather\s+(?:in|at)\s+([\s\S]+?)\??$/i))) return tools.weather(m[1]);
    if ((m = text.match(/^([\s\S]+?)\s+ka\s+mausam\??$/i))) return tools.weather(m[1]);
    if ((m = text.match(/^(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)\??$/i))) {
      return `🧮 ${m[1]}% of ${m[2]} = *${(Number(m[1]) / 100) * Number(m[2])}*`;
    }
    if ((m = text.match(/^(\d+(?:\.\d+)?)\s+ka\s+(\d+(?:\.\d+)?)\s*(?:%|percent|pratishat)(?:\s+kitna\s*(?:hota\s*hai|hai)?)?\??$/i))) {
      return `🧮 ${m[2]}% of ${m[1]} = *${(Number(m[2]) / 100) * Number(m[1])}*`;
    }
    // Hinglish spoken math ("45 guna 12", "100 plus 250", "500 minus 120", "100 bhaag 4")
    if (/^\d+(?:\.\d+)?\s+(?:guna|into|times|multiply(?:\s+by)?|plus|jod|minus|ghata|bhaag|divide(?:\s+by)?)\s+\d+/i.test(text)) {
      const expr = text
        .replace(/\b(?:kitna\s*(?:hota\s*hai|hai)?|kya\s*hai|equals?)\??$/i, '')
        .replace(/\b(?:guna|into|times|multiply(?:\s+by)?)\b/gi, '*')
        .replace(/\b(?:plus|jod)\b/gi, '+')
        .replace(/\b(?:minus|ghata)\b/gi, '-')
        .replace(/\b(?:bhaag|divide(?:\s+by)?)\b/gi, '/')
        .trim();
      try { return `🧮 ${expr} = *${tools.calc(expr)}*`; } catch { /* fall through */ }
    }
    if ((m = text.match(/^(-?\d+(?:\.\d+)?)\s*([a-zA-Z°]+)\s+(?:in|to|into|me|mein)\s+([a-zA-Z°]+)(?:\s+kitna\s*(?:hota\s*hai|hai)?)?\??$/i))) {
      try { return `📏 ${tools.convertUnit(Number(m[1]), m[2], m[3])}`; } catch { /* not a known unit pair */ }
    }
    if (tools.looksLikeCalc(text)) {
      try { return `🧮 ${text.trim()} = *${tools.calc(text)}*`; } catch { /* not maths after all */ }
    }
    if (/^(hi|hello|hey|namaste|hii+|yo|psd|psd_ai|psdai|hey\s+psd)[!. ]*$/i.test(text)) {
      const ownerName = mem.getOwnerName(store);
      const agentName = mem.getAgentName(store, config);
      return `👋 Namaste${ownerName ? ` *${ownerName}*` : ''}! Main *${agentName}* hoon — aapka fast & powerful Observer agent on +${config.agentNumber} — free, native WhatsApp, listening only to you.\n\nAsk me anything, or try /help, /weather <city>, /remind in 10m <text>.`;
    }
    return undefined;
  }

  const AFFIRM = /^(?:yes|y|ya|haan|han|ha|karo|kar\s*do|kardo|confirm|theek\s*hai|thik\s*hai|हाँ|हां|हा|करो|ठीक\s*है)[.!\s]*$/i;
  const DENY = /^(?:no|n|nahi|nah|nope|cancel|mat\s*karo|रद्द|ना|नहीं)[.!\s]*$/i;

  // dedup + anti-double-work: same exact message within 4s is ignored
  let lastHandledText = '';
  let lastHandledTs = 0;
  let isProcessing = false;

  /** Main entry: owner text → reply. `ctx` may carry { waStatus(), quotedMedia }. */
  async function handle(text, ctx = {}) {
    const clean = String(text ?? '').trim();
    if (!clean) return '🤖 I got an empty message. Try /help';
    // /stop is checked before everything else — before the dedup window and
    // before the busy flag — because it must cut in while work is running.
    if (isStopCommand(clean)) return stopCommand();
    // dedup: same exact text within 4s → ignore second copy (double tap / network retry)
    if (clean === lastHandledText && Date.now() - lastHandledTs < 4000) {
      return '⏳ Same command abhi process hua tha (4s ke andar) — duplicate ignore kiya, double kaam nahi karunga.';
    }
    if (isProcessing) {
      // queue-like behaviour: tell owner we're busy, don't run in parallel (no double work)
      return '⏳ Ek kaam abhi chal raha hai — rokna ho to *\/stop* bhejo, ya khatam hone ka wait karo. (Parallel double-work blocked)';
    }
    const label = labelFor(clean);
    const task = taskRegistry.begin(label, { detail: clean.replace(/^\//, '').slice(0, 60) });
    activeSignal = task.signal;
    try {
      isProcessing = true;
      // A message starting with the shell PIN unlocks shell for this message
      // only ("1234 df -h"), so the PIN never has to live in the AI prompt.
      let working = clean;
      let effCtx = ctx;
      if (config.shellPin && working.startsWith(`${config.shellPin} `)) {
        working = working.slice(config.shellPin.length + 1).trim();
        effCtx = { ...ctx, shellPinOk: true };
      }

      // ── stack: multiple slash commands in one WhatsApp bubble, each line starting with /
      //    e.g. "/cron add every 10m pani\n/voicereply hello"
      //    Executed sequentially, results joined, no parallel double-work.
      const lines = working.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const isStack = lines.length > 1 && lines.every(l => l.startsWith('/'));
      if (isStack && stopInStack(lines)) {
        // "/arena hi" + "/stop" in one bubble: stop wins, nothing else runs.
        return `${stopCommand()}\n\n_(Stack me /stop tha — baaki lines nahi chalayi.)_`;
      }
      if (isStack) {
        const results = [];
        for (const line of lines) {
          const m = line.match(/^\/([a-zA-Z]+)\s*([\s\S]*)$/);
          if (!m) { results.push(`⚠️ Skip: ${line.slice(0,40)}`); continue; }
          const r = await handleCommand(m[1].toLowerCase(), m[2].trim(), effCtx);
          const out = typeof r === 'string' ? r : (r?.text ?? JSON.stringify(r).slice(0,500));
          results.push(out);
          macro.recordStep(store, m[1].toLowerCase(), m[2].trim());
        }
        lastHandledText = clean; lastHandledTs = Date.now();
        return results.join('\n\n---\n\n');
      }

      const cmdMatch = working.match(/^\/([a-zA-Z]+)\s*([\s\S]*)$/);
      if (cmdMatch) {
        const res = await handleCommand(cmdMatch[1].toLowerCase(), cmdMatch[2].trim(), effCtx);
        lastHandledText = clean; lastHandledTs = Date.now();
        // A stopped run is reported by /stop itself; do not send a second wall of text.
        if (res && typeof res === 'object' && res.stopped) {
          log.info?.(`[commands] ${label} stopped by /stop`);
          return null;
        }
        // /teach recorder: only commands that actually worked land in the
        // macro. A failed step in a macro would fail again on every replay.
        const failed = (res && typeof res === 'object' && res.ok === false)
          || (typeof res === 'string' && /^(⚠️|🔒|⏳|🤖 I don't know)/.test(res));
        if (!failed) macro.recordStep(store, cmdMatch[1].toLowerCase(), cmdMatch[2].trim());
        return res;
      }

      // A parked destructive action: "haan" runs it, "nahi" cancels.
      if (store.data.pending) {
        if (AFFIRM.test(working)) return toReply(await actions.runPending(effCtx));
        if (DENY.test(working)) { actions.clearPending(); return '👍 Cancelled — kuch nahi kiya.'; }
        // "nahi, chrome kholo" while a confirm is parked → cancel pending AND run the new instruction!
        const overrideWhilePending = mem.unwrapImmediateOverride(working);
        if (overrideWhilePending.bypassSaved && overrideWhilePending.text !== working) {
          actions.clearPending();
          working = overrideWhilePending.text;
          effCtx = { ...effCtx, bypassSaved: true };
        }
      }

      const quick = intent(working, effCtx);
      if (quick !== undefined) return await quick;

      // Immediate override preambles ("firefox nahi chrome kholo", "is baar firefox kholo", "pehle wala chhodo, /note ...")
      const unwrapped = mem.unwrapImmediateOverride(working);
      if (unwrapped.bypassSaved) {
        working = unwrapped.text;
        effCtx = { ...effCtx, bypassSaved: true };
        const innerCmd = working.match(/^\/([a-zA-Z]+)\s*([\s\S]*)$/);
        if (innerCmd) {
          return await handleCommand(innerCmd[1].toLowerCase(), innerCmd[2].trim(), effCtx);
        }
        const innerQuick = intent(working, effCtx);
        if (innerQuick !== undefined) return await innerQuick;
      }

      // User-defined custom rules & learned keywords run BEFORE built-in NLP defaults,
      // unless the owner explicitly bypassed saved rules in this message.
      if (!effCtx.bypassSaved) {
        const matched = mem.matchRule(store, working);
        if (matched) {
          if (matched.type === 'learned') {
            const learnedRes = await runLearned(matched.keyword, effCtx);
            if (learnedRes != null) return learnedRes;
          } else if (matched.type === 'rule') {
            const ruleRes = await runCustomRule(matched.rule, effCtx);
            if (ruleRes != null) return ruleRes;
          }
        }
      }

      // Offline intent layer: works with zero AI, understands Hinglish.
      const parsed = parseIntent(working);
      if (parsed) {
        if (parsed.reply) return parsed.reply;
        return await handleCommand(parsed.cmd, parsed.args ?? '', effCtx);
      }

      // Fast offline multi-command chaining ("todo add milk aur note: wifi 1234", "volume 40 karo aur screenshot bhej do")
      if (!looksLikeWebTask(working) && !working.includes('?')) {
        const chainParts = working.split(/\s+(?:aur|phir|fir|uske\s+baad|iske\s+baad|and\s+then|then|aur\s+phir)\s+/i).map((p) => p.trim()).filter(Boolean);
        if (chainParts.length >= 2 && chainParts.length <= 4) {
          const isQuickIntent = (s) => (
            /^(?:remind me\b|note(?:\s+kar\s+lo)?\s*[:\-]\s+|note that\s+|add\s+(?:a\s+)?todo[:\s]+|todo[:\s]+|remember\s+|(?:what(?:'s| is) the )?weather\s+(?:in|at)\s+|\S+\s+ka\s+mausam|\d+(?:\.\d+)?\s*%\s*of\s*\d+|\d+(?:\.\d+)?\s+ka\s+\d+\s*(?:%|percent))/i.test(s)
            || tools.looksLikeCalc(s)
            || Boolean(mem.parseRuleStatement(s) || mem.extractFact(s))
          );
          const allOfflineRunnable = chainParts.every((p) => (
            p.startsWith('/')
            || isQuickIntent(p)
            || (!effCtx.bypassSaved && mem.matchRule(store, p) !== null)
            || parseIntent(p) !== null
          ));
          if (allOfflineRunnable) {
            const chainTexts = [];
            let lastMediaReply = null;
            for (const part of chainParts) {
              let stepRes = null;
              const sl = part.match(/^\/([a-zA-Z]+)\s*([\s\S]*)$/);
              if (sl) {
                stepRes = await handleCommand(sl[1].toLowerCase(), sl[2].trim(), effCtx);
              } else {
                const q = intent(part, effCtx);
                if (q !== undefined) {
                  stepRes = await q;
                } else if (!effCtx.bypassSaved && mem.matchRule(store, part)) {
                  const mr = mem.matchRule(store, part);
                  stepRes = mr.type === 'learned' ? await runLearned(mr.keyword, effCtx) : await runCustomRule(mr.rule, effCtx);
                } else {
                  const pi = parseIntent(part);
                  if (pi) stepRes = pi.reply ? pi.reply : await handleCommand(pi.cmd, pi.args ?? '', effCtx);
                }
              }
              if (typeof stepRes === 'string') {
                chainTexts.push(stepRes);
              } else if (stepRes && typeof stepRes === 'object') {
                if (stepRes.text) chainTexts.push(stepRes.text);
                if (stepRes.image || stepRes.document || stepRes.audio || stepRes.video) lastMediaReply = stepRes;
              }
              if (store.data.pending) break; // stop chain if a destructive action parked for confirmation
            }
            const joined = chainTexts.join('\n\n---\n\n');
            if (lastMediaReply) return { ...lastMediaReply, text: joined };
            if (joined) return joined;
          }
        }
      }

      // Full-power DeepSeek Harness primary mode (`/dsh auto on` or AI_PROVIDER=dsh).
      if (harness.status().autoRoute) {
        return await handleDsh(working, effCtx);
      }

      // Free AI with tools: multi-step tasks on the PC.
      // Pure Q&A / chat questions skip the 20-tool-schema overhead and go straight to askAI (2x-4x faster, with chat history).
      const complexity = estimateComplexity(working);
      if (agentLoop.enabled && (complexity.needsTools || looksLikeWebTask(working))) {
        const agentReply = await agentLoop.run(working, effCtx);
        if (agentReply != null) return agentReply;
      }

      if (config.forwardToObserver && observerOnline()) {
        const fromObserver = await askObserver(working);
        // askObserver already explains failures; only fall through on timeout handled there.
        return fromObserver;
      }
      const aiRes = await askAI(working, effCtx);
      return aiRes;
    } catch (err) {
      if (isStoppedError(err) || task.signal.aborted) {
        log.info?.(`[commands] ${label} stopped by /stop`);
        return null; // /stop already replied
      }
      log.error?.(`[commands] failed on "${clean.slice(0, 60)}": ${err.message}`);
      return `⚠️ That didn't work: ${err.message}\nNothing was charged (everything here is free). Try /help`;
    } finally {
      // dedup marker — any successful handle sets it, duplicate 4s window handles double-work
      if (clean) { lastHandledText = clean; lastHandledTs = Date.now(); }
      isProcessing = false;
      activeSignal = null;
      task.end();
    }
  }

  return {
    handle, HELP, actions, shots, harness, voice,
    attachWaVoip: (engine) => { waVoip = engine; },
    waVoipStatus: () => waVoip?.status?.() ?? null,
    jarvisAudioReply,
    spokenFor: (reply) => spokenSummary(reply, config),
    isHarnessAuto: () => harness.status().autoRoute,
  };
}
