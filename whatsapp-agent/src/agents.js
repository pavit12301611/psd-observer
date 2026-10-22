// agents.js — the multi-agent fleet 🤖🤝🤖
//
// Work is divided among specialized bots. The trained IntentNet is the
// DISPATCHER: it reads the message, picks the right bot(s), and each bot gets
// its own mission + tools. Multi-part messages ("explain photosynthesis and
// likho ek poem") split into a SQUAD — two bots answer together, each signed.
//
//   🔬 ResearchBot   factual / comparison      tools: knowledge + wiki
//   👩‍🏫 TeacherBot    explain / howto           tools: knowledge + wiki
//   🧑‍💻 CodeBot      code                      tools: code runner
//   🧮 MathBot       math                      tools: solver engine
//   ✍️ CreativeBot   creative writing          tools: —
//   🫂 DostiBot      emotional / chit-chat     tools: —
//   🤖 DeskBot       personal / misc           tools: knowledge
//   👁️ VisionBot     images (image pipeline)   tools: vision + solver
//
// Everything here is deterministic and pure — no network, no AI calls.

export const AGENTS = {
  researcher: {
    id: 'researcher',
    name: 'ResearchBot',
    emoji: '🔬',
    intents: ['factual', 'comparison'],
    tools: ['knowledge', 'wiki'],
    mission: [
      'AGENT MISSION (RESEARCHBOT 🔬): You are the fact-and-research specialist of the bot fleet.',
      'Deliver verified, precise facts first — dates, numbers, names, definitions. Use the knowledge/wiki context when present.',
      'For comparisons, give the key differences in a tight structure (3-6 bullets or a compact table), then one closing insight.',
      'Never pad with pleasantries. If unsure of a fact, say so plainly instead of guessing.',
    ],
  },
  explainer: {
    id: 'explainer',
    name: 'TeacherBot',
    emoji: '👩‍🏫',
    intents: ['explain', 'howto'],
    tools: ['knowledge', 'wiki'],
    mission: [
      'AGENT MISSION (TEACHERBOT 👩‍🏫): You are the teacher of the bot fleet.',
      'Explain step-by-step in simple language the owner already speaks — start with the one-line big picture, then build up.',
      'For how-to questions: numbered steps or working commands FIRST, then one short tip. Use analogies from daily Indian life when useful.',
      'No walls of theory — clarity beats completeness.',
    ],
  },
  coder: {
    id: 'coder',
    name: 'CodeBot',
    emoji: '🧑‍💻',
    intents: ['code'],
    tools: ['code'],
    mission: [
      'AGENT MISSION (CODEBOT 🧑‍💻): You are the programmer of the bot fleet.',
      'Lead with WORKING code in a proper code block, ready to copy-run. Then 2-4 short bullets on how it works or how to run it.',
      'Pick the language the owner asked for; if none, choose the most natural one and say it in one word.',
      'No long tutorials unless asked. Code quality: clean, correct, minimal.',
    ],
  },
  math: {
    id: 'math',
    name: 'MathBot',
    emoji: '🧮',
    intents: ['math'],
    tools: ['solver'],
    mission: [
      'AGENT MISSION (MATHBOT 🧮): You are the calculator of the bot fleet.',
      'Compute CAREFULLY step-by-step and state the final numeric answer clearly at the end (exactly once).',
      'Show only the essential steps — substitution, operation, result — never a textbook essay.',
      'Double-check arithmetic before answering. Units and percent signs matter.',
    ],
  },
  creative: {
    id: 'creative',
    name: 'CreativeBot',
    emoji: '✍️',
    intents: ['creative'],
    tools: [],
    mission: [
      'AGENT MISSION (CREATIVEBOT ✍️): You are the writer of the bot fleet.',
      'Deliver the creative piece FIRST — poem, story, caption, lyrics, shayari — polished and playful, in the language they wrote in.',
      'Then at most one short warm closing line. Never inject facts, definitions, or study-notes energy into creative work.',
      'Match the mood they asked for (sad song lyrics stay sad, gym captions stay punchy).',
    ],
  },
  companion: {
    id: 'companion',
    name: 'DostiBot',
    emoji: '🫂',
    intents: ['emotional', 'greeting', 'gratitude'],
    tools: [],
    mission: [
      'AGENT MISSION (DOSTIBOT 🫂): You are the friend of the bot fleet.',
      'Lead with genuine warmth and empathy (2-4 short lines). Mirror their language — Hinglish in, Hinglish out.',
      'No fact dumps, no bullet lists, no unsolicited advice — just human warmth, maybe one gentle practical thought at the end.',
      'For greetings and thanks: be warm and brief (1-2 lines), never robotic.',
    ],
  },
  assistant: {
    id: 'assistant',
    name: 'DeskBot',
    emoji: '🤖',
    intents: ['personal', 'misc_chat'],
    tools: ['knowledge'],
    mission: [
      'AGENT MISSION (DESKBOT 🤖): You are the all-rounder of the bot fleet.',
      'Handle personal notes, opinions, casual talk and general questions with sharp, useful, friendly replies.',
      'Remember the owner: use their name and stored facts when relevant. Keep it conversational — 2-5 lines unless more is asked.',
    ],
  },
};

export const AGENT_ORDER = Object.keys(AGENTS);

const INTENT_TO_AGENT = {};
for (const agent of Object.values(AGENTS)) {
  for (const intent of agent.intents) INTENT_TO_AGENT[intent] = agent;
}

/** Which bot owns this intent label? (always resolves — DeskBot is home) */
export function agentForIntent(label) {
  return INTENT_TO_AGENT[label] || AGENTS.assistant;
}

/**
 * The dispatcher: trained IntentNet result → one bot, or a SQUAD when the
 * message carries two different kinds of work ("explain X and write a poem").
 *
 * Returns { primary, squad, multi } where squad = [{ agent, intent, share }]
 * and share is the relative weight from the net's scores.
 */
export function orchestrate(text, classified) {
  const label = classified?.label || 'misc_chat';
  const scores = classified?.scores || {};
  const primary = agentForIntent(label);

  // Squad detection: a strong second intent on a DIFFERENT bot, AND the text
  // really looks like two tasks glued together (connector + task verb, double
  // question, or explicit separator). Plain "and"/"bhi" alone is NOT enough —
  // "what is light and sound" is one research question, not a squad.
  const compound = /\b(?:aur|and then|along with|ke saath)\b|\b(?:and|aur)\s+(?:likho|write|make|banao|create|draw|generate|solve|calculate|compute|explain|tell|batao|code|compare|samjhao|sunao|convert)\b|\?[^?]*\?|[\n;]/i.test(String(text || ''));
  const ranked = Object.entries(scores)
    .filter(([intent, s]) => s > 0.15 && agentForIntent(intent).id !== primary.id)
    .sort((a, b) => b[1] - a[1]);

  const squad = [{ agent: primary, intent: label, share: scores[label] ?? 1 }];
  if (compound && ranked.length) {
    const [secondIntent, secondScore] = ranked[0];
    if (secondScore >= 0.2) {
      squad.push({ agent: agentForIntent(secondIntent), intent: secondIntent, share: secondScore });
    }
  }
  return { primary, squad, multi: squad.length > 1 };
}

/** System-prompt lines for one bot's mission. */
export function missionDirective(agent) {
  return agent?.mission ? [...agent.mission] : [];
}

/** Signed footer like "— 🧑‍💻 CodeBot". */
export function agentTag(agent) {
  return `— ${agent.emoji} ${agent.name}`;
}

/** Header for squad sections like "🧑‍💻 CodeBot:" */
export function agentHeader(agent) {
  return `${agent.emoji} ${agent.name}:`;
}

/**
 * Merge squad answers into one visible multi-bot reply:
 *
 *   🔬 ResearchBot:
 *   <facts…>
 *
 *   ✍️ CreativeBot:
 *   <poem…>
 */
export function mergeSquadAnswers(parts) {
  return parts
    .filter((p) => p?.text?.trim())
    .map((p) => `${agentHeader(p.agent)}\n${p.text.trim()}`)
    .join('\n\n');
}

/**
 * How each bot should answer THIS message. For squads every bot gets the full
 * text but only owns its share of the work.
 */
export function taskBrief(entry) {
  const { agent, intent } = entry;
  if (intent === 'factual' || intent === 'comparison') return 'Your share: the factual/research part of this message.';
  if (intent === 'explain' || intent === 'howto') return 'Your share: the explanation/tutorial part of this message.';
  if (intent === 'code') return 'Your share: the programming part of this message.';
  if (intent === 'math') return 'Your share: the calculation part of this message.';
  if (intent === 'creative') return 'Your share: the creative-writing part of this message.';
  if (intent === 'emotional' || intent === 'greeting' || intent === 'gratitude') return 'Your share: the feelings/chit-chat part of this message.';
  return 'Your share: the general-assistant part of this message.';
}

/** Fleet status line for "agents" command / info. */
export function fleetStatus() {
  const rows = AGENT_ORDER.map((id) => {
    const a = AGENTS[id];
    return `${a.emoji} ${a.name} — ${a.intents.join(', ')} [${a.tools.length ? a.tools.join('+') : 'no tools'}]`;
  });
  rows.push('👁️ VisionBot — images & questions [vision+solver] (image pipeline)');
  return rows.join('\n');
}
