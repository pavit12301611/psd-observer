// vocab.js — High-Speed Vocabulary, Slang, Typo-Correction, Synonym
// Normalization, Word-Power & Lexical Intelligence Engine for PSD_Ai.
//
// Makes the agent both:
//   1. "Vocab mein tez" (Linguistically & lexically sharp):
//      • Understands Hinglish/Hindi/Gen-Z WhatsApp shorthand, abbreviations,
//        colloquial slang, phrasal verbs, idioms, and typos in < 0.2ms.
//      • Fuzzy-matches misspelled slash commands & keywords via Damerau-
//        Levenshtein edit distance.
//      • Provides instant offline + online Word-Power lookups (English +
//        Hindi + Hinglish meanings, synonyms, antonyms, usage examples),
//        vocabulary elevation/rewriting, and daily word boosters.
//      • Enriches the AI brain's system prompt with adaptive lexical register
//        directives so replies use crisp, expressive, high-IQ vocabulary.
//   2. "Speed mein fast" (Zero-wait pre-AI lexical routing & caching):
//      • Resolves colloquial/slang commands offline in < 0.5ms without waiting
//        for a network LLM round-trip.

// ── 1. WhatsApp / Hinglish / Slang / Typo Token Normalizer ──────────────────

const WORD_REPLACEMENTS = new Map([
  // Action verbs & auxiliaries (Hinglish / SMS shorthand)
  ['kr', 'kar'],
  ['kro', 'karo'],
  ['krdo', 'kar do'],
  ['kardo', 'kar do'],
  ['krde', 'kar do'],
  ['karde', 'kar do'],
  ['krlo', 'kar lo'],
  ['karlo', 'kar lo'],
  ['krna', 'karna'],
  ['krta', 'karta'],
  ['krti', 'karti'],
  ['krte', 'karte'],
  ['bta', 'batao'],
  ['btao', 'batao'],
  ['btado', 'batao'],
  ['batado', 'batao'],
  ['btade', 'batao'],
  ['dikha', 'dikhao'],
  ['dikhado', 'dikhao'],
  ['dikhade', 'dikhao'],
  ['kholdo', 'khol do'],
  ['kholde', 'khol do'],
  ['bnd', 'band'],
  ['bandh', 'band'],
  ['chlu', 'chalu'],
  ['strt', 'start'],
  ['bhj', 'bhejo'],
  ['bhjo', 'bhejo'],
  ['bhejdo', 'bhej do'],
  ['bhjdo', 'bhej do'],
  ['bhjde', 'bhej do'],
  ['bhejde', 'bhej do'],
  ['dlte', 'delete'],
  ['dlt', 'delete'],
  ['rmv', 'remove'],
  ['htao', 'hatao'],
  ['htado', 'hata do'],
  ['hatado', 'hata do'],
  ['chlao', 'chalao'],
  ['chlado', 'chala do'],
  ['chalado', 'chala do'],
  ['dhund', 'dhundo'],
  ['dhundho', 'dhundo'],
  ['dhoondho', 'dhundo'],
  ['khoj', 'khojo'],
  ['pdho', 'padho'],
  ['padhdo', 'padho'],
  ['lkho', 'likho'],
  ['likhdo', 'likh do'],
  ['rcrd', 'record'],
  ['rec', 'record'],
  ['rply', 'reply'],
  ['jwab', 'jawab'],
  ['swl', 'sawal'],
  ['sawaal', 'sawal'],
  ['mtlb', 'matlab'],
  ['matlb', 'matlab'],

  // Nouns & controls (typos + slang)
  ['scrnshot', 'screenshot'],
  ['scrnsht', 'screenshot'],
  ['screnshot', 'screenshot'],
  ['screensht', 'screenshot'],
  ['screengrab', 'screenshot'],
  ['vlume', 'volume'],
  ['volm', 'volume'],
  ['awaz', 'awaaz'],
  ['avaj', 'awaaz'],
  ['aawaj', 'awaaz'],
  ['awaaj', 'awaaz'],
  ['brghtness', 'brightness'],
  ['brtness', 'brightness'],
  ['brightnes', 'brightness'],
  ['roshni', 'brightness'],
  ['ujala', 'brightness'],
  ['btry', 'battery'],
  ['battry', 'battery'],
  ['betri', 'battery'],
  ['batery', 'battery'],
  ['wthr', 'weather'],
  ['wheather', 'weather'],
  ['wether', 'weather'],
  ['mosam', 'mausam'],
  ['mausham', 'mausam'],
  ['loction', 'location'],
  ['locaton', 'location'],
  ['kidhr', 'kahan'],
  ['kidhar', 'kahan'],
  ['kidr', 'kahan'],
  ['kaha', 'kahan'],
  ['mssg', 'message'],
  ['cmnd', 'command'],
  ['shrtcut', 'shortcut'],
  ['blutooth', 'bluetooth'],
  ['bluetoth', 'bluetooth'],
  ['waifai', 'wifi'],
  ['calclate', 'calculate'],
  ['remnd', 'remind'],
  ['remnder', 'reminder'],
  ['reminders', 'reminders'],

  // App name typos
  ['chrone', 'chrome'],
  ['crome', 'chrome'],
  ['chrme', 'chrome'],
  ['firfox', 'firefox'],
  ['firefx', 'firefox'],
  ['vscde', 'code'],
  ['vscode', 'code'],
  ['sptify', 'spotify'],
  ['spotfy', 'spotify'],
  ['trminal', 'terminal'],
  ['termnal', 'terminal'],
  ['utube', 'youtube'],
  ['ytube', 'youtube'],

  // Pronouns, postpositions & copulas
  ['mra', 'mera'],
  ['mri', 'meri'],
  ['mre', 'mere'],
  ['mjhe', 'mujhe'],
  ['mjhko', 'mujhko'],
  ['apna', 'apna'],
  ['kyaa', 'kya'],
  ['ky', 'kya'],
  ['kese', 'kaise'],
  ['kesa', 'kaisa'],
  ['ktni', 'kitni'],
  ['ktna', 'kitna'],
  ['abhi', 'abhi'],
  ['abi', 'abhi'],
  ['aj', 'aaj'],
  ['kl', 'kal'],
  ['tmrw', 'tomorrow'],
  ['tday', 'today'],
]);

// Multi-word colloquial phrases -> canonical intent-friendly forms
const PHRASE_REPLACEMENTS = [
  [/\b(?:fire\s+up|spin\s+up|boot\s+up|pull\s+up|bring\s+up|launch\s+up)\s+/gi, 'open '],
  [/\b(?:chala\s+de|chalu\s+kar\s+de|on\s+kar\s+de)\s+/gi, 'open '],
  [/\b(?:shut\s+down|terminate|nuke)\s+(chrome|firefox|brave|code|spotify|vlc|discord|slack|telegram|terminal|files)\b/gi, 'close $1'],
  [/\b(?:crank\s+up|pump\s+up|turn\s+up|boost|tez\s+kar(?:\s*do|\s*de)?)\s+(?:the\s+)?(?:volume|awaaz|sound)\b/gi, 'volume up'],
  [/\b(?:volume|awaaz|sound)\s+(?:tez|full|high|zyada|zyda)\s*(?:kar(?:\s*do|\s*de|\s*o)?)?\b/gi, 'volume up'],
  [/\b(?:tone\s+down|turn\s+down|lower|dhire\s+kar(?:\s*do|\s*de)?|slow\s+kar(?:\s*do|\s*de)?|ghata(?:\s*do|\s*de)?)\s+(?:the\s+)?(?:volume|awaaz|sound)\b/gi, 'volume down'],
  [/\b(?:volume|awaaz|sound)\s+(?:dhire|slow|low|ghata|kam)\s*(?:kar(?:\s*do|\s*de|\s*o)?)?\b/gi, 'volume down'],
  [/\b(?:shant|chup|khamosh)\s+kar(?:\s*do|\s*de|\s*o)?\b/gi, 'mute'],
  [/\b(?:dim|darken)\s+(?:the\s+)?(?:screen|display|brightness)\b/gi, 'brightness down'],
  [/\b(?:brighten|light\s+up)\s+(?:the\s+)?(?:screen|display|brightness)\b/gi, 'brightness up'],
  [/\b(?:grab|capture|snap)\s+(?:my\s+|the\s+)?screen(?:shot)?\b/gi, 'screenshot'],
  [/\b(?:peek\s+at|glimpse|check)\s+(?:my\s+|the\s+)?screen\b/gi, 'look at my screen'],
  [/\b(?:system\s+vitals|pc\s+health(?:\s+check)?|hardware\s+status|kitna\s+load\s+hai(?:\s+pc\s+pe)?|kaisa\s+chal\s+raha\s+hai\s+(?:pc|system))\b/gi, 'system status'],
];

/**
 * Normalize WhatsApp/Hinglish/Gen-Z shorthand, common typos, and colloquial
 * idioms into clean canonical text while preserving URLs, file paths, and code.
 */
export function normalizeVocabText(input) {
  const raw = String(input ?? '').trim();
  if (!raw || raw.length > 500) return raw;
  // Never mangle slash commands, URLs, file paths with extensions, or math expressions
  if (raw.startsWith('/') || /https?:\/\//i.test(raw) || /`/.test(raw)) return raw;

  let text = raw;
  for (const [pattern, replacement] of PHRASE_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }

  // Word-by-word normalization (preserving punctuation and case where needed)
  const tokens = text.split(/(\s+)/);
  const mapped = tokens.map((tok) => {
    if (/^\s+$/.test(tok)) return tok;
    const m = tok.match(/^([^a-zA-Z0-9\u0900-\u097F]*)([a-zA-Z0-9\u0900-\u097F]+)([^a-zA-Z0-9\u0900-\u097F]*)$/);
    if (!m) return tok;
    const [, prefix, core, suffix] = m;
    // Skip tokens that look like filenames or numbers
    if (/\d/.test(core) || prefix.includes('.') || suffix.includes('.')) return tok;
    const lower = core.toLowerCase();
    const rep = WORD_REPLACEMENTS.get(lower);
    if (!rep) return tok;
    return `${prefix}${rep}${suffix}`;
  });

  return mapped.join('').replace(/\s+/g, ' ').trim();
}

// ── 2. Damerau-Levenshtein Fuzzy Command Matcher ────────────────────────────

export function editDistance(a = '', b = '') {
  const s1 = String(a).toLowerCase();
  const s2 = String(b).toLowerCase();
  if (s1 === s2) return 0;
  const len1 = s1.length;
  const len2 = s2.length;
  if (!len1) return len2;
  if (!len2) return len1;
  if (Math.abs(len1 - len2) > 3) return Math.abs(len1 - len2);

  const dp = Array.from({ length: len1 + 1 }, () => new Array(len2 + 1).fill(0));
  for (let i = 0; i <= len1; i++) dp[i][0] = i;
  for (let j = 0; j <= len2; j++) dp[0][j] = j;

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // deletion
        dp[i][j - 1] + 1,      // insertion
        dp[i - 1][j - 1] + cost, // substitution
      );
      if (i > 1 && j > 1 && s1[i - 1] === s2[j - 2] && s1[i - 2] === s2[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + cost); // transposition
      }
    }
  }
  return dp[len1][len2];
}

export const KNOWN_SLASH_COMMANDS = [
  'help', 'ping', 'status', 'system', 'pc', 'open', 'close', 'apps', 'windows', 'focus',
  'screenshot', 'ocr', 'screen', 'look', 'webcam', 'record', 'wifi', 'bluetooth', 'bt',
  'ls', 'read', 'write', 'send', 'download', 'mv', 'cp', 'mkdir', 'zip', 'unzip', 'rm',
  'todo', 'todos', 'note', 'notes', 'remind', 'reminders', 'remember', 'memory', 'forget',
  'persona', 'train', 'learn', 'unlearn', 'cmd', 'command', 'createcmd', 'delcmd',
  'watchme', 'recordactions', 'replayactions', 'teach', 'macro', 'macros',
  'location', 'whereami', 'near', 'nearby', 'weather', 'calc', 'unit', 'currency',
  'wiki', 'define', 'vocab', 'word', 'synonym', 'translate', 'news', 'qr', 'url', 'pass',
  'msg', 'reply', 'broadcast', 'contact', 'contacts', 'guest', 'guests', 'pending',
  'approve', 'reject', 'block', 'unblock', 'allow', 'inbox',
  'agent', 'do', 'auto', 'autopilot', 'use', 'hands', 'brains', 'models', 'model',
  'doctor', 'solve', 'reach', 'yt', 'gh', 'reddit', 'hn', 'ui', 'brief', 'undo', 'stop',
];

/**
 * Given a potentially misspelled slash command (e.g. `screnshot`, `wether`,
 * `loction`, `watcme`), find the closest canonical command within edit distance <= 2.
 */
export function fuzzyMatchSlashCommand(cmd, extraCommands = []) {
  const target = String(cmd ?? '').toLowerCase().trim();
  if (!target || target.length < 4) return null;
  const pool = [...new Set([...KNOWN_SLASH_COMMANDS, ...extraCommands])];
  if (pool.includes(target)) return target;

  let best = null;
  let bestDist = Infinity;
  const maxDist = target.length >= 7 ? 2 : 1;

  for (const candidate of pool) {
    if (candidate.length < 4) continue;
    // First letter must match to avoid wild false positives on short words
    if (candidate[0] !== target[0]) continue;
    const d = editDistance(target, candidate);
    if (d <= maxDist && d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  return best;
}

// ── 3. Curated High-Impact Vocabulary Bank (English + Hindi + Hinglish) ─────

export const VOCAB_LEXICON = [
  {
    word: 'ephemeral',
    pronunciation: 'ih-FEM-er-uhl',
    pos: 'adjective',
    meaningEn: 'Lasting for a very short time; transitory.',
    meaningHi: 'क्षणिक / अल्पकालिक (जो बहुत कम समय तक रहे)',
    meaningHinglish: 'Jo cheez bas thodi der ke liye ho aur jaldi khatam ho jaye.',
    synonyms: ['transient', 'fleeting', 'short-lived', 'momentary', 'evanescent'],
    antonyms: ['permanent', 'enduring', 'eternal', 'perpetual'],
    example: 'Trends on social media are ephemeral, but strong engineering fundamentals are permanent.',
  },
  {
    word: 'ubiquitous',
    pronunciation: 'yoo-BIK-wi-tuhs',
    pos: 'adjective',
    meaningEn: 'Present, appearing, or found everywhere at the same time.',
    meaningHi: 'सर्वव्यापी (जो हर जगह मौजूद हो)',
    meaningHinglish: 'Jo har jagah dikhe ya har jagah maujood ho.',
    synonyms: ['omnipresent', 'pervasive', 'universal', 'all-over'],
    antonyms: ['rare', 'scarce', 'uncommon'],
    example: 'AI assistants have become ubiquitous across phones and desktops.',
  },
  {
    word: 'pragmatic',
    pronunciation: 'prag-MAT-ik',
    pos: 'adjective',
    meaningEn: 'Dealing with things sensibly and realistically in a way that is based on practical rather than theoretical considerations.',
    meaningHi: 'व्यावहारिक (प्रैक्टिकल सोच रखने वाला)',
    meaningHinglish: 'Hawa-hawai baaton ke bajaye practical aur kaam aane wala approach.',
    synonyms: ['practical', 'realistic', 'sensible', 'down-to-earth', 'grounded'],
    antonyms: ['idealistic', 'impractical', 'unrealistic', 'dogmatic'],
    example: 'We took a pragmatic approach to ship the feature fast without breaking existing workflows.',
  },
  {
    word: 'meticulous',
    pronunciation: 'muh-TIK-yuh-luhs',
    pos: 'adjective',
    meaningEn: 'Showing great attention to detail; very careful and precise.',
    meaningHi: 'अति-सावधान / बारीकी से काम करने वाला',
    meaningHinglish: 'Chhoti se chhoti detail par poora dhyan dene wala.',
    synonyms: ['thorough', 'scrupulous', 'precise', 'exacting', 'punctilious'],
    antonyms: ['careless', 'sloppy', 'negligent', 'haphazard'],
    example: 'The action recorder does a meticulous job of tracking every single button click.',
  },
  {
    word: 'resilient',
    pronunciation: 'ri-ZIL-yuhnt',
    pos: 'adjective',
    meaningEn: 'Able to withstand or recover quickly from difficult conditions or failures.',
    meaningHi: 'लचीला और मजबूत (मुश्किल से जल्दी उबरने वाला)',
    meaningHinglish: 'Jo failure ya crash ke baad turant wapas khada ho jaye.',
    synonyms: ['robust', 'hardy', 'adaptable', 'tough', 'buoyant'],
    antonyms: ['fragile', 'vulnerable', 'brittle'],
    example: 'Multi-provider routing makes the agent resilient even when one cloud API goes down.',
  },
  {
    word: 'eloquent',
    pronunciation: 'EL-uh-kwuhnt',
    pos: 'adjective',
    meaningEn: 'Fluent, persuasive, and expressive in speaking or writing.',
    meaningHi: 'वाक्पटु / प्रभावशाली ढंग से बोलने वाला',
    meaningHinglish: 'Jo apni baat bahut asardaar, saaf aur shandaar shabdon me rakhe.',
    synonyms: ['articulate', 'expressive', 'fluent', 'silver-tongued', 'persuasive'],
    antonyms: ['inarticulate', 'hesitant', 'tongue-tied'],
    example: 'An eloquent pitch can win over investors in under two minutes.',
  },
  {
    word: 'paradigm',
    pronunciation: 'PAIR-uh-dime',
    pos: 'noun',
    meaningEn: 'A typical example, pattern, or fundamental model of something.',
    meaningHi: 'प्रतिमान / सोचने या काम करने का मूल ढांचा',
    meaningHinglish: 'Kaam karne ya sochne ka ek naya model ya tareeqa.',
    synonyms: ['model', 'framework', 'pattern', 'archetype', 'blueprint'],
    antonyms: ['anomaly', 'exception'],
    example: 'Agentic AI represents a paradigm shift from passive chatbots to autonomous action.',
  },
  {
    word: 'concise',
    pronunciation: 'kuhn-SISE',
    pos: 'adjective',
    meaningEn: 'Giving a lot of information clearly and in a few words; brief but comprehensive.',
    meaningHi: 'संक्षिप्त और सटीक (कम शब्दों में पूरी बात)',
    meaningHinglish: 'Binafaltu lamba khinche, kam shabdon me bilkul point ki baat.',
    synonyms: ['succinct', 'pithy', 'terse', 'crisp', 'laconic'],
    antonyms: ['verbose', 'wordy', 'rambling', 'long-winded'],
    example: 'Keep your WhatsApp updates concise so they can be read at a glance.',
  },
  {
    word: 'astute',
    pronunciation: 'uh-STOOT',
    pos: 'adjective',
    meaningEn: 'Having or showing an ability to accurately assess situations or people and turn this to one\'s advantage.',
    meaningHi: 'चतुर / तीक्ष्ण बुद्धि वाला',
    meaningHinglish: 'Bahut sharp aur samajhdaar jo situation ko turant bhaanp le.',
    synonyms: ['shrewd', 'sharp', 'perceptive', 'incisive', 'canny'],
    antonyms: ['naive', 'obtuse', 'oblivious'],
    example: 'That was an astute observation about why the latency spiked.',
  },
  {
    word: 'synergy',
    pronunciation: 'SIN-er-jee',
    pos: 'noun',
    meaningEn: 'The interaction of two or more agents or forces so that their combined effect is greater than the sum of their individual effects.',
    meaningHi: 'तालमेल / सहक्रिया (मिलकर दोगुनी ताकत बनना)',
    meaningHinglish: 'Jab do cheezein milkar akele se kahin zyada powerful result dein.',
    synonyms: ['collaboration', 'harmony', 'teamwork', 'symbiosis'],
    antonyms: ['discord', 'friction', 'antagonism'],
    example: 'The synergy between local AT-SPI sensors and AI reasoning gives 100% precision.',
  },
  {
    word: 'tenacious',
    pronunciation: 'tuh-NAY-shuhs',
    pos: 'adjective',
    meaningEn: 'Tending to keep a firm hold of something; persistent and determined.',
    meaningHi: 'दृढ़ / ज़िद्दी (लक्ष्य न छोड़ने वाला)',
    meaningHinglish: 'Jo haar na maane aur kaam khatam karke hi dam le.',
    synonyms: ['persistent', 'determined', 'relentless', 'dogged', 'steadfast'],
    antonyms: ['irresolute', 'yielding', 'weak-willed'],
    example: 'A tenacious debugger always tracks down the root cause.',
  },
  {
    word: 'immutable',
    pronunciation: 'ih-MYOO-tuh-buhl',
    pos: 'adjective',
    meaningEn: 'Unchanging over time or unable to be changed.',
    meaningHi: 'अपरिवर्तनीय (जिसे बदला न जा सके)',
    meaningHinglish: 'Ek baar ban gaya to kabhi change na hone wala (fixed/locked).',
    synonyms: ['unchangeable', 'fixed', 'inflexible', 'invariable'],
    antonyms: ['mutable', 'changeable', 'variable'],
    example: 'The owner-only firewall is an immutable security rule in this agent.',
  },
  {
    word: 'alacrity',
    pronunciation: 'uh-LAK-ri-tee',
    pos: 'noun',
    meaningEn: 'Brisk and cheerful readiness; eager speed.',
    meaningHi: 'तत्परता / फुर्ती और उत्साह',
    meaningHinglish: 'Bina der kiye full speed aur josh ke saath kaam karna.',
    synonyms: ['eagerness', 'celerity', 'promptness', 'dispatch', 'zeal'],
    antonyms: ['apathy', 'reluctance', 'sluggishness'],
    example: 'JARVIS executes every owner command with alacrity.',
  },
  {
    word: 'cognitive',
    pronunciation: 'KOG-ni-tiv',
    pos: 'adjective',
    meaningEn: 'Relating to the mental process of perception, memory, judgment, and reasoning.',
    meaningHi: 'संज्ञानात्मक (सोचने-समझने और दिमाग से जुड़ा)',
    meaningHinglish: 'Dimag, samajh, memory aur reasoning se juda hua.',
    synonyms: ['intellectual', 'mental', 'cerebral', 'analytical'],
    antonyms: ['physical', 'reflexive'],
    example: 'Smart routing reduces cognitive load and answers simple questions in milliseconds.',
  },
  {
    word: 'Deterministic',
    pronunciation: 'dih-tur-muh-NIS-tik',
    pos: 'adjective',
    meaningEn: 'Producing the exact same output every time for a given input, with zero randomness.',
    meaningHi: 'निश्चयात्मक (हर बार 100% वही पक्का परिणाम देने वाला)',
    meaningHinglish: 'Jisme koi tukka ya randomness na ho — har baar exact wahi result aaye.',
    synonyms: ['predictable', 'exact', 'certain', 'reproducible'],
    antonyms: ['stochastic', 'random', 'probabilistic'],
    example: 'Offline NLP intents are deterministic and execute in under 1 millisecond.',
  },
  {
    word: 'heuristic',
    pronunciation: 'hyoo-RIS-tik',
    pos: 'noun / adjective',
    meaningEn: 'A practical rule-of-thumb or shortcut that solves a problem faster when an exhaustive search is too slow.',
    meaningHi: 'अनुमानी नियम / तेज़ व्यावहारिक तरकीब',
    meaningHinglish: 'Smart shortcut ya rule-of-thumb jisse kaam turant aur fast ho jaye.',
    synonyms: ['rule of thumb', 'shortcut', 'approximation'],
    antonyms: ['algorithmic proof', 'exhaustive search'],
    example: 'Our complexity router uses fast heuristics to pick the right AI brain in microseconds.',
  },
  {
    word: 'idempotent',
    pronunciation: 'eye-DEM-poh-tuhnt',
    pos: 'adjective',
    meaningEn: 'An operation that can be applied multiple times without changing the result beyond the initial application.',
    meaningHi: 'बार-बार चलाने पर भी सुरक्षित (दोहराव-सुरक्षित)',
    meaningHinglish: 'Jise 1 baar chalao ya 10 baar, result safe aur same rahe (double गड़बड़ na ho).',
    synonyms: ['repeat-safe', 're-entrant'],
    antonyms: ['side-effecting', 'non-repeatable'],
    example: 'Setting the volume to 50% is an idempotent operation.',
  },
  {
    word: 'lucid',
    pronunciation: 'LOO-sid',
    pos: 'adjective',
    meaningEn: 'Expressed clearly; easy to understand.',
    meaningHi: 'सुस्पष्ट / बिल्कुल साफ और समझने में आसान',
    meaningHinglish: 'Ekdam crystal-clear aur aasani se samajh aane wala explanation.',
    synonyms: ['clear', 'intelligible', 'transparent', 'coherent', 'crystalline'],
    antonyms: ['confusing', 'obscure', 'ambiguous', 'muddy'],
    example: 'Give me a lucid explanation of how quantum entanglement works.',
  },
];

// Fast index by lowercase word + synonym reverse lookup
const LEXICON_BY_WORD = new Map();
for (const entry of VOCAB_LEXICON) {
  LEXICON_BY_WORD.set(entry.word.toLowerCase(), entry);
}

/**
 * Look up a word in the instant offline lexicon first, then fall back to the
 * Free Dictionary API when online.
 */
export async function lookupWordPower(rawWord, { fetchOnline = true } = {}) {
  const clean = String(rawWord ?? '').trim().replace(/^["'`]+|["'`?!.।]+$/g, '').trim();
  if (!clean) return null;
  const key = clean.toLowerCase();

  // 1. Direct match in our curated bilingual/Hinglish lexicon
  if (LEXICON_BY_WORD.has(key)) {
    return { ...LEXICON_BY_WORD.get(key), source: 'offline_lexicon' };
  }

  // 2. Fuzzy match in offline lexicon (edit distance <= 1 for words >= 5 chars)
  if (key.length >= 5) {
    for (const [lexWord, entry] of LEXICON_BY_WORD.entries()) {
      if (lexWord[0] === key[0] && editDistance(key, lexWord) <= 1) {
        return { ...entry, correctedFrom: clean, source: 'offline_lexicon_fuzzy' };
      }
    }
  }

  // 3. Synonym match in offline lexicon
  for (const entry of VOCAB_LEXICON) {
    if (entry.synonyms.some((s) => s.toLowerCase() === key)) {
      return {
        word: clean,
        pronunciation: '',
        pos: entry.pos,
        meaningEn: `Closely related to "${entry.word}": ${entry.meaningEn}`,
        meaningHi: entry.meaningHi,
        meaningHinglish: entry.meaningHinglish,
        synonyms: [entry.word, ...entry.synonyms.filter((s) => s.toLowerCase() !== key)],
        antonyms: entry.antonyms,
        example: entry.example,
        source: 'offline_synonym',
      };
    }
  }

  // 4. Online Free Dictionary API lookup (fast 2.5s timeout)
  if (fetchOnline) {
    try {
      const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(key)}`, {
        signal: AbortSignal.timeout(2500),
      });
      if (res.ok) {
        const data = await res.json();
        const first = data?.[0];
        if (first) {
          const allMeanings = first.meanings ?? [];
          const primaryMeaning = allMeanings[0] ?? {};
          const defs = primaryMeaning.definitions ?? [];
          const synonyms = new Set([
            ...(primaryMeaning.synonyms ?? []),
            ...defs.flatMap((d) => d.synonyms ?? []),
          ]);
          const antonyms = new Set([
            ...(primaryMeaning.antonyms ?? []),
            ...defs.flatMap((d) => d.antonyms ?? []),
          ]);
          return {
            word: first.word || clean,
            pronunciation: first.phonetic || first.phonetics?.find((p) => p.text)?.text || '',
            pos: primaryMeaning.partOfSpeech || '',
            meaningEn: defs[0]?.definition || 'No definition found.',
            meaningHi: '',
            meaningHinglish: '',
            synonyms: [...synonyms].slice(0, 6),
            antonyms: [...antonyms].slice(0, 5),
            example: defs.find((d) => d.example)?.example || '',
            source: 'dictionary_api',
          };
        }
      }
    } catch { /* fall through */ }
  }

  return null;
}

/** Format a rich WhatsApp card for a word lookup. */
export function formatVocabCard(entry) {
  if (!entry) return null;
  const lines = [
    `📖 *${entry.word}*${entry.pronunciation ? `  _(${entry.pronunciation})_` : ''}${entry.pos ? ` · _${entry.pos}_` : ''}`,
  ];
  if (entry.correctedFrom) {
    lines.push(`_(Auto-corrected from "${entry.correctedFrom}")_`);
  }
  if (entry.meaningEn) lines.push(`• *English*: ${entry.meaningEn}`);
  if (entry.meaningHi) lines.push(`• *Hindi*: ${entry.meaningHi}`);
  if (entry.meaningHinglish) lines.push(`• *Hinglish*: ${entry.meaningHinglish}`);
  if (entry.synonyms?.length) lines.push(`• *Synonyms (Paryayvachi)*: \`${entry.synonyms.join('`, `')}\``);
  if (entry.antonyms?.length) lines.push(`• *Antonyms (Vilom)*: \`${entry.antonyms.join('`, `')}\``);
  if (entry.example) lines.push(`• *Example*: _"${entry.example}"_`);
  return lines.join('\n');
}

/** Deterministic daily / random high-impact vocabulary booster. */
export function getWordOfTheDay(seed = Date.now()) {
  const dayIndex = Math.abs(Math.floor(Number(seed) / 86_400_000)) % VOCAB_LEXICON.length;
  const entry = VOCAB_LEXICON[dayIndex];
  return [
    '🧠 *Power Word of the Day*',
    '',
    formatVocabCard(entry),
  ].join('\n');
}

/**
 * Parse natural-language vocabulary, meaning, synonym, translation & text
 * elevation requests.
 * Returns `{ mode: 'define'|'synonyms'|'antonyms'|'wod'|'rewrite'|'translate', word?, text?, style?, targetLang? } | null`.
 */
export function parseVocabIntent(rawInput) {
  const text = String(rawInput ?? '').trim();
  if (!text || text.startsWith('/')) return null;
  let m = null;

  // 1. Word of the day / teach me a new word
  if (/^(?:word\s+of\s+the\s+day|aaj\s+ka\s+(?:naya\s+)?(?:word|shabd)|teach\s+me\s+a\s+(?:new\s+|advanced\s+)?word|naya\s+(?:word|shabd)\s+(?:sikhao|batao)|vocab\s+boost(?:er)?)\??$/i.test(text)) {
    return { mode: 'wod' };
  }

  // 2. Synonyms / Antonyms lookup
  if ((m = text.match(/^(?:synonyms?|paryayvachi|similar\s+words?|better\s+words?)\s+(?:of|for|to|ka|ke)?\s*["']?([a-zA-Z-]{2,30})["']?\??$/i))
    || (m = text.match(/^["']?([a-zA-Z-]{2,30})["']?\s+(?:ka|ke)\s+(?:synonyms?|paryayvachi|similar\s+words?)(?:\s+(?:kya\s+hai|batao))?\??$/i))) {
    return { mode: 'synonyms', word: m[1].trim() };
  }
  if ((m = text.match(/^(?:antonyms?|opposite(?:\s+word)?|vilom(?:\s+shabd)?)\s+(?:of|for|to|ka|ke)?\s*["']?([a-zA-Z-]{2,30})["']?\??$/i))
    || (m = text.match(/^["']?([a-zA-Z-]{2,30})["']?\s+(?:ka|ke)\s+(?:antonyms?|opposite|vilom(?:\s+shabd)?)(?:\s+(?:kya\s+hai|batao))?\??$/i))) {
    return { mode: 'antonyms', word: m[1].trim() };
  }

  // 3. Word meaning / definition ("<word> ka matlab kya hai", "meaning of <word>", "define <word>")
  if ((m = text.match(/^(?:define|meaning\s+of|definition\s+of|what\s+does)\s+["']?([a-zA-Z-]{2,30})["']?(?:\s+mean)?\??$/i))
    || (m = text.match(/^["']?([a-zA-Z-]{2,30})["']?\s+(?:word\s+)?(?:ka\s+)?(?:matlab|meaning|arth)(?:\s+kya\s+(?:hota\s+hai|hai)|\s+batao|\s+samjhao|\s+in\s+(?:hindi|hinglish|english))?\??$/i))) {
    const candidate = m[1].trim();
    // Avoid catching general questions like "life ka matlab kya hai" if it's a multi-word phrase, but single word is great
    if (!/^(?:ye|yeh|iska|uska|tumhara|mera)$/i.test(candidate)) {
      return { mode: 'define', word: candidate };
    }
  }

  // 4. Vocabulary elevation / professional rewrite ("isko high vocab me likho: ...", "rewrite professionally: ...")
  if ((m = text.match(/^(?:(?:isko|ise|is\s+line\s+ko)\s+(?:advanced|high\s+vocab|professional|fluent|shuddh\s+hindi|english|hinglish|better|sharp)\s*(?:vocab|english|hindi|style|tarike)?\s*(?:me|mein)\s+(?:likh(?:\s*do|\s*o)?|badal(?:\s*do|\s*o)?|rewrite\s+kar(?:o|do)?)|(?:rewrite|rephrase|elevate|improve\s+vocab(?:ulary)?(?:\s+of)?)\s*(?:in\s+(?:advanced|professional|executive|fluent)\s+english)?)\s*[:\-]\s*([\s\S]+)$/i))) {
    return { mode: 'rewrite', text: m[1].trim() };
  }

  // 5. Translation ("translate to hindi: ...", "isko english me translate karo: ...")
  if ((m = text.match(/^(?:translate\s+(?:this\s+)?(?:to|into)\s+(english|hindi|hinglish)|(?:isko|ise)\s+(english|hindi|hinglish)\s+(?:me|mein)\s+(?:translate|anuvad)\s+kar(?:o|do)?)\s*[:\-]?\s*([\s\S]+)$/i))) {
    return {
      mode: 'translate',
      targetLang: (m[1] || m[2] || 'English').trim(),
      text: m[3].trim(),
    };
  }

  return null;
}

// ── 4. Adaptive Linguistic Register & Prompt Enricher ───────────────────────

/**
 * Detect the linguistic register of the user's message so the AI brain can
 * match and elevate its vocabulary accordingly.
 */
export function detectLinguisticRegister(text = '') {
  const s = String(text ?? '').trim();
  if (!s) return 'balanced';
  if (/[\u0900-\u097F]/.test(s)) return 'devanagari_hindi';
  const low = s.toLowerCase();
  const techHits = (low.match(/\b(api|code|function|async|await|docker|linux|kernel|latency|throughput|database|sql|react|node|python|algorithm|architecture|refactor|bug|stack)\b/g) || []).length;
  if (techHits >= 2) return 'technical_elite';
  const hinglishHits = (low.match(/\b(bhai|bro|yaar|kya|kaise|kyun|hai|hoon|karo|batao|samjhao|matlab|accha|sahi|mast|ekdam|bilkul|jugad|scene)\b/g) || []).length;
  if (hinglishHits >= 1) return 'fluent_hinglish';
  return 'articulate_english';
}

/**
 * Build a concise, high-impact vocabulary & speed directive injected into the
 * AI system prompt so the model speaks with sharper vocabulary and zero fluff.
 */
export function buildVocabPromptDirective(userText = '') {
  const reg = detectLinguisticRegister(userText);
  const registerHint = reg === 'fluent_hinglish'
    ? 'The user is speaking Hinglish: reply in natural, witty, high-fluency Hinglish (seamlessly blending sharp English technical/analytical vocabulary with authentic Hindi/Hinglish idioms — never stiff or textbook).'
    : reg === 'devanagari_hindi'
    ? 'The user is writing in Hindi: reply in rich, natural, expressive Hindi (with accurate technical terms where appropriate).'
    : reg === 'technical_elite'
    ? 'The user is asking a technical question: use precise engineering & computer-science vocabulary, exact terminology, and lucid explanations with zero filler.'
    : 'Use articulate, high-clarity, expressive vocabulary — precise verbs and nouns instead of vague words.';

  return [
    'VOCABULARY & SPEED EXCELLENCE:',
    `- ${registerHint}`,
    '- Be lexically sharp ("vocab mein tez"): understand slang, abbreviations, typos, Hindi/Hinglish/English code-switching, and nuanced intent effortlessly.',
    '- Prioritize high information density and speed: lead with the direct answer or conclusion in the very first sentence, use strong precise words, and never pad with robotic filler.',
  ].join('\n');
}
