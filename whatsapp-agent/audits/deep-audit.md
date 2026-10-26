# Deep test audit — 3.13.0

Generated 2026-10-26T09:15:04.328Z. Source tree SHA-256: `9a1901f0c3ba8fa95db92bf99f4e1462733a893f2ea51bbe9b13a763e745e1a0`.

## Scope, honestly

161 runtime JavaScript modules (backend + browser shell), 48610 lines, **3648 static function definitions** inventoried; 41 recursively discovered Node test suites. Every definition has a file/span in [deep-audit.json](deep-audit.json). Exact AST/V8 span matches have call counts; unmapped spans remain unknown. This is not a claim that every function was manually proved correct.

Other repository components and live WhatsApp/providers/desktop hardware were **not** exhaustively tested. The runner mirrors public source, isolates HOME/TMP/data, strips credentials and desktop addresses, and blocks default external fetch; it is defense in depth, **not an OS sandbox**.

## Full-source execution coverage

Backend comparison (same source scope):

| Metric | Baseline | Current |
|---|---:|---:|
| lines | 74.84% | 75.51% |
| branches | 62.53% | 64.51% |
| functions | 76.31% | 76.66% |

Browser shell (newly included): 43.32% lines / 62.14% branches / 50% functions. All-runtime combined: 74.65% lines / 64.48% branches. Browser tests are DOM/service-worker emulation, not real-browser or hardware validation.

Includes unimported runtime files via c8 `--all`; no blanket 100% claim. Baseline: 477 tests, ref `339bc9e`. See [baseline evidence](baseline-3.9.0.json). The 34 targeted baseline regression failures overlap multiple symptoms of the same bugs; they are **not 34 distinct bugs**.

## Executed validation

- **v22.22.3** (coverage): 657/657 passed, 0 failed, 0 cancelled, 0 skipped.
- **v22.22.3** (full): 657/657 passed, 0 failed, 0 cancelled, 0 skipped.

Original backend instrumenter: c8 10.1.3; current: c8 12.0.0 / V8. New browser coverage is reported separately; differing V8/instrumenter versions and source changes limit direct numerical comparisons.

## Tests that detect faults, not just execute lines

Unmutated control passed; **18/18 selected injected faults detected** by intended named assertions. These are targeted mutations, not a whole-program mutation score. Full per-candidate evidence is in the JSON. Property tests use seed `0x503d`, reference models, shrunk counterexamples, bounded schedule generation and finite-difference gradients.

## High-risk modules

| Module | Lines | Branches | Functions |
|---|---:|---:|---:|
| `src/agentprotocol.js` | 95.68% | 85.98% | 100% |
| `src/allowlist.js` | 97.64% | 74.28% | 83.33% |
| `src/fastcache.js` | 100% | 97.82% | 87.5% |
| `src/guard.js` | 94.2% | 72.22% | 85.71% |
| `src/livemirror.js` | 100% | 91.17% | 100% |
| `src/multitask.js` | 100% | 82.19% | 100% |
| `src/neural/nn.js` | 100% | 96.27% | 100% |
| `src/neural/text.js` | 99.23% | 82.35% | 92.85% |
| `src/persistence.js` | 100% | 85.71% | 100% |
| `src/rollback.js` | 98.55% | 73.58% | 100% |
| `src/safety.js` | 96.95% | 73.68% | 91.66% |
| `src/server.js` | 77.46% | 65.3% | 59.52% |
| `src/store.js` | 85.42% | 73.03% | 78.78% |

## Remaining execution gaps for the next audit cycle

- `src/index.js`: 0% lines, 0% branches.
- `src/mcp-server.js`: 0% lines, 0% branches.
- `webapp/desktop.js`: 0% lines, 0% branches.
- `src/systemx.js`: 23.48% lines, 100% branches.
- `src/imap.js`: 31.16% lines, 22.22% branches.
- `src/ocr.js`: 33.82% lines, 100% branches.
- `src/whatsapp.js`: 37.77% lines, 45.16% branches.
- `src/reach.js`: 39.2% lines, 45.81% branches.
- `webapp/app.js`: 43.89% lines, 56.66% branches.
- `src/location.js`: 45.99% lines, 39.25% branches.
- `src/cron.js`: 50.96% lines, 44.11% branches.
- `src/mobile/assets.js`: 55.88% lines, 50% branches.

Hardware, real permissions/portals, actual WhatsApp sessions, live provider quotas/quality and remote-service failures still need dedicated integration environments. Successful command exit is not proof of a physical desktop outcome. PANIC unlinks local selected files and resets owner state; it cannot securely erase disks or retract remote/backed-up copies.

## Reproduce

Run `npm ci`, then `npm run test:deep`. `npm run test:contracts` runs only the added contract suites. `npm run verify:bundle` checks all archive members without extracting them. Raw coverage HTML is `coverage/index.html` (ignored); persistent source/function evidence is in this directory. Node 20.19+, 22 and 24 are configured in CI; see DEEP-TESTING.md for which runtimes were actually exercised locally.
