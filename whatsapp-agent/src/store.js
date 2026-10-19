// store.js — persistence with zero infrastructure: one JSON file, atomic writes.
// (The cloud version needed Redis + R2 for this; a single-user agent does not.)
import fs from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({
  notes: [],          // {id, text, ts}
  todos: [],          // {id, text, done, ts}
  reminders: [],      // {id, text, dueTs, createdTs}
  facts: {},          // /remember key -> value, injected into the AI prompt
  history: [],        // AI chat turns [{role, content}], trimmed
  downloads: [],      // received media [{file, kind, ts, caption}]
  pending: null,      // destructive action waiting for "haan"/"yes"
  stats: { received: 0, replied: 0, ignoredNonOwner: 0, startedAt: Date.now() },
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
      this.data = { ...EMPTY(), ...parsed, stats: { ...EMPTY().stats, ...(parsed.stats ?? {}) } };
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
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        fs.renameSync(tmp, this.file);
      } catch (err) {
        console.error('[store] save failed:', err.message);
      }
    }, 150);
    this._saveTimer.unref?.();
  }

  saveNow() {
    clearTimeout(this._saveTimer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch { /* shutdown path, best effort */ }
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
