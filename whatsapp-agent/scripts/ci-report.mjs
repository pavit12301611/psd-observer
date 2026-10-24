#!/usr/bin/env node
// Keep real test semantics/exit codes, but make TAP failures visible through
// GitHub check annotations even when the binary log-storage host is blocked.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export function failureDetails(output, limit = 45000) {
  const clean = String(output).replace(/\u001b\[[0-9;]*m/g, '');
  const lines = clean.split('\n'), blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*not ok \d+\b/.test(lines[i])) continue;
    const block = [lines[i]];
    for (let j = i + 1; j < lines.length && j < i + 85; j++) {
      if (/^(?:# Subtest:|(?:ok|not ok) \d+\b)/.test(lines[j])) break;
      block.push(lines[j]);
    }
    blocks.push(block.join('\n'));
  }
  return (blocks.length ? blocks.join('\n\n') : clean.slice(-18000)).slice(0, limit);
}
export function annotation(text) { return String(text).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A'); }
export async function run(command, args = [], env = process.env) {
  let output = '';
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const append = (chunk, sink) => { sink.write(chunk); output = (output + chunk).slice(-4 * 1024 * 1024); };
  child.stdout.on('data', (data) => append(data, process.stdout));
  child.stderr.on('data', (data) => append(data, process.stderr));
  let failedToStart = false;
  child.once('error', (e) => { failedToStart = true; output += '\n' + e.message; });
  const code = await new Promise((resolve) => child.once('close', (status) => resolve(failedToStart ? 1 : status ?? 1)));
  if (code !== 0 && env.GITHUB_ACTIONS === 'true') console.error(`::error title=Agent test failure details::${annotation(failureDetails(output))}`);
  return code;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) { console.error('Command required'); process.exitCode = 2; }
  else process.exitCode = await run(command, args);
}
