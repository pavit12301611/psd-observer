// whatsapp-bridge.js — the upgrade path for WhatsApp.
//
// The existing agent (whatsapp-agent/) links the owner's phone and owns every
// WhatsApp rule: owner-only, LID handling, media, voice notes, calls. It should
// keep doing that. What it should *not* have to do is be the only brain.
//
// So PSD exposes an OpenAI-compatible endpoint and a tiny forwarder:
//
//   POST /v1/chat/completions   point LOCAL_API_URL at this and the WhatsApp
//                               agent routes hard tasks straight to PSD's
//                               agents + skills (LM Studio / llama.cpp shape,
//                               so nothing on the agent side needs patching)
//   POST /psd/whatsapp/forward  explicit: run one owner turn here and return
//                               the reply, for callers that want it directly
//
// This is additive: with nothing configured, the agent behaves exactly as it
// does today. With one .env line, WhatsApp gains PSD's skills and tools.

import { shorten } from './tools.js';

/** Tool schemas in the flat shape llama.cpp / LM Studio servers expect. */
function flatTools(tools) {
  return tools.schemas().map((entry) => ({
    type: 'function',
    function: {
      name: entry.function.name,
      description: entry.function.description,
      parameters: entry.function.parameters,
    },
  }));
}

/**
 * Serve POST /v1/chat/completions (+ /v1/models) so any OpenAI-compatible
 * caller — the WhatsApp agent, OpenJarvis, the phone app, curl — can use PSD as
 * its model and inherit its tools, skills and permissions.
 */
export function createOpenAICompat({ router, tools, agents, config, log = console }) {
  async function completions(body) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content
      : Array.isArray(lastUser?.content) ? lastUser.content.map((p) => p.text ?? '').join(' ') : '';
    if (!text.trim()) {
      return {
        id: `chatcmpl-psd-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
        model: body.model || 'psd', choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      };
    }
    const result = await router.turn(text, { source: 'openai-compat', thread: 'openai' });
    return {
      id: `chatcmpl-psd-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'psd',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: result.text ?? '' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      psd: { path: result.path, tools: result.toolsUsed ?? [], ms: result.ms, brain: result.brain ?? null },
    };
  }

  /**
   * Streaming variant. Emits real delta chunks as the model produces them, so a
   * client like the WhatsApp agent shows progress instead of a 20s silence.
   * `write(payload)` receives each SSE payload; the caller frames it.
   */
  async function streamCompletions(body, write, { signal = null } = {}) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content
      : Array.isArray(lastUser?.content) ? lastUser.content.map((p) => p.text ?? '').join(' ') : '';
    const id = `chatcmpl-psd-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const model = body.model || 'psd';
    const chunk = (delta, finish = null) => write({
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });

    chunk({ role: 'assistant', content: '' });
    let streamed = '';
    const result = await router.turn(text, {
      source: 'openai-compat', thread: 'openai', signal,
      onToken: (piece) => { streamed += piece; chunk({ content: piece }); },
    });
    // A deterministic path (intent/quick) produces no tokens: send the answer
    // once so the client is never left with an empty stream.
    if (!streamed && result.text) chunk({ content: result.text });
    chunk({}, 'stop');
    return { ...result, id, model };
  }

  function models() {
    return {
      object: 'list',
      data: [
        { id: 'psd', object: 'model', created: Math.floor(config.startedAt / 1000), owned_by: 'psd', description: `${tools.accessReport().tools} tools, ${agents.skills.length} skills` },
        { id: `${config.agent}`, object: 'model', created: Math.floor(config.startedAt / 1000), owned_by: 'psd' },
      ],
    };
  }

  /** POST /psd/whatsapp/forward — one owner turn, reply text back. */
  async function forward(body) {
    const text = String(body.text ?? body.message ?? '').slice(0, 16_000);
    if (!text.trim()) throw Object.assign(new Error('text is required'), { status: 400 });
    const result = await router.turn(text, { source: 'whatsapp', thread: 'whatsapp' });
    return {
      ok: true,
      text: shorten(result.text ?? '', 3500),
      path: result.path,
      toolsUsed: result.toolsUsed ?? [],
      ms: result.ms,
    };
  }

  return { completions, streamCompletions, models, forward, flatTools };
}
