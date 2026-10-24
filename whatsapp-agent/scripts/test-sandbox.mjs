// Defense in depth for test fixtures, not an OS/container security boundary.
// Do not let accidental global fetches contact a live provider or Wikipedia.
// Tests can still replace fetch with explicit deterministic fixture functions.
import fs from 'node:fs';
import path from 'node:path';
if (!process.env.OBSERVER_TEST_SANDBOX) throw new Error('Tests require an isolated workspace');
// Each Node test file runs in a separate process, but previously inherited the
// SAME TMPDIR. A /shots clean fixture could sweep a concurrent capture from
// another suite. Isolate worker temp namespaces without serializing tests or
// relaxing screenshot/cleanup assertions (children inherit this private dir).
const workerTmp = path.join(process.env.OBSERVER_TEST_SANDBOX, 'tmp', `worker-${process.pid}`);
fs.mkdirSync(workerTmp, { recursive: true, mode: 0o700 });
for (const name of ['TMPDIR', 'TMP', 'TEMP']) process.env[name] = workerTmp;
const originalFetch = globalThis.fetch;
globalThis.fetch = function fixtureFetch(input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) {
    return Promise.reject(new Error('Test sandbox blocks external fetch; use an injected fixture'));
  }
  return originalFetch(input, init);
};
