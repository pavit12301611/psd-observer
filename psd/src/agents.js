// agents.js — OpenJarvis-style agents and skills, as plain files you own.
//
// The idea is lifted from OpenJarvis (agents/ + skills/), minus the runtime:
//
//   agents/<name>/AGENT.md   YAML frontmatter + the system prompt body
//   skills/<name>/SKILL.md   one capability, described so a model can use it
//
// A skill in OpenJarvis is "a tool the agent discovers"; here it is a *prompt
// module plus a tool allow-list*, which is the part that actually changes model
// behaviour on a 7B local model. Anything the model still needs to *do* goes
// through the tool registry in tools.js.
//
// Files are hot-reloaded: save an AGENT.md and the next turn uses it.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

/** Minimal, dependency-free YAML frontmatter reader (flat keys + lists). */
export function parseFrontmatter(text) {
  const source = String(text ?? '');
  if (!source.startsWith('---')) return { meta: {}, body: source.trim() };
  const end = source.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: source.trim() };
  const raw = source.slice(3, end).trim();
  const body = source.slice(end + 4).replace(/^\s*\n/, '');
  const meta = {};
  let currentKey = null;
  for (const line of raw.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && currentKey) {
      if (!Array.isArray(meta[currentKey])) meta[currentKey] = [];
      meta[currentKey].push(coerce(listItem[1]));
      continue;
    }
    const pair = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!pair) continue;
    currentKey = pair[1];
    const value = pair[2].trim();
    meta[currentKey] = value === '' ? [] : coerce(value);
  }
  return { meta, body: body.trim() };
}

function coerce(raw) {
  const value = raw.trim().replace(/^["']|["']$/g, '');
  if (/^(true|yes|on)$/i.test(value)) return true;
  if (/^(false|no|off)$/i.test(value)) return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  return value;
}

function readDir(dir, filename) {
  const entries = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return entries; }
  for (const name of names) {
    const file = path.join(dir, name, filename);
    try {
      const stat = fs.statSync(file);
      const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      entries.push({
        id: meta.name || name,
        name: meta.name || name,
        description: meta.description || '',
        body,
        tools: meta.tools ?? [],
        tags: meta.tags ?? [],
        when: meta.when ?? [],
        model: meta.model || '',
        temperature: meta.temperature,
        voice: meta.voice || '',
        author: meta.author || '',
        version: meta.version || '',
        file,
        mtime: stat.mtimeMs,
        bytes: stat.size,
      });
    } catch { /* skip unreadable */ }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function createAgentLibrary(config, { log = console } = {}) {
  let agents = [];
  let skills = [];
  let loadedAt = 0;

  function load({ force = false } = {}) {
    if (!force && Date.now() - loadedAt < 2000) return { agents, skills };
    agents = readDir(path.join(config.agentDir), 'AGENT.md');
    skills = readDir(path.join(ROOT, 'skills'), 'SKILL.md');
    loadedAt = Date.now();
    return { agents, skills };
  }

  function agent(id) {
    load();
    const wanted = String(id || config.agent || 'psd').toLowerCase();
    return agents.find((entry) => entry.id.toLowerCase() === wanted) ??
      agents.find((entry) => entry.id.toLowerCase() === 'psd') ?? agents[0] ?? null;
  }

  function skill(id) {
    load();
    return skills.find((entry) => entry.id.toLowerCase() === String(id ?? '').toLowerCase()) ?? null;
  }

  /**
   * Skills that fit the request. Matching is cheap keyword work, but it looks
   * at three places on purpose: the skill id, its `when` trigger phrases (the
   * most reliable signal, written by the skill author), and a light pass over
   * the description. A miss is free; a wrong hit only adds 2 KB of prompt.
   */
  function matchSkills(text, limit = 2) {
    load();
    const query = String(text ?? '').toLowerCase();
    if (!query) return [];
    const queryWords = new Set(query.split(/\W+/).filter((w) => w.length > 2));
    return skills
      .map((entry) => {
        let score = 0;
        const name = entry.name.toLowerCase();
        if (query.includes(name.replace(/-/g, ' '))) score += 10;
        for (const word of name.split('-')) if (word.length > 3 && queryWords.has(word)) score += 3;
        for (const tag of entry.tags) if (tag && queryWords.has(String(tag).toLowerCase())) score += 4;
        for (const trigger of entry.when) {
          const phrase = String(trigger).toLowerCase();
          if (!phrase) continue;
          if (query.includes(phrase)) score += 6;
          else if (phrase.split(/\W+/).some((w) => w.length > 3 && queryWords.has(w))) score += 2;
        }
        for (const word of String(entry.description).toLowerCase().split(/\W+/)) {
          if (word.length > 4 && queryWords.has(word)) score += 1;
        }
        return { entry, score };
      })
      .filter((hit) => hit.score >= 4)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((hit) => hit.entry);
  }

  return {
    load, agent, skill, matchSkills,
    get agents() { load(); return agents; },
    get skills() { load(); return skills; },
  };
}
