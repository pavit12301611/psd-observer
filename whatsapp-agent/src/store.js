// store.js — persistence with zero infrastructure: one JSON file, atomic writes.
// (The cloud version needed Redis + R2 for this; a single-user agent does not.)
import fs from 'node:fs';
import { atomicJSON } from './persistence.js';

const EMPTY = () => ({
  notes: [],          // {id, text, ts}
  todos: [],          // {id, text, done, ts}
  reminders: [],      // {id, text, dueTs, createdTs}
  callSchedules: [],  // {id, text, dueTs, createdTs} — JARVIS calls the owner at dueTs and speaks text (or runs it if it starts with /)
  cronJobs: [],       // {id, text, schedule, scheduleRaw, nextDueTs, createdTs, lastRunTs}
  learned: [],        // custom keywords: {id, keyword, commands: [{cmd,args,raw,inferredOpen}], rawText, createdTs}
  rules: [],          // custom trigger->action overrides: {id, trigger, triggerNorm, kind, action, createdTs}
  facts: {},          // /remember key -> display value, injected into the AI prompt
  factValues: {},     // canonical slot key -> clean value (e.g. name -> "Pavit"), overwritten on updates
  profile: null,      // continuous behavioral & personality learning profile (src/persona.js)
  contacts: {},       // saved contacts { slug: { name, slug, number, addedTs } } (src/guests.js)
  guestPolicy: null,  // controlled multi-user policy { mode, requireApproval, allowlist, blocklist, ... }
  guestChats: {},     // isolated per-guest chat history { [number]: { name, history, lastSeenTs, msgCount, blockedCount } }
  guestAuditLog: [],  // recent guest chat / blocked command / outbound message entries
  pendingGuestApprovals: [], // guest messages held for owner approval (yes / no / send instead)
  lastGuestSender: null, // { number, jid, name, ts } for quick `/reply <text>`
  ownerLocation: null, // owner's current location { enabled, city, region, country, lat, lon, address, source, updatedTs } (src/location.js)
  lastOwnerTask: '',  // owner's most recent actionable message/command (used for "create this as a command /name")
  actionRecordings: [], // saved live PC action recordings (src/actionrecorder.js)
  activeActionRecording: null, // currently active live PC action recording session
  lastActionRecording: null, // most recently completed PC action recording
  history: [],        // AI chat turns [{role, content}], trimmed
  downloads: [],      // received media [{file, kind, ts, caption}]
  pending: null,      // destructive action waiting for "haan"/"yes"
  offlineNotify: null,// null = follow OFFLINE_NOTIFY env (default true), boolean = owner override
  offlineMessage: '', // custom sleeping/offline message override
  stats: {
    received: 0,
    replied: 0,
    ignoredNonOwner: 0,
    guestMessagesIn: 0,
    guestRepliesOut: 0,
    blockedGuestCommands: 0,
    outboundToOthers: 0,
    startedAt: Date.now(),
    sleeping: false,
    lastOfflineNotify: 0,
    lastOfflineReason: '',
  },
});

export class Store {
  constructor(file) {
    this.file = file;
    this.data = EMPTY();
    this._saveTimer = null;
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('State must be a JSON object');
      const defaults = EMPTY();
      this.data = { ...defaults, ...parsed };
      for (const [key, initial] of Object.entries(defaults)) {
        if (Array.isArray(initial) && !Array.isArray(this.data[key])) this.data[key] = [];
      }
      for (const key of ['facts', 'factValues', 'contacts', 'guestChats']) {
        const value = this.data[key];
        if (!value || typeof value !== 'object' || Array.isArray(value)) this.data[key] = {};
      }
      const stats = parsed.stats;
      this.data.stats = { ...defaults.stats, ...(stats && typeof stats === 'object' && !Array.isArray(stats) ? stats : {}) };
      for (const [key, initial] of Object.entries(defaults.stats)) {
        if (typeof initial === 'number' && (!Number.isFinite(this.data.stats[key]) || this.data.stats[key] < 0)) this.data.stats[key] = initial;
        if (typeof initial === 'boolean' && typeof this.data.stats[key] !== 'boolean') this.data.stats[key] = initial;
      }
    } catch {
      this.data = EMPTY(); // first run, or a corrupt file: start clean rather than crash
    }
    return this;
  }

  save() {
    // Debounced + atomic (write tmp, rename) so a crash mid-write cannot corrupt it.
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        atomicJSON(this.file, this.data, { space: 2 });
      } catch (err) {
        console.error('[store] save failed:', err.message);
      }
    }, 150);
    this._saveTimer.unref?.();
  }

  saveNow() {
    clearTimeout(this._saveTimer);
    try {
      atomicJSON(this.file, this.data, { space: 2 });
    } catch { /* shutdown path, best effort */ }
  }

  /** Panic/privacy reset: never let an old debounce resurrect wiped data. */
  reset() {
    clearTimeout(this._saveTimer); this._saveTimer = null;
    this.data = EMPTY();
  }

  _nextId(list) {
    return list.reduce((max, item) => Math.max(max, item.id ?? 0), 0) + 1;
  }

  addNote(text) {
    const note = { id: this._nextId(this.data.notes), text, ts: Date.now() };
    this.data.notes.push(note);
    this.save();
    return note;
  }

  deleteNote(id) {
    const before = this.data.notes.length;
    this.data.notes = this.data.notes.filter((n) => n.id !== id);
    this.save();
    return this.data.notes.length < before;
  }

  addTodo(text) {
    const todo = { id: this._nextId(this.data.todos), text, done: false, ts: Date.now() };
    this.data.todos.push(todo);
    this.save();
    return todo;
  }

  setTodoDone(id, done = true) {
    const todo = this.data.todos.find((t) => t.id === id);
    if (!todo) return null;
    todo.done = done;
    this.save();
    return todo;
  }

  deleteTodo(id) {
    const before = this.data.todos.length;
    this.data.todos = this.data.todos.filter((t) => t.id !== id);
    this.save();
    return this.data.todos.length < before;
  }

  clearDoneTodos() {
    const before = this.data.todos.length;
    this.data.todos = this.data.todos.filter((t) => !t.done);
    this.save();
    return before - this.data.todos.length;
  }

  addReminder(text, dueTs) {
    const reminder = { id: this._nextId(this.data.reminders), text, dueTs, createdTs: Date.now() };
    this.data.reminders.push(reminder);
    this.data.reminders.sort((a, b) => a.dueTs - b.dueTs);
    this.save();
    return reminder;
  }

  deleteReminder(id) {
    const before = this.data.reminders.length;
    this.data.reminders = this.data.reminders.filter((r) => r.id !== id);
    this.save();
    return this.data.reminders.length < before;
  }

  /** Reminders whose time has come; removes and returns them. */
  popDueReminders(now = Date.now()) {
    const due = this.data.reminders.filter((r) => r.dueTs <= now);
    if (due.length) {
      this.data.reminders = this.data.reminders.filter((r) => r.dueTs > now);
      this.save();
    }
    return due;
  }

  // ── scheduled JARVIS calls (/callat) ────────────────────────────────────
  addCallSchedule(text, dueTs) {
    if (!Array.isArray(this.data.callSchedules)) this.data.callSchedules = [];
    const item = { id: this._nextId(this.data.callSchedules), text: String(text ?? '').trim(), dueTs, createdTs: Date.now() };
    this.data.callSchedules.push(item);
    this.data.callSchedules.sort((a, b) => a.dueTs - b.dueTs);
    this.save();
    return item;
  }

  deleteCallSchedule(id) {
    if (!Array.isArray(this.data.callSchedules)) return false;
    const before = this.data.callSchedules.length;
    this.data.callSchedules = this.data.callSchedules.filter((s) => s.id !== id);
    this.save();
    return this.data.callSchedules.length < before;
  }

  /** Scheduled calls whose time has come; removes and returns them. */
  popDueCallSchedules(now = Date.now()) {
    if (!Array.isArray(this.data.callSchedules)) return [];
    const due = this.data.callSchedules.filter((s) => s.dueTs <= now);
    if (due.length) {
      this.data.callSchedules = this.data.callSchedules.filter((s) => s.dueTs > now);
      this.save();
    }
    return due;
  }

  // ── cron / scheduled recurring jobs ──────────────────────────────────────
  addCronJob(text, scheduleRaw, schedule, nextDueTs) {
    if (!this.data.cronJobs) this.data.cronJobs = [];
    const job = { id: this._nextId(this.data.cronJobs), text, scheduleRaw, schedule, nextDueTs, createdTs: Date.now(), lastRunTs: null };
    this.data.cronJobs.push(job);
    this.data.cronJobs.sort((a, b) => a.nextDueTs - b.nextDueTs);
    this.save();
    return job;
  }
  deleteCronJob(id) {
    const before = (this.data.cronJobs ?? []).length;
    this.data.cronJobs = (this.data.cronJobs ?? []).filter((j) => j.id !== id);
    this.save();
    return this.data.cronJobs.length < before;
  }
  listCronJobs() { return this.data.cronJobs ?? []; }

  // ── learned keywords ─────────────────────────────────────────────────────
  addLearned(keyword, commands, rawText) {
    if (!this.data.learned) this.data.learned = [];
    // overwrite if exists
    this.data.learned = this.data.learned.filter(e => e.keyword !== keyword);
    const entry = { id: this._nextId(this.data.learned), keyword, commands, rawText, createdTs: Date.now() };
    this.data.learned.push(entry);
    this.data.learned.sort((a,b) => a.keyword.localeCompare(b.keyword));
    this.save();
    return entry;
  }
  deleteLearned(keyword) {
    const before = (this.data.learned ?? []).length;
    this.data.learned = (this.data.learned ?? []).filter(e => e.keyword !== keyword);
    this.save();
    return this.data.learned.length < before;
  }
  getLearned(keyword) {
    const k = String(keyword ?? '').trim().replace(/^\/+/, '').toLowerCase();
    return (this.data.learned ?? []).find(e => e.keyword === k) ?? null;
  }
  listLearned() { return this.data.learned ?? []; }

  setLastOwnerTask(text) {
    const clean = String(text ?? '').trim();
    if (!clean) return;
    this.data.lastOwnerTask = clean.slice(0, 1200);
    this.save();
  }
  getLastOwnerTask() {
    return String(this.data.lastOwnerTask ?? '').trim();
  }

  pushHistory(role, content, maxTurns = 24) {
    this.data.history.push({ role, content: String(content).slice(0, 4000) });
    if (this.data.history.length > maxTurns) this.data.history = this.data.history.slice(-maxTurns);
    this.save();
  }

  clearHistory() {
    this.data.history = [];
    this.save();
  }

  addDownload(entry) {
    this.data.downloads.unshift(entry);
    this.data.downloads = this.data.downloads.slice(0, 100);
    this.save();
  }

  bump(counter) {
    this.data.stats[counter] = (this.data.stats[counter] ?? 0) + 1;
    this.save();
  }
}

/** Fires due reminders every 20 s through `send(text)`. Survives restarts (store is on disk). */
export function startReminderLoop(store, send, log = console) {
  const timer = setInterval(async () => {
    for (const reminder of store.popDueReminders()) {
      try {
        await send(`⏰ *Reminder:* ${reminder.text}`);
      } catch (err) {
        log.error?.(`[reminders] could not send reminder ${reminder.id}: ${err.message}`);
        store.addReminder(reminder.text, Date.now() + 60_000); // retry in a minute
      }
    }
  }, 20_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
