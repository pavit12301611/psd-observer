// guests.js — Controlled Multi-User Messaging, Contact Book & Strict Owner-Only
// Command Firewall for PSD_Ai (Observer WhatsApp Agent).
//
// Core security & capability contract:
//   1. The agent can message people other than the owner (both replying to
//      incoming chats from others AND sending outbound messages on the owner's
//      instruction via `/msg`, natural language, or the `send_whatsapp` tool).
//   2. ALL commands — both `/` slash commands (`/help`, `/open`, `/pc`,
//      `/screenshot`, `/ls`, `/run`, `/dsh`, `/agent`, `/todo`, `/note`,
//      `/remind`, `/remember`, `/msg`, `/guest`, …) AND non-slash natural
//      language commands ("chrome kholo", "screenshot bhej do", "wifi off karo",
//      "pc band karo", "files dikhao", "mera naam X hai", "remind me…", etc.) —
//      are 100% BLOCKED for everyone except the owner (`config.ownerNumber`).
//   3. Non-owner conversations run in a strict, isolated sandbox:
//        • Zero PC/system/file tools
//        • Zero access to the owner's memory (`facts`), `profile`, `notes`,
//          `todos`, `reminders`, `downloads`, or `history`
//        • Per-guest rate limiting + model tier cap (`standard` max)
//        • Full owner control (`/guest all|contacts|off`, `/allow`, `/block`,
//          `/unblock`, `/contact`, `/guest log`, `/guest notify on|off`)

import { normalizeNumber, numberToJid, maskNumber, isOwner, jidToNumber } from './allowlist.js';
import { parseIntent } from './nlp.js';
import * as mem from './memory.js';
import { isStopCommand } from './cancel.js';
import * as tools from './tools.js';
import { parseCreateCommandIntent } from './learn.js';
import { parseActionRecorderIntent } from './actionrecorder.js';

const MAX_GUEST_HISTORY = 10;
const MAX_AUDIT_LOG = 100;

export function normalizeGuestMode(mode) {
  const raw = String(mode ?? '').trim().toLowerCase();
  if (['off', 'false', '0', 'none', 'silent', 'owner', 'owner-only', 'owner_only', 'band', 'private'].includes(raw)) {
    return 'off';
  }
  if (['contacts', 'contact', 'allowlist', 'allowed', 'whitelist', 'known', 'apne', 'controlled'].includes(raw)) {
    return 'contacts';
  }
  if (['approval', 'approve', 'ask', 'confirm', 'review', 'hold', 'moderate', 'moderated', 'permission'].includes(raw)) {
    return 'approval';
  }
  if (['all', 'auto', 'on', 'true', '1', 'everyone', 'public', 'sab', 'chalu', 'open'].includes(raw)) {
    return 'all';
  }
  return 'approval';
}

export function createDefaultGuestPolicy(config = {}) {
  const mode = normalizeGuestMode(config.guestMode ?? 'approval');
  const requireApproval = config.guestApproval !== undefined
    ? Boolean(config.guestApproval)
    : mode === 'approval';
  return {
    mode, // 'approval' | 'all' | 'contacts' | 'off'
    requireApproval,
    allowlist: [],
    blocklist: [],
    notifyOwnerOnMessage: Boolean(config.guestNotifyMessages ?? (mode === 'approval')),
    notifyOwnerOnBlockedCmd: config.guestNotifyBlocked !== undefined ? Boolean(config.guestNotifyBlocked) : true,
    rateLimitPerMinute: Math.max(1, Math.min(Number(config.guestRateLimitPerMinute ?? 6) || 6, 60)),
    customAutoReply: '',
  };
}

export function ensureGuestStore(store, config = {}) {
  if (!store?.data) {
    return {
      contacts: {},
      guestPolicy: createDefaultGuestPolicy(config),
      guestChats: {},
      guestAuditLog: [],
      pendingGuestApprovals: [],
      lastGuestSender: null,
    };
  }
  if (!store.data.contacts || typeof store.data.contacts !== 'object' || Array.isArray(store.data.contacts)) {
    store.data.contacts = {};
  }
  const basePolicy = createDefaultGuestPolicy(config);
  const rawPolicy = store.data.guestPolicy && typeof store.data.guestPolicy === 'object'
    ? store.data.guestPolicy
    : {};
  const mergedMode = normalizeGuestMode(rawPolicy.mode ?? basePolicy.mode);
  store.data.guestPolicy = {
    ...basePolicy,
    ...rawPolicy,
    mode: mergedMode,
    requireApproval: rawPolicy.requireApproval !== undefined
      ? Boolean(rawPolicy.requireApproval)
      : mergedMode === 'approval',
    allowlist: Array.isArray(rawPolicy.allowlist)
      ? [...new Set(rawPolicy.allowlist.map((n) => normalizeNumber(n)).filter(Boolean))]
      : [],
    blocklist: Array.isArray(rawPolicy.blocklist)
      ? [...new Set(rawPolicy.blocklist.map((n) => normalizeNumber(n)).filter(Boolean))]
      : [],
    rateLimitPerMinute: Math.max(1, Math.min(Number(rawPolicy.rateLimitPerMinute ?? basePolicy.rateLimitPerMinute) || 6, 60)),
    customAutoReply: String(rawPolicy.customAutoReply ?? '').trim(),
  };
  if (!store.data.guestChats || typeof store.data.guestChats !== 'object' || Array.isArray(store.data.guestChats)) {
    store.data.guestChats = {};
  }
  if (!Array.isArray(store.data.guestAuditLog)) {
    store.data.guestAuditLog = [];
  }
  if (!Array.isArray(store.data.pendingGuestApprovals)) {
    store.data.pendingGuestApprovals = [];
  }
  if (!('lastGuestSender' in store.data)) {
    store.data.lastGuestSender = null;
  }
  return store.data;
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const contactSlug = (name) => clean(name).toLowerCase().replace(/[^a-z0-9\u0900-\u097F\s_-]/g, '').trim();

// ── Contact Book Management ──────────────────────────────────────────────────

export function addContact(store, name, rawNumber, config = {}) {
  const data = ensureGuestStore(store, config);
  const cleanName = clean(name).replace(/^[|:,-]+|[|:,-]+$/g, '').trim();
  const slug = contactSlug(cleanName);
  if (!cleanName || !slug || /^\d+$/.test(slug)) {
    return { ok: false, reason: 'Contact ka valid naam do (e.g. `/contact add Rahul 9876543210`).' };
  }
  const number = normalizeNumber(rawNumber);
  if (!/^\d{10,15}$/.test(number)) {
    return { ok: false, reason: `Phone number valid nahi lag raha: "${rawNumber ?? ''}". 10-digit number ya +91... do.` };
  }
  data.contacts[slug] = {
    name: cleanName,
    slug,
    number,
    addedTs: Date.now(),
  };
  // Automatically unblock if previously blocked
  data.guestPolicy.blocklist = data.guestPolicy.blocklist.filter((n) => n !== number);
  store?.save?.();
  return { ok: true, contact: data.contacts[slug] };
}

export function removeContact(store, nameOrNumber, config = {}) {
  const data = ensureGuestStore(store, config);
  const query = clean(nameOrNumber);
  if (!query) return { ok: false, reason: 'Contact ka naam ya number batao.' };
  const slug = contactSlug(query);
  if (slug && data.contacts[slug]) {
    const removed = data.contacts[slug];
    delete data.contacts[slug];
    store?.save?.();
    return { ok: true, removed };
  }
  const asNum = normalizeNumber(query);
  if (asNum) {
    for (const [k, c] of Object.entries(data.contacts)) {
      if (c.number === asNum) {
        delete data.contacts[k];
        store?.save?.();
        return { ok: true, removed: c };
      }
    }
  }
  return { ok: false, reason: `"${query}" naam ya number ka koi saved contact nahi mila.` };
}

export function listContacts(store, config = {}) {
  const data = ensureGuestStore(store, config);
  return Object.values(data.contacts).sort((a, b) => a.name.localeCompare(b.name));
}

export function findContactByNumber(store, rawNumber, config = {}) {
  const data = ensureGuestStore(store, config);
  const num = normalizeNumber(rawNumber);
  if (!num) return null;
  return Object.values(data.contacts).find((c) => c.number === num) ?? null;
}

export function findContactByName(store, rawName, config = {}) {
  const data = ensureGuestStore(store, config);
  const slug = contactSlug(rawName);
  if (!slug) return null;
  if (data.contacts[slug]) return data.contacts[slug];
  return Object.values(data.contacts).find(
    (c) => c.slug === slug || c.name.toLowerCase() === slug || c.slug.startsWith(slug),
  ) ?? null;
}

/**
 * Resolve a recipient target (contact name, phone number, JID, or "last") into
 * `{ ok, number, jid, name, isOwner, source }`.
 */
export function resolveRecipient(store, config = {}, rawTarget = '') {
  const data = ensureGuestStore(store, config);
  const target = clean(rawTarget).replace(/^to\s+/i, '').trim();
  if (!target) {
    return { ok: false, reason: 'Kisko message bhejna hai? Number (e.g. `9876543210`) ya saved contact naam do.' };
  }

  // 1. "last" / "reply" -> last non-owner who messaged the agent
  if (/^(?:last|last\s+guest|last\s+sender|reply)$/i.test(target)) {
    const last = data.lastGuestSender;
    if (!last?.number) {
      return { ok: false, reason: 'Abhi tak kisi guest ka message nahi aaya hai jisko reply kiya ja sake.' };
    }
    const contact = findContactByNumber(store, last.number, config);
    return {
      ok: true,
      number: last.number,
      jid: last.jid || numberToJid(last.number),
      name: contact?.name || last.name || `+${last.number}`,
      isOwner: isOwner([last.number], config.ownerNumber),
      source: 'last_guest',
    };
  }

  // 2. Saved contact by name
  const byName = findContactByName(store, target, config);
  if (byName) {
    return {
      ok: true,
      number: byName.number,
      jid: numberToJid(byName.number),
      name: byName.name,
      isOwner: isOwner([byName.number], config.ownerNumber),
      source: 'contact',
    };
  }

  // 3. JID or phone number
  const fromJid = jidToNumber(target);
  const digits = fromJid || normalizeNumber(target);
  if (/^\d{10,15}$/.test(digits)) {
    const contact = findContactByNumber(store, digits, config);
    return {
      ok: true,
      number: digits,
      jid: target.endsWith('@s.whatsapp.net') ? target : numberToJid(digits),
      name: contact?.name || `+${digits}`,
      isOwner: isOwner([digits], config.ownerNumber),
      source: contact ? 'contact' : 'number',
    };
  }

  return {
    ok: false,
    reason: `"${target}" koi valid phone number nahi hai aur saved contacts me bhi nahi mila. Number do (e.g. \`/msg 9876543210 hello\`) ya pehle \`/contact add ${target} <number>\` se save karo.`,
  };
}

/**
 * Parse `/msg <target> <message>` or `/msg <target> | <message>` into
 * `{ ok, recipient, text, reason }`.
 */
export function parseTargetAndMessage(store, config = {}, rawArgs = '') {
  const raw = String(rawArgs ?? '').trim();
  if (!raw) {
    return {
      ok: false,
      reason: '📤 Usage: `/msg <number ya contact> <message>`\nExamples:\n• `/msg 9876543210 Bhai 10 minute me aa raha hoon`\n• `/msg Rahul | Meeting 5 baje hai`',
    };
  }

  let targetPart = '';
  let messagePart = '';

  // 1. Explicit pipe `|` or `::` delimiter
  const pipeMatch = raw.match(/^([^|]+?)\s*(?:\||::)\s*([\s\S]+)$/);
  if (pipeMatch) {
    targetPart = pipeMatch[1].trim();
    messagePart = pipeMatch[2].trim();
  } else {
    // 2. Check saved multi-word or single-word contacts (longest name match first)
    const contacts = listContacts(store, config).sort((a, b) => b.name.length - a.name.length);
    for (const c of contacts) {
      const escaped = c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^${escaped}(?:\\s*[:\\-]\\s*|\\s+)([\\s\\S]+)$`, 'i');
      const m = raw.match(re);
      if (m) {
        targetPart = c.name;
        messagePart = m[1].trim();
        break;
      }
    }

    // 3. Leading phone number (e.g. "+91 98765 43210 hello", "9876543210: hello")
    if (!targetPart) {
      const phoneMatch = raw.match(/^(\+?\d[\d\s\-]{8,16}\d)(?:\s*[:\-]\s*|\s+)([\s\S]+)$/);
      if (phoneMatch) {
        targetPart = phoneMatch[1].trim();
        messagePart = phoneMatch[2].trim();
      }
    }

    // 4. First word as target, rest as message
    if (!targetPart) {
      const firstSpace = raw.match(/^([^\s:]+)(?:\s*[:\-]\s*|\s+)([\s\S]+)$/);
      if (firstSpace) {
        targetPart = firstSpace[1].trim();
        messagePart = firstSpace[2].trim();
      } else {
        targetPart = raw;
        messagePart = '';
      }
    }
  }

  if (!messagePart) {
    return {
      ok: false,
      reason: `📤 "${targetPart}" ko kya message bhejna hai? Example: \`/msg ${targetPart} Hello bhai\``,
    };
  }

  const recipient = resolveRecipient(store, config, targetPart);
  if (!recipient.ok) return { ok: false, reason: recipient.reason };

  return {
    ok: true,
    recipient,
    text: messagePart,
  };
}

// ── Allowlist / Blocklist & Guest Gate ───────────────────────────────────────

export function allowGuest(store, config, rawTarget) {
  const data = ensureGuestStore(store, config);
  const res = resolveRecipient(store, config, rawTarget);
  if (!res.ok) return res;
  if (!data.guestPolicy.allowlist.includes(res.number)) {
    data.guestPolicy.allowlist.push(res.number);
  }
  data.guestPolicy.blocklist = data.guestPolicy.blocklist.filter((n) => n !== res.number);
  store?.save?.();
  return { ok: true, ...res };
}

export function blockGuest(store, config, rawTarget) {
  const data = ensureGuestStore(store, config);
  const res = resolveRecipient(store, config, rawTarget);
  if (!res.ok) return res;
  if (res.isOwner) {
    return { ok: false, reason: 'Owner number ko block nahi kiya ja sakta.' };
  }
  if (!data.guestPolicy.blocklist.includes(res.number)) {
    data.guestPolicy.blocklist.push(res.number);
  }
  data.guestPolicy.allowlist = data.guestPolicy.allowlist.filter((n) => n !== res.number);
  store?.save?.();
  return { ok: true, ...res };
}

export function unblockGuest(store, config, rawTarget) {
  const data = ensureGuestStore(store, config);
  const res = resolveRecipient(store, config, rawTarget);
  if (!res.ok) return res;
  const before = data.guestPolicy.blocklist.length;
  data.guestPolicy.blocklist = data.guestPolicy.blocklist.filter((n) => n !== res.number);
  store?.save?.();
  return { ok: true, wasBlocked: data.guestPolicy.blocklist.length < before, ...res };
}

export function setGuestMode(store, config, rawMode) {
  const data = ensureGuestStore(store, config);
  const mode = normalizeGuestMode(rawMode);
  data.guestPolicy.mode = mode;
  data.guestPolicy.requireApproval = mode === 'approval';
  store?.save?.();
  return mode;
}

/**
 * Decide whether a non-owner sender is allowed to interact with the agent's
 * conversational guest pipeline.
 */
export function canGuestInteract(store, config = {}, rawSenderNumber = '', opts = {}) {
  const data = ensureGuestStore(store, config);
  const policy = data.guestPolicy;
  const number = normalizeNumber(rawSenderNumber);

  if (policy.mode === 'off') {
    return { allowed: false, reason: 'guest_mode_off', number };
  }
  if (!number) {
    return { allowed: false, reason: 'unknown_number', number: '' };
  }
  if (policy.blocklist.includes(number)) {
    return { allowed: false, reason: 'blocked', number };
  }
  const contact = findContactByNumber(store, number, config);
  if (policy.mode === 'contacts') {
    const inAllowlist = policy.allowlist.includes(number);
    if (!contact && !inAllowlist) {
      return { allowed: false, reason: 'not_in_contacts', number };
    }
  }

  // Per-guest rate limiting (protects AI quota & prevents spam loops)
  const rateMap = opts instanceof Map ? opts : opts?.rateMap;
  if (rateMap instanceof Map) {
    const now = opts?.now ?? Date.now();
    const prev = (rateMap.get(number) ?? []).filter((t) => now - t < 60_000);
    if (prev.length >= policy.rateLimitPerMinute) {
      rateMap.set(number, prev);
      return { allowed: false, reason: 'rate_limited', number, contact };
    }
    prev.push(now);
    rateMap.set(number, prev);
  }

  return {
    allowed: true,
    reason: 'ok',
    number,
    contact,
    mode: policy.mode,
  };
}

// ── Strict Owner-Only Command Firewall ───────────────────────────────────────
//
// Blocks ALL `/` slash commands AND all non-slash natural language commands
// (PC control, app launch/close, screenshots, files, shell, network, power,
// reminders, notes, todos, owner memory/persona/facts, outbound messaging,
// voice calls, DeepSeek Harness, etc.) when sent by anyone other than the owner.

const AFFIRM_OR_DENY_RE = /^(?:yes|y|ya|haan|han|ha|karo|kar\s*do|kardo|confirm|theek\s*hai|thik\s*hai|no|n|nahi|nah|nope|cancel|mat\s*karo|हाँ|हां|हा|करो|ठीक\s*है|रद्द|ना|नहीं)[.!\s]*$/i;

// Conversational / polite command phrasings that might exceed 5 words or carry
// a question mark so `nlp.parseIntent` wouldn't catch them on its own.
const EXTENDED_COMMAND_PATTERNS = [
  {
    cmd: '/screenshot',
    re: /\b(?:take\s+a?\s*screenshot|send\s+(?:me\s+)?(?:a\s+)?screenshot|screenshot\s+(?:le|bhej|dikha)|screen\s*shot\s+(?:le|bhej|dikha)|screen\s+ka\s+photo|capture\s+(?:the\s+)?screen|what(?:'s|\s+is)\s+on\s+(?:the|your|his|owner(?:'s)?|pavit(?:'s)?)\s+screen|screen\s+(?:pe|par)\s+kya\s+(?:chal|dikh|hai)|webcam\s+(?:photo|pic|on)|record\s+(?:the\s+)?screen)\b/i,
  },
  {
    cmd: '/open',
    re: /\b(?:(?:can\s+you|please|pls|plz|bhai|zara)\s+)?(?:open|launch|start|close|quit|kill)\s+(?:the\s+)?(?:chrome|firefox|brave|browser|terminal|vscode|vs\s*code|spotify|vlc|settings|calculator|files|nautilus|code|discord|slack|telegram|zoom|obs|gimp|libreoffice)\b/i,
  },
  {
    cmd: '/open',
    re: /\b(?:chrome|firefox|brave|terminal|vscode|vs\s*code|spotify|vlc|settings|browser)\s+(?:ko\s+)?(?:khol(?:o|do|de|na|iye)?|open\s+kar(?:o|do|na)?|band\s+kar(?:o|do|na)?|chalu\s+kar(?:o|do|na)?|launch\s+kar(?:o|do)?)\b/i,
  },
  {
    cmd: '/pc',
    re: /\b(?:shut\s*down|power\s*off|reboot|restart|suspend|sleep|lock|unlock)\s+(?:the\s+|your\s+|his\s+)?(?:pc|computer|laptop|system|machine|screen|desktop)\b/i,
  },
  {
    cmd: '/pc',
    re: /\b(?:pc|computer|laptop|system|desktop)\s+(?:ko\s+)?(?:band|shutdown|shut\s*down|power\s*off|reboot|restart|lock|sleep|suspend)(?:\s+kar(?:o|do|de|na)?)?\b/i,
  },
  {
    cmd: '/pc',
    re: /^(?:(?:can\s+you|please|pls|bhai)\s+)?(?:type|paste|click(?:\s+on)?|tap(?:\s+on)?|press|scroll)\s+\S+/i,
  },
  {
    cmd: '/pc',
    re: /\b(?:(?:change|set|increase|decrease|lower|raise|mute|unmute)\s+(?:the\s+)?(?:volume|sound|audio|brightness)|(?:volume|awaaz|aawaz|brightness|chamak)\s+(?:ko\s+)?(?:kam|zyada|badha|ghata|mute|full|zero|\d+\s*%?)\s*(?:kar(?:o|do|de|na)?)?)\b/i,
  },
  {
    cmd: '/wifi',
    re: /\b(?:(?:turn\s+(?:on|off)|enable|disable|disconnect|connect)\s+(?:the\s+)?(?:wifi|wi-fi|bluetooth|hotspot)|(?:wifi|wi-fi|bluetooth)\s+(?:ko\s+)?(?:on|off|band|chalu)\s+kar(?:o|do|de|na)?)\b/i,
  },
  {
    cmd: '/ls',
    re: /\b(?:(?:show|list|read|delete|remove|erase|send|upload|download|zip|unzip|move|copy|rename)\s+(?:me\s+)?(?:all\s+|the\s+|your\s+|his\s+|owner(?:'s)?\s+)?(?:file|files|folder|folders|directory|directories|downloads?|documents?|desktop|~\/\S*|\/home\/\S*|\/etc\/\S*|\.env|store\.json|auth_info)|(?:files?|folders?|downloads?)\s+(?:dikhao|bhejo|delete\s+kar(?:o|do)?|hata\s*do|list\s+kar(?:o|do)?))\b/i,
  },
  {
    cmd: '/run',
    re: /\b(?:(?:run|execute)\s+(?:this\s+|a\s+|the\s+)?(?:shell|bash|terminal|linux|command|script)|terminal\s+me(?:in)?\s+.+\s+chalao|shell\s+command\s+chalao)\b/i,
  },
  {
    cmd: '/dsh',
    re: /\b(?:deepseek\s+harness|dsh\s+(?:web|agent|run|install|mode|auto))\b/i,
  },
  {
    cmd: '/remind',
    re: /\b(?:remind\s+me|set\s+a?\s*reminder|add\s+a?\s*reminder|(?:mujhe\s+)?yaad\s+dila(?:na|o|de)|reminder\s+laga(?:o|do)|alarm\s+laga(?:o|do))\b/i,
  },
  {
    cmd: '/todo',
    re: /\b(?:add\s+(?:to\s+)?(?:my\s+)?to-?do|create\s+a?\s*to-?do|save\s+a?\s*note|write\s+a?\s*note|note\s+kar\s+lo|todo\s+(?:list|add|dikhao)|mere\s+(?:notes?|todos?|reminders?|tasks?)\s+(?:dikhao|batao))\b/i,
  },
  {
    cmd: '/memory',
    re: /\b(?:(?:owner|pavit|malik|boss)\s+(?:ka|ki|ke)\s+(?:naam|number|phone|password|pin|wifi|address|location|email|notes?|todos?|reminders?|files?|secrets?|memory|profile|behaviour|behavior)|(?:tumhara|aapka|tera)\s+(?:owner|malik|boss)\s+kaun\s+hai|what\s+do\s+you\s+know\s+about\s+(?:the\s+)?(?:owner|pavit)|(?:what\s+is|tell\s+me|show\s+me|give\s+me)\s+(?:the\s+)?(?:owner(?:'s)?|your\s+owner(?:'s)?|saved)\s+(?:name|phone|password|pin|wifi|notes?|todos?|reminders?|memory|facts?|files?|downloads?|profile))\b/i,
  },
  {
    cmd: '/msg',
    re: /\b(?:send\s+(?:a\s+)?(?:whatsapp|message|msg|dm)\s+to\s+\S+|\S+\s+ko\s+(?:whatsapp|message|msg)\s+(?:bhej(?:o|do|na)?|kar(?:o|do|na)?)|(?:block|unblock|allow)\s+(?:number|contact|\+?\d{10,15})|guest\s+mode\s+(?:on|off|all|contacts))\b/i,
  },
  {
    cmd: '/call',
    re: /\b(?:call\s+me\s+(?:now|on\s+whatsapp|at\s+\d)|mujhe\s+(?:abhi\s+)?call\s+kar(?:o|do)|schedule\s+a?\s*call|voice\s+call\s+mode\s+(?:on|off))\b/i,
  },
  {
    cmd: '/location',
    re: /\b(?:(?:send|share|tell|show|what\s+is|where\s+is)\s+(?:me\s+)?(?:your|the\s+owner(?:'s)?|his|pavit(?:'s)?|current|live)\s+(?:location|gps|coordinates|address|city|ip\s+address|whereabouts)|(?:apni|owner\s+ki|tumhari|live|current)\s+location\s+(?:bhej(?:o|do)?|bata(?:o|do)?|share\s+kar(?:o|do)?|kya\s+hai)|(?:tum|aap|owner|pavit)\s+(?:abhi\s+)?kahan\s+(?:ho|hai|rehte\s+ho)|where\s+are\s+you\s+located)\b/i,
  },
];

function checkSingleSegment(segment, store, config = {}) {
  const raw = clean(segment);
  if (!raw) return null;

  // 1. Any `/` slash command (at start of string or after polite prefix)
  const slashMatch = raw.match(/^(?:(?:please|pls|plz|bhai|bro|yaar|yr|hey|hi|hello|ok|suno)\s*,?\s+)?(\/[a-zA-Z0-9_-]+)/i);
  if (slashMatch) {
    const cmd = slashMatch[1].toLowerCase();
    return {
      blocked: true,
      category: 'slash_command',
      command: cmd,
      reason: `Slash command (${cmd}) is reserved for the owner`,
    };
  }

  // 2. Shell PIN or Control PIN prefix
  if (config.shellPin && (raw === config.shellPin || raw.startsWith(`${config.shellPin} `))) {
    return { blocked: true, category: 'pin_command', command: '/run', reason: 'Shell PIN command is owner-only' };
  }
  if (config.controlPin && (raw === config.controlPin || raw.startsWith(`${config.controlPin} `))) {
    return { blocked: true, category: 'pin_command', command: '/pc', reason: 'Control PIN command is owner-only' };
  }

  // 3. Stop / Cancel / Confirmation words
  if (isStopCommand(raw) || AFFIRM_OR_DENY_RE.test(raw)) {
    return {
      blocked: true,
      category: 'control_keyword',
      command: isStopCommand(raw) ? '/stop' : '/yes|/no',
      reason: 'Task control and confirmation commands are owner-only',
    };
  }

  // 4. Custom learned keywords or custom trigger->action rules
  if (store?.data) {
    const matchedRule = mem.matchRule(store, raw);
    if (matchedRule) {
      const cmdLabel = matchedRule.type === 'learned' ? `/${matchedRule.keyword}` : `rule:${matchedRule.rule?.trigger || 'custom'}`;
      return {
        blocked: true,
        category: 'custom_rule',
        command: cmdLabel,
        reason: 'Owner custom rules and learned macros are owner-only',
      };
    }
    const bareWord = raw.toLowerCase().replace(/^\//, '').trim();
    if (bareWord && store.getLearned?.(bareWord)) {
      return {
        blocked: true,
        category: 'learned_keyword',
        command: `/${bareWord}`,
        reason: 'Learned shortcut command is owner-only',
      };
    }
  }

  // 5. Built-in NLP intent parser (`src/nlp.js` — "chrome kholo", "screenshot bhej do", "wifi off karo", etc.)
  //    Note: pure time/date queries ("time kya hua hai") or general help? The user explicitly asked:
  //    "saari commands block hon woh sirf mere liye hai / waali commands bhi aur baaki bhi"
  //    So ANY command returned by `parseIntent` is blocked for non-owners!
  const parsed = parseIntent(raw);
  if (parsed) {
    const cmdName = parsed.cmd ? `/${parsed.cmd}` : 'intent';
    return {
      blocked: true,
      category: 'nlp_command',
      command: cmdName,
      reason: `Natural-language command (${cmdName}) is owner-only`,
    };
  }

  // Also check after unwrapping immediate override preambles ("firefox nahi chrome kholo")
  const unwrapped = mem.unwrapImmediateOverride(raw);
  if (unwrapped.bypassSaved && unwrapped.text && unwrapped.text !== raw) {
    const innerSlash = unwrapped.text.match(/^\/([a-zA-Z0-9_-]+)/);
    if (innerSlash) {
      return {
        blocked: true,
        category: 'slash_command',
        command: `/${innerSlash[1].toLowerCase()}`,
        reason: 'Slash command is owner-only',
      };
    }
    const innerParsed = parseIntent(unwrapped.text);
    if (innerParsed) {
      const cmdName = innerParsed.cmd ? `/${innerParsed.cmd}` : 'intent';
      return {
        blocked: true,
        category: 'nlp_command',
        command: cmdName,
        reason: `Natural-language command (${cmdName}) is owner-only`,
      };
    }
  }

  // 6. Quick intents in `commands.js` (`remind me`, `note:`, `todo:`, `remember`, memory queries, persona training)
  if (/^remind\s+me\b/i.test(raw)) {
    return { blocked: true, category: 'owner_intent', command: '/remind', reason: 'Reminders are owner-only' };
  }
  if (/^(?:note(?:\s+kar\s+lo)?\s*[:\-]\s*|note\s+that\s+)/i.test(raw)) {
    return { blocked: true, category: 'owner_intent', command: '/note', reason: 'Notes are owner-only' };
  }
  if (/^(?:add\s+(?:a\s+)?todo[:\s]+|todo[:\s]+)/i.test(raw)) {
    return { blocked: true, category: 'owner_intent', command: '/todo', reason: 'To-dos are owner-only' };
  }
  if (/^remember\s+(?:that\s+)?/i.test(raw) || mem.parseRuleStatement(raw) || mem.extractFact(raw, store?.data?.facts)) {
    return { blocked: true, category: 'owner_intent', command: '/remember', reason: 'Owner memory modification is owner-only' };
  }
  if (store?.data && mem.handleMemoryIntent(store, config, raw) !== undefined) {
    return { blocked: true, category: 'owner_intent', command: '/memory', reason: 'Owner personal memory is private' };
  }
  if (parseCreateCommandIntent(raw)) {
    return { blocked: true, category: 'owner_intent', command: '/learn', reason: 'Creating or deleting custom commands is owner-only' };
  }
  if (parseActionRecorderIntent(raw, { isRecording: true })) {
    return { blocked: true, category: 'owner_intent', command: '/watchme', reason: 'Recording or replaying PC actions is owner-only' };
  }

  // 7. Extended natural-language command patterns (polite/longer sentences asking to control PC/files/system/owner data)
  for (const pat of EXTENDED_COMMAND_PATTERNS) {
    if (pat.re.test(raw)) {
      return {
        blocked: true,
        category: 'natural_command',
        command: pat.cmd,
        reason: `Command (${pat.cmd}) is restricted to the owner`,
      };
    }
  }

  return null;
}

/**
 * Inspect any incoming non-owner message and determine if it is attempting
 * ANY command (`/` slash command, stacked `/` command, or natural-language
 * command / PC action / owner-data access).
 */
export function detectGuestCommandAttempt(text, store = null, config = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return { blocked: false };

  // Check multi-line messages (e.g. stacked commands or a slash command on line 2)
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith('/')) {
      const cmd = line.match(/^\/[a-zA-Z0-9_-]+/)?.[0]?.toLowerCase() || '/';
      return {
        blocked: true,
        category: 'slash_command',
        command: cmd,
        reason: `Slash command (${cmd}) is reserved for the owner`,
        reply: buildBlockedCommandReply(config, store, { category: 'slash_command', command: cmd }),
      };
    }
    const lineHit = checkSingleSegment(line, store, config);
    if (lineHit?.blocked) {
      return {
        ...lineHit,
        reply: buildBlockedCommandReply(config, store, lineHit),
      };
    }
  }

  // Check full text as a single segment
  const directHit = checkSingleSegment(raw, store, config);
  if (directHit?.blocked) {
    return {
      ...directHit,
      reply: buildBlockedCommandReply(config, store, directHit),
    };
  }

  // Check compound chains ("X aur Y", "X then Y", "X | Y")
  const chainParts = raw
    .split(/\s+(?:aur|phir|fir|uske\s+baad|iske\s+baad|and\s+then|then|aur\s+phir)\s+|\s*[|;]\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
  if (chainParts.length >= 2) {
    for (const part of chainParts) {
      const hit = checkSingleSegment(part, store, config);
      if (hit?.blocked) {
        return {
          ...hit,
          reply: buildBlockedCommandReply(config, store, hit),
        };
      }
    }
  }

  return { blocked: false };
}

export function buildBlockedCommandReply(config = {}, store = null, detection = {}) {
  const agentName = mem.getAgentName(store, config);
  const cmdTag = detection?.command ? ` (\`${detection.command}\`)` : '';
  return [
    `🔒 *Command Blocked — Owner Only*`,
    `Main *${agentName}* hoon. Yeh command${cmdTag} sirf mere owner ke liye hai.`,
    `\`/\` waali commands aur baaki saare PC/system/personal commands sirf owner chala sakte hain.`,
    `Aap mujhse normal baat-cheet (chat) ya koi general sawal pooch sakte hain! 🙂`,
  ].join('\n');
}

// ── Isolated Per-Guest History & Audit Log ───────────────────────────────────

export function recordGuestChatTurn(store, senderNumber, role, content, meta = {}) {
  if (!store?.data) return;
  const data = ensureGuestStore(store);
  const num = normalizeNumber(senderNumber) || 'guest';
  if (!data.guestChats[num]) {
    data.guestChats[num] = {
      name: meta.name || '',
      history: [],
      lastSeenTs: Date.now(),
      msgCount: 0,
      blockedCount: 0,
    };
  }
  const slot = data.guestChats[num];
  if (meta.name) slot.name = meta.name;
  slot.lastSeenTs = Date.now();
  if (role === 'user') slot.msgCount = (slot.msgCount || 0) + 1;
  slot.history.push({
    role,
    content: String(content ?? '').slice(0, 2000),
    ts: Date.now(),
  });
  if (slot.history.length > MAX_GUEST_HISTORY) {
    slot.history = slot.history.slice(-MAX_GUEST_HISTORY);
  }
  store.save?.();
}

export function getGuestHistory(store, senderNumber, limit = 8) {
  if (!store?.data) return [];
  const data = ensureGuestStore(store);
  const num = normalizeNumber(senderNumber) || 'guest';
  const list = data.guestChats[num]?.history ?? [];
  return list.slice(-limit).map(({ role, content }) => ({ role, content }));
}

export function recordGuestAudit(store, entry = {}) {
  if (!store?.data) return null;
  const data = ensureGuestStore(store);
  const num = normalizeNumber(entry.from || entry.to || '') || '';
  if (entry.kind === 'blocked_cmd' && num) {
    if (!data.guestChats[num]) {
      data.guestChats[num] = { name: entry.name || '', history: [], lastSeenTs: Date.now(), msgCount: 0, blockedCount: 0 };
    }
    data.guestChats[num].blockedCount = (data.guestChats[num].blockedCount || 0) + 1;
    data.guestChats[num].lastSeenTs = Date.now();
  }
  const item = {
    id: (data.guestAuditLog[data.guestAuditLog.length - 1]?.id ?? 0) + 1,
    ts: Date.now(),
    from: num,
    name: clean(entry.name || ''),
    kind: entry.kind || 'chat', // 'chat' | 'blocked_cmd' | 'outbound'
    command: entry.command || '',
    text: clean(entry.text || '').slice(0, 300),
    reply: clean(entry.reply || '').slice(0, 300),
  };
  data.guestAuditLog.push(item);
  while (data.guestAuditLog.length > MAX_AUDIT_LOG) {
    data.guestAuditLog.shift();
  }
  store.save?.();
  return item;
}

// ── Owner Approval Queue & Decision Parser (`yes` / `no` / `no send this instead`) ──

export function enqueueGuestApproval(store, config = {}, item = {}) {
  const data = ensureGuestStore(store, config);
  const nextId = (data.pendingGuestApprovals[data.pendingGuestApprovals.length - 1]?.id ?? 0) + 1;
  const tz = config.timezone || 'Asia/Kolkata';
  const ts = item.ts || Date.now();
  const formattedTime = new Date(ts).toLocaleString('en-IN', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  const senderNum = normalizeNumber(item.senderNumber || '');
  const senderName = clean(item.senderName || '');
  const incomingText = String(item.incomingText ?? '').trim();
  const isSaved = Boolean(findContactByNumber(store, senderNum));
  const urgency = classifyGuestMessageUrgency(incomingText, senderName, isSaved);
  const entry = {
    id: nextId,
    ts,
    formattedTime: `${formattedTime} (${tz})`,
    senderNumber: senderNum,
    senderName,
    senderJid: item.senderJid || '',
    incomingText,
    proposedReply: String(item.proposedReply ?? '').trim(),
    blockedCommand: item.blockedCommand || '',
    blockedCategory: item.blockedCategory || '',
    priority: urgency.priority,
    priorityBadge: urgency.badge,
    status: 'pending', // 'pending' | 'approved' | 'rejected' | 'custom' | 'blocked'
  };
  data.pendingGuestApprovals.push(entry);
  while (data.pendingGuestApprovals.length > 50) {
    data.pendingGuestApprovals.shift();
  }
  store?.save?.();
  return entry;
}

export function listPendingGuestApprovals(store, config = {}) {
  const data = ensureGuestStore(store, config);
  return data.pendingGuestApprovals.filter((e) => e.status === 'pending');
}

export function getActiveGuestApproval(store, config = {}, id = null) {
  const pending = listPendingGuestApprovals(store, config);
  if (!pending.length) return null;
  if (id != null && Number.isFinite(Number(id))) {
    return pending.find((e) => e.id === Number(id)) || null;
  }
  return pending[pending.length - 1];
}

export function resolveGuestApproval(store, config = {}, id = null, status = 'approved', finalReply = '') {
  const entry = getActiveGuestApproval(store, config, id);
  if (!entry) return null;
  entry.status = status;
  entry.resolvedTs = Date.now();
  entry.finalReply = finalReply;
  store?.save?.();
  return entry;
}

/**
 * Parse the owner's reply when a guest message is awaiting approval:
 *   - "yes" / "haan" / "bhej do" / "send" -> { action: 'approve' }
 *   - "no" / "nahi" / "mat bhejo" / "ignore" -> { action: 'reject' }
 *   - "no block" / "block kar do" -> { action: 'block' }
 *   - "no send this instead: <text>" / "nahi yeh bhejo: <text>" / "send instead: <text>" -> { action: 'custom', text }
 */
export function parseOwnerApprovalDecision(rawText) {
  const text = String(rawText ?? '').trim();
  if (!text || text.startsWith('/')) return null;

  let m = null;

  // 1. Custom replacement reply ("no send this instead: ...", "nahi yeh bhejo: ...", "send this instead ...", "instead send ...")
  if ((m = text.match(/^(?:no\s*,?\s*|nahi\s*,?\s*)?(?:send\s+this\s+instead|send\s+instead|instead\s+send|reply\s+instead|instead\s+reply|yeh\s+bhej(?:\s*do|\s*o)?|ye\s+bhej(?:\s*do|\s*o)?|iska\s+yeh\s+reply\s+do|isko\s+yeh\s+bhej(?:\s*do|\s*o)?)\s*(?:[:\-|,]\s*|\s+)([\s\S]+)$/i))) {
    const custom = m[1].trim().replace(/^["']|["']$/g, '');
    if (custom) return { action: 'custom', text: custom };
  }
  if ((m = text.match(/^(?:no|nahi)\s*,?\s*send\s+([\s\S]+?)(?:\s+instead)?$/i))) {
    const body = m[1].trim().replace(/^(?:this\s+instead\s*[:\-]?\s*|this\s*[:\-]\s*|instead\s*[:\-]?\s*)/i, '').replace(/^["']|["']$/g, '').trim();
    if (body && !/^(?:it|anything|nothing|mat|nahi)$/i.test(body)) {
      return { action: 'custom', text: body };
    }
  }
  if ((m = text.match(/^(?:no|nahi)\s*,?\s*(?:iske\s+badle|iski\s+jagah)?\s*([\s\S]+?)\s+(?:bhej\s*do|bhejo|send\s+kar(?:\s*do|\s*o)?)$/i))) {
    const body = m[1].trim().replace(/^(?:yeh|ye|this)\s*[:\-]?\s*/i, '').replace(/^["']|["']$/g, '').trim();
    if (body && !/^(?:mat|kuch\s+mat|nothing)$/i.test(body)) {
      return { action: 'custom', text: body };
    }
  }

  // 2. Reject + Block sender ("no block", "nahi block kar do", "block him")
  if (/^(?:(?:no|nahi)\s*,?\s*)?(?:block|block\s+him|block\s+her|block\s+kar(?:\s*do|\s*o)?|isko\s+block\s+kar(?:\s*do|\s*o)?)[.!\s]*$/i.test(text)) {
    return { action: 'block' };
  }

  // 3. Approve AI's proposed reply ("yes", "haan", "send", "bhej do", "ok", "approve")
  if (/^(?:yes|y|yeah|yep|haan|han|ha|haan\s+bhej\s*(?:do|o)|yes\s+send(?:\s+it)?|bhej\s*(?:do|o)|send(?:\s+it|\s+reply)?|approve|ok|okay|theek\s*hai|thik\s*hai|kar\s*do|kardo|हाँ|हां|भेज\s*दो)[.!\s]*$/i.test(text)) {
    return { action: 'approve' };
  }

  // 4. Reject / Do not send anything ("no", "nahi", "mat bhejo", "cancel", "ignore")
  if (/^(?:no|n|nope|nah|nahi|na|mat\s+bhej(?:o|na)|nahi\s+bhejna|dont\s+send|don't\s+send|no\s+dont\s+send|cancel|ignore|reject|skip|chhodo|rehne\s*do|ना|नहीं|मत\s*भेजो)[.!\s]*$/i.test(text)) {
    return { action: 'reject' };
  }

  return null;
}

const URGENT_GUEST_RE = /\b(?:urgent|emergency|asap|jaldi|turant|hospital|accident|doctor|police|otp|bank|exam|deadline|interview|call\s+(?:uthao|pick|back)|bahut\s+zaruri|bohot\s+zaruri|important|help\s+needed)\b/i;
const VIP_NAME_RE = /\b(?:mom|maa|mummy|dad|papa|pitaji|brother|bhai|sister|didi|boss|prof|professor|dean|hod)\b/i;

export function classifyGuestMessageUrgency(text, senderName = '', isSavedContact = false) {
  const s = String(text ?? '').trim();
  const name = String(senderName ?? '').trim();
  const isUrgent = URGENT_GUEST_RE.test(s);
  const isVip = VIP_NAME_RE.test(name) || isSavedContact;
  if (isUrgent && isVip) return { priority: 'critical', badge: '🚨⭐ *URGENT + VIP CONTACT*', score: 100 };
  if (isUrgent) return { priority: 'urgent', badge: '🚨 *URGENT PRIORITY*', score: 80 };
  if (isVip) return { priority: 'vip', badge: '⭐ *VIP / SAVED CONTACT*', score: 50 };
  return { priority: 'normal', badge: '', score: 10 };
}

export function formatApprovalCardForOwner(entry, config = {}) {
  const who = entry.senderName
    ? `*${entry.senderName}* (\`+${entry.senderNumber}\`)`
    : `\`+${entry.senderNumber}\``;
  const cmdAlert = entry.blockedCommand
    ? `\n🚨 *Command Attempt Blocked:* \`${entry.blockedCommand}\` _(Non-owners cannot run commands 🔒)_`
    : '';
  const priorityLine = entry.priorityBadge ? `🏷️ *Triage:* ${entry.priorityBadge}` : '';

  return [
    `📨 *Incoming Message — Waiting for Your Approval* (#${entry.id})`,
    priorityLine,
    `👤 *Who Sent:* ${who}`,
    `🕐 *Time:* ${entry.formattedTime}`,
    `💬 *Their Message:* "${entry.incomingText}"${cmdAlert}`,
    '',
    `🤖 *AI Thinking of Sending:*`,
    `"${entry.proposedReply}"`,
    '',
    `⚡ *What should I do? (Reply directly):*`,
    `• Reply *yes* (ya *haan*) — Send this AI reply`,
    `• Reply *no* (ya *nahi*) — Don't send anything`,
    `• Reply *no send this instead: <your message>* (ya *nahi yeh bhejo: <message>*) — Send your custom message instead!`,
    `• Reply *no block* — Ignore & block this number`,
  ].filter(Boolean).join('\n');
}

export function formatPendingApprovalsList(store, config = {}) {
  const pending = listPendingGuestApprovals(store, config);
  if (!pending.length) {
    return '✅ *Pending Guest Approvals:* Abhi koi message approval ke liye pending nahi hai.';
  }
  const lines = pending.map((e) => {
    const who = e.senderName ? `*${e.senderName}* (+${e.senderNumber})` : `+${e.senderNumber}`;
    return [
      `*#${e.id}* · 👤 ${who} · 🕐 ${e.formattedTime}`,
      `   💬 Sent: "${e.incomingText.slice(0, 100)}"`,
      `   🤖 AI Draft: "${e.proposedReply.slice(0, 120)}"`,
    ].join('\n');
  });
  return [
    `📨 *Pending Guest Messages (${pending.length})*`,
    '',
    ...lines,
    '',
    '_Reply *yes*, *no*, or *no send this instead: <text>* for the latest message, or use `/approve <id> [custom text]` / `/reject <id>`_ ',
  ].join('\n');
}

// ── Human-Readable Reports for Owner (`/guest`, `/contacts`, `/guest log`) ──

export function formatContactsList(store, config = {}) {
  const contacts = listContacts(store, config);
  if (!contacts.length) {
    return [
      '📇 *Saved Contacts* — abhi koi contact save nahi hai.',
      '',
      '*Save karne ke liye:*',
      '• `/contact add Rahul 9876543210`',
      '• `/contact add Mom +91 98765 00000`',
      '',
      'Uske baad seedha `/msg Rahul <message>` ya `"Rahul ko message bhejo..."` likh sakte ho!',
    ].join('\n');
  }
  return [
    `📇 *Saved Contacts (${contacts.length})*`,
    '',
    ...contacts.map((c, idx) => `${idx + 1}. *${c.name}* — \`+${c.number}\``),
    '',
    '_Send message: `/msg <name> <text>` · Delete: `/contact del <name>`_ ',
  ].join('\n');
}

export function formatGuestStatus(store, config = {}) {
  const data = ensureGuestStore(store, config);
  const p = data.guestPolicy;
  const contacts = listContacts(store, config);
  const pending = listPendingGuestApprovals(store, config);
  const stats = store?.data?.stats ?? {};
  const modeLabel = p.mode === 'approval' || p.requireApproval
    ? '🛡️ *OWNER APPROVAL (Moderated)* — Har guest message pehle aapko aayega (Who + Time + AI Draft) taaki aap *yes / no / send instead* bol sako'
    : p.mode === 'all'
    ? '🟢 *AUTO-REPLY (ALL)* — Sabse baat kar sakta hai · Commands 100% Owner-Only 🔒'
    : p.mode === 'contacts'
    ? '🟡 *CONTACTS ONLY* — Sirf saved contacts & allowed numbers · Commands 100% Owner-Only 🔒'
    : '🔴 *OFF* — Sirf Owner · Non-owners ko silent ignore';

  const last = data.lastGuestSender;
  const lastLine = last?.number
    ? `• Last guest: *${last.name || `+${last.number}`}* (\`+${last.number}\`) — reply via \`/reply <msg>\``
    : '• Last guest: _abhi tak koi nahi_';

  return [
    '🛡️ *Controlled Multi-User Messaging & Command Firewall*',
    `• Mode: ${modeLabel}`,
    `• Command Lock: 🔒 *STRICT* — \`/\` waali commands aur saari natural commands sirf aapke (+${config.ownerNumber}) liye hain`,
    `• Location Lock: 📍 *OWNER-ONLY* — Aapki location sirf aapke liye active hai; guests ke liye 100% blocked`,
    `• Pending Approvals: *${pending.length}* waiting (\`/pending\` se dekhein)`,
    `• Guest Rate Limit: *${p.rateLimitPerMinute} msgs/min* per person · AI Tier Cap: *standard* (zero PC tools, zero owner memory leak)`,
    p.customAutoReply ? `• Custom Auto-Reply: "${p.customAutoReply}"` : '• Reply Brain: *Sandboxed Guest AI* (safe chat + Q&A)',
    `• Contacts: *${contacts.length}* saved · Allowed: *${p.allowlist.length}* · Blocked: *${p.blocklist.length}*`,
    `• Stats: *${stats.guestMessagesIn || 0}* guest msgs in · *${stats.guestRepliesOut || 0}* replies · *${stats.blockedGuestCommands || 0}* commands blocked · *${stats.outboundToOthers || 0}* outbound sent`,
    lastLine,
    '',
    '*Owner Controls (sirf aapke liye):*',
    '• `/guest approval` — (Default) Har guest reply bhejne se pehle aapse *yes / no / send instead* poochega',
    '• `/guest auto` (ya `/guest all`) — Bina pooche automatic safe AI reply bhejega',
    '• `/guest contacts` · `/guest off` — Contacts-only ya poora band',
    '• `/pending` · `/approve [id] [text]` · `/reject [id]` — Pending guest replies control karo',
    '• `/msg <number|name> | <text>` · `/reply <text>` — Kisi ko bhi message bhejo',
    '• `/contact add <name> <number>` · `/contacts` — Contact book',
    '• `/allow <num|name>` · `/block <num|name>` · `/unblock <num|name>`',
  ].join('\n');
}

export function formatGuestLog(store, config = {}, filterTarget = '') {
  const data = ensureGuestStore(store, config);
  const tz = config.timezone || 'Asia/Kolkata';
  let entries = [...data.guestAuditLog];
  if (filterTarget) {
    const resolved = resolveRecipient(store, config, filterTarget);
    const num = resolved.ok ? resolved.number : normalizeNumber(filterTarget);
    const low = filterTarget.toLowerCase();
    entries = entries.filter((e) => (num && e.from === num) || e.name.toLowerCase().includes(low));
  }
  if (!entries.length) {
    return '📋 *Guest & Outbound Activity Log* — abhi tak koi entry nahi hai.';
  }
  const recent = entries.slice(-15).reverse();
  const lines = recent.map((e) => {
    const when = tools.formatDateTime(e.ts, tz);
    const who = e.name ? `${e.name} (+${maskNumber(e.from)})` : `+${maskNumber(e.from)}`;
    if (e.kind === 'blocked_cmd') {
      return `🔒 [${when}] *BLOCKED* ${who} tried ${e.command || 'command'}: "${e.text.slice(0, 80)}"`;
    }
    if (e.kind === 'outbound') {
      return `📤 [${when}] *TO* ${who}: "${e.text.slice(0, 100)}"`;
    }
    return `💬 [${when}] *FROM* ${who}: "${e.text.slice(0, 70)}" → "${e.reply.slice(0, 70)}"`;
  });
  return [
    `📋 *Guest & Messaging Activity Log (last ${recent.length})*`,
    '',
    ...lines,
  ].join('\n');
}
