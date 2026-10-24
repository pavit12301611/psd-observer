import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { failureDetails, annotation } from './ci-report.mjs';

test('CI report retains an early assertion block rather than only the passing log tail', () => {
  const tap = 'TAP version 13\nnot ok 1 - exact failing fixture\n  ---\n  error: expected real result\n  stack: |\n    fixture.js:10\n  ...\n# Subtest: later test\nok 2 - later test\n' + 'ok 3 - passing tail\n'.repeat(1000);
  const text = failureDetails(tap);
  assert.match(text, /exact failing fixture/); assert.match(text, /expected real result/); assert.match(text, /fixture.js:10/); assert.doesNotMatch(text, /passing tail/);
});
test('CI annotation escapes control characters and bounds diagnostics', () => {
  assert.equal(annotation('100%\r\n::warning::not a new command'), '100%25%0D%0A::warning::not a new command');
  assert.ok(failureDetails('not ok 1 - '+ 'a'.repeat(60000)).length <= 45000);
  assert.match(failureDetails('Error: import failed'), /import failed/);
});
test('CI wrapper preserves a failing exit code and the intended assertion annotation', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./ci-report.mjs', import.meta.url)), process.execPath, '-e', "console.log('not ok 1 - fixture failure\\n  error: actual assertion');process.exitCode=7"], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true' } });
  assert.equal(result.status, 7); assert.match(result.stderr, /::error title=Agent test failure details::not ok 1 - fixture failure%0A  error: actual assertion/);
});
test('CI wrapper does not emit failure annotations for a passing command', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./ci-report.mjs', import.meta.url)), process.execPath, '-e', "console.log('ok 1 - fixture')"], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true' } });
  assert.equal(result.status, 0); assert.doesNotMatch(result.stderr, /::error/);
});
