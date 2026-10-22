// text.js — text → fixed-size numeric feature vector for the neural nets.
//
// fastText-style hashing trick: word unigrams + bigrams + character 3-grams
// are hashed into D buckets (default 384) and L2-normalized. Deterministic,
// no vocabulary to maintain, handles Hinglish/English/text-speak equally.

const HASH_DIM = 384;

/**
 * Lexicographic cue flags — engineered indicator features appended to the
 * hashed n-gram vector. Small data loves these: "45 * 32 + 18 = ?" has almost
 * no words, but mathop+digit flags make it unmistakable; "who wrote X" gets
 * the wh-flag. Standard practice, and it is what makes 400 examples enough.
 */
const CUE_FLAGS = [
  [/\d/, 'digit'],
  [/[=+\-*/^%×÷]/, 'mathop'],
  [/[?]/, 'qmark'],
  [/^(?:what|who|when|where|why)\b/, 'wh'],
  [/^how\s+(?:many|much|far|tall|old|long|often)\b/, 'howmany'],
  [/^(?:how to|how do i|how do you (?:make|install|create|reset|change|write|build|start|use|get)|how can i|kaise (?:kar|install|ban))\b/, 'howto'],
  [/^how\b/, 'how'],
  [/^(?:kya|kaun|kab|kahan|kyun|kisne|kitna|kitne|kitni)\b/, 'hiwh'],
  [/^kaise\b/, 'kaise'],
  [/(?:^(?:explain|samjhao|describe|detail)\b|how (?:does|do) .*\bwork|kaise kaam karta|kyun hota hai)/, 'explain'],
  [/^(?:write|likho|banao|create|compose|design|generate)\b/, 'create'],
  [/^(?:solve|calculate|compute|evaluate|find)\b/, 'mathverb'],
  [/\b(vs\.?|versus|difference|compare|farak|better|antar|kaunsa)\b/, 'cmp'],
  [/\b(thanks|thank|shukriya|dhanyavaad|badhiya|great|awesome|accha jawab|kamaal)\b/, 'praise'],
  [/\b(mood|sad|khush|tension|stress|lonely|dar|bura|off hai|burnout|fail|anxiety|dukhi)\b/, 'emo'],
  [/\b(poem|kavita|story|kahani|caption|shayari|quote|lyrics|limerick|rap|song|gaana)\b/, 'creative'],
  [/\b(mera|meri|mujhe|mereko|my name|my favourite|my favorite|yaad rakh|remember|reminder|birthday|who am i|about me)\b/, 'personal'],
  [/\b(code|script|function|debug|bug|regex|sql|python|javascript|react|api|query|compiler)\b/, 'codeword'],
  [/\b(hi|hello|hey|yo|namaste|namaskar|radhe|good morning|good night|good evening|kaise ho|kya haal|wassup|sup)\b/, 'greet'],
  [/\b(bye|gn|tata|see you|goodbye)\b/, 'bye'],
  [/^(?:\d|[xXn]\s*[*+\-/^=])/, 'mathstart'],
  [/\b(?:sorry|excuse|please|plz)\b/, 'polite'],
];

export const FLAG_DIM = CUE_FLAGS.length;
export const DEFAULT_DIM = HASH_DIM + FLAG_DIM;

/** FNV-1a — tiny, fast, well-distributed. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Bilingual lexicon — Hinglish/Hindi words expand to English before featurizing
// so "bharat ki rajdhani" and "capital of india" land in the same feature space.
// (Feature-level only; reply text is never touched.)
const BILINGUAL = {
  rajdhani: 'capital', rajdhaani: 'capital', bharat: 'india', hindustan: 'india',
  nadi: 'river', pahad: 'mountain', parvat: 'mountain', pahadi: 'mountain',
  khel: 'game', khelkud: 'sports', vigyan: 'science', vigyani: 'scientist',
  ganit: 'math', riyazi: 'math', itihas: 'history', purane: 'history',
  bhugol: 'geography', praudyogiki: 'technology', takniki: 'technology',
  sarkar: 'government', kanoon: 'law', shiksha: 'education', padhai: 'education',
  chikitsa: 'medicine', davai: 'medicine', dawai: 'medicine', kheti: 'agriculture',
  krishi: 'agriculture', arthvyavastha: 'economy', sanskriti: 'culture',
  paryatan: 'tourism', yatra: 'travel', rashtra: 'nation', desh: 'country',
  nagar: 'city', shehar: 'city', gaon: 'village', samay: 'time', saal: 'year',
  mahina: 'month', hawa: 'air', paani: 'water', aag: 'fire', dharti: 'earth',
  aakash: 'sky', suraj: 'sun', chandrama: 'moon', chand: 'moon', tara: 'star',
  jeevan: 'life', manav: 'human', prani: 'animal', ped: 'tree', phool: 'flower',
  kitab: 'book', vidyalaya: 'school', vishwavidyalaya: 'university',
  aspatal: 'hospital', swatantrata: 'independence', azaadi: 'independence',
  samvidhan: 'constitution', pradhanmantri: 'prime minister',
  rashtrapati: 'president', sansad: 'parliament', sainya: 'military',
  fauj: 'army', yuddh: 'war', shanti: 'peace', kranti: 'revolution',
};

// ── Memoization ────────────────────────────────────────────────────────────
// normalizeText/textFeatures/tokens run on every match, classify and knowledge
// lookup. Bounded LRU keeps the hot paths allocation-free on repeats. Text
// features are deterministic, so caching is always safe.
const LRU_CAP = 4000;
function makeLRU() {
  const map = new Map();
  return {
    get(k) {
      if (!map.has(k)) return undefined;
      const v = map.get(k);
      map.delete(k);
      map.set(k, v); // refresh recency
      return v;
    },
    set(k, v) {
      if (map.has(k)) map.delete(k);
      map.set(k, v);
      if (map.size > LRU_CAP) map.delete(map.keys().next().value);
      return v;
    },
  };
}
const normLRU = makeLRU();
const featLRU = makeLRU();
const tokLRU = makeLRU();

function normalizeTextRaw(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\bu\b/g, 'you')
    .replace(/\bur\b/g, 'your')
    .replace(/\br\b/g, 'are')
    .replace(/\bn\b/g, 'and')
    .replace(/\bthx\b/g, 'thanks')
    .replace(/\bplz\b/g, 'please')
    .replace(/\bwanna\b/g, 'want to')
    .replace(/\bgotta\b/g, 'got to')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => BILINGUAL[w] || w)
    .join(' ');
}

export function normalizeText(s) {
  const key = String(s ?? '');
  const hit = normLRU.get(key);
  if (hit !== undefined) return hit;
  return normLRU.set(key, normalizeTextRaw(key));
}

export function tokens(s) {
  return normalizeText(s).split(' ').filter(Boolean);
}

/** Hash text into a fixed-dim L2-normalized feature vector (plain Array). */
function textFeaturesRaw(text, dim = DEFAULT_DIM) {
  const raw = String(text ?? '').toLowerCase().trim();
  const vec = new Array(dim).fill(0);
  const toks = tokens(text);
  const add = (gram, weight = 1) => {
    const idx = fnv1a(gram) % HASH_DIM;
    vec[idx] += weight;
  };
  for (const t of toks) {
    add(`w:${t}`, 1);
    const padded = `_${t}_`;
    for (let i = 0; i + 3 <= padded.length; i++) add(`c:${padded.slice(i, i + 3)}`, 0.5);
    if (t.length > 5) add(`p:${t.slice(0, 3)}`, 0.4); // prefix cue ("photosyn…")
  }
  for (let i = 0; i + 1 < toks.length; i++) add(`b:${toks[i]}_${toks[i + 1]}`, 0.8);
  if (toks.length) add(`n:${Math.min(toks.length, 12)}`, 0.3); // length bucket

  // append cue-flag slots (dedicated positions, weight 2.5 — strong signals)
  for (let f = 0; f < CUE_FLAGS.length; f++) {
    if (CUE_FLAGS[f][0].test(raw)) vec[HASH_DIM + f] = 2.5;
  }

  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

export function textFeatures(text, dim = DEFAULT_DIM) {
  const key = dim === DEFAULT_DIM ? String(text ?? '') : `d${dim}:${text ?? ''}`;
  const hit = featLRU.get(key);
  if (hit) return hit;
  return featLRU.set(key, textFeaturesRaw(text, dim));
}

// ── Prepared pair sides ────────────────────────────────────────────────────
// pairFeatures used to compute BOTH sides from scratch every call. For a
// knowledge scan (query × hundreds of keys) the sides repeat constantly —
// compute each side once, then only the 13 cheap scalars per pair.
const sideLRU = makeLRU();

export function preparePairSide(s) {
  const raw = String(s ?? '');
  const hit = sideLRU.get(raw);
  if (hit) return hit;
  const norm = normalizeText(raw);
  const toks = new Set(norm.split(' ').filter(Boolean));
  return sideLRU.set(raw, { raw, norm, toks, vec: textFeatures(raw), len: norm.length });
}

export function pairFeaturesPrepared(q, c) {
  const qt = q.toks;
  const ct = c.toks;
  let inter = 0;
  for (const t of qt) if (ct.has(t)) inter += 1;
  const union = qt.size + ct.size - inter || 1;
  const jaccard = inter / union;

  const qv = q.vec;
  const cv = c.vec;
  let cos = 0;
  for (let i = 0; i < qv.length; i++) cos += qv[i] * cv[i];

  const lenRatio = Math.min(q.len, c.len) / Math.max(1, Math.max(q.len, c.len));
  const qInC = c.norm.includes(q.norm) && q.norm.length >= 4 ? 1 : 0;
  const cInQ = q.norm.includes(c.norm) && c.norm.length >= 4 ? 1 : 0;

  const ed = editDistance(q.norm.slice(0, 40), c.norm.slice(0, 40));
  const edRatio = 1 - ed / Math.max(1, Math.max(Math.min(q.len, 40), Math.min(c.len, 40)));

  return [
    jaccard, cos, lenRatio, qInC, cInQ, edRatio,
    inter / Math.max(1, qt.size),
    inter / Math.max(1, ct.size),
    q.len / 100, c.len / 100,
    qt.size / 10, ct.size / 10,
    1, // bias
  ];
}

/**
 * Hand-crafted pair features for MatchNet — the signals a good matcher needs
 * (linear thresholds on any single one of these are weak; the net learns the
 * nonlinear combination).
 */
export function pairFeatures(query, candidate) {
  return pairFeaturesPrepared(preparePairSide(query), preparePairSide(candidate));
}

export function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

