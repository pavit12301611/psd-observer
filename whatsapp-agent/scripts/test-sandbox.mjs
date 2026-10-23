// Defense in depth for test fixtures, not an OS/container security boundary.
// Do not let accidental global fetches contact a live provider or Wikipedia.
// Tests can still replace fetch with explicit deterministic fixture functions.
if (!process.env.OBSERVER_TEST_SANDBOX) throw new Error('Tests require an isolated workspace');
const originalFetch = globalThis.fetch;
globalThis.fetch = function fixtureFetch(input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) {
    return Promise.reject(new Error('Test sandbox blocks external fetch; use an injected fixture'));
  }
  return originalFetch(input, init);
};
