// router.js — the planner.
//
// A single request takes one of four paths, cheapest first. This is the reason
// PSD answers a notch request in tens of milliseconds instead of a minute:
//
//   1. quick         deterministic reply ("hi", "who are you", the clock)
//   2. intent        offline intent → one tool call, no model involved
//   3. tool-calling  model + tools, streaming, bounded to config.maxSteps
//   4. escalate      if the model produced nothing usable, retry once with a
//                    smaller tool set / different brain (OpenJarvis' hybrid
//                    fallback idea, kept deliberately simple)
//
// Every step is traced, so "why was that slow" is answerable after the fact.

import { parseIntent, quickReply, keywordTool } from './intents.js';
import { NoBrainError } from './engine.js';
import { shorten } from './tools.js';

const QUESTION = /\b(kya|kaise|kyun|what|why|how|who|when|where|kitna|explain|samjhao|difference|meaning)\b/i;

/** Does this look like something the model should answer (not one tool call)? */
export function needsModel(text, intent) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  if (QUESTION.test(value) && (!intent || intent.tool === null)) return true;
  if (value.includes('?') && !intent) return true;
  if (value.split(/\s+/).length > 12) return true;
  if (/\b(plan|compare|summar|write|draft|explain|research|debug|why|should i)\b/i.test(value)) return true;
  if (/\b(aur|and|then|phir|ke baad|uske baad)\b/i.test(value) && intent) return true;
  return false;
}

function buildSystemPrompt({ agent, skills, memory, tools, config, extra = '' }) {
  const today = new Date().toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
  const lines = [
    agent?.body || 'You are PSD, the owner\'s personal agent on their own Fedora workstation.',
    '',
    `Context: ${today} (Asia/Kolkata). Host ${config.hostname}. Access level: ${config.access}. Shell: ${config.shell ? 'enabled' : 'disabled'}.`,
    'You act on a real Linux machine through tools. Prefer one decisive tool call over speculation.',
    'Never claim you did something unless a tool result proves it. If a tool failed, say what failed and why, in one line.',
    'Keep replies short and concrete: this is read in a 640px notch, on a phone, or in WhatsApp. No markdown tables, no filler.',
    'Match the owner\'s language — Hinglish, Hindi or English, whatever they used.',
    'Tool arguments must be valid JSON. Use absolute paths. Do not invent file paths or app names; list first if unsure.',
  ];
  const block = memory.promptBlock();
  if (block) lines.push('', block);
  if (skills?.length) {
    lines.push('', 'Active skills (follow these instructions for this request):');
    for (const skill of skills) {
      lines.push(`### ${skill.name}`, shorten(skill.body, 2400));
    }
  }
  if (tools?.length) lines.push('', `Available tools: ${tools.map((t) => t.function?.name ?? t.name).join(', ')}.`);
  if (extra) lines.push('', extra);
  return lines.join('\n');
}

function formatToolResult(result) {
  const body = [result.ok ? 'OK' : 'ERROR', result.text ?? ''].filter(Boolean).join(': ');
  return shorten(body, 4000);
}

export function createRouter({ config, engine, tools, memory, agents, notch, whatsapp, log = console, bus = () => {} }) {
  /** Run one deterministic intent or quick reply. */
  async function runFast(text, ctx) {
    const reply = quickReply(text);
    if (reply) return { text: reply, path: 'quick', toolsUsed: [] };

    const intent = parseIntent(text);
    if (!intent) return null;
    if (!intent.tool) return { text: intent.reply ?? '', path: 'intent', toolsUsed: [], label: intent.label };

    bus({ type: 'status', state: 'working', label: intent.label });
    const result = await tools.execute(intent.tool, intent.args, { source: ctx.source ?? 'psd', ...ctx });
    bus({ type: 'status', state: 'idle' });

    if (result.needsConfirmation) {
      return {
        text: `Needs your approval: ${result.text}\nApprove with: /approve ${result.approvalId}`,
        path: 'intent', toolsUsed: [intent.tool], needsConfirmation: true, approvalId: result.approvalId,
      };
    }
    return {
      text: result.text || (result.ok ? 'Done.' : 'That did not work.'),
      path: 'intent', toolsUsed: [intent.tool], ok: result.ok, image: result.image,
      label: intent.label, ms: result.ms,
    };
  }

  /**
   * The full turn. Returns {text, path, toolsUsed, ms, images?}.
   * Streams tokens through ctx.onToken when the model is in the loop.
   */
  async function turn(text, ctx = {}) {
    const started = Date.now();
    const source = ctx.source ?? 'psd';
    const threadId = ctx.thread ?? 'chat';
    const value = String(text ?? '').trim();
    if (!value) return { text: '', path: 'empty', toolsUsed: [], ms: 0 };

    const finish = (result) => {
      memory.append(threadId, 'user', value, { source });
      memory.append(threadId, 'assistant', result.text, { path: result.path });
      memory.trace({ source, text: value, path: result.path, tools: result.toolsUsed, ms: result.ms ?? Date.now() - started });
      return { ...result, ms: result.ms ?? Date.now() - started };
    };

    // 1. Deterministic small talk — no model, no tool, single-digit milliseconds.
    const quick = quickReply(value);
    if (quick) return finish({ text: quick, path: 'quick', toolsUsed: [] });

    // 2. A pure clock/info answer with no side effect.
    const intent = parseIntent(value);
    if (intent && !intent.tool) return finish({ text: intent.reply ?? '', path: 'intent', toolsUsed: [], label: intent.label });

    // 3. One intent → one tool call, unless the sentence clearly wants more
    //    ("wifi off karo aur phir chrome kholo"). Compound requests go to the
    //    model with the detected intent as a hint instead of being half-run.
    if (intent?.tool && !needsModel(value, intent)) {
      bus({ type: 'status', state: 'working', label: intent.label });
      const result = await tools.execute(intent.tool, intent.args, { source, ...ctx });
      bus({ type: 'status', state: 'idle' });
      if (result.needsConfirmation) {
        return finish({
          text: `Needs your approval: ${result.text}\nApprove with: /approve ${result.approvalId}`,
          path: 'intent', toolsUsed: [intent.tool], needsConfirmation: true, approvalId: result.approvalId,
        });
      }
      return finish({
        text: result.text || (result.ok ? 'Done.' : 'That did not work.'),
        path: 'intent', toolsUsed: [intent.tool], ok: result.ok, image: result.image,
        label: intent.label, ms: result.ms, hints: result.hints,
      });
    }

    // The model has the floor. Deterministic knowledge is still offered as a
    // head start so a slow local brain does not have to rediscover it.
    const agent = agents.agent(ctx.agent ?? config.agent);
    const hints = config.skills === false ? [] : agents.matchSkills(value, 2);
    const toolSchemas = ctx.toolsOnly
      ? tools.schemas().filter((t) => (ctx.toolsOnly ?? []).includes(t.function.name))
      : tools.schemas();

    const deferred = intent?.tool ? `The owner\'s message also looks like: ${intent.label} (${intent.tool} ${JSON.stringify(intent.args)}). Do that first if it still fits, with other tools as needed.` : '';
    const messages = [
      { role: 'system', content: buildSystemPrompt({ agent, skills: hints, memory, tools: toolSchemas, config, extra: [ctx.extraPrompt ?? '', deferred].filter(Boolean).join('\n') }) },
      ...memory.history(threadId).slice(-(config.maxHistory - 2)).map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: value },
    ];

    const usages = [];
    let streamed = '';
    const onToken = (chunk) => {
      streamed += chunk;
      ctx.onToken?.(chunk);
      notch.token(chunk).catch?.(() => {});
    };

    let final = '';
    let path = 'model';
    try {
      for (let step = 0; step < config.maxSteps; step += 1) {
        const response = await engine.chat({
          messages,
          tools: toolSchemas,
          onToken,
          signal: ctx.signal,
          maxTokens: ctx.maxTokens ?? 1024,
        });
        usages.push(response);
        const calls = response.toolCalls ?? [];

        if (!calls.length) { final = response.content.trim(); break; }

        messages.push({
          role: 'assistant',
          content: response.content || '',
          tool_calls: calls.map((call) => ({
            id: call.id, type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
          })),
        });

        for (const call of calls) {
          bus({ type: 'status', state: 'tool', label: call.name });
          const result = await tools.execute(call.name, call.arguments, { source, signal: ctx.signal });
          usages.push({ tool: call.name, ok: result.ok });
          memory.data.stats.tools += 1;
          memory.trace({ source, step, tool: call.name, ok: result.ok, ms: result.ms });
          if (result.needsConfirmation) {
            messages.push({
              role: 'tool', tool_call_id: call.id,
              content: 'The owner must confirm this action before it can run. Tell them what needs approval and stop.',
            });
            final = `Needs your approval: ${result.text}\nApprove with: /approve ${result.approvalId}`;
            path = 'approval';
            break;
          }
          messages.push({ role: 'tool', tool_call_id: call.id, tool_name: call.name, content: formatToolResult(result) });
          if (result.image) ctx.onImage?.(result.image);
        }
        if (path === 'approval') break;
        if (step === config.maxSteps - 1) {
          final = response.content?.trim() || 'I hit the step limit before finishing. Tell me to continue and I will pick up from the last verified step.';
          path = 'step-limit';
        }
      }

      if (!final.trim()) {
        // One escalation pass: same conversation, no tools, ask for the answer
        // in words. This is what turns a silent tool loop into a real reply.
        const retry = await engine.chat({
          messages: [...messages, { role: 'user', content: 'Now answer the owner in two or three short lines, based only on what the tools returned.' }],
          tools: [], onToken, signal: ctx.signal, maxTokens: 512,
        });
        final = retry.content.trim();
        path = 'escalate';
      }
    } catch (err) {
      const safe = parseIntent(value);
      const fastFallback = safe && !safe.tool ? await runFast(value, { ...ctx, source }) : null;
      if (fastFallback) {
        final = fastFallback.text;
        fastFallback.toolsUsed.forEach((tool) => usages.push({ tool }));
        path = 'intent-fallback';
      } else if (err instanceof NoBrainError) {
        const keyword = keywordTool(value, tools);
        if (keyword) {
          const result = await tools.execute(keyword.tool, keyword.args, { source });
          final = result.text || (result.ok ? 'Done.' : 'That did not work.');
          usages.push({ tool: keyword.tool });
          path = 'keyword';
          ctx.onImage?.(result.image);
        } else final = [
          'No model is answering, so I can only do the fast things.',
          'Try: system status · screenshot · volume up · open chrome · wifi off · notch: hello',
          `Or start a brain: \`ollama pull qwen3:8b\` then \`systemctl --user start psd-agent\`${config.openaiUrl || config.openjarvisUrl ? '' : ' (or set PSD_OPENAI_URL / PSD_OPENJARVIS_URL)'}.`,
        ].join('\n');
        if (!path || path === 'model') path = 'no-brain';
      } else {
        final = `That failed: ${err.message}`;
        path = 'error';
      }
    }

    const toolsUsed = usages.filter((u) => u.tool).map((u) => u.tool);
    memory.append(threadId, 'user', value, { source });
    memory.append(threadId, 'assistant', final, { path });
    if (toolsUsed.length) memory.noteEpisode(`${shorten(value, 90)} → ${toolsUsed.join(', ')}`);
    memory.trace({ source, text: value, path, tools: toolsUsed, steps: usages.length, ms: Date.now() - started });

    return {
      text: final,
      path,
      toolsUsed,
      ms: Date.now() - started,
      brain: usages[0]?.brain ?? null,
      model: usages[0]?.model ?? null,
      streamed,
    };
  }

  return { turn, runFast };
}
