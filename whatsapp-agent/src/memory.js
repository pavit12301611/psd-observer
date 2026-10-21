// memory.js — persistent owner memory, smart fact updates, and user-first overrides.
//
// Why this file exists:
//   1. Plain "/remember <text>" used to key facts by `text.slice(0, 48)`, so
//      saying "my name is Aman" and later "my name is Pavit" kept BOTH in
//      store.json and confused the AI. Worse, natural Hinglish ("mera naam
//      Pavit hai", "mujhe Boss bulao", "mera bike number … hai") was ignored
//      unless the owner typed `/remember` or an AI brain happened to call a tool.
//   2. If something was already saved (a fact, a default like "Sir", a learned
//      command, or a built-in phrase) and the owner told the agent something
//      new ("mera naam ab X hai", "agar main Y kahun to Z karo", "X nahi Y
//      kholo"), the old saved value or default could win over the owner's
//      explicit instruction.
//
// Now:
//   • Facts are canonicalised by slot (`name`, `address`, `city`, `bike`,
//     `browser`, `wifi_password`, …). A new statement about the same slot
//     ALWAYS overwrites the older one — even across Hindi, Hinglish, Devanagari
//     and English phrasings.
//   • Natural-language memory works 100% offline (`AI_PROVIDER=none`) AND in
//     live voice calls: setting facts, updating them, asking them back ("mera
//     naam kya hai?", "what is my bike number?"), and forgetting them.
//   • Custom trigger→action rules ("agar main X kahun to Y karo" / "jab main X
//     bolun to Y karna") are persisted in `store.data.rules` (and synced with
//     `learned` for single-word keywords) and evaluated BEFORE built-in NLP
//     intents — so whatever the owner tells the agent to do overrides defaults
//     and previously saved rules.

import * as learn from './learn.js';

// Devanagari words commonly spoken in memory / override sentences so raw Hindi
// text (chat or STT) parses with the exact same rules as Roman Hinglish.
const DEVA_MEMORY_MAP = {
  'मेरा': 'mera', 'मेरी': 'meri', 'मेरे': 'mere', 'मैं': 'main', 'मुझे': 'mujhe', 'मुझको': 'mujhko',
  'हमारा': 'hamara', 'अपना': 'apna', 'अपनी': 'apni',
  'नाम': 'naam', 'शहर': 'shehar', 'उम्र': 'umar', 'जन्मदिन': 'janamdin', 'भाषा': 'bhasha',
  'घर': 'ghar', 'गाड़ी': 'gaadi', 'बाइक': 'bike', 'कार': 'car', 'फोन': 'phone', 'मोबाइल': 'mobile',
  'ईमेल': 'email', 'ब्राउज़र': 'browser', 'पासवर्ड': 'password', 'नंबर': 'number', 'कोड': 'code',
  'कॉलेज': 'college', 'ऑफिस': 'office', 'कंपनी': 'company', 'काम': 'kaam', 'दोस्त': 'dost',
  'क्या': 'kya', 'कौन': 'kaun', 'कहाँ': 'kahan', 'कहां': 'kahan', 'कब': 'kab', 'कैसे': 'kaise',
  'है': 'hai', 'हैं': 'hain', 'हूँ': 'hoon', 'हूं': 'hoon', 'था': 'tha', 'थी': 'thi',
  'याद': 'yaad', 'रखो': 'rakho', 'रखना': 'rakhna', 'रख': 'rakh', 'रखें': 'rakhein', 'रखे': 'rakhe',
  'भूल': 'bhool', 'जाओ': 'jao', 'जाना': 'jana', 'मत': 'mat', 'हटा': 'hata', 'हटाओ': 'hatao',
  'बदलो': 'badlo', 'बदल': 'badal', 'कर': 'kar', 'करो': 'karo', 'करना': 'karna', 'दो': 'do', 'देना': 'dena',
  'बुलाओ': 'bulao', 'बुलाना': 'bulana', 'बोलो': 'bolo', 'बोलना': 'bolna', 'कहो': 'kaho', 'कहना': 'kehna',
  'अगर': 'agar', 'जब': 'jab', 'भी': 'bhi', 'कहूँ': 'kahun', 'कहूं': 'kahun', 'बोलूँ': 'bolun', 'बोलूं': 'bolun',
  'तो': 'to', 'तब': 'tab', 'वही': 'wohi', 'वोही': 'wohi', 'जो': 'jo',
  'पहले': 'pehle', 'अब': 'ab', 'से': 'se', 'पर': 'par', 'पे': 'pe', 'में': 'mein', 'का': 'ka', 'की': 'ki', 'के': 'ke', 'को': 'ko',
  'नहीं': 'nahi', 'ना': 'na', 'बल्कि': 'balki', 'सही': 'sahi', 'गलत': 'galat',
  'सेव': 'save', 'मेमोरी': 'memory', 'पता': 'pata', 'बताओ': 'batao', 'दिखाओ': 'dikhao',
  'खोलो': 'kholo', 'खोलना': 'kholna', 'बंद': 'band', 'चलाओ': 'chalao', 'चलाना': 'chalana',
  'भेजो': 'bhejo', 'भेजना': 'bhejna', 'सर': 'sir', 'बॉस': 'boss', 'भाई': 'bhai',
  'रहता': 'rehta', 'रहती': 'rehti', 'साल': 'saal', 'हमेशा': 'hamesha',
};

const DEVA_DIGITS = { '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9' };

function normalizeDevanagariWords(input) {
  let out = String(input ?? '');
  if (!/[ऀ-ॿ]/.test(out)) return out;
  out = out.replace(/[०-९]/g, (d) => DEVA_DIGITS[d] ?? d);
  return out.split(/(\s+)/).map((token) => {
    const punc = token.match(/[।,!?;:]+$/u)?.[0] ?? '';
    const bare = punc ? token.slice(0, -punc.length) : token;
    const mapped = DEVA_MEMORY_MAP[token] ?? DEVA_MEMORY_MAP[bare];
    return mapped ? mapped + punc.replace(/।/g, '.') : token.replace(/।/g, '.');
  }).join('');
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function stripPolite(s) {
  return clean(s)
    .replace(/^(?:please|pls|plz|bhai|bro|yaar|yr|suno|hey|hello|hi|ok|okay|acha|accha|listen|jarvis)\b[,:\s-]*/i, '')
    .replace(/\s*,?\s*(?:please|pls|plz|bhai|bro|yaar|yr|jarvis)$/i, '')
    .trim();
}

// System/hardware nouns that belong to `/pc` or `/look`, NEVER personal facts.
const SYSTEM_SLOT_WORDS = /^(?:ip|ip\s+address|lan\s+ip|battery|charge|charging|disk|storage|space|jagah|screen|screenshot|ss|volume|awaaz|aawaz|sound|brightness|chamak|pc|system|cpu|ram|memory\s+usage|wifi\s+status|network\s+status|bluetooth|bt|clipboard|process(?:es)?|tasks?|windows?|downloads?\s+folder)$/i;

const QUESTION_RE = /\b(kya|kaise|kyun|kyu|kab|kahan|kaun|konsa|kaunsa|kitna|kitni|what|who|why|how|when|where|which|tell\s+me|batao|dikhao)\b|\?$/i;

// Transient complaints ("mera wifi kaam nahi kar raha hai") are not personal facts.
const TRANSIENT_COMPLAINT_RE = /\b(kaam\s+nahi|nahi\s+chal|chal\s+nahi|slow\s+hai|hang\s+ho|black\s+aa|kaala\s+aa|khatam\s+ho|band\s+ho\s+gaya|down\s+hai|error\s+aa|problem\s+hai|issue\s+hai)\b/i;

// Words that follow "main <X> hoon" / "I am <X>" as states/moods/locations, NOT a person's name.
const NON_NAME_STATES = new Set([
  'theek', 'thik', 'fine', 'good', 'great', 'ok', 'okay', 'well', 'alright',
  'busy', 'ready', 'free', 'available', 'here', 'back', 'home', 'outside',
  'yahan', 'yahin', 'wahan', 'ghar', 'office', 'college', 'school', 'market',
  'tired', 'thaka', 'thaki', 'happy', 'khush', 'sad', 'upset', 'pareshan',
  'hungry', 'bhookha', 'sleeping', 'soya', 'working', 'coming', 'going',
  'calling', 'asking', 'saying', 'telling', 'talking', 'trying', 'waiting',
  'online', 'offline', 'late', 'early', 'alone', 'sick', 'bimar', 'done',
  'bol', 'keh', 'kar', 'ja', 'aa', 'dekh', 'sun', 'padh', 'likh', 'khel',
  'kaun', 'kya', 'kahan', 'kab', 'kaise', 'ek', 'student', 'developer', 'engineer', 'doctor',
]);

const SLOT_SYNONYMS = [
  { key: 'agent_name', label: 'Agent name', patterns: [/^(?:(?:tumhara|tera|aapka|your|agent(?:'s)?|bot(?:'s)?|assistant(?:'s)?)\s+)(?:asli\s+|naya\s+|new\s+)?(?:naam|nam|name|नाम)$/i, /^(?:agent\s+name|bot\s+name|assistant\s+name)$/i] },
  { key: 'name', label: 'Name', patterns: [/^(?:(?:mera|my|apna|owner(?:'s)?)\s+)?(?:asli\s+|pura\s+|real\s+|full\s+)?(?:naam|nam|name|नाम)$/i] },
  { key: 'address', label: 'Preferred address', patterns: [/^(?:(?:preferred\s+)?address|title|salutation|call\s+me|bulao|bolna)$/i] },
  { key: 'city', label: 'City', patterns: [/^(?:(?:mera|my|current|home)\s+)?(?:shehar|shahar|city|town|location|hometown|place|शहर)$/i] },
  { key: 'age', label: 'Age', patterns: [/^(?:(?:meri|mera|my)\s+)?(?:umar|age|उम्र)$/i] },
  { key: 'birthday', label: 'Birthday', patterns: [/^(?:(?:mera|my)\s+)?(?:birthday|bday|birth\s*date|date\s+of\s+birth|dob|janamdin|जन्मदिन)$/i] },
  { key: 'bike', label: 'Bike', patterns: [/^(?:(?:meri|mera|my)\s+)?(?:bike|bike\s+number|bike\s+no|scooty|scooter|two\s+wheeler)(?:\s+(?:number|no|naam))?$/i] },
  { key: 'car', label: 'Car', patterns: [/^(?:(?:meri|mera|my)\s+)?(?:car|car\s+number|car\s+no|gaadi|gadi|gaadi\s+number|gadi\s+number)(?:\s+(?:number|no|naam))?$/i] },
  { key: 'phone', label: 'Phone number', patterns: [/^(?:(?:mera|my)\s+)?(?:phone|phone\s+number|mobile|mobile\s+number|contact\s+number|whatsapp\s+number)$/i] },
  { key: 'email', label: 'Email', patterns: [/^(?:(?:mera|my)\s+)?(?:email|email\s+id|e-mail|mail|mail\s+id|gmail|gmail\s+id)$/i] },
  { key: 'wifi_password', label: 'Wi-Fi password', patterns: [/^(?:(?:mera|my|office|home|ghar\s+ka|room\s+ka)\s+)?(?:wifi|wi-fi|net|hotspot)\s*(?:ka\s+)?(?:password|pass|key|pin)$/i] },
  { key: 'wifi_ssid', label: 'Wi-Fi network', patterns: [/^(?:(?:mera|my|office|home|ghar\s+ka)\s+)?(?:wifi|wi-fi)\s*(?:name|naam|ssid|network)$/i] },
  { key: 'browser', label: 'Preferred browser', patterns: [/^(?:(?:mera|my|default|favourite|favorite|pasandida|main|preferred)\s+)*(?:web\s+)?browser$/i] },
  { key: 'editor', label: 'Preferred editor', patterns: [/^(?:(?:mera|my|default|favourite|favorite|pasandida|code|text|preferred)\s+)*(?:editor|ide)$/i] },
  { key: 'language', label: 'Preferred language', patterns: [/^(?:(?:meri|mera|my|default|preferred|reply|pasandida)\s+)*(?:language|bhasha|zubaan|भाषा)$/i] },
  { key: 'college', label: 'College / School', patterns: [/^(?:(?:mera|meri|my)\s+)?(?:college|school|university|institute)(?:\s+(?:naam|name))?$/i] },
  { key: 'work', label: 'Work / Office', patterns: [/^(?:(?:mera|meri|my)\s+)?(?:job|profession|work|company|office|occupation|kaam)(?:\s+(?:naam|name))?$/i] },
  { key: 'gate_code', label: 'Gate code', patterns: [/^(?:(?:mera|my)\s+)?(?:gate\s+code|door\s+code|lock\s+code|entry\s+code|gate\s+pin)$/i] },
];

const KNOWN_PERSONAL_SLOTS_RE = /\b(naam|name|shehar|shahar|city|hometown|umar|age|birthday|bday|janamdin|dob|bike|scooty|scooter|car|gaadi|gadi|phone|mobile|email|gmail|wifi\s*password|wi-fi\s*password|net\s*password|password|passcode|pin|gate\s*code|locker\s*code|roll\s*number|enrollment|browser|editor|ide|language|bhasha|college|school|university|office|company|job|profession|favourite|favorite|pasandida|default|dost|friend|bhai|brother|sister|behen|mother|mummy|father|papa|pet|dog|cat|address|ghar\s*ka\s*pata)\b/i;

/** Map any raw slot phrase ("mera bike number", "my favourite browser") to { key, label }. */
export function canonicalSlot(rawSlot) {
  const norm = normalizeDevanagariWords(rawSlot)
    .replace(/^(?:mera|meri|mere|hamara|hamari|apna|apni|my|the|our|owner(?:'s)?)\s+/i, '')
    .replace(/\s+(?:ka|ki|ke)\s+(?:naam|name|number|no|code|value)$/i, '')
    .replace(/[?:!.,।]+$/g, '')
    .trim();
  for (const entry of SLOT_SYNONYMS) {
    if (entry.patterns.some((re) => re.test(norm))) {
      return { key: entry.key, label: entry.label };
    }
  }
  const key = norm
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097F]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  const label = norm ? norm.charAt(0).toUpperCase() + norm.slice(1) : 'Fact';
  return { key: key || 'fact', label };
}

function cleanValue(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .replace(/\s*,?\s*(?:yaad\s+rakh(?:na|o|ein|e|lo)?|remember(?:\s+(?:this|it|that))?|save\s+kar(?:\s*lo|\s*do)?|bhoolna\s+mat|ok|theek\s+hai|thik\s+hai|samjhe|understood|please|plz|bhai|bro)[.!।]*$/i, '')
    .replace(/\s+(?:hai|hain|he|h|hoon|hu|hun|है|हैं|हूँ|हूं)[.!।]*$/i, '')
    .replace(/^.+?\s+(?:nahi|nhi|nahin|nai)\s*(?:,\s*|\s+balki\s+|\s+ab\s+|\s+)(?=\S)/i, '')
    .replace(/^not\s+[^,]+,\s*(?:it(?:'s|\s+is)\s+)?/i, '')
    .replace(/[.!।]+$/g, '')
    .trim();
}

function looksLikeValidName(candidate) {
  const v = cleanValue(candidate);
  if (!v || v.length < 2 || v.length > 40) return false;
  if (QUESTION_RE.test(v)) return false;
  const words = v.split(/\s+/);
  if (words.length > 4) return false;
  const firstLow = words[0].toLowerCase();
  if (NON_NAME_STATES.has(firstLow)) return false;
  if (/\b(kholo|band|karo|bhejo|dikhao|chalao|nahi|mat|kyun|kya|kaise|kahan|me|mein|se|rehta|rehti|rahta|rahti|karta|karti|padhta|padhti|kaam)\b/i.test(v)) return false;
  return true;
}

/**
 * Parse a fact statement or correction into `{ key, label, value, display, isOverride, explicit }`.
 * When `explicit` is false (plain chat message), only clear personal facts / corrections match;
 * when `explicit` is true (`/remember …`, `yaad rakhna …`, `remember_fact` tool), free-form facts
 * are also accepted.
 */
export function extractFact(rawInput, existingFacts = {}, { explicit = false } = {}) {
  const original = clean(rawInput);
  if (!original || original.length > 400) return null;

  let text = stripPolite(original);
  let normalized = stripPolite(normalizeDevanagariWords(original));
  let hasExplicitPrefix = Boolean(explicit);
  let isOverride = false;
  let m;

  // 1. Strip explicit memory prefixes ("yaad rakhna ki …", "remember that …", "save kar lo ki …")
  const prefixRe = /^(?:(?:ab\s+se\s+)?(?:yaad\s+rakh(?:na|o|ein|e|lo)?|remember|save\s+kar(?:\s*lo|\s*do)?|memory\s+me(?:in)?\s+(?:rakh(?:o|na|\s*lo)?|save\s+kar(?:\s*lo|\s*do)?|daal(?:\s*do)?)|note\s+kar(?:\s*lo)?\s+ki|memorise|memorize|bhoolna\s+mat|don'?t\s+forget))\s*(?:ki|ke|that|:|-|,)?\s+([\s\S]+)$/i;
  if ((m = normalized.match(prefixRe))) {
    hasExplicitPrefix = true;
    normalized = stripPolite(m[1]);
    const origMatch = text.match(prefixRe);
    text = stripPolite(origMatch ? origMatch[1] : normalized);
  }

  // 2. Strip leading override / correction cues ("nahi, ab se …", "pehle X tha par ab …")
  if ((m = normalized.match(/^(?:pehle\s+.+?\s+(?:tha|thi|save\s+tha|rakha\s+tha)\s*(?:par|lekin|magar|but|,)\s*(?:ab\s+(?:se\s+)?)?)([\s\S]+)$/i))) {
    isOverride = true;
    normalized = stripPolite(m[1]);
  } else if ((m = normalized.match(/^(?:nahi|nhi|no|nope|wrong|galat|correction|update|actually)\b[,:\s-]*(?:pehle\s+wala\s+(?:galat|wrong)\s+(?:hai|tha)[,.\s]+)?(?:ab\s+se\s+|ab\s+)?([\s\S]+)$/i))) {
    isOverride = true;
    normalized = stripPolite(m[1]);
  } else if ((m = normalized.match(/^(?:ab\s+se|from\s+now\s+on)\s+([\s\S]+)$/i))) {
    isOverride = true;
    normalized = stripPolite(m[1]);
  }

  // Never treat questions as fact statements unless explicitly forced via /remember
  if (!explicit && QUESTION_RE.test(normalized)) return null;
  if (!hasExplicitPrefix && TRANSIENT_COMPLAINT_RE.test(normalized)) return null;

  // ── A. Owner's Name corrections & statements ─────────────────────────────
  // "mera naam Aman nahi Pavit hai" / "my name is not Aman, it is Pavit"
  if ((m = normalized.match(/^(?:mera\s+(?:asli\s+|pura\s+)?(?:naam|nam|name)|my\s+(?:real\s+|full\s+)?name)\s+(?:is\s+not\s+|isn'?t\s+|pehle\s+)?([^\s,]+(?:\s+[^\s,]+)?)\s+(?:nahi|nhi|not|tha\s+(?:par\s+)?ab|balki|,)\s*(?:balki|it\s+is|it'?s|ab\s+se|ab)?\s+(.+?)(?:\s+(?:hai|hain|he|h))?[.!।]*$/i))) {
    const val = cleanValue(m[2]);
    if (looksLikeValidName(val)) {
      return { key: 'name', label: 'Name', value: val, display: `My name is ${val}`, isOverride: true, explicit: hasExplicitPrefix };
    }
  }
  // "mera naam badal ke Pavit kar do" / "change my name to Pavit"
  if ((m = normalized.match(/^(?:mera\s+(?:naam|nam|name))\s+(?:badal\s+ke|change\s+karke|update\s+karke|hata\s+ke|set\s+karke)\s+(.+?)(?:\s+(?:kar(?:\s*do|\s*lo)?|rakh(?:\s*do|\s*lo)?|save\s+kar(?:\s*do|\s*lo)?|hai))?[.!।]*$/i))
      || (m = normalized.match(/^(?:change|update|set|replace)\s+my\s+name\s+(?:to|as|with)\s+(.+?)[.!।]*$/i))) {
    const val = cleanValue(m[1]);
    if (looksLikeValidName(val)) {
      return { key: 'name', label: 'Name', value: val, display: `My name is ${val}`, isOverride: true, explicit: hasExplicitPrefix };
    }
  }
  // "mera naam Pavit hai" / "mera naam hai Pavit" / "my name is Pavit"
  if ((m = normalized.match(/^(?:mera\s+(?:asli\s+|pura\s+)?(?:naam|nam|name)|my\s+(?:real\s+|full\s+)?name|my\s+name'?s)\s+(?:ab\s+(?:se\s+)?|hai\s+|is\s+)?(.+?)(?:\s+(?:hai|hain|he|h|rakh(?:o|na|ein)?|save\s+kar(?:\s*lo|\s*do)?))?[.!।]*$/i))) {
    const rawCandidate = m[1].replace(/\s+(?:yaad\s+rakh(?:na|o|ein)?|remember).*$/i, '');
    const val = cleanValue(rawCandidate);
    if (looksLikeValidName(val)) {
      return { key: 'name', label: 'Name', value: val, display: `My name is ${val}`, isOverride, explicit: hasExplicitPrefix };
    }
  }
  // "main Pavit hoon" / "I am Pavit" (only when valid name, not state/adjective)
  if ((m = normalized.match(/^(?:main|mai|mein)\s+(?:ab\s+)?([A-Za-z][A-Za-z\s]{1,28}?)\s+(?:hoon|hu|hun)[.!।]*$/i))) {
    const val = cleanValue(m[1]);
    if (looksLikeValidName(val)) {
      return { key: 'name', label: 'Name', value: val, display: `My name is ${val}`, isOverride, explicit: hasExplicitPrefix };
    }
  }
  if ((m = text.match(/^(?:i\s+am|i'?m)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})[.!]*$/))) {
    const val = cleanValue(m[1]);
    if (looksLikeValidName(val)) {
      return { key: 'name', label: 'Name', value: val, display: `My name is ${val}`, isOverride, explicit: hasExplicitPrefix };
    }
  }

  // ── A2. Agent's own name ("tumhara naam PSD_Ai hai", "apna naam PSD_Ai rakho", "your name is PSD_Ai") ──
  if ((m = normalized.match(/^(?:(?:tumhara|tera|aapka|apna|iska|agent\s+ka|bot\s+ka)\s+(?:naam|nam|name)|your\s+name)\s+(?:change\s+karke|badal\s+ke|hata\s+ke|set\s+karke|ab\s+(?:se\s+)?|hai\s+|is\s+)?(.+?)(?:\s+(?:rakh(?:o|na|lo|do)?|kar(?:\s*do|\s*lo)?|save\s+kar(?:\s*do|\s*lo)?|hai|he|h))?[.!।]*$/i))
      || (m = normalized.match(/^(?:change|set|update|rename)\s+(?:your|the\s+agent'?s|the\s+bot'?s)\s+name\s+(?:to|as)\s+(.+?)[.!।]*$/i))) {
    const val = cleanValue(m[1]);
    if (val && val.length >= 2 && val.length <= 40 && !QUESTION_RE.test(val)) {
      return { key: 'agent_name', label: 'Agent name', value: val, display: `Agent's name is ${val}`, isOverride: true, explicit: hasExplicitPrefix };
    }
  }

  // ── B. Preferred Address / Title ("mujhe Boss bulao", "call me Boss") ────
  if ((m = normalized.match(/^(?:(?:sir|boss|bhai|\S+)\s+mat\s+(?:bolo|bolna|kaho|kehna|bulao|bulana)[,\s]+(?:balki\s+|ab\s+se\s+)?)?(?:mujhe|mujhko)\s+(?:ab\s+se\s+|hamesha\s+)?(.+?)\s+(?:bulao|bulana|bulaya\s+karo|bolo|bolna|bola\s+karo|kaho|kehna|kaha\s+karo)[.!।]*$/i))) {
    const rawAddr = cleanValue(m[1]).replace(/^(?:sir\s+mat\s+(?:bolo|bulao)[,\s]*)/i, '').trim();
    if (rawAddr && !/\bmat\b/i.test(rawAddr) && rawAddr.length <= 32) {
      return { key: 'address', label: 'Preferred address', value: rawAddr, display: `Address the owner as ${rawAddr}`, isOverride: true, explicit: hasExplicitPrefix };
    }
  }
  if ((m = normalized.match(/^(?:sir|boss|bhai)\s+mat\s+(?:bolo|bolna|bulao|kaho)[,\s]+(?:mujhe\s+)?(.+?)\s+(?:bolo|bolna|bulao|bulana|kaho|kehna)[.!।]*$/i))) {
    const rawAddr = cleanValue(m[1]);
    if (rawAddr && rawAddr.length <= 32) {
      return { key: 'address', label: 'Preferred address', value: rawAddr, display: `Address the owner as ${rawAddr}`, isOverride: true, explicit: hasExplicitPrefix };
    }
  }
  if ((m = normalized.match(/^(?:don'?t\s+call\s+me\s+\S+[,\s]+)?(?:always\s+|please\s+)?(?:call\s+me|address\s+me\s+as|refer\s+to\s+me\s+as)\s+(.+?)[.!।]*$/i))) {
    const rawAddr = cleanValue(m[1]);
    if (rawAddr && rawAddr.length <= 32 && !/\b(?:at|in|on|after|later|tomorrow|kal|baje|minute|min|hour)\b/i.test(rawAddr)) {
      return { key: 'address', label: 'Preferred address', value: rawAddr, display: `Address the owner as ${rawAddr}`, isOverride: true, explicit: hasExplicitPrefix };
    }
  }

  // ── C. Residence / City ("main Dehradun me rehta hoon", "I live in …") ───
  if ((m = normalized.match(/^(?:main|mai|mein)\s+(?:ab\s+)?([A-Za-z][A-Za-z\s]{1,30}?)\s+(?:me|mein|se)\s+(?:rehta|rehti|rahta|rahti)?\s*(?:hoon|hu|hun)[.!।]*$/i))
      || (m = normalized.match(/^(?:i\s+(?:now\s+)?live\s+in|i\s+am\s+from|i'?m\s+from)\s+([A-Za-z][A-Za-z\s,]{1,35}?)[.!]*$/i))) {
    const val = cleanValue(m[1]);
    if (val && !QUESTION_RE.test(val)) {
      return { key: 'city', label: 'City', value: val, display: `Owner lives in ${val}`, isOverride, explicit: hasExplicitPrefix };
    }
  }

  // ── D. Language preference ("hamesha Hindi me jawab do", "reply in Hindi") ──
  if ((m = normalized.match(/^(?:ab\s+se\s+)?(?:hamesha|always)?\s*(?:mujhe\s+)?(hindi|hinglish|english)\s+(?:bhasha\s+)?(?:me|mein|in)\s+(?:hi\s+)?(?:baat\s+kar(?:o|na|ein)|jawab\s+d(?:o|ena|iya\s+karo)|bol(?:o|na|a\s+karo)|reply\s+kar(?:o|na))[.!।]*$/i))
      || (m = normalized.match(/^(?:from\s+now\s+on\s+)?(?:always\s+)?(?:reply|answer|speak|talk)(?:\s+to\s+me)?\s+in\s+(hindi|hinglish|english)[.!]*$/i))) {
    const val = cleanValue(m[1]);
    return { key: 'language', label: 'Preferred language', value: val, display: `Preferred language is ${val}`, isOverride: true, explicit: hasExplicitPrefix };
  }

  // ── E. Generic slot correction ("mera <slot> <old> nahi <new> hai", "change my <slot> to <new>") ──
  if ((m = normalized.match(/^(?:mera|meri|mere|my)\s+([a-zA-Z0-9_\s\-]{2,30}?)\s+(?:is\s+not\s+|isn'?t\s+|pehle\s+)?([^\s,]+(?:\s+[^\s,]+)?)\s+(?:nahi|nhi|not|tha\s+(?:par\s+)?ab|balki)\s*(?:balki|it\s+is|it'?s|ab)?\s+(.+?)(?:\s+(?:hai|hain|he|h))?[.!।]*$/i))) {
    const slot = canonicalSlot(m[1]);
    const val = cleanValue(m[3]);
    if (val && !SYSTEM_SLOT_WORDS.test(m[1].trim())) {
      return { key: slot.key, label: slot.label, value: val, display: `my ${m[1].trim()} is ${val}`, isOverride: true, explicit: hasExplicitPrefix };
    }
  }
  if ((m = normalized.match(/^(?:mera|meri|mere|apna|apni)\s+([a-zA-Z0-9_\s\-]{2,30}?)\s+(?:badal\s+ke|change\s+karke|update\s+karke|set\s+karke|hata\s+ke)\s+(.+?)(?:\s+(?:kar(?:\s*do|\s*lo)?|rakh(?:\s*do|\s*lo)?|save\s+kar(?:\s*do|\s*lo)?|hai))?[.!।]*$/i))
      || (m = normalized.match(/^(?:change|update|set|override)\s+(?:my|the)\s+([a-zA-Z0-9_\s\-]{2,30}?)\s+(?:to|as|with)\s+(.+?)[.!।]*$/i))) {
    const slot = canonicalSlot(m[1]);
    const val = cleanValue(m[2]);
    if (val && !SYSTEM_SLOT_WORDS.test(m[1].trim())) {
      return { key: slot.key, label: slot.label, value: val, display: `my ${m[1].trim()} is ${val}`, isOverride: true, explicit: hasExplicitPrefix };
    }
  }

  // ── F. General "mera/meri <slot> <value> hai" and "my <slot> is <value>" ──
  if ((m = normalized.match(/^(?:mera|meri|mere)\s+([a-zA-Z0-9_\s\-]{2,32}?)\s+(?:ab\s+(?:se\s+)?)?(.+?)\s+(?:hai|hain|he|h)[.!।]*$/i))) {
    let rawSlot = clean(m[1]);
    let rawVal = m[2];
    // Handle "mere दोस्त ka naam Rahul hai" / "meri bike ka number UK04 hai"
    const subMatch = rawVal.match(/^(?:ka|ki|ke)\s+(naam|name|number|no|code|password)\s+(.+)$/i);
    if (subMatch) {
      rawSlot = `${rawSlot} ${subMatch[1]}`;
      rawVal = subMatch[2];
    }
    if (!SYSTEM_SLOT_WORDS.test(rawSlot)) {
      const slot = canonicalSlot(rawSlot);
      const val = cleanValue(rawVal);
      const alreadySaved = Boolean(existingFacts && (slot.key in existingFacts));
      if (val && (hasExplicitPrefix || alreadySaved || KNOWN_PERSONAL_SLOTS_RE.test(rawSlot))) {
        return {
          key: slot.key,
          label: slot.label,
          value: val,
          display: `my ${rawSlot} is ${val}`,
          isOverride: isOverride || alreadySaved,
          explicit: hasExplicitPrefix,
        };
      }
    }
  }

  if ((m = normalized.match(/^(?:my)\s+([a-zA-Z0-9_\s\-]{2,35}?)\s+(?:is|are|=)\s+(?:now\s+)?(.+?)[.!।]*$/i))) {
    const rawSlot = clean(m[1]);
    if (!SYSTEM_SLOT_WORDS.test(rawSlot)) {
      const slot = canonicalSlot(rawSlot);
      const val = cleanValue(m[2]);
      const alreadySaved = Boolean(existingFacts && (slot.key in existingFacts));
      if (val && (hasExplicitPrefix || alreadySaved || KNOWN_PERSONAL_SLOTS_RE.test(rawSlot))) {
        return {
          key: slot.key,
          label: slot.label,
          value: val,
          display: hasExplicitPrefix ? text : `my ${rawSlot} is ${val}`,
          isOverride: isOverride || alreadySaved,
          explicit: hasExplicitPrefix,
        };
      }
    }
  }

  // Key = Value or Key : Value when explicitly remembered
  if (hasExplicitPrefix && (m = normalized.match(/^([a-zA-Z0-9_\s\-]{2,30}?)\s*(?:=|->|=>|:)\s*(.+)$/))) {
    const slot = canonicalSlot(m[1]);
    const val = cleanValue(m[2]);
    if (val) {
      return { key: slot.key, label: slot.label, value: val, display: `${m[1].trim()}: ${val}`, isOverride: true, explicit: true };
    }
  }

  // Free-form explicit fact ("/remember office gate closes at 9pm", "yaad rakhna mujhe chai pasand hai")
  if (hasExplicitPrefix && text) {
    const key = normalized
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || text.slice(0, 48);
    return { key, label: 'Fact', value: text, display: text, isOverride, explicit: true };
  }

  return null;
}

/**
 * Save or update a fact in `store.data.facts` (and `store.data.factValues`),
 * replacing any older entry for the same canonical slot so outdated facts never linger.
 */
export function rememberFact(store, rawText, { explicit = false } = {}) {
  if (!store?.data) return null;
  if (!store.data.facts || typeof store.data.facts !== 'object') store.data.facts = {};
  if (!store.data.factValues || typeof store.data.factValues !== 'object') store.data.factValues = {};

  const parsed = extractFact(rawText, store.data.facts, { explicit });
  if (!parsed) return null;

  // Resolve "mujhe mere naam se bulao" / "call me by my name"
  if (parsed.key === 'address' && /^(?:mere\s+naam(?:\s+se)?|apne\s+naam(?:\s+se)?|(?:by\s+)?my\s+name)$/i.test(parsed.value)) {
    const savedName = getOwnerName(store);
    if (savedName) {
      parsed.value = savedName;
      parsed.display = `Address the owner as ${savedName}`;
    }
  }

  let previousValue = store.data.factValues[parsed.key] ?? null;

  // Sweep `store.data.facts` for any existing or legacy key that maps to the same canonical slot.
  for (const [k, existingDisplay] of Object.entries(store.data.facts)) {
    if (k === parsed.key) {
      if (!previousValue) {
        const prevParsed = extractFact(existingDisplay, {}, { explicit: true });
        previousValue = prevParsed?.value ?? existingDisplay;
      }
      continue;
    }
    const existingParsed = extractFact(existingDisplay, {}, { explicit: true });
    if (existingParsed && existingParsed.key === parsed.key) {
      if (!previousValue) previousValue = existingParsed.value;
      delete store.data.facts[k];
    }
  }

  const updated = Boolean(previousValue && String(previousValue).toLowerCase() !== String(parsed.value).toLowerCase());
  store.data.facts[parsed.key] = parsed.display;
  store.data.factValues[parsed.key] = parsed.value;

  // If the owner updated an existing fact (e.g. changed their name), prune stale
  // assistant claims of the old value from chat history so the LLM never argues back.
  if (updated && Array.isArray(store.data.history) && previousValue) {
    const oldLow = String(previousValue).toLowerCase();
    store.data.history = store.data.history.filter((turn) => {
      if (turn?.role !== 'assistant') return true;
      return !String(turn.content ?? '').toLowerCase().includes(oldLow);
    });
  }

  store.save?.();

  let reply;
  if (parsed.key === 'name') {
    reply = updated
      ? `🧠 Remembered — aapka naam update kar diya: ab *${parsed.value}* yaad rakhunga (pehle *${previousValue}* save tha). (/memory to see all)`
      : `🧠 Remembered — aapka naam *${parsed.value}* yaad rakh liya. (/memory to see all)`;
  } else if (parsed.key === 'agent_name') {
    reply = updated
      ? `🧠 Done! Mera naam ab *${parsed.value}* hai (pehle *${previousValue}* save tha).`
      : `🧠 Done! Mera naam ab *${parsed.value}* hai.`;
  } else if (parsed.key === 'address') {
    reply = updated
      ? `🧠 Remembered — ab se aapko *${parsed.value}* kahunga (pehle *${previousValue}* save tha). (/memory to see all)`
      : `🧠 Remembered — ab se aapko *${parsed.value}* kahunga. (/memory to see all)`;
  } else if (updated) {
    reply = `🧠 Remembered — update kar diya: *${parsed.label}* ab *${parsed.value}* hai (pehle *${previousValue}* save tha). (/memory to see all)`;
  } else {
    reply = `🧠 Remembered. I'll keep it in mind in our chats: *${parsed.display}* (/memory to see all)`;
  }

  return {
    ok: true,
    key: parsed.key,
    label: parsed.label,
    value: parsed.value,
    display: parsed.display,
    previousValue,
    updated,
    reply,
  };
}

/** Look up a canonical slot value from `store` (works with both new and legacy `facts` entries). */
export function getFactValue(store, slotOrQuery) {
  const facts = store?.data?.facts;
  if (!facts || typeof facts !== 'object') return null;
  const entries = Object.entries(facts);
  if (!entries.length) return null;

  const { key } = canonicalSlot(slotOrQuery);
  if (key in facts) {
    if (store.data.factValues && store.data.factValues[key]) {
      return store.data.factValues[key];
    }
    const p = extractFact(facts[key], {}, { explicit: true });
    return p?.value ?? facts[key];
  }

  // Fallback: scan existing entries (handles pre-existing legacy keys in store.json)
  for (const [k, v] of entries) {
    const p = extractFact(v, {}, { explicit: true });
    if (p && p.key === key) return p.value;
    if (k.toLowerCase().includes(key) || String(v).toLowerCase().includes(slotOrQuery.toLowerCase())) {
      return p?.value ?? v;
    }
  }
  return null;
}

export function getOwnerName(store) {
  return getFactValue(store, 'name');
}

export function getAgentName(store, config = {}) {
  const custom = getFactValue(store, 'agent_name');
  if (custom) return custom;
  return String(config?.agentName || 'PSD_Ai').trim() || 'PSD_Ai';
}

export function getOwnerAddress(store, config = {}) {
  const customAddr = getFactValue(store, 'address');
  if (customAddr) return customAddr;
  const ownerName = getFactValue(store, 'name');
  if (ownerName) return ownerName;
  return String(config?.jarvisAddress || 'Sir').trim() || 'Sir';
}

export function forgetFact(store, slotOrQuery) {
  if (!store?.data) return { ok: false, removed: 0 };
  const raw = clean(slotOrQuery);
  const { key, label } = canonicalSlot(raw);
  let removed = 0;

  if (store.data.facts && typeof store.data.facts === 'object') {
    for (const [k, v] of Object.entries(store.data.facts)) {
      const p = extractFact(v, {}, { explicit: true });
      if (k === key || p?.key === key || k.toLowerCase() === raw.toLowerCase() || String(v).toLowerCase().includes(raw.toLowerCase())) {
        delete store.data.facts[k];
        removed += 1;
      }
    }
  }
  if (store.data.factValues && key in store.data.factValues) {
    delete store.data.factValues[key];
  }
  if (Array.isArray(store.data.rules)) {
    const normTrig = normalizeTrigger(raw);
    const before = store.data.rules.length;
    store.data.rules = store.data.rules.filter((r) => r.triggerNorm !== normTrig && r.triggerNorm !== key);
    if (store.data.rules.length < before) removed += before - store.data.rules.length;
  }
  if (removed > 0) store.save?.();
  return { ok: removed > 0, removed, key, label };
}

// ── Custom trigger → action rules ("agar main X kahun to Y karo") ────────────

export function normalizeTrigger(raw) {
  return stripPolite(normalizeDevanagariWords(raw))
    .replace(/^["'“”‘’`/]+|["'“”‘’`]+$/g, '')
    .replace(/[.!?,।]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Convert a Hindi/Hinglish rule action phrase ("brave kholna", "screenshot bhejna",
 * "chrome open karna") into a runnable imperative command ("brave kholo", "screenshot bhejo").
 */
export function normalizeActionCommand(rawAction) {
  let act = stripPolite(normalizeDevanagariWords(rawAction))
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .replace(/^(?:tum|aap|yeh|ye|tu|hamesha|always|seedha|turant|bas)\s+/i, '')
    .replace(/\s+(?:kar\s+diya\s+karo|kiya\s+karo|karna\s+hai|karein|karen|karna)$/i, (m) => (/karna/i.test(m) ? ' karo' : ''))
    .replace(/[.!।]+$/g, '')
    .trim();

  // Infinitive verb endings at the end of a command → imperative
  act = act
    .replace(/\bkholna$/i, 'kholo')
    .replace(/\bband\s+karna$/i, 'band karo')
    .replace(/\bchalana$/i, 'chalao')
    .replace(/\bbajao\s+karna$/i, 'bajao')
    .replace(/\bbajana$/i, 'bajao')
    .replace(/\bbhejna$/i, 'bhejo')
    .replace(/\bdikhana$/i, 'dikhao')
    .replace(/\bbatana$/i, 'batao')
    .replace(/\bpadhna$/i, 'padho')
    .replace(/\blikhna$/i, 'likho')
    .replace(/\bdhundhna$/i, 'dhundo')
    .replace(/\bdhoondhna$/i, 'dhundo')
    .replace(/\bopen\s+karna$/i, 'open karo')
    .replace(/\bclose\s+karna$/i, 'close karo')
    .replace(/\brun\s+karna$/i, 'run karo')
    .trim();

  return act;
}

/**
 * Detect custom rule statements like:
 *   • "agar main browser kholo kahun to brave kholna"
 *   • "jab main work bolun to chrome kholo"
 *   • "when I say study, open firefox"
 *   • "gaana chalao bolne par spotify kholo"
 *   • "agar main kuch kahun to wohi karna jo main kahun" (general override directive)
 */
export function parseRuleStatement(rawInput) {
  const original = clean(rawInput);
  if (!original || original.length > 400) return null;
  const text = stripPolite(normalizeDevanagariWords(original));
  if (QUESTION_RE.test(text)) return null;
  let m;

  // General meta-directive: "agar main kuch kahun to wohi karna jo main kahun" / "jo main kahun wohi karna"
  if (/\b(?:wohi|wahi|yehi|yahi)\s+(?:kar(?:na|o|ein|e)|ho|maan(?:na|o))\s+jo\s+(?:main|mai|mein|hum)\s+(?:kahun|kahu|bolun|bolu|kahu|chahta)/i.test(text)
      || /^(?:pehle\s+se\s+kuch\s+(?:aur\s+)?save\s+ho\s+par\s+)?(?:agar\s+(?:main|mai|mein)\s+(?:kuch\s+)?(?:kahun|kahu|bolun|bolu)\s+to\s+)?(?:yeh|ye|tum)?\s*(?:wohi|wahi)\s+(?:kar(?:ein|e|o|na))\s+jo\s+(?:main|mai|mein)\s+(?:kahun|kahu|bolun|bolu)/i.test(text)) {
    return {
      kind: 'directive',
      value: 'Always obey the owner\'s latest instruction and override any older saved fact, preference, or default.',
    };
  }

  // 1. "agar/jab main <trigger> kahun/bolun to <action>"
  if ((m = text.match(/^(?:pehle\s+.+?\s+(?:par|lekin|but)\s+)?(?:ab\s+se\s+)?(?:yaad\s+rakh(?:na|o|ein)?\s*(?:ki)?\s*)?(?:agar|jab(?:\s+bhi)?)\s+(?:main|mai|mein|hum)\s+["'“”]?(.{1,60}?)["'“”]?\s+(?:kahun|kahu|kahein|kahe|bolun|bolu|bolein|bole|likhun|likhu|bhejun|bheju)\s*(?:to|toh|tab|,)\s*(?:tum\s+|yeh\s+|ye\s+|aap\s+|pehle\s+wala\s+chhod\s+ke\s+)?["'“”]?(.+?)["'“”]?[.!।]*$/i))) {
    const trigger = clean(m[1]).replace(/^ki\s+/i, '');
    const actionRaw = clean(m[2]);
    return buildParsedRule(trigger, actionRaw);
  }

  // 2. "when(ever) I say <trigger>, <action>"
  if ((m = text.match(/^(?:from\s+now\s+on[,\s]+)?(?:remember\s+(?:that\s+)?)?(?:when(?:ever)?|if)\s+i\s+(?:say|type|ask(?:\s+for)?)\s+["'“”]?(.{1,60}?)["'“”]?\s*(?:,|then|->|=>|do)\s*(?:you\s+(?:should|must)\s+|always\s+|just\s+)?["'“”]?(.+?)["'“”]?[.!]*$/i))) {
    return buildParsedRule(clean(m[1]), clean(m[2]));
  }

  // 3. "<trigger> bolne/kehne par <action>"
  if ((m = text.match(/^(?:ab\s+se\s+)?["'“”]?(.{2,45}?)["'“”]?\s+(?:bolne|kehne|likhne)\s+(?:par|pe)\s+["'“”]?(.+?)["'“”]?[.!।]*$/i))) {
    return buildParsedRule(clean(m[1]), clean(m[2]));
  }

  // 4. "ab se <trigger> ka matlab <action> hai"
  if ((m = text.match(/^(?:ab\s+se\s+|yaad\s+rakh(?:na|o)\s+(?:ki\s+)?)["'“”]?(.{2,40}?)["'“”]?\s+ka\s+matlab\s+["'“”]?(.+?)["'“”]?\s*(?:hai|hota\s+hai|samjho|karo|rakhna)?[.!।]*$/i))) {
    return buildParsedRule(clean(m[1]), clean(m[2]));
  }

  return null;
}

function buildParsedRule(trigger, actionRaw) {
  const triggerNorm = normalizeTrigger(trigger);
  if (!triggerNorm || triggerNorm.length < 2) return null;
  if (/^(?:kuch|kuch\s+bhi|anything|something)$/.test(triggerNorm)) {
    return {
      kind: 'directive',
      value: `Owner directive: ${actionRaw}`,
    };
  }

  // Check if the action is "mujhe <X> bulao/bolna" (which sets preferred address)
  const addrMatch = actionRaw.match(/^(?:mujhe|mujhko)\s+(.+?)\s+(?:bulao|bulana|bolo|bolna|kaho|kehna)$/i);
  if (addrMatch && /^(?:mera\s+naam|naam|hello|hi|jarvis)$/.test(triggerNorm)) {
    return { kind: 'fact', text: `mujhe ${addrMatch[1]} bulao` };
  }

  // Check if the action is a custom text reply: "bolna <text>" / "kaho <text>" / "reply <text>" / "say <text>"
  const replyMatch = actionRaw.match(/^(?:bolna|bolo|kaho|kehna|jawab\s+dena|reply(?:\s+with)?|say)\s+(?:ki\s+)?["'“”]?(.+?)["'“”]?$/i);
  if (replyMatch) {
    return {
      kind: 'rule',
      ruleKind: 'reply',
      trigger: trigger.replace(/^["'“”]+|["'“”]+$/g, '').trim(),
      triggerNorm,
      action: replyMatch[1].trim(),
    };
  }

  const action = normalizeActionCommand(actionRaw);
  if (!action) return null;
  return {
    kind: 'rule',
    ruleKind: 'command',
    trigger: trigger.replace(/^["'“”]+|["'“”]+$/g, '').trim(),
    triggerNorm,
    action,
  };
}

/**
 * Save or overwrite a trigger→action rule in `store.data.rules` (and sync with
 * `store.data.learned` when the trigger is a single keyword).
 */
export function addRule(store, parsedRule) {
  if (!store?.data || !parsedRule) return null;
  if (!Array.isArray(store.data.rules)) store.data.rules = [];

  const { trigger, triggerNorm, ruleKind = 'command', action } = parsedRule;
  const existingRule = store.data.rules.find((r) => r.triggerNorm === triggerNorm);
  const kw = learn.normalizeKeyword(triggerNorm);
  const existingLearned = (!triggerNorm.includes(' ') && kw === triggerNorm) ? store.getLearned?.(kw) : null;

  const previousAction = existingRule?.action
    ?? (existingLearned ? learn.formatLearned(existingLearned).replace(/^\/\S+\s*→\s*/, '') : null);

  store.data.rules = store.data.rules.filter((r) => r.triggerNorm !== triggerNorm);
  const id = store.data.rules.reduce((max, item) => Math.max(max, item.id ?? 0), 0) + 1;
  const entry = {
    id,
    trigger,
    triggerNorm,
    kind: ruleKind,
    action,
    createdTs: Date.now(),
  };
  store.data.rules.push(entry);

  // Sync single-word command triggers into `store.data.learned` so `/<kw>` works too.
  if (ruleKind === 'command' && !triggerNorm.includes(' ') && kw && kw.length >= 2 && !learn.isReserved(kw)) {
    const cmds = learn.parseLearnCommands(action);
    if (cmds) {
      store.addLearned?.(kw, cmds, action);
    }
  }

  store.save?.();

  const updated = Boolean(previousAction && previousAction.toLowerCase() !== action.toLowerCase());
  const reply = updated
    ? `🧠 Remembered — rule update kar diya: jab aap *"${trigger}"* kahenge, ab main *"${action}"* karunga (pehle *"${previousAction}"* save tha).`
    : `🧠 Remembered — jab aap *"${trigger}"* kahenge, main *"${action}"* karunga.`;

  return { ok: true, entry, previousAction, updated, reply };
}

/**
 * Match an incoming plain message against user-defined rules (`store.data.rules`)
 * or learned keywords (`store.data.learned`). User rules run BEFORE built-in NLP
 * intents so the owner's instructions always override defaults.
 */
export function matchRule(store, inputText) {
  if (!store?.data) return null;
  const norm = normalizeTrigger(inputText);
  if (!norm) return null;

  // Strip optional trailing "karo / kar do / chala do / chalu karo" for trigger matching
  const bare = norm.replace(/\s+(?:karo|kar\s+do|chala\s+do|chalao|chalu\s+karo)$/i, '').trim();

  if (Array.isArray(store.data.rules)) {
    const hit = store.data.rules.find((r) => r.triggerNorm === norm || (bare && r.triggerNorm === bare));
    if (hit) return { type: 'rule', rule: hit };
  }

  // Also allow plain-text invocation of learned keywords ("work" or "work karo" → /work)
  if (Array.isArray(store.data.learned) && store.data.learned.length) {
    const candidateKw = !norm.includes(' ') ? norm : (!bare.includes(' ') ? bare : '');
    if (candidateKw) {
      const learnedEntry = store.getLearned?.(candidateKw);
      if (learnedEntry) return { type: 'learned', keyword: learnedEntry.keyword, entry: learnedEntry };
    }
  }

  return null;
}

/**
 * Detect immediate per-turn overrides in a command:
 *   • "firefox nahi chrome kholo" / "firefox ki jagah chrome kholo" → { text: "chrome kholo", bypassSaved: true }
 *   • "open chrome instead of firefox" → { text: "open chrome", bypassSaved: true }
 *   • "pehle wala chhodo, chrome kholo" / "is baar chrome kholo" / "nahi, chrome kholo"
 */
export function unwrapImmediateOverride(rawInput) {
  const original = clean(rawInput);
  if (!original) return { text: original, bypassSaved: false };
  const text = stripPolite(normalizeDevanagariWords(original));
  let m;

  // 1. "<old> nahi <new> kholo / band karo" or "<old> ki jagah <new> kholo"
  if ((m = text.match(/^(?:pehle\s+wala\s+|saved\s+wala\s+|\S+\s+)(?:nahi|nhi|ki\s+jagah|ke\s+bajay)[,\s]+(?:balki\s+|abhi\s+|is\s+baar\s+)?(.+?\s+(?:khol(?:o|do|de)?|open(?:\s+kar(?:o|do))?|chalu\s+kar(?:o|do)|band\s+kar(?:o|do)|close(?:\s+kar(?:o|do))?|chalao|bhejo|dikhao))$/i))) {
    return { text: clean(m[1]), bypassSaved: true };
  }
  // 2. "open <new> instead of <old>"
  if ((m = text.match(/^((?:open|launch|close|quit|run|use)\s+.+?)\s+(?:instead\s+of|rather\s+than|not)\s+.+$/i))) {
    return { text: clean(m[1]), bypassSaved: true };
  }
  // 3. Explicit override preambles: "pehle jo save hai chhodo, <cmd>" / "is baar <cmd>" / "nahi, <cmd>"
  if ((m = text.match(/^(?:(?:pehle\s+(?:jo\s+save\s+hai|wala|saved\s+wala)\s+(?:chhodo|chhod\s+do|hatao|bhool\s+jao| rehne\s+do)|jo\s+pehle\s+save\s+hai\s+(?:use\s+)?chhodo|saved\s+wala\s+nahi)[,:\s-]+)(?:abhi\s+|is\s+baar\s+)?([\s\S]+)$/i))) {
    return { text: clean(m[1]), bypassSaved: true };
  }
  if ((m = text.match(/^(?:is\s+baar|abhi\s+ke\s+liye|sirf\s+abhi|mere\s+kehne\s+(?:pe|par)|main\s+keh\s+raha\s+hoon\s+(?:to|ki)?)\s*[,:\s-]*([\s\S]+)$/i))) {
    return { text: clean(m[1]), bypassSaved: true };
  }
  // "nahi, chrome kholo" (only when followed by an actual multi-word command, not bare "nahi")
  if ((m = text.match(/^(?:nahi|nhi|no|cancel\s+karo\s+aur)[,\s]+(?:abhi\s+|is\s+baar\s+)?([a-zA-Z0-9][\s\S]{3,})$/i))) {
    const rest = clean(m[1]);
    // Do not strip if it's a fact correction ("mera naam …"), which extractFact handles directly
    if (!/^(?:mera|meri|mere|my\s+name|mujhe)\b/i.test(rest)) {
      return { text: rest, bypassSaved: true };
    }
  }

  return { text: original, bypassSaved: false };
}

/**
 * If the owner asks to open a generic category ("browser", "editor") and has a
 * saved preference in memory (`browser: "brave"`), resolve to that preference.
 * If they named a specific app ("chrome", "firefox") or `bypassSaved` is true,
 * return their explicit app name untouched.
 */
export function resolvePreferredApp(store, appName, { bypassSaved = false } = {}) {
  const raw = clean(appName);
  if (!raw || bypassSaved) return raw;
  if (/^(?:browser|web\s+browser|default\s+browser|mera\s+browser|my\s+browser)$/i.test(raw)) {
    return getFactValue(store, 'browser') || raw;
  }
  if (/^(?:editor|code\s+editor|text\s+editor|ide|mera\s+editor|my\s+editor)$/i.test(raw)) {
    return getFactValue(store, 'editor') || raw;
  }
  return raw;
}

// ── Natural-language Memory Queries & Handler ────────────────────────────────

export function formatMemoryList(store) {
  const facts = Object.values(store?.data?.facts ?? {});
  const rules = store?.data?.rules ?? [];
  if (!facts.length && !rules.length) {
    return '🧠 I haven\'t memorised anything yet. Try: /remember my office Wi-Fi password is … ya seedha bolo "mera naam … hai"';
  }
  const sections = [];
  if (facts.length) {
    sections.push('🧠 *What I remember*\n\n' + facts.map((f) => `• ${f}`).join('\n'));
  }
  if (rules.length) {
    sections.push('⚡ *Custom rules (jab aap kahenge → main karunga)*\n\n' + rules.map((r) => `• "${r.trigger}" → ${r.action}`).join('\n'));
  }
  sections.push('/forget <item> — ek cheez hatao · /forget memory — sab saaf karo');
  return sections.join('\n\n');
}

export function formatMemoryForPrompt(store, config = {}) {
  const agentName = getAgentName(store, config);
  const name = getOwnerName(store);
  const address = getOwnerAddress(store, config);
  const facts = Object.values(store?.data?.facts ?? {});
  const rules = store?.data?.rules ?? [];
  const lines = [
    `Your name (assistant identity): ${agentName} (if the owner asks "tumhara naam kya hai" / "what is your name" / "who are you" / "tum kaun ho", always answer "${agentName}").`,
  ];
  if (name) lines.push(`Owner's name: ${name} (if they ask "mera naam kya hai" / "what is my name" / "who am I", answer "${name}").`);
  if (address) lines.push(`Preferred way to address the owner: "${address}".`);
  if (facts.length) {
    lines.push('Things the owner asked you to remember (latest saved truth):\n' + facts.map((f) => `- ${f}`).join('\n'));
  }
  if (rules.length) {
    lines.push('Owner\'s custom trigger rules:\n' + rules.map((r) => `- When owner says "${r.trigger}" → ${r.action}`).join('\n'));
  }
  lines.push(
    'PRIORITY RULE (Owner Command > Saved Memory > Defaults): Always use the owner\'s saved name, preferences, and rules above. However, if the owner tells you a new fact, changes their name/preference, or gives a direct instruction in the current message that conflicts with anything saved earlier or in chat history, ALWAYS obey what the owner says right now without arguing.',
  );
  return lines.join('\n\n');
}

/**
 * Check if `rawText` is a natural-language memory operation:
 *   1. Custom rule definition ("agar main X kahun to Y karo")
 *   2. Fact statement / update ("mera naam Pavit hai", "nahi mera naam Rahul hai", "mujhe Boss bulao")
 *   3. Forget request ("mera naam bhool jao", "forget my bike")
 *   4. Memory recall query ("mera naam kya hai?", "what is my bike number?", "tumhe kya yaad hai?")
 * Returns a reply string, or `undefined` if not a memory intent.
 */
export function handleMemoryIntent(store, config, rawText, opts = {}) {
  const original = clean(rawText);
  if (!original || original.length > 400) return undefined;
  // Let existing `note:` / `remind me` / `todo:` shortcuts run untouched
  if (/^(?:remind\s+me\b|note(?:\s+kar\s+lo)?\s*[:\-]|note\s+that\s+|add\s+(?:a\s+)?todo[:\s]|todo[:\s])/i.test(original)) {
    return undefined;
  }

  const norm = stripPolite(normalizeDevanagariWords(original));
  const address = getOwnerAddress(store, config);
  const englishVoice = Boolean(opts.voice && config?.jarvisEnglishOnly !== false);
  let m;

  // 1. Custom rule definition ("agar main X kahun to Y karo")
  const parsedRule = parseRuleStatement(original);
  if (parsedRule) {
    if (parsedRule.kind === 'directive') {
      const saved = rememberFact(store, `owner_priority_rule: ${parsedRule.value}`, { explicit: true });
      return englishVoice
        ? `Understood, ${address}. I shall remember everything you tell me, and whenever you give a new instruction, it will always override anything saved previously.`
        : `🧠 Remembered — bilkul! Aap jo naam ya baat batayenge wo yaad rakhunga, aur agar pehle se kuch aur save ho par aap kuch naya kahenge to hamesha wohi karunga jo aap kahenge. (${saved ? 'Saved' : 'Active'})`;
    }
    if (parsedRule.kind === 'fact') {
      const res = rememberFact(store, parsedRule.text, { explicit: true });
      return res?.reply;
    }
    const res = addRule(store, parsedRule);
    if (res) {
      return englishVoice
        ? `Very well, ${address}. Whenever you say "${parsedRule.trigger}", I shall run "${parsedRule.action}".`
        : res.reply;
    }
  }

  // 2. Forget a specific fact/rule in natural language ("mera naam bhool jao", "forget my bike")
  if ((m = norm.match(/^(?:mera|meri|mere|my)\s+([a-zA-Z0-9_\s\-]{2,30}?)\s+(?:bhool\s+ja(?:o|na)?|forget\s+kar(?:\s*do)?|memory\s+se\s+hata(?:\s*do|o)?|delete\s+kar(?:\s*do)?)[.!।]*$/i))
      || (m = norm.match(/^(?:bhool\s+ja(?:o|na)?|forget|memory\s+se\s+hata(?:o|\s+do))\s+(?:ki\s+|that\s+)?(?:mera|meri|mere|my)\s+([a-zA-Z0-9_\s\-]{2,30}?)[.!।]*$/i))) {
    const target = clean(m[1]);
    // Do not intercept file deletion ("old.txt delete karo")
    if (!/\.\w{1,6}$/.test(target)) {
      const res = forgetFact(store, target);
      return res.ok
        ? `🧹 Memory se *${res.label}* hata diya.`
        : `🧠 *${target}* naam se kuch memory me save nahi tha.`;
    }
  }

  // 3. Fact statement or update ("mera naam Pavit hai", "mujhe Boss bulao", "yaad rakhna …")
  const factRes = rememberFact(store, original, { explicit: false });
  if (factRes) {
    if (englishVoice) {
      if (factRes.key === 'name') {
        return factRes.updated
          ? `Very well, ${factRes.value}. I have updated your name from ${factRes.previousValue} to ${factRes.value}.`
          : `Pleasure to meet you, ${factRes.value}. I shall remember your name.`;
      }
      if (factRes.key === 'agent_name') {
        return `Very well, ${address}. My name is now ${factRes.value}.`;
      }
      if (factRes.key === 'address') {
        return `Very well, ${factRes.value}. I shall address you as ${factRes.value} from now on.`;
      }
      return `Noted and remembered, ${getOwnerAddress(store, config)}.`;
    }
    return factRes.reply;
  }

  // 4. Memory recall queries ("mera naam kya hai?", "tumhara naam kya hai?", "tumhe kya yaad hai?")
  // 4a-0. Asking for the agent's own name / identity ("tumhara naam kya hai?", "tum kaun ho?", "what is your name?")
  if (/^(?:(?:tumhara|tera|aapka|your)\s+(?:asli\s+|pura\s+)?(?:naam|nam|name)\s+(?:kya\s*(?:hai|he|tha)?|batao|bata|bolo)|(?:tumhara|tera|aapka|your)\s+(?:naam|nam|name)\s*\?|apna\s+(?:naam|nam|name)\s+bata(?:o)?|what(?:'s|\s+is)\s+your\s+name|who\s+are\s+you|tum\s+kaun\s+ho|tu\s+kaun\s+hai|aap\s+kaun\s+ho|kaun\s+bol\s+raha\s+hai)[?!.।]*$/i.test(norm)) {
    const agentName = getAgentName(store, config);
    const ownerName = getOwnerName(store);
    if (englishVoice) {
      return `I am ${agentName} — your personal AI assistant, running right here on your own computer, ${address}.`;
    }
    return `🤖 Mera naam *${agentName}* hai${ownerName ? `, *${ownerName}*` : ''}! Main aapka fast & powerful personal AI + full PC control assistant hoon.`;
  }

  // 4a. Asking for owner's name
  if (/^(?:(?:mera|my)\s+(?:asli\s+|pura\s+)?(?:naam|nam|name)\s+(?:kya\s*(?:hai|tha|save\s+hai|he)?|batao|bata|bolo)|(?:mera|my)\s+(?:naam|nam|name)\s*\?|what(?:'s|\s+is)\s+my\s+name|who\s+am\s+i|main\s+kaun\s+(?:hoon|hu|hun)|mai\s+kaun\s+(?:hoon|hu|hun)|(?:kya\s+)?tumhe\s+mera\s+naam\s+(?:pata|yaad)\s+hai|do\s+you\s+(?:know|remember)\s+my\s+name)[?!.।]*$/i.test(norm)) {
    const name = getOwnerName(store);
    if (name) {
      return englishVoice
        ? `Your name is ${name}, ${address}.`
        : `🧠 Aapka naam *${name}* hai.`;
    }
    return englishVoice
      ? `You haven't told me your name yet, ${address}. Simply say "my name is ..." and I shall remember it.`
      : '🧠 Aapne abhi apna naam nahi bataya hai. Bas kahiye *"mera naam <naam> hai"* aur main yaad rakhunga.';
  }

  // 4b. Asking how the agent addresses the owner
  if (/^(?:(?:tum\s+)?mujhe\s+kya\s+(?:bulaoge|bulate\s+ho|bolte\s+ho|bologe|kahoge)|what\s+(?:do|will|should)\s+you\s+call\s+me|how\s+do\s+you\s+address\s+me)[?!.।]*$/i.test(norm)) {
    return englishVoice
      ? `I address you as ${address}.`
      : `🧠 Main aapko *${address}* keh kar bulata hoon. (Badalne ke liye kahiye: *"mujhe <naam> bulao"*)`;
  }

  // 4c. Asking for all saved memory
  if (/^(?:tumhe\s+(?:mere\s+baare\s+me(?:in)?\s+)?kya\s+(?:yaad|pata)\s+hai|mere\s+baare\s+me(?:in)?\s+kya\s+(?:pata|yaad|save)\s+hai|memory\s+(?:me(?:in)?\s+kya\s+(?:hai|save\s+hai)|dikhao|batao|list)|kya\s+kya\s+(?:yaad|save)\s+hai|what\s+do\s+you\s+(?:remember|know\s+about\s+me)|show\s+(?:my\s+)?memory)[?!.।]*$/i.test(norm)) {
    return formatMemoryList(store);
  }

  // 4d. Asking where the owner lives
  if (/^(?:main\s+kahan\s+(?:rehta|rehti|rahta|rahti)\s+(?:hoon|hu|hun)|where\s+do\s+i\s+live)[?!.।]*$/i.test(norm)) {
    const city = getFactValue(store, 'city');
    if (city) {
      return englishVoice
        ? `You live in ${city}, ${address}.`
        : `🧠 Aap *${city}* me rehte hain.`;
    }
  }

  // 4e. Asking for any specific saved personal slot ("mera bike number kya hai?", "what is my gate code?")
  if ((m = norm.match(/^(?:mera|meri|mere)\s+([a-zA-Z0-9_\s\-]{2,32}?)\s+(?:kya\s*(?:hai|tha|save\s+hai|he)?|batao|konsa\s+hai|kaunsa\s+hai|kitna\s+hai|kitni\s+hai)[?!.।]*$/i))
      || (m = norm.match(/^(?:what(?:'s|\s+is)\s+my)\s+([a-zA-Z0-9_\s\-]{2,32}?)[?!.।]*$/i))) {
    const rawSlot = clean(m[1]).replace(/\s+(?:ka\s+(?:naam|number|code|password))$/i, (sub) => ` ${sub.trim().split(/\s+/).pop()}`);
    if (!SYSTEM_SLOT_WORDS.test(rawSlot)) {
      const val = getFactValue(store, rawSlot);
      const { label } = canonicalSlot(rawSlot);
      if (val) {
        return englishVoice
          ? `Your ${label.toLowerCase()} is ${val}, ${address}.`
          : `🧠 *${label}*: *${val}*`;
      }
      if (KNOWN_PERSONAL_SLOTS_RE.test(rawSlot)) {
        return englishVoice
          ? `You haven't told me your ${label.toLowerCase()} yet, ${address}.`
          : `🧠 Mere paas aapka *${rawSlot}* abhi save nahi hai. Aap *"mera ${rawSlot} <value> hai"* bolke yaad dila sakte hain.`;
      }
    }
  }

  return undefined;
}
