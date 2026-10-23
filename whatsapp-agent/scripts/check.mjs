#!/usr/bin/env node
// Recursive syntax check, including neural workers and release scripts/tests.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let checked = 0, shell = 0, python = 0;
function check(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) check(file);
    else if (/\.(?:js|mjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status || 1);
      checked++;
    } else if (entry.name.endsWith('.sh')) {
      const result = spawnSync('bash', ['-n', file], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status || 1);
      shell++;
    } else if (entry.name.endsWith('.py')) {
      const result = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1],encoding="utf-8").read(), filename=sys.argv[1])', file], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status || 1);
      python++;
    }
  }
}
for (const dir of ['src', 'scripts', 'test', 'webapp']) check(path.join(root, dir));
const start = spawnSync('bash', ['-n', path.join(root, 'start.sh')], { stdio: 'inherit' });
if (start.status !== 0) process.exit(start.status || 1);
shell++;
console.log(`Syntax OK: ${checked} JavaScript, ${shell} shell, ${python} Python files (recursive; no execution).`);
