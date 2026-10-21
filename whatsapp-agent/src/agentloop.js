// agentloop.js — real tool-calling agent, free, routed by workload.
//
// Plain WhatsApp text ("mera download folder saaf karo, phir screenshot bhej")
// goes to a free AI with the action registry as tools. The model picks
// actions, this loop runs them on the PC, feeds results back, and repeats
// until it can answer. Destructive actions still stop at the owner
// confirmation gate inside actions.js.
//
// What changed in 2.1:
//   • The model is chosen per request by router.js (tiny task → small/fast
//     model, heavy task → the biggest free model available). No more "always
//     the same 70B model for a one-liner".
//   • Step and tool budgets follow the task size, so small jobs don't get a
//     10-step allowance.
//   • If a model fails, returns nothing, or gives up, the next (bigger) brain
//     is tried automatically. A dead Ollama no longer blocks WhatsApp.
//   • A repeated identical tool call is detected instead of looping until the
//     step limit.
//   • The loop reports what actually happened (model, tier, tool count) via
//     `lastRun`, so /agent can prove it did work instead of guessing.

import { routerFor } from './router.js';
import { throwIfStopped, isStoppedError } from './cancel.js';
import { personaLines } from './jarvis.js';

const DEFAULT_TIMEOUT_MS = 90_000;

async function postJson(url, body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, outerSignal = null) {
  const timeout = AbortSignal.timeout(Math.max(5_000, timeoutMs));
  const signal = outerSignal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([timeout, outerSignal])
    : outerSignal ?? timeout;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
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

// A model that did not call a single tool must not be believed when it says
// "ho gaya". This is the exact bug owners reported with /agent.
const SUCCESS_CLAIM = /\b(ho\s*gaya|ho\s*gya|kar\s*diya|kar\s*di|khol\s*diya|khul\s*gaya|bhej\s*diya|bana\s*diya|save\s*kar\s*diya|done|opened|launched|completed|finished|sent|saved|✅)/i;

const clip = (text, max = 2500) => {
  const value = String(text ?? '');
  return (value.length > max ? `${value.slice(0, max)}…` : value) || '(done)';
};

export function createAgentLoop({ config = {}, store, actions, log = console }) {
  const router = routerFor(config, log);
  const allTools = actions.toolSchemas();
  const enabled = config.agentTools !== false && config.aiProvider !== 'none' && allTools.length > 0;
  const timeoutMs = Math.max(5_000, Number(config.aiTimeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);

  // Local models have a small context. Sending all 57 tool schemas to a 2k-4k
  // context model hides half of them, so each request gets the relevant ones.
  const ALWAYS = new Set([
    'open_app', 'screenshot', 'look_at_screen', 'system_status', 'send_file',
    'search_files', 'read_file', 'write_file', 'download_url', 'notify',
    'volume', 'media', 'run_shell', 'power', 'list_windows', 'focus_window',
    // The "hands" loop is the one tool that can finish visual tasks, so it is
    // always offered — even to a small local model with a tight tool budget.
    'computer_use',
  ]);

  function toolsFor(text, { limit } = {}) {
    const query = String(text ?? '').toLowerCase();
    const words = query.split(/[^a-z0-9_]+/).filter((w) => w.length > 2);
    const scored = allTools.map((tool) => {
      const haystack = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
      let score = words.reduce((total, word) => total + (haystack.includes(word) ? 2 : 0), 0);
      if (ALWAYS.has(tool.name)) score += 6;
      return { tool, score };
    });
    scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
    const configured = Math.max(8, Math.min(Number(config.agentToolLimit ?? 20) || 20, allTools.length));
    const wanted = Math.max(8, Math.min(Number(limit ?? configured) || configured, allTools.length));
    return scored.slice(0, wanted).map((entry) => entry.tool);
  }

  function systemPrompt(plan, ctx = {}) {
    const facts = Object.values(store?.data?.facts ?? {}).slice(-20).map((f) => `- ${f}`).join('\n');
    const todos = (store?.data?.todos ?? []).filter((t) => !t.done).slice(-10).map((t) => `- ${t.text}`).join('\n');
    return [
      'You are the owner\'s personal assistant, running 100% free on their own Fedora computer (Observer WhatsApp Agent).',
      ...personaLines(config, { voice: Boolean(ctx.voice) }),
      ctx.voice ? 'The owner is speaking to you on a live VOICE CALL right now and is listening for your spoken reply. Prefer speak_text only when explicitly asked to read/announce something; otherwise your final text is spoken automatically.' : '',
      `Owner: +${config.ownerNumber}. You are on the agent WhatsApp number +${config.agentNumber}.`,
      `Current time: ${new Date().toLocaleString('en-IN', { timeZone: config.timezone ?? 'Asia/Kolkata' })} (${config.timezone ?? 'Asia/Kolkata'}).`,
      'You can actually DO things on the owner\'s computer: open/close apps, control volume/brightness/music, Wi-Fi, Bluetooth, files, screenshots, OCR, typing/clicking, downloads, webcam, screen recording, power, and more — using the tools provided.',
      'For anything that needs the GUI (a website, a video, an app setting, a dialog), call computer_use with a clear task: it looks at the screen, clicks/types like a human, and looks again. Do not describe how the owner could do it — do it.',
      'Rules:',
      '1. When the owner asks you to DO something, call the tool instead of explaining how to do it.',
      '2. You may call several tools in a row; check each result before deciding the next step.',
      '3. Destructive actions (delete, kill, restart, shutdown, close app, shell) are automatically held for the owner\'s confirmation — just call them, do not ask for permission yourself.',
      '4. If a tool fails, say exactly what failed in one line and, if there is an obvious fix, do it. Never repeat the exact same failing call.',
      '5. Reply in the owner\'s language: Hinglish for Hinglish, Hindi for Hindi, English for English. WhatsApp-short, no Markdown tables or # headers, *bold* is fine.',
      '6. Never invent results. If you could not do something, say so.',
      '7. Never claim you opened/launched/closed an app unless the open_app/close_app tool just returned success. If it failed, report the tool error verbatim — do not say "open ho gaya".',
      '8. Do not take a screenshot at the end unless the owner asked for one or it is the proof they need.',
      `This request was sized as *${plan.tier}* (${plan.complexity?.reasons?.join(', ') || 'simple ask'}); you have ${plan.maxSteps} steps. Be efficient: the fewest tool calls that finish the job.`,
      `Access level: ${actions.level?.() ?? 'full'}. Shell: ${config.allowShell ? 'enabled (PIN protected)' : 'disabled'}.`,
      facts ? `Things the owner asked you to remember:\n${facts}` : '',
      todos ? `Open to-dos:\n${todos}` : '',
    ].filter(Boolean).join('\n');
  }

  // ── provider adapters ─────────────────────────────────────────────────────
  // Each returns { text, toolCalls:[{id,name,args}], assistant } and knows how to
  // append its own assistant/tool messages to the conversation.

  function ollamaAdapter(model, selectedTools, signal) {
    return {
      name: model.label,
      async step(messages) {
        const data = await postJson(`${model.baseUrl || config.ollamaUrl}/api/chat`, {
          model: model.model,
          messages,
          tools: selectedTools,
          stream: false,
          options: { temperature: 0.3, num_ctx: Number(config.ollamaNumCtx ?? 8192) || 8192 },
        }, {}, timeoutMs, signal);
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

  function openAiAdapter(model, selectedTools, signal) {
    const base = {
      groq: { url: config.groqBaseUrl || 'https://api.groq.com/openai/v1', key: config.groqApiKey },
      openrouter: { url: config.openrouterBaseUrl || 'https://openrouter.ai/api/v1', key: config.openrouterApiKey },
      // Local llama.cpp / LM Studio / vLLM: no account, no quota, no network.
      local: { url: model.baseUrl, key: model.apiKey || config.localApiKey || 'local' },
    }[model.provider];
    if (!base) throw new Error(`unknown OpenAI-compatible provider ${model.provider}`);
    const openAiTools = selectedTools.map((t) => ({ type: 'function', function: t }));
    return {
      name: model.label,
      async step(messages) {
        const data = await postJson(`${base.url}/chat/completions`, {
          model: model.model,
          messages,
          tools: openAiTools,
          tool_choice: 'auto',
          temperature: 0.3,
        }, { authorization: `Bearer ${base.key}` }, timeoutMs, signal);
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

  function geminiAdapter(model, selectedTools, runPlan, signal) {
    const declarations = selectedTools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    return {
      name: model.label,
      usesContents: true,
      async step(_messages, contents) {
        const data = await postJson(
          `https://generativelanguage.googleapis.com/v1beta/models/${model.model}:generateContent?key=${config.geminiApiKey}`,
          {
            contents,
            tools: [{ functionDeclarations: declarations }],
            systemInstruction: { parts: [{ text: systemPrompt(runPlan) }] },
            generationConfig: { temperature: 0.3 },
          },
          {},
          timeoutMs,
          signal,
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
      appendTool() { return null; }, // handled by the loop for Gemini
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

  function makeAdapter(model, selectedTools, runPlan, signal) {
    if (model.provider === 'ollama') return ollamaAdapter(model, selectedTools, signal);
    if (model.provider === 'gemini') return geminiAdapter(model, selectedTools, runPlan, signal);
    return openAiAdapter(model, selectedTools, signal);
  }

  // ── one run with one model ───────────────────────────────────────────────

  async function runWithModel(model, text, ctx, plan, opts = {}) {
    const selectedTools = toolsFor(text, { limit: plan.toolLimit });
    const adapter = makeAdapter(model, selectedTools, plan, opts.signal);

    let messages = adapter.usesContents ? null : [
      { role: 'system', content: systemPrompt(plan, ctx) },
      { role: 'user', content: String(text) },
    ];
    let contents = adapter.usesContents ? adapter.contentsStart(String(text)) : null;

    const attachments = [];
    const callCounts = new Map();
    let toolCalls = 0;
    let didWork = false;
    let nudged = false;
    let stepsUsed = 0;
    let lastText = '';
    const maxSteps = Math.max(1, Math.min(Number(opts.maxSteps ?? plan.maxSteps) || 1, 12));
    const pack = (reply) => ({ reply, toolCalls, stepsUsed });

    for (let step = 0; step < maxSteps; step++) {
      throwIfStopped(opts.signal, 'Agent');
      stepsUsed = step + 1;
      let result;
      try {
        result = adapter.usesContents ? await adapter.step(messages, contents) : await adapter.step(messages);
      } catch (err) {
        if (isStoppedError(err) || opts.signal?.aborted) throw err;
        throw err;
      }
      lastText = result.text || lastText;

      if (result.toolCalls?.length) {
        if (adapter.usesContents) contents = adapter.appendAssistant(contents, result.assistant);
        else messages = [...messages, result.assistant];

        let confirmation = null;
        for (const call of result.toolCalls) {
          throwIfStopped(opts.signal, 'Agent');
          const signature = `${call.name}:${JSON.stringify(call.args ?? {})}`;
          const times = (callCounts.get(signature) ?? 0) + 1;
          callCounts.set(signature, times);

          if (times > 2) {
            // Small models love to repeat the same call. Feed the previous
            // outcome back and move on instead of burning every step.
            const note = 'You already called this exact tool with these arguments. Its result is above — use it, do not repeat.';
            if (adapter.usesContents) contents = adapter.appendToolResult(contents, call, note);
            else messages = adapter.appendTool(messages, call, note);
            continue;
          }

          toolCalls += 1;
          const outcome = await actions.execute(call.name, call.args, { ...ctx, source: 'ai' });
          const textOut = clip(outcome.text);
          if (adapter.usesContents) contents = adapter.appendToolResult(contents, call, textOut);
          else messages = adapter.appendTool(messages, call, textOut);

          if (outcome.ok !== false) didWork = true;
          if (outcome.image || outcome.document || outcome.video) {
            attachments.push({ image: outcome.image, document: outcome.document, video: outcome.video, text: outcome.text });
          }
          if (outcome.needsConfirmation) confirmation = outcome;
          if (outcome.ok === false && !outcome.needsConfirmation) {
            log.info?.(`[agent] tool ${call.name} failed: ${String(outcome.text).slice(0, 160)}`);
          }
        }
        if (confirmation) return pack({ text: confirmation.text });
        continue;
      }

      // Guard against "kuch kiye bina hi done bol diya": one corrective turn.
      if (opts.nudge && !nudged && toolCalls === 0 && plan.complexity?.needsTools) {
        nudged = true;
        const nudge = 'You did not call any tool. If the owner asked you to DO something on the computer, call the right tool now instead of saying it is done. If this is only a question, answer it normally.';
        if (adapter.usesContents) contents = [...contents, { role: 'user', parts: [{ text: nudge }] }];
        else messages = [...messages, { role: 'user', content: nudge }];
        continue;
      }

      const answer = (result.text ?? '').trim();
      if (!answer && !didWork) return pack(null); // empty answer + no work → escalate
      const finalText = answer || '✅ Done.';
      if (attachments.length) {
        const images = attachments.filter((a) => a.image).map((a) => a.image);
        const first = attachments[0];
        const spoken = attachments.find((a) => a.audio);
        return pack({
          text: finalText,
          image: images[0] ?? first.image,
          extraImages: images.slice(1),
          document: first.document,
          video: first.video,
          audio: spoken?.audio,
          mimetype: spoken?.mimetype,
          ptt: spoken?.ptt,
        });
      }
      return pack(finalText);
    }

    // Ran out of steps.
    if (attachments.length) {
      const images = attachments.filter((a) => a.image).map((a) => a.image);
      return pack({
        text: lastText || '✅ Steps complete.',
        image: images[0] ?? attachments[0].image,
        extraImages: images.slice(1),
      });
    }
    if (didWork) return pack(lastText || '✅ Done.');
    return pack(null); // no progress → let a bigger model try
  }

  // ── public run ───────────────────────────────────────────────────────────

  let lastRun = null;

  /**
   * Run the tool loop. Returns a reply (string or {text,image,…}), or null
   * when no brain could do the job (caller falls back to plain chat/offline).
   */
  async function run(text, ctx = {}, opts = {}) {
    if (!enabled) {
      lastRun = { ok: false, reason: 'agent tools disabled', model: null, tier: null };
      return null;
    }
    const plan = router.plan({
      text,
      needsTools: opts.needsTools ?? true,
      minTier: opts.minTier,
      forceTier: opts.forceTier,
      maxSteps: opts.maxSteps,
      toolLimit: opts.toolLimit,
    });

    const started = Date.now();
    const attempts = plan.candidates.slice(0, Math.max(1, Math.min(Number(opts.maxTries ?? 3), 4)));
    if (!attempts.length) {
      lastRun = { ok: false, reason: plan.notes.join(' · ') || 'no brain available', tier: plan.tier, model: null, plan };
      return null;
    }

    const effectivePlan = opts.nudge ? { ...plan, maxSteps: Math.max(plan.maxSteps, 3) } : plan;

    for (const model of attempts) {
      const attemptStart = Date.now();
      try {
        throwIfStopped(opts.signal, 'Agent');
        const attempt = await runWithModel(model, text, ctx, effectivePlan, opts);
        const ms = Date.now() - attemptStart;
        if (!attempt || attempt.reply == null) {
          router.record(model.id, { ok: false, ms, tier: plan.rank, error: 'no usable reply' });
          continue;
        }
        router.record(model.id, { ok: true, ms, tier: plan.rank });

        // Actionable task + zero tool calls + a success claim = fabricated.
        const claimedText = typeof attempt.reply === 'string' ? attempt.reply : attempt.reply?.text ?? '';
        if (
          opts.nudge
          && attempt.toolCalls === 0
          && plan.complexity?.needsTools
          && claimedText.length < 240 // long answers are explanations, not claims
          && SUCCESS_CLAIM.test(claimedText)
        ) {
          lastRun = {
            ok: false,
            model: model.label,
            tier: plan.tier,
            reason: 'model claimed success without calling any tool',
            toolCalls: 0,
            steps: attempt.stepsUsed,
          };
          log.warn?.(`[agent] ${model.label} claimed success with 0 tool calls — refusing to trust it`);
          return [
            '⚠️ *Kuch nahi hua.*',
            'Model ne bina koi tool chalaye "ho gaya" bol diya — main use sach nahi maanta.',
            '',
            `Uska jawab: "${String(claimedText).replace(/\s+/g, ' ').slice(0, 200)}"`,
            '',
            'Dobara bhejo, ya direct command: /open chrome · /screenshot · /ls · /pc type hello',
            'Routing dekhni ho to /brains.',
          ].join('\n');
        }

        const meta = {
          ok: true,
          model: model.label,
          modelId: model.id,
          tier: plan.tier,
          rank: plan.rank,
          reasons: plan.complexity.reasons,
          steps: attempt.stepsUsed,
          stepBudget: effectivePlan.maxSteps,
          toolLimit: plan.toolLimit,
          toolCalls: attempt.toolCalls,
          ms,
          totalMs: Date.now() - started,
        };
        router.noteDecision({ text, tier: plan.tier, model: model.id, reason: meta.reasons.join(', ') });
        lastRun = meta;
        // Callers that want the metadata use lastRun; the reply itself stays
        // a plain WhatsApp-friendly value.
        return attempt.reply;
      } catch (err) {
        if (isStoppedError(err) || opts.signal?.aborted) {
          lastRun = { ok: false, stopped: true, model: model.label, tier: plan.tier, reason: 'stopped by /stop' };
          throw err;
        }
        const ms = Date.now() - attemptStart;
        router.record(model.id, { ok: false, ms, tier: plan.rank, error: err.message });
        log.warn?.(`[agent] ${model.label} failed: ${err.message}`);
      }
    }

    lastRun = {
      ok: false,
      model: attempts.map((m) => m.model).join(' → '),
      tier: plan.tier,
      reason: 'all brains failed',
      plan,
      ms: Date.now() - started,
    };
    return null;
  }

  return {
    run,
    enabled,
    toolCount: allTools.length,
    toolsFor,
    router,
    get lastRun() { return lastRun; },
    buildPlan: (text, opts = {}) => router.plan({ text, ...opts }),
  };
}
