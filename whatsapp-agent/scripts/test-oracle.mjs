// Run the Oracle tests in a public-source-only sandbox, never an owner's data.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { workspace, testEnvironment } from './test-workspace.mjs';
const mirror = workspace('oracle');
try {
  const result = spawnSync(process.execPath, ['--import', path.join(mirror.dir, 'scripts/test-sandbox.mjs'), '--test', path.join(mirror.dir, 'test/oracle-relay.test.js')], { cwd: mirror.dir, env: testEnvironment(mirror.dir), stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { mirror.cleanup(); }
