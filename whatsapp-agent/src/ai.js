// ai.js — the free brain. Priority in "auto" mode:
//   1. Ollama on this PC           (100% free, offline, private — recommended)
//   2. Groq free tier               (only if GROQ_API_KEY is set)
//   3. Gemini free tier             (only if GEMINI_API_KEY is set)
//   4. OpenRouter free models       (only if OPENROUTER_API_KEY is set)
// If none answer, chat() returns null and commands.js falls back to offline
// tools + a short "install Ollama" hint. The agent never *requires* a key.

const TIMEOUT_MS = 60_000;

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function systemPrompt(config, store) {
  const facts = Object.entries(store.data.facts ?? {}).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  const openTodos = store.data.todos.filter((t) => !t.done).map((t) => `- ${t.text}`).join('\n');
  return [
    `You are the owner's personal WhatsApp assistant, running for free on their own computer as part of Observer.`,
    `Owner number: +${config.ownerNumber}. You are chatting as the agent number +${config.agentNumber}.`,
    `Current time: ${new Date().toLocaleString('en-IN', { timeZone: config.timezone })} (${config.timezone}).`,
    `Style: WhatsApp-short. Answer in the owner's language — if they write Hinglish, reply in Hinglish; Hindi in Hindi; English in English. Use WhatsApp formatting (*bold*, _italic_) sparingly, never Markdown tables or # headers. No preamble like "As an AI". If you don't know, say so briefly.`,
    `You also have built-in tools the owner can trigger with slash commands: /remind /todo /note /weather /wiki /define /calc /unit /currency /news /qr /url /system /observer (Observer can see their screen/camera). Mention one only when genuinely relevant.`,
    facts ? `Things the owner asked you to remember:\n${facts}` : '',
    openTodos ? `Open to-dos:\n${openTodos}` : '',
  ].filter(Boolean).join('\n\n');
}

async function ollamaChat(config, messages) {
  const data = await postJson(`${config.ollamaUrl}/api/chat`, {
    model: config.ollamaModel,
    messages,
    stream: false,
  });
  const text = data.message?.content?.trim();
  if (!text) throw new Error('empty Ollama response');
  return { text, provider: `Ollama · ${config.ollamaModel}` };
}

async function openAiCompatible({ url, key, model, label }, messages) {
  const data = await postJson(`${url}/chat/completions`, { model, messages }, { authorization: `Bearer ${key}` });
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`empty ${label} response`);
  return { text, provider: `${label} · ${model}` };
}

async function geminiChat(config, messages) {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const contents = messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const data = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${config.geminiApiKey}`,
    { contents, ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}) },
  );
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('').trim();
  if (!text) throw new Error('empty Gemini response');
  return { text, provider: `Gemini · ${config.geminiModel}` };
}

function providersFor(config, messages) {
  const all = {
    ollama: () => ollamaChat(config, messages),
    groq: config.groqApiKey ? () => openAiCompatible({ url: 'https://api.groq.com/openai/v1', key: config.groqApiKey, model: config.groqModel, label: 'Groq (free tier)' }, messages) : null,
    gemini: config.geminiApiKey ? () => geminiChat(config, messages) : null,
    openrouter: config.openrouterApiKey ? () => openAiCompatible({ url: 'https://openrouter.ai/api/v1', key: config.openrouterApiKey, model: config.openrouterModel, label: 'OpenRouter (free model)' }, messages) : null,
  };
  if (config.aiProvider === 'none') return [];
  if (config.aiProvider !== 'auto') {
    const only = all[config.aiProvider];
    return only ? [[config.aiProvider, only]] : [];
  }
  return Object.entries(all).filter(([, fn]) => fn);
}

/** Chat with history. Returns {text, provider} or null when no brain is reachable. */
export async function chat(config, store, userText, log = console) {
  const messages = [
    { role: 'system', content: systemPrompt(config, store) },
    ...store.data.history.slice(-12),
    { role: 'user', content: userText },
  ];
  for (const [name, fn] of providersFor(config, messages)) {
    try {
      const result = await fn();
      store.pushHistory('user', userText);
      store.pushHistory('assistant', result.text);
      return result;
    } catch (err) {
      log.warn?.(`[ai] ${name} failed: ${err.message}`);
    }
  }
  return null;
}

/** One-shot completion with no history (summarise / improve / describe). */
export async function complete(config, prompt, log = console) {
  const messages = [{ role: 'user', content: prompt }];
  for (const [name, fn] of providersFor(config, messages)) {
    try {
      return await fn();
    } catch (err) {
      log.warn?.(`[ai] ${name} failed: ${err.message}`);
    }
  }
  return null;
}

/** Describe an image with a local Ollama vision model (OLLAMA_VISION_MODEL). Null if not set up. */
export async function describeImage(config, imageBase64, caption = '', log = console) {
  if (!config.ollamaVisionModel) return null;
  try {
    const data = await postJson(`${config.ollamaUrl}/api/chat`, {
      model: config.ollamaVisionModel,
      stream: false,
      messages: [{
        role: 'user',
        content: caption ? `The owner sent this photo with the caption "${caption}". Answer about the photo, briefly.` : 'Describe this photo briefly: what is in it, and read any visible text.',
        images: [imageBase64],
      }],
    });
    return data.message?.content?.trim() || null;
  } catch (err) {
    log.warn?.(`[ai] vision failed: ${err.message}`);
    return null;
  }
}

/** For /model: what brains are configured, and whether Ollama is actually up. */
export async function aiStatus(config) {
  const lines = [`Provider mode: *${config.aiProvider}*`];
  try {
    const res = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const models = (data.models ?? []).map((m) => m.name);
    lines.push(`✅ Ollama is running locally — models: ${models.join(', ') || '(none pulled yet)'}`);
    if (!models.some((m) => m.startsWith(config.ollamaModel))) {
      lines.push(`⬇️ Your configured model ${config.ollamaModel} isn't pulled yet: \`ollama pull ${config.ollamaModel}\``);
    }
  } catch {
    lines.push(`❌ Ollama not reachable at ${config.ollamaUrl} (install free from ollama.com, then \`ollama pull ${config.ollamaModel}\`)`);
  }
  lines.push(config.groqApiKey ? '✅ Groq free-tier key set' : '— Groq key not set (optional)');
  lines.push(config.geminiApiKey ? '✅ Gemini free-tier key set' : '— Gemini key not set (optional)');
  lines.push(config.openrouterApiKey ? '✅ OpenRouter key set' : '— OpenRouter key not set (optional)');
  lines.push(config.ollamaVisionModel ? `👁️ Vision model: ${config.ollamaVisionModel}` : '👁️ No vision model set (OLLAMA_VISION_MODEL) — photos are saved but not described');
  return lines.join('\n');
}

export const NO_BRAIN_HINT =
  '🤖 I\'m online, but no free AI brain is reachable right now, so I can only run built-in tools.\n\n' +
  'For full chat (free, offline): install *Ollama* on this PC → `ollama pull llama3.2` → send me anything.\n' +
  'Meanwhile try: /weather <city>, /remind in 10m <text>, /todo, /wiki <topic>, /calc 45*12 — full list: /help';
