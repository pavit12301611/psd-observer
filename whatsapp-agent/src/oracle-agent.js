// Oracle mode deliberately separates deterministic PC commands from chat.
import { parseIntent } from './nlp.js';
import { actionForText } from './oracle-relay.js';

export function createOracleAgent({ sendCommand, askModel }) {
  return {
    async handle(text, ctx = {}) {
      if (ctx.isOwner === false || ctx.guest === true) return '🔒 Owner only.';
      const clean = String(text ?? '').trim();
      if (/^\/help$/i.test(clean)) return 'Oracle mode: /open <app>, /screenshot, /apps, /windows, /pc volume [0-100|up|down|mute], /pc brightness [0-100|up|down]. Normal text is AI chat only; AI cannot control the PC. PC must be online.';
      if (actionForText(clean)) {
        try { return await sendCommand(clean); }
        catch { return '⚠️ PC connector unreachable or timed out. Action may have run; check the PC before retrying.'; }
      }
      if (clean.startsWith('/') || parseIntent(clean)?.cmd) return '⚠️ Unsupported command in Oracle mode. Nothing ran. See /help.';
      if (!clean) return 'Send a message or /help.';
      try {
        const text = await askModel(clean.slice(0, 4000));
        return `💬 AI chat only (no PC action):\n${text}`;
      } catch { return '⚠️ Oracle model unavailable. No PC action was run.'; }
    },
  };
}
