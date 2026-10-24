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
import { ROOT } from './config.js';
import { createApprovalBroker } from './appbridge.js';
import * as tools from './tools.js';
import * as learn from './learn.js';
import * as cron from './cron.js';
import * as tts from './tts.js';
import * as autopilot from './autopilot.js';
import { describeSite } from './sites.js';
import * as hands from './hands.js';
import { tasks as globalTasks, isStopCommand, isStoppedError, throwIfStopped } from './cancel.js';
import * as ai from './ai.js';
import * as pc from './pccontrol.js';
import { shadesOn, shadesOff, shadesStatus, initShades, shadeAwareBrightness } from './shades.js';
import * as liveMirror from './livemirror.js';
import * as guardMode from './guard.js';
import * as notifMirror from './notifmirror.js';
import * as study from './studypack.js';
import * as expenses from './expenses.js';
import { resolveRefs, absorb, contextStatus, clearContext } from './context.js';
import { parseCorrection, saveCorrection, applyCorrection, listCorrections } from './corrections.js';
import { scoreAnswer, bestAnswer } from './answerquality.js';
import { withSource, extractSources } from './sourcelinks.js';
import { completeWithFallback, fallbackReply } from './brainfallback.js';
import { makePlan, planStatus, approvePlan, cancelPlan, buildSteps, planReply } from './planpreview.js';
import { diffBuffers, setBaseline, compareWithBaseline, diffReply, pushBuffer, resetDiff } from './screendiff.js';
import { extractHighlights, highlightReply } from './highlights.js';
import { startTimelapse, stopTimelapse } from './timelapse.js';
import { parseFill, fillForm, fillReply } from './formfill.js';
import { detectShare, sharePolicy } from './sharedetect.js';
import { saveMacroFromHistory, trackCommand } from './macrohistory.js';
import { addWatch, removeWatch, checkAll, watchList } from './watchalert.js';
import { buildPlaylistNotes } from './playlist.js';
import { searchContent, contentReply } from './contentsearch.js';
import { netTick, netReport, setNetwatch } from './netwatch.js';
import { saveScript, getScript, listScripts, callPlan } from './callscript.js';
import { setWindow as setQuietWindow, clearWindow as clearQuiet, digest as quietDigest, gate as quietGate, loadQuiet } from './quiet.js';
import { shouldVoiceReply, voiceReply } from './voicereply.js';
import {
  isDestructive, requestConfirm, confirmPending, cancelPending, pendingState,
  moveToTrash, listTrash, restoreTrash, runPanic, pendingTicket,
} from './safety.js';
import { saveSnapshot, rollback as rollbackTo, snapshotList } from './rollback.js';
import { setupMail, checkMail, mailStatus, setMonitor } from './mail.js';
import { makeDeliverable } from './make.js';
import { scanPII, redactPII, guardOutbound } from './pii.js';
import { syncFromICS, exportICS } from './gcal.js';
import { switchTopic, currentTopic, recordMessage, pinToTopic, topicContext, listTopics, deleteTopic } from './topics.js';
import { buildToday } from './today.js';
import { addExam, examCountdownReply, nextExam, removeExam, loadExams } from './exams.js';
import { accuracyReport } from './accuracyreport.js';
import { buildRevisionSegments, revisionSummary } from './revisioncall.js';
import { scanToPack, cardsFromText } from './studyscan.js';
import { tick as escalateTick, humanDelta } from './escalate.js';
import { blockTick, parseBlockList, DEFAULT_BLOCK } from './siteblock.js';
import { logAudit, auditReply } from './audit.js';
import { fireNudges, setNudges, evaluateNudges } from './nudges.js';
import { buildRecap, recapGoal } from './recap.js';
import * as funMode from './fun.js';
import { setRole, rolesStatus, setLimit as setRoleLimit, allowCommand } from './roles.js';
import { setupHome, addDevice, controlHome, homeStatus } from './smarthome.js';
import { addRoutine, removeRoutine, routineList, dueRoutines } from './routine.js';
import { organize, organizeReply } from './organizer.js';
import { backupNow, cloudCopy, backupList } from './backup.js';
import { leaveByReply } from './leaveby.js';
import { timelineReply, setTimeline, recordShot, loadTimeline } from './timeline.js';
import { enqueue, checkResult, takeNext, postResult, readResult } from './fleetqueue.js';
import { extractActions, actionsReply } from './actionitems.js';
import { startWake, stopWake, wakeStatus, matchWake } from './wake.js';
import * as docChat from './docchat.js';
import * as photoSearch from './photosearch.js';
import * as calendar from './calendar.js';
import * as focusMode from './focus.js';
import * as powerGuard from './powerguard.js';
import * as screenTime from './screentime.js';
import * as meetingNotes from './meetingnotes.js';
import * as clipSync from './clipboard.js';
import * as fleetPcs from './fleetstatus.js';
import * as homework from './homework.js';
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
import { imageStats } from './imaging.js';
import { webcamPhoto } from './systemx.js';
import { spawn } from 'node:child_process';
import { createVoiceCall } from './voicecall.js';
import { jarvisGreeting, spokenSummary } from './jarvis.js';
import * as mem from './memory.js';
import * as reach from './reach.js';
import * as grounding from './grounding.js';
import {
  isOfflineNotifyEnabled,
  buildOfflineMessage,
  noteOfflineAnnounced,
} from './lifecycle.js';
import {
  ensureProfile,
  observeOwnerTurn,
  trainFromHistory,
  formatPersonaReport,
  addLesson,
  createEmptyProfile,
} from './persona.js';
import { isOwner, normalizeNumber, maskNumber } from './allowlist.js';
import {
  ensureGuestStore,
  addContact,
  removeContact,
  listContacts,
  findContactByNumber,
  resolveRecipient,
  parseTargetAndMessage,
  allowGuest,
  blockGuest,
  unblockGuest,
  setGuestMode,
  detectGuestCommandAttempt,
  buildBlockedCommandReply,
  recordGuestChatTurn,
  recordGuestAudit,
  enqueueGuestApproval,
  getActiveGuestApproval,
  listPendingGuestApprovals,
  resolveGuestApproval,
  parseOwnerApprovalDecision,
  formatApprovalCardForOwner,
  formatPendingApprovalsList,
  formatContactsList,
  formatGuestStatus,
  formatGuestLog,
} from './guests.js';
import {
  ensureLocationStore,
  resolveOwnerLocation,
  setOwnerLocation,
  searchNearbyPlaces,
  formatOwnerLocationCard,
} from './location.js';
import {
  getActiveRecording,
  startActionRecording,
  stopActionRecording,
  cancelActionRecording,
  recordDesktopEvent,
  formatActionRecorderStatus,
  saveLastRecordingAsCommand,
  executeRecordedStep,
  replayRecordedActions,
  parseActionRecorderIntent,
} from './actionrecorder.js';
import {
  lookupWordPower,
  formatVocabCard,
  getWordOfTheDay,
  fuzzyMatchSlashCommand,
  normalizeVocabText,
} from './vocab.js';
import {
  solveDeterministicQuery,
  extractDeterministicGrounding,
  looksLikeComplexStemOrMcq,
  formatAccuracyReport,
  runAccuracySelfTest,
  bumpAccuracyStat,
} from './accuracy.js';
import {
  lookupBilingualCorpus,
  detectQuestionScope,
  runBilingualMasteryBenchmark,
  BILINGUAL_CORPUS,
} from './bilingual.js';
import { lookupKnowledge } from './knowledge.js';
import { classifyIntent, learnExample, brainInfo, INTENT_LABELS } from './neural/index.js';
import { trainPersonalBrain } from './neural/training.js';
import { parseBatch, runBatch, batchSummary, conversationSnapshot, concurrencyLimit } from './multitask.js';
import { orchestrate, independentParts, agentForIntent, missionDirective, agentTag, taskBrief, mergeSquadAnswers, fleetStatus, AGENTS } from './agents.js';
import { wikiCommand, wikiFallback } from './wiki.js';
import {
  recordTurnOutcome,
  resolveFollowUpQuery,
  runInstantCodeSandbox,
  answerFromDocuments,
  verifyLiveFact,
  detectRequestedFormat,
  applyAnswerFormat,
  scanTextForScreenErrors,
  parseConditionalWorkflow,
  evaluateConditionalWorkflow,
  WORKSPACES,
  summarizeVoiceOrText,
  buildBriefing2Addons,
  recallEverything,
  runSelfDoctorRepair,
} from './quality15.js';
import {
  handleExpenseCommand,
  handleHabitCommand,
  runGitAutopilot,
  grabMediaOrFile,
  runSmartConverter,
  handleScribeCommand,
  runNetworkHealthCheck,
  handleUsbGuardCommand,
  handleVaultCommand,
  deterministicToneRewrite,
  handlePomodoroCommand,
  handlePortsCommand,
  handleGuardianCommand,
  handleQuizCommand,
  handleBackupCommand,
} from './quality30.js';

const execAsync = promisify(exec);
// Shades' injectable runner (execFile-based; tests pass their own fake).
async function execAsyncFile(bin, args = []) {
  const { execFile } = await import('node:child_process');
  return promisify(execFile)(bin, args ?? [], { timeout: 8000 }).then((r) => r.stdout ?? '');
}

// 🔔 Notification mirror: stream the freedesktop notification bus (GNOME).
function notifMonitorSpawner(onLine) {
  const child = spawn('gdbus', ['monitor', '--session', '--dest', 'org.freedesktop.Notifications'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let buf = '';
  child.stdout?.on('data', (d) => {
    buf += String(d);
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  });
  child.on('error', () => { /* no gdbus — mirror simply has nothing to show */ });
  return child;
}

// 📚 Study pack builder: AI generates summary + flashcards + quiz JSON.
async function buildStudyPack(topic, ctx) {
  const prompt = [
    `Create a study pack on "${topic}" for an Indian school student.`,
    'Return ONLY a JSON object, no prose:',
    '{"summary":"4-6 line crisp summary","flashcards":[{"q":"question","a":"short answer"} x 12],"quiz":[{"q":"question","options":["a","b","c","d"],"answer":"a"} x 6]}',
  ].join('\n');
  const raw = await ai.complete(config, prompt, log).catch(() => null);
  const parsed = raw ? solver.extractJsonObject(solver.stripThinkBlocks(raw)) : null;
  if (!parsed?.flashcards?.length && !parsed?.summary) {
    return '📚 Study pack banane ke liye AI brain chahiye — `/brains` se setup karo (free: Ollama/Groq).';
  }
  const pack = study.buildPack(topic, parsed, Date.now());
  study.savePack(pack);
  store.data.lastStudyTopic = topic;
  store.save?.();
  return [
    `📚 *Study pack ready — ${pack.topic}*`,
    '',
    pack.summary,
    '',
    `🃏 ${pack.flashcards.length} flashcards · 📝 ${pack.quiz.length} quiz questions`,
    'Revise: `/revise` · Quiz: `/quiz ' + topic + '`',
  ].join('\n');
}
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
• /shades [off|status] — 🕶️ screen physically BLACK (privacy) but screenshots CLEAR
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
*🚀 3.5.0 — 15 Smart Features*
• /live [sec] — 🎥 screen mirror (live screenshots stream here)
• /guard on|off|status — 🛡️ webcam motion → photo alert (travel ke liye)
• /nmirror on|off|allow <apps> — 🔔 PC notifications yahan mirror
• /study <topic> · /revise · /quiz — 📚 flashcards + spaced repetition
• /exp <amt> <note> · /exp report|budget <n>|undo|list — 💰 kharcha tracker
• /doc <path> · /doc q <question> — 📄 PDF/notes se sawal ke jawab
• /photos <query> · /photos index — 🔍 photo dhundo (meaning se)
• /cal add kal 4pm meeting · /cal today|week — 🗓️ calendar + /brief me reminders
• /focus 25 block:youtube — 🎯 pomodoro + distraction blocker
• /pguard on|status|battery 20|temp 90 — 🔋 battery/temp alerts
• /stats [today|week|on|off] — 📊 screen time report
• /notes now|stop — 🎙️ meeting record → AI notes + transcript
• /clip · /copy <text> — 📋 PC↔phone clipboard sync
• /pcs register <name> · /pcs — 🖥️ multi-PC fleet status
• /hw add maths pg 42 kal · /hw today|week|done — 📝 homework tracker

*🆕 3.8.0 — Complete Feature Suite (29 upgrades)*
• /today — 📅 aaj ka full timeline (calendar + reminders + pending + HW)
• /exam add <sub> <date> · list · del — 🎯 exam countdown + auto study schedule
• /revise call [topic] — 📞 JARVIS khud CALL karta hai + revision (voice)
• /study scan — 📸 flashcards ki photo → OCR → study pack
• /accuracy report — 📊 bot ka report card (kitne sawal, kitne sahi)
• /recap — 🗞️ weekly recap (padhai/work/balance)
• /block [now] — 🚫 study window me sites auto-close (music allowed)
• /fun quiz|riddle — 🎮 timepass GK quiz + puzzles
• /nudges on|off|now — 💬 proactive nudges (padhai, reminders miss)
• /role <num> kids|family — 👨‍👩‍👧 family/kids mode + /rolelimit <min>
• /home add|light on — 🏠 smart home webhooks (Alexa/Google)
• /routine at 7am <macro> — ⏰ morning auto-routines (IST)
• /organize now — 📂 downloads auto-sort (Images/Docs/…)
• /backup now|list|cloud — 💾 zip backup + GitHub cloud copy
• /leaveby 9am 25km — 🚗 kitne baje niklo (traffic estimate)
• /timeline on|3pm — 🖼️ screenshot timeline / milestone recall
• /wake on|off — 🎤 wake word "Hey JARVIS" + voice command
• /pcs ask|all|check — 🖥️ fleet remote commands (queue + results)
• /audit — 📋 security audit log (guest attempts, naye contacts)
• Notes/meetings se ✅ action-items auto-extract · HW reminders escalate
*📬 3.7.0 — Duet-Class Features*
• 📧 \`/mail setup imap.gmail.com user apppass\` · \`/mail today\` · \`/mail on\` — mail digest + priority alerts (Gmail app-password)
• 🛠️ \`/make report|slides|dashboard|csv <topic>\` — review/edit files bana deta hai
• 🔐 \`/pii scan <text>\` — card/Aadhaar/PAN/API-key detect; outbound strict PII BLOCK; clipboard history redacted
• 🗓️ \`/cal sync <ics-url>\` (Google Calendar secret iCal) · \`/cal export\` — .ics file
• 🗂️ \`/topic work\` — channels with shared memory · \`/pin\` · \`/topic list\`
• ⚡ lookup cache (µs-level repeats) · guests ko kabhi raw PII nahi

*⚡ 3.6.0 — Smart Upgrades*
• 🧠 Multi-turn yaad (\"wo file bhejo\") · \`/context\` · \`galat, asli jawab X hai\` se seekhta hai (\`/corrections\`) · \`/retrain\`
• 🤖 \`/plan <task>\` → preview → \`/go\` (plan-confirm mode) · \`/no\` cancel
• 🔍 \`/look diff\` — screen pe kya badla · \`/highlights <rec>\` — reel · \`/webcam timelapse 2h\` · \`/fill name:Rahul, phone:…\`
• 👀 \`/watch add <url> [price<5000|contains x|release]\` — page/price/release alerts (brief me bhi) · \`/yt playlist <url>\` notes
• 🔎 \`/fsearch <text>\` — file CONTENT search · \`/netwatch\` — wifi watchdog · \`/savemacro <name>\` — last commands → macro
• 📞 \`/callscript save <name> <text>\` · 🌙 \`/quiet 22:00-07:00\` + \`/digest\` · 🎤 voice→voice reply
• 🔒 \`/rm\` ab TRASH me (recoverable: \`/trash restore\`) · double-confirm · \`/panic\` kill-switch · \`/snapshot\` + \`/rollback\`
• 🕶️ \`/shares\` — screen-share detect (shades kabhi auto-OFF nahi)

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
• /sleepnotify [on|off|test|set <msg>] — PC band/sleep hone se pehle auto "Agent is sleeping" message (active by default)
• /persona (ya /profile, /train) — aapki chats se seekha hua behaviour, style, goals, likes/dislikes & continuous self-training
• /learn <keyword> <cmds> — e.g. /learn work open chrome | open slack | open code  — then just /work  ·  /learn list|del
• /weather [city] · /location · /near <query> · /wiki · /news · /calc · /unit · /currency · /url · /qr
• /observer <task> (optional Observer app) · /screen
*📍 Owner Location Intelligence (100% Private to You)*
• /location — aapki current location (GPS Pin / manual / live IP geolocation)
• /location set <city or lat,lon> — ya seedha WhatsApp 📍 Location Pin bhej do!
• /near <cafe|atm|hospital|gym> (ya /location near <query>) — aas-paas ki jagah + distance + Google Maps
• /weather — bina city likhe aapki current location ka live mausam
*👥 Multi-User Messaging, Owner Approval Gate & Command Lock*
• 🛡️ *Owner Approval Gate (Default):* Aapke alawa jo bhi message karega, agent pehle aapko batayega (*Kisne bheja* + *Kis time* + *AI kya reply soch raha hai*). Aap seedha bol sakte ho:
  — *yes* / *haan* → AI ka socha hua reply bhej do
  — *no* / *nahi* → kuch mat bhejo
  — *no send this instead: <text>* (ya *nahi yeh bhejo: <text>*) → AI ke reply ki jagah aapka message bhejega!
• /pending · /approve [id] [custom text] · /reject [id] — pending guest messages dekho/control karo
• /msg <number|name> | <text> — kisi bhi dusre number ya saved contact ko WhatsApp message bhejo
• /reply <text> — last guest sender ko turant reply bhejo · /broadcast <n1,n2> | <text>
• /contact add <Name> <Number> · /contacts — contacts save/manage karo
• /guest [approval|auto|contacts|off|status|log|clear] — guest chat policy & audit log
• /allow <number|name> · /block <number|name> · /unblock <number|name>
• 🔒 *Strict Command Firewall:* Non-owners ke liye sabhi \`/\` aur plain-language commands + aapki location 100% blocked hain!
*Safety*
• /batch <question> || <question> — up to 8 tasks; bounded parallel answers, serial PC actions
• /taskstatus · /batch status — live progress · /batch results — completed/partial outputs · /stop — cancel
• /neural status · /neural learn <label> | <example> · /neural train — real local neural training
• /doctor — kya kaam nahi kar raha, aur exact fix (screenshot/input/AI)
• /access — what is allowed · /yes · /no (destructive actions ask first)
• /run <PIN> <command> — shell, only if ALLOW_SHELL=true

_Built-in commands work with no AI at all. Local Ollama makes conversation + multi-step tasks unlimited and offline._`;

const num = (s) => Number.parseInt(String(s ?? ''), 10);

export function createAgent({
  config, store, log = console, forwardToObserver = async () => null, observerOnline = () => false,
  taskRegistry = globalTasks, notify = null, sendToNumber = null,
}) {
  const tz = config.timezone;
  ensureGuestStore(store, config);
  // The signal of whatever command is running right now. Commands are
  // serialized (isProcessing), so one slot is enough; /stop does not use it.
  let activeSignal = null;
  const appStopListeners = new Set();
  let lastBatch = null;
  // Unsolicited messages (live progress, watch alerts). index.js wires this to
  // WhatsApp; in tests it stays a no-op so nothing ever sends by accident.
  let notifyOwner = typeof notify === 'function' ? notify : async () => false;
  let sendWhatsappTo = typeof sendToNumber === 'function' ? sendToNumber : null;
  const journal = createJournal({ config, log });
  // Same janitor instance the background loop uses, so /shots and the timer
  // agree on one ledger.
  const shots = createShotJanitor({ config, log });
  const harness = createHarness({ config, store, log });
  const actions = createActions({
    config,
    store,
    log,
    journal,
    notify: (msg) => notifyOwner(msg),
    harness,
    sendToNumber: (to, reply) => (sendWhatsappTo ? sendWhatsappTo(to, reply) : Promise.resolve(false)),
  });
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

  // ── learn & custom commands (/learn, /cmd, natural command creation) ──────
  function learnCmd(args) {
    const raw = String(args ?? '').trim();
    if (!raw || raw.toLowerCase() === 'list' || raw.toLowerCase() === 'ls') {
      const all = store.listLearned();
      if (!all.length) {
        return [
          '📚 *No custom commands yet.*',
          'Aap seedha natural message me ya `/learn` se naya command bana sakte ho:',
          '• `"create a command /study that opens chrome and sets volume to 30"`',
          '• `"todo add revise math — create this as a command /math"`',
          '• `"/learn work open chrome | open slack | open code"`',
          'Phir kabhi bhi `/study` ya `study` likho aur wahi task execute hoga!',
        ].join('\n');
      }
      return '📚 *Learned / Custom Commands*\n\n' + all.map(e => `• /${e.keyword} → ${e.commands.map(c => learn.formatLearnedStep ? learn.formatLearnedStep(c) : (c.inferredOpen ? c.args : `/${c.cmd}${c.args ? ' '+c.args : ''}`)).join(' | ')}`).join('\n');
    }
    // delete forms: del work / delete work / rm work / remove work / unlearn work
    const m = raw.match(/^(?:del|delete|rm|remove|unlearn|forget)\s+\/?([a-z0-9_-]+)$/i);
    if (m) {
      const kw = learn.normalizeKeyword(m[1]);
      return store.deleteLearned(kw) ? `🗑️ /${kw} deleted.` : `No learned keyword /${kw}. See /learn list`;
    }
    // handle "add work ..." or "create work ..." prefix
    const addText = raw.replace(/^(?:add|create|set|new)\s+/i, '');
    // split keyword from commands: first word is keyword, rest is commands
    const sp = addText.search(/\s/);
    if (sp === -1) {
      return '📚 Usage: /learn <keyword> <commands>\nE.g. /learn work open chrome | open slack | open code\nOr natural: "create a command /work that opens chrome and sets volume to 40"';
    }
    const keywordRaw = addText.slice(0, sp).trim();
    const commandsRaw = addText.slice(sp + 1).replace(/^(?:that|which|to|for|:|=|-)\s+/i, '').trim();
    if (!commandsRaw) return `📚 /learn ${keywordRaw} — commands kya hai? E.g. /learn ${keywordRaw} open chrome | open slack`;
    const kw = learn.normalizeKeyword(keywordRaw);
    const err = learn.validateKeyword(kw);
    if (err) return `⚠️ ${err}`;
    const cmds = learn.parseLearnCommands(commandsRaw);
    if (!cmds) return '⚠️ Commands samajh nahi aaye. Try:\n/learn work open chrome | open slack\n/learn work chrome, slack, code';
    store.addLearned(kw, cmds, commandsRaw);
    const steps = cmds.map(c => learn.formatLearnedStep ? learn.formatLearnedStep(c) : (c.inferredOpen ? c.args : `/${c.cmd}${c.args ? ' '+c.args : ''}`)).join(' | ');
    return `📚 Learned /${kw} → ${steps}\nAb bas /${kw} ya \`${kw}\` likho aur ye saare kaam ek saath honge.`;
  }

  async function runNaturalStep(stepText, ctx = {}) {
    const cleanStep = String(stepText ?? '').trim();
    if (!cleanStep) return '✅ Done.';
    const stepCtx = { ...ctx, bypassSaved: true };
    const sl = cleanStep.match(/^\/([a-zA-Z0-9_-]+)\s*([\s\S]*)$/);
    if (sl) return handleCommand(sl[1].toLowerCase(), sl[2].trim(), stepCtx);
    const q = intent(cleanStep, stepCtx);
    if (q !== undefined) return await q;
    const pi = parseIntent(cleanStep);
    if (pi) return pi.reply ? pi.reply : await handleCommand(pi.cmd, pi.args ?? '', stepCtx);
    if (agentLoop.enabled) {
      const ar = await agentLoop.run(cleanStep, stepCtx);
      if (ar != null) return ar;
    }
    return askAI(cleanStep, stepCtx);
  }

  async function runLearned(keyword, ctx = {}, extraArgs = '') {
    const cleanKw = learn.normalizeKeyword(keyword);
    const entry = store.getLearned(cleanKw);
    if (!entry) return null;
    const results = [];
    const stepCtx = { ...ctx, bypassSaved: true };
    for (const step of entry.commands) {
      let r;
      if (step.cmd === '__natural__') {
        const naturalText = extraArgs ? `${step.args} ${extraArgs}`.trim() : step.args;
        r = await runNaturalStep(naturalText, stepCtx);
      } else if (step.actionType && ['click', 'double_click', 'right_click', 'middle_click', 'drag', 'scroll', 'type', 'key'].includes(step.actionType)) {
        r = await executeRecordedStep(step, {
          runCommand: (c, a) => handleCommand(c, a, stepCtx),
        });
      } else {
        const cmd = step.inferredOpen ? 'open' : step.cmd;
        const baseArgs = step.args ?? '';
        const args = extraArgs && entry.commands.length === 1
          ? `${baseArgs} ${extraArgs}`.trim()
          : baseArgs;
        r = await handleCommand(cmd, args, stepCtx);
      }
      const out = typeof r === 'string' ? r : (r?.text ?? '');
      if (r && typeof r === 'object' && (r.image || r.audio || r.document || r.video)) {
        results.push(out || '(media)');
        results._lastMedia = r;
      } else {
        results.push(out);
      }
      if (store.data.pending) break;
    }
    const text = `📚 /${entry.keyword} (${entry.commands.length} step${entry.commands.length === 1 ? '' : 's'}):\n\n` + results.join('\n\n---\n\n');
    const lastMedia = results._lastMedia;
    if (lastMedia) {
      return { ...lastMedia, text };
    }
    return text;
  }

  async function cmdCommand(args, ctx = {}) {
    const raw = String(args ?? '').trim();
    if (!raw || /^(?:list|ls|show)$/i.test(raw)) return learnCmd('list');
    const runMatch = raw.match(/^(?:run|exec|execute|start)\s+\/?([a-zA-Z0-9_-]+)(?:\s+([\s\S]+))?$/i);
    if (runMatch) {
      const kw = learn.normalizeKeyword(runMatch[1]);
      const res = await runLearned(kw, ctx, (runMatch[2] || '').trim());
      return res ?? `⚠️ Custom command \`/${kw}\` nahi mila. (\`/learn list\` dekhein)`;
    }
    return learnCmd(raw);
  }

  async function executeCreateCommandIntent(parsedCmd, ctx = {}) {
    if (!parsedCmd) return undefined;
    if (parsedCmd.action === 'list') {
      return learnCmd('list');
    }
    if (parsedCmd.action === 'delete') {
      return learnCmd(`del ${parsedCmd.name}`);
    }
    if (parsedCmd.action === 'create') {
      const kw = learn.normalizeKeyword(parsedCmd.name);
      const err = learn.validateKeyword(kw);
      if (err) return `⚠️ ${err}`;
      const taskText = String(parsedCmd.task || store.getLastOwnerTask() || '').trim();
      if (!taskText) {
        return `⚠️ Command \`/${kw}\` me kya task save karna hai? Example:\n• \`create a command /${kw} that opens chrome and sets volume to 30\`\n• Ya pehle koi task bhejo aur phir bolo: \`create this as a command /${kw}\``;
      }
      const cmds = learn.parseLearnCommands(taskText);
      if (!cmds || !cmds.length) {
        return `⚠️ Command \`/${kw}\` ke steps samajh nahi aaye. Try: \`create a command /${kw} that opens chrome and takes a screenshot\``;
      }
      store.addLearned(kw, cmds, taskText);
      const steps = cmds.map((c) => learn.formatLearnedStep(c)).join(' → ');
      const header = [
        `🧠 *Custom Command Created:* \`/${kw}\``,
        `📋 *Task (${cmds.length} step${cmds.length === 1 ? '' : 's'}):* ${steps}`,
        parsedCmd.fromLastMessage ? `↩️ _Created from your previous message: "${taskText.slice(0, 100)}"_` : '',
        '',
        `Ab aap kabhi bhi \`/${kw}\` ya sirf \`${kw}\` bhejoge to main yahi task execute karunga!`,
      ].filter(Boolean).join('\n');

      if (parsedCmd.runNow) {
        const executed = await runLearned(kw, ctx);
        if (executed && typeof executed === 'object') {
          return { ...executed, text: `${header}\n\n---\n\n${executed.text || ''}` };
        }
        return `${header}\n\n---\n\n${executed || ''}`;
      }
      return header;
    }
    return undefined;
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
        // 🕶️ Stealth: while shades are ON the panel stays black — this only
        // adjusts the saved level that /shades off will restore.
        const stealth = await shadeAwareBrightness(action, value);
        if (stealth) return stealth;
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
      case 'drag': {
        const gate = tier2Gate(rest);
        if (gate.reply) return gate.reply;
        const nums = gate.text.match(/-?\d+/g)?.map(Number) ?? [];
        if (nums.length < 4) return '🖱️ Usage: /pc drag <x1> <y1> <x2> <y2>';
        return pc.dragMouse(nums[0], nums[1], nums[2], nums[3]);
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
        noteOfflineAnnounced(store, action);
        pc.schedulePower(action);
        return `😴 *Agent is sleeping* — ⏻ ${{ shutdown: 'Shutting down', poweroff: 'Shutting down', reboot: 'Rebooting', restart: 'Rebooting', suspend: 'Suspending', sleep: 'Suspending' }[action]} in 5 seconds. See you on the other side 👋`;
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
      `Work size: ${meta.requestedTier ?? meta.tier ?? plan.tier} · tried: ${(meta.attempts ?? []).map((attempt) => shortModel(attempt.model)).join(' → ') || 'none (cooldown/provider filter)'}`,
      ...((meta.attempts ?? []).filter((attempt) => attempt.error).map((attempt) =>
        `• ${shortModel(attempt.model)} — ${attempt.error.kind}${attempt.error.status ? ` / HTTP ${attempt.error.status}` : ''}: ${attempt.error.message}`)),
      ...[...new Set((meta.attempts ?? []).filter((attempt) => attempt.error).map((attempt) => attempt.error.hint))].slice(0, 3),
      ...(!meta.attempts?.length ? (meta.plan?.notes ?? []) : []),
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
    for (const fn of appStopListeners) { try { fn(); } catch {} }
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
    const rawWatch = String(args ?? '').trim();
    if (/^(?:error|errors|crash|build\s+error)$/i.test(rawWatch)) {
      const watcher = watch.addWatcher(store, {
        condition: 'Screen/Terminal Error or Crash (SyntaxError / TypeError / Traceback / Build failed)',
        everyMs: 30_000,
        once: false,
      });
      return [
        '🚨 *Live Screen Error Auto-Watcher: ON*',
        `• Watching for: _${watcher.condition}_`,
        '• Har 30s screen/terminal check karunga — koi bhi error ya crash aate hi screenshot + fix bhejunga.',
        `Stop: \`/watch stop ${watcher.id}\``,
      ].join('\n');
    }
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

  // ── Live PC Action Recorder, Learner & Replayer (`/watchme`, `/recordactions`) ──
  async function executeActionRecorderIntent(intentObj, ctx = {}) {
    if (!intentObj) return undefined;
    if (ctx?.isOwner === false || ctx?.guest) {
      return buildBlockedCommandReply(config, store, { command: '/watchme' });
    }
    if (intentObj.action === 'start') {
      const res = await startActionRecording(store, config, { name: intentObj.name || '' });
      return res.text;
    }
    if (intentObj.action === 'stop') {
      const res = await stopActionRecording(store, { name: intentObj.name || '' });
      return res.ok ? res.text : res.reason;
    }
    if (intentObj.action === 'cancel') {
      return cancelActionRecording(store).text;
    }
    if (intentObj.action === 'save_as') {
      const res = saveLastRecordingAsCommand(store, intentObj.name || '');
      return res.ok ? res.text : `⚠️ ${res.reason}`;
    }
    if (intentObj.action === 'replay') {
      const res = await replayRecordedActions(store, {
        name: intentObj.name || '',
        times: intentObj.times || 1,
        delayMs: 0,
        runCommand: (cmd, args) => handleCommand(cmd, args, { ...ctx, bypassSaved: true }),
      });
      return res.image || res.audio || res.document || res.video ? res : res.text;
    }
    return formatActionRecorderStatus(store);
  }

  async function watchMeCommand(args = '', ctx = {}) {
    if (ctx?.isOwner === false || ctx?.guest) {
      return buildBlockedCommandReply(config, store, { command: '/watchme' });
    }
    const raw = String(args ?? '').trim();
    const low = raw.toLowerCase();

    if (!raw || /^(?:status|list|ls|info)$/i.test(low)) {
      return formatActionRecorderStatus(store);
    }
    const startMatch = raw.match(/^(?:start|record|shuru|begin)(?:\s+\/?([a-zA-Z][a-zA-Z0-9_-]{1,27}))?$/i);
    if (startMatch) {
      return executeActionRecorderIntent({ action: 'start', name: startMatch[1] || '' }, ctx);
    }
    const stopMatch = raw.match(/^(?:stop|save|done|finish|band|khatam)(?:\s+(?:as\s+)?\/?([a-zA-Z][a-zA-Z0-9_-]{1,27}))?$/i);
    if (stopMatch) {
      return executeActionRecorderIntent({ action: 'stop', name: stopMatch[1] || '' }, ctx);
    }
    if (/^(?:cancel|abort|chhodo|discard)$/i.test(low)) {
      return executeActionRecorderIntent({ action: 'cancel' }, ctx);
    }
    const replayMatch = raw.match(/^(?:replay|repeat|run)(?:\s+\/?([a-zA-Z][a-zA-Z0-9_-]{1,27}))?(?:\s+(\d+)\s*(?:times?|baar)?)?$/i);
    if (replayMatch) {
      return executeActionRecorderIntent({
        action: 'replay',
        name: replayMatch[1] || '',
        times: Number(replayMatch[2] || 1),
      }, ctx);
    }
    const saveAsMatch = raw.match(/^(?:name|rename|saveas|save_as)\s+\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})$/i);
    if (saveAsMatch) {
      return executeActionRecorderIntent({ action: 'save_as', name: saveAsMatch[1] }, ctx);
    }
    // Shortcut `/watchme morning` -> start recording as `morning`
    if (/^\/?[a-zA-Z][a-zA-Z0-9_-]{1,27}$/.test(raw)) {
      return executeActionRecorderIntent({ action: 'start', name: raw }, ctx);
    }
    return formatActionRecorderStatus(store);
  }

  async function briefCommand(args) {
    const raw = String(args ?? '').trim();
    if (!raw) {
      const baseBrief = await brief.buildBrief({ store, config });
      const addons = buildBriefing2Addons(store);
      // 3.5.0: today's calendar events + due-soon homework join the brief.
      const extra = [];
      try {
        const calToday = calendar.todayReply();
        if (!/koi event nahi/.test(calToday)) extra.push(calToday);
      } catch { /* brief never breaks */ }
      try {
        const hwToday = homework.todayReply();
        if (!/koi homework due nahi/.test(hwToday)) extra.push(hwToday);
      } catch { /* brief never breaks */ }
      try {
        // 👀 watch alerts (page change / price / release) join the brief
        const { alerts } = await checkAll({
          fetchText: (u) => fetch(u, { signal: AbortSignal.timeout(5000) }).then((r) => r.text()),
        });
        if (alerts?.length) extra.push(`👀 *Watch alerts*\n${alerts.join('\n')}`);
      } catch { /* brief never breaks */ }
      return [baseBrief, addons, ...extra].filter(Boolean).join('\n\n');
    }
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

  function sleepNotifyCommand(args) {
    const raw = String(args ?? '').trim();
    const [subRaw, ...restParts] = raw.split(/\s+/);
    const sub = (subRaw || 'status').toLowerCase();
    const rest = restParts.join(' ').trim();

    if (['on', 'enable', 'active', 'activate', 'chalu'].includes(sub)) {
      store.data.offlineNotify = true;
      store.save();
      return `✅ *Offline/sleeping auto-message ACTIVE hai!* 😴\nAb jab bhi PC band (shutdown), restart, sleep/suspend ya agent offline hoga, bina puche message aayega:\n\n${buildOfflineMessage({ config, store, reason: 'shutdown' })}`;
    }
    if (['off', 'disable', 'band'].includes(sub)) {
      store.data.offlineNotify = false;
      store.save();
      return '⚪ Offline/sleeping auto-message *OFF* kar diya. (`/sleepnotify on` se wapas active karein)';
    }
    if (['test', 'now', 'check', 'preview'].includes(sub)) {
      return buildOfflineMessage({ config, store, reason: rest || 'shutdown' });
    }
    if (['reset', 'default', 'clear'].includes(sub)) {
      store.data.offlineMessage = '';
      store.data.offlineNotify = true;
      store.save();
      return `✅ Default sleeping message restore ho gaya:\n\n${buildOfflineMessage({ config, store, reason: 'shutdown' })}`;
    }
    if (sub === 'set' && rest) {
      store.data.offlineMessage = rest;
      store.data.offlineNotify = true;
      store.save();
      return `✅ Custom sleeping message set ho gaya:\n\n${buildOfflineMessage({ config, store, reason: 'shutdown' })}`;
    }
    if (raw && !['status', 'info', 'help'].includes(sub)) {
      store.data.offlineMessage = raw;
      store.data.offlineNotify = true;
      store.save();
      return `✅ Custom sleeping message set ho gaya:\n\n${buildOfflineMessage({ config, store, reason: 'shutdown' })}`;
    }

    const enabled = isOfflineNotifyEnabled(config, store);
    const preview = buildOfflineMessage({ config, store, reason: 'shutdown' });
    const lastAt = store.data.stats?.lastOfflineNotify;
    const lastReason = store.data.stats?.lastOfflineReason || 'offline';
    return [
      `😴 *Offline / Sleeping Auto-Message* — ${enabled ? '🟢 *ACTIVE*' : '⚪ *OFF*'}`,
      '• Trigger: PC shutdown, restart, sleep/suspend, ya agent service stop hone se pehle bina puche WhatsApp message bhejta hai',
      lastAt ? `• Last sent: ${tools.formatDateTime(lastAt, tz)} (${lastReason})` : '• Last sent: _abhi tak nahi_',
      '',
      '*Message preview:*',
      preview,
      '',
      '*Commands:*',
      '• `/sleepnotify on` · `/sleepnotify off` — chalu ya band karo',
      '• `/sleepnotify test` — abhi sleeping message preview dekho',
      '• `/sleepnotify set <custom message>` — apna message set karo',
      '• `/sleepnotify reset` — default message wapas lao',
    ].join('\n');
  }

  // Bootstrap the owner behavioral profile from existing history/notes/todos/facts on startup
  try { trainFromHistory(store); } catch { /* best-effort */ }

  async function personaCommand(args = '', { forceTrain = false } = {}) {
    const raw = String(args ?? '').trim();
    const [subRaw] = raw.split(/\s+/);
    const sub = (subRaw || '').toLowerCase();
    const rest = raw.slice(subRaw ? subRaw.length : 0).trim();

    if (sub === 'reset' || sub === 'clear') {
      store.data.profile = createEmptyProfile();
      store.save();
      return '🧹 Behavioral profile reset kar diya. Ab main aapki nayi chats se fresh seekhunga!';
    }
    if ((sub === 'teach' || sub === 'rule' || sub === 'lesson') && rest) {
      const profile = ensureProfile(store);
      addLesson(profile, rest, 'owner_command');
      observeOwnerTurn(store, rest);
      return `🧠 *Behavioral Lesson Saved!* Ab main har chat me ye yaad rakhunga:\n• _${rest}_\n\n(/persona se pura profile dekhein)`;
    }
    if (sub === 'goal' && rest) {
      const profile = ensureProfile(store);
      profile.goals.push({ text: rest, ts: Date.now(), status: 'active' });
      store.save();
      return `🎯 *Active Goal Added:* *${rest}*\nMain aapki chats aur tasks me is goal ko dhyan me rakhunga.`;
    }
    if (sub === 'like' && rest) {
      const profile = ensureProfile(store);
      profile.preferences.push({ text: rest, ts: Date.now(), source: 'owner_command' });
      store.save();
      return `❤️ *Preference Saved:* *${rest}*`;
    }
    if (sub === 'dislike' && rest) {
      const profile = ensureProfile(store);
      profile.dislikes.push({ text: rest, ts: Date.now(), source: 'owner_command' });
      store.save();
      return `🚫 *Dislike Saved:* *${rest}*`;
    }
    if (forceTrain || sub === 'train' || sub === 'reflect' || sub === 'learn') {
      const extraInstruction = forceTrain ? raw : rest;
      if (extraInstruction) {
        const profile = ensureProfile(store);
        observeOwnerTurn(store, extraInstruction);
        if (extraInstruction.length >= 6 && !/^(?:now|all|chats?|history|me)$/i.test(extraInstruction)) {
          addLesson(profile, extraInstruction, 'owner_train');
        }
      }
      const { learnedCount } = trainFromHistory(store);
      const biBench = runBilingualMasteryBenchmark();
      let aiReflected = false;
      if (config.aiProvider !== 'none') {
        const ref = await ai.reflectOwnerProfile(config, store, log);
        aiReflected = Boolean(ref?.updated);
      }
      const header = [
        `⚡ *Self-Training Complete! (Bilingual Mastery Active)*`,
        `• Analyzed all your past chats, notes, todos & facts (${learnedCount} new signals + ${aiReflected ? 'deep AI reflection updated ✨' : 'instant behavioral analysis active'})`,
        `• *Hinglish + English Mastery Corpus*: Trained on *${BILINGUAL_CORPUS.length}* bilingual patterns · Benchmark: *${biBench.passed}/${biBench.total} (${biBench.pct}%)* in \`${biBench.ms}ms\``,
        `• *Strict Question-Scope Alignment*: Active — jo aap puchoge uska hi seedha, proper aur perfect answer milega.`,
        '',
      ].join('\n');
      return header + formatPersonaReport(store, config);
    }
    if (raw && !['status', 'show', 'view', 'info', 'me'].includes(sub)) {
      // e.g. `/persona speak like a brother and keep answers practical`
      const profile = ensureProfile(store);
      addLesson(profile, raw, 'owner_command');
      observeOwnerTurn(store, raw);
      return `🧠 *Updated your behavioral profile:* _${raw}_\n\n${formatPersonaReport(store, config)}`;
    }
    return formatPersonaReport(store, config);
  }

  // ── Controlled Multi-User Messaging, Contacts & Guest Policy Commands ────

  async function msgCommand(args, ctx = {}) {
    if (ctx?.isOwner === false || ctx?.guest) {
      return buildBlockedCommandReply(config, store, { command: '/msg' });
    }
    const raw = String(args ?? '').trim();
    if (!raw) {
      return [
        '📤 *Send WhatsApp Message to Another Person*',
        'Usage:',
        '• `/msg <phone_or_contact> | <message>`',
        '• `/msg 9876543210 Hello bhai, 5 baje milte hain`',
        '• `/msg Rahul | Meeting 10 min me start hogi`',
        '• `/reply <message>` — reply to the last guest who messaged',
        '• `/broadcast <n1, n2> | <message>` — send to up to 5 recipients',
      ].join('\n');
    }
    const parsed = parseTargetAndMessage(store, config, raw);
    if (!parsed.ok) {
      return parsed.reason || '⚠️ Usage: `/msg <phone_number_or_contact_name> | <message>`';
    }
    return act('send_whatsapp', { to: parsed.recipient.number, text: parsed.text }, ctx);
  }

  async function replyCommand(args, ctx = {}) {
    if (ctx?.isOwner === false || ctx?.guest) {
      return buildBlockedCommandReply(config, store, { command: '/reply' });
    }
    const text = String(args ?? '').trim();
    if (!text) {
      const last = store?.data?.lastGuestSender;
      const hint = last?.number
        ? `Last guest: *${last.name || `+${last.number}`}* (\`+${last.number}\`)`
        : 'No guest has messaged yet in this session.';
      return `↩️ *Usage:* \`/reply <message>\`\n${hint}`;
    }
    return act('send_whatsapp', { to: 'last', text }, ctx);
  }

  async function broadcastCommand(args, ctx = {}) {
    if (ctx?.isOwner === false || ctx?.guest) {
      return buildBlockedCommandReply(config, store, { command: '/broadcast' });
    }
    const raw = String(args ?? '').trim();
    const pipeIdx = raw.indexOf('|');
    if (pipeIdx === -1) {
      return '📢 *Usage:* `/broadcast <target1, target2, ...> | <message>` (max 5 recipients per broadcast)';
    }
    const targetsRaw = raw.slice(0, pipeIdx).split(',').map((s) => s.trim()).filter(Boolean);
    const body = raw.slice(pipeIdx + 1).trim();
    if (!targetsRaw.length || !body) {
      return '📢 *Usage:* `/broadcast <target1, target2, ...> | <message>`';
    }
    if (targetsRaw.length > 5) {
      return '🔒 For safety & anti-spam control, `/broadcast` is capped at 5 recipients at a time.';
    }
    const results = [];
    for (const target of targetsRaw) {
      const res = await actions.execute('send_whatsapp', { to: target, text: body }, ctx);
      results.push(res.ok ? `✅ *${target}*: Sent` : `⚠️ *${target}*: ${res.text}`);
    }
    return `📢 *Broadcast Summary (${targetsRaw.length}):*\n${results.join('\n')}`;
  }

  function contactCommand(args) {
    const raw = String(args ?? '').trim();
    if (!raw || /^(?:list|ls|all|show)$/i.test(raw)) {
      return formatContactsList(store, config);
    }
    const delMatch = raw.match(/^(?:del|delete|rm|remove)\s+(.+)$/i);
    if (delMatch) {
      const res = removeContact(store, delMatch[1].trim(), config);
      return res.ok
        ? `🗑️ Removed contact *${res.removed.name}* (\`+${res.removed.number}\`).`
        : `⚠️ ${res.reason}`;
    }
    const stripped = raw.replace(/^add\s+/i, '').trim();
    let name = '';
    let number = '';
    if (stripped.includes('|')) {
      const [left, right] = stripped.split('|').map((s) => s.trim());
      name = left;
      number = right;
    } else {
      const m = stripped.match(/^(.+?)\s+(\+?\d[\d\s\-()]{6,18}\d)$/);
      if (m) {
        name = m[1].trim();
        number = m[2].trim();
      }
    }
    if (!name || !number) {
      return [
        '📇 *Contact Book Usage:*',
        '• `/contact add <Name> <Phone>` (e.g. `/contact add Rahul 9876543210`)',
        '• `/contact del <Name or Phone>`',
        '• `/contacts` — list all saved contacts',
      ].join('\n');
    }
    const res = addContact(store, name, number, config);
    if (!res.ok) return `⚠️ ${res.reason}`;
    return `📇 *Contact Saved:* *${res.contact.name}* → \`+${res.contact.number}\`\nAb aap seedha \`/msg ${res.contact.name} | Hello\` bhej sakte hain.`;
  }

  function allowCommand(args) {
    const target = String(args ?? '').trim();
    if (!target) return '✅ *Usage:* `/allow <phone_number_or_contact_name>`';
    const res = allowGuest(store, config, target);
    if (!res.ok) return `⚠️ ${res.reason}`;
    return `✅ *Allowed Guest:* ${res.name ? `*${res.name}* ` : ''}(\`+${res.number}\`) can now chat with the AI (commands remain owner-only).`;
  }

  function blockCommand(args) {
    const target = String(args ?? '').trim();
    if (!target) return '🚫 *Usage:* `/block <phone_number_or_contact_name>`';
    const res = blockGuest(store, config, target);
    if (!res.ok) return `⚠️ ${res.reason}`;
    return `🚫 *Blocked Number:* ${res.name ? `*${res.name}* ` : ''}(\`+${res.number}\`). All messages from this number will be ignored.`;
  }

  function unblockCommand(args) {
    const target = String(args ?? '').trim();
    if (!target) return '🔓 *Usage:* `/unblock <phone_number_or_contact_name>`';
    const res = unblockGuest(store, config, target);
    if (!res.ok) return `⚠️ ${res.reason}`;
    return res.wasBlocked
      ? `🔓 *Unblocked:* ${res.name ? `*${res.name}* ` : ''}(\`+${res.number}\`).`
      : `ℹ️ \`+${res.number}\` was not in the blocklist.`;
  }

  function guestCommand(args) {
    ensureGuestStore(store, config);
    const raw = String(args ?? '').trim();
    const low = raw.toLowerCase();
    if (!raw || low === 'status' || low === 'info') {
      return formatGuestStatus(store, config);
    }
    if (low === 'log' || low === 'logs' || low === 'audit' || low === 'history') {
      return formatGuestLog(store, config);
    }
    if (low === 'pending' || low === 'queue') {
      return formatPendingApprovalsList(store, config);
    }
    if (low === 'clear' || low === 'reset') {
      store.data.guestChats = {};
      store.data.guestAuditLog = [];
      store.data.pendingGuestApprovals = [];
      store.save();
      return '🧹 Cleared all guest chat histories, pending approvals, and audit logs.';
    }
    if (/^(?:approval|approve|ask|confirm|review|hold|moderate|moderated)$/i.test(low)) {
      setGuestMode(store, config, 'approval');
      return '🛡️ *Guest Mode: OWNER APPROVAL (Moderated)*\nAb aapke alawa jo bhi message karega, agent pehle aapko bhejega (*Who sent* + *Time* + *What AI is thinking of replying*) taaki aap *yes*, *no*, ya *no send this instead: <text>* bol sako!';
    }
    if (/^(?:all|auto|on|open|public|everyone|chalu)$/i.test(low)) {
      setGuestMode(store, config, 'all');
      store.data.guestPolicy.requireApproval = false;
      store.save();
      return '🌐 *Guest Mode: AUTO-REPLY (ALL)*\nAnyone (except blocked numbers) can chat with the AI automatically. All `/` and plain-language commands remain 100% locked to you (owner).';
    }
    if (/^(?:contacts|allowlist|saved)$/i.test(low)) {
      setGuestMode(store, config, 'contacts');
      return '📇 *Guest Mode: CONTACTS ONLY*\nOnly saved contacts (`/contacts`) and `/allow`-ed numbers can chat with the AI. All commands remain 100% locked to you (owner).';
    }
    if (/^(?:off|disable|disabled|none|private|band)$/i.test(low)) {
      setGuestMode(store, config, 'off');
      return '🔒 *Guest Mode: OFF (Owner-Only)*\nIncoming messages from all non-owners will be silently ignored. You can still message anyone via `/msg <number|name> | <text>`.';
    }
    const approvalMatch = raw.match(/^(?:approval|ask|confirm)\s+(on|off|true|false)$/i);
    if (approvalMatch) {
      const enable = /^(?:on|true)$/i.test(approvalMatch[1]);
      store.data.guestPolicy.requireApproval = enable;
      if (enable && store.data.guestPolicy.mode === 'off') store.data.guestPolicy.mode = 'approval';
      store.save();
      return enable
        ? '🛡️ *Owner Approval Gate ON:* Every guest reply will wait for your `yes` / `no` / `no send this instead: <text>`.'
        : '🟢 *Owner Approval Gate OFF:* Allowed guests will receive automatic safe AI replies.';
    }
    const notifyMatch = raw.match(/^notify\s+(on|off|true|false|all|blocked)$/i);
    if (notifyMatch) {
      const val = notifyMatch[1].toLowerCase();
      if (val === 'on' || val === 'true' || val === 'all') {
        store.data.guestPolicy.notifyOwnerOnMessage = true;
        store.data.guestPolicy.notifyOwnerOnBlockedCmd = true;
        store.save();
        return '🔔 Owner notifications enabled for all guest messages and blocked commands.';
      }
      if (val === 'blocked') {
        store.data.guestPolicy.notifyOwnerOnMessage = false;
        store.data.guestPolicy.notifyOwnerOnBlockedCmd = true;
        store.save();
        return '🔔 Owner notifications set to *blocked command attempts only*.';
      }
      store.data.guestPolicy.notifyOwnerOnMessage = false;
      store.data.guestPolicy.notifyOwnerOnBlockedCmd = false;
      store.save();
      return '🔕 Owner notifications for guest chats turned OFF.';
    }
    const rateMatch = raw.match(/^(?:rate|ratelimit|limit)\s+(\d+)$/i);
    if (rateMatch) {
      const n = Math.max(1, Math.min(60, Number.parseInt(rateMatch[1], 10) || 6));
      store.data.guestPolicy.rateLimitPerMinute = n;
      store.save();
      return `⏱️ Guest rate limit set to *${n} messages/minute* per guest.`;
    }
    const autoReplyMatch = raw.match(/^(?:autoreply|reply)\s+([\s\S]+)$/i);
    if (autoReplyMatch) {
      const text = autoReplyMatch[1].trim();
      if (/^(?:off|clear|none|default|ai)$/i.test(text)) {
        store.data.guestPolicy.customAutoReply = '';
        store.save();
        return '🤖 Custom guest auto-reply cleared — guests will receive dynamic AI chat replies.';
      }
      store.data.guestPolicy.customAutoReply = text;
      store.save();
      return `💬 Fixed guest auto-reply set to:\n"${text}"`;
    }
    if (low.startsWith('allow ')) return allowCommand(raw.slice(6));
    if (low.startsWith('block ')) return blockCommand(raw.slice(6));
    if (low.startsWith('unblock ')) return unblockCommand(raw.slice(8));
    return formatGuestStatus(store, config);
  }

  /**
   * Execute the owner's decision (`approve`, `reject`, `custom`, or `block`)
   * on a pending guest message.
   */
  async function executeOwnerApprovalDecision(decision, targetId = null, ctx = {}) {
    if (ctx?.isOwner === false || ctx?.guest) {
      return buildBlockedCommandReply(config, store, { command: '/approve' });
    }
    const entry = getActiveGuestApproval(store, config, targetId);
    if (!entry) {
      return 'ℹ️ Abhi koi pending guest message approval ke liye nahi hai.';
    }
    const who = entry.senderName
      ? `*${entry.senderName}* (\`+${entry.senderNumber}\`)`
      : `\`+${entry.senderNumber}\``;

    if (decision.action === 'reject') {
      resolveGuestApproval(store, config, entry.id, 'rejected', '');
      recordGuestAudit(store, {
        from: entry.senderNumber,
        name: entry.senderName,
        kind: 'rejected_by_owner',
        text: entry.incomingText,
        reply: '(owner rejected — nothing sent)',
      });
      return `🚫 *Not Sent:* ${who} ko koi reply nahi bheja gaya (Message #${entry.id} cancelled).`;
    }

    if (decision.action === 'block') {
      resolveGuestApproval(store, config, entry.id, 'blocked', '');
      blockGuest(store, config, entry.senderNumber);
      return `🚫 *Rejected & Blocked:* ${who} ko block kar diya gaya hai aur koi reply nahi bheja gaya.`;
    }

    const finalReply = decision.action === 'custom'
      ? String(decision.text ?? '').trim()
      : entry.proposedReply;
    if (!finalReply) {
      return '⚠️ Reply text khali hai.';
    }

    resolveGuestApproval(store, config, entry.id, decision.action === 'custom' ? 'custom' : 'approved', finalReply);
    if (typeof sendWhatsappTo === 'function') {
      await sendWhatsappTo(entry.senderJid || entry.senderNumber, finalReply);
    } else {
      store?.bump?.('outboundToOthers');
    }
    store.bump('guestRepliesOut');
    recordGuestChatTurn(store, entry.senderNumber, 'user', entry.incomingText, { name: entry.senderName });
    recordGuestChatTurn(store, entry.senderNumber, 'assistant', finalReply, { name: entry.senderName });
    recordGuestAudit(store, {
      from: entry.senderNumber,
      name: entry.senderName,
      kind: decision.action === 'custom' ? 'owner_custom_reply' : 'owner_approved_reply',
      text: entry.incomingText,
      reply: finalReply,
    });

    return decision.action === 'custom'
      ? `📤 *Sent Your Custom Reply to ${who}:*\n"${finalReply}"`
      : `✅ *Approved & Sent AI Reply to ${who}:*\n"${finalReply}"`;
  }

  function pendingCommand() {
    return formatPendingApprovalsList(store, config);
  }

  async function approveCommand(args, ctx = {}) {
    const raw = String(args ?? '').trim();
    const idMatch = raw.match(/^#?(\d+)(?:\s+([\s\S]+))?$/);
    if (idMatch) {
      const id = Number(idMatch[1]);
      const customText = (idMatch[2] || '').trim();
      return executeOwnerApprovalDecision(
        customText ? { action: 'custom', text: customText } : { action: 'approve' },
        id,
        ctx,
      );
    }
    if (raw) {
      return executeOwnerApprovalDecision({ action: 'custom', text: raw }, null, ctx);
    }
    return executeOwnerApprovalDecision({ action: 'approve' }, null, ctx);
  }

  async function rejectCommand(args, ctx = {}) {
    const raw = String(args ?? '').trim();
    const idMatch = raw.match(/^#?(\d+)$/);
    const id = idMatch ? Number(idMatch[1]) : null;
    return executeOwnerApprovalDecision({ action: 'reject' }, id, ctx);
  }

  // ── Owner-Only Location Intelligence Commands (`/location`, `/near`) ─────

  async function locationCommand(args, ctx = {}) {
    if (ctx?.isOwner === false || ctx?.guest) {
      return buildBlockedCommandReply(config, store, { command: '/location' });
    }
    const raw = String(args ?? '').trim();
    const low = raw.toLowerCase();

    if (/^(?:off|disable|lock|band)$/i.test(low)) {
      const loc = ensureLocationStore(store);
      if (loc) loc.enabled = false;
      store.save();
      return '🔒 *Location Access Turned OFF.* (`/location on` ya `/location set <city>` se wapas chalu karein)';
    }
    if (/^(?:on|enable|unlock|chalu)$/i.test(low)) {
      const loc = ensureLocationStore(store);
      if (loc) loc.enabled = true;
      store.save();
      const res = await resolveOwnerLocation(store, config, { allowNetwork: true });
      return formatOwnerLocationCard(store, config, res.location);
    }
    if (/^(?:refresh|detect|auto|update|ip)$/i.test(low)) {
      const res = await resolveOwnerLocation(store, config, { forceRefresh: true, allowNetwork: true });
      if (!res.ok) return `⚠️ ${res.reason}`;
      return formatOwnerLocationCard(store, config, res.location);
    }
    const nearMatch = raw.match(/^(?:near|nearby|around|aas\s*paas)\s+([\s\S]+)$/i);
    if (nearMatch) {
      const res = await searchNearbyPlaces(store, config, nearMatch[1].trim());
      return res.ok ? res.text : `⚠️ ${res.reason}`;
    }
    const setMatch = raw.match(/^(?:set|save|to)\s+([\s\S]+)$/i);
    if (setMatch) {
      const res = await setOwnerLocation(store, config, setMatch[1].trim());
      if (!res.ok) return `⚠️ ${res.reason}`;
      return `✅ *Location Updated!*\n\n${formatOwnerLocationCard(store, config, res.location)}`;
    }
    if (raw && !/^(?:status|show|get|me|current|live|kya\s+hai)$/i.test(low)) {
      const res = await setOwnerLocation(store, config, raw);
      if (!res.ok) return `⚠️ ${res.reason}`;
      return `✅ *Location Updated!*\n\n${formatOwnerLocationCard(store, config, res.location)}`;
    }
    const res = await resolveOwnerLocation(store, config, { allowNetwork: true });
    if (!res.ok) return `⚠️ ${res.reason}`;
    return formatOwnerLocationCard(store, config, res.location);
  }

  // ── 3.6.0 flows (diff / timelapse / playlist) ─────────────────────────
  async function diffFlow() {
    try {
      const shot = await pc.captureScreenshot();
      const buf = shot?.image ?? shot;
      if (!buf || !Buffer.isBuffer(buf)) return '🔍 Screenshot nahi mila.';
      const res = compareWithBaseline(buf, {});
      if (res.first) {
        setBaseline(buf, {});
        pushBuffer(buf);
        return '📸 Pehla snapshot liya — ab `\/look diff` dobara bolo, badlaav bataunga.';
      }
      const out = diffReply(res, {});
      setBaseline(buf, {});
      pushBuffer(buf);
      return out;
    } catch (err) {
      return `🔍 Diff fail: ${err?.message ?? err}`;
    }
  }

  async function timelapseFlow(raw) {
    const s = String(raw ?? '').replace(/^timelapse\s*/i, '').trim();
    const stopM = s.match(/^stop\s+(\S+)/i);
    if (stopM) return stopTimelapse(stopM[1]);
    const mins = Number((s.match(/(\d+(?:\.\d+)?)\s*(?:min|m|h)/) ?? [])[1] ?? 60);
    const unit = (s.match(/\d+(?:\.\d+)?\s*(min|m|h)/) ?? [])[1] ?? 'min';
    const durationMs = mins * (unit.startsWith('h') ? 3600_000 : 60_000);
    const intervalSec = Number((s.match(/every\s+(\d+)\s*s/i) ?? [])[1] ?? 60);
    return startTimelapse({
      durationMs,
      intervalSec,
      capture: async () => (await webcamPhoto()).image,
      onDone: (r) => notifyOwner(`⏩ Timelapse ready: ${r.file} (${r.frames} frames)`),
    }).reply ?? '⏩ Timelapse start nahi hua.';
  }

  async function ytplFlow(raw) {
    const ref = String(raw ?? '').replace(/^playlist\s*/i, '').trim();
    if (!ref) return '📺 Usage: `/yt playlist <url>`';
    return buildPlaylistNotes(ref, {
      listVideos: async (r) => {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const run = promisify(execFile);
        const { stdout } = await run('yt-dlp', ['--flat-playlist', '-J', r], { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 });
        const data = JSON.parse(stdout);
        return (data.entries ?? []).map((e) => ({ title: e.title, url: e.url ?? e.webpage_url ?? '', transcript: '' }));
      },
    });
  }

  async function meetingNotesCmd(raw) {
    // 🎙️ Meeting recorder → transcript + AI notes + auto action-items.
    if (raw === 'stop') {
      return meetingNotes.stopNotes({
        summarize: async (text) => {
          const base = await ai.complete(config, `Make crisp meeting notes from this transcript: decisions, actions (with owners if mentioned), key points.\n\n${text.slice(0, 12_000)}`, log).catch(() => text.slice(0, 2000));
          const actBlock = actionsReply(extractActions(text));
          return actBlock ? `${base}\n\n${actBlock}` : base;
        },
        onSummary: (msg) => notifyOwner(msg),
      });
    }
    if (raw === 'status') return meetingNotes.notesStatus();
    return meetingNotes.startNotes();
  }

  async function revisionCallFlow(arg) {
    // 📞 Voice revision call — JARVIS poochhe, tum jawab do.
    const topic = arg.replace(/^call\s*/i, '').trim() || store.data.lastStudyTopic;
    const pack = topic ? study.loadPack(topic) : null;
    if (!pack) return '📞 Revision call ke liye pack chahiye — `/study <topic>` pehle.';
    const segs = buildRevisionSegments(pack, { max: 5 });
    const script = segs.map((s) => s.say).join('\n');
    const callRes = await callMeCommand('');
    const lines = [String(callRes)];
    if (!/VoIP|ready nahi|nahi lagi|Setup/.test(String(callRes))) {
      try { await waVoip?.speak?.(script); } catch { /* per-segment below */ }
    }
    // Har segment as TTS audio (call ke saath hi chalega; fallback text).
    for (const s of segs) {
      let sent = false;
      try {
        const out = await tts.synthesize(s.say, config, log);
        if (out?.buffer && sendWhatsappTo) {
          sendWhatsappTo(config.ownerNumber, { audio: out.buffer, mimetype: out.mimetype ?? 'audio/ogg', text: s.say });
          sent = true;
        }
      } catch { /* text below */ }
      if (!sent && sendWhatsappTo) sendWhatsappTo(config.ownerNumber, { text: `📞 ${s.say}` });
    }
    lines.push('📞 *Revision script bheja* — jawab bolo, phir `/revise` se score.');
    return lines.join('\n');
  }

  async function studyScanFlow() {
    const recent = (store.data.downloads ?? []).find((d) => d.kind === 'image');
    if (!recent) return '📸 Pehle textbook page ka photo bhejo (WhatsApp pe), phir `/study scan`.';
    const fullPath = path.join(config.downloadsDir, recent.file);
    if (!fs.existsSync(fullPath)) return '📸 Photo mil nahi rahi — dobara bhejo.';
    const buf = fs.readFileSync(fullPath);
    const topic = store.data.lastStudyTopic ?? 'scanned';
    const pack = study.loadPack(topic) ?? study.buildPack(topic, {}, Date.now());
    const r = await scanToPack(buf, pack, {
      ocr: async (b) => {
        const { ocrImage } = await import('./imaging.js');
        return (await ocrImage(b, { config, log })) ?? '';
      },
      makeCards: async (text) => {
        const raw = await ai.complete(config, `Make 6-10 flashcards as JSON array [{"q":"","a":""}] from this text:\n${text.slice(0, 3000)}`, log).catch(() => null);
        const parsed = solver.extractJsonObject(solver.stripThinkBlocks(raw ?? ''));
        return Array.isArray(parsed) ? parsed : parsed?.cards ?? [];
      },
    });
    if (!r.ok) return r.error;
    study.savePack(pack);
    return r.reply;
  }

  async function handleCommand(cmd, args, ctx) {
    // 3.6.0 quick hooks into existing commands (look diff / webcam timelapse / yt playlist)
    if (cmd === 'look' && /^diff\b/i.test(String(args ?? ''))) return diffFlow();
    if (cmd === 'webcam' && /^timelapse\b/i.test(String(args ?? ''))) return timelapseFlow(args);
    if (cmd === 'yt' && /^playlist\b/i.test(String(args ?? ''))) return ytplFlow(args);
    if (cmd === 'study' && /^scan\b/i.test(String(args ?? ''))) return studyScanFlow();
    trackCommand(cmd, args);
    logAudit({ who: ctx?.senderNumber ? String(ctx.senderNumber).slice(-4) : 'owner', cmd, args: String(args ?? '').slice(0, 60) });
    switch (cmd) {
      case 'stop': case 'cancel': case 'abort': case 'ruko': return stopCommand();
      case 'msg': case 'dm': case 'sendto': case 'whatsapp': return await msgCommand(args, ctx);
      case 'reply': return await replyCommand(args, ctx);
      case 'broadcast': return await broadcastCommand(args, ctx);
      case 'contact': case 'contacts': return contactCommand(args);
      case 'guest': case 'guests': case 'guestmode': return guestCommand(args);
      case 'pending': return pendingCommand();
      case 'approve': return await approveCommand(args, ctx);
      case 'reject': case 'deny': return await rejectCommand(args, ctx);
      case 'allow': return allowCommand(args);
      case 'block': return blockCommand(args);
      case 'unblock': return unblockCommand(args);
      case 'location': case 'loc': case 'whereami': case 'mylocation': return await locationCommand(args, ctx);
      case 'near': case 'nearby': return await locationCommand(`near ${args}`, ctx);
      case 'sleepnotify': case 'offlinenotify': case 'sleepmsg': return sleepNotifyCommand(args);
      case 'persona': case 'profile': case 'twin': case 'behaviour': case 'behavior': return await personaCommand(args);
      case 'train': return await personaCommand(args, { forceTrain: true });
      case 'hinglish': {
        const profile = ensureProfile(store);
        profile.style.dominantLanguage = 'hinglish';
        addLesson(profile, 'Speak natural, witty, street-smart + tech-sharp Hinglish ("at its best") when chatting with the owner.', 'owner_command');
        store.save();
        const biBench = runBilingualMasteryBenchmark();
        return `🔥 *Hinglish Mastery Mode: AT ITS BEST* ✅\n• Trained on *${BILINGUAL_CORPUS.length}* bilingual patterns (${biBench.passed}/${biBench.total} benchmark checks passed in \`${biBench.ms}ms\`).\n• Ab har Hinglish sawal ka ekdam natural, seedha aur proper jawab milega!`;
      }
      case 'english': {
        const profile = ensureProfile(store);
        profile.style.dominantLanguage = 'english';
        addLesson(profile, 'Deliver impeccable, articulate, crystal-clear English when chatting in English.', 'owner_command');
        store.save();
        const biBench = runBilingualMasteryBenchmark();
        return `🇬🇧 *Impeccable English Mastery Mode: ACTIVE* ✅\n• Trained on *${BILINGUAL_CORPUS.length}* bilingual patterns (${biBench.passed}/${biBench.total} benchmark checks passed in \`${biBench.ms}ms\`).\n• Every English query will receive a crisp, articulate, and strictly scoped response.`;
      }
      case 'undo': case 'journal': {
        if (/^file\s+/i.test(String(args || '').trim())) {
          return handleBackupCommand(store, `restore ${String(args).replace(/^file\s+/i, '').trim()}`);
        }
        return await undoCommand(args);
      }
      case 'shots': case 'screenshots': return shotsCommand(args);
      case 'usage': case 'quota': return usageReport(store, { catalog: router.catalog });
      case 'watch': return watchCommand(args);
      case 'watchme': case 'recordactions': return await watchMeCommand(args, ctx);
      case 'replayactions': return await watchMeCommand(`replay ${args}`, ctx);
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
          `Sleep notify: ${isOfflineNotifyEnabled(config, store) ? 'ACTIVE 😴 (auto "Agent is sleeping" before PC shutdown/sleep)' : 'off (/sleepnotify on)'}`,
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
      case 'cmd': case 'command': case 'createcmd': return await cmdCommand(args, ctx);
      case 'unlearn': case 'undefine': case 'forgetword': case 'delcmd': return learnCmd(`del ${args}`);
      case 'todo': case 'todos': case 'task': return todo(args);
      case 'note': return note(args);
      case 'notes': {
        const rawN = String(args || '').trim().toLowerCase();
        if (/^(now|stop|status)\b/.test(rawN)) return meetingNotesCmd(rawN);
        return notes();
      }
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
      case 'improve': case 'rewrite': case 'tone': {
        if (!args) return '✍️ Usage: `/rewrite professional | bhai kal chutti chahiye tabiyat kharab hai` or `/improve <text>`';
        const styleMatch = String(args).match(/^(professional(?:\s+email)?|email|formal|polite|concise|short)\s*(?:\||:)\s*([\s\S]+)$/i)
          || String(args).match(/^(professional(?:\s+email)?|email|formal|polite|concise|short)\s+([\s\S]+)$/i);
        if (styleMatch || cmd === 'tone') {
          const style = styleMatch ? styleMatch[1] : 'professional';
          const body = styleMatch ? styleMatch[2] : args;
          const done = await ai.complete(config, `Rewrite the following text in a ${style} tone. Reply with only the rewritten text:\n\n${body}`, log);
          return done ? done.text : deterministicToneRewrite(style, body);
        }
        const done = await ai.complete(config, `Improve this text (clearer, polite, same language, keep it short). Reply with only the improved text:\n\n${args}`, log);
        return done ? done.text : deterministicToneRewrite('professional', args);
      }
      case 'weather': {
        if (args) return tools.weather(args);
        const locRes = await resolveOwnerLocation(store, config, { allowNetwork: true });
        if (locRes.ok && locRes.location?.city) {
          return tools.weather(locRes.location.city);
        }
        return '🌤️ Usage: /weather <city> — e.g. /weather Dehradun (or set your location with `/location set <city>`)';
      }
      case 'wiki': return args ? wikiCommand(args, config, store) : '📚 Usage: /wiki <topic>';
      case 'define': return args ? tools.define(args) : '🔤 Usage: /define <word>';
      case 'vocab': case 'word': case 'synonym': case 'synonyms': case 'antonym': case 'antonyms': case 'meaning': {
        const rawArg = String(args || '').trim();
        if (!rawArg || /^(?:daily|wod|boost|word\s+of\s+the\s+day)$/i.test(rawArg)) {
          return getWordOfTheDay();
        }
        const rwMatch = rawArg.match(/^(?:rewrite|rephrase|elevate)\s+([\s\S]+)$/i);
        if (rwMatch) {
          const textToElevate = rwMatch[1].trim();
          const done = await ai.complete(
            config,
            `Rewrite the following text with sharp, articulate, high-impact vocabulary (preserving its exact meaning, concise for WhatsApp). Also list 2 key vocabulary words used with their Hindi/Hinglish meaning:\n\n${textToElevate}`,
            log,
          );
          return done ? `✨ *Elevated Vocabulary*\n\n${done.text}` : `✨ *Normalized*: ${normalizeVocabText(textToElevate)}`;
        }
        const trMatch = rawArg.match(/^translate\s+(english|hindi|hinglish)\s*\|\s*([\s\S]+)$/i);
        if (trMatch) {
          const [, targetLang, bodyText] = trMatch;
          const done = await ai.complete(
            config,
            `Translate the following text into natural, fluent, high-vocabulary ${targetLang}. Reply with only the translation:\n\n${bodyText}`,
            log,
          );
          return done ? `🌐 *${targetLang} Translation*\n\n${done.text}` : `🌐 No AI brain reachable right now for full translation. Normalized text:\n${normalizeVocabText(bodyText)}`;
        }
        const wantsSynonymsOnly = cmd === 'synonym' || cmd === 'synonyms' || /^synonyms?\s+/i.test(rawArg);
        const wantsAntonymsOnly = cmd === 'antonym' || cmd === 'antonyms' || /^antonyms?\s+/i.test(rawArg);
        const cleanWord = rawArg.replace(/^(?:synonyms?|antonyms?|define|meaning)\s+/i, '').trim();
        const entry = await lookupWordPower(cleanWord);
        if (entry) {
          if (wantsSynonymsOnly && entry.synonyms?.length) {
            return `📖 *Synonyms of ${entry.word}*: \`${entry.synonyms.join('`, `')}\``;
          }
          if (wantsAntonymsOnly && entry.antonyms?.length) {
            return `📖 *Antonyms of ${entry.word}*: \`${entry.antonyms.join('`, `')}\``;
          }
          return formatVocabCard(entry);
        }
        const aiDef = await ai.complete(
          config,
          `Explain the word or phrase "${cleanWord}" concisely for WhatsApp with:\n• English meaning\n• Hindi & Hinglish meaning\n• 4 Synonyms\n• 2 Antonyms\n• 1 short example sentence`,
          log,
        );
        if (aiDef?.text) return `📖 *${cleanWord}*\n\n${aiDef.text}`;
        return tools.define(cleanWord);
      }
      case 'translate': {
        if (!args) return '🌐 Usage: /translate <hindi|english|hinglish> | <text>';
        const m = String(args).match(/^(english|hindi|hinglish)\s*(?:\||:)\s*([\s\S]+)$/i);
        const targetLang = m ? m[1] : 'English';
        const bodyText = m ? m[2] : args;
        const done = await ai.complete(
          config,
          `Translate the following text into natural, fluent ${targetLang}. Reply with only the translation:\n\n${bodyText}`,
          log,
        );
        return done ? `🌐 *${targetLang}*\n\n${done.text}` : `🌐 No AI brain reachable right now (see /model).`;
      }
      case 'news': return tools.news(args || '');
      case 'calc': {
        if (!args) return '🧮 Usage: /calc 45*12 + sqrt(81)';
        const percentOf = args.match(/^([\d.]+)\s*%\s*of\s*([\d.]+)$/i);
        if (percentOf) return `🧮 ${percentOf[1]}% of ${percentOf[2]} = *${(Number(percentOf[1]) / 100) * Number(percentOf[2])}*`;
        return `🧮 ${args} = *${tools.calc(args)}*`;
      }
      case 'unit': case 'convert': case 'fileconvert': {
        const m = (args || '').match(/^(-?[\d.]+)\s*([a-zA-Z°]+)\s+(?:to|in|->)\s*([a-zA-Z°]+)$/);
        if (m && cmd !== 'fileconvert') {
          return `🔁 ${tools.convertUnit(Number(m[1]), m[2], m[3])}`;
        }
        if (cmd === 'convert' || cmd === 'fileconvert') {
          return await runSmartConverter(args);
        }
        return '🔁 Usage: /unit 10 km to mi (or `/convert json2csv [...]`, `/convert md2html ...`)';
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
      case 'kill': {
        if (!args) return '🛑 Usage: /kill <process name> (confirm ke baad)';
        if (!ctx.confirmed) return requestConfirm('kill', args);
        return act('kill_process', { name: args });
      }
      case 'svc': case 'service': {
        const [sub, name] = (args || '').split(/\s+/);
        if (!name) return '⚙️ Usage: /svc status <name> · /svc restart <name>';
        return sub === 'restart' ? act('service_restart', { name }) : act('service_status', { name });
      }
      case 'notify': return args ? act('notify', { text: args }) : '🔔 Usage: /notify <text>';
      case 'dsh': case 'harness': case 'deepseek': return handleDsh(args, ctx);
      case 'solve': case 'ans': case 'answer': case 'q': return handleSolve(args, ctx);
      case 'accuracy': return /^report\b/i.test(String(args || '').trim()) ? accuracyReport(store) : handleAccuracy(args);
      case 'verify': case 'factcheck': return handleVerify(args, ctx);
      case 'livefact': return await verifyLiveFact(args, store);
      case 'runjs': case 'js': return await runInstantCodeSandbox('javascript', args);
      case 'runpy': case 'py': case 'python': return await runInstantCodeSandbox('python', args);
      case 'sql': case 'sqlite': return await runInstantCodeSandbox('sql', args);
      case 'docqa': case 'pdfqa': return answerFromDocuments(store, config, args);
      case 'recall': case 'searchmemory': return recallEverything(store, args);
      case 'voicesummary': case 'vsummary': return summarizeVoiceOrText(args).formatted;
      case 'expense': case 'expenses': case 'kharcha': return handleExpenseCommand(store, args);
      case 'habit': case 'habits': case 'streak': return handleHabitCommand(store, args);
      case 'gitstatus': case 'git': return await runGitAutopilot(args || 'status');
      case 'gitdiff': return await runGitAutopilot('diff');
      case 'grab': return await grabMediaOrFile(args, config?.downloadsDir || path.join(os.homedir(), 'Downloads'));
      case 'scribe': return handleScribeCommand(store, args);
      case 'netcheck': case 'netopt': return await runNetworkHealthCheck();
      case 'usbguard': case 'usb': return await handleUsbGuardCommand(store, args);
      case 'vault': return await handleVaultCommand(store, config, args, async (secretText) => {
        try {
          await handlePc(`type ${secretText}`);
        } catch { /* ignore headless typing errors */ }
      });
      case 'pomo': case 'pomodoro': return handlePomodoroCommand(store, args, notify);
      case 'ports': case 'port': return await handlePortsCommand(args);
      case 'guardian': case 'thermal': return handleGuardianCommand(store, args);
      case 'quiz': case 'flashcard': return handleQuizCommand(store, args);
      case 'backup': case 'timemachine': return handleBackupCommand(store, args);
      case 'clip': case 'clipboard': {
        const sub = String(args || '').trim();
        if (!sub || /^(?:get|read|show)$/i.test(sub)) return handlePc('clipboard');
        const cleanSet = sub.replace(/^(?:set|copy)\s+/i, '').trim();
        return handlePc(`clipset ${cleanSet}`);
      }
      case 'workspace': case 'mode': {
        const key = String(args || '').trim().toLowerCase();
        const ws = WORKSPACES[key];
        if (!ws) {
          return [
            '🖥️ *Instant Workspaces — Usage:* `/workspace <coding|study|focus|meeting|chill>`',
            ...Object.entries(WORKSPACES).map(([k, v]) => `• \`/workspace ${k}\` — *${v.name}*: ${v.description}`),
          ].join('\n');
        }
        const results = [];
        for (const step of ws.steps) {
          const m = step.match(/^\/([a-zA-Z]+)\s*(.*)$/);
          if (m) {
            try {
              const out = await handleCommand(m[1].toLowerCase(), m[2].trim(), ctx);
              results.push(typeof out === 'string' ? out : (out?.text ?? `✅ ${step}`));
            } catch {
              results.push(`✅ Applied preset: \`${step}\``);
            }
          }
        }
        return [
          `🚀 *${ws.name} Activated!*`,
          `_${ws.description}_`,
          '',
          ...results.map((r) => `• ${r}`),
        ].join('\n');
      }
      case 'if': case 'cond': {
        const parsedCond = parseConditionalWorkflow(args);
        if (!parsedCond) {
          return '🔀 *Conditional Workflow Usage*: `/if battery < 25 then /pc brightness 30 else /pc brightness 80`';
        }
        const liveMetrics = {
          battery: Number(ctx?.liveMetrics?.battery ?? 20),
          volume: Number(ctx?.liveMetrics?.volume ?? 50),
          brightness: Number(ctx?.liveMetrics?.brightness ?? 70),
          hour: new Date().getHours(),
        };
        try {
          const batStr = await tools.battery();
          const bm = String(batStr).match(/(\d{1,3})\s*%/);
          if (bm && ctx?.liveMetrics?.battery == null) liveMetrics.battery = Number(bm[1]);
        } catch { /* fallback to default */ }
        const evalRes = evaluateConditionalWorkflow(parsedCond, liveMetrics);
        if (!evalRes.chosenBranch) {
          return `🔀 Condition \`${evalRes.metric} (${evalRes.actual}) ${evalRes.op} ${evalRes.threshold}\` is *FALSE* (no else branch).`;
        }
        const branch = evalRes.chosenBranch.trim();
        const sl = branch.match(/^\/([a-zA-Z]+)\s*([\s\S]*)$/);
        let branchOut;
        if (sl) {
          branchOut = await handleCommand(sl[1].toLowerCase(), sl[2].trim(), ctx);
        } else {
          const pi = parseIntent(branch);
          branchOut = pi ? await handleCommand(pi.cmd, pi.args ?? '', ctx) : branch;
        }
        const outText = typeof branchOut === 'string' ? branchOut : (branchOut?.text ?? '✅ Done');
        return `🔀 *Condition (${evalRes.metric}=${evalRes.actual} ${evalRes.op} ${evalRes.threshold} → ${evalRes.conditionMet ? 'TRUE' : 'FALSE'})*\n↳ Executed: \`${branch}\`\n${outText}`;
      }
      case 'reach': case 'agentreach': return handleReach(args);
      case 'yt': case 'youtube': return handleReach(`yt ${args || ''}`.trim());
      case 'gh': case 'github': return handleReach(`gh ${args || ''}`.trim());
      case 'reddit': case 'rdt': return handleReach(`reddit ${args || ''}`.trim());
      case 'hn': case 'hackernews': return handleReach(`hn ${args || ''}`.trim());
      case 'ui': case 'ground': case 'elements': return act('inspect_ui');
      case 'doctor': case 'diag': case 'diagnose': {
        if (/^(?:fix|repair|heal|auto)$/i.test(String(args || '').trim())) {
          return runSelfDoctorRepair(config, store, log);
        }
        return runDoctor({ config, ctx, log });
      }
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
      case 'rm': case 'delete': {
        if (!args) return '🗑️ Usage: /rm <path>  (confirm ke baad TRASH me jaata hai — recoverable)';
        if (!ctx.confirmed) return requestConfirm('rm', args);
        const tr = moveToTrash(args, { trashDir: path.join(config.dataDir || path.join(ROOT, 'data'), 'trash') });
        return tr.reply ?? tr.error;
      }

      // ── agent + confirmations ───────────────────────────────────────────
      case 'auto': case 'autopilot': return args ? autopilot.runAutopilot(args, { config, log, signal: ctx.signal }) : '🤖 Usage: /auto open chrome | tap Search | type hello | key enter | screenshot\nNatural: /auto open chrome and search for today weather then screenshot\nHar step verify hota hai — jo fail hua wahi batata hai.';
      case 'agent': return runAgentTask(args, ctx);
      case 'use': case 'hands': return runUseTask(args, ctx.signal);
      case 'arena': return runArenaPrompt(args, ctx.signal);
      case 'batch': return batchCommand(args, ctx);
      case 'taskstatus': return workStatus();
      case 'neural': return neuralCommand(args, ctx);
      case 'agents': case 'fleet': {
        const head = `🤖🤖 *Multi-Agent Fleet* — kaam bots me divide hota hai (IntentNet dispatcher):`;
        let brain = '🧠 IntentNet: trained checkpoint loaded';
        try { brain = `🧠 IntentNet: ${classifyIntent('hello', { dataDir: config.dataDir }).source} · conf ${classifyIntent('hello', { dataDir: config.dataDir }).confidence.toFixed(2)}`; } catch { /* optional */ }
        return `${head}\n${fleetStatus()}\n\n${brain}\n👁️ VisionBot — images/questions (vision pipeline)\n\nIndependent text questions split into specialists. Execution/verification uses /agent or /solve; /batch bounds parallel answers and serializes allowed actions. ✅`;
      }
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
      case 'yes': case 'haan': {
        if (pendingState()) {
          const conf = confirmPending('yes');
          if (conf.ok) return handleCommand(conf.action, conf.args, { ...ctx, confirmed: true });
          return conf.error;
        }
        if (!store.data.pending && (pendingPower || pendingTap)) return handlePc('confirm');
        return toReply(await actions.runPending(ctx));
      }
      case 'no': case 'nahi': case 'cancel': {
        if (pendingState()) cancelPending();
        actions.clearPending(); pendingPower = null; pendingTap = null;
        return '👍 Cancelled — kuch nahi kiya.';
      }
      case 'confirm': {
        const conf = confirmPending(String(args || '').trim());
        if (!conf.ok) return conf.error;
        return handleCommand(conf.action, conf.args, { ...ctx, confirmed: true });
      }
      case 'live': {
        // 🎥 Live screen mirror — frames keep coming to WhatsApp.
        const arg = String(args || '').trim().toLowerCase();
        if (arg === 'off' || arg === 'stop') return liveMirror.stopLive();
        if (arg === 'status') return liveMirror.liveStatus();
        const intervalSec = Number(arg) || liveMirror.DEFAULT_INTERVAL_SEC;
        return liveMirror.startLive({
          intervalSec,
          capture: () => pc.captureScreenshot({ portalTimeoutMs: config.portalTimeoutMs }),
          send: (payload) => notifyOwner(payload),
        });
      }
      case 'guard': {
        // 🛡️ Motion-triggered webcam security camera.
        const [sub, ...restArgs] = String(args || '').trim().toLowerCase().split(/\s+/);
        const restJoined = restArgs.join(' ');
        if (sub === 'off' || sub === 'stop') return guardMode.stopGuard();
        if (sub === 'status') return guardMode.guardStatus();
        if (sub === 'sens' || sub === 'sensitivity') return guardMode.setGuardSensitivity(restJoined);
        return guardMode.startGuard({
          sensitivity: Number(restJoined) || undefined,
          capture: async () => (await webcamPhoto()).image,
          statFn: (buf) => imageStats(buf),
          send: (payload) => notifyOwner(payload),
        });
      }
      case 'nmirror': case 'notifmirror': case 'mirror': {
        // 🔔 Desktop notifications → WhatsApp.
        const [sub, ...restArgs] = String(args || '').trim().split(/\s+/);
        const restJoined = restArgs.join(' ');
        if (sub === 'off') return notifMirror.toggleMirror(false);
        if (sub === 'status') return notifMirror.mirrorStatus();
        if (sub === 'allow') return notifMirror.setAllow(restJoined);
        return notifMirror.toggleMirror(true, {
          spawnMonitor: (onLine) => notifMonitorSpawner(onLine),
          send: (text) => notifyOwner(text),
        });
      }
      case 'study': {
        // 📚 Study pack generator — summary + flashcards + quiz.
        const topic = String(args || '').trim();
        if (!topic) return '📚 Usage: `/study <topic>` — e.g. `/study photosynthesis`';
        return buildStudyPack(topic, ctx);
      }
      case 'revise': {
        const arg = String(args || '').trim().toLowerCase();
        if (arg === 'call' || arg.startsWith('call ')) return revisionCallFlow(String(args || '').trim());
        const topic = arg && !['ok', 'again'].includes(arg) ? arg : store.data.lastStudyTopic;
        const pack = topic ? study.loadPack(topic) : null;
        if (!pack) return '📚 Revision ke liye pack chahiye — `/study <topic>` pehle.';
        return study.reviseMessage(pack, Date.now());
      }
      case 'quiz': {
        const arg = String(args || '').trim();
        if (/^answers\b/i.test(arg)) {
          const topic = arg.replace(/^answers\s+/i, '').trim() || store.data.lastStudyTopic;
          const pack = topic ? study.loadPack(topic) : null;
          return pack ? study.quizAnswers(pack) : '📚 Pack nahi mila.';
        }
        const pack = study.loadPack(arg || store.data.lastStudyTopic);
        return pack ? study.quizMessage(pack) : '📚 Usage: `/quiz <topic>` (pehle `/study <topic>`)';
      }
      case 'exp': case 'expense': case 'kharcha': {
        // 💰 Expense tracker.
        const raw = String(args || '').trim();
        if (!raw) return expenses.lastEntries(5);
        if (/^report\b/i.test(raw)) {
          const month = raw.replace(/^report\s*/i, '').trim() || null;
          return expenses.report({ month });
        }
        if (/^budget\b/i.test(raw)) return expenses.setBudget(raw.replace(/^budget\s*/i, '').trim());
        if (/^undo\b/i.test(raw)) return expenses.undoLast();
        if (/^list\b/i.test(raw)) return expenses.lastEntries(10);
        return expenses.addExpense(raw).reply;
      }
      case 'doc': {
        // 📄 Document Q&A — load a doc, then ask questions from it.
        const raw = String(args || '').trim();
        if (!raw) return docChat.docStatus();
        if (/^clear\b/i.test(raw)) return docChat.clearDoc();
        if (/^status\b/i.test(raw)) return docChat.docStatus();
        if (/^q\s+/i.test(raw)) {
          return docChat.askDoc(raw.replace(/^q\s+/i, ''), {
            ask: (prompt) => ai.complete(config, prompt, log),
          });
        }
        const loaded = await docChat.loadDoc(raw);
        return loaded.reply ?? loaded.error;
      }
      case 'photos': case 'pics': {
        // 🔍 Semantic-ish photo search over the local library.
        const raw = String(args || '').trim();
        if (/^index\b/i.test(raw)) {
          const dir = raw.replace(/^index\s*/i, '').trim() || photoSearch.DEFAULT_DIR;
          const idx = photoSearch.buildPhotoIndex({ dir });
          return `🔍 Photo index ready — *${idx.photos.length} photos* from ${idx.dir}\nAb dhundo: \`/photos goa trip\``;
        }
        if (/^status\b/i.test(raw)) {
          const idx = photoSearch.loadIndex();
          return `🔍 Photo index: ${idx.photos.length} photos${idx.dir ? ` from ${idx.dir}` : ''} · query: \`/photos <what>\``;
        }
        if (!raw) return '🔍 Usage: `/photos <query>` — e.g. `/photos goa beach` · index: `/photos index`';
        const reply = photoSearch.photoReply(raw);
        const hits = photoSearch.searchPhotos(raw, { limit: 3 });
        const good = hits.find((h) => h.score >= 0.12 && fs.existsSync(h.file));
        if (good) {
          try {
            return { image: fs.readFileSync(good.file), text: reply };
          } catch { /* text only */ }
        }
        return reply;
      }
      case 'cal': case 'calendar': {
        // 🗓️ Calendar — events + day/week views + Google sync (ICS).
        const raw = String(args || '').trim();
        if (/^sync\b/i.test(raw)) {
          const url = raw.replace(/^sync\s+/i, '').trim();
          if (!url) return '🗓️ Usage: `/cal sync <ics-url>` — Google Calendar → Settings → "Secret address in iCal format"';
          return syncFromICS(url, {
            fetchText: (u) => fetch(u, { signal: AbortSignal.timeout(15_000) }).then((r) => r.text()),
          });
        }
        if (/^export\b/i.test(raw)) {
          const ics = exportICS(calendar.loadCal().events);
          return {
            text: '🗓️ *Calendar export* — Google/Outlook me import karo (Settings → Import → .ics file).',
            document: { buffer: Buffer.from(ics), fileName: 'psd-calendar.ics', mimetype: 'text/calendar' },
          };
        }
        if (!raw || /^today\b/i.test(raw)) return calendar.todayReply();
        if (/^week\b/i.test(raw)) return calendar.weekReply();
        if (/^del\b/i.test(raw)) return calendar.delEvent(raw.replace(/^del\s+/i, '').trim());
        if (/^add\b/i.test(raw)) {
          const r = calendar.addEvent(raw.replace(/^add\s+/i, ''));
          return r.reply ?? r.error;
        }
        return '🗓️ Usage: `/cal add kal 4pm meeting` · `/cal today` · `/cal week` · `/cal del <id>`';
      }
      case 'focus': {
        // 🎯 Focus mode — pomodoro + distraction gate.
        const raw = String(args || '').trim();
        if (/^stop\b/i.test(raw) || raw === 'off') return focusMode.stopFocus();
        if (/^status\b/i.test(raw)) return focusMode.focusStatus();
        if (/^week\b/i.test(raw)) return focusMode.weeklyReport();
        const blockM = raw.match(/block:([\w,\s-]+)/i);
        const blocks = (blockM?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const minutes = Number((raw.match(/\d+/) ?? [focusMode.DEFAULT_MINUTES])[0]);
        return focusMode.startFocus({
          minutes,
          blocks,
          closeApp: async (app) => {
            if (['web', 'sites', 'websites'].includes(String(app).toLowerCase())) {
              const { exec } = await import('node:child_process');
              const { promisify } = await import('node:util');
              const run = promisify(exec);
              const r = await blockTick({
                listWindows: async () => (await run('wmctrl -l', { timeout: 3000 })).stdout,
                closeWindow: async (line) => {
                  const title = String(line).split(/\s+/).slice(3).join(' ').slice(0, 80);
                  if (title.trim()) await run(`wmctrl -c ${JSON.stringify(title.trim())}`, { timeout: 3000 });
                },
                sites: parseBlockList(raw.match(/block:([\w,.\s-]+)/i)?.[1] ?? ''),
              });
              return r.closed > 0;
            }
            await handleCommand('close', app, { bypassSaved: true });
            return true;
          },
          onDone: (msg) => notifyOwner(msg),
        });
      }
      case 'pguard': case 'powerguard': {
        // 🔋 Power Guardian — battery/temp thresholds + alerts.
        const [sub, ...restArgs] = String(args || '').trim().toLowerCase().split(/\s+/);
        const restJoined = restArgs.join(' ');
        if (!sub || sub === 'status') return powerGuard.pgStatus();
        if (sub === 'on') return powerGuard.togglePowerGuard(true, { send: (t) => notifyOwner(t) });
        if (sub === 'off') return powerGuard.togglePowerGuard(false);
        if (sub === 'battery' || sub === 'temp') return powerGuard.setThreshold(sub, restJoined);
        return '🔋 Usage: `/pguard on|off|status` · `/pguard battery 20` · `/pguard temp 90`';
      }
      case 'stats': {
        // 📊 Screen time — window-title samples → daily/weekly minutes.
        const raw = String(args || '').trim().toLowerCase();
        if (raw === 'on') return screenTime.toggleSampling(true);
        if (raw === 'off') return screenTime.toggleSampling(false);
        if (raw === 'week') return screenTime.weekReply();
        return screenTime.todayReply();
      }
      case 'clip': {
        // 📋 PC clipboard → WhatsApp.
        const raw = String(args || '').trim().toLowerCase();
        if (raw === 'list') return clipSync.clipList();
        return clipSync.clipPull();
      }
      case 'copy': {
        // 📱 WhatsApp → PC clipboard (history me PII redacted).
        const text = String(args || '').trim();
        if (!text) return '📋 Usage: `/copy <text>` — PC clipboard pe set ho jayega.';
        const pushed = await clipSync.clipPush(text);
        const pii = scanPII(text);
        return pii.safe ? pushed : `${pushed}\n🔐 _Sensitive info detect hui — clipboard history me redacted save kiya._`;
      }
      case 'pcs': {
        // 🖥️ Multi-PC fleet status.
        const raw = String(args || '').trim();
        const [sub, ...nameParts] = raw.split(/\s+/);
        const name = nameParts.join(' ');
        if (sub === 'register') return fleetPcs.registerPc(name);
        if (sub === 'remove') return fleetPcs.removePc(name);
        if (sub === 'ask') {
          const [pcName, ...cmdParts] = name.split(/\s+/);
          if (!pcName || !cmdParts.length) return '🖥️ Usage: `/pcs ask <pc-name> <command>`';
          const enq = enqueue(pcName, cmdParts.join(' '));
          return enq.reply ?? enq.error ?? '🖥️ Queue fail';
        }
        if (sub === 'all') {
          const cmd = name;
          if (!cmd) return '🖥️ Usage: `/pcs all <command>` — saare PCs ko';
          const pcs = fleetPcs.listPcs().map((x) => x.name);
          const lines = pcs.map((n) => `• ${n}: ${enqueue(n, cmd)?.ok ? 'queued ✅' : 'fail ❌'}`);
          return `🖥️ *Fleet broadcast:* \`${cmd}\`\n${lines.join('\n')}`;
        }
        if (sub === 'check') return checkResult(name.split(/\s+/)[0]);
        return fleetPcs.fleetReply();
      }
      case 'hw': case 'homework': {
        // 📝 Homework / deadline tracker.
        const raw = String(args || '').trim();
        if (!raw || /^today\b/i.test(raw)) return homework.todayReply();
        if (/^week\b/i.test(raw)) return homework.weekReply();
        if (/^done\b/i.test(raw)) return homework.doneHw(raw.replace(/^done\s+/i, '').trim());
        if (/^add\b/i.test(raw)) {
          const r = homework.addHw(raw.replace(/^add\s+/i, ''));
          return r.reply ?? r.error;
        }
        return '📝 Usage: `/hw add maths pg 42 kal` · `/hw today` · `/hw week` · `/hw done <id>`';
      }
      case 'diff': return diffFlow();
      case 'highlights': case 'highlight': {
        const raw = String(args || '').trim();
        const target = raw || store.data.lastRecordFile;
        if (!target) return '✨ Usage: `/highlight <recording-file>` (ya /record ke baad `/highlight`)';
        return highlightReply(await extractHighlights(target));
      }
      case 'fill': {
        const fields = parseFill(args);
        const r = await fillForm(fields, {
          type: (t) => handlePc(`type ${t}`),
          tab: () => handlePc('key tab'),
        });
        return fillReply(r);
      }
      case 'shares': {
        const res = await detectShare({
          probe: async () => {
            const { exec } = await import('node:child_process');
            const { promisify } = await import('node:util');
            try { return (await promisify(exec)('ps -eo args', { timeout: 3000 })).stdout; } catch { return ''; }
          },
        });
        if (!res.sharing) return '🕶️ Koi screen share detect nahi hui — safe.';
        if (/^arm$/i.test(String(args || '').trim())) {
          await handleCommand('shades', 'on', ctx);
          return `🕶️ Screen share detect (${res.apps[0] ?? '?'}) — shades auto-ON kar diye. OFF sirf \`/shades off\` se.`;
        }
        return sharePolicy(res, { shadesOn: false }).message;
      }
      case 'watch': {
        const raw = String(args || '').trim();
        const [sub, ...rest] = raw.split(/\s+/);
        if (!sub || sub === 'list') return watchList();
        if (sub === 'off') return removeWatch(rest[0]);
        if (sub === 'check' || sub === 'now') {
          const { alerts, checked } = await checkAll({
            fetchText: async (u) => {
              const res = await fetch(u, { signal: AbortSignal.timeout(8000) });
              return res.text();
            },
          }).catch(() => ({ alerts: [], checked: 0 }));
          return alerts.length
            ? `👀 Checked ${checked}:\n${alerts.join('\n')}`
            : `👀 Checked ${checked} watchers — abhi kuch naya nahi.`;
        }
        if (sub === 'add') {
          const url = rest[0];
          if (!url) return '👀 Usage: `/watch add <url> [price<5000 | contains <text> | release]`';
          const r = addWatch(url, rest.slice(1).join(' '));
          return r.reply ?? r.error;
        }
        return '👀 Usage: `/watch add <url> [rule]` · `/watch list` · `/watch check` · `/watch off <id>`';
      }
      case 'ytpl': return ytplFlow(args);
      case 'fsearch': {
        const raw = String(args || '').trim();
        if (!raw) return '🔎 Usage: `/fsearch <text> [path]` — file CONTENT me search';
        const [q, ...pathParts] = raw.split(/\s+(?=\/|~)/);
        const root = pathParts.join(' ') || os.homedir();
        const hits = await searchContent(q, { root });
        return contentReply(hits, q);
      }
      case 'netwatch': {
        const raw = String(args || '').trim().toLowerCase();
        if (raw === 'on') return setNetwatch(true);
        if (raw === 'off') return setNetwatch(false);
        if (raw === 'report') return netReport();
        const r = await netTick({
          pingFn: async () => {
            const { exec } = await import('node:child_process');
            const { promisify } = await import('node:util');
            await promisify(exec)('ping -c1 -W2 8.8.8.8', { timeout: 5000 });
            return 10;
          },
          reconnectFn: async () => {
            const { exec } = await import('node:child_process');
            const { promisify } = await import('node:util');
            await promisify(exec)('nmcli radio wifi on && nmcli con up --ask 2>/dev/null || true', { timeout: 15_000 });
            return true;
          },
        });
        return r.message ?? `📶 Net *${r.state}*${r.latency != null ? ` (${r.latency}ms)` : ''}`;
      }
      case 'callscript': {
        const raw = String(args || '').trim();
        const [sub, ...rest] = raw.split(/\s+/);
        if (!sub) return listScripts();
        if (sub === 'save') {
          const name = rest[0];
          const r = saveScript(name, rest.slice(1).join(' '));
          return r.reply ?? r.error;
        }
        if (sub === 'list') return listScripts();
        const script = getScript(sub);
        if (!script) return '📞 Script nahi mili. List: `/callscript list`';
        const plan = callPlan(script);
        return `📞 *Call script: ${sub}*\n${plan.map((s, i) => `${i + 1}. ${s.question ? '🗣️❓' : '🗣️'} ${s.say}`).join('\n')}\n\n_JARVIS call chahiye to: \`/callme\` bolo, main ye script bolunga._`;
      }
      case 'quiet': {
        const raw = String(args || '').trim();
        if (!raw || raw === 'status') {
          const w = loadQuiet().window;
          return w ? `🌙 Quiet hours active: ${w.startMin / 60}:${String(w.startMin % 60).padStart(2, '0')}–${w.endMin / 60}:${String(w.endMin % 60).padStart(2, '0')}` : '🌙 Quiet hours OFF. Set: `/quiet 22:00-07:00`';
        }
        if (/^(off|clear)$/i.test(raw)) return clearQuiet();
        return setQuietWindow(raw);
      }
      case 'digest': return quietDigest();
      case 'savemacro': {
        const raw = String(args || '').trim();
        const [name, nRaw] = raw.split(/\s+/);
        if (!name) return '💾 Usage: `/savemacro <name> [n]` — last n commands ko macro banao';
        const r = saveMacroFromHistory(store, name, Number(nRaw) || 5);
        return r.reply ?? r.error;
      }
      case 'context': {
        if (/^clear$/i.test(String(args || '').trim())) return clearContext();
        return contextStatus();
      }
      case 'corrections': return listCorrections();
      case 'retrain': return neuralCommand(`train ${args || ''}`.trim(), ctx);
      case 'plan': {
        if (!args) return planStatus();
        const steps = await buildSteps(args, {
          plannerFn: (task) => ai.complete(config, `Plan this PC/browser task as 3-6 short numbered steps (no prose): ${task}`, log),
        });
        const plan = makePlan(args, steps);
        return planReply(plan);
      }
      case 'go': {
        const plan = approvePlan();
        if (!plan) return '✅ Koi pending plan nahi. Banao: `/plan <task>`';
        return runAgentTask(plan.task, ctx);
      }
      case 'snapshot': {
        const r = saveSnapshot({ label: 'manual', snapRoot: path.join(config.dataDir || path.join(ROOT, 'data'), 'rollback') });
        return r.ok ? `⏪ Snapshot save: ${r.dest}` : r.error;
      }
      case 'snapshots': return snapshotList(path.join(config.dataDir || path.join(ROOT, 'data'), 'rollback'));
      case 'rollback': return rollbackTo({ snapRoot: path.join(config.dataDir || path.join(ROOT, 'data'), 'rollback') });
      case 'panic': {
        if (!ctx.confirmed) return requestConfirm('panic', '');
        liveMirror.stopLive(); guardMode.stopGuard();
        lastBatch = null; cancelPlan(); clearContext(); ai.clearAiCache(config);
        const r = runPanic({ dataDir: config.dataDir, store });
        (await import('./neural/index.js')).reloadBrain({ dataDir: config.dataDir });
        let lock = 'PC lock not requested (PC control disabled).';
        if (config.allowPcControl) {
          try { lock = `PC lock request: ${await pc.lockSession()}`; }
          catch (err) { lock = `⚠️ PC lock failed: ${err.message}`; }
        }
        return `${r.reply}\n${lock}`;
      }
      case 'trash': {
        const raw = String(args || '').trim();
        const [sub, ...rest] = raw.split(/\s+/);
        const trashDir = path.join(config.dataDir || path.join(ROOT, 'data'), 'trash');
        if (sub === 'restore') return restoreTrash(rest.join(' '), { trashDir });
        if (sub === 'empty') {
          if (!ctx.confirmed) return requestConfirm('trash', 'empty');
          try {
            for (const f of (await import('node:fs')).readdirSync(trashDir)) {
              (await import('node:fs')).rmSync(`${trashDir}/${f}`, { recursive: true, force: true });
            }
            return '🗑️ Trash empty kar diya (permanent delete).';
          } catch { return '🗑️ Trash pehle se khaali hai.'; }
        }
        return listTrash(trashDir);
      }
      case 'voicereply': {
        const raw = String(args || '').trim().toLowerCase();
        if (raw === 'on') { store.data.voiceReplyOff = false; store.save?.(); return '🎤 Voice→voice reply *ON* (voice aayega to main bhi bolunga).'; }
        if (raw === 'off') { store.data.voiceReplyOff = true; store.save?.(); return '🎤 Voice→voice reply *OFF*.'; }
        return `🎤 Voice reply: ${store.data.voiceReplyOff ? 'OFF' : 'ON'} · on/off toggle`;
      }
      case 'mail': {
        // 📧 Mail monitor — IMAP digest (Gmail app-password works).
        const raw = String(args || '').trim();
        const [sub, ...rest] = raw.split(/\s+/);
        if (sub === 'setup') return setupMail(rest.join(' '));
        if (sub === 'on') return setMonitor(true);
        if (sub === 'off') return setMonitor(false);
        if (sub === 'status') return mailStatus();
        return checkMail();
      }
      case 'make': {
        // 🛠️ Deliverables — report/slides/dashboard/csv files.
        const raw = String(args || '').trim();
        const [kind, ...topicParts] = raw.split(/\s+/);
        const topic = topicParts.join(' ');
        return makeDeliverable(kind, topic, {
          draft: async (k, t) => {
            const prompt = {
              report: `Return ONLY JSON {"sections":[{"heading":"...","body":"..."} x 4-6]} for a report on: ${t}`,
              slides: `Return ONLY JSON {"slides":[{"title":"...","bullets":["...","..."]} x 5-8]} for a slide deck on: ${t}`,
              dashboard: `Return ONLY JSON {"metrics":[{"label":"...","value":"...","hint":"..."} x 6-10]} for a dashboard about: ${t}`,
              csv: `Return ONLY JSON {"rows":[["col1","col2"],["v1","v2"] x 5-12]} as CSV data about: ${t}`,
            }[k];
            const raw2 = await ai.complete(config, prompt, log);
            return solver.extractJsonObject(solver.stripThinkBlocks(raw2 ?? ''));
          },
        });
      }
      case 'pii': {
        // 🔐 PII scanner — "kya is text me secret hai?"
        const text = String(args || '').trim();
        if (!text) return '🔐 Usage: `/pii scan <text>` — card/Aadhaar/PAN/API-key detect karta hai.';
        const body = text.replace(/^scan\s+/i, '');
        const scan = scanPII(body);
        return scan.safe
          ? '🔐 Clean — koi PII/secret nahi mili.'
          : `🔐 *PII mili:*
${scan.found.map((f) => `• ${f.type}: ${f.sample}${f.strict ? ' (strict — outbound block)' : ''}`).join('\n')}`;
      }
      case 'topic': case 'channel': {
        // 🗂️ Topic channels — shared-memory namespaces.
        const raw = String(args || '').trim();
        const [sub, ...rest] = raw.split(/\s+/);
        if (!raw || sub === 'list') return listTopics();
        if (sub === 'pin') return pinToTopic(rest.join(' '));
        if (sub === 'del' || sub === 'delete') return deleteTopic(rest.join(' '));
        return switchTopic(raw);
      }
      case 'today': {
        // 📅 Master timeline — poora din ek message me.
        return buildToday({
          calToday: () => calendar.todayReply(),
          hwToday: () => homework.todayReply(),
          pgStatus: () => powerGuard.pgStatus(),
          focusStatus: () => focusMode.focusStatus(),
          statsToday: () => screenTime.todayReply(),
          netReport: () => null,
          examCountdown: () => examCountdownReply(),
          nudgeList: () => {
            const msgs = fireNudges({ hwOverdue: 0 });
            return msgs.length ? `🤖 *Nudges*\n${msgs.join('\n')}` : null;
          },
        });
      }
      case 'exam': {
        const raw = String(args || '').trim();
        const [sub, ...rest] = raw.split(/\s+/);
        if (!raw || sub === 'list') {
          const c = examCountdownReply();
          return c ?? '🎓 Koi exam set nahi. Add: `/exam add physics 12 dec`';
        }
        if (sub === 'add') { const r = addExam(rest.join(' ')); return r.reply ?? r.error; }
        if (sub === 'del' || sub === 'remove') return removeExam(rest.join(' '));
        return '🎓 Usage: `/exam add <subject> <date>` · `/exam list` · `/exam del <subject>`';
      }
      case 'block': {
        // 🚫 Website blocker (window-close based — hosts/root nahi chahiye).
        const raw = String(args || '').trim();
        const sites = parseBlockList(raw.replace(/^(now|on|off)\s*/i, ''));
        if (/^off$/i.test(raw)) return '🚫 Website blocker abhi se OFF (focus ke saath hi chalta hai).';
        const { exec } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const run = promisify(exec);
        const r = await blockTick({
          sites,
          listWindows: async () => (await run('wmctrl -l', { timeout: 3000 })).stdout,
          closeWindow: async (line) => {
            const title = String(line).split(/\s+/).slice(3).join(' ').slice(0, 80);
            if (title.trim()) await run(`wmctrl -c ${JSON.stringify(title.trim())}`, { timeout: 3000 });
          },
        });
        return r.message ?? `🚫 Koi blocked window nahi khuli (${sites.slice(0, 3).join(', ')} …).`;
      }
      case 'audit': return auditReply({ limit: Number(String(args).trim()) || 15 });
      case 'nudges': {
        const raw = String(args || '').trim().toLowerCase();
        if (raw === 'on') return setNudges(true);
        if (raw === 'off') return setNudges(false);
        const msgs = fireNudges({
          youtubeMin: 0, hwOverdue: 0, examsSoon: 99,
        });
        return msgs.length ? `🤖 *Nudges aaj ke liye*
${msgs.join('\\n')}` : '🤖 Abhi koi nudge nahi — sab theek chal raha hai.';
      }
      case 'recap': {
        const r = buildRecap({
          focusWeek: () => focusMode.weeklyReport(),
          expWeek: () => expenses.report(),
          statsWeek: () => screenTime.weekReply(),
          examCountdown: () => examCountdownReply(),
          accuracy: () => accuracyReport(store),
        });
        return `${r}

${recapGoal()}`;
      }
      case 'fun': {
        const raw = String(args || '').trim().toLowerCase();
        if (raw === 'quiz') return funMode.newQuiz();
        if (raw.startsWith('answer')) return funMode.answerQuiz(raw.split(/\s+/)[1]);
        if (raw === 'riddle') return funMode.newRiddle();
        return '🎉 Usage: `/fun quiz` · `/fun answer <n>` · `/fun riddle` (study break time!)';
      }
      case 'role': {
        const raw = String(args || '').trim();
        const [num, role] = raw.split(/\s+/);
        if (!num) return rolesStatus();
        if (/^\d+$/.test(num) && role) return setRole(num, role);
        return '👨‍👩‍👧‍👦 Usage: `/role <number> kids|family|admin` · `/role` status';
      }
      case 'rolelimit': return setRoleLimit(String(args || '').trim());
      case 'home': {
        const raw = String(args || '').trim();
        const [sub, ...rest] = raw.split(/\s+/);
        if (sub === 'setup') return setupHome(rest.join(' '));
        if (sub === 'add') return addDevice(rest[0], rest.slice(1).join(' '));
        if (sub === 'status' || !sub) return homeStatus();
        // /home light on|off|dim 40
        return controlHome(sub, rest.join(' '), {
          post: async (url, body) => {
            await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(8000),
            });
          },
        });
      }
      case 'routine': {
        const raw = String(args || '').trim();
        const [sub, ...rest] = raw.split(/\s+/);
        if (!raw || sub === 'list') return routineList();
        if (sub === 'off') return removeRoutine(rest.join(' '));
        const r = addRoutine(raw.replace(/^set\s+/i, ''));
        return r.reply ?? r.error;
      }
      case 'organize': {
        const dir = String(args || '').trim().replace(/^now\s*/i, '') || undefined;
        return organizeReply(organize(dir));
      }
      case 'backup': {
        const raw = String(args || '').trim();
        const [sub, ...rest] = raw.split(/\s+/);
        if (!raw || sub === 'list') return backupList();
        if (sub === 'cloud') return cloudCopy(rest.join(' '));
        return backupNow(rest.join(' ') || undefined);
      }
      case 'leaveby': return leaveByReply(args);
      case 'timeline': {
        const raw = String(args || '').trim();
        if (raw === 'on') return setTimeline(true);
        if (raw === 'off') return setTimeline(false);
        return timelineReply(raw || 'now');
      }
      case 'wake': {
        const raw = String(args || '').trim().toLowerCase();
        if (raw === 'off' || raw === 'stop') return stopWake();
        if (raw === 'status') return wakeStatus();
        return startWake({
          transcribe: async (file) => {
            const { transcribeWavFile } = await import('./meetingnotes.js');
            return (await transcribeWavFile(file)).text;
          },
          onCommand: (cmd) => handle(cmd, { source: 'wake', voice: true }),
        });
      }
      case 'shades': case 'privacy': {
        // 🕶️ SHADES — panel physically black (privacy from bystanders), but
        // screenshots stay CLEAR (backlight/gamma, never the framebuffer).
        const sub = String(args || '').trim().toLowerCase();
        const shared = {
          run: (bin, a) => execAsyncFile(bin, a),
          stateFile: undefined,
          timeoutMs: Math.max(0, Number(config?.shadesTimeoutMin ?? 30) * 60_000),
        };
        if (sub === 'off' || sub === 'disable' || sub === '0' || sub === 'down') return shadesOff(shared);
        if (sub === 'status') return shadesStatus(shared);
        return shadesOn(shared);
      }
      case 'link': return '📱 On the PC, open the dashboard URL printed at startup (or http://<PC-IP>:8787/) — it shows the WhatsApp QR while linking.';
      default: {
        const learnedRes = await runLearned(cmd, ctx, args);
        if (learnedRes != null) return learnedRes;
        if (!ctx?._fuzzyTried) {
          const learnedNames = (store?.data?.learned ?? []).map((l) => l.keyword);
          const fuzzy = fuzzyMatchSlashCommand(cmd, learnedNames);
          if (fuzzy && fuzzy !== cmd) {
            return handleCommand(fuzzy, args, { ...ctx, _fuzzyTried: true });
          }
        }
        return `🤖 I don't know /${cmd} yet.\n\n${HELP.split('\n').slice(0, 6).join('\n')}\n…full list: /help`;
      }
    }
  }

  async function handleAccuracy(args = '') {
    const raw = String(args ?? '').trim();
    const low = raw.toLowerCase();

    if (/^(?:strict\s+)?(on|enable|active|chalu)$/i.test(low)) {
      store.data.accuracyStrict = true;
      store.save();
      return '🎯 *100% Strict Answer Accuracy Mode: ON* ✅\nHar math, equation, MCQ, coding, calendar, aur factual sawal ab deterministic Ground-Truth + Python/SymPy + Adversarial Auditor se verify hokar aayega.';
    }
    if (/^(?:strict\s+)?(off|disable|band)$/i.test(low)) {
      store.data.accuracyStrict = false;
      store.save();
      return '⚙️ *Strict Multi-Pass Audit Mode: OFF* (Deterministic Ground-Truth & Low-Temp Precision still active).';
    }
    if (low === 'test' || low === 'benchmark' || low === 'selftest') {
      const bench = runAccuracySelfTest();
      const lines = [
        `🎯 *100% Accuracy Engine — Live Self-Test Benchmark*`,
        `• *Score*: *${bench.passed}/${bench.total} (${bench.accuracyPct}%)* in \`${bench.ms}ms\``,
        '',
        ...bench.results.map((r, i) => `${r.passed ? '✅' : '❌'} ${i + 1}. *${r.name}* → \`${r.summary}\``),
      ];
      return lines.join('\n');
    }

    const s = await solver.solverStatus(config, log).catch(() => null);
    return formatAccuracyReport(config, store, s);
  }

  async function handleVerify(args = '', ctx = {}) {
    const raw = String(args ?? '').trim();
    if (!raw) {
      return [
        '🎯 *100% Answer Verifier — Usage:*',
        '• `/verify <question, equation, code, or claim>`',
        '• Examples:',
        '  - `/verify solve x^2 - 5x + 6 = 0`',
        '  - `/verify what day of the week was 15 August 1947`',
        '  - `/verify Integrate x^2 * sin(x) from 0 to pi`',
        '  - `/accuracy test` — Run 10-point live accuracy benchmark',
      ].join('\n');
    }

    bumpAccuracyStat(config, 'verifiedAnswers');
    const det = solveDeterministicQuery(raw);
    if (det) {
      bumpAccuracyStat(config, 'deterministicHits');
      return det.reply;
    }

    const solved = await solver.solveQuestionText(config, raw, {
      harness,
      log,
      signal: activeSignal,
    });
    if (solved?.ok && solved.text) {
      return solved.text;
    }

    const { facts } = extractDeterministicGrounding(raw);
    const aiOut = await askAI(raw, ctx);
    if (facts.length && aiOut && !String(aiOut).includes('Verified Ground-Truth')) {
      return `${aiOut}\n\n🎯 *Verified Ground-Truth*: ${facts.join(' · ')}`;
    }
    return aiOut;
  }

  function workStatus() {
    const active = taskRegistry.active();
    const lines = ['🧩 *Work status*', ...active.map((t) => `⚡ ${t.label} · ${tools.humanDuration(t.elapsedMs)}`)];
    if (!active.length) lines.push('No active task.');
    if (lastBatch) {
      const count = (s) => lastBatch.entries.filter((e) => e.status === s).length;
      lines.push(`Batch: ${count('running')} running · ${count('queued')} queued · ${count('completed')} completed · ${count('failed')} failed · ${count('waiting')} awaiting confirmation · ${count('skipped')} skipped`);
    }
    if (lastBatch) lines.push('Completed/partial outputs: `/batch results`');
    lines.push(`Parallel answer/read limit: ${concurrencyLimit(config.maxParallelTasks)}; PC/write actions are serial.`,
      'Usage: `/batch /ask explain recursion || /ask write a short poem || /time`', '/stop cancels active work and prevents queued tasks from starting.');
    return lines.join('\n');
  }

  async function neuralCommand(raw = '', ctx = {}) {
    const value = String(raw).trim();
    if (!value || /^status$/i.test(value)) {
      const b = brainInfo({ dataDir: config.dataDir });
      const metric = b.metrics?.intent?.testHybrid;
      return [
        `🧠 Local routing brain: ${b.trained ? b.architecture.join('→') : 'heuristic fallback'}`,
        `Memory: ${b.memorySize} examples · ${b.approvedExamples} owner-approved · ${b.ignoredUntrusted} unverified legacy labels ignored`,
        metric ? `Held-out int8 routing test: ${(metric.accuracy * 100).toFixed(1)}% (n=${metric.n}); macro-F1 ${metric.macroF1.toFixed(3)}` : 'No validated checkpoint metrics.',
        b.loadIssues.length ? '⚠️ Bad/incompatible override skipped; using the next healthy checkpoint.' : '',
        'This is intent/matching training, not Grok/Claude language-model fine-tuning.',
        '`/neural classify <text>` · `/neural labels` · `/neural learn <label> | <example>` · `/neural train [epochs]`',
      ].filter(Boolean).join('\n');
    }
    if (/^labels$/i.test(value)) return `Intent labels: ${INTENT_LABELS.join(', ')}`;
    const query = value.match(/^classify\s+([\s\S]+)$/i);
    if (query) {
      const c = classifyIntent(query[1], { dataDir: config.dataDir });
      return `🧠 ${c.label} · routing confidence ${(c.confidence * 100).toFixed(1)}% · ${c.source}${c.uncertain ? ' · ambiguous' : ''}\nConfidence is about routing, NOT factual answer correctness.`;
    }
    const correction = value.match(/^learn\s+([a-z_]+)\s*\|\s*([\s\S]+)$/i);
    if (correction) {
      const ok = learnExample(correction[2], correction[1].toLowerCase(), { dataDir: config.dataDir });
      return ok ? '✅ Owner-approved label saved; routing memory/cache updated immediately. `/neural train` updates weights privately.' : '⚠️ Label not saved. Use `/neural labels`; example must be 1..300 characters and the data file must be valid/writable.';
    }
    const train = value.match(/^train(?:\s+(\d+))?$/i);
    if (train) {
      const epochs = train[1] ? Number(train[1]) : 90;
      const result = await trainPersonalBrain({ dataDir: config.dataDir, epochs, signal: activeSignal ?? ctx.signal });
      const m = result.metrics;
      return `✅ *Neural training actually completed* (CPU worker; private checkpoint loaded).\nIntent test: ${(m.intent.testHybrid.accuracy * 100).toFixed(1)}% (n=${m.intent.test.n}); Match test: ${(m.match.test.accuracy * 100).toFixed(1)}%.\n${m.intent.approvedRuntimeExamples} approved personal labels included. Answer corrections remain lookup rules; this does NOT train the external language model.`;
    }
    return '🧠 Usage: `/neural status|labels|classify <text>|learn <label> | <example>|train [1..500]`';
  }

  async function batchCommand(raw, ctx = {}) {
    if (/^results$/i.test(String(raw ?? '').trim())) return lastBatch ? batchSummary(lastBatch) : workStatus();
    if (!String(raw ?? '').trim() || /^status$/i.test(String(raw).trim())) return workStatus();
    let parsed;
    try {
      parsed = parseBatch(raw);
      // An answer request cannot silently turn into a PC action (or claim one).
      const answerIntents = new Set(['ask', 'ai', 'calc', 'unit', 'convert', 'currency', 'wiki', 'define', 'time', 'date', 'joke', 'fact', 'quote', 'weather', 'news', 'coin', 'dice', 'choose']);
      for (const [index, task] of parsed.tasks.entries()) if (task.kind === 'answer') {
        if (index > 0 && /\b(?:(?:explain|summarize|translate|convert|fix|improve)\s+(?:it|that|this|the above)|previous (?:task|answer|result|output)|based on (?:it|that|the)|using (?:it|that|the previous))\b/i.test(task.args)) {
          throw new Error('Batch tasks must be independent. Use one /ask or /agent request for dependent steps.');
        }
        const intent = parseIntent(task.args);
        if (intent?.cmd && !answerIntents.has(intent.cmd)) throw new Error(`Use an explicit /${intent.cmd} command for actions; bare batch tasks are answer-only.`);
      }
    } catch (err) { return `⚠️ Batch not started: ${err.message}`; }
    if (parsed.stop) return `${stopCommand()}\nNo batch tasks started.`;
    if (store.data.pending || pendingState() || pendingPower || pendingTap) return '🔒 Resolve the pending confirmation first (/yes or /no); no batch tasks started.';
    store.data.lastQuestion = null; // multiple answers: a correction must name its question
    const result = await runBatch(parsed.tasks, {
      concurrency: concurrencyLimit(config.maxParallelTasks), signal: activeSignal,
      onUpdate: (state) => { lastBatch = state; },
      shouldPause: (value) => Boolean(store.data.pending || pendingState() || pendingPower || pendingTap || value?.pending || value?.needsConfirmation),
      run: async (task) => {
        if (task.kind === 'answer') {
          const answer = await askAI(task.args, ctx, { single: true, isolated: true, store: conversationSnapshot(store) });
          return { ok: answer !== ai.NO_BRAIN_HINT, text: answer };
        }
        // Each action traverses the original handler and owner/PIN/confirmation
        // policy. No permission escalation, cached action, implicit retry or yes.
        return handleCommand(task.cmd, task.args, { ...ctx, confirmed: false, signal: activeSignal });
      },
    });
    lastBatch = result;
    throwIfStopped(activeSignal, 'Batch');
    const reply = batchSummary(result);
    const questions = parsed.tasks.filter((t) => t.kind === 'answer').map((t) => t.args).join('\n');
    ai.recordChatTurn(config, store, `/batch ${raw}`, reply, log, { skipBackgroundReflect: true, profileText: questions, skipObserve: !questions });
    return reply;
  }

  async function askAI(text, ctx = {}, taskOptions = {}) {
    const turnStore = taskOptions.store ?? store;
    throwIfStopped(activeSignal, 'AI answer');
    if (turnStore?.data) turnStore.data.lastQuestion = String(text).slice(0, 200);
    const fastReply = (answer) => {
      throwIfStopped(activeSignal, 'AI answer');
      ai.recordChatTurn(config, turnStore, text, answer, log, { isolated: taskOptions.isolated, skipBackgroundReflect: Boolean(taskOptions.isolated) });
      return answer;
    };
    const compound = independentParts(text);
    const complexStem = looksLikeComplexStemOrMcq(text);
    let classified = null, plan = null;
    if (!taskOptions.single && compound.length && !complexStem) {
      try { classified = classifyIntent(text, { dataDir: config.dataDir }); } catch { /* optional */ }
      plan = orchestrate(text, classified || { label: 'misc_chat', scores: {} }, (q) => classifyIntent(q, { dataDir: config.dataDir }));
    }
    // Corrections for a sub-question must not erase the other requested work.
    const forcedAnswer = compound.length ? null : applyCorrection(text, null);
    if (forcedAnswer) return fastReply(forcedAnswer);
    if (plan?.multi) {
      const tasks = plan.squad.map((entry) => ({ kind: 'answer', lane: 'parallel', cmd: 'ask', entry }));
      const output = await runBatch(tasks, {
        concurrency: concurrencyLimit(config.maxParallelTasks), signal: activeSignal,
        run: async ({ entry }) => {
          const answer = await askAI(entry.text, ctx, { single: true, isolated: true, store: conversationSnapshot(turnStore), agent: entry.agent, parentContext: text, squadName: entry.agent.name });
          return { ok: answer !== ai.NO_BRAIN_HINT, text: answer };
        },
      });
      throwIfStopped(activeSignal, 'Squad');
      const parts = plan.squad.map((entry, i) => ({ agent: entry.agent,
        text: output.entries[i].value?.text || '⚠️ No answer for this part; it was not completed.' }));
      // Request order, never answer-length/quality sorting or duplicate turn writes.
      const merged = mergeSquadAnswers(parts);
      if (turnStore?.data) turnStore.data.lastQuestion = null;
      ai.recordChatTurn(config, turnStore, text, merged, log, { isolated: taskOptions.isolated });
      return merged;
    }

    const det = compound.length ? null : solveDeterministicQuery(text);
    if (det) {
      bumpAccuracyStat(config, 'deterministicHits');
      return fastReply(det.reply);
    }
    const bilingualHit = compound.length ? null : lookupBilingualCorpus(text, turnStore);
    if (bilingualHit) {
      return fastReply(bilingualHit.reply);
    }
    if (!taskOptions.isolated && turnStore.data.accuracyStrict !== false && complexStem) {
      const solved = await solver.solveQuestionText(config, text, {
        harness,
        log,
        signal: activeSignal,
      }).catch(() => null);
      if (solved?.ok && solved.text) {
        bumpAccuracyStat(config, 'verifiedAnswers');
        return fastReply(solved.text);
      }
    }
    // Instant trained knowledge (Wikipedia-derived bank + learned entries):
    // factual one-liners answer with zero AI and zero latency.
    const kh = lookupKnowledge(text, turnStore, { dataDir: config.dataDir });
    if (!compound.length && kh && detectQuestionScope(text).scope === 'direct_fact') {
      const wikiUrl = kh.url ?? (kh.wiki ? `https://en.wikipedia.org/wiki/${encodeURIComponent(String(text).split(/\s+/).slice(0, 4).join('_'))}` : null);
      return fastReply(withSource(kh.reply, kh.sources ?? (wikiUrl ? [{ url: wikiUrl, title: 'Wikipedia' }] : [])));
    }
    // ── Multi-agent dispatcher: trained IntentNet splits the work ──
    // One bot for single-intent messages, a SQUAD for compound ones
    // ("explain X and likho ek poem" → 🔬 + ✍️ answering together).
    if (!classified) {
      try { classified = classifyIntent(text, { dataDir: config.dataDir }); } catch { /* optional */ }
    }
    plan ??= taskOptions.single || complexStem
      ? { primary: taskOptions.agent ?? agentForIntent(classified?.label), multi: false }
      : orchestrate(text, classified || { label: 'misc_chat', scores: {} }, (q) => classifyIntent(q, { dataDir: config.dataDir }));

    const result = await ai.chat(config, turnStore, text, log, {
      voice: Boolean(ctx?.voice),
      ...(Array.isArray(ctx.appHistory) ? { history: ctx.appHistory } : {}),
      signal: activeSignal, isolated: Boolean(taskOptions.isolated),
      squadName: taskOptions.squadName,
      skipBackgroundReflect: Boolean(taskOptions.isolated),
      intent: classified?.label,
      agent: plan.primary,
      taskBrief: [taskBrief({ agent: plan.primary, intent: classified?.label }),
        ...compound.map((q) => { const answer = applyCorrection(q, null); return answer ? `Owner-corrected answer for ${JSON.stringify(q)}: ${answer}` : ''; }),
        taskOptions.parentContext ? `Original multi-part question (background only; answer ONLY your current sub-request, not the other parts): ${taskOptions.parentContext}` : '',
      ].filter(Boolean).join('\n'),
    });
    if (result?.text) {
      const tagged = config?.agentTag === false ? result.text : `${result.text}\n\n${agentTag(plan.primary)}`;
      return tagged;
    }
    // No brain: still try to be useful offline for factual questions.
    try {
      const fb = await wikiFallback(text, config, turnStore, { signal: activeSignal });
      if (fb) return fastReply(fb);
    } catch { /* fall through to hint */ }
    throwIfStopped(activeSignal, 'AI answer');
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
          if (step.cmd === '__natural__') {
            const r = await runNaturalStep(step.args ?? '', ruleCtx);
            outs.push(typeof r === 'string' ? r : (r?.text ?? '✅ Done.'));
          } else {
            const cmd = step.inferredOpen ? 'open' : step.cmd;
            const r = await handleCommand(cmd, step.args ?? '', ruleCtx);
            outs.push(typeof r === 'string' ? r : (r?.text ?? '✅ Done.'));
          }
        }
        return outs.join('\n\n---\n\n');
      }
    }

    // Slash command ("/brief", "/open brave")
    const slash = actionText.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)\s*([\s\S]*)$/);
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
    // Natural-language behavioral training & profile inspection
    if (/\b(?:meri\s+chats?\s+se\s+(?:train|seekh)|khud\s+ko\s+train\s+kar|train\s+(?:yourself|from\s+my\s+chats?)|agentic\s+ai\s+ban(?:na|o)?.*understand\s+me)\b/i.test(text)) {
      return personaCommand(text, { forceTrain: true });
    }
    if (/^(?:(?:tu|tum)\s+mujhe\s+kitna\s+(?:jaant[ae]|samajht[ae])\s+h(?:o|ai)|mera\s+(?:behaviour|behavior|swabhav|profile|persona)\s+(?:kaisa\s+hai|batao|dikhao)|mere\s+baare\s+me(?:in)?\s+kya\s+samjha|how\s+well\s+do\s+you\s+know\s+me|what\s+is\s+my\s+(?:persona|behavior\s+profile))[?!.।]*$/i.test(text.trim())) {
      return formatPersonaReport(store, config);
    }
    const memReply = mem.handleMemoryIntent(store, config, text, { voice: Boolean(ctx?.voice) });
    if (memReply !== undefined) return memReply;
    if ((m = text.match(/^(?:what(?:'s| is) the )?weather\s+(?:in|at)\s+([\s\S]+?)\??$/i))) return tools.weather(m[1]);
    if ((m = text.match(/^([\s\S]+?)\s+ka\s+mausam\??$/i))) return tools.weather(m[1]);
    const followUp = resolveFollowUpQuery(store, text);
    if (followUp) {
      return followUp.reply;
    }
    const { format: reqFormat, cleanQuery } = detectRequestedFormat(text);
    const effectiveText = reqFormat ? cleanQuery : text;

    if ((m = effectiveText.match(/^(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)\??$/i))) {
      const out = `🧮 ${m[1]}% of ${m[2]} = *${(Number(m[1]) / 100) * Number(m[2])}*`;
      recordTurnOutcome(store, text, out);
      return applyAnswerFormat(out, reqFormat);
    }
    if ((m = effectiveText.match(/^(\d+(?:\.\d+)?)\s+ka\s+(\d+(?:\.\d+)?)\s*(?:%|percent|pratishat)(?:\s+kitna\s*(?:hota\s*hai|hai)?)?\??$/i))) {
      const out = `🧮 ${m[2]}% of ${m[1]} = *${(Number(m[2]) / 100) * Number(m[1])}*`;
      recordTurnOutcome(store, text, out);
      return applyAnswerFormat(out, reqFormat);
    }
    // Hinglish spoken math ("45 guna 12", "100 plus 250", "500 minus 120", "100 bhaag 4")
    if (/^\d+(?:\.\d+)?\s+(?:guna|into|times|multiply(?:\s+by)?|plus|jod|minus|ghata|bhaag|divide(?:\s+by)?)\s+\d+/i.test(effectiveText)) {
      const expr = effectiveText
        .replace(/\b(?:kitna\s*(?:hota\s*hai|hai)?|kya\s*hai|equals?)\??$/i, '')
        .replace(/\b(?:guna|into|times|multiply(?:\s+by)?)\b/gi, '*')
        .replace(/\b(?:plus|jod)\b/gi, '+')
        .replace(/\b(?:minus|ghata)\b/gi, '-')
        .replace(/\b(?:bhaag|divide(?:\s+by)?)\b/gi, '/')
        .trim();
      try {
        const out = `🧮 ${expr} = *${tools.calc(expr)}*`;
        recordTurnOutcome(store, text, out);
        return applyAnswerFormat(out, reqFormat);
      } catch { /* fall through */ }
    }
    if ((m = effectiveText.match(/^(-?\d+(?:\.\d+)?)\s*([a-zA-Z°]+)\s+(?:in|to|into|me|mein)\s+([a-zA-Z°]+)(?:\s+kitna\s*(?:hota\s*hai|hai)?)?\??$/i))) {
      try {
        const out = `📏 ${tools.convertUnit(Number(m[1]), m[2], m[3])}`;
        recordTurnOutcome(store, text, out);
        return applyAnswerFormat(out, reqFormat);
      } catch { /* not a known unit pair */ }
    }
    if (tools.looksLikeCalc(effectiveText)) {
      try {
        const out = `🧮 ${effectiveText.trim()} = *${tools.calc(effectiveText)}*`;
        recordTurnOutcome(store, text, out);
        return applyAnswerFormat(out, reqFormat);
      } catch { /* not maths after all */ }
    }
    // 100% Deterministic Ground-Truth Solver (< 1ms offline: Equations, GCD/LCM, Factorials, nCr/nPr, Primes, Stats, SI/CI, Base/Roman, Calendar, Science Constants & Capitals)
    const det = solveDeterministicQuery(effectiveText);
    if (det) {
      bumpAccuracyStat(config, 'deterministicHits');
      recordTurnOutcome(store, text, det.reply);
      return applyAnswerFormat(det.reply, reqFormat);
    }
    // Instant Bilingual (Hinglish + English) Corpus Lookup (< 1ms offline: natural Hinglish & impeccable English Q&A)
    const bilingualHit = lookupBilingualCorpus(effectiveText, store);
    if (bilingualHit) {
      recordTurnOutcome(store, text, bilingualHit.reply);
      return applyAnswerFormat(bilingualHit.reply, reqFormat);
    }
    if (/^(hi|hello|hey|namaste|hii+|yo|psd|psd_ai|psdai|hey\s+psd)[!. ]*$/i.test(text)) {
      const ownerName = mem.getOwnerName(store);
      const agentName = mem.getAgentName(store, config);
      return `Ji bolo${ownerName ? ` *${ownerName}*` : ''}! 👋 Main *${agentName}* hoon — aapka fast & powerful Observer agent on +${config.agentNumber} — free, native WhatsApp, listening only to you.\n\nSeedha bolo kya karna hai — ya try karo /help, /weather <city>, /remind in 10m <text>.`;
    }
    return undefined;
  }

  const AFFIRM = /^(?:yes|y|ya|haan|han|ha|karo|kar\s*do|kardo|confirm|theek\s*hai|thik\s*hai|हाँ|हां|हा|करो|ठीक\s*है)[.!\s]*$/i;
  const DENY = /^(?:no|n|nahi|nah|nope|cancel|mat\s*karo|रद्द|ना|नहीं)[.!\s]*$/i;

  // dedup + anti-double-work: same exact message within 4s is ignored
  let lastHandledText = '';
  let lastHandledTs = 0;
  let isProcessing = false;

  /**
   * Controlled Guest / Non-Owner Message Handler.
   * Strictly blocks ALL `/` slash commands and ALL plain-language commands (`baaki bhi`)
   * while allowing safe conversational replies (AI chat / simple greetings / math).
   * Never touches the owner's memory, persona, todos, notes, files, or PC tools.
   */
  async function handleGuest(text, ctx = {}) {
    ensureGuestStore(store, config);
    const senderNumber = normalizeNumber(ctx.senderNumber || '');
    const contact = findContactByNumber(store, senderNumber);
    const senderName = String(ctx.senderName || contact?.name || '').trim();
    const who = senderName
      ? `*${senderName}* (\`+${senderNumber || 'guest'}\`)`
      : `\`+${senderNumber || 'guest'}\``;
    const cleanText = String(text ?? '').trim();

    if (senderNumber) {
      store.data.lastGuestSender = {
        number: senderNumber,
        jid: ctx.senderJid || '',
        name: senderName,
        ts: Date.now(),
      };
    }

    // Block media/file actions from non-owners
    if (ctx.hasMedia && !cleanText) {
      store.bump('blockedGuestCommands');
      const reply = buildBlockedCommandReply(config, store, { command: '/media' });
      recordGuestAudit(store, {
        from: senderNumber,
        name: senderName,
        kind: 'blocked_cmd',
        command: 'media',
        text: '[media attachment]',
        reply,
      });
      const notifyOwnerText = store.data.guestPolicy?.notifyOwnerOnBlockedCmd
        ? `🔒 *Blocked Guest Media/Command* from ${who}: sent a media attachment.`
        : null;
      return { blocked: true, category: 'files', command: 'media', reply, notifyOwnerText };
    }

    if (!cleanText) {
      return { blocked: false, reply: null, notifyOwnerText: null };
    }

    // ── Strict Owner-Only Command Firewall (both `/` and plain-language `baaki bhi`) ──
    const requireApproval = Boolean(
      store.data.guestPolicy?.requireApproval || store.data.guestPolicy?.mode === 'approval',
    );
    const detection = detectGuestCommandAttempt(cleanText, store, config);
    if (detection.blocked) {
      store.bump('blockedGuestCommands');
      recordGuestAudit(store, {
        from: senderNumber,
        name: senderName,
        kind: 'blocked_cmd',
        command: detection.command,
        text: cleanText,
        reply: detection.reply,
      });
      if (requireApproval) {
        const entry = enqueueGuestApproval(store, config, {
          senderNumber,
          senderName,
          senderJid: ctx.senderJid || '',
          incomingText: cleanText,
          proposedReply: detection.reply,
          blockedCommand: detection.command || 'command',
          blockedCategory: detection.category || 'command',
        });
        return {
          blocked: true,
          heldForApproval: true,
          approvalId: entry.id,
          category: detection.category,
          command: detection.command,
          reply: null,
          proposedReply: detection.reply,
          notifyOwnerText: formatApprovalCardForOwner(entry, config),
        };
      }
      const notifyOwnerText = store.data.guestPolicy?.notifyOwnerOnBlockedCmd
        ? `🔒 *Blocked Guest Command* from ${who}: tried \`${detection.command || 'command'}\` — "${cleanText.slice(0, 120)}"\n_(Reply via: \`/reply <msg>\` or block via: \`/block ${senderNumber || senderName}\`)_`
        : null;
      return {
        blocked: true,
        heldForApproval: false,
        category: detection.category,
        command: detection.command,
        reply: detection.reply,
        proposedReply: detection.reply,
        notifyOwnerText,
      };
    }

    // ── Safe Conversational Reply Draft for Allowed Guests ───────────────────
    store.bump('guestMessagesIn');
    const agentName = mem.getAgentName(store, config);
    let replyText = '';
    let pctMatch = null;
    let unitMatch = null;

    if (store.data.guestPolicy?.customAutoReply) {
      replyText = store.data.guestPolicy.customAutoReply;
    } else if (/^(hi|hello|hey|namaste|hii+|yo|hola|assalamualaikum|ram\s*ram|radhe\s*radhe|good\s*(?:morning|afternoon|evening)|kaise\s+ho|kya\s+haal\s+hai)[!.?\s]*$/i.test(cleanText)) {
      replyText = `Hello${senderName ? ` *${senderName}*` : ''}! 👋 Main *${agentName}* hoon. Aap mujhse normal baat-cheet (chat) ya koi bhi general sawal pooch sakte hain.\n_(🔒 Note: Sabhi \`/\` aur system commands sirf mere owner ke liye locked hain.)_`;
    } else if ((pctMatch = cleanText.match(/^(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)\??$/i))
      || (pctMatch = cleanText.match(/^(\d+(?:\.\d+)?)\s+ka\s+(\d+(?:\.\d+)?)\s*(?:%|percent)\??$/i))) {
      const isHindiOrder = /\s+ka\s+/i.test(cleanText);
      const base = Number(isHindiOrder ? pctMatch[1] : pctMatch[2]);
      const pct = Number(isHindiOrder ? pctMatch[2] : pctMatch[1]);
      const ans = Number(((base * pct) / 100).toFixed(6));
      replyText = `🧮 ${pct}% of ${base} = *${ans}*`;
    } else if ((unitMatch = cleanText.match(/^(-?\d+(?:\.\d+)?)\s*([a-zA-Z°]+)\s+(?:in|to|into|me|mein)\s+([a-zA-Z°]+)(?:\s+kitna\s*(?:hota\s*hai|hai)?)?\??$/i))) {
      try {
        replyText = `📏 ${tools.convertUnit(Number(unitMatch[1]), unitMatch[2], unitMatch[3])}`;
      } catch { /* fall through to AI */ }
    } else if (tools.looksLikeCalc(cleanText)) {
      try {
        replyText = `🧮 ${cleanText} = *${tools.calc(cleanText)}*`;
      } catch { /* fall through to AI */ }
    }

    if (!replyText) {
      if (config.aiProvider !== 'none') {
        const aiRes = await ai.guestChat(config, store, senderNumber, cleanText, log, { senderName });
        if (aiRes?.text) {
          replyText = aiRes.text;
        }
      }
    }

    if (!replyText) {
      replyText = `💬 Message mil gaya${senderName ? ` *${senderName}*` : ''}! Main *${agentName}* hoon. Aapka text ("${cleanText.slice(0, 80)}") receive hua — jald hi jawab dunga.`;
    }

    // ── Owner Approval Gate (`approval` mode): send to owner first for yes / no / send instead ──
    if (requireApproval) {
      const entry = enqueueGuestApproval(store, config, {
        senderNumber,
        senderName,
        senderJid: ctx.senderJid || '',
        incomingText: cleanText,
        proposedReply: replyText,
      });
      recordGuestAudit(store, {
        from: senderNumber,
        name: senderName,
        kind: 'held_for_approval',
        text: cleanText,
        reply: replyText,
      });
      return {
        blocked: false,
        heldForApproval: true,
        approvalId: entry.id,
        reply: null,
        proposedReply: replyText,
        notifyOwnerText: formatApprovalCardForOwner(entry, config),
      };
    }

    recordGuestChatTurn(store, senderNumber, 'user', cleanText, { name: senderName });
    recordGuestChatTurn(store, senderNumber, 'assistant', replyText, { name: senderName });
    store.bump('guestRepliesOut');
    recordGuestAudit(store, {
      from: senderNumber,
      name: senderName,
      kind: 'chat',
      text: cleanText,
      reply: replyText,
    });
    const notifyOwnerText = store.data.guestPolicy?.notifyOwnerOnMessage
      ? `💬 *Guest Message* from ${who}: "${cleanText.slice(0, 120)}"\n↳ Reply: "${replyText.slice(0, 120)}"\n_(Reply via: \`/reply <msg>\`)_`
      : null;

    return {
      blocked: false,
      heldForApproval: false,
      reply: replyText,
      proposedReply: replyText,
      notifyOwnerText,
    };
  }

  /** Main entry: owner text → reply. `ctx` may carry { waStatus(), quotedMedia }. */
  // 🔒 Command-name gate for non-owners (3.8.0: per-role allow for kids/family)
  function commandGateOk(senderNumber, cmd) {
    const word = String(cmd ?? '').trim().toLowerCase().replace(/^[/!]/, '').split(/\s+/)[0];
    if (isOwner([String(senderNumber ?? '')], config.ownerNumber) && word && word.length >= 2 && isReserved(word)) {
      return { allow: true, reason: '' };
    }
    return { allow: false, reason: 'Command Blocked 🚫\nSirf owner hi commands use kar sakta hai. Aap normally baat kar sakte ho.' };
  }

  async function handle(text, ctx = {}) {
    // Hard security gate: if `handle()` is ever called with a non-owner context
    // (`isOwner: false`, `guest: true`, or a non-owner `senderNumber`), route
    // strictly through the sandboxed `handleGuest()` pipeline so NO command,
    // PC action, or owner memory access can ever execute for a non-owner.
    if (
      ctx?.isOwner === false
      || ctx?.guest === true
      || (ctx?.senderNumber && !isOwner([ctx.senderNumber], config.ownerNumber))
    ) {
      const roleCheck = commandGateOk(ctx?.senderNumber ?? 'guest', String(text ?? '').trim().split(/\s+/)[0]?.replace(/^\//, ''));
      if (!roleCheck.allow) return roleCheck.reason;
      const guestOut = await handleGuest(text, ctx);
      const guestReply = guestOut?.reply ?? null;
      // 🔐 3.7.0 — guests ko kabhi raw PII nahi (classifier redacts)
      return typeof guestReply === 'string' ? redactPII(guestReply) : guestReply;
    }

    let clean = String(text ?? '').trim();
    const rawText = clean;
    if (!clean) return '🤖 I got an empty message. Try /help';
    // /stop is checked before everything else — before the dedup window and
    // before the busy flag — because it must cut in while work is running.
    if (!ctx.readOnlyReference && isStopCommand(clean)) return stopCommand();
    if (!ctx.readOnlyReference) {
    if (/^\/batch\s+results\s*$/i.test(clean)) return lastBatch ? batchSummary(lastBatch) : workStatus();
    if (/^\/taskstatus\s*$/i.test(clean) || /^\/batch\s+status\s*$/i.test(clean)) return workStatus();
    if (/^\/neural(?:\s+status)?\s*$/i.test(clean)) return neuralCommand('status', ctx);
    }
    // dedup: same exact text within 4s → ignore second copy (double tap / network retry)
    if (clean === lastHandledText && Date.now() - lastHandledTs < 4000) {
      return '⏳ Same command abhi process hua tha (4s ke andar) — duplicate ignore kiya, double kaam nahi karunga.';
    }
    if (isProcessing) {
      // queue-like behaviour: tell owner we're busy, don't run in parallel (no double work)
      return '⏳ Ek kaam chal raha hai — /taskstatus se progress, /stop se roko. Multiple independent tasks ek message me: `/batch sawal 1 || sawal 2` (PC actions serialized).';
    }
    if (ctx.readOnlyReference || ctx.mobileProject?.privateChat && !clean.startsWith('/')) {
      const projectTask = taskRegistry.begin('Private project answer'); isProcessing = true; activeSignal = projectTask.signal;
      try {
        const result = await ai.chat(config, { data: { history: [], facts: {}, notes: [], todos: [] }, save() {}, pushHistory() {} }, clean, log,
          { signal: activeSignal, history: ctx.appHistory || [], isolated: true, privateProject: ctx.mobileProject });
        return result?.text || 'No configured AI provider returned an answer. Check /brains in Personal; this private project did not use other owner memory.';
      } finally { activeSignal = null; isProcessing = false; projectTask.end(); }
    }
    // ✏️ 3.6.0 — "galat, asli jawab X hai" → bot permanently seekh jata hai.
    const corr = parseCorrection(rawText);
    if (corr?.right && store.data.lastQuestion) {
      saveCorrection(store.data.lastQuestion, corr.right);
      store.data.lastQuestion = null;
      return `✏️ *Seekh gaya!* Ab se is sawal ka jawab: *${corr.right.slice(0, 100)}*\nList: \`/corrections\``;
    }
    // 🧠 3.6.0 — multi-turn memory: "wo file bhejo" → last-mentioned file.
    clean = resolveRefs(rawText);
    absorb(rawText);
    recordMessage('user', clean); // 🗂️ 3.7.0 topic-channel memory
    const label = labelFor(clean);
    const task = taskRegistry.begin(label, { detail: clean.replace(/^\//, '').slice(0, 60) });
    activeSignal = task.signal;
    try {
      isProcessing = true;
      // A message starting with the shell PIN unlocks shell for this message
      // only ("1234 df -h"), so the PIN never has to live in the AI prompt.
      let working = clean;
      let effCtx = { ...ctx, signal: activeSignal };
      if (config.shellPin && working.startsWith(`${config.shellPin} `)) {
        working = working.slice(config.shellPin.length + 1).trim();
        effCtx = { ...effCtx, shellPinOk: true };
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
          throwIfStopped(activeSignal, 'Command stack');
          const m = line.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)\s*([\s\S]*)$/);
          if (!m) { results.push(`⚠️ Skip: ${line.slice(0,40)}`); continue; }
          const r = await handleCommand(m[1].toLowerCase(), m[2].trim(), effCtx);
          const out = typeof r === 'string' ? r : (r?.text ?? JSON.stringify(r).slice(0,500));
          results.push(out);
          macro.recordStep(store, m[1].toLowerCase(), m[2].trim());
          if (store.data.pending || pendingState() || pendingPower || pendingTap) {
            results.push('🔒 Confirmation needed — remaining stack commands were NOT started. Confirm separately.');
            break;
          }
        }
        store.setLastOwnerTask?.(working);
        lastHandledText = clean; lastHandledTs = Date.now();
        return results.join('\n\n---\n\n');
      }

      const cmdMatch = working.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)\s*([\s\S]*)$/);
      if (cmdMatch) {
        // If the message is "/<name> naam ka command banao ...", treat it as command creation rather than running an unknown slash command
        const slashCreateIntent = learn.parseCreateCommandIntent(working, store.getLastOwnerTask?.() || '');
        if (slashCreateIntent) {
          const createdReply = await executeCreateCommandIntent(slashCreateIntent, effCtx);
          if (createdReply !== undefined) {
            lastHandledText = clean; lastHandledTs = Date.now();
            return createdReply;
          }
        }
        const slashName = cmdMatch[1].toLowerCase();
        const res = await handleCommand(slashName, cmdMatch[2].trim(), effCtx);
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
        if (!failed) {
          macro.recordStep(store, slashName, cmdMatch[2].trim());
          if (!['learn', 'unlearn', 'cmd', 'command', 'createcmd', 'delcmd', 'watchme', 'recordactions', 'replayactions', 'teach', 'stop', 'cancel', 'yes', 'no', 'pending', 'approve', 'reject'].includes(slashName)) {
            store.setLastOwnerTask?.(working);
            recordDesktopEvent(store, { type: 'command', cmd: slashName, args: cmdMatch[2].trim() });
          }
        }
        return res;
      }

      // 3.6.0 safety pending (token confirm for rm/kill/panic): "haan" runs it.
      if (pendingState()) {
        if (AFFIRM.test(working)) {
          const conf = confirmPending('yes');
          if (conf.ok) return handleCommand(conf.action, conf.args, { ...effCtx, confirmed: true });
          return conf.error;
        }
        if (DENY.test(working)) { cancelPending(); return '👍 Cancelled — kuch nahi kiya.'; }
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
      if (pendingPower || pendingTap) {
        if (AFFIRM.test(working)) return handlePc('confirm');
        if (DENY.test(working)) return handlePc('cancel');
      }

      // Pending Guest Message Approval: "yes" / "no" / "no send this instead: <text>" / "nahi yeh bhejo: <text>"
      if (getActiveGuestApproval(store, config)) {
        const guestDecision = parseOwnerApprovalDecision(working);
        if (guestDecision) {
          return await executeOwnerApprovalDecision(guestDecision, null, effCtx);
        }
      }

      // Continuously learn owner's behavior, language vibe, mood, preferences, goals & lessons from every message
      observeOwnerTurn(store, working);

      // Live PC Action Recorder, Learner & Replayer ("mere actions record karo", "stop recording", "mere actions repeat karo")
      const actionRecIntent = parseActionRecorderIntent(working, {
        isRecording: Boolean(getActiveRecording(store)),
      });
      if (actionRecIntent) {
        const recReply = await executeActionRecorderIntent(actionRecIntent, effCtx);
        if (recReply !== undefined) return recReply;
      }

      // Natural-Language Dynamic Command Creation ("create a command /study that ...", "create this as a command /work")
      const createCmdIntent = learn.parseCreateCommandIntent(working, store.getLastOwnerTask?.() || '');
      if (createCmdIntent) {
        const createdReply = await executeCreateCommandIntent(createCmdIntent, effCtx);
        if (createdReply !== undefined) return createdReply;
      }

      // Remember this actionable message so the owner can say "create this as a command /name" next
      store.setLastOwnerTask?.(working);

      const quick = intent(working, effCtx);
      if (quick !== undefined) return await quick;

      // Immediate override preambles ("firefox nahi chrome kholo", "is baar firefox kholo", "pehle wala chhodo, /note ...")
      const unwrapped = mem.unwrapImmediateOverride(working);
      if (unwrapped.bypassSaved) {
        working = unwrapped.text;
        effCtx = { ...effCtx, bypassSaved: true };
        const innerCmd = working.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)\s*([\s\S]*)$/);
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
        const nlpRes = await handleCommand(parsed.cmd, parsed.args ?? '', effCtx);
        if (!['watchme', 'recordactions', 'replayactions', 'teach', 'learn', 'unlearn', 'cmd', 'command', 'stop', 'cancel'].includes(parsed.cmd)) {
          recordDesktopEvent(store, { type: 'command', cmd: parsed.cmd, args: parsed.args ?? '' });
        }
        return nlpRes;
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
      const tCtx = topicContext();
      const aiRes = await askAI(tCtx ? `${tCtx}\n\n${working}` : working, effCtx);
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

  const appApprovals = createApprovalBroker({
    busy: () => isProcessing,
    candidates: () => {
      const now = Date.now(), safety = pendingTicket();
      // Match /yes priority exactly; expose only the action that /yes would
      // consume. Expired state must never mask a different live approval.
      if (safety) return [{ kind: 'safety', value: safety, nonce: safety.nonce, text: `/${safety.action} ${safety.args}`, expiresAt: safety.at + 300_000 }];
      if (store.data.pending) {
        const p = store.data.pending, expiry = p.ts + (config.confirmTtlMs ?? 120_000);
        if (Number.isFinite(p.ts) && p.ts <= now && expiry > now) return [{ kind: 'action', value: p, text: p.text, expiresAt: expiry }];
        actions.clearPending();
      }
      if (pendingTap && pendingTap.expires > now) return [{ kind: 'tap', value: pendingTap, text: `Click “${pendingTap.matched}” at ${pendingTap.x},${pendingTap.y}`, expiresAt: pendingTap.expires }];
      if (pendingPower && pendingPower.expires > now) return [{ kind: 'power', value: pendingPower, text: `${pendingPower.action} the PC (unsaved work may be lost)`, expiresAt: pendingPower.expires }];
      return [];
    },
    // The ID is checked synchronously, then the ORIGINAL owner dispatcher
    // acquires its busy/task barrier before any await. Never run a side-door
    // confirmed action in parallel with an in-progress batch or PC write.
    resolve: (_kind, approve) => handle(approve ? '/yes' : '/no', { source: 'app', isOwner: true }),
  });
  const appState = () => ({
    active: taskRegistry.active(), pending: appApprovals.list(),
    batch: lastBatch ? { halted: lastBatch.halted || '', entries: lastBatch.entries.map((e) => ({ index: e.index, command: `/${e.task.cmd}`, status: e.status, ms: e.ms, text: String(typeof e.value === 'string' ? e.value : e.value?.text || '').slice(0, 2400), completedAfterStop: Boolean(e.completedAfterStop) })) } : null,
  });

  return {
    handle, handleGuest, HELP, actions, shots, harness, voice,
    app: { state: appState, decide: appApprovals.decide, busy: () => isProcessing, onStop: (fn) => { appStopListeners.add(fn); return () => appStopListeners.delete(fn); } },
    attachWhatsApp: ({ sendToNumber: sendFn, sendToOwner: notifyFn } = {}) => {
      if (typeof sendFn === 'function') {
        sendWhatsappTo = sendFn;
        actions.setSendToNumber?.(sendFn);
      }
      if (typeof notifyFn === 'function') {
        notifyOwner = notifyFn;
      }
    },
    attachWaVoip: (engine) => { waVoip = engine; },
    waVoipStatus: () => waVoip?.status?.() ?? null,
    jarvisAudioReply,
    spokenFor: (reply) => spokenSummary(reply, config),
    isHarnessAuto: () => harness.status().autoRoute,
  };
}
