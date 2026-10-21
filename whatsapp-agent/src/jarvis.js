// jarvis.js — J.A.R.V.I.S.: persona, spoken language, and speech normalisation.
//
// Why this file exists: a WhatsApp reply is written for eyes ("• item one\n•
// item two\n```code``` *bold* https://…"). Read aloud raw it sounds like a
// robot reading markup. JARVIS never does that — he speaks in short, calm,
// British-butler sentences and *summarises*. Everything voice-shaped in the
// agent goes through here first:
//
//   spokenSummary(text)      WhatsApp text → something worth saying out loud
//   splitSentences(text)     sentence chunks for streaming TTS
//   normalizeSpokenText(x)   STT output → text the command layers understand
//                            (Devanagari "क्रोम खोलो" → "chrome kholo",
//                             "volume fifty" → "volume 50", wake words, …)
//   personaLines()           the butler rules injected into AI system prompts
//
// Pure functions only — no I/O — so every rule is unit-testable offline.

export const DEFAULT_MAX_SPOKEN_CHARS = 340;

const addressOf = (config = {}) => String(config.jarvisAddress || 'Sir').trim() || 'Sir';

// ── greetings & stock phrases ────────────────────────────────────────────────

export function jarvisGreeting(config = {}, now = new Date()) {
  const tz = config.timezone || 'Asia/Kolkata';
  let hour = now.getHours();
  try {
    hour = Number(new Intl.DateTimeFormat('en-IN', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now));
  } catch { /* keep local hour */ }
  const part = hour < 5 ? 'evening' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  const who = addressOf(config);
  return hour < 5
    ? `Good ${part}, ${who}. Burning the midnight oil, I see. All systems are at your disposal.`
    : `Good ${part}, ${who}. All systems are now fully operational. How may I assist you?`;
}

export function jarvisFarewell(config = {}) {
  return `Very good, ${addressOf(config)}. I shall be here when you need me.`;
}

const ACKS = ['Right away', 'Very well', 'Certainly', 'Of course', 'At once'];
export function jarvisAck(config = {}, seed = Date.now()) {
  return `${ACKS[Math.abs(Math.trunc(seed)) % ACKS.length]}, ${addressOf(config)}.`;
}

// ── persona for the AI brains ────────────────────────────────────────────────

/**
 * Lines appended to AI system prompts. `voice: true` adds the strict
 * spoken-reply rules used during calls (short, no lists, confirm in one line).
 */
export function personaLines(config = {}, { voice = false } = {}) {
  if (config.jarvisPersona === false) return [];
  const who = addressOf(config);
  const lines = [
    `Your name is J.A.R.V.I.S. — a calm, impeccably polite British digital butler in the manner of Iron Man's JARVIS. Address the owner as "${who}". Dry wit is welcome, never at the owner's expense. Never say "As an AI".`,
    'Preference order for style: accomplish first, report briefly. One or two crisp sentences beat a paragraph.',
  ];
  if (voice) {
    lines.push(
      'This reply will be SPOKEN ALOUD on a voice call. Rules: maximum 2 short sentences; no lists, no markdown, no code, no URLs, no file paths unless asked; numbers spoken naturally; confirm what you DID ("Chrome is open, Sir") rather than describing the plan.',
      'If the full detail is long (a list, code, a report), say the headline result aloud and add "I have sent the details in text."',
    );
  }
  return lines;
}

// ── spoken summary ───────────────────────────────────────────────────────────

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu;

/** Split into sentences (English + Hindi danda), keeping decimals/abbreviations sane. */
export function splitSentences(text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const out = [];
  let rest = clean;
  const ABBR = /\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|approx|e\.g|i\.e|etc|No|Rs|U\.S|U\.K)$/i;
  while (rest.length) {
    const match = rest.match(/^[\s\S]{2,}?(?:[.!?।]+["'”’)]?(?=\s|$)|$)/);
    if (!match) { out.push(rest.trim()); break; }
    let sentence = match[0];
    // "Dr. Sharma …" — an abbreviation full-stop is not a sentence end.
    if (/\.\s*$/.test(sentence) && ABBR.test(sentence.trimEnd().slice(0, -1)) && rest.length > sentence.length) {
      const more = rest.slice(sentence.length).match(/^[\s\S]{1,}?(?:[.!?।]+["'”’)]?(?=\s|$)|$)/);
      if (more) sentence += more[0];
    }
    sentence = sentence.trim();
    if (sentence) out.push(sentence);
    rest = rest.slice(match[0].length + (sentence.length > match[0].trim().length ? sentence.length - match[0].trim().length : 0)).trimStart();
    if (rest === sentence) break; // safety against any infinite loop
  }
  return out.filter(Boolean);
}

/**
 * Turn any agent reply into something JARVIS would actually say.
 * Code blocks, tables and long lists collapse to one spoken headline; the
 * owner still has the full text in chat ("details have been sent in text").
 */
export function spokenSummary(reply, config = {}) {
  const maxChars = Math.max(80, Number(config.voiceMaxSpokenChars) || DEFAULT_MAX_SPOKEN_CHARS);
  let text = typeof reply === 'string' ? reply : (reply?.text ?? '');
  text = String(text ?? '');
  if (!text.trim()) {
    if (reply && typeof reply === 'object' && reply.image) return `Here is the image you requested, ${addressOf(config)}.`;
    if (reply && typeof reply === 'object' && reply.document) return `The file is ready, ${addressOf(config)}.`;
    return `Done, ${addressOf(config)}.`;
  }

  let hadCode = false;
  text = text.replace(/```[\s\S]*?```/g, () => { hadCode = true; return ' '; });
  // Tables (markdown pipes) are unreadable aloud — drop the rows entirely.
  const lines = text.split(/\r?\n/).filter((line) => !/^\s*\|/.test(line) && !/^\s*-{3,}\s*$/.test(line));

  // Bullet lists: speak at most the first three items, count the rest.
  const bullets = [];
  const prose = [];
  for (const line of lines) {
    const bullet = line.match(/^\s*(?:[•\-*]|\d+[.)])\s+(.*)$/);
    if (bullet) bullets.push(bullet[1].trim());
    else if (line.trim()) prose.push(line.trim());
  }
  if (bullets.length > 3) {
    prose.push(`The main points are: ${bullets.slice(0, 3).join('; ')}; and ${bullets.length - 3} more, which I have sent in text.`);
  } else if (bullets.length) {
    prose.push(bullets.join('. '));
  }
  if (hadCode) prose.push('The code itself has been sent in text.');

  let spoken = prose.join(' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/~([^~\n]+)~/g, '$1')
    .replace(/https?:\/\/\S+/g, 'the link')
    .replace(EMOJI, '')
    .replace(/(?:^|\s)#(\w+)/g, ' $1')
    .replace(/\s+/g, ' ')
    .trim();
  // English-only speech (default): never hand Devanagari to a British voice.
  if (config.jarvisEnglishOnly !== false) spoken = transliterateDevanagari(spoken).replace(/\s+/g, ' ').trim();
  if (!spoken) return `Done, ${addressOf(config)}.`;

  // Confirmation prompts must survive intact — the owner has to hear the question.
  const sentences = splitSentences(spoken);
  let out = '';
  for (const sentence of sentences) {
    if (out && out.length + sentence.length + 1 > maxChars) break;
    out = out ? `${out} ${sentence}` : sentence;
    if (out.length > maxChars * 0.75 && sentences.length > 2) break;
  }
  if (!out) out = spoken.slice(0, maxChars).trim();
  if (spoken.length > out.length + 20 && !/sent in text|bhej diya/i.test(out)) {
    out = `${out.replace(/[.\s]+$/, '')}. I have sent the remaining details in text.`;
  }
  return out.trim();
}

// ── speech-to-command normalisation ──────────────────────────────────────────

// Speech recognisers love returning Devanagari ("क्रोम खोलो") while every
// command layer below (nlp.js intents, slash commands) speaks Hinglish Roman.
// This word map transliterates the command vocabulary so Hindi speech executes
// *offline*, without waiting for an AI brain to translate it.
const DEVANAGARI_WORDS = {
  'जार्विस': 'jarvis', 'हेलो': 'hello', 'नमस्ते': 'namaste', 'प्लीज': 'please', 'भाई': 'bhai',
  'खोलो': 'kholo', 'खोल': 'khol', 'बंद': 'band', 'बन्द': 'band', 'करो': 'karo', 'कर': 'kar', 'दो': 'do',
  'चलाओ': 'chalao', 'चला': 'chala', 'चालू': 'chalu', 'रुको': 'ruko', 'रुक': 'ruk', 'स्टॉप': 'stop',
  'हाँ': 'haan', 'हां': 'haan', 'नहीं': 'nahi', 'मत': 'mat', 'ठीक': 'theek',
  'स्क्रीनशॉट': 'screenshot', 'स्क्रीन': 'screen', 'फोटो': 'photo', 'कैमरा': 'camera', 'वेबकैम': 'webcam',
  'भेजो': 'bhejo', 'भेज': 'bhej', 'बताओ': 'batao', 'दिखाओ': 'dikhao', 'पढ़ो': 'padho', 'लिखो': 'likho',
  'टाइप': 'type', 'ढूंढो': 'dhundo', 'ढूँढो': 'dhundo', 'खोजो': 'khojo', 'सर्च': 'search',
  'वाईफाई': 'wifi', 'वाई-फाई': 'wifi', 'ब्लूटूथ': 'bluetooth', 'आवाज़': 'awaaz', 'आवाज': 'awaaz',
  'वॉल्यूम': 'volume', 'कम': 'kam', 'बढ़ाओ': 'badhao', 'ज़्यादा': 'zyada', 'ज्यादा': 'zyada',
  'क्रोम': 'chrome', 'यूट्यूब': 'youtube', 'गूगल': 'google', 'गाना': 'gaana', 'गाने': 'gaane', 'म्यूजिक': 'music',
  'क्या': 'kya', 'है': 'hai', 'हैं': 'hain', 'मेरा': 'mera', 'मेरी': 'meri', 'मेरे': 'mere',
  'पीसी': 'pc', 'कंप्यूटर': 'computer', 'लैपटॉप': 'laptop', 'फाइल': 'file', 'फ़ाइल': 'file',
  'फोल्डर': 'folder', 'फ़ोल्डर': 'folder', 'डेस्कटॉप': 'desktop', 'डाउनलोड': 'download',
  'मौसम': 'mausam', 'याद': 'yaad', 'दिलाओ': 'dilao', 'मिनट': 'minute', 'सेकंड': 'second',
  'रिकॉर्ड': 'record', 'लॉक': 'lock', 'ऑन': 'on', 'ऑफ': 'off', 'ऑफ़': 'off',
  'बैटरी': 'battery', 'कितनी': 'kitni', 'कितना': 'kitna', 'समय': 'samay', 'टाइम': 'time',
  'आज': 'aaj', 'कल': 'kal', 'ऐप': 'app', 'ऐप्स': 'apps', 'विंडो': 'window',
  'पीडीएफ': 'pdf', 'धन्यवाद': 'dhanyavaad', 'शुक्रिया': 'shukriya', 'और': 'aur', 'फिर': 'phir',
  'पे': 'pe', 'पर': 'par', 'में': 'mein', 'का': 'ka', 'की': 'ki', 'के': 'ke', 'को': 'ko', 'से': 'se',
  'एक': 'ek', 'दस': 'das', 'बीस': 'bees', 'तीस': 'tees', 'चालीस': 'chalis', 'पचास': 'pachas',
  'साठ': 'saath', 'सत्तर': 'sattar', 'अस्सी': 'assi', 'नब्बे': 'nabbe', 'सौ': 'sau',
};
const DEVA_DIGITS = { '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9' };

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  ek: 1, do: 2, teen: 3, chaar: 4, char: 4, paanch: 5, panch: 5, chhah: 6, chhe: 6, saat: 7, sat: 7,
  aath: 8, nau: 9, das: 10, dus: 10, bees: 20, tees: 30, chalis: 40, pachas: 50, saath: 60,
  sattar: 70, assi: 80, nabbe: 90, sau: 100,
};
const NUMBER_WORD_RE = Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join('|');

/** "fifty five" → 55, "twenty" → 20. Returns null when it is not a number. */
function numberWordsToInt(phrase) {
  const words = String(phrase).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 2) return null;
  if (words.length === 1) return NUMBER_WORDS[words[0]] ?? null;
  const [tens, ones] = words;
  const t = NUMBER_WORDS[tens];
  const o = NUMBER_WORDS[ones];
  if (t != null && o != null && t >= 20 && t % 10 === 0 && o >= 1 && o <= 9) return t + o;
  return null;
}

/**
 * Convert number *words* to digits, but ONLY next to units/controls where a
 * number is unambiguous ("volume fifty", "das minute", "fifty percent").
 * A blanket conversion would turn "screenshot bhej do" (do = "give") into
 * "screenshot bhej 2", which is exactly the kind of bug that breaks trust.
 */
export function spokenNumbersToDigits(text) {
  let out = String(text ?? '');
  const num = `(${NUMBER_WORD_RE})(?:\\s+(${NUMBER_WORD_RE}))?`;
  // <num> percent/minute/second …
  out = out.replace(new RegExp(`\\b${num}\\s*(percent|parcent|pratishat|%|minutes?|min|seconds?|sec|ghante?|hours?)\\b`, 'gi'),
    (full, a, b, unit) => {
      const value = numberWordsToInt(b ? `${a} ${b}` : a) ?? numberWordsToInt(a);
      return value == null ? full : `${value} ${unit}`;
    });
  // volume/brightness <num> …
  out = out.replace(new RegExp(`\\b(volume|awaaz|brightness|roshni)\\s+${num}\\b`, 'gi'),
    (full, control, a, b) => {
      const value = numberWordsToInt(b ? `${a} ${b}` : a) ?? numberWordsToInt(a);
      return value == null ? full : `${control} ${value}`;
    });
  // "<num> baje" (o'clock) → "<num> baje" in digits, tools.parseWhen reads it.
  out = out.replace(new RegExp(`\\b${num}\\s+baje\\b`, 'gi'),
    (full, a, b) => {
      const value = numberWordsToInt(b ? `${a} ${b}` : a) ?? numberWordsToInt(a);
      return value == null ? full : `${value} baje`;
    });
  return out;
}

// Common STT mis-hearings of command words (English recogniser + Hinglish).
const MISHEARINGS = [
  [/\b(jarvis|javis|jervis|jarwis|jharvis|jarvish)\b/gi, 'jarvis'],
  [/\b(screen shot|screen short|iskreen ?shot)\b/gi, 'screenshot'],
  [/\b(wi ?fi|wife ?i|waifai)\b/gi, 'wifi'],
  [/\b(colou?r? ?chrome|groom|krome)\b/gi, 'chrome'],
  [/\b(volume|volium|walume)\b/gi, 'volume'],
  [/\b(bright ?ness|brightnes)\b/gi, 'brightness'],
];

/** Strip a leading/any wake word. Returns { text, hadWake }. */
export function stripWakeWord(text) {
  const original = String(text ?? '').trim();
  const stripped = original
    .replace(/^(?:hey|ok|okay|hello|hi)?[,\s]*jarvis[,\s]+/i, '')
    .replace(/\bjarvis\b[,\s]*/gi, '')
    .trim();
  return { text: stripped || original.replace(/\bjarvis\b/gi, '').trim(), hadWake: /\bjarvis\b/i.test(original) };
}

/**
 * Devanagari → Roman for the known command vocabulary (digits too). Used on
 * SPOKEN OUTPUT when JARVIS speaks English-only: an en_GB voice must never
 * be handed Devanagari script (it spells/mangles it). Unmapped words pass
 * through untouched.
 */
export function transliterateDevanagari(text) {
  let out = String(text ?? '');
  if (!/[ऀ-ॿ]/.test(out)) return out;
  out = out.replace(/[०-९]/g, (d) => DEVA_DIGITS[d] ?? d);
  return out.split(/(\s+)/).map((token) => {
    const trailing = token.match(/[।,!?;:]+$/u)?.[0] ?? '';
    const cleanToken = trailing ? token.slice(0, -trailing.length) : token;
    const mapped = DEVANAGARI_WORDS[token] ?? DEVANAGARI_WORDS[cleanToken];
    return mapped ? mapped + trailing.replace(/।/g, '.') : token.replace(/।/g, '.');
  }).join('');
}

/**
 * Full pipeline for one recognised utterance: wake word → Devanagari →
 * mis-hearings → digits → tidy spacing. The result is what every command
 * layer (intents, AI tool loop, DeepSeek Harness) receives.
 */
export function normalizeSpokenText(text) {
  let out = String(text ?? '').trim();
  if (!out) return '';
  out = out.replace(/[०-९]/g, (d) => DEVA_DIGITS[d] ?? d);
  if (/[ऀ-ॿ]/.test(out)) {
    out = out.split(/(\s+)/).map((token) => {
      const cleanToken = token.replace(/[।,!?;:]+$/u, '');
      const mapped = DEVANAGARI_WORDS[token] ?? DEVANAGARI_WORDS[cleanToken];
      return mapped ?? token;
    }).join('');
  }
  for (const [pattern, replacement] of MISHEARINGS) out = out.replace(pattern, replacement);
  out = stripWakeWord(out).text;
  out = spokenNumbersToDigits(out);
  return out.replace(/[।]+/g, '.').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();
}

// ── call-control phrases (handled locally, never sent to an AI) ──────────────

const cleanPhrase = (text) => String(text ?? '').toLowerCase().replace(/[.!?,।]+$/g, '').trim();

export function isEndCallPhrase(text) {
  return /^(?:end (?:the )?call|hang up|good ?bye|bye(?: bye)?|that'?s all|bas (?:karo|itna hi)|call (?:band|kaat|kato|end)(?: karo| do)?|band karo call|rakh (?:do|deta|deti) hu?n?|baad me baat karte hain|alvida)$/.test(cleanPhrase(text));
}

export function isStopPhrase(text) {
  return /^(?:stop|ruko|ruk jao|bas|chup|chup karo|band karo|rok do|stop (?:it|that|everything)|cancel (?:that|it|everything))$/.test(cleanPhrase(text))
    || /^jarvis stop$/.test(cleanPhrase(text));
}

export function isRepeatPhrase(text) {
  return /^(?:repeat(?: that)?|say (?:that|it) again|dobara bolo|phir se bolo|kya bola|samjha nahi|come again|pardon)$/.test(cleanPhrase(text));
}

export function isAffirmPhrase(text) {
  return /^(?:yes|yeah|yep|haan|han|ha|karo|kar do|kardo|confirm(?:ed)?|go ahead|proceed|theek hai|thik hai|bilkul|ok|okay|हाँ|हां|करो)$/.test(cleanPhrase(text));
}

export function isDenyPhrase(text) {
  return /^(?:no|nope|nahi|nahin|nah|mat karo|ruk jao|cancel|don'?t|do not|ना|नहीं|रद्द)$/.test(cleanPhrase(text));
}

/**
 * Casual conversation for live calls — greetings, thanks, "how are you".
 * Instant + offline (no brain needed), always answered in English with
 * butler polish. Returns null for everything else (real questions go to
 * the agent/AI as usual). Input should already be normalizeSpokenText-ed.
 */
export function smalltalkReply(text, config = {}, now = new Date()) {
  const clean = cleanPhrase(text);
  if (!clean) return null;
  const address = addressOf(config);
  if (/^(hello|hi+|hey|namaste|namaskar|good (?:morning|afternoon|evening|night)|namaskar jarvis|ram ram)$/.test(clean)) {
    return jarvisGreeting(config, now);
  }
  if (/^(how are you|how r u|kaise ho|kaisi ho|kaisa hai|how is it going|how'?s it going|what'?s up|aur batao|sab theek)$/.test(clean)) {
    return `All systems are running smoothly, ${address} — I am quite well, and entirely at your service. What would you like me to do?`;
  }
  if (/^(thank you|thanks|thank u|thanks a lot|shukriya|dhanyavaad|bahut shukriya|bahut dhanyavaad|great|nice|awesome|perfect|good job|well done|badia|badiya|shandaar)$/.test(clean)) {
    return `Always a pleasure, ${address}.`;
  }
  if (/^(who are you|your name|what is your name|tum kaun ho|tumhara naam kya hai|tera naam kya hai|aap kaun ho)$/.test(clean)) {
    return `I am JARVIS — your personal assistant, running right here on your own computer, ${address}. Commands, questions or conversation: simply ask.`;
  }
  if (/^(what can you do|what do you do|tum kya kar sakte ho|kya kya kar sakte ho|kaise kaam karte ho)$/.test(clean)) {
    return `Quite a lot, ${address}. I can open apps, take screenshots, find and send files, control volume, Wi-Fi and music, download links, answer questions — and even call you at a set time with updates. Just tell me what you need.`;
  }
  if (/^(you are (?:great|awesome|amazing|the best)|i love you|mast ho tum|tum bahut acche ho)$/.test(clean)) {
    return `You are most kind, ${address}. I shall endeavour to be worthy of it.`;
  }
  return null;
}

// ── the JARVIS audio sheen (ffmpeg) ──────────────────────────────────────────

/**
 * ffmpeg `-af` chain that turns a plain British TTS voice into JARVIS:
 * a touch of chest warmth, presence, broadcast compression, a *barely there*
 * 24 ms digital sheen (the "AI in the room" comb), loudness-normalised.
 * Timbre comes from the voice itself (Piper en_GB / Edge en-GB-Ryan); this is
 * the polish. Set TTS_FX=none to disable, TTS_PITCH (e.g. 0.94) deepens.
 */
export function jarvisFxFilter(config = {}) {
  const mode = String(config.ttsFx ?? 'jarvis').toLowerCase();
  if (mode === 'none' || mode === 'off' || mode === '') return '';
  const pitch = Number(config.jarvisPitch ?? config.ttsPitch ?? 0);
  const parts = [];
  if (pitch > 0.8 && pitch < 1.2 && pitch !== 1) {
    // Pitch-shift without tempo change: resample then tempo-correct back.
    parts.push(`asetrate=44100*${pitch.toFixed(3)}`, 'aresample=44100', `atempo=${(1 / pitch).toFixed(3)}`);
  }
  parts.push(
    'equalizer=f=110:t=h:w=90:g=2.5',       // warmth / chest
    'equalizer=f=3400:t=h:w=900:g=1.6',     // presence / articulation
    'highpass=f=65',                        // remove rumble
    'acompressor=threshold=-19dB:ratio=3:attack=6:release=140:makeup=4',
    'aecho=0.8:0.72:24:0.06',               // the JARVIS digital sheen (subtle!)
    'loudnorm=I=-16:TP=-1.5:LRA=11',
  );
  return parts.join(',');
}

/** Recommended free Piper voices, closest-first to Paul Bettany's JARVIS. */
export const RECOMMENDED_PIPER_VOICES = [
  {
    id: 'en_GB-alan-medium', label: 'British male (Alan) — the classic JARVIS clone pick',
    url: 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/alan/medium/en_GB-alan-medium.onnx',
  },
  {
    id: 'en_GB-ryan-high', label: 'British male (Ryan, high quality, deeper)',
    url: 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/ryan/high/en_GB-ryan-high.onnx',
  },
  {
    id: 'en_GB-northern_english_male-medium', label: 'Northern English male',
    url: 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx',
  },
];
