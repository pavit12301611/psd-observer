// voicereply.js — 🎤 Voice ka jawab voice me: owner voice note bheje to bot
// bhi bole (same language vibe). Decision pure — sending injected.

export function shouldVoiceReply(ctx = {}, opts = {}) {
  const { enabled = true } = opts;
  if (!enabled) return false;
  if (ctx?.voice === true || ctx?.fromVoice === true) return true;
  if (ctx?.ptt === true) return true; // WhatsApp voice-note flag
  return false;
}

/**
 * Make the voice reply payload. `speak(text)` returns {audio, mimetype}
 * (injected — prod: tts engine). Falls back to text on failure.
 */
export async function voiceReply(reply, opts = {}) {
  const { speak, ctx = {}, enabled = true, maxChars = 900 } = opts;
  if (!shouldVoiceReply(ctx, { enabled })) return { text: reply };
  if (typeof speak !== 'function') return { text: reply };
  const spoken = String(reply ?? '').replace(/[*_`#>]/g, '').slice(0, maxChars);
  try {
    const out = await speak(spoken);
    if (out?.audio) return { audio: out.audio, mimetype: out.mimetype ?? 'audio/ogg', text: reply };
    return { text: reply };
  } catch {
    return { text: reply };
  }
}
