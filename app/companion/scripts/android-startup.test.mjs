import test from 'node:test';
import assert from 'node:assert/strict';
import { attachStableStartup } from '../e2e/android-startup.mjs';
const closed = () => new Error('Target page, context or browser has been closed');
test('startup recovery reattaches read-only probes only while the original process lives', async () => {
  let attaches = 0, probes = 0, aliveChecks = 0;
  const result = await attachStableStartup({ packageName: 'fixture', device: { async webView() { attaches++; return { async page() { return { id: attaches }; } }; } }, probe: async () => { if (++probes < 3) throw closed(); }, sameProcess: async () => { aliveChecks++; return true; }, delay: async () => {} });
  assert.equal(result.reattachments, 2); assert.equal(attaches, 3); assert.equal(aliveChecks, 2);
});
test('startup recovery cannot hide a native application crash or process replacement', async () => {
  let attaches = 0;
  await assert.rejects(attachStableStartup({ packageName: 'fixture', device: { async webView() { attaches++; throw closed(); } }, probe: async () => {}, sameProcess: async () => false, delay: async () => {} }), /closed/);
  assert.equal(attaches, 1);
});
test('startup assertions fail immediately rather than being retried into a pass', async () => {
  let attaches = 0;
  await assert.rejects(attachStableStartup({ packageName: 'fixture', device: { async webView() { attaches++; return { page: async () => ({}) }; } }, probe: async () => { assert.equal(false, true, 'bridge missing'); }, sameProcess: async () => true, delay: async () => {} }), /bridge missing/);
  assert.equal(attaches, 1);
});
test('persistent closed targets still fail after a bounded number of read-only probes', async () => {
  let attaches = 0;
  await assert.rejects(attachStableStartup({ packageName: 'fixture', device: { async webView() { attaches++; throw closed(); } }, probe: async () => {}, sameProcess: async () => true, delay: async () => {} }), /closed/);
  assert.equal(attaches, 3);
});
