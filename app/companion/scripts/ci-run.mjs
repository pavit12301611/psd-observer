// Preserve the real exit status and surface native build diagnostics as check
// annotations, which remain readable even when artifact/log hosts are blocked.
import { spawn } from 'node:child_process';
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Command required');
let tail = '';
const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
for (const [stream, out] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) stream.on('data', (data) => { out.write(data); tail = (tail + data).slice(-18000); });
child.once('error', (error) => { console.error(`::error title=Native command failed::${String(error.message).replaceAll('%', '%25').replaceAll('\n', '%0A').replaceAll('\r', '%0D')}`); process.exitCode = 1; });
child.once('close', (code) => {
  if (code !== 0) { const clean = tail.replace(/\u001b\[[0-9;]*m/g, '').replaceAll('%', '%25').replaceAll('\n', '%0A').replaceAll('\r', '%0D'); console.error(`::error title=Native build diagnostics::${clean}`); }
  process.exitCode = code ?? 1;
});
