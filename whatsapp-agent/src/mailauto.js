// mailauto.js — 📧 `/email auto`: the agent reads the Gmail app password off
// the screen itself, so the owner never copies 16 characters by hand.
//
// What is honestly automatable and what is not:
//   ✅ Opening Google's app-password page.
//   ✅ Clicking "Create app password".
//   ✅ Reading the 16-char code from the screen with local OCR.
//   ✅ Fixing the classic OCR confusions (0/o, 1/l/|, 5/s, 8/b) and verifying
//      each guess by an actual IMAP login before believing it.
//   ❌ Turning on 2-Step Verification / creating the Google account: Google
//      requires a human phone approval and offers no API for either.
//
// The verification step is what makes OCR safe here: a wrong guess is simply
// rejected by Gmail's own server, so the worst case is "try the next candidate".

export const APP_PASSWORD_URL = 'https://myaccount.google.com/apppasswords';
export const CANDIDATE_LIMIT = 6;
export const APP_PASSWORD_LENGTH = 16;

// Groups that mean "this is prose, not an app password".
const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'will', 'your', 'code', 'here', 'mail',
  'pass', 'word', 'copy', 'done', 'next', 'more', 'show', 'name', 'like', 'time',
  'just', 'then', 'also', 'only', 'some', 'when', 'what', 'were', 'been', 'they',
  'them', 'than', 'into', 'over', 'back', 'after', 'before', 'click', 'press',
]);

/** OCR confusions → the alphabet Google actually uses (lowercase a-z). */
export function fixOcrConfusions(chunk) {
  return String(chunk ?? '')
    .toLowerCase()
    .replace(/[0]/g, 'o')
    .replace(/[1|!¡]/g, 'l')
    .replace(/[2]/g, 'z')
    .replace(/[5]/g, 's')
    .replace(/[6]/g, 'g')
    .replace(/[8]/g, 'b')
    .replace(/[9]/g, 'g')
    .replace(/[^a-z]/g, '');
}

/** l↔i is the one confusion OCR cannot resolve by rules — try both. */
function confusionVariants(candidate) {
  const out = [candidate];
  if (/[li]/.test(candidate)) {
    out.push(candidate.replace(/[li]/g, (ch) => (ch === 'l' ? 'i' : 'l')));
  }
  return out;
}

/**
 * Pull app-password candidates out of OCR text, best first.
 * Accepts "abcd efgh ijkl mnop", "abcdefghijklmnop", and OCR-damaged variants.
 * Prose like "this that code here" is rejected by the stopword rule instead of
 * being wasted on a login attempt.
 */
export function extractAppPasswordCandidates(text, opts = {}) {
  const { limit = CANDIDATE_LIMIT } = opts;
  const raw = String(text ?? '');
  const scored = [];
  const seen = new Set();

  const consider = (chunk, rank) => {
    const groups = String(chunk).trim().split(/[\s\u00a0]+/).filter(Boolean);
    const normalised = fixOcrConfusions(chunk);
    if (normalised.length !== APP_PASSWORD_LENGTH) return;
    if (groups.length === 4) {
      const words = groups.map((group) => group.toLowerCase());
      if (words.filter((word) => STOPWORDS.has(word)).length >= 2) return; // prose
    }
    for (const variant of confusionVariants(normalised)) {
      if (seen.has(variant)) continue;
      seen.add(variant);
      scored.push({ candidate: variant, rank });
    }
  };

  // 1) four groups of four — exactly how Google renders it.
  for (const match of raw.matchAll(/(?:[a-z0-9|!¡]{4}[ \t\u00a0]{1,2}){3}[a-z0-9|!¡]{4}/gi)) {
    const hasConfusable = /[0-9|!¡]/.test(match[0]);
    consider(match[0], hasConfusable ? 0 : 1);
  }
  // 2) one unbroken 16-character run (the "copy" view).
  for (const match of raw.matchAll(/(?<![a-z0-9])[a-z0-9|!¡]{16}(?![a-z0-9])/gi)) {
    consider(match[0], 2);
  }

  return scored
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.candidate)
    .slice(0, limit);
}

/**
 * Try candidates against the real server, cheapest first. `verifyOne` returns
 * truthy for a password the mailbox accepts. Nothing is saved until one works.
 */
export async function findWorkingCandidate(candidates, verifyOne, opts = {}) {
  const { limit = CANDIDATE_LIMIT, log = null } = opts;
  const tried = [];
  for (const candidate of (candidates ?? []).slice(0, limit)) {
    tried.push(candidate);
    try {
      // eslint-disable-next-line no-await-in-loop
      if (await verifyOne(candidate)) return { candidate, tried, ok: true };
    } catch (err) {
      log?.info?.(`[mailauto] candidate rejected: ${err?.message ?? err}`);
    }
  }
  return { candidate: null, tried, ok: false };
}

/** Masked proof that OCR saw something, without printing the secret. */
export function describeCandidates(candidates) {
  return (candidates ?? []).length ? `${candidates.length} code mile (••••)` : 'koi 16-char code nahi mila';
}

export function autoIntro() {
  return [
    '📧 *Email auto setup* — 2 cheezein sirf aap kar sakte ho, baaki sab main:',
    '',
    '1️⃣ Browser me Gmail login (agar nahi hai) — Google ka phone-approval 2FA hai, usse koi script bypass nahi kar sakta.',
    '2️⃣ `https://myaccount.google.com/apppasswords` page pe *Create app password* dabao (naam kuch bhi likho).',
    '',
    'Phir bhejo: `/email auto grab`',
    '→ main screen se 16-char code *khud OCR karke padhunga*, Gmail se verify karunga, sealed save karunga. Aapko copy-paste nahi karna.',
    '',
    'Aur bhi automatic chahiye to: `/email auto create` — page khud kholta hai, *Create app password* khud dabata hai, phir code khud padh leta hai.',
    '',
    '_(Code kabhi chat me print nahi hoga — sirf ••••••••.)_',
  ].join('\n');
}
