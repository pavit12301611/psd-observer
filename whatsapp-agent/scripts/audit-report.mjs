#!/usr/bin/env node
// Persist small, reproducible evidence; raw V8/HTML/logs remain ignored.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root, testFiles } from './test-workspace.mjs';
import { mutations } from './mutation-check.mjs';
import { inventory } from './function-inventory.mjs';
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = (data) => createHash('sha256').update(data).digest('hex');
const outDir = path.join(root, 'audits'); fs.mkdirSync(outDir, { recursive: true });
const final = read(path.join(root, 'coverage/coverage-final.json'));
const summary = read(path.join(root, 'coverage/coverage-summary.json'));
const baselineFile = path.join(root, '.cache/deep-audit/baseline-coverage/coverage-summary.json');
const baselineOut = path.join(outDir, 'baseline-3.9.0.json');
if (fs.existsSync(baselineFile) && !fs.existsSync(baselineOut)) {
  const old = read(baselineFile);
  const failed = ['red-regressions-corrected.log', 'red-panic.log'].flatMap((name) => {
    try { return fs.readFileSync(path.join(root, '.cache/deep-audit', name), 'utf8').split('\n').filter((line) => /^not ok /.test(line)).map((line) => line.replace(/^not ok \d+ - /, '')); } catch { return []; }
  });
  const files = Object.fromEntries(Object.entries(old).filter(([name]) => name !== 'total').map(([name, stats]) => [path.relative(root, name).split(path.sep).join('/'), stats]));
  fs.writeFileSync(baselineOut, JSON.stringify({ ref: '339bc9e7075acc89d2a21f88fc5340e1f51dfd6b', version: '3.9.0', node: 'v22.22.3', testCount: 477, instrumenter: 'c8 10.1.3 / V8', coverage: old.total, files, regressionFailures: failed, note: 'These overlapping failing contracts are not a count of distinct bugs; original coverage was recorded before runtime changes.' }, null, 2) + '\n');
}
const baseline = read(baselineOut);
const mutation = read(path.join(root, '.cache/deep-audit/mutations.json'));
const dependencies = read(path.join(root, '.cache/deep-audit/dependency-after.json'));
function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : entry.name.endsWith('.js') ? [file] : [];
  }).sort();
}
const files = [...sourceFiles(path.join(root, 'src')), ...sourceFiles(path.join(root, 'webapp'))].map((file) => {
  const source = fs.readFileSync(file, 'utf8'), relative = path.relative(root, file).split(path.sep).join('/');
  const measured = final[file];
  const measuredFunctions = Object.entries(measured?.fnMap ?? {}).map(([id, fn]) => ({ name: fn.name, ...fn.loc.start, endLine: fn.loc.end.line, endColumn: fn.loc.end.column, calls: measured.f[id] }));
  const functions = inventory(source).map((fn) => {
    const matches = measuredFunctions.filter((m) => m.line === fn.line && m.column === fn.column && m.endLine === fn.endLine && m.endColumn === fn.endColumn);
    return { ...fn, coverage: matches.length === 1 ? { calls: matches[0].calls, mapping: 'exact source span' } : { calls: null, mapping: 'unmapped; inspect instrumentedFunctions, do not infer executed/unexecuted' } };
  });
  if (!summary[file]) throw new Error(`Unmeasured source file: ${relative}; use full-source --all coverage`);
  return { path: relative, sha256: sha(source), lines: source.split('\n').length - 1, coverage: summary[file], functions, instrumentedFunctions: measuredFunctions };
});
function aggregate(selected) {
  return Object.fromEntries(['lines', 'statements', 'functions', 'branches'].map((key) => {
    const total = selected.reduce((n, f) => n + f.coverage[key].total, 0), covered = selected.reduce((n, f) => n + f.coverage[key].covered, 0);
    return [key, { total, covered, skipped: 0, pct: total ? Math.floor(10000 * covered / total) / 100 : 100 }];
  }));
}
const backend = aggregate(files.filter((f) => f.path.startsWith('src/'))), browser = aggregate(files.filter((f) => f.path.startsWith('webapp/')));
const treeHash = sha(files.map((f) => `${f.path}\0${f.sha256}`).join('\n'));
const evidenceDir = path.join(root, '.cache/deep-audit');
const executions = fs.readdirSync(evidenceDir).filter((name) => /^tests-(full|coverage)-node\d+\.json$/.test(name)).map((name) => read(path.join(evidenceDir, name))).filter((r) => r.sourceTreeSha256 === treeHash);
const validation = executions.find((r) => r.mode === 'coverage' && r.node === process.version);
if (!validation?.passed || !validation.sourceStable || validation.coverageSummarySha256 !== sha(fs.readFileSync(path.join(root, 'coverage/coverage-summary.json'))) || validation.coverageFinalSha256 !== sha(fs.readFileSync(path.join(root, 'coverage/coverage-final.json')))) throw new Error('Need successful, current-source coverage evidence from this Node runtime; run npm run test:coverage first.');
if (Object.entries(validation.inputHashes ?? {}).some(([file, digest]) => sha(fs.readFileSync(path.join(root, file))) !== digest)) throw new Error('Test inputs changed after validation; rerun coverage.');
if (mutation.sourceTreeSha256 !== treeHash || !mutation.control?.passed || mutation.total !== mutations.length || mutation.definitionsSha256 !== sha(JSON.stringify(mutations)) || mutation.killed !== mutation.total) throw new Error('Need successful mutation evidence matching this source tree.');
if (!dependencies.metadata?.vulnerabilities) throw new Error('Missing dependency audit metadata; run npm run audit:deps.');
const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), version: read(path.join(root, 'package.json')).version,
  sourceTreeSha256: treeHash,
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  scope: { component: 'whatsapp-agent', runtimeModules: files.length, sourceLines: files.reduce((n, f) => n + f.lines, 0), staticFunctionDefinitions: files.reduce((n, f) => n + f.functions.length, 0), testSuites: testFiles().length, backendModules: files.filter((f) => f.path.startsWith('src/')).length, browserModules: files.filter((f) => f.path.startsWith('webapp/')).length, outsideScope: ['Tauri/React desktop and mobile clients', 'Rust CLI', 'api backend', 'marketing/status/dashboard websites', 'live WhatsApp/provider/desktop/network integrations'], limitations: ['Inventory and syntax are not manual semantic verification of every function.', 'V8 function totals and AST function totals differ; unmatched spans are explicitly unknown.', 'Coverage is execution evidence, not correctness, security certification or real-provider accuracy.', 'Generated/embedded code, native dependencies and remote models are not exhaustively analysed.'] },
  baseline: { ref: baseline.ref, testCount: baseline.testCount, coverage: baseline.coverage, regressionFailures: baseline.regressionFailures },
  executions,
  coverage: backend, browserCoverage: browser, combinedCoverage: summary.total, selectedMutations: mutation,
  dependencyAudit: { vulnerabilities: dependencies.metadata?.vulnerabilities, scope: 'production + development + optional dependencies at audit time; not an OS vulnerability scan' },
  reviewedRiskAreas: ['owner authorization and bridge authentication/input limits', 'trash/restore and confirmed permanent deletion', 'recursive integrity-checked snapshot and staged recovery', 'owner-store shape, private atomic persistence and panic reset', 'camera/mirror lifecycle and concurrency races', 'batch ordering, exclusive barriers, failure/cancellation and truthful results', 'cache identity, TTL, eviction and transient failures', 'tool decoding, schema depth and prompt size boundaries', 'neural backprop finite differences, Unicode features and indexed/dense equivalence', 'isolated test discovery/environment and release packaging', 'phone shell parsing, cached chat shape, HTML text escaping and post-logout/old-session isolation', 'service-worker public-asset/query-token allowlist, version-scoped reads/writes and namespace-only cache eviction'],
  files,
};
fs.writeFileSync(path.join(outDir, 'deep-audit.json'), JSON.stringify(report, null, 2) + '\n');
const metrics = ['lines', 'branches', 'functions'];
const table = ['| Metric | Baseline | Current |', '|---|---:|---:|', ...metrics.map((key) => `| ${key} | ${baseline.coverage[key].pct}% | ${backend[key].pct}% |`)];
const risks = ['allowlist.js', 'server.js', 'store.js', 'persistence.js', 'safety.js', 'rollback.js', 'guard.js', 'livemirror.js', 'multitask.js', 'fastcache.js', 'agentprotocol.js', 'neural/text.js', 'neural/nn.js'];
const focus = files.filter((f) => risks.some((name) => f.path === `src/${name}`));
const rows = ['| Module | Lines | Branches | Functions |', '|---|---:|---:|---:|', ...focus.map((f) => `| \`${f.path}\` | ${f.coverage.lines.pct}% | ${f.coverage.branches.pct}% | ${f.coverage.functions.pct}% |`)];
const gaps = files.filter((f) => f.coverage.lines.total > 10).sort((a, b) => a.coverage.lines.pct - b.coverage.lines.pct).slice(0, 12);
const md = `# Deep test audit — ${report.version}\n\nGenerated ${report.generatedAt}. Source tree SHA-256: \`${treeHash}\`.\n\n## Scope, honestly\n\n${files.length} runtime JavaScript modules (backend + browser shell), ${report.scope.sourceLines} lines, **${report.scope.staticFunctionDefinitions} static function definitions** inventoried; ${report.scope.testSuites} recursively discovered Node test suites. Every definition has a file/span in [deep-audit.json](deep-audit.json). Exact AST/V8 span matches have call counts; unmapped spans remain unknown. This is not a claim that every function was manually proved correct.\n\nOther repository components and live WhatsApp/providers/desktop hardware were **not** exhaustively tested. The runner mirrors public source, isolates HOME/TMP/data, strips credentials and desktop addresses, and blocks default external fetch; it is defense in depth, **not an OS sandbox**.\n\n## Full-source execution coverage\n\nBackend comparison (same source scope):\n\n${table.join('\n')}\n\nBrowser shell (newly included): ${browser.lines.pct}% lines / ${browser.branches.pct}% branches / ${browser.functions.pct}% functions. All-runtime combined: ${summary.total.lines.pct}% lines / ${summary.total.branches.pct}% branches. Browser tests are DOM/service-worker emulation, not real-browser or hardware validation.\n\nIncludes unimported runtime files via c8 \`--all\`; no blanket 100% claim. Baseline: 477 tests, ref \`${baseline.ref.slice(0, 7)}\`. See [baseline evidence](baseline-3.9.0.json). The ${baseline.regressionFailures.length} targeted baseline regression failures overlap multiple symptoms of the same bugs; they are **not ${baseline.regressionFailures.length} distinct bugs**.\n\n## Executed validation\n\n${executions.map((r) => `- **${r.node}** (${r.mode}): ${r.pass}/${r.tests} passed, ${r.fail} failed, ${r.cancelled} cancelled, ${r.skipped} skipped.`).join('\n')}\n\nOriginal backend instrumenter: c8 10.1.3; current: c8 ${read(path.join(root, 'node_modules/c8/package.json')).version} / V8. New browser coverage is reported separately; differing V8/instrumenter versions and source changes limit direct numerical comparisons.\n\n## Tests that detect faults, not just execute lines\n\nUnmutated control passed; **${mutation.killed}/${mutation.total} selected injected faults detected** by intended named assertions. These are targeted mutations, not a whole-program mutation score. Full per-candidate evidence is in the JSON. Property tests use seed \`0x503d\`, reference models, shrunk counterexamples, bounded schedule generation and finite-difference gradients.\n\n## High-risk modules\n\n${rows.join('\n')}\n\n## Remaining execution gaps for the next audit cycle\n\n${gaps.map((f) => `- \`${f.path}\`: ${f.coverage.lines.pct}% lines, ${f.coverage.branches.pct}% branches.`).join('\n')}\n\nHardware, real permissions/portals, actual WhatsApp sessions, live provider quotas/quality and remote-service failures still need dedicated integration environments. Successful command exit is not proof of a physical desktop outcome. PANIC unlinks local selected files and resets owner state; it cannot securely erase disks or retract remote/backed-up copies.\n\n## Reproduce\n\nRun \`npm ci\`, then \`npm run test:deep\`. \`npm run test:contracts\` runs only the added contract suites. \`npm run verify:bundle\` checks all archive members without extracting them. Raw coverage HTML is \`coverage/index.html\` (ignored); persistent source/function evidence is in this directory. Node 20.19+, 22 and 24 are configured in CI; see DEEP-TESTING.md for which runtimes were actually exercised locally.\n`;
fs.writeFileSync(path.join(outDir, 'deep-audit.md'), md);
console.log(`Audit persisted: ${files.length} modules, ${report.scope.staticFunctionDefinitions} AST functions; coverage ${summary.total.lines.pct}% lines / ${summary.total.branches.pct}% branches.`);
