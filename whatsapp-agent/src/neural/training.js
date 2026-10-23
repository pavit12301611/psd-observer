import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { dataDirectory, atomicJSON } from './storage.js';
import { validateCheckpoint, reloadBrain } from './index.js';
import { throwIfStopped, StoppedError } from '../cancel.js';

const running = new Set();
/** Install only a complete, compatible, quality-checked worker result. */
export function trainPersonalBrain({ dataDir, epochs = 90, seed = 42, signal, timeoutMs = 240_000 } = {}) {
  const dir = dataDirectory({ dataDir });
  throwIfStopped(signal, 'Neural training');
  if (running.has(dir)) return Promise.reject(new Error('Training already running for this data directory'));
  if (!Number.isInteger(epochs) || epochs < 1 || epochs > 500) return Promise.reject(new Error('Epochs must be 1..500'));
  running.add(dir);
  return new Promise((resolve, reject) => {
    let worker;
    let settled = false;
    let timer;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      running.delete(dir);
      worker?.terminate().catch(() => {});
      if (err) reject(err); else resolve(value);
    };
    const stop = () => finish(new StoppedError('Neural training'));
    try {
      // Plain ESM worker: parent CLI/V8/test flags are unnecessary and may be
      // rejected by Worker (notably Node 24's expanded test-runner defaults).
      worker = new Worker(new URL('./train-worker.js', import.meta.url), { workerData: { dataDir: dir, epochs, seed }, execArgv: [] });
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) return stop();
      timer = setTimeout(() => finish(new Error('Training timed out; previous checkpoint kept')), timeoutMs);
      worker.on('error', (err) => finish(err));
      worker.on('exit', (code) => { if (!settled) finish(new Error(`Training worker exited (${code}); previous checkpoint kept`)); });
      worker.on('message', ({ checkpoint, metrics }) => {
        if (settled) return;
        try {
          throwIfStopped(signal, 'Neural training');
          validateCheckpoint(checkpoint);
          if (metrics.intent.valHybrid.accuracy < 0.8 || metrics.intent.testHybrid.accuracy < 0.8
            || metrics.intent.testHybrid.macroF1 < 0.75 || metrics.match.val.accuracy < 0.75 || metrics.match.test.accuracy < 0.75) {
            throw new Error('Training quality gate failed (held-out accuracy/F1); previous checkpoint kept');
          }
          const file = path.join(dir, 'neural-weights.json');
          atomicJSON(file, checkpoint);
          reloadBrain({ dataDir: dir });
          finish(null, { file, metrics });
        } catch (err) { finish(err); }
      });
    } catch (err) { finish(err); }
  });
}
