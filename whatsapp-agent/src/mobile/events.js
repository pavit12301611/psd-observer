import { randomBytes } from 'node:crypto';
import { records, short } from './records.js';
export function createEvents({ file, now = Date.now, push = null } = {}) {
  const db = records(file, { schema: 1, epoch: randomBytes(12).toString('hex'), sequence: 0, events: [] }, { maxBytes: 1024 * 1024 });
  if (db.value.schema !== 1 || !Array.isArray(db.value.events)) throw new Error('Invalid notification journal');
  const listeners = new Set();
  return {
    publish(type, text, extra = {}) {
      const event = { epoch: db.value.epoch, id: db.value.sequence + 1, uid: randomBytes(8).toString('hex'), type: short(type, 40), text: short(text, 1800), ts: now(), ...(extra.jobId ? { jobId: short(extra.jobId, 100) } : {}) };
      db.update((state) => ({ ...state, sequence: event.id, events: [...state.events, event].slice(-120) }));
      for (const fn of listeners) { try { fn(event); } catch { /* closed client */ } }
      // Push carries only a generic type/id. No private text/screenshots/keys.
      if (push && ['job_result', 'job_unknown', 'approval', 'reminder', 'watch', 'agent_notice'].includes(type)) Promise.resolve(push({ epoch: event.epoch, id: String(event.id), type: event.type })).catch(() => {});
      return event;
    },
    status: () => ({ epoch: db.value.epoch, latest: db.value.sequence }),
    list(after = 0) { return db.value.events.filter((e) => e.id > Number(after || 0)); },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    clear() { listeners.clear(); },
  };
}
