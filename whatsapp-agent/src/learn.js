// learn.js — Dynamic Custom Command Creator & Macro Engine for PSD_Ai.
//
// Lets the owner create new commands directly from natural-language messages
// (English, Hindi, or Hinglish), e.g.:
//   • "create a command /study that opens chrome and sets volume to 30 and takes a screenshot"
//   • "make a command called morning to show my todos and check weather"
//   • "/gaming naam ka command banao jo brave khole aur volume 80 kare"
//   • "todo add revise math aur note: exam Friday — create this as a command /exam"
//   • "create this as a command /repeat" (turns the owner's previous message/task into a command!)
//   • "/learn work open chrome | open slack | open code"
//
// Strictly Owner-Only and persisted in store.json (`learned: []`).

import { parseIntent } from './nlp.js';

const RESERVED = new Set([
  'help','commands','menu','start','ping','me','id','whoami','status','time','date',
  'remind','reminder','reminders','timer','todo','todos','task','note','notes','remember','memory','forget',
  'model','ai','ask','summarize','summarise','tldr','improve','rewrite',
  'weather','wiki','define','news','calc','unit','convert','currency','fx','url','qr','password','pw','uuid','shorten','coin','dice','choose','joke','fact','quote','poll',
  'files','get','sendfile','downloads','pc','system','sysinfo','observer','obs','screen','look','lookscreen','ocr','screenshot','shot','webcam','cam','record','screencast','run','exec','shell','sticker',
  'apps','applications','windows','tasks','focus','switch','open','close','quit','wifi','bt','bluetooth','kill','svc','service','notify','doctor','diag','diagnose','access',
  'ls','dir','read','cat','write','savefile','send','getfile','download','dl','mv','move','rename','cp','copy','mkdir','zip','unzip','rm','delete',
  'agent','do','yes','haan','no','nahi','cancel','link',
  'cron','schedule','repeat','jobs','voicereply','voice','tts','bol','speak',
  'learn','teach','alias','unlearn','undefine','forgetword',
  'msg','dm','sendto','whatsapp','reply','broadcast','contact','contacts','guest','guests','guestmode',
  'pending','approve','reject','deny','allow','block','unblock','location','loc','whereami','mylocation','near','nearby',
  'cmd','command','createcmd','delcmd','watchme','recordactions','replayactions',
]);

export function normalizeKeyword(raw) {
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '');
  return cleaned.slice(0, 28);
}

export function isReserved(keyword) {
  return RESERVED.has(String(keyword).toLowerCase());
}

/**
 * Normalize descriptive/subjunctive English & Hinglish phrasing ("opens chrome",
 * "sets volume to 30", "takes a screenshot", "chrome khole", "volume 30 kare")
 * into direct imperative command text that `parseIntent` or `handleCommand` understands.
 */
export function normalizeDescriptiveStep(rawStep) {
  let s = String(rawStep ?? '').trim();
  if (!s) return '';
  if (s.startsWith('/')) return s;

  // Strip leading filler words ("it should", "that", "to", "jo", "jisme", "aur")
  s = s
    .replace(/^(?:it\s+should|it\s+will|it|that|which|to|for|jo\s+ki|jo|jisme|jisse|phir|fir|then)\s+/i, '')
    .trim();

  // English 3rd-person singular -> imperative at start of step
  s = s
    .replace(/^opens\s+/i, 'open ')
    .replace(/^closes\s+/i, 'close ')
    .replace(/^launches\s+/i, 'open ')
    .replace(/^starts\s+/i, 'open ')
    .replace(/^(?:takes?|captures?|sends?)\s+(?:a\s+)?screenshots?$/i, 'screenshot')
    .replace(/^sets?\s+(?:the\s+)?volume\s+(?:to|at)\s+(\d+)\s*%?$/i, 'volume $1 karo')
    .replace(/^(?:mutes?|unmutes?)\s+(?:the\s+)?(?:volume|audio|sound)$/i, (m) => (/^unmute/i.test(m) ? 'unmute' : 'mute'))
    .replace(/^sets?\s+(?:the\s+)?brightness\s+(?:to|at)\s+(\d+)\s*%?$/i, 'brightness $1 karo')
    .replace(/^turns?\s+(on|off)\s+(?:the\s+)?(wifi|wi-fi|bluetooth)$/i, '$2 $1 karo')
    .replace(/^turns?\s+(?:the\s+)?(wifi|wi-fi|bluetooth)\s+(on|off)$/i, '$1 $2 karo')
    .replace(/^(?:shows?|lists?|checks?)\s+(?:my\s+)?(?:todos?|tasks?|to-dos?)$/i, 'show my todos')
    .replace(/^(?:shows?|lists?|checks?)\s+(?:my\s+)?notes?$/i, 'show my notes')
    .replace(/^(?:shows?|lists?|checks?)\s+(?:my\s+)?reminders?$/i, 'show my reminders')
    .replace(/^(?:shows?|checks?|gets?)\s+(?:the\s+)?weather(?:\s+(?:in|of|at|for)\s+(.+))?$/i, (_, city) => (city ? `weather in ${city.trim()}` : 'weather'))
    .replace(/^(?:shows?|checks?|gets?)\s+(?:my\s+|the\s+)?location$/i, 'my location')
    .replace(/^(?:shows?|checks?|gets?)\s+(?:system\s+)?status$/i, '/status')
    .replace(/^(?:shows?|runs?)\s+(?:daily\s+|morning\s+)?brief(?:ing)?$/i, 'brief')
    .replace(/^adds?\s+(?:a\s+)?todo(?:\s*[:\-]\s*|\s+)(.+)$/i, 'todo: $1')
    .replace(/^(?:adds?|saves?|writes?)\s+(?:a\s+)?note(?:\s*[:\-]\s*|\s+)(.+)$/i, 'note: $1')
    .replace(/^sends?\s+(?:a\s+)?(?:whatsapp\s+(?:message|msg)|whatsapp|message|msg)\s+to\s+(.+?)\s+(?:saying|that|:)\s+(.+)$/i, 'send whatsapp message to $1: $2');

  // Hinglish subjunctive endings ("chrome khole" -> "chrome kholo", "volume 30 kare" -> "volume 30 karo", "screenshot bheje" -> "screenshot bhejo")
  s = s
    .replace(/\bkhol\s*de\b/gi, 'kholo')
    .replace(/\bkhole\b/gi, 'kholo')
    .replace(/\bbhej\s*de\b/gi, 'bhejo')
    .replace(/\bbheje\b/gi, 'bhejo')
    .replace(/\bdikhaye\b/gi, 'dikhao')
    .replace(/\bdikha\s*de\b/gi, 'dikhao')
    .replace(/\bbataye\b/gi, 'batao')
    .replace(/\bbata\s*de\b/gi, 'batao')
    .replace(/\bchalaye\b/gi, 'chalao')
    .replace(/\bchala\s*de\b/gi, 'chalao')
    .replace(/\bkare\b/gi, 'karo')
    .replace(/\bkar\s*de\b/gi, 'karo');

  return s.trim();
}

function parseSingleStep(rawPart) {
  const raw = String(rawPart ?? '').trim();
  if (!raw) return null;

  // 1. Explicit leading `/` slash command
  if (raw.startsWith('/')) {
    const trimmed = raw.replace(/^\/+/, '').trim();
    if (!trimmed) return null;
    const m = trimmed.match(/^([a-zA-Z0-9_-]+)\s*([\s\S]*)$/);
    if (m) {
      return { cmd: m[1].toLowerCase(), args: (m[2] ?? '').trim(), raw: `/${trimmed}` };
    }
  }

  // 2. Normalize descriptive phrasing ("opens chrome" -> "open chrome", "chrome khole" -> "chrome kholo")
  const norm = normalizeDescriptiveStep(raw);
  if (norm.startsWith('/')) {
    const trimmed = norm.replace(/^\/+/, '').trim();
    const m = trimmed.match(/^([a-zA-Z0-9_-]+)\s*([\s\S]*)$/);
    if (m) {
      return { cmd: m[1].toLowerCase(), args: (m[2] ?? '').trim(), raw: norm };
    }
  }

  // 3. Quick intents (todo, note, remind, weather, location)
  let qm = null;
  if ((qm = norm.match(/^(?:add\s+(?:a\s+)?todo[:\s]+|todo\s*[:\-]\s*|todo\s+add\s+)(.+)$/i))) {
    return { cmd: 'todo', args: `add ${qm[1].trim()}`, raw };
  }
  if ((qm = norm.match(/^(?:note(?:\s+kar\s+lo)?\s*[:\-]\s*|note\s+that\s+|save\s+note[:\s]+)(.+)$/i))) {
    return { cmd: 'note', args: qm[1].trim(), raw };
  }
  if ((qm = norm.match(/^remind\s+me\s+(.+)$/i))) {
    return { cmd: 'remind', args: qm[1].trim(), raw };
  }
  if ((qm = norm.match(/^(?:what(?:'s|\s+is)\s+the\s+)?weather\s+(?:in|at|of|for)\s+(.+?)\??$/i))
    || (qm = norm.match(/^(.+?)\s+ka\s+(?:mausam|weather)(?:\s+kaisa\s+hai|\s+batao)?\??$/i))) {
    return { cmd: 'weather', args: qm[1].trim(), raw };
  }

  // 4. Built-in NLP parser (`src/nlp.js` — "chrome kholo", "volume 30 karo", "screenshot bhej do", "Rahul ko whatsapp message bhejo ...", etc.)
  const nlpHit = parseIntent(norm) || parseIntent(raw);
  if (nlpHit && nlpHit.cmd) {
    return { cmd: nlpHit.cmd, args: nlpHit.args ?? '', raw };
  }

  // 5. Known direct command verb at start (e.g. "open chrome", "pc volume 30", "weather Dehradun", "msg Rahul | hi")
  const singleCommandVerbs = new Set([
    'open','close','apps','pc','screenshot','shot','wifi','bt','todo','todos','note','notes',
    'remind','reminders','cron','voicereply','notify','ls','read','write','send','download',
    'mv','cp','mkdir','zip','unzip','rm','kill','svc','doctor','weather','wiki','calc','unit',
    'currency','quote','joke','screen','look','ocr','brief','status','ping','time','date',
    'location','loc','near','nearby','msg','dm','sendto','reply','broadcast','contact','contacts',
    'guest','pending','reach','yt','gh','reddit','hn','ui','dsh','solve','agent','auto','use',
  ]);
  const firstWord = norm.split(/\s+/)[0]?.toLowerCase() || '';
  if (singleCommandVerbs.has(firstWord)) {
    const rest = norm.slice(firstWord.length).trim();
    return { cmd: firstWord, args: rest, raw };
  }

  // 6. Single word without spaces -> treat as app name to open (e.g. `chrome` -> `/open chrome`)
  if (!norm.includes(' ') && norm.length <= 30) {
    const w = norm.toLowerCase();
    if (RESERVED.has(w)) {
      return { cmd: w, args: '', raw };
    }
    return { cmd: 'open', args: norm, raw, inferredOpen: true };
  }

  // 7. Free-form natural language / AI step (executed via natural pipeline when the command runs)
  return { cmd: '__natural__', args: norm, raw };
}

/**
 * Parse a command definition string (slash commands, pipe chains, or natural
 * English/Hindi/Hinglish sentences) into an array of executable step objects.
 */
export function parseLearnCommands(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;

  let parts = [];
  if (/[|;\n]/.test(text)) {
    parts = text.split(/[|;\n]+/).map((s) => s.trim()).filter(Boolean);
  } else if (/\s+(?:and\s+then|then|aur\s+phir|uske\s+baad|iske\s+baad|phir|fir|aur|and)\s+/i.test(text)) {
    const candidateParts = text
      .split(/\s+(?:and\s+then|then|aur\s+phir|uske\s+baad|iske\s+baad|phir|fir|aur|and)\s+/i)
      .map((s) => s.trim())
      .filter(Boolean);
    parts = candidateParts.length >= 2 ? candidateParts : [text];
  } else if (text.includes(',')) {
    const commaParts = text.split(',').map((s) => s.trim()).filter(Boolean);
    // Keep as single step if it looks like GPS coordinates ("30.3165, 78.0322")
    if (commaParts.length === 2 && /^-?\d+(?:\.\d+)?$/.test(commaParts[0]) && /^-?\d+(?:\.\d+)?$/.test(commaParts[1])) {
      parts = [text];
    } else {
      parts = commaParts;
    }
  } else {
    const firstWord = text.split(/\s+/)[0]?.toLowerCase() || '';
    const tokens = text.split(/\s+/).map((t) => t.trim()).filter(Boolean);
    if (
      tokens.length > 1
      && tokens.length <= 8
      && !text.startsWith('/')
      && !parseIntent(normalizeDescriptiveStep(text))
      && tokens.every((t) => !t.includes(' ') && t.length <= 24 && /^[a-z0-9_-]+$/i.test(t))
      && !['open','close','pc','wifi','todo','note','remind','weather','location','near','msg','send','show','check','set','turn','take'].includes(firstWord)
    ) {
      // Shorthand like `/learn work chrome slack vscode` -> open each app
      parts = tokens;
    } else {
      parts = [text];
    }
  }

  const commands = [];
  for (const part of parts) {
    const step = parseSingleStep(part);
    if (step) commands.push(step);
    if (commands.length >= 12) break;
  }

  return commands.length ? commands : null;
}

export function formatLearnedStep(c) {
  if (!c) return '';
  if (c.inferredOpen) return `/open ${c.args}`;
  if (c.cmd === '__natural__') return `"${c.args}"`;
  return `/${c.cmd}${c.args ? ` ${c.args}` : ''}`;
}

export function formatLearned(entry) {
  if (!entry) return '';
  const steps = (entry.commands ?? []).map(formatLearnedStep).join(' → ');
  return `/${entry.keyword} → ${steps}`;
}

export function validateKeyword(keyword) {
  const k = normalizeKeyword(keyword);
  if (!k) return 'Keyword khali nahi ho sakta. e.g. `/learn work open chrome | open slack`';
  if (k.length < 2) return 'Keyword kam se kam 2 letters ka ho. e.g. `/learn work open chrome`';
  if (isReserved(k)) return `/${k} built-in command hai, is naam se custom command nahi bana sakte. Koi dusra naam use karo jaise \`/my${k}\` ya \`/${k}2\`.`;
  if (!/^[a-z][a-z0-9_-]*$/i.test(k)) return 'Keyword sirf letters, numbers, `-` ya `_` se bane. e.g. `/work`, `/morning_routine`';
  return null;
}

/**
 * Detect natural-language requests from the owner to create or delete a custom
 * command based on their message (or their previous message when they say
 * "create this as a command /name").
 *
 * Returns:
 *   • `{ action: 'create', name, task, runNow, fromLastMessage }`
 *   • `{ action: 'delete', name }`
 *   • `{ action: 'list' }`
 *   • `null` when the message is not a command-creation request.
 */
export function parseCreateCommandIntent(rawInput, lastOwnerText = '') {
  const text = String(rawInput ?? '').trim();
  if (!text) return null;
  // Allow "/<name> naam ka command banao ..." while ignoring actual slash commands like "/learn ..." or "/open ..."
  if (text.startsWith('/') && !/^\/[a-zA-Z][a-zA-Z0-9_-]{1,27}\s+naam\s+(?:ka|ki|se)\s+(?:ek\s+)?(?:naya\s+)?command\s+bana/i.test(text)) {
    return null;
  }

  let m = null;

  // ── 1. List custom commands ──────────────────────────────────────────────
  if (/^(?:(?:show|list)\s+(?:my\s+)?(?:custom|created|learned|saved)\s+commands?|(?:mere\s+)?(?:custom|naye|banaye\s+hue)\s+commands?\s+(?:dikhao|batao|list))\??$/i.test(text)) {
    return { action: 'list' };
  }

  // ── 2. Delete a custom command ───────────────────────────────────────────
  if ((m = text.match(/^(?:delete|remove|forget|unlearn)\s+(?:the\s+)?(?:custom\s+)?command\s+\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})$/i))
    || (m = text.match(/^\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})\s+(?:custom\s+)?command\s+(?:ko\s+)?(?:delete|remove|hata(?:\s*do|\s*o)?)(?:\s+kar(?:\s*do|\s*o)?)?$/i))) {
    return { action: 'delete', name: normalizeKeyword(m[1]) };
  }

  // Check if owner also asked to execute it immediately ("and run it", "aur abhi chalao")
  let working = text;
  let runNow = false;
  if (/\s+(?:and\s+(?:run|execute)\s+it(?:\s+now)?|aur\s+(?:abhi\s+)?(?:chala(?:\s*do|\s*o)|run\s+kar(?:\s*do|\s*o)))$/i.test(working)) {
    runNow = true;
    working = working.replace(/\s+(?:and\s+(?:run|execute)\s+it(?:\s+now)?|aur\s+(?:abhi\s+)?(?:chala(?:\s*do|\s*o)|run\s+kar(?:\s*do|\s*o)))$/i, '').trim();
  }

  // ── 3. "<task> — create/make/save this as a command [called] /<name>" ────
  if ((m = working.match(/^([\s\S]+?)\s*(?:—|--|-|;|\.|,|\s+and|\s+aur)\s*(?:create|make|save|set|turn)\s+(?:this|it)\s+(?:as|into)\s+(?:a\s+)?(?:new\s+)?command\s*(?:called|named|as)?\s*\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})$/i))
    || (m = working.match(/^([\s\S]+?)\s*(?:—|--|-|;|\.|,|\s+aur)\s*(?:isko|ise|is\s+kaam\s+ko|ye\s+kaam\s+ko)\s+\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})\s*(?:naam\s+ka\s+)?command\s+bana(?:\s*do|\s*o|\s*lo)?$/i))) {
    const taskPart = m[1].trim();
    const name = normalizeKeyword(m[2]);
    if (name && taskPart) {
      return { action: 'create', name, task: taskPart, runNow };
    }
  }

  // ── 4. "create/make/save this as a command /<name>: <task>" or referring to previous message ──
  if ((m = working.match(/^(?:create|make|save|set|turn|add)\s+(?:this|it|my\s+last\s+(?:message|task|command))\s+(?:as|into)\s+(?:a\s+)?(?:new\s+)?command\s*(?:called|named|as)?\s*\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})(?:\s*(?::|-|to|that|which|for)\s*([\s\S]+))?$/i))
    || (m = working.match(/^(?:isko|ise|is\s+(?:message|kaam|task)\s+ko|pichle\s+(?:message|kaam|task)\s+ko)\s+\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})\s*(?:naam\s+ka\s+)?command\s+bana(?:\s*do|\s*o|\s*lo)?(?:\s*(?::|-|jo|jisme)\s*([\s\S]+))?$/i))) {
    const name = normalizeKeyword(m[1]);
    const inlineTask = (m[2] || '').trim();
    const task = inlineTask || String(lastOwnerText || '').trim();
    if (name) {
      return {
        action: 'create',
        name,
        task,
        runNow,
        fromLastMessage: !inlineTask,
      };
    }
  }

  // ── 5. "create/make/add [a] [new] command [called/named] /<name> that/to/for/: <task>" ──
  if ((m = working.match(/^(?:create|make|add|define|build|register|save)\s+(?:a\s+)?(?:new\s+)?(?:custom\s+)?command\s+(?:called\s+|named\s+)?\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})\s*(?:that\s+|which\s+|to\s+|for\s+|as\s+|=\s*|:\s*|-\s*|\s+)([\s\S]+)$/i))) {
    const name = normalizeKeyword(m[1]);
    const task = m[2].trim();
    if (name && task) {
      return { action: 'create', name, task, runNow };
    }
  }

  // ── 6. Hindi / Hinglish: "/<name> naam ka [ek] [naya] command banao jo/jisme/: <task>" ──
  if ((m = working.match(/^(?:ek\s+)?(?:naya\s+)?\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})\s+naam\s+(?:ka|ki|se)\s+(?:ek\s+)?(?:naya\s+)?command\s+bana(?:\s*do|\s*o|\s*lo)?\s*(?:jo\s+ki|jo|jisme|jisse|:|-|to|for)?\s+([\s\S]+)$/i))
    || (m = working.match(/^(?:ek\s+)?(?:naya\s+)?command\s+bana(?:\s*do|\s*o|\s*lo)?\s+(?:named\s+|called\s+)?\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})\s*(?:naam\s+(?:ka|se)\s+)?(?:jo\s+ki|jo|jisme|jisse|that|to|for|:|-|=)\s*([\s\S]+)$/i))
    || (m = working.match(/^(?:ek\s+)?(?:naya\s+)?command\s+\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})\s+(?:bana(?:\s*do|\s*o|\s*lo)?|add\s+kar(?:\s*do|\s*o)?|set\s+kar(?:\s*do|\s*o)?)\s*(?:jo\s+ki|jo|jisme|that|to|for|:|-|=)?\s+([\s\S]+)$/i))) {
    const name = normalizeKeyword(m[1]);
    const task = m[2].trim();
    if (name && task) {
      return { action: 'create', name, task, runNow };
    }
  }

  // ── 7. "when I say /<name> [then] <task>" / "jab main /<name> bolu to <task>" ──
  // (Specifically when the trigger starts with `/` or says "command /<name>")
  if ((m = working.match(/^(?:when(?:ever)?\s+i\s+(?:say|type|send|run)\s+(?:command\s+)?\/([a-zA-Z][a-zA-Z0-9_-]{1,27})|jab\s+(?:bhi\s+)?main\s+(?:command\s+)?\/([a-zA-Z][a-zA-Z0-9_-]{1,27})\s+(?:bolu(?:n)?|likhu(?:n)?|bheju(?:n)?|chalaun?))\s*(?:then\s+|to\s+|tab\s+|,\s*|\s+)([\s\S]+)$/i))) {
    const name = normalizeKeyword(m[1] || m[2]);
    const task = m[3].trim();
    if (name && task) {
      return { action: 'create', name, task, runNow };
    }
  }

  return null;
}
