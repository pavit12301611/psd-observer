// Read only the public HELP template as AST. Never execute agent code/config.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, '../../whatsapp-agent/src/commands.js'), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const node = ast.body.flatMap((n) => n.type === 'VariableDeclaration' ? n.declarations : []).find((n) => n.id.name === 'HELP');
if (node?.init?.type !== 'TemplateLiteral' || node.init.expressions.length) throw new Error('HELP must be a static public template');
const text = node.init.quasis.map((q) => q.value.cooked).join('');
const seen = new Set(); let section = 'Essentials'; const commands = [];
for (const raw of text.split('\n')) {
  const line = raw.replace(/[`*]/g, '').trim();
  if (!line) continue;
  if (!line.startsWith('•') && !line.startsWith('/')) { section = line.replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 100); continue; }
  const matches = [...line.matchAll(/(?:^|[\s·(])\/([a-z][a-z0-9_-]*)\b/gi)];
  for (const match of matches) {
    const name = '/' + match[1].toLowerCase(); if (seen.has(name)) continue; seen.add(name);
    const start = match.index + match[0].indexOf('/');
    const segment = line.slice(start).split(/\s+·\s+|\s+—\s+|\s+→\s+/)[0];
    commands.push({ name, section, description: line.replace(/^•\s*/, ''), usage: segment.slice(0, 180) });
  }
}
commands.sort((a, b) => a.name.localeCompare(b.name));
// The catalog is generated from the agent's public HELP, so anything the phone
// needs beyond that lives in runnable.json and is merged back in here. A
// regeneration therefore cannot silently drop the Run buttons.
let runnable = {};
try {
  runnable = JSON.parse(fs.readFileSync(path.join(root, 'src/data/runnable.json'), 'utf8')).commands || {};
} catch {
  throw new Error('src/data/runnable.json is missing or invalid; the Run buttons need it');
}
let runCount = 0;
for (const command of commands) {
  const run = runnable[command.name];
  if (typeof run !== 'string' || !run.startsWith(command.name)) continue;
  command.runnable = true;
  command.run = run;
  runCount++;
}
const stale = Object.keys(runnable).filter((name) => !commands.some((c) => c.name === name));
if (stale.length) throw new Error(`runnable.json lists commands the agent no longer publishes: ${stale.join(', ')}`);
fs.writeFileSync(path.join(root, 'src/data/commands.json'), JSON.stringify({ schemaVersion: 1, source: 'whatsapp-agent/src/commands.js public HELP', commands }, null, 2) + '\n');
console.log(`Catalog: ${commands.length} unique public commands, ${runCount} runnable read-only reports. Selecting a command only drafts it; never executes it.`);
