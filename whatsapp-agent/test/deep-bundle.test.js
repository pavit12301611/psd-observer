import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root } from '../scripts/test-workspace.mjs';
import { inventory } from '../scripts/function-inventory.mjs';

test('deep/packaging: nine adversarial archive checks pass without extracting or executing members', () => {
  const result = spawnSync('python3', [path.join(root, 'test/bundle_verifier_test.py')], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stderr, /Ran 9 tests/);
});

test('deep/inventory: declarations, methods, closures and arrow functions have source spans without executing code', () => {
  const source = 'export function add(a,b){ return a+b; }\nexport class API { method(){ return [1].map(x=>x+1); } }\nexport const arrow = async (x)=>x;\nthrow new Error("never execute");';
  const rows = inventory(source);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => row.name), ['add', 'API.method', `anonymous@2:${source.split('\n')[1].indexOf('x=>')}`, 'arrow']);
  assert.equal(rows.find((row) => row.name === 'arrow').async, true);
  assert.ok(rows.every((row) => row.exportContext && row.line > 0 && row.endLine >= row.line));
  assert.throws(() => inventory('function {'), SyntaxError);
});
