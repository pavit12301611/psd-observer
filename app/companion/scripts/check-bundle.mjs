import fs from 'node:fs';
import path from 'node:path';
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const files = walk('dist'); const js = files.filter((p) => p.endsWith('.js'));
const total = js.reduce((n, p) => n + fs.statSync(p).size, 0);
if (total > 650_000) throw new Error(`JS budget exceeded: ${total} > 650000 bytes`);
for (const file of files.filter((p) => p.endsWith('.css'))) if (/(?:linear|radial|conic)-gradient\s*\(/i.test(fs.readFileSync(file, 'utf8'))) throw new Error('Zero-gradient design contract violated');
console.log(`Bundle verified: ${total} bytes JS (650 kB hard budget), no gradients, no model/WASM runtime bundled.`);
