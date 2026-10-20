// ai.js — the free brain, routed by workload.
//
// Before: a fixed list (Ollama → Groq → Gemini → OpenRouter) and whichever
// answered first won. That meant a 3-second "hi" could wake a 70B model and a
// real question could land on a 1B one.
//
// Now router.js picks the order for every message: the model is chosen by how
// much work the request actually is, prefers the local (free, private) brain,
// escalates only when needed, and puts failing brains on a cooldown so the
// next message does not wait for them again.
//
// Multimodal: photos/screenshots are routed to a model that can actually see
// (local Ollama vision model first, then Gemini), instead of being saved
// without a description.

import { routerFor } from './router.js';

const TIMEOUT_MS = 60_000;

async function postJson(url, body, headers = {}, timeoutMs = TIMEOUT_MS) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(5_000, timeoutMs)),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function systemPrompt(config, store) {
  const facts = Object.entries(store?.data?.facts ?? {}).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  const openTodos = (store?.data?.todos ?? []).filter((t) => !t.done).map((t) => `- ${t.text}`).join('\n');
  return [
    'You are the owner\'s personal WhatsApp assistant, running for free on their own computer as part of Observer.',
    `Owner number: +${config.ownerNumber}. You are chatting as the agent number +${config.agentNumber}.`,
    `Current time: ${new Date().toLocaleString('en-IN', { timeZone: config.timezone })} (${config.timezone}).`,
    'Style: WhatsApp-short. Answer in the owner\'s language — if they write Hinglish, reply in Hinglish; Hindi in Hindi; English in English. Use WhatsApp formatting (*bold*, _italic_) sparingly, never Markdown tables or # headers. No preamble like "As an AI". If you don\'t know, say so briefly.',
    'You also have built-in tools the owner can trigger with slash commands: /remind /todo /note /weather /wiki /define /calc /unit /currency /news /qr /url /system /observer (Observer can see their screen/camera). Mention one only when genuinely relevant.',
    facts ? `Things the owner asked you to remember:\n${facts}` : '',
    openTodos ? `Open to-dos:\n${openTodos}` : '',
  ].filter(Boolean).join('\n\n');
}

// ── one call to one specific model ───────────────────────────────────────────

async function callModel(model, config, messages, timeoutMs = TIMEOUT_MS) {
  if (model.provider === 'ollama') {
    const data = await postJson(`${model.baseUrl || config.ollamaUrl}/api/chat`, {
      model: model.model,
      messages,
      stream: false,
    }, {}, timeoutMs);
    const text = data.message?.content?.trim();
    if (!text) throw new Error('empty Ollama response');
    return { text, provider: model.label, model: model.model };
  }
  if (model.provider === 'local') {
    // llama.cpp's llama-server, LM Studio, vLLM, koboldcpp … all speak this.
    const data = await postJson(`${model.baseUrl}/chat/completions`, {
      model: model.model,
      messages,
      temperature: 0.3,
      stream: false,
    }, { authorization: `Bearer ${model.apiKey || 'local'}` }, timeoutMs);
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('empty local model response');
    return { text, provider: model.label, model: model.model };
  }
  if (model.provider === 'gemini') {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const contents = messages.filter((m) => m.role !== 'system').map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    const data = await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${model.model}:generateContent?key=${config.geminiApiKey}`,
      { contents, ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}) },
      {},
      timeoutMs,
    );
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('').trim();
    if (!text) throw new Error('empty Gemini response');
    return { text, provider: model.label, model: model.model };
  }
  const endpoint = model.provider === 'groq'
    ? { url: 'https://api.groq.com/openai/v1', key: config.groqApiKey }
    : { url: 'https://openrouter.ai/api/v1', key: config.openrouterApiKey };
  const data = await postJson(`${endpoint.url}/chat/completions`, {
    model: model.model,
    messages,
  }, { authorization: `Bearer ${endpoint.key}` }, timeoutMs);
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`empty ${model.provider} response`);
  return { text, provider: model.label, model: model.model };
}

/**
 * Chat with history. Returns { text, provider, model, tier } or null when no
 * brain is reachable.
 */
export async function chat(config, store, userText, log = console) {
  const router = routerFor(config, log);
  const messages = [
    { role: 'system', content: systemPrompt(config, store) },
    ...(store?.data?.history ?? []).slice(-12),
    { role: 'user', content: userText },
  ];
  const plan = router.plan({ text: userText, needsTools: false });
  const started = Date.now();

  for (const model of plan.candidates) {
    const attemptStart = Date.now();
    try {
      const result = await callModel(model, config, messages, config.aiTimeoutMs);
      router.record(model.id, { ok: true, ms: Date.now() - attemptStart, tier: plan.rank });
      router.noteDecision({ text: userText, tier: plan.tier, model: model.id, reason: plan.complexity.reasons.join(', ') });
      store?.pushHistory?.('user', userText);
      store?.pushHistory?.('assistant', result.text);
      return { ...result, tier: plan.tier, ms: Date.now() - started };
    } catch (err) {
      router.record(model.id, { ok: false, ms: Date.now() - attemptStart, tier: plan.rank, error: err.message });
      log.warn?.(`[ai] ${model.label} failed: ${err.message}`);
    }
  }
  return null;
}

/** One-shot completion with no history (summarise / improve / describe). */
export async function complete(config, prompt, log = console) {
  const router = routerFor(config, log);
  const messages = [{ role: 'user', content: prompt }];
  const plan = router.plan({ text: prompt, needsTools: false });
  for (const model of plan.candidates) {
    const attemptStart = Date.now();
    try {
      const result = await callModel(model, config, messages, config.aiTimeoutMs);
      router.record(model.id, { ok: true, ms: Date.now() - attemptStart, tier: plan.rank });
      return result;
    } catch (err) {
      router.record(model.id, { ok: false, ms: Date.now() - attemptStart, tier: plan.rank, error: err.message });
      log.warn?.(`[ai] ${model.label} failed: ${err.message}`);
    }
  }
  return null;
}

// ── multimodal: images ───────────────────────────────────────────────────────

async function visionCall(model, config, prompt, imageBase64, mime = 'image/png') {
  if (model.provider === 'ollama') {
    const data = await postJson(`${model.baseUrl || config.ollamaUrl}/api/chat`, {
      model: model.model,
      stream: false,
      messages: [{ role: 'user', content: prompt, images: [imageBase64] }],
    });
    return data.message?.content?.trim() || null;
  }
  if (model.provider === 'local') {
    // OpenAI-style vision (llama.cpp with an mmproj / unified multimodal GGUF).
    const data = await postJson(`${model.baseUrl}/chat/completions`, {
      model: model.model,
      temperature: 0.2,
      stream: false,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } },
        ],
      }],
    }, { authorization: `Bearer ${model.apiKey || 'local'}` });
    return data.choices?.[0]?.message?.content?.trim() || null;
  }
  if (model.provider === 'gemini') {
    const data = await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${model.model}:generateContent?key=${config.geminiApiKey}`,
      {
        contents: [{
          role: 'user',
          parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: imageBase64 } }],
        }],
      },
    );
    return data.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('').trim() || null;
  }
  return null; // groq/openrouter vision models are not enabled by default
}

/**
 * Describe a photo the owner sent. Local vision model first (private), then
 * Gemini if a key is set. Returns null when nothing can see images.
 */
export async function describeImage(config, imageBase64, caption = '', log = console) {
  const router = routerFor(config, log);
  const prompt = caption
    ? `The owner sent this photo with the caption "${caption}". Answer about the photo, briefly.`
    : 'Describe this photo briefly: what is in it, and read any visible text.';
  const plan = router.plan({ text: caption || 'describe this photo', needsVision: true, needsTools: false });
  for (const model of plan.candidates.filter((m) => m.vision)) {
    const started = Date.now();
    try {
      const text = await visionCall(model, config, prompt, imageBase64);
      if (!text) throw new Error('empty vision response');
      router.record(model.id, { ok: true, ms: Date.now() - started, tier: plan.rank });
      return text;
    } catch (err) {
      router.record(model.id, { ok: false, ms: Date.now() - started, tier: plan.rank, error: err.message });
      log.warn?.(`[ai] vision ${model.label} failed: ${err.message}`);
    }
  }
  return null;
}

/**
 * Ask a LOCAL vision model where a UI element is in an image.
 * Returns the raw model reply (expected: {"x":0-1000,"y":0-1000} or
 * {"found":false}) or null when no vision model is available. Local-only on
 * purpose: screenshots of the owner's screen never leave the PC for this.
 */
export async function locateInImage(config, imageBase64, description, log = console) {
  const VISIONY_MODEL = /llava|vision|vl\b|[-_]vl|moondream|minicpm-v|gemma3|qwen.*vl|llama3\.2-vision/i;
  const model = config.ollamaVisionModel || (VISIONY_MODEL.test(config.ollamaModel ?? '') ? config.ollamaModel : '');
  if (!model) return null;
  try {
    const data = await postJson(`${config.ollamaUrl}/api/chat`, {
      model,
      stream: false,
      messages: [{
        role: 'user',
        content:
          `This is a screenshot of a computer screen. Find the UI element the user wants to click: "${description}". ` +
          'Reply with ONLY a JSON object {"x": <0-1000>, "y": <0-1000>} giving the CENTER of that element in ' +
          '0-to-1000 relative coordinates (x: 0=left edge, 1000=right edge; y: 0=top, 1000=bottom). ' +
          'If the element is not visible, reply with ONLY {"found": false}. No other text.',
        images: [imageBase64],
      }],
    });
    return data.message?.content?.trim() || null;
  } catch (err) {
    log.warn?.(`[ai] vision locate failed: ${err.message}`);
    return null;
  }
}

/** For /model: what brains are configured, and whether they are actually up. */
export async function aiStatus(config) {
  const mode = String(config.aiProvider || 'auto');
  const localOnly = mode === 'local' || mode === 'llamacpp';
  const lines = [`Provider mode: *${mode}*${localOnly ? ' — sirf is PC, koi cloud nahi' : ''}`];

  // llama.cpp / LM Studio / vLLM: the fully-local path.
  if (config.localApiUrl) {
    try {
      const res = await fetch(`${config.localApiUrl}/models`, { signal: AbortSignal.timeout(2_500) });
      const data = res.ok ? await res.json() : null;
      const ids = (data?.data ?? []).map((m) => m.id).filter(Boolean);
      lines.push(`🏠 Local server: ✅ ${config.localApiUrl}${ids.length ? ` — ${ids.join(', ')}` : ''}`);
    } catch {
      lines.push(`🏠 Local server: ❌ not reachable at ${config.localApiUrl}`);
      lines.push('   start it: ./scripts/observer.sh models serve <model>   (or: systemctl --user start observer-model)');
    }
    if (config.localModelSmall) lines.push(`   small: ${config.localModelSmall} @ ${config.localApiUrlSmall || '(unset)'}`);
    if (config.localModelHeavy) lines.push(`   heavy: ${config.localModelHeavy} @ ${config.localApiUrlHeavy || '(unset)'}`);
    if (config.localModelVision) lines.push(`👁️ local vision: ${config.localModelVision}`);
  } else if (localOnly) {
    lines.push('🏠 Local server: ❌ LOCAL_API_URL not set');
    lines.push('   ./scripts/observer.sh models recommend   →   ./scripts/observer.sh models setup <model>');
  }

  // Ollama, unless the owner pinned another mode.
  if (!localOnly && mode !== 'groq' && mode !== 'gemini' && mode !== 'openrouter') {
    try {
      const res = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3_000) });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      const models = (data.models ?? []).map((m) => m.name);
      lines.push(`✅ Ollama running — models: ${models.join(', ') || '(none pulled yet)'}`);
      if (!models.some((m) => m.startsWith(config.ollamaModel))) {
        lines.push(`⬇️ ${config.ollamaModel} isn't pulled yet: \`ollama pull ${config.ollamaModel}\``);
      }
    } catch {
      lines.push(`— Ollama not reachable at ${config.ollamaUrl} (optional if you use llama.cpp or a cloud key)`);
    }
  }

  if (!localOnly) {
    lines.push(config.groqApiKey ? '✅ Groq free-tier key set' : '— Groq key not set (optional)');
    lines.push(config.geminiApiKey ? '✅ Gemini free-tier key set' : '— Gemini key not set (optional)');
    lines.push(config.openrouterApiKey ? '✅ OpenRouter key set' : '— OpenRouter key not set (optional)');
  }
  if (config.ollamaVisionModel && !localOnly) lines.push(`👁️ Ollama vision model: ${config.ollamaVisionModel}`);

  lines.push('', '_/brains shows workload routing + live health. Local guide: LOCAL-MODELS.md_');
  return lines.join('\n');
}

export const NO_BRAIN_HINT =
  '🤖 I\'m online, but no free AI brain is reachable right now, so I can only run built-in tools.\n\n' +
  'For full chat (free, offline): install *Ollama* on this PC → `ollama pull llama3.2` → send me anything.\n' +
  'Meanwhile try: /weather <city>, /remind in 10m <text>, /todo, /wiki <topic>, /calc 45*12 — full list: /help\n' +
  'Status: /brains · diagnose: /doctor';
