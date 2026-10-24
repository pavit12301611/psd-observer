import { randomBytes } from 'node:crypto';
import { records, error, short, validId } from './records.js';
export const WORKFLOW_TOOLS = Object.freeze({ time: { command: '/time', risk: 'read' }, status: { command: '/status', risk: 'read' }, apps: { command: '/apps', risk: 'read' }, open: { command: '/open', risk: 'write' }, note: { command: '/note', risk: 'write' }, todo: { command: '/todo add', risk: 'write' }, remind: { command: '/remind', risk: 'write' } });
export function previewWorkflow(input) {
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 || !Array.isArray(input.steps) || !input.steps.length || input.steps.length > 8) throw error(400, 'Workflow needs a name and 1–8 supported steps');
  const steps = input.steps.map((s) => {
    const tool = s && WORKFLOW_TOOLS[s.tool]; if (!tool) throw error(400, 'Unsupported workflow step. Shell, approvals, nested workflows and arbitrary commands are forbidden.');
    const value = short(s.value, 1000);
    if (/[\r\n\0]/.test(value) || s.value?.length > 1000) throw error(400, 'Steps must be single-line bounded values');
    if (tool.risk === 'read' && value.trim()) throw error(400, 'Read-only step does not accept hidden arguments');
    if (tool.risk === 'write' && !value.trim()) throw error(400, 'This step needs an explicit value');
    return { tool: s.tool, value, command: `${tool.command}${value ? ' ' + value : ''}`, risk: tool.risk };
  });
  const trigger = input.trigger || { type: 'manual' };
  if (!['manual', 'daily'].includes(trigger.type) || trigger.type === 'daily' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(trigger.time || '')) throw error(400, 'Choose manual or an explicit daily HH:MM trigger');
  return { name: input.name.trim(), steps, trigger: trigger.type === 'daily' ? { type: 'daily', time: trigger.time } : { type: 'manual' }, notice: 'Preview only. No action executed. The original owner/PIN/confirmation gates always apply.' };
}
export function createWorkflows({ file, runOwner, pending = () => false, now = Date.now, timezone = 'Asia/Kolkata' } = {}) {
  const db = records(file, { schema: 1, workflows: [] });
  if (db.value.schema !== 1 || !Array.isArray(db.value.workflows)) throw new Error('Invalid workflow store');
  return {
    list: () => structuredClone(db.value.workflows),
    save(input) {
      const preview = previewWorkflow(input), id = input.id || randomBytes(12).toString('hex'); if (!validId(id)) throw error(400, 'Invalid workflow ID');
      db.update((state) => { if (!state.workflows.some((w) => w.id === id) && state.workflows.length >= 20) throw error(409, 'Workflow limit reached'); const old = state.workflows.find((w) => w.id === id); state.workflows = [...state.workflows.filter((w) => w.id !== id), { ...preview, id, createdAt: old?.createdAt || now(), lastDay: old?.lastDay || null }]; return state; });
      return db.value.workflows.find((w) => w.id === id);
    },
    remove(id) { db.update((state) => ({ ...state, workflows: state.workflows.filter((w) => w.id !== id) })); return { ok: true }; },
    async run(id, cancelled = () => false) {
      const workflow = db.value.workflows.find((w) => w.id === id); if (!workflow) throw error(404, 'Workflow not found');
      const validated = previewWorkflow(workflow), outputs = [];
      for (const step of validated.steps) {
        if (cancelled()) { outputs.push('Stopped before the next step.'); break; }
        if (pending()) { outputs.push('Approval is pending. Remaining steps were NOT started.'); break; }
        const reply = await runOwner(step.command, { source: 'app-workflow', confirmed: false });
        const text = typeof reply === 'string' ? reply : reply?.text || 'Agent returned no text.';
        outputs.push(`${outputs.length + 1}. ${step.command}\n${text}`);
        if (pending() || reply?.ok === false || /^(?:⚠|❌|🔒|⏳)/u.test(text)) { outputs.push('Paused for review. No remaining steps or automatic retries.'); break; }
      }
      return { ok: true, text: `Workflow: ${validated.name}\n\n${outputs.join('\n\n')}` };
    },
    scheduled() {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now())).map((p) => [p.type, p.value]));
      const day = `${parts.year}-${parts.month}-${parts.day}`, clock = `${parts.hour}:${parts.minute}`;
      return db.value.workflows.filter((w) => w.trigger?.type === 'daily' && w.trigger.time === clock && w.lastDay !== day).map((w) => ({ id: w.id, day }));
    },
    markScheduled(id, day) { db.update((state) => { const w = state.workflows.find((w) => w.id === id); if (w) w.lastDay = day; return state; }); },
  };
}
