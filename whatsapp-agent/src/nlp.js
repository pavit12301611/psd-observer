// nlp.js — offline intent parsing, so the agent can ACT on plain messages even
// with no AI brain installed at all. This is the "free forever" layer:
//
//   "chrome kholo"          → /open chrome
//   "screenshot bhej do"    → /screenshot
//   "awaaz kam karo"        → /pc volume down
//   "wifi band karo"        → /wifi off
//   "thesis.pdf dhundo"     → /pc find thesis.pdf
//   "screen pe kya hai"     → /look
//   "terminal me df -h chalao" → /run df -h
//
// It is a pure function returning a command the command router already knows,
// or null. AI tool-calling (agentloop.js) handles everything beyond this list.

import { extractFact, parseRuleStatement, unwrapImmediateOverride } from './memory.js';
import { normalizeVocabText, parseVocabIntent } from './vocab.js';
import { parseAccuracyIntent } from './accuracy.js';

/** Short questions that only *look* like commands ("open source kya hai?"). */
const QUESTION_WORDS = /\b(kya|kaise|kyun|kyu|kab|kahan|kaun|kitna|kitni|what|who|why|how|when|where|which|explain|samjhao|matlab|meaning)\b/i;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const stripPoliteness = (s) => clean(s)
  .replace(/^(?:please|pls|plz|bhai|bro|yaar|yr|suno|hey|ok|arre|arey|oye|boss|sir)\b[, ]*/i, '')
  .replace(/\s+(?:please|pls|plz|bhai|bro|yaar|yr|boss|sir)$/i, '')
  .trim();

const asCmd = (cmd, args = '') => ({ cmd, args });
const looksLikeChat = (rest) => QUESTION_WORDS.test(rest) || /\?$/.test(rest) || clean(rest).split(' ').length > 5;

/**
 * Parse a plain (non-slash) message into {cmd,args} | {reply} | null.
 * `null` means "not one of my fast intents — let the AI handle it".
 */
export function parseIntent(input) {
  const original = clean(input);
  if (!original || original.length > 500) return null;

  // ── Memory & custom rules ("mera naam Pavit hai", "agar main X kahun to Y karo") ──
  if (parseRuleStatement(original) || extractFact(original)) {
    return asCmd('remember', original);
  }

  // ── 100% Answer Accuracy & Verification ("verify karo: ...", "100% sahi answer batao: ...", "accuracy status") ──
  const accIntent = parseAccuracyIntent(original);
  if (accIntent) {
    return asCmd(accIntent.cmd, accIntent.args);
  }

  // ── Vocabulary, Word-Power, Synonyms, Definitions, Rewrite & Translation ──
  const vocabIntent = parseVocabIntent(original);
  if (vocabIntent) {
    if (vocabIntent.mode === 'wod') return asCmd('vocab', 'daily');
    if (vocabIntent.mode === 'synonyms') return asCmd('vocab', `synonyms ${vocabIntent.word}`);
    if (vocabIntent.mode === 'antonyms') return asCmd('vocab', `antonyms ${vocabIntent.word}`);
    if (vocabIntent.mode === 'define') return asCmd('vocab', vocabIntent.word);
    if (vocabIntent.mode === 'rewrite') return asCmd('vocab', `rewrite ${vocabIntent.text}`);
    if (vocabIntent.mode === 'translate') return asCmd('vocab', `translate ${vocabIntent.targetLang} | ${vocabIntent.text}`);
  }

  // ── Immediate overrides ("firefox nahi chrome kholo", "is baar chrome kholo") ──
  const unwrapped = unwrapImmediateOverride(original);
  const rawStripped = stripPoliteness(unwrapped.text);
  const text = normalizeVocabText(rawStripped);
  const low = text.toLowerCase();
  if (!text) return null;
  let m;

  // ── DeepSeek Harness (before app open/close so "harness web kholo" routes cleanly) ──
  if (/^(?:dsh|deepseek\s+harness|harness)\s*(?:status|kya\s+haal|check)?\??$/i.test(text)) {
    return asCmd('dsh', 'status');
  }
  if (/^(?:dsh\s+web|deepseek\s+harness\s+web|harness\s+web)(?:\s+(open|kholo|khol|start|chalu|stop|band))?(?:\s+kar(?:o|do))?$/i.test(text)) {
    const sub = (text.match(/\b(open|kholo|khol|stop|band)\b/i)?.[1] || 'start').toLowerCase();
    return asCmd('dsh', `web ${/open|khol/.test(sub) ? 'open' : /stop|band/.test(sub) ? 'stop' : 'start'}`);
  }
  if ((m = text.match(/^(?:dsh\s+(?:se|me|mein)|harness\s+(?:se|me|mein)|deepseek\s+harness\s+(?:se|me|mein))\s+([\s\S]+)$/i))) {
    return asCmd('dsh', clean(m[1]));
  }

  // ── Question Solver (MUST run before generic `screen pe` -> `/look` rule!) ──
  if (/\b(?:screen\s*(?:pe|ka|ki|ke|par)|on\s*(?:my\s*)?screen)\b.*\b(?:question|questions|mcq|quiz|test|solve|answer|jawab|hal)\b/i.test(text)
      || /\b(?:solve|answer)\b.*\b(?:question|questions|mcq|problem)s?\s+(?:on|from)\s+(?:the\s+|my\s+)?screen\b/i.test(text)) {
    return asCmd('solve', `screen ${text}`);
  }
  if (/^(?:pichli|pichhli|last|previous|ye|is|iss)\s+(?:photo|image|pic|screenshot|paper|sheet)\s+(?:(?:ka|ke|ki|ko|wali|wale)\s+)?(?:question|questions|sawal|answer|answers|solve|hal)(?:\s+[\s\S]*)?$/i.test(text)) {
    return asCmd('solve', text);
  }

  // ── Offline / Sleeping auto-notification control ──────────────────────────
  if ((m = text.match(/^(?:sleep(?:ing)?|offline)\s+(?:message|msg|notify|notification|alert)(?:\s+(on|off|active|activate|enable|disable|chalu|band|test|check|preview|status|reset))?(?:\s+kar(?:o|do))?$/i))) {
    const act = (m[1] || 'status').toLowerCase();
    const mapped = ['on', 'active', 'activate', 'enable', 'chalu'].includes(act) ? 'on'
      : ['off', 'disable', 'band'].includes(act) ? 'off'
      : ['test', 'check', 'preview'].includes(act) ? 'test'
      : act === 'reset' ? 'reset' : 'status';
    return asCmd('sleepnotify', mapped);
  }

  // ── Self-Evolving Persona & Behavioral Training ───────────────────────────
  if (/^(?:persona|my\s+persona|my\s+profile|owner\s+profile|mera\s+(?:behaviour|behavior|swabhav|profile|persona)(?:\s+(?:kaisa\s+hai|batao|dikhao))?|(?:tu|tum)\s+mujhe\s+kitna\s+(?:jaant[ae]|samajht[ae])\s+h(?:o|ai)|mere\s+baare\s+me(?:in)?\s+kya\s+samjha|how\s+well\s+do\s+you\s+know\s+me)[?!.।]*$/i.test(text)) {
    return asCmd('persona', 'status');
  }
  if (/\b(?:meri\s+chats?\s+se\s+(?:train|seekh)|khud\s+ko\s+train\s+kar|train\s+(?:yourself|from\s+my\s+chats?)|hinglish\s+(?:ki\s+)?practice\s+kar|english\s+(?:bhi\s+)?perfect\s+kar|hinglish\s+aur\s+english\s+train\s+kar)\b/i.test(text)) {
    return asCmd('train', text);
  }

  // ── app control ───────────────────────────────────────────────────────────
  if ((m = text.match(/^(?:open|launch|khol(?:o|do|de)?|chalu\s+kar(?:o|do)?|start)\s+(?:the\s+|app\s+)?(.+)$/i))) {
    const rest = clean(m[1]).replace(/\s+(?:app|application)$/i, '').replace(/\s+(?:karo|kar do|kholo|khol do)$/i, '');
    if (rest && !looksLikeChat(rest)) return asCmd('open', rest);
  }
  if ((m = text.match(/^(?:open|launch)\s+(?:karo|kar\s+do)\s+(.+)$/i))) return asCmd('open', clean(m[1]));
  if ((m = text.match(/^(.{2,40}?)\s+(?:khol(?:o|do|de)|khol\s+do|chalu\s+kar(?:o|do))$/i))) {
    const rest = clean(m[1]);
    if (!looksLikeChat(rest) && !/^(?:screen|pc|window|windows|app|apps)$/i.test(rest)) return asCmd('open', rest);
  }
  // Suffix English open: "chrome open karo", "firefox open kar do", "vs code open karo"
  if ((m = text.match(/^(.{2,40}?)\s+(?:open|launch)(?:\s+(?:karo|kar\s*do|kholo|khol\s*do))?$/i))) {
    const rest = clean(m[1]);
    if (rest && !looksLikeChat(rest) && !/^(?:the|app|application)$/i.test(rest)) return asCmd('open', rest);
  }
  if ((m = text.match(/^(?:close|quit|exit|band\s*kar(?:o|do)?)\s+(?:the\s+|app\s+)?(.+)$/i))) {
    const rest = clean(m[1]);
    if (!looksLikeChat(rest) && !/^(?:pc|screen|system|wifi|wi-fi|bluetooth|bt|music|song|gaana|volume|awaaz|notification)$/i.test(rest)) return asCmd('close', rest);
  }
  if ((m = text.match(/^(.{2,40}?)\s+(?:band\s*kar(?:o|do)|close\s*kar(?:o|do))$/i))) {
    const rest = clean(m[1]);
    if (!/^(?:pc|screen|wifi|wi-fi|bluetooth|bt|music|song|gaana|volume|awaaz)$/i.test(rest)) return asCmd('close', rest);
  }
  if (/^(?:apps|app\s*list|installed\s+apps|kaunse\s+apps|apps?\s+dikhao)$/i.test(text)) return asCmd('apps');
  if (/^(?:windows?|open\s+windows?|window\s*list)(?:\s+(?:dikhao|list))?$/i.test(text)) return asCmd('windows');
  if ((m = text.match(/^(?:focus|switch\s+to|window)\s+(.+)$/i))) return asCmd('focus', clean(m[1]));

  // ── screen ────────────────────────────────────────────────────────────────
  if (/^(?:screenshot|screen\s?shot|ss)(?:\s+(?:bhej(?:o|\s*do)?|le(?:\s*lo)?|kheench(?:o)?|send|abhi|now))?$/i.test(text)
    || /^(?:screen|screen\s*ka\s*photo)\s+(?:bhej(?:o|\s*do)?|dikhao|le\s*lo)$/i.test(text)
    || /^(?:screenshot|screen\s?shot|ss)\s+(?:bhej(?:o|\s*do)?|le(?:\s*lo)?|kheench(?:o)?)$/i.test(text)) return asCmd('screenshot');
  if (/^(?:ocr|read\s+screen\s+text|screen\s+text|screen\s+padho)$/i.test(text)) return asCmd('ocr');
  if (/^screen\s+(?:pe|par|mein|me)\s+kya\b/i.test(text)) return asCmd('look', '');
  if (/^(?:what(?:'s| is) on (?:my |the )?screen|look at (?:my |the )?screen|screen\s+(?:pe|par|mein|me)\s+kya|screen\s+kya\s+(?:hai|dikh|chal)|screen\s+(?:dekho|batao|read\s+karo))\b/i.test(text)
    || /^screen\b.*\b(?:kya|what)\b/i.test(text)) {
    const question = text.replace(/^(?:what(?:'s| is) on (?:my |the )?screen|look at (?:my |the )?screen|screen\s+(?:dekho|batao|padho))\s*/i, '').trim();
    return asCmd('look', question);
  }

  // ── input ─────────────────────────────────────────────────────────────────
  if ((m = text.match(/^(?:type\s+kar\s+do|type\s+karo|type|likho|likh\s+do)\s+([\s\S]+)$/i))) return asCmd('pc', `type ${m[1]}`);
  // Long / multi-line text is far more reliable through the clipboard.
  if ((m = text.match(/^(?:paste\s+kar\s+do|paste|chipka\s+do|chipkao|baithao)\s+([\s\S]+)$/i))) return asCmd('pc', `paste ${m[1]}`);
  if ((m = text.match(/^(?:press|key|key\s+dabao|press\s+karo)\s+([\w+]+)$/i))) return asCmd('pc', `key ${m[1]}`);
  if ((m = text.match(/^(?:click|tap|dabao|click\s+karo)\s+(?:on\s+)?(.+)$/i))) {
    const rest = clean(m[1]);
    if (/^-?\d+\s+-?\d+$/.test(rest)) return asCmd('pc', `click ${rest}`);
    if (rest && !looksLikeChat(rest)) return asCmd('pc', `tap ${rest}`);
  }

  // ── sound / brightness / media ────────────────────────────────────────────
  if ((m = text.match(/^(?:set\s+)?(?:volume|awaaz|aawaz|sound|वॉल्यूम)\s*(?:to|pe|par|ko)?\s*(\d{1,3})\s*%?(?:\s*(?:pe|par)?\s*(?:kar(?:\s*do|\s*o)?|set\s*kar(?:\s*do|\s*o)?))?$/i))) return asCmd('pc', `volume ${m[1]}`);
  if (/^(?:volume|awaaz|aawaz|sound)\s+(?:up|badhao|increase|raise|badha\s+do)$/i.test(text)
    || /^(?:volume|awaaz|aawaz)\s+(?:ko\s+)?(?:up|badhao|increase)$/i.test(text)) return asCmd('pc', 'volume up');
  if (/^(?:volume|awaaz|aawaz|sound)\s+(?:down|kam|decrease|lower)\b/i.test(text)
    || /^(?:volume|awaaz|aawaz)\s+(?:ko\s+)?(?:kam|down)\s+kar(?:o|do)$/i.test(text)) return asCmd('pc', 'volume down');
  if (/^(?:mute|unmute|silent\s+kar(?:o|do)?)$/i.test(text)) return asCmd('pc', 'volume mute');
  if (/^(?:volume|awaaz|aawaz)\s*(?:kya|kitni|status|batao)?\s*(?:hai)?\??$/i.test(low)) return asCmd('pc', 'volume');
  if ((m = text.match(/^(?:set\s+)?(?:brightness|screen\s+brightness|screen\s+ki\s+brightness|chamak)\s*(?:to|pe|par|ko)?\s*(\d{1,3})\s*%?(?:\s*(?:pe|par)?\s*(?:kar(?:\s*do|\s*o)?|set\s*kar(?:\s*do|\s*o)?))?$/i))) return asCmd('pc', `brightness ${m[1]}`);
  if (/^(?:brightness|chamak)\s+(?:up|badhao|increase)$/i.test(text)) return asCmd('pc', 'brightness up');
  if (/^(?:brightness|chamak)\s+(?:down|kam|decrease)$/i.test(text)) return asCmd('pc', 'brightness down');
  if (/^(?:brightness|chamak)\s*(?:kya|kitni|status)?\s*(?:hai)?\??$/i.test(low)) return asCmd('pc', 'brightness');
  if (/^(?:play|resume|pause|next|previous|prev|stop)\s*(?:music|song|gaana|gana|track)?$/i.test(text)) {
    return asCmd('pc', `media ${low.split(' ')[0].replace('resume', 'play').replace('previous', 'prev')}`);
  }
  if (/^(?:music|song|gaana|gana)\s+(?:play|chalao|chalu\s+kar(?:o|do))$/i.test(text)) return asCmd('pc', 'media play');
  if (/^(?:music|song|gaana|gana)\s+(?:pause|rok(?:o|do))$/i.test(text)) return asCmd('pc', 'media pause');
  if (/^(?:next|next\s+song|next\s+track|agla\s+gaana)$/i.test(text)) return asCmd('pc', 'media next');

  // ── network ───────────────────────────────────────────────────────────────
  if ((m = text.match(/^(?:wifi|wi-fi)\s+(?:connect|join|se\s+connect)\s+(\S+)(?:\s+(?:(?:password|pass|pin)\s+)?(\S+))?$/i))) {
    return asCmd('wifi', `connect ${m[1]}${m[2] ? ` ${m[2]}` : ''}`);
  }
  if ((m = text.match(/^(?:wifi|wi-fi|net|network)\s*(on|off|band|chalu|start|stop|status|kya|list|networks)?\s*(?:karo|kar do|hai)?\??$/i))) {
    const word = (m[1] ?? 'status').toLowerCase();
    const action = ['on', 'chalu', 'start'].includes(word) ? 'on'
      : ['off', 'band', 'stop'].includes(word) ? 'off'
        : ['list', 'networks'].includes(word) ? 'list' : 'status';
    return asCmd('wifi', action);
  }
  if ((m = text.match(/^(?:bluetooth|bt)\s*(on|off|band|chalu|status|kya)?\s*(?:karo|kar do|hai)?\??$/i))) {
    const word = (m[1] ?? 'status').toLowerCase();
    return asCmd('bt', ['on', 'chalu'].includes(word) ? 'on' : ['off', 'band'].includes(word) ? 'off' : 'status');
  }
  if (/^(?:ip|ip\s+address|mera\s+ip|my\s+ip|lan\s+ip)\s*(?:kya|address|batao)?\s*(?:hai)?\??$/i.test(low)) return asCmd('pc', 'ip');

  // ── system ────────────────────────────────────────────────────────────────
  if (/^(?:(?:pc\s+ki\s+|laptop\s+ki\s+)?(?:battery|charge|charging)\s*(?:(?:kya|kitni|kitna|bachi|status|batao|hai)\s*){0,3}|laptop\s+kitna\s+charge\s+hai|how\s+much\s+battery\s+is\s+left)\??$/i.test(low)) return asCmd('pc', 'battery');
  if (/^(?:disk|storage|jagah|space)\s*(?:kya|kitni|status|batao|free)?\s*(?:hai)?\??$/i.test(low)) return asCmd('pc', 'disk');
  if (/^(?:(?:ram|memory\s+usage|cpu|cpu\s+usage|cpu\s+load|system\s+load|pc\s+ka\s+haal|system\s+ka\s+haal)\s*(?:kya|kitni|kitna|status|batao|hai)?\??|uptime\??)$/i.test(low)) return asCmd('system');
  if (/^(?:time\s+kya\s+(?:hua|hai)|abhi\s+kitne\s+baje\s+hain|kitne\s+baje\s+hain|what\s+time\s+is\s+it|current\s+time|samay\s+kya\s+hua\s+hai)\??$/i.test(low)) return asCmd('time');
  if (/^(?:aaj\s+(?:kya\s+date|ki\s+tareekh|kaun\s*sa\s+din)\s*(?:hai)?|what(?:'s|\s+is)\s+today'?s\s+date|today'?s\s+date)\??$/i.test(low)) return asCmd('date');
  if (/^(?:pc|system)\s+(?:status|info)$/i.test(text) || /^system\s+status$/i.test(text)) return asCmd('pc', 'status');
  if (/^(?:process(?:es)?|top|top\s+process(?:es)?)\s*(?:dikhao|list|kya\s+chal\s+raha)?$/i.test(text)) return asCmd('pc', 'top');
  if ((m = text.match(/^(?:kill|band\s+kar(?:o|do)?\s+process|process\s+band\s+kar(?:o|do)?)\s+(.+)$/i))) return asCmd('kill', clean(m[1]));
  if ((m = text.match(/^(?:service|svc)\s+(status|restart)\s+(\S+)$/i))) return asCmd('svc', `${m[1].toLowerCase()} ${m[2]}`);
  if (/^(?:lock|screen\s+lock|lock\s+the\s+(?:pc|screen)|lock\s+kar(?:o|do)?)$/i.test(text)) return asCmd('pc', 'lock');
  if (/^(?:shutdown|shut\s+down|power\s*off|pc\s+band(?:\s+kar(?:o|do)?)?|band\s+kar\s+do\s+pc)$/i.test(text)) return asCmd('pc', 'shutdown');
  if (/^(?:reboot|restart|restart\s+pc|pc\s+restart|reboot\s+kar(?:o|do)?)$/i.test(text)) return asCmd('pc', 'reboot');
  if (/^(?:suspend|sleep|sleep\s+pc|suspend\s+kar(?:o|do)?)$/i.test(text)) return asCmd('pc', 'suspend');
  if (/^(?:notify|notification|notification\s+bhejo)\s+([\s\S]+)$/i.test(text)) {
    return asCmd('notify', text.replace(/^(?:notify|notification|notification\s+bhejo)\s+/i, ''));
  }
  if (/^(?:clipboard|clipboard\s+kya|clipboard\s+padho|clipboard\s+batao|clipboard\s+dekho)\s*(?:hai)?\??$/i.test(low)) return asCmd('pc', 'clipboard');
  if ((m = text.match(/^(?:clipboard\s+(?:me|mein)|clipboard\s+set)\s+([\s\S]+)$/i))) return asCmd('pc', `clipset ${m[1]}`);

  // ── files ─────────────────────────────────────────────────────────────────
  if ((m = text.match(/^(?:read|cat|padho|khol\s+ke\s+padho)\s+(~?\/?[\w.@%+,\- /]+\.\w+)$/i))) return asCmd('read', m[1]);
  // Hinglish puts the file first: "report.pdf padho".
  if ((m = text.match(/^(.+?\.\w{1,6})\s+(?:padho|read\s+kar(?:o|do)|dikhao|khol\s+ke\s+dikhao)$/i))) return asCmd('read', clean(m[1]));
  if ((m = text.match(/^(?:ls|dir|list\s+files?|files?\s+(?:dikhao|list|batao))\s*(.*)$/i))) {
    const target = clean(m[1]).replace(/^(?:in|of|me|mein)\s+/i, '');
    return asCmd('ls', target || '~');
  }
  if ((m = text.match(/^(.+?)\s+(?:me|mein|folder\s+me(?:in)?)\s+kya\s+(?:hai|he)\??$/i))) return asCmd('ls', clean(m[1]));
  if ((m = text.match(/^(?:save|write|likh(?:\s+do)?)\s+(?:this\s+)?(?:to\s+)?(.+?\.\w+)\s*(?:mein|me|:)\s*([\s\S]+)$/i))) return asCmd('write', `${m[1]} | ${m[2]}`);
  if ((m = text.match(/^(?:file\s+)?(?:banao|create|make)\s+(?:a\s+file\s+)?(.+?\.\w+)\s*(?:mein|me|with|:)\s*([\s\S]+)$/i))) {
    return asCmd('write', `${m[1]} | ${m[2]}`);
  }
  if ((m = text.match(/^(.+?\.\w+)\s+me(?:in)?\s+([\s\S]+?)\s+(?:likho|likh\s+do|save\s+kar(?:o|do))$/i))) {
    return asCmd('write', `${m[1]} | ${m[2]}`);
  }
  if ((m = text.match(/^(?:find|search|dhundo|dhoondo|khojo|locate\s+file)\s+(?:file\s+)?(.+)$/i))) {
    const rest = clean(m[1]);
    // "find meaning of life" is a question; "find thesis.pdf" is a file.
    if (!looksLikeChat(rest) || /\.\w{1,5}$/.test(rest)) return asCmd('pc', `find ${rest}`);
  }
  if ((m = text.match(/^(.+?)\s+(?:dhundo|dhoondo|khojo|find\s+karo)$/i))) {
    const rest = clean(m[1]);
    if (/\.[a-z0-9]{1,5}$/i.test(rest) || !looksLikeChat(rest)) return asCmd('pc', `find ${rest}`);
  }
  if ((m = text.match(/^(?:download|download\s+karo|ye\s+download\s+karo|link\s+download\s+karo)\s+(https?:\/\/\S+)(?:\s+(.+))?$/i))) {
    return asCmd('download', `${m[1]}${m[2] ? ` ${m[2]}` : ''}`);
  }
  if ((m = text.match(/^(?:webcam|camera)\s*(?:se\s+)?(?:photo|pic|snap|picture)?\s*(?:lo|le|bhej(?:o|do)?|kheench(?:o)?)?$/i)) && (/\b(?:photo|pic|snap|picture)\b/i.test(text) || /\bwebcam\b/i.test(text))) {
    return asCmd('webcam');
  }
  if ((m = text.match(/^(?:record|screen\s+record(?:ing)?)\s*(\d+)?\s*(?:sec(?:onds?)?|s)?\s*(?:karo|kar\s+do|of\s+the\s+screen)?$/i))) {
    return asCmd('record', m[1] ? String(m[1]) : '10');
  }
  if ((m = text.match(/^(?:rename|move|mv)\s+(.+?)\s+(?:to|ko|me|mein)\s+(.+)$/i))
    || (m = text.match(/^(.+?)\s+ko\s+(.+?)\s+(?:me|mein)\s+(?:rename|move|badal)\s*(?:karo|kar\s+do)?$/i))) {
    return asCmd('mv', `${clean(m[1])} | ${clean(m[2])}`);
  }
  if ((m = text.match(/^(?:copy|cp)\s+(.+?)\s+(?:to|ko|me|mein)\s+(.+)$/i))) {
    return asCmd('cp', `${clean(m[1])} | ${clean(m[2])}`);
  }
  if ((m = text.match(/^(?:mkdir|make\s+(?:a\s+)?folder|folder\s+(?:banao|bana\s+do)|new\s+folder)\s+(.+)$/i))) {
    return asCmd('mkdir', clean(m[1]));
  }
  if ((m = text.match(/^(.+?\.\w{1,6})\s+(?:bhej(?:o|do)|send(?:\s+karo)?)$/i))) {
    return asCmd('send', clean(m[1]));
  }
  // ── custom / learned commands (before generic rm / run shell rules) ───────
  if (/^(?:(?:show|list)\s+(?:my\s+)?(?:custom|created|learned|saved)\s+commands?|(?:mere\s+)?(?:custom|naye|banaye\s+hue)\s+commands?\s*(?:dikhao|batao|list)?|learned\s+commands?)\??$/i.test(low)) {
    return asCmd('learn', '');
  }
  if ((m = text.match(/^(?:run|execute|trigger)\s+(?:the\s+|my\s+)?(?:custom\s+)?command\s+\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})$/i))
    || (m = text.match(/^(?:run|execute)\s+\/([a-zA-Z][a-zA-Z0-9_-]{1,27})(?:\s+command)?$/i))
    || (m = text.match(/^\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})\s+(?:custom\s+)?command\s+(?:ko\s+)?(?:chala(?:\s*do|\s*o)?|run\s+kar(?:\s*do|\s*o)?)$/i))) {
    return asCmd('cmd', `run ${clean(m[1])}`);
  }
  if ((m = text.match(/^(?:delete|remove|forget|unlearn)\s+(?:the\s+)?(?:custom\s+)?command\s+\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})$/i))
    || (m = text.match(/^\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})\s+(?:custom\s+)?command\s+(?:ko\s+)?(?:delete|remove|hata(?:\s*do|\s*o)?)(?:\s+kar(?:\s*do|\s*o)?)?$/i))) {
    return asCmd('learn', `del ${clean(m[1])}`);
  }

  if ((m = text.match(/^(?:rm|remove|delete|hatao|delete\s+karo|remove\s+karo)\s+(.+)$/i))
    || (m = text.match(/^(.+?)\s+(?:delete|remove|hata\s*do|delete\s+karo)$/i))) {
    return asCmd('rm', clean(m[1]));
  }
  if ((m = text.match(/^(?:zip|compress)\s+(.+)$/i))) return asCmd('zip', clean(m[1]));

  // ── shell ─────────────────────────────────────────────────────────────────
  if ((m = text.match(/^(?:run|terminal\s+(?:me|mein)|shell\s+(?:me|mein))\s+([\s\S]+?)(?:\s+chalao)?$/i))) {
    const command = clean(m[1]);
    if (command && !/^(?:app|karo)$/i.test(command)) return asCmd('run', command);
  }

  // ── troubleshooting & auto-repair ─────────────────────────────────────────
  if (/^(?:doctor\s+(?:fix|repair|heal|theek)(?:\s+kar(?:o|do|de)?)?|auto\s*repair(?:\s+kar(?:o|do|de)?)?|self\s*heal(?:\s+kar(?:o|do|de)?)?|khud\s+ko\s+(?:theek|fix|repair)\s+kar(?:o|do|de)?)$/i.test(text)) {
    return asCmd('doctor', 'fix');
  }
  if (/^(?:doctor|diagnose|diagnostics|health|healthcheck|sab\s+theek|kya\s+kaam\s+nahi|kya\s+theek\s+nahi|screenshot\s+(?:kaam\s+nahi|black|kaala)|why\s+(?:is|are)\s+(?:my\s+)?screenshot)\b/i.test(text)) {
    return asCmd('doctor');
  }

  // ── 15-feature quality intents: Workspace, Code Sandbox, DocQA, Recall, Clipboard Bridge, Conditional Workflow ──
  if ((m = text.match(/^(coding|study|focus|meeting|chill)\s+(?:mode|workspace)\s+(?:chalu\s+kar(?:o|do|de)?|on\s+kar(?:o|do|de)?|start\s+kar(?:o|do)?|lagao)$/i))
    || (m = text.match(/^(?:start|enable|activate|switch\s+to)\s+(coding|study|focus|meeting|chill)\s+(?:mode|workspace)$/i))) {
    return asCmd('workspace', m[1].toLowerCase());
  }
  if ((m = original.match(/^(?:(?:ye|yeh|is|this)\s+(?:(js|javascript|node|py|python|sql)\s+)?code\s+(?:chala\s+ke\s+(?:output\s+)?(?:dikha(?:o)?|bata(?:o)?)|run\s+kar(?:o|do|de)?)|run\s+this\s+(?:(js|javascript|node|py|python|sql)\s+)?code)\s*[:\-]?\s*([\s\S]+)$/i))) {
    const langHint = (m[1] || m[2] || '').toLowerCase();
    const codeBody = m[3].trim();
    const cmdName = /py/.test(langHint) ? 'runpy' : /sql/.test(langHint) ? 'sql' : 'runjs';
    return asCmd(cmdName, codeBody);
  }
  if ((m = text.match(/^(?:is\s+(?:pdf|doc|document|file|note|notes)\s+me(?:in)?\s+(?:se\s+)?|according\s+to\s+my\s+(?:notes?|docs?|documents?)[,\s]+|mere\s+notes?\s+me(?:in)?\s+(?:se\s+)?)([\s\S]+?)(?:\s+bata(?:o|de)?|\s+kya\s+hai|\s+dhundo)?\??$/i))) {
    return asCmd('docqa', clean(m[1]));
  }
  if ((m = text.match(/^(?:maine\s+(?:pichle\s+hafte\s+|pehle\s+)?(.+?)\s+ke\s+baare\s+me(?:in)?\s+kya\s+(?:bataya|bola|likha)\s+tha|recall\s+everything\s+about\s+(.+?)|search\s+my\s+memory\s+for\s+(.+?))\??$/i))) {
    return asCmd('recall', clean(m[1] || m[2] || m[3]));
  }
  if ((m = original.match(/^(?:pc\s+(?:pe|par|ke\s+clipboard\s+me)\s+copy\s+kar(?:\s*do|\s*de|\s*o)?|copy\s+(?:this\s+)?to\s+pc(?:\s+clipboard)?)\s*[:\-]?\s*([\s\S]+)$/i))) {
    return asCmd('pc', `clipset ${m[1].trim()}`);
  }
  if (/^(?:pc\s+(?:pe|par)\s+jo\s+copy\s+hai\s+(?:wo\s+)?bhej(?:o|do|de)?|send\s+pc\s+clipboard|pc\s+clipboard\s+bhej(?:o|do|de)?|get\s+pc\s+clipboard)[?!.]*$/i.test(text)) {
    return asCmd('pc', 'clipboard');
  }
  if (/^(?:if|agar|jab)\s+(?:battery|volume|brightness|hour|time)\s*(?:<=|>=|<|>|==|=|\s+se\s+kam|\s+se\s+zyada)\s*\d+/i.test(text)) {
    return asCmd('if', text);
  }

  // ── productivity & quick actions ─────────────────────────────────────────
  if (/^(?:(?:mere\s+)?(?:todos?|tasks?|to-dos?)\s+(?:dikhao|batao|list)|kya\s+(?:kya\s+)?kaam\s+baaki\s+hai|show\s+(?:my\s+)?(?:todos?|tasks?))\??$/i.test(low)) return asCmd('todo');
  if (/^(?:(?:mere\s+)?notes?\s+(?:dikhao|batao|list)|show\s+(?:my\s+)?notes?)\??$/i.test(low)) return asCmd('notes');
  if (/^(?:(?:mere\s+)?reminders?\s+(?:dikhao|batao|list)|show\s+(?:my\s+)?reminders?)\??$/i.test(low)) return asCmd('reminders');
  if (/^(?:(?:aaj\s+ka\s+)?brief(?:\s+do|\s+batao)?|morning\s+brief|daily\s+brief|daily\s+summary)$/i.test(low)) return asCmd('brief');
  if (/^(?:undo(?:\s+kar(?:o|do))?|pichla\s+kaam\s+(?:wapas\s+lo|undo\s+karo))$/i.test(low)) return asCmd('undo');
  if (/^(?:reach|agent[- ]?reach)\s*(?:doctor|status|check)?\??$/i.test(text)) return asCmd('reach', 'doctor');
  if (/^(?:ui\s+elements?|screen\s+elements?|inspect\s+ui|desktop\s+elements?|screen\s+ke\s+buttons?\s+dikhao)$/i.test(low)) {
    return asCmd('ui', '');
  }
  if ((m = text.match(/^(?:deep\s+research|research\s+karo|research\s+on|full\s+research)\s+(.+)$/i))
    || (m = text.match(/^(.+?)\s+(?:pe|par)\s+(?:deep\s+)?research\s+kar(?:o|do)$/i))) {
    return asCmd('reach', `research ${clean(m[1])}`);
  }
  if ((m = text.match(/^(?:youtube\s+transcript|yt\s+transcript|transcript\s+of)\s+(https?:\/\/\S+|[A-Za-z0-9_-]{11})$/i))
    || (m = text.match(/^(https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/\S+|youtu\.be\/\S+))\s+(?:ka\s+)?(?:transcript|subtitles?|captions?)(?:\s+(?:nikalo|batao|dikhao|padho))?$/i))) {
    return asCmd('reach', `yt ${clean(m[1])}`);
  }
  if ((m = text.match(/^(?:youtube\s+(?:pe|par)\s+(.+?)\s+(?:chalao|bajao|play\s+kar(?:o|do)|lagao)|play\s+(.+?)\s+on\s+youtube)$/i))) {
    const q = clean(m[1] || m[2]);
    if (q) return asCmd('yt', `play ${q}`);
  }

  // ── multi-user messaging, contacts & guest access control ────────────────
  if (/^(?:(?:mere\s+)?contacts?\s*(?:dikhao|batao|list)?|show\s+(?:my\s+)?contacts?|contact\s+list)\??$/i.test(low)) {
    return asCmd('contacts', '');
  }
  if ((m = text.match(/^(?:save\s+contact|add\s+contact|contact\s+(?:add|save)\s+kar(?:o|do)?)\s+([a-zA-Z\u0900-\u097F][a-zA-Z0-9\u0900-\u097F\s_-]{0,30}?)\s+(\+?\d[\d\s\-]{8,16}\d)$/i))
    || (m = text.match(/^([a-zA-Z\u0900-\u097F][a-zA-Z0-9\u0900-\u097F\s_-]{0,30}?)\s+ka\s+(?:number|no|phone|whatsapp)\s+(\+?\d[\d\s\-]{8,16}\d)\s+(?:contact\s+me(?:in)?\s+)?(?:save|add)\s+kar(?:\s*lo|\s*do|\s*o)?$/i))) {
    return asCmd('contact', `add ${clean(m[1])} | ${clean(m[2])}`);
  }
  if ((m = text.match(/^(?:guest|guests|guest\s+mode|public\s+chat|multi\s*user)(?:\s+(on|off|all|auto|approval|approve|ask|pending|contacts|allowlist|status|log|history|clear|band|chalu))?(?:\s+kar(?:o|do))?\??$/i))) {
    return asCmd('guest', (m[1] || 'status').toLowerCase());
  }
  if (/^(?:pending\s+(?:messages?|approvals?|guests?)|kiske\s+messages?\s+(?:aaye|pending)\s+hain|show\s+pending)\??$/i.test(low)) {
    return asCmd('pending', '');
  }
  // ── owner location intelligence & local weather ──────────────────────────
  if (/^(?:(?:meri\s+)?(?:current\s+|live\s+)?location(?:\s+(?:kya\s+hai|batao|dikhao))?|main\s+(?:abhi\s+)?kahan\s+hoon|where\s+am\s+i(?:\s+right\s+now)?|my\s+location|whereami)\??$/i.test(low)) {
    return asCmd('location', '');
  }
  if ((m = text.match(/^(?:set\s+(?:my\s+)?location(?:\s+to)?|meri\s+location\s+(?:set\s+kar(?:o|do)\s+)?|location\s+set(?:\s+kar(?:o|do))?)\s+(.+?)(?:\s+set\s+kar(?:o|do))?$/i))) {
    return asCmd('location', `set ${clean(m[1])}`);
  }
  if ((m = text.match(/^(?:mere\s+aas\s*paas\s+(.+?)(?:\s+(?:dhundo|batao|dikhao|search\s+karo|kahan\s+hai))?|find\s+(.+?)\s+near\s+me|nearby\s+(.+?)|(.+?)\s+near\s+me)\??$/i))) {
    const q = clean(m[1] || m[2] || m[3] || m[4]);
    if (q) return asCmd('location', `near ${q}`);
  }
  if (/^(?:(?:aaj\s+ka\s+|abhi\s+ka\s+|yahan\s+ka\s+)?mausam(?:\s+kaisa\s+hai|\s+batao)?|(?:what(?:'s|\s+is)\s+the\s+|how(?:'s|\s+is)\s+the\s+)?weather(?:\s+(?:outside|here|today|now))?)\??$/i.test(low)) {
    return asCmd('weather', '');
  }
  if ((m = text.match(/^(?:block(?:\s+number|\s+contact)?)\s+(.+?)(?:\s+ko)?$/i))
    || (m = text.match(/^(\+?\d[\d\s\-]{8,16}\d|[a-zA-Z][a-zA-Z0-9_-]{1,24})\s+ko\s+block\s+kar(?:\s*do|\s*o)?$/i))) {
    return asCmd('block', clean(m[1]));
  }
  if ((m = text.match(/^(?:unblock(?:\s+number|\s+contact)?)\s+(.+?)(?:\s+ko)?$/i))
    || (m = text.match(/^(\+?\d[\d\s\-]{8,16}\d|[a-zA-Z][a-zA-Z0-9_-]{1,24})\s+ko\s+unblock\s+kar(?:\s*do|\s*o)?$/i))) {
    return asCmd('unblock', clean(m[1]));
  }
  if ((m = text.match(/^(?:allow(?:\s+number|\s+contact|\s+guest)?)\s+(.+?)(?:\s+ko)?$/i))
    || (m = text.match(/^(\+?\d[\d\s\-]{8,16}\d|[a-zA-Z][a-zA-Z0-9_-]{1,24})\s+ko\s+allow\s+kar(?:\s*do|\s*o)?$/i))) {
    return asCmd('allow', clean(m[1]));
  }
  // Outbound WhatsApp message: "<number|name> ko whatsapp/message bhejo [ki/:] <text>"
  if ((m = text.match(/^(\+?\d[\d\s\-]{8,16}\d|[a-zA-Z\u0900-\u097F][a-zA-Z0-9\u0900-\u097F\s_-]{0,25}?)\s+(?:ko|pe|par)\s+(?:whatsapp\s+(?:message|msg)|whatsapp|message|msg|dm)\s+(?:bhej(?:\s*do|\s*o|\s*de|\s*na)?|kar(?:\s*do|\s*o|\s*de|\s*na)?|likh(?:\s*do|\s*o)?)\s*(?:ki|ke|:|-|,)?\s+([\s\S]+)$/i))) {
    const target = clean(m[1]);
    const body = clean(m[2]);
    if (target && body && !/^(?:sleep(?:ing)?|offline)$/i.test(target)) {
      return asCmd('msg', `${target} | ${body}`);
    }
  }
  // "send (a) whatsapp/message/dm to <target> [:|that] <text>" or "message/whatsapp <target>: <text>"
  if ((m = text.match(/^(?:send\s+(?:a\s+)?(?:whatsapp\s+(?:message|msg)|whatsapp|message|msg|dm)\s+to|whatsapp\s+to|message\s+to|dm\s+to)\s+(\+?\d[\d\s\-]{8,16}\d|[a-zA-Z\u0900-\u097F][a-zA-Z0-9\u0900-\u097F\s_-]{0,25}?)\s*(?:(?:\||:|that|ki|-)\s*|\s+)([\s\S]+)$/i))
    || (m = text.match(/^(?:whatsapp|msg|dm)\s+(\+?\d[\d\s\-]{8,16}\d|[a-zA-Z][a-zA-Z0-9_-]{1,24})\s*(?::|\||-)?\s+([\s\S]+)$/i))) {
    const target = clean(m[1]);
    const body = clean(m[2]);
    if (target && body) return asCmd('msg', `${target} | ${body}`);
  }
  if ((m = text.match(/^(?:reply(?:\s+to\s+last(?:\s+guest)?)?|last\s+guest\s+ko\s+reply(?:\s+kar(?:o|do))?)\s*(?::|-)?\s+([\s\S]+)$/i))) {
    return asCmd('reply', clean(m[1]));
  }

  // ── custom / learned commands ─────────────────────────────────────────────
  if (/^(?:(?:show|list)\s+(?:my\s+)?(?:custom|created|learned|saved)\s+commands?|(?:mere\s+)?(?:custom|naye|banaye\s+hue)\s+commands?\s*(?:dikhao|batao|list)?|learned\s+commands?)\??$/i.test(low)) {
    return asCmd('learn', '');
  }
  if ((m = text.match(/^(?:run|execute|trigger)\s+(?:the\s+|my\s+)?(?:custom\s+)?command\s+\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})$/i))
    || (m = text.match(/^(?:run|execute)\s+\/([a-zA-Z][a-zA-Z0-9_-]{1,27})(?:\s+command)?$/i))
    || (m = text.match(/^\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})\s+(?:custom\s+)?command\s+(?:ko\s+)?(?:chala(?:\s*do|\s*o)?|run\s+kar(?:\s*do|\s*o)?)$/i))) {
    return asCmd('cmd', `run ${clean(m[1])}`);
  }

  // ── meta ──────────────────────────────────────────────────────────────────
  if (/^(?:help|commands|kya\s+kar\s+sakte\s+ho|what\s+can\s+you\s+do|capabilities|features|tum\s+kya\s+kar\s+sakte\s+ho)$/i.test(text)) return asCmd('help');
  return null;
}
