# Deep testing — 3.9.1 candidate

This round audits the **WhatsApp agent and its phone browser shell**, not every component of the monorepo. The generated [audit summary](audits/deep-audit.md) and [machine-readable function inventory/evidence](audits/deep-audit.json) are the source of exact measurements. [Historical RED stages](audits/regressions.json) preserve the overlapping failure names and counts. An inventory of every static function is **not** a manual semantic proof of every function.

## Executed local validation

<!-- LOCAL-VALIDATION-START -->
Validated on 2026-10-23 (Linux x64), against source-tree SHA-256 `4510d1da2c2a3d62042cb5c9f307edef7642c1cfe222a6624ac7e337ffa66677`.

| Actual runtime | Mode | Result |
|---|---|---|
| v20.20.2 | Full suite | 560/560 passed; 0 failed, 0 skipped |
| v22.22.3 | Full suite + c8 coverage | 560/560 passed; 0 failed, 0 skipped |
| v24.22.1 | Full suite | 560/560 passed; 0 failed, 0 skipped |

- **83 added contract tests** pass; total increased **477 → 560**, across **35** Node suite files.
- **18/18 selected mutations detected**, with 83/83 passing unmutated control tests on v24.22.1.
- Recursive syntax: **193 JavaScript, 11 Bash and 2 Python files**.
- npm audit (production + development + optional graph): **0 reported vulnerabilities**.
- **144 runtime modules / 3,300 AST function definitions** inventoried. These are not 3,300 manually verified functions.
- Backend coverage: **75.12% lines / 63.32% branches / 76.5% functions**.
- Phone browser coverage: **45.18% lines / 62.58% branches / 50.98% functions** (emulation only). Combined runtime lines: **74.31%**.
- Clean `npm ci --no-audit --no-fund` succeeded from the final lockfile.
- At the recorded local-validation time, GitHub CI had **not run remotely** and this candidate had not yet been committed or pushed. See the pull request Checks tab for subsequent CI results; opening a PR is not a deployment.
<!-- LOCAL-VALIDATION-END -->

Node test totals include one wrapper running **9 additional Python archive-adversarial cases**; those 9 are not counted as extra Node tests. Tests use fixture identities, synthetic owner data and disposable models/files. The public checkpoint is unchanged, verified against its recorded SHA-256; no live personal conversations or private production checkpoints were used.

## Reproduce safely

Use Python 3, Bash and a compatible Node release: **20.19+ in the 20.x line, 22.13+ in the 22.x line, or 24+**. These minima come from development dependencies; only the exact runtimes in the validation table were exercised here.

```bash
cd whatsapp-agent
npm ci --no-audit --no-fund
npm run check                 # recursive JS (including browser), Bash and Python parsing
npm test                      # complete, recursively discovered Node suite
npm run test:contracts        # only new deep-* suites; not a substitute for npm test
npm run test:coverage         # full suite; all src/**/*.js and webapp/**/*.js
npm run test:mutation         # unmutated control + selected independent fault injections
npm run audit:deps            # persist fresh npm audit JSON; nonzero on any reported severity
npm run audit:report          # requires successful coverage + mutation evidence for this source
npm run verify:bundle         # exact members/bytes/version/checkpoint; no extraction/execution
```

`npm run test:deep` combines syntax, full coverage, mutation checks, dependency audit and report generation. Coverage is in ignored `coverage/`; durable, reviewable evidence is in `audits/`. After changing public files or regenerating reports, run `npm run build:bundle` and `npm run verify:bundle` so the archive is not stale. CI verifies the checked-in bundle **before** regenerating timestamped audit reports.

Use `npm exec --yes --package=node@20 -- node scripts/test.mjs --test-concurrency=4` (or `node@24`) to run the complete suite on another installed Node line. The runner forces TAP on every supported line and persists structured results under `.cache/deep-audit/tests-*.json`. The audit generator rejects missing/failed coverage, changed runtime/input files or mismatching coverage/mutation evidence. It does not silently turn missing measurements into a pass.

### Isolation is defense in depth, not a sandbox

The runner creates a public-source mirror, never copies `.env`, owner `data/` or WhatsApp credentials, and isolates HOME/XDG/TMP. It strips provider credentials, desktop display/D-Bus addresses and caller `NODE_OPTIONS`; its preloaded fetch guard permits loopback fixtures only. Public source symlinks are rejected. Real state is never the test fixture.

**This is not OS/process/network isolation.** Raw socket/HTTP/subprocess APIs are not globally blocked. Plain ESM training workers deliberately do not inherit parent CLI/V8/test/preload flags (some are invalid for workers); worker code is local CPU/filesystem code. Review tests before running them with privileges or real desktop/session access. Never substitute real PANIC, shutdown, lock, deletion, WhatsApp or hardware callbacks for the fixture stubs.

## What was studied and tested

| Area | Evidence / adversarial conditions |
|---|---|
| Ownership, protocol and bridge | Exact owner equality, no suffix/LID bypass; scoped confirmations; blank/missing tokens fail closed; malformed/scalar/oversized HTTP bodies; schema depth and tiny prompt budgets. |
| Persistence and PANIC | Malformed state normalization, exclusive private temporary files, partial-write failure injection, pending-save cancellation, memory/cache reset, real lock-method interface rather than a nonexistent method. |
| Trash and rollback | Traversal/absolute/empty names, no destination clobber, expired confirmation; recursive nested snapshots, integrity rejection, stale-source removal, mid-install recovery, source-change detection and honest pruning warnings. |
| Async devices and batches | Off/restart during capture, overlapping ticks, no stale sends; exclusive PC/write lanes, parallel read allowlist, stable ordering, pause/stop barriers and preserving a verified action even after cancellation. |
| Cache and neural logic | Reference-model LRU/TTL and key identity, negative zero, Unicode/custom dimensions, numerical backprop finite differences, indexed/dense equivalence, deterministic property tests and parent-worker flag compatibility. |
| Phone webapp | Actual entrypoint parsing and boot, login, chat HTML escaping, damaged cached-history shapes, late post-logout replies and old-session 401 responses, private/query-token route bypass, version-scoped public-asset reads/writes, event lifetime and Observer-only cache cleanup. |
| Test/release infrastructure | Recursive discovery, source/environment isolation, AST fixture accuracy, failed/missing execution-evidence rejection, location-independent source fingerprints, exact archive content and 9 malicious archive fixtures. |

Property tests use fixed seed `0x503d` (20541), with bounded generated cases/schedules, shrinkable counterexamples, reference models and finite-difference tolerances. DOM/service-worker emulation is **not a real-browser end-to-end test**.

### Evidenced fixes

- LRU replacement/TTL and memo-key identity errors; safe truncation for very small budgets; neural feature-cache key collisions across supported dimensions.
- Private atomic owner-state/checkpoint persistence and damaged-state normalization. PANIC now cancels pending store writes, clears loaded state and uses the existing PC lock interface. A stopped write cannot resurrect owner history.
- Trash restore no longer silently overwrites owner files or accepts path traversal. Rollback includes nested neural source, verifies hashes, stages replacement and recovers the prior tree if installation fails.
- Camera/live-mirror capture from an obsolete session cannot change a new session or claim ON after OFF; overlapping ticks are suppressed.
- Batch stop/pause prevents later starts without pretending that a completed real action never happened. PC/write work remains serialized and owner/confirmation gated.
- Blank bridge configuration fails closed; only valid bounded JSON objects reach owner code.
- Browser `app.js` contained an extra closing trailer, so the old backend-only syntax check missed a fatal browser parse error. After removing it, new DOM contracts reproduced corrupt-cache boot failures, late private chat persistence after logout and unrelated-cache deletion by the service worker. Those are now fixed; the shell cache was bumped for this update. Follow-up cache contracts also found cross-app cache reads, query-token caching and unsafe HTML fallback for missing scripts: only allowlisted public, query-free assets now enter the version-scoped cache, with writes extending the fetch event lifetime.
- Node 24 TAP execution exposed invalid parent CLI/V8 flags inherited by the training worker. A focused injected-flag test reproduced the same failure on Node 22; the plain ESM worker now starts with explicit empty `execArgv`. Quality gates, cancellation and atomic installation remain in place.
- Optional `sharp` and development coverage dependencies were updated; see the fresh dependency audit for the actual current vulnerability count. Zero registry findings are not proof of zero vulnerabilities.

The original targeted backend RED run had **33/52 failing contracts**, plus a separately reproduced PANIC failure. These overlap and are **not 34 distinct bugs**. Additional frontend/worker failures were reproduced in later stages. Some numerical/reference tests were already correct before fixes; passing them is not evidence that their underlying algorithm was previously broken.

## Reading the numbers honestly

- Original baseline: **477/477** tests at `339bc9e`, c8 **10.1.3**, backend-only coverage. Current coverage uses c8 **12.0.0** / V8. Runtime/source/instrumenter changes affect denominators; report backend and newly included browser coverage separately.
- `--all` includes runtime files the suite never imports. Unexecuted and partially executed functions remain visible; no claim of 100% coverage, correctness or security certification.
- AST and V8 count functions differently. Exact matching source spans receive call counts; unmatched spans are explicitly **unknown**, not silently marked covered/uncovered. Generated/embedded code, native code and external model internals are not exhaustively inventoried.
- A mutation is detected only after its source parses and an intended named assertion fails. Timeouts, syntax/import errors and unrelated failures are **inconclusive**, not kills. The unmutated control must pass first. This is a selected fault set, **not whole-program mutation coverage**. An initial traversal mutant survived because a second no-clobber guard masked it; the fixture was corrected to test the guards independently.
- Local tests do not establish live-provider accuracy, latency, quotas or physical desktop success. This pass did not fine-tune a foundation model or re-establish earlier development-probe accuracy claims.

## Safety preserved and explicit limits

Owner provenance, PIN/permission checks and confirmation scopes remain mandatory. No automatic approval, destructive-action retry, sibling conversation leakage or shell/media batching was added. **Shades restores only on `/shades off`; no automatic restoration was added.**

PANIC performs selected local unlink/reset operations, **not secure disk erasure**. It cannot remove provider, remote, backup, filesystem-snapshot or already-sent copies; an already-started send may finish. Photo-index and screen-time records are outside its current wipe list. Atomic rename avoids torn JSON but is **not an fsync/power-loss durability guarantee**. No real PC lock or display change was executed in this environment.

## Remaining work / next audit cycle

1. Real Chromium/Firefox/mobile PWA runs: installation/update lifecycle, reconnect/logout races, file solving, voice/audio/camera permissions and cross-tab behavior. Current phone DOM coverage is partial and reported explicitly.
2. Dedicated Linux desktop fixtures for X11/Wayland/portals, audio, brightness, sleep/wake and actual lock/recovery. Never use an unmonitored production owner machine for destructive fault injection.
3. Opt-in staging WhatsApp/provider integrations with disposable accounts, quota/error/network simulation and independent accuracy evaluations. Production credentials and private training data were deliberately absent here.
4. Increase low-covered provider/media modules and perform broader independent mutation exploration. The generated report lists the lowest-covered modules.
5. Separate semantic/function audits for the Tauri/TypeScript desktop/mobile app, Rust CLI, Python API and other web projects. They were inventoried as repository components, not exhaustively tested in this pass. Cargo was unavailable in this environment.

The Node 20/22/24 CI workflow is configured with read-only permissions and evidence artifacts. A configuration file is not a remotely executed GitHub Actions result. This document records local validation; a pushed branch or open pull request does not establish a deployed or installed release.
