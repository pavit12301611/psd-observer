// agentloop.js — real tool-calling agent, free.
//
// Plain WhatsApp text ("mera download folder saaf karo, phir screenshot bhej")
// goes to the free AI with the whole action registry as tools. The model picks
// actions, this loop runs them on the PC, feeds the results back, and repeats
// (up to MAX steps) until it can answer. Destructive actions still stop at the
// owner confirmation gate inside actions.js.
//
// Works with whatever free brain is available:
//   • Ollama (/api/chat tools)      — offline, private, recommended
//   • Groq / OpenRouter (OpenAI-style tools, free tiers)
//   • Gemini (functionDeclarations, free tier)
// No brain reachable → returns null, and commands.js falls back to the offline
// intent parser + built-in tools. The agent never needs a paid API.

const TIMEOUT_MS = 90_000;

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`${res.status} ${detail}`);
  }
  return res.json();
}

function parseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function createAgentLoop({ config, store, actions, log = console }) {
  const maxSteps = Math.max(1, Math.min(Number(config.maxAgentSteps ?? 6) || 6, 12));
  const tools = actions.toolSchemas();
  const enabled = config.agentTools !== false && config.aiProvider !== 'none' && tools.length > 0;
  // Local models have a small context. Sending all 57 tool schemas to a 2k-4k
  // context model hides half of them, so each request gets the relevant ones.
  const ALWAYS = new Set([
    'open_app', 'screenshot', 'look_at_screen', 'system_status', 'send_file',
    'search_files', 'read_file', 'write_file', 'download_url', 'notify',
    'volume', 'media', 'run_shell', 'power',
  ]);

  function toolsFor(text) {
    const query = String(text ?? '').toLowerCase();
    const words = query.split(/[^a-z0-9_]+/).filter((w) => w.length > 2);
    const scored = tools.map((tool) => {
      const haystack = `${tool.name} ${tool.description}`.toLowerCase();
      let score = words.reduce((total, word) => total + (haystack.includes(word) ? 2 : 0), 0);
      if (ALWAYS.has(tool.name)) score += 6;
      return { tool, score };
    });
    scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
    const limit = Math.max(8, Math.min(Number(config.agentToolLimit ?? 20) || 20, tools.length));
    return scored.slice(0, limit).map((entry) => entry.tool);
  }

  function systemPrompt() {
    const facts = Object.values(store.data.facts ?? {}).slice(-20).map((f) => `- ${f}`).join('\n');
    const todos = store.data.todos.filter((t) => !t.done).slice(-10).map((t) => `- ${t.text}`).join('\n');
    return [
      'You are the owner\'s personal assistant, running 100% free on their own Fedora computer (Observer WhatsApp Agent).',
      `Owner: +${config.ownerNumber}. You are on the agent WhatsApp number +${config.agentNumber}.`,
      `Current time: ${new Date().toLocaleString('en-IN', { timeZone: config.timezone })} (${config.timezone}).`,
      'You can actually DO things on the owner\'s computer: open/close apps, control volume/brightness/music, Wi-Fi, Bluetooth, files, screenshots, OCR, typing/clicking, downloads, webcam, screen recording, power, and more — using the tools provided.',
      'Rules:',
      '1. When the owner asks you to DO something, call the tool instead of explaining how to do it.',
      '2. You may call several tools in a row; check each result before deciding the next step.',
      '3. Destructive actions (delete, kill, restart, shutdown, close app, shell) are automatically held for the owner\'s confirmation — just call them, do not ask for permission yourself.',
      '4. If a tool fails, say exactly what failed in one line and, if there is an obvious fix, do it.',
      '5. Reply in the owner\'s language: Hinglish for Hinglish, Hindi for Hindi, English for English. WhatsApp-short, no Markdown tables or # headers, *bold* is fine.',
      '6. Never invent results. If you could not do something, say so.',
      `Access level: ${actions.level()}. Shell: ${config.allowShell ? 'enabled (PIN protected)' : 'disabled'}.`,
      facts ? `Things the owner asked you to remember:\n${facts}` : '',
      todos ? `Open to-dos:\n${todos}` : '',
    ].filter(Boolean).join('\n');
  }

  // ── provider adapters ─────────────────────────────────────────────────────
  // Each returns { text, toolCalls:[{id,name,args}], assistant } and knows how to
  // append its own assistant/tool messages to the conversation.

  function ollamaAdapter(selectedTools) {
    return {
      name: `Ollama · ${config.ollamaModel}`,
      async step(messages) {
        const data = await postJson(`${config.ollamaUrl}/api/chat`, {
          model: config.ollamaModel,
          messages,
          tools: selectedTools,
          stream: false,
          options: { temperature: 0.3, num_ctx: Number(config.ollamaNumCtx ?? 8192) || 8192 },
        });
        const msg = data.message ?? {};
        return {
          text: (msg.content ?? '').trim(),
          toolCalls: (msg.tool_calls ?? []).map((call, i) => ({
            id: call.id ?? `call_${i}`,
            name: call.function?.name,
            args: parseArgs(call.function?.arguments),
          })).filter((c) => c.name),
          assistant: { role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls ?? [] },
        };
      },
      appendTool(messages, call, content) {
        return [...messages, { role: 'tool', content, tool_name: call.name }];
      },
    };
  }

  function openAiAdapter({ url, key, model, label }, selectedTools) {
    const openAiTools = selectedTools.map((t) => ({ type: 'function', function: t }));
    return {
      name: `${label} · ${model}`,
      async step(messages) {
        const data = await postJson(`${url}/chat/completions`, {
          model,
          messages,
          tools: openAiTools,
          tool_choice: 'auto',
          temperature: 0.3,
        }, { authorization: `Bearer ${key}` });
        const msg = data.choices?.[0]?.message ?? {};
        return {
          text: (msg.content ?? '').trim(),
          toolCalls: (msg.tool_calls ?? []).map((call) => ({
            id: call.id,
            name: call.function?.name,
            args: parseArgs(call.function?.arguments),
          })).filter((c) => c.name),
          assistant: msg,
        };
      },
      appendTool(messages, call, content) {
        return [...messages, { role: 'tool', tool_call_id: call.id, content }];
      },
    };
  }

  function geminiAdapter(selectedTools) {
    const declarations = selectedTools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    // Gemini wants its own contents array; convert once and keep growing it.
    return {
      name: `Gemini · ${config.geminiModel}`,
      usesContents: true,
      async step(_messages, contents) {
        const data = await postJson(
          `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${config.geminiApiKey}`,
          {
            contents,
            tools: [{ functionDeclarations: declarations }],
            systemInstruction: { parts: [{ text: systemPrompt() }] },
            generationConfig: { temperature: 0.3 },
          },
        );
        const parts = data.candidates?.[0]?.content?.parts ?? [];
        const calls = parts.filter((p) => p.functionCall).map((p, i) => ({
          id: `gemini_${i}_${Date.now()}`,
          name: p.functionCall.name,
          args: p.functionCall.args ?? {},
        }));
        const text = parts.filter((p) => p.text).map((p) => p.text).join('').trim();
        return { text, toolCalls: calls, assistant: { role: 'model', parts } };
      },
      appendTool(_messages, call, content) {
        // handled by the loop for Gemini (see appendGeminiTool)
        return null;
      },
      contentsStart(text) {
        return [{ role: 'user', parts: [{ text }] }];
      },
      appendAssistant(contents, assistant) {
        return [...contents, assistant];
      },
      appendToolResult(contents, call, content) {
        return [...contents, { role: 'user', parts: [{ functionResponse: { name: call.name, response: { result: content } } }] }];
      },
    };
  }

  function providers(selectedTools) {
    const want = config.aiProvider;
    const all = [
      { id: 'ollama', make: () => ollamaAdapter(selectedTools) },
      ...(config.groqApiKey ? [{ id: 'groq', make: () => openAiAdapter({ url: 'https://api.groq.com/openai/v1', key: config.groqApiKey, model: config.groqModel, label: 'Groq (free tier)' }, selectedTools) }] : []),
      ...(config.geminiApiKey ? [{ id: 'gemini', make: () => geminiAdapter(selectedTools) }] : []),
      ...(config.openrouterApiKey ? [{ id: 'openrouter', make: () => openAiAdapter({ url: 'https://openrouter.ai/api/v1', key: config.openrouterApiKey, model: config.openrouterModel, label: 'OpenRouter (free model)' }, selectedTools) }] : []),
    ];
    return want && want !== 'auto' ? all.filter((p) => p.id === want) : all;
  }

  /**
   * Run the loop. Returns a reply (string or {text,image,document,video}), or
   * null when no provider worked (caller falls back to plain chat).
   */
  async function run(text, ctx = {}) {
    if (!enabled) return null;
    const selectedTools = toolsFor(text);
    for (const providerEntry of providers(selectedTools)) {
      let provider;
      try { provider = providerEntry.make(); } catch { continue; }
      try {
        const base = [{ role: 'system', content: systemPrompt() }, { role: 'user', content: String(text) }];
        let messages = provider.usesContents ? null : base;
        let contents = provider.usesContents ? provider.contentsStart(String(text)) : null;
        let attachments = [];

        for (let step = 0; step < maxSteps; step++) {
          const result = provider.usesContents ? await provider.step(messages, contents) : await provider.step(messages);

          if (result.toolCalls?.length) {
            if (provider.usesContents) {
              contents = provider.appendAssistant(contents, result.assistant);
            } else {
              messages = [...messages, result.assistant];
            }
            let confirmation = null;
            for (const call of result.toolCalls) {
              const outcome = await actions.execute(call.name, call.args, { ...ctx, source: 'ai' });
              const clipped = String(outcome.text ?? '').slice(0, 2500) || '(done)';
              if (provider.usesContents) contents = provider.appendToolResult(contents, call, clipped);
              else messages = provider.appendTool(messages, call, clipped);

              if (outcome.image || outcome.document || outcome.video) {
                attachments.push({ image: outcome.image, document: outcome.document, video: outcome.video, text: outcome.text });
              }
              if (outcome.needsConfirmation) confirmation = outcome;
              if (outcome.ok === false && !outcome.needsConfirmation) {
                log.info?.(`[agent] tool ${call.name} failed: ${String(outcome.text).slice(0, 160)}`);
              }
            }
            if (confirmation) return confirmation.text;
            continue;
          }

          const answer = result.text || '✅ Done.';
          if (attachments.length) {
            const first = attachments[0];
            return { text: answer, image: first.image, document: first.document, video: first.video };
          }
          return answer;
        }
        if (attachments.length) {
          const first = attachments[0];
          return { text: '✅ Done — here is the result.', image: first.image, document: first.document, video: first.video };
        }
        return '🤖 I did several steps but couldn\'t finish. Try saying it more specifically (e.g. "/open chrome" or "/pc screenshot").';
      } catch (err) {
        log.warn?.(`[agent] ${provider.name} failed: ${err.message}`);
        // try the next free provider
      }
    }
    return null;
  }

  return { run, enabled, toolCount: tools.length, toolsFor };
}
