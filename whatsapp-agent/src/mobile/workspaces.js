import { randomBytes } from 'node:crypto';
import { records, error, validId, short } from './records.js';
export function createWorkspaces({ file, now = Date.now } = {}) {
  const db = records(file, { schema: 1, projects: [{ id: 'personal00', name: 'Personal', description: 'Shared owner context', privateChat: false, memories: [], createdAt: now() }] });
  if (db.value.schema !== 1 || !Array.isArray(db.value.projects)) throw new Error('Invalid project store');
  return {
    list: () => structuredClone(db.value.projects),
    get(id) { const p = db.value.projects.find((p) => p.id === id); if (!p) throw error(404, 'Project not found'); return structuredClone(p); },
    save(input) {
      const id = input.id || randomBytes(12).toString('hex');
      if (!validId(id) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || typeof input.privateChat !== 'boolean') throw error(400, 'A project needs a name and explicit context mode');
      const memories = input.memories ?? [];
      if (!Array.isArray(memories) || memories.length > 30 || memories.some((m) => typeof m !== 'string' || m.length > 1000)) throw error(400, 'Project memory budget: 30 entries, 1000 characters each');
      db.update((state) => {
        const old = state.projects.find((p) => p.id === id);
        if (!old && state.projects.length >= 20) throw error(409, 'Project limit reached');
        const p = { id, name: input.name.trim(), description: short(input.description, 1200), privateChat: id === 'personal00' ? false : input.privateChat, memories: memories.filter(Boolean), createdAt: old?.createdAt || now(), updatedAt: now() };
        state.projects = [...state.projects.filter((p) => p.id !== id), p]; return state;
      });
      return this.get(id);
    },
    remove(id) {
      if (id === 'personal00') throw error(400, 'The personal owner workspace cannot be deleted');
      db.update((state) => ({ ...state, projects: state.projects.filter((p) => p.id !== id) })); return { ok: true };
    },
  };
}
