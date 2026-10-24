import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { root, testEnvironment } from './test-workspace.mjs';

test('parallel capture/cleanup fixtures detect a shared-temp race and pass with private worker namespaces', () => {
  const base = path.join(root, '.cache'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'worker-tmp-proof-'));
  try {
    for (const name of ['tmp', 'home', 'home/.config', 'home/.cache', 'home/.local/share']) fs.mkdirSync(path.join(dir, name), { recursive: true });
    const files = ['a', 'b'].map((id) => {
      const file = path.join(dir, id + '.test.mjs');
      fs.writeFileSync(file, `import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
        test('fixture ${id}',async()=>{
          const root=process.env.OBSERVER_TEST_SANDBOX;
          const capture=path.join(os.tmpdir(),'observer-shot-1.png');
          fs.writeFileSync(capture,'${id}');
          fs.writeFileSync(path.join(root,'ready-${id}'),'ready');
          for(let n=0;!fs.existsSync(path.join(root,'ready-${id === 'a' ? 'b' : 'a'}'));n++){
            assert.ok(n<1000,'other worker never reached fixture barrier');await new Promise(r=>setTimeout(r,5));
          }
          assert.equal(fs.readFileSync(capture,'utf8'),'${id}','parallel suite must not overwrite/delete this capture');
          assert.equal(fs.statSync(os.tmpdir()).mode&0o777,0o700);
        });`);
      return file;
    });
    fs.chmodSync(path.join(dir, 'tmp'), 0o700);
    const execute = (isolated) => {
      for (const id of ['a', 'b']) fs.rmSync(path.join(dir, 'ready-' + id), { force: true });
      return spawnSync(process.execPath, [...(isolated ? ['--import', fileURLToPath(new URL('./test-sandbox.mjs', import.meta.url))] : []), '--test', '--test-reporter=tap', '--test-concurrency=2', ...files], { env: testEnvironment(dir), encoding: 'utf8', timeout: 15000 });
    };
    const red = execute(false);
    assert.equal(red.error, undefined); assert.notEqual(red.status, 0, 'negative control must detect the shared temp collision');
    assert.match(red.stdout, /parallel suite must not overwrite/);
    const green = execute(true);
    assert.equal(green.error, undefined); assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.match(green.stdout, /# pass 2/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
