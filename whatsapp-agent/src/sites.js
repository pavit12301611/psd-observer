// sites.js — what the agent knows about specific websites.
//
// The important fact: every modern chat site (Arena, ChatGPT, Claude, Gemini,
// Perplexity …) focuses its composer the moment the page loads. You do NOT
// click the box first — you just type and press Enter. Blind-clicking a
// screenshot looked like the safe thing to do and was the opposite: OCR picks
// the wrong "Send", or the click lands on a sidebar and the text goes nowhere.
//
// So a site profile says:
//   autofocus → type straight away, no click step (and skip any composer tap
//               an AI plan may have invented)
//   readyMs   → how long the page usually needs before the box takes input
//   composer  → labels that mean "this is the message box", so a tap aimed at
//               the composer can be recognised and skipped
//
// A profile is decoration, not a guarantee: the executor still verifies what it
// can and reports `unverified` when it cannot.

export const SITES = [
  { host: 'arena.ai', name: 'Arena', autofocus: true, readyMs: 3_500 },
  { host: 'lmarena.ai', name: 'LMArena', autofocus: true, readyMs: 3_500 },
  { host: 'chatgpt.com', name: 'ChatGPT', autofocus: true, readyMs: 3_000 },
  { host: 'chat.openai.com', name: 'ChatGPT', autofocus: true, readyMs: 3_000 },
  { host: 'claude.ai', name: 'Claude', autofocus: true, readyMs: 3_000 },
  { host: 'gemini.google.com', name: 'Gemini', autofocus: true, readyMs: 3_500 },
  { host: 'aistudio.google.com', name: 'AI Studio', autofocus: true, readyMs: 3_500 },
  { host: 'chat.deepseek.com', name: 'DeepSeek', autofocus: true, readyMs: 3_000 },
  { host: 'chat.mistral.ai', name: 'Le Chat', autofocus: true, readyMs: 3_000 },
  { host: 'grok.com', name: 'Grok', autofocus: true, readyMs: 3_000 },
  { host: 'www.perplexity.ai', name: 'Perplexity', autofocus: true, readyMs: 3_000 },
  { host: 'perplexity.ai', name: 'Perplexity', autofocus: true, readyMs: 3_000 },
  { host: 'kimi.com', name: 'Kimi', autofocus: true, readyMs: 3_000 },
  { host: 'www.kimi.com', name: 'Kimi', autofocus: true, readyMs: 3_000 },
  { host: 'poe.com', name: 'Poe', autofocus: true, readyMs: 3_000 },
  { host: 'copilot.microsoft.com', name: 'Copilot', autofocus: true, readyMs: 3_500 },
  { host: 'chat.qwen.ai', name: 'Qwen Chat', autofocus: true, readyMs: 3_000 },
  { host: 'you.com', name: 'You.com', autofocus: true, readyMs: 3_000 },
  { host: 'huggingface.co', name: 'Hugging Face', autofocus: false, readyMs: 2_500 },
];

// Labels that mean "the message box" on a chat page.
export const COMPOSER_LABELS = /^(message|message box|prompt|prompt box|ask anything|ask a question|input|text box|chat box|send a message|type a message|what would you like to do|composer|query)$/i;

/** Hostname without `www.`, lower-case, or '' when the input is not a URL. */
export function hostOf(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
    return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Profile for a URL/hostname (exact or sub-domain match), else null. */
export function siteFor(input) {
  const host = hostOf(input);
  if (!host) return null;
  const bare = host.replace(/^www\./, '');
  return SITES.find((site) => {
    const want = site.host.replace(/^www\./, '');
    return bare === want || bare.endsWith(`.${want}`);
  }) ?? null;
}

/** Does this URL open with the composer already focused? */
export function autoFocusFor(input) {
  return Boolean(siteFor(input)?.autofocus);
}

/** How long to wait after opening before typing into this site. */
export function readyMsFor(input, fallback = 2_500) {
  return siteFor(input)?.readyMs ?? fallback;
}

/** Would a tap/click on this label be the composer we do not need to click? */
export function isComposerLabel(label) {
  return COMPOSER_LABELS.test(String(label ?? '').trim());
}

/** One line for /help and messages. */
export function describeSite(input) {
  const site = siteFor(input);
  if (!site) return null;
  return site.autofocus
    ? `${site.name}: message box already focused — type karo aur Enter, click ki zaroorat nahi`
    : site.name;
}
