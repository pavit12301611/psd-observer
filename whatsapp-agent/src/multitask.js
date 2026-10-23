// Bounded answer/read concurrency + explicit serialized action barriers.
// Lane decisions are a hard command allowlist, NEVER a neural prediction.
import { isStopCommand, isStoppedError, throwIfStopped } from './cancel.js';

const READ_ONLY = new Set(['help', 'commands', 'ping', 'status', 'time', 'date', 'agents', 'brains', 'access']);
const SERIAL = new Set(['open', 'close', 'mkdir', 'note', 'todo', 'remind', 'remember', 'rm', 'kill']);
export const MAX_BATCH_TASKS = 8;
export const concurrencyLimit = (n) => Math.max(1, Math.min(4, Number.isFinite(Number(n)) ? Math.floor(Number(n)) || 2 : 2));

/** Split || outside code fences, inline code, and quoted strings. */
export function splitBatch(raw) {
  const text = String(raw ?? '').trim();
  if (!text || text.length > 16000) throw new Error('Batch needs 1..16000 characters');
  const parts = [];
  let start = 0, quote = '', fence = false, inline = false;
  for (let i = 0; i < text.length; i++) {
    if (!quote && text.slice(i, i + 3) === '```') { fence = !fence; i += 2; continue; }
    if (fence) continue;
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '`') { inline = !inline; continue; }
    if (inline) continue;
    // Apostrophes inside don't/owner's are not quote delimiters.
    if (c === '"' || (c === "'" && !/[\p{L}\p{N}]/u.test(text[i - 1] ?? ''))) { quote = c; continue; }
    if (text.slice(i, i + 2) === '||') {
      parts.push(text.slice(start, i).trim()); start = i + 2; i++;
    }
  }
  if (quote || fence || inline) throw new Error('Close quotes/code fences before separating tasks with ||');
  parts.push(text.slice(start).trim());
  if (parts.some((p) => !p) || parts.length > MAX_BATCH_TASKS) throw new Error('Use 1..8 non-empty tasks separated by ||');
  return parts;
}

export function parseBatch(raw) {
  const parts = splitBatch(raw);
  // /stop in ANY position wins before any work starts.
  if (parts.some(isStopCommand)) return { stop: true, tasks: [] };
  const tasks = parts.map((text) => {
    const slash = text.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)\s*([\s\S]*)$/);
    const cmd = slash?.[1].toLowerCase();
    const args = slash?.[2].trim() ?? text;
    if (!slash && text.startsWith('/')) throw new Error('Invalid slash command in batch');
    if (!slash || cmd === 'ask' || cmd === 'ai') {
      if (!args) throw new Error('/ask needs a question');
      return { kind: 'answer', lane: 'parallel', cmd: 'ask', args, text };
    }
    if (READ_ONLY.has(cmd) && !args) return { kind: 'command', lane: 'parallel', cmd, args, text };
    if (cmd === 'pc' && /^(?:volume|brightness)(?:\s+(?:get|set|up|down|mute|unmute|[0-9]{1,3})(?:\s+[0-9]{1,3})?)?$/i.test(args)) {
      return { kind: 'command', lane: 'serial', cmd, args, text };
    }
    if (SERIAL.has(cmd)) return { kind: 'command', lane: 'serial', cmd, args, text };
    throw new Error(`/${cmd} is not batch-safe. Run it separately; approvals, shell, nested batches and media are never auto-batched.`);
  });
  return { stop: false, tasks };
}

/** Each worker gets detached data, no persistence or shared history writes. */
export function conversationSnapshot(store) {
  return { data: structuredClone(store?.data ?? {}), save() {}, saveNow() {}, pushHistory() {} };
}

const failedReply = (v) => v?.ok === false || (typeof v === 'string' && /^(?:⚠|❌|🔒|⛔|⏳|🤖 I don't know)/u.test(v));
export async function runBatch(tasks, { run, concurrency = 2, signal, shouldPause = () => false, onUpdate = () => {} } = {}) {
  const entries = tasks.map((task, i) => ({ task, index: i, status: 'queued', value: null, ms: 0 }));
  let halted = '', active = 0;
  const update = () => onUpdate({ entries, running: active, halted });
  const execute = async (index) => {
    if (signal?.aborted || halted) return;
    const entry = entries[index], started = Date.now();
    entry.status = 'running'; active++; update();
    try {
      throwIfStopped(signal, 'Batch');
      const value = await run(entry.task, index);
      throwIfStopped(signal, 'Batch');
      entry.value = value;
      entry.status = failedReply(value) ? 'failed' : 'completed';
      if (shouldPause(value)) { entry.status = 'waiting'; halted = 'confirmation'; }
      else if (entry.status === 'failed') halted = 'failure';
    } catch (err) {
      entry.status = isStoppedError(err) || signal?.aborted ? 'cancelled' : 'failed';
      entry.value = { ok: false, text: entry.status === 'cancelled' ? 'Stopped (/stop)' : String(err?.message ?? err) };
      halted = entry.status === 'cancelled' ? 'stopped' : 'failure';
    } finally {
      active--; entry.ms = Date.now() - started; update();
    }
  };
  for (let cursor = 0; cursor < tasks.length && !halted && !signal?.aborted;) {
    if (tasks[cursor].lane === 'serial') { await execute(cursor++); continue; }
    const start = cursor;
    while (cursor < tasks.length && tasks[cursor].lane === 'parallel') cursor++;
    const end = cursor;
    let next = start;
    await Promise.all(Array.from({ length: Math.min(concurrencyLimit(concurrency), end - start) }, async () => {
      while (next < end && !halted && !signal?.aborted) { const index = next++; await execute(index); }
    }));
  }
  if (signal?.aborted) halted = 'stopped';
  for (const entry of entries) if (entry.status === 'queued') entry.status = 'skipped';
  update();
  return { entries, halted, stopped: halted === 'stopped' };
}

export function batchSummary(result) {
  const entries = result?.entries ?? [];
  const count = (status) => entries.filter((e) => e.status === status).length;
  const heading = `🧩 Batch: ${count('completed')}/${entries.length} completed · ${count('failed')} failed · ${entries.length - count('completed') - count('failed')} not completed`;
  const parts = entries.map((e) => {
    const icon = { completed: '✅', failed: '❌', skipped: '⏭', cancelled: '⏹', waiting: '🔒', queued: '⏳', running: '⚡' }[e.status];
    const body = e.status === 'skipped' ? 'Not started.' : typeof e.value === 'string' ? e.value : e.value?.text ?? '';
    return `${icon} ${e.index + 1}. /${e.task.cmd} [${e.status}]${body ? `\n${body}` : ''}`;
  });
  if (result?.halted === 'confirmation') parts.push('🔒 Confirmation needed. Remaining tasks were NOT started or auto-approved. Confirm separately; submit skipped tasks again only if still needed.');
  if (result?.halted === 'failure') parts.push('⚠️ Stopped starting new tasks after a failure. Already-running independent answers were allowed to settle; nothing is retried automatically.');
  return [heading, ...parts].join('\n\n');
}
