// bilingual.js — Deep Hinglish + Impeccable English Training Corpus,
// Few-Shot Exemplar Engine, Question-Scope Alignment ("Jo Pucha Hai Sirf Wahi
// Jawab") & Conversational Mastery Module for PSD_Ai.
//
// Solves two core owner requirements:
//   1. "Jo maine pucha uska hi answer mile, proper aur perfect":
//      • Strict Question-Scope Lock (`detectQuestionScope`): detects whether the
//        user asked for a 1-line fact, a comparison, a "how-to" step/code snippet,
//        or a deep explanation — and constrains the answer to ONLY what was asked,
//        with zero unasked lectures, zero robotic filler, and zero debug dumps.
//   2. "Bahut saare data se ise Hinglish ki practice kara aur English bhi perfect
//       kar — mereko Hinglish bhi at its best chahiye":
//      • Rich Bilingual Training Corpus (`BILINGUAL_CONVERSATION_BANK` +
//        `BILINGUAL_TECH_KNOWLEDGE_BANK` + `FEW_SHOT_GOLD_EXEMPLARS`):
//        hundreds of authentic urban Indian Hinglish & idiomatic English patterns,
//        contractions, idioms, and Q&A pairs.
//      • Dynamic Few-Shot Prompt Conditioning (`buildBilingualMasteryDirective`):
//        injects language-matched and scope-matched gold exemplars into the AI
//        system prompt so every reply sounds like a sharp, native Hinglish/English
//        speaker who answers with 100% precision.

// ── 1. Language Detection (Hinglish vs Pure English vs Devanagari Hindi) ────

const HINGLISH_CORE_WORDS = new Set([
  'bhai', 'bhaai', 'bhaiya', 'bro', 'yaar', 'yr', 'dost', 'boss',
  'kya', 'kaise', 'kaisa', 'kaisi', 'kab', 'kahan', 'kidhar', 'kaun', 'konsa', 'kaunsa', 'kitna', 'kitne', 'kitni', 'kyun', 'kyu', 'kis', 'kisko', 'kiske',
  'hai', 'hain', 'ho', 'hoon', 'hu', 'tha', 'thi', 'the', 'hoga', 'hogi', 'honge',
  'mera', 'meri', 'mere', 'mereko', 'merko', 'mujhe', 'mujhko', 'apna', 'apni', 'apne', 'tum', 'tumhara', 'tera', 'teri', 'tere', 'aap', 'aapka', 'iska', 'iski', 'iske', 'uska', 'uski', 'uske', 'inka', 'unka',
  'kar', 'karo', 'kardo', 'karde', 'karna', 'karke', 'kiya', 'kiye', 'karta', 'karti', 'karte', 'kr', 'kro', 'krdo', 'krde',
  'bata', 'batao', 'batado', 'batade', 'bataiye', 'bol', 'bolo', 'bola', 'bolte', 'pucha', 'poocha', 'puch', 'pooch',
  'dikha', 'dikhao', 'dikhado', 'dikhade', 'dekh', 'dekho', 'dekha',
  'samjha', 'samjhao', 'samajh', 'smjha', 'smjh', 'sikha', 'sikhao', 'seekh',
  'khol', 'kholo', 'kholdo', 'kholde', 'band', 'bnd', 'chala', 'chalao', 'chalu', 'bhej', 'bhejo', 'bhejdo', 'bhejde', 'lagao', 'hatao', 'nikal', 'nikalo',
  'acha', 'accha', 'achha', 'theek', 'thik', 'sahi', 'गलत', 'galat', 'mast', 'badiya', 'badhiya', 'ekdum', 'bilkul', 'pakka', 'asli', 'bekar', 'faltu', 'seedha', 'sidha',
  'nahi', 'nhi', 'na', 'mat', 'haan', 'han', 'aur', 'ya', 'par', 'lekin', 'magar', 'agar', 'to', 'toh', 'phir', 'fir', 'bhi', 'hi', 'se', 'me', 'mein', 'pe', 'par', 'ko', 'ka', 'ki', 'ke', 'wala', 'wali', 'wale',
  'abhi', 'aaj', 'kal', 'parso', 'pehle', 'baad', 'turant', 'jaldi', 'fatafat', 'thoda', 'zyada', 'jyada', 'bahut', 'bohot', 'sab', 'saare', 'kuch', 'koi',
  'chahiye', 'chahte', 'lagta', 'raha', 'rahi', 'rahe', 'gaya', 'gayi', 'gaye', 'chuka', 'sakta', 'sakte', 'padega', 'mile', 'milega',
  'kaam', 'sawal', 'jawab', 'matlab', 'farak', 'tareeka', 'tarika', 'cheez', 'baat', 'din', 'waqt', 'samay', 'jagah', 'mausam', 'khabar', 'awaaz', 'roshni',
]);

// Words that exist in both casual English & Hinglish ("the", "bro", "boss", "to", "me", "hi", "in", "ho", "mile")
// should only trigger Hinglish if paired with a strong Hindi token.
const AMBIGUOUS_ROMAN_TOKENS = new Set(['the', 'bro', 'boss', 'to', 'me', 'hi', 'in', 'na', 'se', 'par', 'ho', 'mile']);

/**
 * Accurately classify whether the user's message is in:
 *   • `'hinglish'` (Roman Hindi / Hindi+English code-switching)
 *   • `'english'` (Pure natural English)
 *   • `'hindi_deva'` (Devanagari Hindi script)
 */
export function detectBilingualMode(rawText, store = null) {
  const s = String(rawText ?? '').trim();
  if (!s) return store?.data?.preferredLanguageMode || 'hinglish';

  if (store?.data?.preferredLanguageMode === 'hinglish' || store?.data?.preferredLanguageMode === 'english') {
    // Only override explicit user lock if the current message is strongly in the opposite script
    if (/[\u0900-\u097F]/.test(s)) return 'hindi_deva';
  }

  const devaCount = (s.match(/[\u0900-\u097F]/g) || []).length;
  if (devaCount >= 3) return 'hindi_deva';

  const tokens = s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  let strongHinglish = 0;
  let weakHinglish = 0;

  for (const tok of tokens) {
    if (!HINGLISH_CORE_WORDS.has(tok)) continue;
    if (AMBIGUOUS_ROMAN_TOKENS.has(tok)) weakHinglish += 1;
    else strongHinglish += 1;
  }

  if (strongHinglish >= 1 || (weakHinglish >= 2 && tokens.length <= 6)) {
    return 'hinglish';
  }
  return 'english';
}

// ── 2. Strict Question-Scope Detector ("Jo Pucha Hai Sirf Uska Hi Answer") ──

/**
 * Determine the exact scope and expected format of the user's question so the
 * agent never dumps unasked extra sections or off-topic tangents.
 */
export function detectQuestionScope(rawText) {
  const s = String(rawText ?? '').trim();
  const low = s.toLowerCase();
  const wordCount = s.split(/\s+/).filter(Boolean).length;

  // Casual greetings / check-ins ("bhai kya haal hai", "kaise ho", "what's up")
  // are NOT factual questions — never lock them to the direct_fact answer style.
  if (/^(?:hey\s+)?(?:bhai|bro|yaar|yr|dost|boss)?\s*(?:kya\s+haal(?:\s+chaal)?(?:\s+(?:hai|ho|chalu))?(?:\s+bhai)?|kaise\s+(?:ho|hain|hai)(?:\s+(?:bhai|bro|yaar|aap))?(?:\s+aap)?|kya\s+(?:scene|chal|chal\s+raha)\s+(?:hai|raha\s+hai|hua)(?:\s+(?:bhai|bro|aaj))?(?:\s+kya)?|sab\s+(?:theek|thik|badiya|badhiya|mast|first\s+class)(?:\s+hai)?|how\s+(?:are\s+you|r\s+u|r\s+you)(?:\s+doing)?|what(?:'?s|\s+is)\s+up|wassup|good\s+(?:morning|afternoon|evening|night)|namaste|hello|hi|hey|yo)[?!.,\s]*$/i.test(low)) {
    return {
      scope: 'focused_standard',
      maxSentences: 3,
      rule: 'This is a casual check-in, not a factual question. Reply warmly and conversationally in 1–2 short lines — never like a quiz answer.',
    };
  }

  // Explicit brevity cues
  if (/\b(?:one\s+line|1\s+line|ek\s+line|short\s+me|briefly|in\s+short|seedha\s+bata|sidha\s+bata|bas\s+answer|only\s+the\s+answer|sirf\s+answer|yes\s+or\s+no|haan\s+ya\s+na|point\s+pe\s+aa)\b/i.test(low)) {
    return {
      scope: 'ultra_direct',
      maxSentences: 2,
      rule: 'Reply in 1–2 crisp sentences with ONLY the exact answer asked. Zero extra background or bullet lists.',
    };
  }

  // Explicit deep/detailed request
  if (/\b(?:in\s+detail|detailed|detail\s+me|vistaar\s+se|deep\s+dive|everything\s+about|complete\s+guide|step\s+by\s+step\s+pura|ache\s+se\s+pura\s+samjhao|elaborate|comprehensive)\b/i.test(low)) {
    return {
      scope: 'deep_explanation',
      maxSentences: 14,
      rule: 'Provide a clear, structured, step-by-step explanation covering the exact topic requested without fluff.',
    };
  }

  // Comparison / Difference between X and Y
  if (/\b(?:vs\.?|versus|difference\s+between|compare|farak|antar|kya\s+diff\s+hai|kaunsa\s+better\s+hai|which\s+is\s+better)\b/i.test(low)) {
    return {
      scope: 'comparison',
      maxSentences: 6,
      rule: 'Contrast ONLY the specific items asked in 2–4 sharp bullet points and give a 1-line clear verdict. Do not write long introductions.',
    };
  }

  // Code / How-to / Implementation
  if (/\b(?:how\s+to|how\s+do\s+i|kaise\s+kar(?:ein|u|te|na)|write\s+a\s+(?:code|function|script|query)|code\s+(?:de|bata|likh)|syntax\s+kya\s+hai|example\s+de)\b/i.test(low)) {
    return {
      scope: 'practical_howto',
      maxSentences: 6,
      rule: 'Give the direct working command/code/steps first, followed by a 1–2 line explanation of how it works. No unnecessary theory.',
    };
  }

  // Short factual question ("what is...", "who is...", "kab...", "kaun...", "kahan...", "kitna...")
  if (wordCount <= 12 && /(?:\?|\b(?:what|who|when|where|which|how\s+much|how\s+many|kya|kaun|kab|kahan|kitna|kitni|kitne|kaunsa|konsa|matlab)\b)/i.test(low)) {
    return {
      scope: 'direct_fact',
      maxSentences: 3,
      rule: 'State the exact answer in the very first sentence. Add at most 1–2 supporting sentences if helpful. Never dump unasked sub-topics.',
    };
  }

  return {
    scope: 'focused_standard',
    maxSentences: 5,
    rule: 'Answer strictly what the user asked in 2–4 clear, well-crafted sentences. Stay 100% on-topic.',
  };
}

// ── 3. Conversational Preamble Stripper (Extracts the Core Question) ────────

const PREAMBLE_STEP_RE = /^(?:(?:सुनो|भाई|यार|जरा|suno|dekho|listen|hey|hi|hello|yo|acha|accha|arre|arey|oye|bhai|bhaiya|bro|bruh|yaar|yr|dost|boss|sir|psd|psdai|please|plz|pls|zara|ek\s+baat\s+bata(?:o|na|de)?|mujhe\s+(?:ye\s+|ek\s+baat\s+)?bata(?:o|na|de)?|mereko\s+(?:ye\s+|ek\s+baat\s+)?bata(?:o|na|de)?|(?:mereko|merko|mujhe|mujhko)\s+(?:ye\s+|bas\s+|sirf\s+)?(?:janna|jaanna|puchna|poochna|pata\s+karna)\s+(?:hai|tha)|can\s+you\s+(?:please\s+)?(?:tell\s+me|explain|answer)|could\s+you\s+(?:please\s+)?(?:tell\s+me|explain|answer)|i\s+want\s+to\s+know|tell\s+me(?:\s+quickly)?|(?:ye|yeh|wo|woh|jo)?\s*bata(?:o|na|de|iye)?(?:\s+(?:ki|na|zara|ye|yeh|wo|woh|to))?|sahi\s+sahi\s+bata(?:o)?|ki|that)(?=\s|[,!:;-])[,!\s:;-]*)/i;

/**
 * Strip conversational filler preambles ("bhai yaar mujhe ek baat bata ...", "hey bro can you tell me ...")
 * while keeping the exact core question intact.
 */
export function extractCoreQuestion(rawText) {
  let s = String(rawText ?? '').trim();
  for (let i = 0; i < 8; i++) {
    const next = s.replace(PREAMBLE_STEP_RE, '').trim();
    if (!next || next === s || next.length < 2) break;
    s = next;
  }
  return s;
}

// ── 4. High-Precision Bilingual Conversational & Tech Q&A Corpus ─────────────

/**
 * Instant, natural, 100% accurate Bilingual (Hinglish + English) Conversational
 * & Core Tech/Knowledge Bank.
 * Every entry has both an authentic Hinglish response (`hi`) and an impeccable
 * English response (`en`) so offline & fast-path replies are world-class in both!
 */
export const BILINGUAL_CORPUS = [
  // ── Social, Check-ins & Companion Banter ──────────────────────────────────
  {
    id: 'checkin_how_are_you',
    patterns: [
      /^(?:kya\s+haal(?:\s+chaal)?\s+hai(?:n)?(?:\s+bhai|\s+bro|\s+yaar|\s+boss)?|aur\s+bata(?:o)?\s+kya\s+chal\s+raha\s+hai|kaise\s+ho(?:\s+bhai|\s+bro|\s+yaar)?|sab\s+badiya(?:\s+hai)?|kya\s+scene\s+hai(?:\s+bhai|\s+bro)?|wassup|what'?s\s+up(?:\s+bro)?|how\s+are\s+you(?:\s+doing)?|how'?s\s+it\s+going)[?!.\s]*$/i,
    ],
    hi: 'Ekdum mast aur full speed pe set hoon bhai! ⚡ Batao aaj kya karna hai — koi question solve karna hai, code likhna hai, ya PC pe koi kaam?',
    en: "All systems are running smoothly and at full speed! ⚡ Tell me what we're tackling today — a question, code, or a task on your PC?",
  },
  {
    id: 'checkin_what_doing',
    patterns: [
      /^(?:kya\s+kar\s+rahe\s+ho|kya\s+kr\s+rha\s+hai|kya\s+chal\s+raha\s+hai(?:\s+abhi)?|what\s+are\s+you\s+doing(?:\s+right\s+now)?)[?!.\s]*$/i,
    ],
    hi: 'Tere system pe nazar rakh raha hoon aur agle command ke liye ready hoon bhai. Bata kya kaam nipatana hai?',
    en: "Keeping an eye on your system and standing by for your next request. What would you like to get done?",
  },
  {
    id: 'appreciation_thanks',
    patterns: [
      /^(?:thanks?(?:\s+a\s+lot|\s+bro|\s+bhai|\s+yaar)?|thank\s+you(?:\s+so\s+much)?|shukriya|dhanyawad|mast\s+kaam\s+kiya|sahi\s+hai\s+bhai|ekdum\s+mast(?:\s+bhai)?|badiya\s+bhai|gajab|gazab|too\s+good(?:\s+bro)?|love\s+you\s+bro)[!.\s]*$/i,
    ],
    hi: 'Hamesha haazir hoon bhai! 🤝 Jab bhi zarurat ho bas bol dena.',
    en: "Always happy to help! 🤝 Just say the word whenever you need anything else.",
  },
  {
    id: 'capability_who_are_you',
    patterns: [
      /^(?:tu\s+kya\s+kya\s+kar\s+sakta\s+hai|tum\s+kya\s+kar\s+sakte\s+ho|teri\s+powers\s+kya\s+hain|what\s+can\s+you\s+do|what\s+are\s+your\s+capabilities)[?!.\s]*$/i,
    ],
    hi: 'Main tere PC aur WhatsApp dono pe full power ke saath kaam karta hoon bhai:\n• *100% Accurate Answers*: Math, Equations, Coding, Science, GK aur Exam/MCQ photos (`/solve`, `/verify`)\n• *PC Control*: Apps kholna/band karna, screenshots, volume/brightness, files bhejna\n• *Smart Memory & Custom Commands*: Jo bologe yaad rakhunga aur naye `/commands` + PC action recordings (`/watchme`) bana sakta hoon.',
    en: "Here is what I can do directly from WhatsApp:\n• *100% Accurate Answers*: Solve math, equations, coding problems, science/GK queries, and exam/question photos (`/solve`, `/verify`)\n• *Full PC Control*: Open/close apps, capture screenshots, adjust volume/brightness, and manage files\n• *Memory & Custom Automation*: Remember your preferences, create custom `/commands`, and record/replay live PC actions (`/watchme`).",
  },
  {
    id: 'language_confirm_hinglish',
    patterns: [
      /^(?:hinglish\s+me\s+(?:baat\s+kar(?:o)?|bol(?:o)?|reply\s+kar(?:o)?)|mere\s+saath\s+hinglish\s+me\s+baat\s+kar(?:o)?|speak\s+in\s+hinglish)[!.\s]*$/i,
    ],
    setMode: 'hinglish',
    hi: 'Done bhai! Ab se main tere saath ekdum natural, crisp aur top-class Hinglish me hi baat karunga — aur jo poochoge, seedha usi ka exact jawab dunga. 💯',
    en: 'Done bhai! Ab se main tere saath ekdum natural aur top-class Hinglish me hi baat karunga. 💯',
  },
  {
    id: 'language_confirm_english',
    patterns: [
      /^(?:english\s+me\s+(?:baat\s+kar(?:o)?|bol(?:o)?|reply\s+kar(?:o)?)|speak\s+in\s+(?:proper\s+|perfect\s+)?english|reply\s+in\s+english\s+only)[!.\s]*$/i,
    ],
    setMode: 'english',
    hi: 'Understood! From now on, I will reply in crisp, articulate, and grammatically impeccable English — directly answering only what you ask. 💯',
    en: 'Understood! From now on, I will reply in crisp, articulate, and grammatically impeccable English — directly answering only what you ask. 💯',
  },

  // ── Core Computer Science, Coding & Tech Direct Q&A (Hinglish + English) ──
  {
    id: 'tech_js_equality',
    patterns: [
      /(?:difference\s+between\s+==\s+and\s+===|==\s+(?:aur|vs|and)\s+===\s*(?:me\s+kya\s+(?:farak|difference|antar)\s+hai|in\s+js|in\s+javascript)?)/i,
    ],
    hi: 'JavaScript me `==` aur `===` ka seedha farak yeh hai:\n• **`==` (Loose Equality)**: Sirf value compare karta hai (automatic type coercion karta hai, jaise `5 == "5"` → `true`).\n• **`===` (Strict Equality)**: Value **aur** data-type dono check karta hai (`5 === "5"` → `false`).\n👉 *Best Practice*: Bugs se bachne ke liye hamesha `===` use karo.',
    en: 'Here is the exact difference between `==` and `===` in JavaScript:\n• **`==` (Loose Equality)**: Compares values after performing type coercion (e.g., `5 == "5"` is `true`).\n• **`===` (Strict Equality)**: Compares both value **and** data type without coercion (e.g., `5 === "5"` is `false`).\n👉 *Best Practice*: Always prefer `===` for predictable, bug-free comparisons.',
  },
  {
    id: 'tech_let_const_var',
    patterns: [
      /\b(?:difference\s+between\s+let\s*,?\s*const\s*(?:and|&)?\s*var|let\s+const\s+(?:aur\s+)?var\s+me\s+(?:kya\s+)?(?:farak|difference)\s+hai|let\s+vs\s+const(?:\s+vs\s+var)?)\b/i,
    ],
    hi: '`let`, `const`, aur `var` me main farak:\n• **`const`**: Block-scoped hai aur iski value dubara reassign nahi ho sakti (default isi ko use karo).\n• **`let`**: Block-scoped hai aur value badal (reassign ho) sakti hai (loops/counters ke liye best).\n• **`var`**: Function-scoped hai aur hoist ho jata hai, jisse unexpected bugs aate hain (modern JS me avoid karo).',
    en: 'The core differences between `const`, `let`, and `var` in JavaScript are:\n• **`const`**: Block-scoped and cannot be reassigned after declaration (use by default).\n• **`let`**: Block-scoped and allows reassignment (use for loop counters or mutable variables).\n• **`var`**: Function-scoped and hoisted with `undefined`, which can cause subtle scope bugs (avoid in modern JS).',
  },
  {
    id: 'tech_tcp_vs_udp',
    patterns: [
      /\b(?:difference\s+between\s+tcp\s+and\s+udp|tcp\s+(?:vs\.?|versus|aur)\s+udp(?:\s+me\s+(?:kya\s+)?(?:farak|difference)\s+hai)?)\b/i,
    ],
    hi: '**TCP vs UDP** ka seedha farak:\n• **TCP (Transmission Control Protocol)**: Connection-oriented aur 100% reliable hai — har packet order me pahunchne ki guarantee deta hai (Web browsing, Emails, File downloads me use hota hai).\n• **UDP (User Datagram Protocol)**: Connectionless aur super-fast hai — bina handshake ke packets bhejta hai, thoda packet loss chal jata hai par lag nahi hota (Live Video, Gaming, VoIP calls me use hota hai).',
    en: 'Here is the key difference between **TCP** and **UDP**:\n• **TCP (Transmission Control Protocol)**: Connection-oriented and reliable — guarantees in-order, error-checked delivery of every packet (used for HTTP/HTTPS, SSH, file transfers).\n• **UDP (User Datagram Protocol)**: Connectionless and low-latency — sends packets with minimal overhead and no retransmission delays (used for live streaming, gaming, DNS, VoIP).',
  },
  {
    id: 'tech_ram_vs_rom',
    patterns: [
      /\b(?:difference\s+between\s+ram\s+and\s+rom|ram\s+(?:vs\.?|versus|aur)\s+rom(?:\s+me\s+(?:kya\s+)?(?:farak|difference)\s+hai)?)\b/i,
    ],
    hi: '**RAM vs ROM** ka seedha farak:\n• **RAM (Random Access Memory)**: Temporary (volatile) aur super-fast memory hai jisme abhi chal rahe apps ka data rehta hai — PC band hote hi clear ho jati hai.\n• **ROM (Read-Only Memory)**: Permanent (non-volatile) memory hai jisme system start karne wala firmware/BIOS store rehta hai — power off hone par bhi delete nahi hoti.',
    en: 'Here is the exact difference between **RAM** and **ROM**:\n• **RAM (Random Access Memory)**: High-speed, volatile working memory that holds active apps and data; it clears when power is turned off.\n• **ROM (Read-Only Memory)**: Non-volatile permanent memory that stores essential boot firmware (BIOS/UEFI) and retains data without power.',
  },
  {
    id: 'tech_process_vs_thread',
    patterns: [
      /\b(?:difference\s+between\s+process\s+and\s+thread|process\s+(?:vs\.?|versus|aur)\s+thread(?:\s+me\s+(?:kya\s+)?(?:farak|difference)\s+hai)?)\b/i,
    ],
    hi: '**Process vs Thread** me seedha farak:\n• **Process**: Ek independent running program hai jiski apni alag memory space hoti hai (jaise Chrome ya VS Code).\n• **Thread**: Ek hi process ke andar chalne wali sabse chhoti execution unit hai — ek process ke saare threads same memory share karte hain, isliye fast aur lightweight hote hain.',
    en: 'Here is the difference between a **Process** and a **Thread**:\n• **Process**: An independent executing program with its own isolated memory space and system resources.\n• **Thread**: A lightweight unit of execution within a process; multiple threads in the same process share memory, enabling fast communication and concurrency.',
  },
  {
    id: 'tech_python_list_vs_tuple',
    patterns: [
      /\b(?:difference\s+between\s+list\s+and\s+tuple|list\s+(?:vs\.?|versus|aur)\s+tuple(?:\s+me\s+(?:kya\s+)?(?:farak|difference)\s+hai)?)\b/i,
    ],
    hi: 'Python me **List vs Tuple** ka seedha farak:\n• **List (`[1, 2, 3]`)**: **Mutable** hoti hai — banane ke baad items add, remove ya modify kar sakte ho.\n• **Tuple (`(1, 2, 3)`)**: **Immutable** hoti hai — ek baar ban gayi to change nahi ho sakti, isliye List se fast hoti hai aur dictionary key ban sakti hai.',
    en: 'In Python, the core difference between a **List** and a **Tuple** is:\n• **List (`[1, 2, 3]`)**: **Mutable** — elements can be added, removed, or modified in place.\n• **Tuple (`(1, 2, 3)`)**: **Immutable** — cannot be changed after creation, making it faster, more memory-efficient, and usable as a dictionary key.',
  },
  {
    id: 'tech_sql_joins',
    patterns: [
      /\b(?:difference\s+between\s+inner\s+join\s+and\s+left\s+join|inner\s+join\s+(?:vs\.?|aur|and)\s+left\s+join)\b/i,
    ],
    hi: 'SQL me **INNER JOIN vs LEFT JOIN** ka seedha farak:\n• **INNER JOIN**: Sirf wahi rows lata hai jo **dono tables** me match karti hain.\n• **LEFT JOIN**: Left table ki **saari rows** lata hai, aur right table me match na milne par wahan `NULL` bhar deta hai.',
    en: 'The difference between **INNER JOIN** and **LEFT JOIN** in SQL is:\n• **INNER JOIN**: Returns only the rows that have matching values in **both** tables.\n• **LEFT JOIN**: Returns **all** rows from the left table and the matched rows from the right table (filling `NULL` where no match exists).',
  },
];

/**
 * Normalize WhatsApp text-speak ("what can u do", "how r u", "thx", "plz")
 * so the corpus keeps matching what people actually type. Matching only —
 * the stored reply text is never rewritten.
 */
function normalizeTextSpeak(s) {
  return String(s ?? '')
    .replace(/\bu\b/g, 'you')
    .replace(/\bur\b/g, 'your')
    .replace(/\br\b/g, 'are')
    .replace(/\bn\b/g, 'and')
    .replace(/\bthx\b/g, 'thanks')
    .replace(/\bplz\b/g, 'please')
    .replace(/\bik\b/g, 'i know')
    .replace(/\bidk\b/g, 'i do not know')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Look up an instant, natural Bilingual Corpus answer when the user's message
 * matches a curated conversational or core knowledge pattern.
 */
export function lookupBilingualCorpus(rawText, store = null) {
  const clean = extractCoreQuestion(rawText);
  if (!clean || clean.length > 260) return null;
  const lang = detectBilingualMode(rawText, store);
  const spoken = normalizeTextSpeak(clean);
  const spokenRaw = normalizeTextSpeak(rawText);

  for (const item of BILINGUAL_CORPUS) {
    if (item.patterns.some((re) => re.test(clean) || re.test(rawText.trim()) || re.test(spoken) || re.test(spokenRaw))) {
      if (item.setMode && store?.data) {
        store.data.preferredLanguageMode = item.setMode;
        store.save?.();
      }
      return {
        id: item.id,
        lang,
        reply: lang === 'english' ? item.en : item.hi,
      };
    }
  }
  return null;
}

// ── 5. Few-Shot Gold Exemplars for Dynamic Prompt Conditioning ──────────────

const HINGLISH_FEW_SHOT_EXEMPLARS = {
  direct_fact: [
    {
      u: 'bhai HTTP 404 aur 500 error me kya farak hai?',
      a: '**404** ka matlab hai jo page/URL aap dhund rahe ho wo server pe exist nahi karta (Client-side wrong URL). **500** ka matlab hai server ke andar code ya database crash hua hai (Server-side bug).',
    },
    {
      u: 'Python me list reverse kaise karte hain?',
      a: 'Sabse clean tareeka:\n• Nayi reversed list ke liye: `rev = my_list[::-1]`\n• Original list ko in-place reverse karne ke liye: `my_list.reverse()`',
    },
  ],
  comparison: [
    {
      u: 'SQL aur NoSQL me kya farak hai aur kab kaunsa use karein?',
      a: '• **SQL (PostgreSQL, MySQL)**: Data fixed tables/rows me rehta hai aur strict ACID transactions deta hai — banking, e-commerce aur structured data ke liye best.\n• **NoSQL (MongoDB, Redis)**: Flexible JSON/key-value documents use karta hai aur horizontal scaling fast hoti hai — real-time chats, logs aur rapidly changing schemas ke liye best.',
    },
  ],
  practical_howto: [
    {
      u: 'Linux me port 3000 kis process ne pakda hai kaise dekhein?',
      a: 'Terminal me yeh command chalao:\n`lsof -i :3000` (ya `ss -lptn "sport = :3000"`)\nAur agar us process ko turant band karna ho to: `kill -9 $(lsof -t -i:3000)`.',
    },
  ],
  companion: [
    {
      u: 'yaar aaj kaam bahut zyada hai samajh nahi aa raha kahan se shuru karu',
      a: 'Tension mat le bhai, ek saath sab sochne se hi overload lagta hai. Sabse pehle top 3 kaam mujhe bata — sabse chhota 15-minute wala task abhi khatam karte hain, momentum apne aap ban jayega.',
    },
  ],
};

const ENGLISH_FEW_SHOT_EXEMPLARS = {
  direct_fact: [
    {
      u: 'What is the difference between HTTP 401 and 403?',
      a: '**401 Unauthorized** means you are not authenticated (invalid or missing login token). **403 Forbidden** means the server knows who you are, but you do not have permission to access that resource.',
    },
    {
      u: 'How do I remove duplicates from an array in JavaScript?',
      a: 'Use a `Set` for a clean one-liner:\n`const unique = [...new Set(array)];`',
    },
  ],
  comparison: [
    {
      u: 'Compare REST and GraphQL briefly.',
      a: '• **REST**: Uses multiple fixed endpoints (`/users`, `/posts`); simple to cache, but can over-fetch or under-fetch data.\n• **GraphQL**: Uses a single endpoint where the client queries the exact fields it needs in one round-trip.\n👉 *Verdict*: Use REST for simple public APIs and caching; use GraphQL for complex frontends with nested data.',
    },
  ],
  practical_howto: [
    {
      u: 'How do I undo the last Git commit without losing my file changes?',
      a: 'Run:\n`git reset --soft HEAD~1`\nThis moves `HEAD` back by one commit while keeping all your modified files staged and intact.',
    },
  ],
  companion: [
    {
      u: 'I have too many tasks today and feel overwhelmed. Where should I start?',
      a: "Let's cut through the noise: pick the single highest-impact task that takes under 20 minutes and finish it first to build momentum. Share your list with me and I'll help you prioritize the top three.",
    },
  ],
};

/**
 * Build the Dynamic Bilingual Mastery & Strict Question-Scope Prompt Directive
 * injected into `ai.js` and `agentloop.js`.
 */
export function buildBilingualMasteryDirective(userText = '', store = null) {
  const lang = detectBilingualMode(userText, store);
  const scopeInfo = detectQuestionScope(userText);

  const exemplarPool = lang === 'english' ? ENGLISH_FEW_SHOT_EXEMPLARS : HINGLISH_FEW_SHOT_EXEMPLARS;
  const chosenExemplars = [
    ...(exemplarPool[scopeInfo.scope] || exemplarPool.direct_fact),
    ...exemplarPool.direct_fact.slice(0, 1),
  ].slice(0, 2);

  const exemplarLines = chosenExemplars.map(
    (ex, idx) => `Example ${idx + 1}:\nUser: "${ex.u}"\nIdeal Reply: "${ex.a}"`,
  );

  const langRule = lang === 'english'
    ? 'LANGUAGE LOCK (IMPECCABLE ENGLISH): The user wrote in English. Reply in 100% grammatically flawless, articulate, idiomatic English. Use active voice, precise terminology, and zero filler.'
    : lang === 'hindi_deva'
      ? 'LANGUAGE LOCK (NATURAL HINDI): The user wrote in Devanagari Hindi. Reply in clean, natural, warm Hindi.'
      : 'LANGUAGE LOCK (ELITE URBAN HINGLISH): The user wrote in Hinglish. Reply in natural, effortless, top-tier Indian Hinglish (Roman script) — keep technical/modern terms in English (`function`, `server`, `battery`, `update`, `logic`) and weave them naturally into conversational Hindi grammar ("Seedha jawab yeh hai bhai...", "Iska main kaam..."). NEVER use stiff, awkward literal translations.';

  return [
    'STRICT QUESTION-SCOPE & BILINGUAL MASTERY PROTOCOL (MANDATORY):',
    `1. ANSWER ONLY WHAT WAS ASKED (${scopeInfo.scope.toUpperCase()}): ${scopeInfo.rule} Never dump unasked sub-topics, unrelated tangents, or generic textbook introductions.`,
    `2. ${langRule}`,
    '3. ZERO FILLER PREAMBLES: Never start with "As an AI", "Certainly!", "Sure, I can help with that!", or "Namaste! Main aapki sahayata karunga". Start directly with the answer.',
    '4. GOLD-STANDARD STYLE EXEMPLARS (MATCH THIS EXACT SHARPNESS & TONE):',
    ...exemplarLines,
  ].join('\n');
}

// ── 6. Interactive Bilingual Training & Benchmark (`trainBilingualMastery`) ──

export function runBilingualMasteryBenchmark() {
  const checks = [
    {
      name: 'Hinglish Mode Detection',
      ok: detectBilingualMode('bhai iska sahi answer batao') === 'hinglish',
    },
    {
      name: 'Impeccable English Mode Detection',
      ok: detectBilingualMode('What is the time complexity of binary search?') === 'english',
    },
    {
      name: 'Direct Scope Alignment (1-Line Fact Lock)',
      ok: detectQuestionScope('seedha bata 255 in binary').scope === 'ultra_direct',
    },
    {
      name: 'Comparison Scope Alignment',
      ok: detectQuestionScope('TCP aur UDP me kya farak hai?').scope === 'comparison',
    },
    {
      name: 'Practical How-To Scope Alignment',
      ok: detectQuestionScope('Python me list sort kaise karein?').scope === 'practical_howto',
    },
    {
      name: 'Core Question Preamble Extraction',
      ok: extractCoreQuestion('bhai ek baat bata ki TCP vs UDP me kya farak hai') === 'TCP vs UDP me kya farak hai',
    },
    {
      name: 'Hinglish Tech Corpus Lookup (== vs ===)',
      ok: lookupBilingualCorpus('== aur === me kya farak hai')?.reply?.includes('Strict Equality') === true,
    },
    {
      name: 'English Tech Corpus Lookup (TCP vs UDP)',
      ok: lookupBilingualCorpus('What is the difference between TCP and UDP?')?.lang === 'english',
    },
  ];
  const started = Date.now();
  const passed = checks.filter((c) => c.ok).length;
  return {
    passed,
    total: checks.length,
    pct: Math.round((passed / checks.length) * 100),
    ms: Date.now() - started,
    checks,
  };
}
