// memory.js — what PSD knows and what it promised.
//
// One JSON file, written atomically, small enough to read on every turn:
//   facts      durable owner preferences ("preferred browser" = "firefox")
//   reminders  {id, text, at, done}
//   threads    per-surface conversation windows (chat, notch, whatsapp, cli)
//   episodes   recent task summaries — the learning loop's raw material
//   runs       append-only JSONL trace of every agent run (OpenJarvis-style)
//
// No database, no server, no dependency: the file is the state, and a corrupt
// file is quarantined instead of crashing the agent.

import fs from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({ version: 1, facts: {}, reminders: [], threads: {}, episodes: [], stats: { turns: 0, tools: 0 } });

export class Memory {
  constructor(config, { log = console } = {}) {
    this.config = config;
    this.log = log;
    this.file = config.memoryFile;
    this.runFile = config.runFile;
    this.data = EMPTY();
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { ...EMPTY(), ...parsed };
      this.data.facts ??= {};
      this.data.threads ??= {};
    } catch (err) {
      if (err.code !== 'ENOENT') {
        const quarantine = `${this.file}.corrupt-${Date.now()}`;
        try { fs.renameSync(this.file, quarantine); } catch { /* ignore */ }
        this.log.warn?.(`[memory] unreadable state moved to ${quarantine}; starting clean.`);
      }
      this.data = EMPTY();
    }
    return this;
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log.warn?.(`[memory] could not save: ${err.message}`);
    }
    return this;
  }

  // ── facts ────────────────────────────────────────────────────────────────
  remember(key, value) {
    const slot = String(key).trim().toLowerCase().slice(0, 80);
    if (!slot) return null;
    this.data.facts[slot] = { value: String(value).trim().slice(0, 2000), at: Date.now() };
    this.save();
    return this.data.facts[slot];
  }

  forget(key) {
    const slot = String(key).trim().toLowerCase();
    if (!(slot in this.data.facts)) return false;
    delete this.data.facts[slot];
    this.save();
    return true;
  }

  facts() {
    return Object.entries(this.data.facts).map(([key, entry]) => ({ key, value: entry.value, at: entry.at }));
  }

  recall(query = '') {
    const q = String(query ?? '').trim().toLowerCase();
    const all = this.facts();
    if (!all.length) return 'Nothing stored yet. Tell me something like "remember: my preferred editor is neovim".';
    const hits = q ? all.filter((f) => f.key.includes(q) || f.value.toLowerCase().includes(q)) : all;
    if (!hits.length) return `Nothing stored matching "${query}".`;
    return hits.map((f) => `• ${f.key} = ${f.value}`).join('\n');
  }

  /** Compact block injected into every system prompt. */
  promptBlock() {
    const facts = this.facts();
    const lines = [];
    if (facts.length) lines.push('Known owner facts:', ...facts.slice(-24).map((f) => `- ${f.key}: ${f.value}`));
    const due = this.reminders().slice(0, 5);
    if (due.length) lines.push('Pending reminders:', ...due.map((r) => `- ${new Date(r.at).toLocaleString('en-IN')}: ${r.text}`));
    const episodes = (this.data.episodes ?? []).slice(-3);
    if (episodes.length) lines.push('Recent work:', ...episodes.map((e) => `- ${e.summary}`));
    return lines.join('\n');
  }

  // ── reminders ────────────────────────────────────────────────────────────
  addReminder(text, at) {
    const id = (globalThis.crypto?.randomUUID?.() ?? String(Math.random())).replace(/-/g, '').slice(0, 12);
    this.data.reminders.push({ id, text: String(text).slice(0, 500), at: Number(at), done: false, created: Date.now() });
    this.data.reminders.sort((a, b) => a.at - b.at);
    this.save();
    return id;
  }

  reminders() {
    return (this.data.reminders ?? []).filter((r) => !r.done).sort((a, b) => a.at - b.at);
  }

  dueReminders(now = Date.now()) {
    return this.reminders().filter((r) => r.at <= now);
  }

  completeReminder(id) {
    const entry = (this.data.reminders ?? []).find((r) => r.id === id);
    if (!entry) return null;
    entry.done = true;
    entry.doneAt = Date.now();
    this.data.reminders = this.data.reminders.filter((r) => !r.done || r.at > Date.now() - 7 * 86_400_000);
    this.save();
    return entry;
  }

  // ── threads ──────────────────────────────────────────────────────────────
  thread(id = 'chat') {
    return this.data.threads[id] ??= { messages: [], updatedAt: 0 };
  }

  append(id, role, content, extra = {}) {
    const thread = this.thread(id);
    thread.messages.push({ role, content: String(content ?? ''), at: Date.now(), ...extra });
    // Bound the window: last N messages, and always keep the first user turn
    // summary out of the model context if it is ancient.
    const keep = this.config.maxHistory ?? 24;
    if (thread.messages.length > keep) thread.messages = thread.messages.slice(-keep);
    thread.updatedAt = Date.now();
    this.data.stats.turns += role === 'user' ? 1 : 0;
    this.save();
    return thread;
  }

  history(id = 'chat') {
    return (this.data.threads[id]?.messages ?? []).filter((m) => m.role === 'user' || m.role === 'assistant');
  }

  clearThread(id = 'chat') {
    if (this.data.threads[id]) {
      this.data.threads[id] = { messages: [], updatedAt: Date.now() };
      this.save();
      return true;
    }
    return false;
  }

  // ── episodes + traces ────────────────────────────────────────────────────
  noteEpisode(summary) {
    this.data.episodes = [...(this.data.episodes ?? []), { summary: String(summary).slice(0, 400), at: Date.now() }].slice(-60);
    this.save();
  }

  /** Append-only JSONL trace: replayable, greppable, no database. */
  trace(entry) {
    try {
      fs.mkdirSync(path.dirname(this.runFile), { recursive: true });
      fs.appendFileSync(this.runFile, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
    } catch { /* tracing must never break a turn */ }
  }

  recentTraces(limit = 20) {
    try {
      const lines = fs.readFileSync(this.runFile, 'utf8').trim().split('\n').slice(-limit);
      return lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).reverse();
    } catch { return []; }
  }
}
