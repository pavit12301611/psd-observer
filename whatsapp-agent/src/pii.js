// pii.js — 🔐 PII/Secret classifier: card numbers (Luhn), Aadhaar, PAN,
// CVV/OTP, API keys, passwords — detect, redact, refuse the strictest tier.
// Pure functions; wired at outbound boundaries (guest replies, /copy
// history, mail digests). Never logs the raw secret.

const RULES = [
  { type: 'card', re: /\b(?:\d[ -]?){13,19}\b/g, strict: true, validate: luhnish },
  { type: 'aadhaar', re: /\b\d{4}(?:[ -]?\d{4}){2,}\b/g, strict: true, validate: (m) => m.replace(/[ -]/g, '').length === 12 },
  { type: 'pan', re: /\b[A-Z]{5}\d{4}[A-Z]\b/g, strict: true },
  { type: 'api_key', re: /\b(?:gsk_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})\b/g, strict: true },
  { type: 'password', re: /(?:password|passwd|pwd|secret|token)\s*[:=]\s*\S{4,}/gi, strict: true },
  { type: 'otp', re: /\b(?:otp|code|verification)(?:\s+is)?\s*[:=]?\s*\d{4,8}\b/gi, strict: false },
  { type: 'cvv', re: /\bcvv\s*[:=]?\s*\d{3,4}\b/gi, strict: true },
  { type: 'bank_acct', re: /\b(?:a\/c|account|acct)\s*(?:no\.?|number)?\s*[:=]?\s*\d{6,18}\b/gi, strict: true },
];

function luhnish(digits) {
  const s = digits.replace(/[ -]/g, '');
  if (s.length < 13 || s.length > 19 || !/^\d+$/.test(s)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = Number(s[i]);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Scan text for PII. Returns {safe, found:[{type, sample, strict}]}. */
export function scanPII(text) {
  const s = String(text ?? '');
  const found = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of s.matchAll(rule.re)) {
      const raw = m[0];
      if (rule.validate && !rule.validate(raw)) continue;
      // Aadhaar regex overlaps plain numbers — require word-ish isolation only
      found.push({ type: rule.type, sample: mask(raw), strict: rule.strict });
      if (found.length >= 20) break;
    }
  }
  return { safe: found.length === 0, found };
}

export function mask(value) {
  const s = String(value ?? '');
  if (s.length <= 4) return '••••';
  return `${s.slice(0, 2)}••••${s.slice(-2)}`;
}

/** Replace every finding with a masked token. */
export function redactPII(text) {
  let out = String(text ?? '');
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, (m) => {
      if (rule.validate && !rule.validate(m)) return m;
      return `[${rule.type} ${mask(m)}]`;
    });
  }
  return out;
}

/**
 * Outbound gate. Returns {allow, reply?}:
 * - strict PII (card/aadhaar/api key) → REFUSE (Duet-classifier rule)
 * - soft PII (otp) → allow but redact copy in history
 */
export function guardOutbound(text, opts = {}) {
  const { mode = 'refuse_strict' } = opts;
  const scan = scanPII(text);
  if (scan.safe) return { allow: true, text, scan };
  const strictHits = scan.found.filter((f) => f.strict);
  if (strictHits.length && mode === 'refuse_strict') {
    return {
      allow: false,
      scan,
      reply: `🔐 *Blocked:* is message me sensitive info hai (${[...new Set(strictHits.map((f) => f.type))].join(', ')}) — card/Aadhaar/API-key jaisi cheezein bahar nahi bhej sakta (safety classifier).`,
    };
  }
  return { allow: true, text: redactPII(text), scan, redacted: true };
}
