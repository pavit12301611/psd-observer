#!/usr/bin/env node
// Keep real test semantics/exit codes, but make Playwright failures visible
// through GitHub check annotations. This repo's CI log storage is not always
// readable from automation, and an annotation always is.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ANSI = /\u001b\[[0-9;]*m/g;

/** Pull the interesting part of a Playwright run: failing tests + their errors. */
export function failureDetails(output, limit = 24000) {
  const lines = String(output).replace(ANSI, '').split('\n');
  // Playwright prints "  1) [project] › file:line › title" followed by the
  // error and the call log. That detail block is what a human needs, so it wins
  // over the run list at the top.
  const detail = /^\s{1,3}\d+\)\s/;
  const firstDetail = lines.findIndex((l) => detail.test(l));
  if (firstDetail !== -1) {
    const summaryIndex = lines.findIndex(
      (l, i) => i > firstDetail && /^\s*\d+ (?:failed|passed|flaky|skipped)/.test(l),
    );
    const body = lines.slice(firstDetail, summaryIndex === -1 ? firstDetail + 400 : summaryIndex + 3);
    return body.join('\n').trim().slice(0, limit);
  }
  const blocks = [];
  const starts = /^\s*(?:✘|✗|Error:|Test timeout)/;
  for (let i = 0; i < lines.length; i++) {
    if (!starts.test(lines[i])) continue;
    const block = [lines[i]];
    for (let j = i + 1; j < lines.length && j < i + 40; j++) {
      if (starts.test(lines[j]) || /^\s*(?:\d+ failed|Running \d+ tests)/.test(lines[j])) break;
      block.push(lines[j]);
    }
    blocks.push(block.join('\n').trimEnd());
    if (blocks.length >= 12) break;
  }
  const summary = lines.filter((l) => /^\s*\d+ (?:failed|passed|flaky|skipped)/.test(l));
  const body = blocks.length ? `${blocks.join('\n\n')}\n\n${summary.join('\n')}` : lines.slice(-12000).join('\n');
  return body.trim().slice(0, limit);
}

export const annotation = (text) =>
  String(text).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

export async function run(command, args = [], env = process.env) {
  let output = '';
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const append = (chunk, sink) => {
    sink.write(chunk);
    output = (output + chunk).slice(-4 * 1024 * 1024);
  };
  child.stdout.on('data', (d) => append(d, process.stdout));
  child.stderr.on('data', (d) => append(d, process.stderr));
  let failedToStart = false;
  child.once('error', (e) => {
    failedToStart = true;
    output += `\n${e.message}`;
  });
  const code = await new Promise((resolve) =>
    child.once('close', (status) => resolve(failedToStart ? 1 : status ?? 1)),
  );
  if (code !== 0 && env.GITHUB_ACTIONS === 'true')
    console.error(`::error title=Companion test failure details::${annotation(failureDetails(output))}`);
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error('Command required');
    process.exitCode = 2;
  } else process.exitCode = await run(command, args);
}
