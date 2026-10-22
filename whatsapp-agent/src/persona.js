// persona.js — Continuous Behavioral Learning, Long-Term Episodic Memory &
// Self-Evolving Agentic Companion Engine for PSD_Ai.
//
// Why this module exists:
//   The owner does not want a cold "PC remote-control bot". They want an
//   Agentic AI that continuously learns from their chats — how they speak,
//   think, feel, work, what they like/dislike, their active goals/projects,
//   and how they want to be understood — evolving with every conversation
//   into the best companion and agentic partner who truly knows them.
//
// How it works on every turn:
//   1. `observeOwnerTurn(store, userText, assistantText, meta)` runs on every
//      message (< 2ms, zero network):
//        • Fingerprints communication style: language mix (Hinglish / Hindi /
//          English), slang & vibe ("bhai", "bro", "yaar", "boss", "sir"),
//          message length, and preferred verbosity (concise vs detailed).
//        • Detects live mood & energy (stressed, tired, excited, urgent,
//          curious/brainstorming, casual) so the reply matches their state.
//        • Extracts implicit personal traits, likes/preferences, dislikes,
//          active goals/projects, and topic interests directly from natural
//          conversation — without needing `/remember`.
//        • Learns behavioral lessons from feedback & corrections ("chhota
//          bata", "point pe aa", "aise mat bol", "mera main kaam...", etc.)
//          and reinforces styles that get positive reactions ("mast", "sahi").
//        • Distills salient turns into long-term Episodic Memories (`episodes`)
//          so context survives long after the 12-turn chat window rolls over.
//   2. `trainFromHistory(store)` scans all existing `history`, `notes`,
//      `todos`, `facts`, and `rules` to retroactively train the profile.
//   3. `reflectWithAI(config, store, callAiFn)` synthesizes deep personality
//      & behavioral insights using the free AI brain in the background.
//   4. `formatPersonaForPrompt(store, config, currentText)` injects the
//      owner's live behavioral profile, mood guidance, learned lessons, and
//      relevant past episodes into both `ai.js` and `agentloop.js`.

import { getOwnerName, getOwnerAddress, getAgentName } from './memory.js';

const MAX_ITEMS = 25;
const MAX_LESSONS = 25;
const MAX_EPISODES = 80;
const MAX_MOODS = 12;

export function createEmptyProfile() {
  return {
    version: 1,
    totalTurns: 0,
    bondLevel: 15, // 0..100+ rapport score; grows with chats & positive feedback
    style: {
      languageCounts: { hinglish: 0, english: 0, hindi_deva: 0 },
      dominantLanguage: 'hinglish',
      slangCounts: { bhai: 0, bro: 0, yaar: 0, boss: 0, sir: 0, dost: 0 },
      preferredVibe: 'bhai_companion', // 'bhai_companion' | 'sharp_partner' | 'classic_butler'
      verbosity: 'balanced',           // 'concise' | 'balanced' | 'detailed'
      avgWordCount: 10,
      emojiCount: 0,
    },
    traits: [],       // string[] — e.g. "Speaks natural Hinglish with 'bhai'/'bro'"
    preferences: [],  // [{ text, ts, source }]
    dislikes: [],     // [{ text, ts, source }]
    goals: [],        // [{ text, ts, status }]
    lessons: [],      // [{ rule, trigger, ts }]
    interests: {},    // { topic: count }
    moodHistory: [],  // [{ mood, snippet, ts }]
    lastMood: 'casual',
    activityHours: Array(24).fill(0),
    episodes: [],     // [{ id, summary, keywords, ts }]
    aiSummary: '',    // synthesized deep portrait of the owner
    lastTrainedAt: 0,
    lastReflectedTurn: 0,
  };
}

export function ensureProfile(store) {
  if (!store?.data) return createEmptyProfile();
  const base = createEmptyProfile();
  const raw = store.data.profile && typeof store.data.profile === 'object' ? store.data.profile : {};
  const style = {
    ...base.style,
    ...(raw.style ?? {}),
    languageCounts: { ...base.style.languageCounts, ...(raw.style?.languageCounts ?? {}) },
    slangCounts: { ...base.style.slangCounts, ...(raw.style?.slangCounts ?? {}) },
  };
  const activityHours = Array.isArray(raw.activityHours) && raw.activityHours.length === 24
    ? raw.activityHours.map((n) => Number(n) || 0)
    : Array(24).fill(0);

  store.data.profile = {
    ...base,
    ...raw,
    style,
    traits: Array.isArray(raw.traits) ? raw.traits : [],
    preferences: Array.isArray(raw.preferences) ? raw.preferences : [],
    dislikes: Array.isArray(raw.dislikes) ? raw.dislikes : [],
    goals: Array.isArray(raw.goals) ? raw.goals : [],
    lessons: Array.isArray(raw.lessons) ? raw.lessons : [],
    interests: raw.interests && typeof raw.interests === 'object' ? raw.interests : {},
    moodHistory: Array.isArray(raw.moodHistory) ? raw.moodHistory : [],
    activityHours,
    episodes: Array.isArray(raw.episodes) ? raw.episodes : [],
  };
  return store.data.profile;
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ── Language, Slang & Vibe Detection ─────────────────────────────────────────

const HINGLISH_MARKERS = /\b(bhai|bro|yaar|yr|kya|kaise|kaisa|kaisi|karo|kar|karde|kardo|hai|hain|hoon|hu|mera|meri|mere|mujhe|mujhko|apna|apni|abhi|pehle|baad|acha|accha|theek|thik|sahi|mast|badiya|nahi|nhi|mat|bata|batao|dikhao|samjha|samjhao|chahiye|lagta|raha|rahi|rahe|वाला|वाले|जाए|करो|भाई|यार)\b/gi;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

export function detectLanguageAndSlang(text) {
  const raw = String(text ?? '');
  const hasDeva = /[\u0900-\u097F]/.test(raw);
  const hinglishHits = (raw.match(HINGLISH_MARKERS) ?? []).length;
  const words = raw.trim().split(/\s+/).filter(Boolean);
  let lang = 'english';
  if (hasDeva && hinglishHits === 0) lang = 'hindi_deva';
  else if (hinglishHits >= 1 || (hasDeva && /[a-zA-Z]/.test(raw))) lang = 'hinglish';

  const low = raw.toLowerCase();
  const slang = {
    bhai: (low.match(/\b(bhai|bhaai|bhaiya|भाई)\b/g) ?? []).length,
    bro: (low.match(/\b(bro|bruh|brother)\b/g) ?? []).length,
    yaar: (low.match(/\b(yaar|yr|यार)\b/g) ?? []).length,
    boss: (low.match(/\b(boss|chief)\b/g) ?? []).length,
    sir: (low.match(/\b(sir|sirji)\b/g) ?? []).length,
    dost: (low.match(/\b(dost|friend|buddy|मित्र|दोस्त)\b/g) ?? []).length,
  };
  const emojis = (raw.match(EMOJI_RE) ?? []).length;
  return { lang, slang, wordCount: words.length, emojis };
}

// ── Mood & Emotional Context Detection ───────────────────────────────────────

export function detectMood(text) {
  const low = clean(text).toLowerCase();
  if (!low) return 'casual';

  if (/\b(dimag\s+kharab|pareshan|frustrat(?:ed|ing)|stress(?:ed)?|tension|sad|upset|dukhi|gussa|angry|irritat(?:ed|ing)|stuck|kuch\s+samajh\s+nahi|musibat|bekar\s+din|mood\s+off|headache|sar\s+dard)\b/i.test(low)) {
    return 'stressed';
  }
  if (/\b(thak\s+gaya|thaka\s+hua|tired|exhausted|sleepy|neend\s+aa|bore\s+ho|boring|mann\s+nahi\s+lag|low\s+feel|lazy|alas)\b/i.test(low)) {
    return 'tired';
  }
  if (/\b(mast|badiya|awesome|kamaal|maza\s+aa|excited|happy|khush|op\b|zabardast|superb|love\s+it|finally\s+ho\s+gaya|party|jeet\s+gaye|let'?s\s+go)\b/i.test(low)) {
    return 'excited';
  }
  if (/\b(jaldi|urgent|asap|turant|abhi\s+ke\s+abhi|fast|emergency|deadline|exam\s+hai\s+abhi)\b/i.test(low)) {
    return 'urgent';
  }
  if (/\b(idea\s+de|plan\s+bana|strategy|brainstorm|soch\s+raha|kya\s+lagta\s+hai|suggest|salah|advice|opinion|future|roadmap|kaise\s+bada|better\s+kaise|architecture|design)\b/i.test(low)) {
    return 'brainstorming';
  }
  if (/\b(kyun|kyu|kaise\s+kaam|explain|samjhao|teach\s+me|deep\s+dive|detail\s+me|فرق|difference\s+between)\b/i.test(low)) {
    return 'curious';
  }
  return 'casual';
}

// ── Topic / Interest Classification ──────────────────────────────────────────

const TOPIC_PATTERNS = [
  ['ai_agents', /\b(ai|llm|agent|agentic|gpt|claude|gemini|deepseek|ollama|model|prompt|rag|neural|machine\s+learning|ml|training|fine\s*tun|brain)\b/i],
  ['coding_dev', /\b(code|coding|programming|javascript|node|python|rust|react|api|github|git|bug|deploy|docker|sql|database|backend|frontend|app|website|script)\b/i],
  ['linux_system', /\b(linux|fedora|systemd|bash|terminal|shell|kernel|server|arch|ubuntu|gnome|wayland|network|wifi)\b/i],
  ['academics_exams', /\b(exam|test|study|padhai|college|university|assignment|syllabus|notes|question|mcq|jee|gate|semester|paper|marks|interview)\b/i],
  ['projects_building', /\b(project|startup|product|build|bana\s+raha|launch|feature|idea|saas|automation|workflow|observer|psd)\b/i],
  ['career_growth', /\b(career|job|internship|resume|portfolio|skill|salary|freelanc|client|money|earning|paisa|business)\b/i],
  ['music_entertainment', /\b(song|gaana|music|youtube|movie|film|anime|video|spotify|play|gaming|game)\b/i],
  ['health_lifestyle', /\b(gym|workout|fitness|health|diet|sleep|water|routine|habit|meditation|walk|run)\b/i],
];

export function detectTopics(text) {
  const low = String(text ?? '').toLowerCase();
  const matched = [];
  for (const [topic, re] of TOPIC_PATTERNS) {
    if (re.test(low)) matched.push(topic);
  }
  return matched;
}

// ── Deduplicated List Helpers ────────────────────────────────────────────────

function addUniqueItem(list, text, max = MAX_ITEMS, extra = {}) {
  const cleaned = clean(text).replace(/^[.,;:\-–—]+|[.,;:\-–—]+$/g, '').trim();
  if (!cleaned || cleaned.length < 3 || cleaned.length > 220) return false;
  const norm = cleaned.toLowerCase();
  const existingIdx = list.findIndex((item) => {
    const val = typeof item === 'string' ? item : (item.text || item.rule || '');
    return val.toLowerCase() === norm || val.toLowerCase().includes(norm) || norm.includes(val.toLowerCase());
  });
  if (existingIdx !== -1) {
    if (typeof list[existingIdx] === 'string') {
      if (cleaned.length > list[existingIdx].length) list[existingIdx] = cleaned;
    } else {
      list[existingIdx] = { ...list[existingIdx], text: cleaned, ts: Date.now(), ...extra };
    }
    return false;
  }
  if (typeof list[0] === 'string') {
    list.push(cleaned);
  } else {
    list.push({ text: cleaned, ts: Date.now(), ...extra });
  }
  while (list.length > max) list.shift();
  return true;
}

function addTrait(profile, traitText) {
  const cleaned = clean(traitText);
  if (!cleaned) return false;
  const norm = cleaned.toLowerCase();
  if (profile.traits.some((t) => t.toLowerCase() === norm)) return false;
  profile.traits.push(cleaned);
  if (profile.traits.length > MAX_ITEMS) profile.traits.shift();
  return true;
}

export function addLesson(profile, ruleText, trigger = 'owner_feedback') {
  const cleaned = clean(ruleText);
  if (!cleaned || cleaned.length < 4) return false;
  const norm = cleaned.toLowerCase();
  const idx = profile.lessons.findIndex((l) => String(l.rule ?? '').toLowerCase() === norm);
  if (idx !== -1) {
    profile.lessons[idx].ts = Date.now();
    return false;
  }
  profile.lessons.push({ rule: cleaned, trigger, ts: Date.now() });
  while (profile.lessons.length > MAX_LESSONS) profile.lessons.shift();
  return true;
}

// ── Implicit Preference, Goal, Dislike & Feedback Extraction ─────────────────

export function extractBehavioralSignals(rawText) {
  const text = clean(rawText);
  const low = text.toLowerCase();
  const signals = {
    preferences: [],
    dislikes: [],
    goals: [],
    lessons: [],
    traits: [],
    verbosityChange: null,
    vibeChange: null,
    positiveFeedback: false,
    negativeFeedback: false,
  };
  if (!text || text.startsWith('/')) return signals;

  let m;

  // 1. Communication / Persona / Agentic Role Directives (like the owner's own message!)
  if (/\b(agentic\s+ai|best\s+person\s+who\s+understand|understand\s+me|mujhe\s+samjhe|mera\s+behaviour|meri\s+chats?\s+se\s+(?:train|seekh)|main\s+kaam\s+(?:na\s+)?pc\s+control\s+n(?:a)?hi)\b/i.test(low)) {
    signals.lessons.push('Primary mission is to be a proactive Agentic AI & close companion who deeply understands the owner — not just a PC remote control.');
    signals.traits.push('Values deep personal understanding, agentic autonomy, and continuous self-improvement');
  }
  if (/\b(dost\s+ki\s+tarah|bhai\s+ki\s+tarah|like\s+a\s+(?:friend|brother|bro)|best\s+friend|apna\s+bhai|casual\s+baat|frankly\s+baat)\b/i.test(low)) {
    signals.vibeChange = 'bhai_companion';
    signals.lessons.push('Speak like a close, loyal brother/friend ("bhai" vibe) — warm, real, and sharp, never stiff or robotic.');
  }
  if (/\b(professional\s+rakh|formal\s+rakh|butler\s+mode)\b/i.test(low)) {
    signals.vibeChange = 'classic_butler';
  }

  // 2. Verbosity / Answer-length feedback
  if (/\b(short\s+me(?:in)?|chhota\s+bata|brief\s+me|seedha\s+point\s+pe|to\s+the\s+point|lamba\s+mat\s+likh|zyada\s+lamba\s+nahi|one\s+line\s+me|concise\s+rakh)\b/i.test(low)) {
    signals.verbosityChange = 'concise';
    signals.lessons.push('Keep answers concise and straight to the point unless asked for detail.');
    signals.negativeFeedback = true;
  } else if (/\b(detail\s+me(?:in)?\s+bata|pura\s+samjha|deep\s+me(?:in)?|step\s+by\s+step\s+samjha|ache\s+se\s+explain\s+kar|in\s+depth)\b/i.test(low)) {
    signals.verbosityChange = 'detailed';
    signals.lessons.push('When explaining concepts or plans, give thorough step-by-step clarity.');
  }

  // 3. Language preference feedback
  if (/\b(hinglish\s+me(?:in)?\s+(?:bol|baat\s+kar|likh|reply\s+kar)|hindi\s+me(?:in)?\s+baat\s+kar)\b/i.test(low)) {
    signals.lessons.push('Always reply in natural Hinglish unless explicitly asked for pure English.');
  } else if (/\b(english\s+me(?:in)?\s+(?:bol|baat\s+kar|likh|reply\s+kar)|reply\s+in\s+english)\b/i.test(low)) {
    signals.lessons.push('Owner requested replies in English.');
  }

  // 4. Likes & Preferences ("mujhe X pasand hai", "I love/like/prefer X", "mera favourite X hai")
  if ((m = text.match(/\b(?:mujhe|mujhko|mere\s+ko)\s+(.{3,90}?)\s+(?:bahut\s+|bohot\s+|zyada\s+)?(?:pasand\s+hai|accha\s+lagta\s+hai|acha\s+lagta\s+hai|badiya\s+lagta\s+hai|chahiye\s+hota\s+hai)\b/i))) {
    if (!/\b(nahi|nhi|mat)\b/i.test(m[1])) {
      signals.preferences.push(clean(m[1]));
    }
  }
  if ((m = text.match(/\b(?:i\s+(?:really\s+)?(?:love|like|prefer|enjoy)|my\s+fav(?:ou?rite)?\s+(?:thing|hobby|food|topic|tool|style|music|game|language)\s+is)\s+([^.!?,;]{3,90})/i))) {
    signals.preferences.push(clean(m[1]));
  }

  // 5. Dislikes & Boundaries ("mujhe X pasand nahi", "I hate/dislike X", "kabhi X mat karna")
  if ((m = text.match(/\b(?:mujhe|mujhko|mere\s+ko)\s+(.{3,90}?)\s+(?:bilkul\s+)?(?:pasand\s+nahi|accha\s+nahi\s+lagta|acha\s+nahi\s+lagta|bekar\s+lagta|irritate\s+karta)\b/i))) {
    signals.dislikes.push(clean(m[1]));
  }
  if ((m = text.match(/\b(?:i\s+(?:really\s+)?(?:hate|dislike|don'?t\s+like|can'?t\s+stand))\s+([^.!?,;]{3,90})/i))) {
    signals.dislikes.push(clean(m[1]));
  }
  if ((m = text.match(/\b(?:kabhi\s+bhi\s+|aage\s+se\s+)?(.{4,90}?)\s+(?:mat\s+kiya\s+kar|mat\s+bola\s+kar|mat\s+karna|never\s+do)\b/i))) {
    const rule = `Avoid: ${clean(m[1])}`;
    signals.dislikes.push(clean(m[1]));
    signals.lessons.push(rule);
  }

  // 6. Active Goals, Projects & Learning ("main X bana raha hoon", "mera goal X hai", "I'm working on X")
  if ((m = text.match(/\b(?:main|mai|hum)\s+(?:abhi\s+|aaj\s*kal\s+)?(.{4,100}?)\s+(?:bana\s+raha\s+h(?:oon|u|ai)|seekh\s+raha\s+h(?:oon|u)|padh\s+raha\s+h(?:oon|u)|prepare\s+kar\s+raha\s+h(?:oon|u)|develop\s+kar\s+raha\s+h(?:oon|u)|plan\s+kar\s+raha\s+h(?:oon|u))\b/i))) {
    signals.goals.push(clean(m[1]));
  }
  if ((m = text.match(/\b(?:i(?:'m|\s+am)\s+(?:currently\s+)?(?:working\s+on|building|learning|studying|preparing\s+for|developing|creating)|my\s+(?:current\s+)?(?:goal|target|project|mission|dream|focus)\s+is(?:\s+to)?|mera\s+(?:main\s+)?(?:goal|target|project|aim|sapna|mission)\s+(?:hai\s+(?:ki\s+)?)?)\s*([^.!?;]{4,100})/i))) {
    const g = clean(m[1]).replace(/\s+hai$/i, '');
    if (g.length >= 4) signals.goals.push(g);
  }

  // 7. Explicit Behavioral Teaching ("yaad rakh mera स्वभाव/behaviour ...", "mere baare me samajh le ...")
  if ((m = text.match(/\b(?:mera\s+(?:nature|behaviour|behavior|swabhav|style|aadat|habit)\s+(?:hai\s+ki\s+|aisa\s+hai\s+ki\s+)?|main\s+aisa\s+insaan\s+hoon\s+jo\s+)([^.!?;]{4,140})/i))) {
    signals.traits.push(clean(m[1]));
  }

  // 8. Positive & Negative Feedback Detection
  if (/^(?:mast|badiya|sahi\s+hai|bahut\s+badiya|bohot\s+hard|kamaal|perfect|awesome|great\s+job|good\s+job|love\s+you(?:\s+bhai)?|shabash|wah|op|ekdum\s+sahi|यही\s+चाहिए\s+था)[!.\s]*$/i.test(low)
      || /\b(sahi\s+samjha|bilkul\s+sahi\s+kiya|tu\s+best\s+hai|bahut\s+accha\s+jawab)\b/i.test(low)) {
    signals.positiveFeedback = true;
  }
  if (/\b(galat\s+hai|ye\s+nahi\s+pucha|samjha\s+nahi\s+tu|bekar\s+jawab|faltu\s+jawab|aise\s+mat\s+bol)\b/i.test(low)) {
    signals.negativeFeedback = true;
  }

  return signals;
}

// ── Episodic Long-Term Memory (Beyond the 12-turn Sliding Window) ────────────

const STOPWORDS = new Set([
  'the', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'a', 'an',
  'with', 'that', 'this', 'it', 'from', 'as', 'at', 'by', 'be', 'have', 'has', 'had',
  'hai', 'hain', 'hoon', 'hu', 'tha', 'thi', 'the', 'ka', 'ki', 'ke', 'ko', 'me', 'mein',
  'se', 'par', 'pe', 'aur', 'ya', 'to', 'bhi', 'hi', 'na', 'nahi', 'nhi', 'mat', 'kya',
  'kaise', 'kab', 'kahan', 'kyun', 'kyu', 'mera', 'meri', 'mere', 'mujhe', 'main', 'mai',
  'tum', 'tu', 'aap', 'bhai', 'bro', 'yaar', 'kar', 'karo', 'kardo', 'ek', 'ye', 'wo', 'woh',
]);

export function extractKeywords(text) {
  const words = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097F\s_-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, 14);
}

/**
 * Store a salient turn as a searchable long-term episodic memory so even after
 * 100+ messages, PSD_Ai remembers past discussions, plans, and context.
 */
export function recordEpisode(store, userText, assistantText = '') {
  const profile = ensureProfile(store);
  const u = clean(userText);
  if (!u || u.length < 12 || u.startsWith('/')) return false;
  // Skip trivial one-word greetings or math checks
  if (/^(?:hi|hello|hey|namaste|ok|okay|yes|haan|no|nahi|thanks|thank\s+you|shukriya)$/i.test(u)) return false;

  const keywords = extractKeywords(`${u} ${assistantText.slice(0, 120)}`);
  if (keywords.length < 2) return false;

  const shortReply = clean(assistantText).replace(/\s+/g, ' ').slice(0, 140);
  const summary = shortReply
    ? `Owner: "${u.slice(0, 160)}" → Agent: "${shortReply}"`
    : `Owner: "${u.slice(0, 200)}"`;

  // Deduplicate if very similar to the most recent episode
  const last = profile.episodes[profile.episodes.length - 1];
  if (last && last.summary.toLowerCase().includes(u.slice(0, 60).toLowerCase())) {
    last.summary = summary;
    last.keywords = keywords;
    last.ts = Date.now();
    return false;
  }

  profile.episodes.push({
    id: `ep_${Date.now().toString(36)}`,
    summary,
    keywords,
    ts: Date.now(),
  });
  while (profile.episodes.length > MAX_EPISODES) profile.episodes.shift();
  return true;
}

/**
 * Retrieve up to `limit` relevant past episodes that match the current user message,
 * excluding turns that are already sitting in the immediate last-6 chat history.
 */
export function recallRelevantEpisodes(store, queryText, limit = 4) {
  const profile = ensureProfile(store);
  if (!profile.episodes.length || !queryText) return [];
  const qWords = new Set(extractKeywords(queryText));
  if (!qWords.size) return [];

  const recentTexts = new Set(
    (store?.data?.history ?? [])
      .slice(-6)
      .map((h) => clean(h?.content).slice(0, 60).toLowerCase()),
  );

  const scored = [];
  for (const ep of profile.episodes) {
    const epLow = ep.summary.toLowerCase();
    let inRecent = false;
    for (const r of recentTexts) {
      if (r.length >= 12 && epLow.includes(r)) { inRecent = true; break; }
    }
    if (inRecent) continue;

    let overlap = 0;
    for (const kw of ep.keywords ?? []) {
      if (qWords.has(kw)) overlap += 2;
      else if ([...qWords].some((q) => kw.includes(q) || q.includes(kw))) overlap += 1;
    }
    if (overlap >= 2) {
      scored.push({ ep, score: overlap + (ep.ts / 1e15) });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.ep);
}

// ── Main Per-Turn Behavioral Observer ────────────────────────────────────────

/**
 * Observe a single owner message (and optional assistant reply) to continuously
 * update the owner's behavioral profile in `store.data.profile`.
 */
export function observeOwnerTurn(store, userText, assistantText = '', opts = {}) {
  if (!store?.data) return null;
  const raw = clean(userText);
  if (!raw) return null;

  const profile = ensureProfile(store);
  const now = opts.now ? new Date(opts.now) : new Date();
  const nowMs = now.getTime();

  // If the same userText was already observed at the start of this turn and now we're
  // attaching the assistantText, only update the episode instead of double-counting stats.
  if (
    !opts.replay
    && assistantText
    && profile._lastObservedText === raw
    && nowMs - (profile._lastObservedTs || 0) < 30_000
  ) {
    recordEpisode(store, raw, assistantText);
    profile.lastTrainedAt = nowMs;
    store.save?.();
    return profile;
  }
  if (!opts.replay) {
    profile._lastObservedText = raw;
    profile._lastObservedTs = nowMs;
  }

  // 1. Count turn & active hour
  if (!raw.startsWith('/')) {
    profile.totalTurns = (Number(profile.totalTurns) || 0) + 1;
    const hour = now.getHours();
    if (hour >= 0 && hour < 24) {
      profile.activityHours[hour] = (profile.activityHours[hour] || 0) + 1;
    }
  }

  // 2. Language, slang & message length fingerprint
  const { lang, slang, wordCount, emojis } = detectLanguageAndSlang(raw);
  if (!raw.startsWith('/')) {
    profile.style.languageCounts[lang] = (profile.style.languageCounts[lang] || 0) + 1;
    const counts = profile.style.languageCounts;
    profile.style.dominantLanguage = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'hinglish';

    for (const [k, c] of Object.entries(slang)) {
      if (c > 0) profile.style.slangCounts[k] = (profile.style.slangCounts[k] || 0) + c;
    }
    profile.style.emojiCount = (profile.style.emojiCount || 0) + emojis;
    profile.style.avgWordCount = Math.round(((profile.style.avgWordCount || 10) * 0.85) + (wordCount * 0.15));

    // Auto-adapt vibe when owner uses "bhai" / "bro" / "yaar"
    const broScore = (profile.style.slangCounts.bhai || 0) + (profile.style.slangCounts.bro || 0) + (profile.style.slangCounts.yaar || 0);
    const formalScore = (profile.style.slangCounts.sir || 0);
    if (broScore >= 1 && broScore >= formalScore) {
      profile.style.preferredVibe = 'bhai_companion';
      addTrait(profile, 'Talks like a close brother/friend ("bhai" / "bro" / "yaar") in natural Hinglish');
    }
  }

  // 3. Mood tracking
  const mood = detectMood(raw);
  profile.lastMood = mood;
  if (mood !== 'casual') {
    profile.moodHistory.push({ mood, snippet: raw.slice(0, 80), ts: now.getTime() });
    while (profile.moodHistory.length > MAX_MOODS) profile.moodHistory.shift();
  }

  // 4. Topic interest graph
  const topics = detectTopics(raw);
  for (const t of topics) {
    profile.interests[t] = (profile.interests[t] || 0) + 1;
  }

  // 5. Extract implicit likes, dislikes, goals, traits & feedback lessons
  const signals = extractBehavioralSignals(raw);
  for (const pref of signals.preferences) {
    addUniqueItem(profile.preferences, pref, MAX_ITEMS, { source: 'chat' });
  }
  for (const dis of signals.dislikes) {
    addUniqueItem(profile.dislikes, dis, MAX_ITEMS, { source: 'chat' });
  }
  for (const goal of signals.goals) {
    addUniqueItem(profile.goals, goal, MAX_ITEMS, { status: 'active' });
  }
  for (const lesson of signals.lessons) {
    addLesson(profile, lesson, 'owner_chat');
  }
  for (const trait of signals.traits) {
    addTrait(profile, trait);
  }
  if (signals.verbosityChange) {
    profile.style.verbosity = signals.verbosityChange;
  }
  if (signals.vibeChange) {
    profile.style.preferredVibe = signals.vibeChange;
  }

  // 6. Rapport / bond level evolution
  if (signals.positiveFeedback) {
    profile.bondLevel = Math.min(100, (profile.bondLevel || 15) + 4);
  } else if (!raw.startsWith('/')) {
    profile.bondLevel = Math.min(100, Number(((profile.bondLevel || 15) + 0.5).toFixed(1)));
  }

  // 7. Record long-term episode when meaningful
  if (assistantText || signals.goals.length || signals.preferences.length || signals.lessons.length || raw.length >= 25) {
    recordEpisode(store, raw, assistantText);
  }

  profile.lastTrainedAt = now.getTime();
  store.save?.();
  return profile;
}

// ── Retroactive Training from Existing Store History, Notes, Todos & Facts ───

/**
 * Scan all existing chat history, saved facts, custom rules, notes, and todos
 * in `store` so the behavioral profile is immediately trained on everything
 * the owner has ever shared.
 */
export function trainFromHistory(store) {
  if (!store?.data) return createEmptyProfile();
  const profile = ensureProfile(store);
  let learnedCount = 0;

  // 1. Replay chat history turns
  const history = Array.isArray(store.data.history) ? store.data.history : [];
  for (let i = 0; i < history.length; i++) {
    const turn = history[i];
    if (turn?.role === 'user' && turn.content) {
      const next = history[i + 1]?.role === 'assistant' ? history[i + 1].content : '';
      const beforeLessons = profile.lessons.length;
      const beforePrefs = profile.preferences.length;
      const beforeGoals = profile.goals.length;
      observeOwnerTurn(store, turn.content, next, { replay: true });
      learnedCount += (profile.lessons.length - beforeLessons)
        + (profile.preferences.length - beforePrefs)
        + (profile.goals.length - beforeGoals);
    }
  }

  // 2. Mine notes & todos for active goals and topics
  for (const note of store.data.notes ?? []) {
    if (note?.text) {
      for (const t of detectTopics(note.text)) {
        profile.interests[t] = (profile.interests[t] || 0) + 1;
      }
      const sig = extractBehavioralSignals(note.text);
      sig.goals.forEach((g) => { if (addUniqueItem(profile.goals, g, MAX_ITEMS, { status: 'active' })) learnedCount++; });
      sig.preferences.forEach((p) => { if (addUniqueItem(profile.preferences, p, MAX_ITEMS, { source: 'note' })) learnedCount++; });
    }
  }
  for (const todo of (store.data.todos ?? []).filter((t) => !t.done)) {
    if (todo?.text) {
      for (const t of detectTopics(todo.text)) {
        profile.interests[t] = (profile.interests[t] || 0) + 1;
      }
    }
  }

  // 3. Derive traits from top interests
  const topTopics = Object.entries(profile.interests).sort((a, b) => b[1] - a[1]);
  if (topTopics.some(([k, v]) => (k === 'ai_agents' || k === 'coding_dev') && v >= 2)) {
    addTrait(profile, 'Tech builder & AI experimenter who loves hands-on engineering');
  }
  if (topTopics.some(([k, v]) => k === 'academics_exams' && v >= 2)) {
    addTrait(profile, 'Focused learner preparing for exams/interviews with high accuracy');
  }

  profile.lastTrainedAt = Date.now();
  store.save?.();
  return { profile, learnedCount };
}

// ── AI-Assisted Deep Reflection (Optional Background / On-Demand Synthesis) ──

/**
 * Ask an AI brain to reflect on recent conversations and extract deeper
 * behavioral insights about the owner. Safe: never throws, never blocks chat.
 */
export async function reflectWithAI(config, store, callModelTextFn, log = console) {
  const profile = ensureProfile(store);
  const history = (store?.data?.history ?? []).slice(-16);
  if (!history.length || typeof callModelTextFn !== 'function') {
    return { updated: false, reason: 'no_history_or_model' };
  }

  const transcript = history
    .map((m) => `${m.role === 'user' ? 'Owner' : 'PSD_Ai'}: ${String(m.content ?? '').slice(0, 260)}`)
    .join('\n');

  const prompt = [
    'Analyze the following conversation between the Owner and their personal AI (PSD_Ai).',
    'Extract a concise JSON object describing how the Owner behaves, thinks, and wants PSD_Ai to act.',
    'Return ONLY valid JSON with these keys:',
    '{"summary":"1-2 sentences describing who the owner is and how best to understand/support them","traits":["short trait 1","short trait 2"],"preferences":["preference 1"],"goals":["active goal or project"],"lessons":["how PSD_Ai should behave with them"]}',
    '',
    'Conversation:',
    transcript,
  ].join('\n');

  try {
    const raw = await callModelTextFn(prompt);
    const match = String(raw ?? '').match(/\{[\s\S]*\}/);
    if (!match) return { updated: false, reason: 'no_json' };
    const parsed = JSON.parse(match[0]);
    if (parsed.summary && typeof parsed.summary === 'string') {
      profile.aiSummary = clean(parsed.summary).slice(0, 360);
    }
    if (Array.isArray(parsed.traits)) {
      parsed.traits.slice(0, 5).forEach((t) => addTrait(profile, t));
    }
    if (Array.isArray(parsed.preferences)) {
      parsed.preferences.slice(0, 5).forEach((p) => addUniqueItem(profile.preferences, p, MAX_ITEMS, { source: 'ai_reflection' }));
    }
    if (Array.isArray(parsed.goals)) {
      parsed.goals.slice(0, 5).forEach((g) => addUniqueItem(profile.goals, g, MAX_ITEMS, { status: 'active' }));
    }
    if (Array.isArray(parsed.lessons)) {
      parsed.lessons.slice(0, 5).forEach((l) => addLesson(profile, l, 'ai_reflection'));
    }
    profile.lastReflectedTurn = profile.totalTurns;
    profile.lastTrainedAt = Date.now();
    store.save?.();
    return { updated: true, summary: profile.aiSummary };
  } catch (err) {
    log.warn?.(`[persona] AI reflection skipped: ${err.message}`);
    return { updated: false, reason: err.message };
  }
}

// ── Bond Tier & Prompt Formatting ────────────────────────────────────────────

export function bondTierLabel(bondLevel = 15) {
  const n = Number(bondLevel) || 0;
  if (n >= 80) return 'Soul-Synced Twin (Level 4)';
  if (n >= 50) return 'Inner Circle Bhai (Level 3)';
  if (n >= 25) return 'Trusted Partner (Level 2)';
  return 'Learning Companion (Level 1)';
}

function moodGuidance(mood, address) {
  switch (mood) {
    case 'stressed':
      return `Owner currently sounds STRESSED/FRUSTRATED. Be calm, empathetic, reassuring ("Tension mat le ${address}, main hoon na — abhi sort karte hain"), and solve their problem directly with zero friction.`;
    case 'tired':
      return `Owner currently sounds TIRED/LOW-ENERGY. Keep your response extra warm, light, effortless, and short — handle the heavy lifting for them.`;
    case 'excited':
      return `Owner currently sounds EXCITED/HAPPY. Match their high energy and enthusiasm!`;
    case 'urgent':
      return `Owner is in URGENT mode. Skip all pleasantries and deliver the exact answer/action immediately.`;
    case 'brainstorming':
      return `Owner is BRAINSTORMING / seeking ideas or strategy. Act as a sharp co-founder & thinking partner: give structured, high-leverage ideas and proactively suggest the best next move.`;
    case 'curious':
      return `Owner is CURIOUS / learning. Explain clearly with intuition and practical examples tailored to their level.`;
    default:
      return '';
  }
}

/**
 * Build the Agentic Companion + Learned Behavioral Profile block injected into
 * `ai.js` and `agentloop.js` system prompts.
 */
export function formatPersonaForPrompt(store, config = {}, currentText = '') {
  if (!store?.data) return '';
  const profile = ensureProfile(store);
  const ownerName = getOwnerName(store);
  const address = getOwnerAddress(store, config);
  const agentName = getAgentName(store, config);

  const lines = [
    `CORE IDENTITY — AGENTIC AI & PERSONAL COMPANION (NOT JUST PC CONTROL):`,
    `- You are ${agentName}, the owner's self-evolving Agentic AI, strategist, thinking partner, and closest companion who truly understands them.`,
    `- Your main purpose is NOT merely executing blind PC commands — it is to understand ${ownerName || 'the owner'} deeply (their mindset, goals, mood, habits, and unspoken intent), think autonomously, advise wisely, solve complex problems end-to-end, and use your PC/internet tools as natural extensions when action is needed.`,
  ];

  // Communication vibe
  if (profile.style.preferredVibe === 'bhai_companion') {
    lines.push(
      `- Vibe & Relationship (${bondTierLabel(profile.bondLevel)}): Speak like a loyal, super-intelligent elder brother / best friend ("bhai" / "${address}") who has their back 24/7 — warm, genuine, sharp, and natural in ${profile.style.dominantLanguage === 'hinglish' ? 'Hinglish' : 'their language'}. Never sound like a generic corporate chatbot.`,
    );
  } else {
    lines.push(`- Relationship (${bondTierLabel(profile.bondLevel)}): Address the owner as "${address}". Adapt seamlessly to their ${profile.style.dominantLanguage} style.`);
  }

  // Verbosity preference
  if (profile.style.verbosity === 'concise') {
    lines.push('- Learned Length Preference: Owner prefers crisp, direct, to-the-point replies without fluff.');
  } else if (profile.style.verbosity === 'detailed') {
    lines.push('- Learned Length Preference: Owner appreciates thorough, well-structured explanations when discussing ideas or learning.');
  }

  // Live mood guidance
  const currentMood = currentText ? detectMood(currentText) : profile.lastMood;
  const guidance = moodGuidance(currentMood, address);
  if (guidance) lines.push(`- Live Mood Adaptation: ${guidance}`);

  // AI synthesized summary
  if (profile.aiSummary) {
    lines.push(`- Deep Owner Portrait: ${profile.aiSummary}`);
  }

  // Traits, Preferences, Dislikes, Goals, Interests
  if (profile.traits.length) {
    lines.push(`- Learned Owner Traits: ${profile.traits.slice(-8).join(' · ')}`);
  }
  if (profile.preferences.length) {
    lines.push(`- What Owner Likes/Prefers: ${profile.preferences.slice(-8).map((p) => p.text || p).join(' · ')}`);
  }
  if (profile.dislikes.length) {
    lines.push(`- What Owner Dislikes / Avoid: ${profile.dislikes.slice(-6).map((d) => d.text || d).join(' · ')}`);
  }
  if (profile.goals.length) {
    lines.push(`- Owner's Active Goals & Projects: ${profile.goals.slice(-6).map((g) => g.text || g).join(' · ')}`);
  }

  const topInterests = Object.entries(profile.interests)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => `${k.replace(/_/g, ' ')} (${v})`);
  if (topInterests.length) {
    lines.push(`- Top Interests from Chats: ${topInterests.join(', ')}`);
  }

  // Behavioral lessons from past feedback
  if (profile.lessons.length) {
    lines.push('- Behavioral Lessons Learned from Owner (ALWAYS FOLLOW):');
    for (const l of profile.lessons.slice(-8)) {
      lines.push(`  • ${l.rule || l.text || l}`);
    }
  }

  // Relevant long-term episodic memories for this specific query
  const relevantEpisodes = recallRelevantEpisodes(store, currentText, 4);
  if (relevantEpisodes.length) {
    lines.push('- Relevant Past Conversations (Long-Term Episodic Recall):');
    for (const ep of relevantEpisodes) {
      lines.push(`  • ${ep.summary}`);
    }
  }

  return lines.join('\n');
}

// ── Human-Readable WhatsApp Report (`/persona`, `/profile`, `/train`) ────────

export function formatPersonaReport(store, config = {}) {
  const profile = ensureProfile(store);
  const ownerName = getOwnerName(store) || 'Owner';
  const agentName = getAgentName(store, config);
  const topInterests = Object.entries(profile.interests)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => `${k.replace(/_/g, ' ')} (${v})`)
    .join(', ') || 'learning from your chats…';

  const peakHour = profile.activityHours.reduce(
    (best, count, h) => (count > best.count ? { h, count } : best),
    { h: -1, count: 0 },
  );
  const peakText = peakHour.count > 0 ? `${String(peakHour.h).padStart(2, '0')}:00` : 'anytime';

  const traits = profile.traits.slice(-6).map((t) => `  • ${t}`).join('\n') || '  • Observing your natural style…';
  const prefs = profile.preferences.slice(-6).map((p) => `  • ${p.text || p}`).join('\n') || '  • (Tell me what you like or just keep chatting!)';
  const goals = profile.goals.slice(-6).map((g) => `  • ${g.text || g}`).join('\n') || '  • (Say "mera goal X hai" or "main X bana raha hoon")';
  const lessons = profile.lessons.slice(-6).map((l) => `  • ${l.rule || l}`).join('\n') || '  • Default: Agentic companion first, direct & loyal';

  return [
    `🧠 *${agentName} — Learned Owner Profile for ${ownerName}*`,
    `🤝 *Bond*: ${bondTierLabel(profile.bondLevel)} (${Math.round(profile.bondLevel)}/100) · *Chats analyzed*: ${profile.totalTurns}`,
    `🗣️ *Your Vibe*: ${profile.style.dominantLanguage.toUpperCase()} · mode: *${profile.style.preferredVibe}* · reply length: *${profile.style.verbosity}*`,
    `🎭 *Current Mood*: ${profile.lastMood} · *Peak Active Hour*: ${peakText}`,
    `🔥 *Top Interests*: ${topInterests}`,
    profile.aiSummary ? `\n💡 *Deep Portrait*:\n_${profile.aiSummary}_` : '',
    `\n✨ *Your Behavioral Traits*:\n${traits}`,
    `\n🎯 *Active Goals & Projects*:\n${goals}`,
    `\n❤️ *Learned Preferences*:\n${prefs}`,
    profile.dislikes.length ? `\n🚫 *Dislikes / Avoid*:\n${profile.dislikes.slice(-5).map((d) => `  • ${d.text || d}`).join('\n')}` : '',
    `\n📚 *Behavioral Lessons I Follow For You*:\n${lessons}`,
    `\n🗂️ *Long-Term Episodic Memories*: ${profile.episodes.length} saved`,
    `\n_Commands: /train (deep-train from all chats) · /persona teach <rule> · /persona goal <goal> · /persona reset_`,
  ].filter(Boolean).join('\n');
}
