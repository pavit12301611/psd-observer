// route.ts — which engine answers THIS message.
//
// The app has two engines: Direct AI (a provider key held on the phone, no PC
// needed, fast) and the paired PC agent (every tool, files, approvals). Before
// this file the choice was a single global switch, so talking about the PC in
// a Direct AI chat meant leaving the chat, and a command in PC mode could not
// use the faster cloud model.
//
// In "auto" mode the decision is per message, on the device, with no model
// call: Direct AI by default, the PC the moment the message is about the
// machine or is a command. The classifier is deliberately conservative in the
// PC direction — a wrongly-routed question still gets a good answer from the
// PC agent, while a command sent to Direct AI would just be refused.
//
// Pure on purpose: no network, no storage, fully testable.

import type { ChatMode, Message, Route } from "../types";

/** What the phone shows instead of PC output while it is talking to Direct AI. */
export const PC_PLACEHOLDER = "[Handled on your PC — details stay on the PC.]";

/** The machine itself, its parts, and the things living on it. */
const PC_NOUNS = [
  // the box
  "pc", "laptop", "computer", "desktop", "machine", "system", "server",
  "workstation", "mac", "macbook", "cpu", "ram", "gpu", "disk", "ssd", "hdd",
  "processor", "motherboard", "battery", "charger", "fan", "temperature",
  // the screen
  "screen", "display", "monitor", "screenshot", "screencap", "screen shot",
  "screen recording", "screenrecord", "wallpaper", "brightness", "resolution",
  // storage
  "file", "files", "folder", "directory", "download", "downloads", "upload",
  "path", "recycle bin", "trash", "usb", "pendrive", "hard disk",
  // hardware switches
  "wifi", "wi-fi", "bluetooth", "hotspot", "airplane mode", "volume",
  "speaker", "headphone", "microphone", "mic ", "camera", "webcam", "printer",
  "keyboard", "mouse", "touchpad", "clipboard",
  // software on the box
  "chrome", "firefox", "edge", "safari", "browser", "vscode", "vs code",
  "visual studio", "terminal", "command prompt", "powershell", "notepad",
  "calculator", "explorer", "file manager", "settings app", "task manager",
  "spotify", "vlc", "zoom", "teams", "discord", "steam", "word", "excel",
  "powerpoint", "photoshop", "obs", "anydesk", "teamviewer",
  // system state
  "shutdown", "restart", "reboot", "sleep", "hibernate", "lock screen",
  "log off", "sign out", "boot", "startup", "processes", "services", "ports",
  "ip address", "localhost", "hostname", "taskbar", "start menu", "notification",
];

/** Installed apps people name without saying "app". */
const PC_APPS = [
  "chrome", "firefox", "edge", "safari", "spotify", "vlc", "youtube",
  "whatsapp", "telegram", "instagram", "discord", "steam", "zoom", "teams",
  "vscode", "vs code", "notepad", "calculator", "terminal", "camera", "gallery",
  "settings", "files", "explorer", "word", "excel", "powerpoint", "photoshop",
  "obs", "gimp", "android studio", "intellij", "postman", "docker",
];

/** "Do something" verbs — English plus the Hinglish the agent already speaks. */
const ACTION_VERBS = [
  // english
  "open", "close", "launch", "start", "kill", "run", "execute", "install",
  "uninstall", "download", "upload", "save", "write", "create", "make",
  "delete", "remove", "move", "copy", "rename", "zip", "unzip", "extract",
  "send", "share", "search", "find", "scan", "record", "capture", "screenshot",
  "type", "click", "tap", "press", "play", "pause", "mute", "unmute", "set",
  "restart", "reboot", "shutdown", "lock", "schedule", "remind", "backup",
  "empty", "clear", "convert", "compress", "print", "connect",
  "disconnect", "pair", "cast", "mirror",
  // hinglish / shorthand (same vocabulary as the agent's router)
  "kholo", "khol", "kholdo", "kholke", "band", "bnd", "bandh", "bhej", "bhejo",
  "bhj", "bhjo", "bhejdo", "banao", "bana", "bnao", "likho", "likh", "likhdo",
  "dhundo", "dhoondo", "dhund", "hata", "hatao", "htao", "chalao", "chlao",
  "chalu", "chlu", "kaato", "lagao", "lgao", "karo", "kro", "krdo", "kardo",
  "dlt", "dlte", "rcrd", "dikhado", "dikha", "btao", "bta", "screenshot le",
  "le lo", "dekh", "dekho", "chalu kar", "band kar", "on kar", "off kar",
  // level changes
  "badhao", "badha", "increase", "decrease", "reduce", "raise", "lower",
  "turn on", "turn off", "enable", "disable", "toggle",
];

/**
 * Questions and study/code talk. These win over a stray action verb:
 * "explain how wifi works" is a question, "wifi band karo" is a command.
 */
const KNOWLEDGE_HINTS = [
  "what", "why", "how", "when", "which", "who", "whose", "where",
  "kaise", "kaisa", "kyun", "kyu", "kya", "kab", "kaun", "kitna", "kitne",
  "matlab", "meaning", "means", "explain", "describe", "teach", "samjhao",
  "samajh", "difference", "compare", "comparison", "versus",
  "vs ", "pros and cons", "advantages", "disadvantages", "example", "examples",
  "define", "definition", "summary", "summarise", "summarize", "translate",
  "essay", "paragraph", "speech", "story", "poem", "letter", "email draft",
  "code", "function", "python", "javascript", "typescript", "java", "react",
  "sql", "regex", "algorithm", "bug", "error", "exception", "stack trace",
  "compile", "syntax", "api", "json", "html", "css", "linux command",
  "tutorial", "course", "exam", "study", "homework", "assignment", "revision",
  "recipe", "gym", "workout", "diet", "travel", "hotel", "flight", "movie",
  "song", "book", "news", "weather", "cricket", "match", "score",
];

/** Nouns that make an "open/close" verb about the world, not the machine. */
const NOT_THE_PC = [
  "account", "ticket", "demat", "meeting", "appointment", "shop", "store",
  "business", "company", "restaurant", "booking", "order", "parcel", "door",
  "gate", "bank", "loan", "policy",
];

// Both sides get one padding space, so a word never matches inside a longer
// word: "mic" must not fire on "microphone", "vs" must not fire on "vscode".
const norm = (text: string) => ` ${text.toLowerCase().trim().replace(/\s+/g, " ")} `;
const has = (hay: string, needle: string) => hay.includes(norm(needle));

/** True when the message names the machine, its parts, or software on it. */
export function mentionsPc(text: string): boolean {
  const t = norm(text);
  return PC_NOUNS.some((n) => has(t, n));
}

/** True when the message is a command aimed at the machine. */
export function looksLikeCommand(text: string): boolean {
  if (text.trim().startsWith("/")) return true;
  const knowledge = KNOWLEDGE_HINTS.some((k) => has(norm(text), k));
  if (knowledge && !mentionsPc(text)) return false;
  if (NOT_THE_PC.some((n) => has(norm(text), n)) && !mentionsPc(text))
    return false;
  if (PC_APPS.some((a) => has(norm(text), a))) return true;
  return ACTION_VERBS.some((v) => has(norm(text), v));
}

/**
 * Route one message. A file attachment always goes to the PC (Direct AI is
 * text-only), a slash command always goes to the PC (it is a PC command), and
 * otherwise the machine/app/command signals decide.
 *
 * With no key and no PC paired there is no engine at all; the app then opens
 * the key sheet, because Direct AI is the default and needs no PC.
 */
export function pickRoute(
  text: string,
  options: {
    hasFile?: boolean;
    mode?: ChatMode;
    cloudReady?: boolean;
    paired?: boolean;
  } = {},
): Route {
  const {
    hasFile = false,
    mode = "auto",
    cloudReady = true,
    paired = true,
  } = options;
  // An explicit choice always wins — auto only applies in "auto".
  if (mode === "agent") return "agent";
  if (mode === "cloud" && !hasFile && !text.trim().startsWith("/"))
    return "cloud";
  // Auto: the PC takes anything about the machine or any command.
  if (hasFile) return "agent";
  if (text.trim().startsWith("/")) return "agent";
  if (mentionsPc(text) || looksLikeCommand(text)) return "agent";
  // Nothing machine-ish: Direct AI when it can actually answer.
  if (cloudReady) return "cloud";
  return paired ? "agent" : "cloud";
}

/**
 * History handed to Direct AI when the chat contains PC answers. PC output
 * never leaves the machine, so those turns are replaced by a placeholder that
 * keeps the thread readable without leaking what the agent did.
 */
export function cloudContext(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    out.push(
      m.role === "assistant" && m.route === "agent"
        ? { ...m, text: PC_PLACEHOLDER }
        : m,
    );
  }
  return out;
}
