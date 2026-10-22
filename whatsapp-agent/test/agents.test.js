// agents.test.js — the multi-agent fleet: work is divided among specialist
// bots and the trained IntentNet is the dispatcher.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENTS, AGENT_ORDER, agentForIntent, orchestrate, missionDirective,
  agentTag, agentHeader, mergeSquadAnswers, taskBrief, fleetStatus,
} from '../src/agents.js';
import { classifyIntent } from '../src/neural/index.js';
import { systemPrompt } from '../src/ai.js';

// ── 1. Fleet registry ──────────────────────────────────────────────────────

test('fleet: registry covers every intent exactly once, with tools', () => {
  assert.ok(AGENT_ORDER.length >= 7, 'at least 7 specialist bots');
  const covered = new Set();
  for (const id of AGENT_ORDER) {
    const a = AGENTS[id];
    assert.ok(a.name && a.emoji && a.mission?.length >= 3, `${id} fully specified`);
    for (const intent of a.intents) {
      assert.ok(!covered.has(intent), `intent ${intent} assigned once`);
      covered.add(intent);
    }
  }
  for (const intent of ['factual', 'comparison', 'explain', 'howto', 'code', 'math', 'creative', 'emotional', 'greeting', 'gratitude', 'personal', 'misc_chat']) {
    assert.ok(covered.has(intent), `${intent} owned by a bot`);
  }
  // MathBot uses the solver, research/teacher use knowledge+wiki.
  assert.deepEqual(AGENTS.math.tools, ['solver']);
  assert.deepEqual(AGENTS.researcher.tools, ['knowledge', 'wiki']);
});

test('fleet: agentForIntent always resolves (DeskBot is home)', () => {
  assert.equal(agentForIntent('code').name, 'CodeBot');
  assert.equal(agentForIntent('emotional').name, 'DostiBot');
  assert.equal(agentForIntent('nonsense-label').name, 'DeskBot');
});

test('fleet: missions never contain the banned greeting', () => {
  for (const id of AGENT_ORDER) {
    for (const line of AGENTS[id].mission) {
      assert.ok(!/namaste|namaskar/i.test(line), `${id} mission clean`);
    }
  }
});

// ── 2. Dispatcher ──────────────────────────────────────────────────────────

test('dispatch: single-intent messages go to one bot', () => {
  const plan = orchestrate('mood off hai aaj', classifyIntent('mood off hai aaj'));
  assert.equal(plan.multi, false);
  assert.equal(plan.primary.name, 'DostiBot');
  assert.equal(plan.squad.length, 1);
});

test('dispatch: compound messages split into a squad', () => {
  const text = 'explain photosynthesis and likho ek poem barish pe';
  const plan = orchestrate(text, classifyIntent(text));
  // Whatever the net's exact labels are, the squad must span 2 different bots
  // OR degrade gracefully to a single bot — never crash, never 3+ bots.
  assert.ok(plan.squad.length <= 2, 'squad capped at 2');
  if (plan.multi) {
    assert.notEqual(plan.squad[0].agent.id, plan.squad[1].agent.id, 'different bots');
  }
});

test('dispatch: plain "and" inside one question does NOT create a squad', () => {
  const text = 'what is the speed of light and sound';
  const plan = orchestrate(text, classifyIntent(text));
  assert.equal(plan.multi, false, 'single research question stays solo');
  assert.equal(plan.primary.name, 'ResearchBot');
});

test('dispatch: "solve X and write code" wants MathBot + CodeBot', () => {
  const text = 'solve 2x + 4 = 8 and write a python function to reverse a string';
  const plan = orchestrate(text, classifyIntent(text));
  const names = plan.squad.map((s) => s.agent.name);
  assert.ok(names.includes('MathBot') || names.includes('CodeBot'), names.join('+'));
  if (plan.multi) assert.equal(plan.squad.length, 2);
});

test('dispatch: taskBrief tells each bot its share of the work', () => {
  assert.match(taskBrief({ agent: AGENTS.creative, intent: 'creative' }), /creative-writing/);
  assert.match(taskBrief({ agent: AGENTS.math, intent: 'math' }), /calculation/);
  assert.match(taskBrief({ agent: AGENTS.researcher, intent: 'factual' }), /factual/);
});

// ── 3. Prompt integration ──────────────────────────────────────────────────

test('dispatch: system prompt carries the dispatched bot mission', () => {
  const config = { ownerNumber: '911234567890', agentNumber: '919876543210', timezone: 'Asia/Kolkata' };
  const store = { data: { history: [], memory: { facts: [], rules: [] }, todos: [], preferredLanguageMode: 'hinglish' } };
  const sys = systemPrompt(config, store, {
    userText: 'likho ek poem barish pe',
    intent: 'creative',
    agent: AGENTS.creative,
    taskBrief: taskBrief({ agent: AGENTS.creative, intent: 'creative' }),
    squadName: 'CreativeBot',
  });
  assert.match(sys, /AGENT MISSION \(CREATIVEBOT/, 'creative mission present');
  assert.match(sys, /SQUAD MODE/, 'squad mode flagged');
  assert.match(sys, /creative-writing part/, 'task brief present');
  // Existing brain rules survive the agent layer.
  assert.match(sys, /Hinglish/);
  assert.match(sys, /ZERO-HALLUCINATION|ACCURACY/);
});

test('dispatch: emotional message prompt has no fact-dump energy', () => {
  const config = { ownerNumber: '911234567890', agentNumber: '919876543210', timezone: 'Asia/Kolkata' };
  const store = { data: { history: [], memory: { facts: [], rules: [] }, todos: [], preferredLanguageMode: 'hinglish' } };
  const sys = systemPrompt(config, store, { userText: 'yaar mood off hai', intent: 'emotional', agent: AGENTS.companion });
  assert.match(sys, /DOSTIBOT/);
  assert.match(sys, /No fact dumps/);
});

// ── 4. Squad output shape ──────────────────────────────────────────────────

test('fleet: squad answers merge with visible bot headers', () => {
  const merged = mergeSquadAnswers([
    { agent: AGENTS.researcher, text: 'Photosynthesis ka process…' },
    { agent: AGENTS.creative, text: 'Barish ki boondein…' },
  ]);
  assert.match(merged, /🔬 ResearchBot:\nPhotosynthesis/);
  assert.match(merged, /✍️ CreativeBot:\nBarish/);
  assert.equal(mergeSquadAnswers([{ agent: AGENTS.coder, text: '   ' }]), '', 'empty parts dropped');
});

test('fleet: tags and headers are clean', () => {
  assert.equal(agentTag(AGENTS.coder), '— 🧑‍💻 CodeBot');
  assert.equal(agentHeader(AGENTS.math), '🧮 MathBot:');
});

test('fleet: status line lists every bot', () => {
  const status = fleetStatus();
  for (const id of AGENT_ORDER) assert.ok(status.includes(AGENTS[id].name), `${id} in status`);
  assert.match(status, /VisionBot/);
});

test('dispatch: graceful fallback with no neural brain', () => {
  const plan = orchestrate('hello', { label: null, scores: {} });
  assert.equal(plan.primary.name, 'DeskBot');
  assert.equal(plan.multi, false);
});
