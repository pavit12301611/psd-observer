import { createHash } from 'node:crypto';
import { records, error, validId, short } from './records.js';
const terminal = new Set(['replied', 'unknown', 'cancelled', 'rejected']);
export function validateJob(body) {
  if (!body || !validId(body.id) || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 16000) throw error(400, 'Job needs a stable 8–100 character request ID and 1–16000 characters of text');
  if (!['chat', 'voice', 'workflow', 'solve', 'reference'].includes(body.kind || 'chat')) throw error(400, 'Unsupported job kind');
  const history = body.history ?? [];
  if (!Array.isArray(history) || history.length > 12 || history.some((m) => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 4000) || history.reduce((n, m) => n + m.content.length, 0) > 40000) throw error(400, 'Invalid bounded job context');
  if (body.projectId && !validId(body.projectId)) throw error(400, 'Invalid project ID');
  if (body.kind === 'voice' && (!validId(body.sessionId))) throw error(400, 'Voice session required');
  let upload = null;
  if (body.kind === 'solve') {
    const u = body.upload;
    if (!u || typeof u.base64 !== 'string' || u.base64.length > 11200000 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(u.base64) || Buffer.from(u.base64, 'base64').length > 8 * 1024 * 1024 || !/\.(?:pdf|docx|txt|png|jpe?g|webp)$/i.test(u.name || '')) throw error(400, 'A supported upload up to 8 MB is required');
    upload = { base64: u.base64, name: short(u.name, 180), mime: short(u.mime, 140) };
  }
  return { id: body.id, upload, text: body.text.trim(), kind: body.kind || 'chat', history: history.map(({ role, content }) => ({ role, content })), projectId: body.projectId || null, sessionId: body.sessionId || null };
}
export function createJobs({ file, run, events, busy = () => false, now = Date.now, resultTtl = 48 * 3600_000 } = {}) {
  const db = records(file, { schema: 1, jobs: [] });
  if (db.value.schema !== 1 || !Array.isArray(db.value.jobs)) throw new Error('Invalid mobile job journal');
  let active = null, closed = false; const volatileErrors = new Map();
  const stranded = db.value.jobs.some((j) => !terminal.has(j.state));
  if (stranded) db.update((state) => { for (const j of state.jobs) if (!terminal.has(j.state)) { j.state = 'unknown'; j.finishedAt = now(); j.result = { ok: false, text: 'Agent restarted while this request was pending. Outcome unknown; it was NOT replayed. Inspect before repeating.' }; } return state; });
  const publicJob = (j, withResult = true) => j ? ({ id: j.id, kind: j.kind, projectId: j.projectId, deviceId: j.deviceId, label: j.label, state: j.state, createdAt: j.createdAt, finishedAt: j.finishedAt || null, stopRequested: Boolean(j.stopRequested), ...(withResult && (j.result || terminal.has(j.state)) ? { result: j.result || {ok:false,text:'Detailed result retention expired; its safety receipt remains. Nothing was replayed.'} } : {}) }) : null;
  function write(id, patch) { db.update((state) => { const j = state.jobs.find((j) => j.id === id); if (j) Object.assign(j, patch); return state; }); }
  function publish(type, text, extra) { try { events?.publish(type, text, extra); } catch { /* a notification failure never retries a job */ } }
  return {
    submit(raw, principal = { id: 'owner' }) {
      const input = validateJob(raw), digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const old = db.value.jobs.find((j) => j.id === input.id);
      if (old) {
        if (old.fingerprint !== digest || old.deviceId !== principal.id) throw error(409, 'That request ID belongs to different content/device. Nothing was executed.');
        return { existing: true, job: publicJob(old) };
      }
      if (closed) throw error(503, 'Job dispatcher is shutting down');
      if (active || busy()) throw error(423, 'Another agent task is active. Wait/stop it; this request was not queued or executed.');
      // Persist BEFORE dispatch, even before returning 202. If storage fails no
      // action can start. A caller can GET this ID after any socket abort.
      const sensitive = /^\/(?:run|mail|key|keys|dsh)\b/i.test(input.text) || /^\/pc\s+\S+\s+\d{4,12}\b/i.test(input.text);
      const record = { id: input.id, kind: input.kind, projectId: input.projectId, deviceId: principal.id, fingerprint: digest, label: sensitive ? 'Private command' : short(input.text, 100), state: 'accepted', createdAt: now(), result: null };
      db.update((state) => { state.jobs = state.jobs.filter((j) => now() - j.createdAt < resultTtl); if(state.jobs.length>=2048) throw error(507,'Safety receipt capacity reached; no action was accepted. Wait for retention expiry or export/review records.'); for(const old of state.jobs.slice(0,-39))old.result=null; state.jobs.push(record); return state; });
      active = input.id;
      const started = Promise.resolve().then(async () => {
        if (closed) return;
        write(input.id, { state: 'running' }); publish('job_started', 'Your agent started a request.', { jobId: input.id });
        try {
          const result = await run(input, { principal, cancelled: () => Boolean(db.value.jobs.find((j) => j.id === input.id)?.stopRequested) });
          // Normalized app replies, never raw Buffer/controller/config objects.
          const current = db.value.jobs.find((j) => j.id === input.id);
          const state = result?.stopped ? 'cancelled' : 'replied';
          write(input.id, { state, finishedAt: now(), result: result ? { ...result, text: short(result.text, 48000) } : { ok: true, stopped: Boolean(current?.stopRequested), text: 'The agent returned no text. Inspect the task before repeating an action.' } });
          publish('job_result', current?.stopRequested ? 'A stopped request settled. Inspect the result; do not automatically repeat it.' : 'Your agent has a result ready.', { jobId: input.id });
        } catch (e) {
          try { write(input.id, { state: 'unknown', finishedAt: now(), result: { ok: false, text: `Request outcome could not be recorded normally: ${short(e.message, 500)}. Inspect before repeating; no retry was performed.` } }); } catch { /* persistent accepted/running marker becomes unknown after restart */ }
          publish('job_unknown', 'A request needs review. Its outcome is unknown.', { jobId: input.id });
        } finally { if (active === input.id) active = null; }
      });
      started.catch(() => { volatileErrors.set(input.id, { ...record, state: 'unknown', finishedAt: now(), result: { ok: false, text: 'The journal could not advance safely. No dispatch was retried; inspect before repeating.' } }); active = null; }); // fs failure before execution is never an unhandled rejection
      return { existing: false, job: publicJob(record) };
    },
    get(id) { return publicJob(volatileErrors.get(id) || db.value.jobs.find((j) => j.id === id)); },
    list() { return db.value.jobs.slice(-60).map((j) => publicJob(j, false)).reverse(); },
    requestStop(id) { const j = db.value.jobs.find((j) => j.id === id); if (!j) throw error(404, 'Job not found'); if (!terminal.has(j.state)) write(id, { stopRequested: true }); return publicJob(db.value.jobs.find((j) => j.id === id)); },
    get active() { return active; },
    close() { closed = true; },
  };
}
