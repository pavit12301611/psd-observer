#!/usr/bin/env node
// Recursive syntax check, including neural workers and release scripts/tests.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let checked = 0;
function check(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) check(file);
    else if (/\.(?:js|mjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status || 1);
      checked++;
    }
  }
}
for (const dir of ['src', 'scripts', 'test']) check(path.join(root, dir));
console.log(`Syntax OK: ${checked} JavaScript files (recursive).`);
