// Oracle mode deliberately separates deterministic PC commands from chat.

export function createOracleAgent({ sendCommand, askModel }) {
  return {
    async handle(text, ctx = {}) {
      if (ctx.isOwner === false || ctx.guest === true) return '🔒 Owner only.';
      const clean = String(text ?? '').trim();
      if (clean.startsWith('/')) {
        try { return await sendCommand(clean); }
        catch { return '⚠️ PC connector unreachable or timed out. Action may have run; check the PC before retrying.'; }
      }
      if (!clean) return 'Send a message or /help.';
      if (clean.length > 16000) return '⚠️ Message too long; send at most 16000 characters.';
      try {
        const text = await askModel(clean);
        return text;
      } catch { return '⚠️ Oracle model unavailable. No PC action was run.'; }
    },
  };
}
