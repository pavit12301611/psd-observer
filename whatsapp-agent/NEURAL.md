# Neural v2 and safe multitasking — 3.9.0

Observer uses two **small local routing/matching networks**, plus whichever
external or local generative model you configure. Training these networks does
**not** train, replace or reproduce Grok, Claude or another foundation model.
No provider keys or GPU are needed for the local neural trainer.

## What changed

- IntentNet **406 → 64 → 12**, ReLU/softmax, backpropagation + Adam; MatchNet
  **13 → 16 → 1**, sigmoid. The shipped int8 checkpoint is about **86 KiB**.
- Sparse first-layer inference/backprop and an inverted-index cosine search:
  skip zero features rather than scanning every dimension of every example.
  Inference loading does not initialize random weights or optimizer tensors.
- Named intent scores fix specialist dispatch. Memory confidence belongs to
  its chosen label, not the probability of an unrelated neural prediction.
  Neural probabilities are temperature-scaled on validation data.
- Hindi combining marks survive normalization; English, Roman Hinglish and
  basic Devanagari intent examples share bilingual features.
- Only **explicit owner-approved labels** enter personal memory/training.
  Predictions are not ground truth. Old unverified auto-label rows are ignored,
  not silently promoted or deleted. Corrections invalidate both memory and the
  classification-result cache, and replace an older label for the same text.
- Strict feature/label/shape/finite-weight validation. A bad/old personal
  override falls through to the healthy shipped checkpoint. Atomic writes
  prevent readers seeing a partially written checkpoint.
- Answer cache keys include conversation, memory, model selection and mission;
  changing facts/history cannot return the old context's answer. Code case is
  preserved. History-save failure cannot cause another provider call.
- Fact matching ignores function-word overlap, enforces word boundaries and
  requires meaningful shared content. Unrelated stored facts are not promoted
  to grounding just because they share “of”, “are”, or “theory”.

## Measurements (local sandbox, not live-provider promises)

[`benchmarks/neural-v2.json`](benchmarks/neural-v2.json) contains the inputs,
checkpoint hash, machine information, all trial timings and limitations.
Baseline is commit `507d640` / version 3.8.1. Same harness, three fresh processes
per runtime, 1,000 unique warmups, 3,000 unique samples/path/trial, interleaved
runtime order; reported values are medians of the trial percentiles.

| Measurement | 3.8.1 | 3.9.0 |
|---|---:|---:|
| Unique routing p50 | 161.3 µs | 48.0 µs (~3.4× faster) |
| Unique routing p95 | 240.9 µs | 86.5 µs |
| kNN, prepared query vectors, p50 | 129.6 µs | 13.1 µs (~9.9× faster) |
| kNN p95 | 247.6 µs | 20.2 µs |
| Fixed 72-case routing probe | 55/72 (76.4%) | 68/72 (94.4%) |

The probe is a **developer-created regression set**, frozen before the upgrade;
its exact strings are not in curated/template training data. It is not a
certified production/general-answer accuracy estimate. We inspected failures
while developing the upgrade, so do not treat it as a blind external audit.

Separately, the trainer's **held-out int8 test** is **61/73 = 83.6%**,
macro-F1 **0.839**, using **train-only memory**. Validation is 91.8% (73 examples).
MatchNet's disjoint-target-group test is **84/101 = 83.2%**, precision 75.0%,
recall 67.7%. These numbers deliberately do not count runtime memorization of
all curated examples as “unseen accuracy”. Routing confidence is not factual
answer confidence.

Four synthetic 40ms answer jobs take about 162ms serial vs 81ms with two
workers. That demonstrates scheduler overlap, **not** actual WhatsApp/LLM
speed. Real response time/quality still depends on provider quotas, configured
model, network and the installed PC. No live provider or desktop actions were
benchmarked here.

## WhatsApp commands (owner only)

```text
/neural status
/neural labels
/neural classify write a typescript utility
/neural learn code | implement my custom widget helper
/neural train
/neural train 90
/retrain
```

`learn` accepts one of the 12 labels and a 1–300-character example. Memory
updates immediately; `/neural train` updates weights. Training runs in a CPU
**worker thread**, leaving the event loop and `/stop` responsive. Its complete
checkpoint is installed privately at `DATA_DIR/neural-weights.json`, then
reloaded without restarting. `/retrain` now actually does this work instead of
merely marking an unperformed job as trained.

Installation quality gates: intent validation/test ≥80%, test macro-F1 ≥0.75;
MatchNet validation/test ≥75%. Failure, cancellation or timeout keeps the
previous checkpoint. Test labels never select epochs or temperature; the
post-training deployment gate does check the fixed minimum test floor.

Answer corrections (`galat, asli jawab …`) remain explicit answer-lookup
rules, not invalid intent labels or language-model fine-tuning. A compound
answer/batch does not pick a guessed “last question” for a subsequent correction.

## Multiple tasks

```text
/batch /ask explain database snapshot isolation || /ask write a poem about a comet || /time
/batch /open chrome || /open code || /note prepare the demo
/batch /pc brightness 50 || /time
/batch status
/batch results
/taskstatus
/stop
```

- Up to **8** explicit tasks, separated with `||`; total input ≤16,000 characters.
  Quote or fence literal `||` inside code. Unclosed quotes/fences and empty
  parts are rejected **before any task starts**.
- **2 workers by default**, configurable with `MAX_PARALLEL_TASKS=1..4`.
  Text answers and no-argument `/help`, `/commands`, `/ping`, `/status`,
  `/time`, `/date`, `/agents`, `/brains`, `/access` may overlap.
- Explicit `/open`, `/close`, `/mkdir`, `/note`, `/todo`, `/remind`, `/remember`,
  `/rm`, `/kill`, and allowlisted `/pc volume|brightness` operations are
  **exclusive, serialized barriers**. They traverse the existing action,
  access/PIN and confirmation policies, never a neural permission guess.
- Obvious cross-task answer dependencies are rejected before any work; use
  one coherent `/ask` or `/agent` request instead. Snapshots after a serialized
  action include its newly committed owner state, without sharing writes.
- Shell, media, nested batches, unknown commands, `/yes`, `/approve`, `/go` and
  other approval/execution workflows are not batch-allowlisted. Use them
  separately. A bare action request cannot silently become a parallel chat.
- Pending confirmation pauses the batch; later tasks are **not** auto-approved,
  resumed or retried. Resolve it separately and resubmit only skipped work.
  A failure also prevents new starts; already-running independent answers
  settle. Every part reports completed/failed/waiting/skipped explicitly.
- `/stop` cancels provider/wiki requests and prevents queued starts. A `/stop`
  anywhere in a batch preempts the whole batch before the first action.
  Progress/status commands bypass the busy guard but not the owner firewall.
  `/batch results` retrieves completed/partial outputs, including work finished
  before a stop; it never resumes or repeats any task. Results last in memory
  until the next batch or process restart.
- Parallel answers are **text-only**: no arbitrary code execution, PC tools or
  full verification harness in those workers. Deterministic answers and
  knowledge grounding remain available. For dependent execution, use `/agent`;
  for compiler/Python/adversarial verification, use `/solve` or `/verify`.

Clear independent two-part questions also auto-dispatch to two specialists:

```text
/ask explain snapshot isolation and write a poem about a purple robot
```

Each receives its own sub-prompt, the original question as background (not a
second task to answer), and a detached conversation snapshot. Answers
stay in request order and produce **one** owner history/profile turn. Obvious
dependencies (“then”, “based on”, “about it”), quoted/code-block requests and
ambiguous connectors stay one job. Ordinary “light and sound” stays one question.
Separate new WhatsApp messages still use the global busy guard; this is explicit
bounded batching, not unlimited concurrent control of the same desktop.

Shades behavior is unchanged: no automatic screen restore, only `/shades off`.

## Data and reproducible training

- **491** curated labelled examples (including 120 new English/Hinglish/Hindi
  examples), **474** after split-key deduplication; 12 intents.
- **763** synthetic templates plus training-only noise augmentation. Normalized
  validation/test keys are excluded from augmented/template training.
- Seeded stratified **70/15/15** intent folds: 328 train / 73 validation / 73 test.
  Validation selects the best epoch and temperature; snapshots are deep copies.
  The shipped run selected epoch 36 of 54 (90 requested, real early stopping).
- **41** paraphrase groups / **136** queries; 29 train / 6 validation / 6 test
  groups, including hard wrong-target negatives. Targets/paraphrase groups are
  disjoint; casual negative queries can recur with different target groups.
- Deployment metrics are recomputed after the **actual int8 round-trip**, using
  the same weighted top-five memory decision code as inference.
- Public/release training excludes runtime conversations by default. Personal
  labels and weights stay private in the configured data directory. Do not
  commit them, even if you configure a custom directory outside ignored `data/`.

```bash
npm run train:neural                 # public corpus only; writes shipped weights
node scripts/train-neural.mjs --stats
node scripts/train-neural.mjs --runtime ./data --out ./data/neural-weights.json
npm run bench                       # current runtime; fresh-process load separately
node scripts/bench.mjs --json ./data/local-benchmark.json
node scripts/compare-neural.mjs --ref 507d640 --out ./data/comparison.json
npm run check                       # recursive JS syntax check, including neural workers
npm test                            # offline fixtures; no real desktop/provider needed
```

Comparison requires Git history and only reads the baseline with `git show`;
it never changes branches. Both runtimes are isolated from private data overrides. `npm run bench` also works from an installed bundle.
Training defaults to seed 42; wall time is CPU-dependent (~5s in this sandbox).

Key modules: `neural/nn.js` (MLP/serialization), `text.js` (features),
`decision.js` (indexed memory/shared blend), `train.js` (splits/evaluation),
`training.js` + `train-worker.js` (cancellable installation), `index.js` (runtime),
`multitask.js` (bounded scheduler), `agents.js` (specialist dispatch).
