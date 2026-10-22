# Neural — the trained brain 🧠

The chat brain now runs on a **real neural network** trained in pure JavaScript —
no Python, no TensorFlow, no cloud. Two tiny feed-forward networks ship as a
quantized checkpoint and upgrade every part of the agent: intent routing,
semantic knowledge matching, tone control, and continuous learning.

```
IntentNet   [406 → 32 → 12]  softmax   trained: val 86.0% (held-out handwritten Hinglish)
MatchNet    [ 13 → 16 → 1]   sigmoid   trained: val P 90.0% / R 73.0%
checkpoint  src/neural/weights.json     43 KB int8, auto-loaded at runtime
```

## What makes it a real network

| Property | Implementation |
|---|---|
| Learnable layers | Dense → ReLU → Dense → softmax/sigmoid |
| Training | Backpropagation + Adam optimizer + mini-batches |
| Regularization | L2 weight decay + gradient clipping + early stopping |
| Proof | Solves **XOR** (loss 0.8032 → 0.0003) — impossible for a linear model |
| Reproducibility | Seeded RNG everywhere — same seed, same weights |
| Deployment | int8 quantization (4× smaller, <1% accuracy loss) |

## Features (406 dims)

- **384 hash-ngram slots** — word uni/bi-grams + char 3-grams (handles "rnadhani"
  typos, "maja aa gaya")
- **22 CUE_FLAGS** — regex indicators: digit, mathop, qmark, wh-word, "kaise",
  "explain", "compare", praise, emotion, creative verbs, code words, greeting…
  This single addition took validation accuracy from **66.7% → 83.3%**
- **Bilingual lexicon** — "bharat/rajdhani" expand to "india/capital" so
  Hinglish and English land in the same feature space (cross-lingual matching
  scores 0.85–0.98 vs 0.07 for mismatches)

## Training data

- ~300 handwritten labelled examples (12 intent classes: greeting, gratitude,
  factual, comparison, howto, code, explain, emotional, creative, math,
  personal, misc_chat) — Hinglish heavy: *"yaar mood bahut off hai aaj"*
- **Template synthesis** (training only) — 756 fill-in variants teach
  topic/skill nouns
- 30 paraphrase groups × 103 queries for MatchNet + **OOD negatives** (casual
  chat × knowledge targets) so greetings never match "b r ambedkar"
- Runtime learning: every confident chat message becomes a labelled example
  (`data/neural-examples.json`, retrain to absorb)

## How the agent uses it

1. **Tone routing** (ai.js) — emotional messages get empathy-first instructions
   ("no fact dumps"), creative prompts get "deliver the piece first", code/howto
   get "lead with the working code". Fact dumps on a sad evening are gone.
2. **Semantic knowledge matching** (knowledge.js) — MatchNet scores
   query↔knowledge-key; *"bharat ki rajdhani batao"* now finds `india_capital`
   instantly. Guarded by content-word overlap + score bar so casual chat never
   hijacks.
3. **Wiki gate** (wiki.js) — the IntentNet decides when a question is
   factual/comparison/explain before any live Wikipedia fetch happens.
4. **k-NN memory** (index.js) — near-duplicate messages at cosine ≥ 0.8 answer
   from remembered examples instead of the net; blends perfectly with weights.
5. **Learning loop** (commands.js) — messages classified with confidence ≥ 0.85
   are saved as labelled examples. `npm run train:neural` absorbs them.

## Commands

```bash
npm run train:neural   # train both nets, validate, save checkpoint (20s)
npm run train          # neural + Wikipedia training
```

## The multi-agent fleet 🤖🤝🤖

The trained IntentNet is the **dispatcher**: work is divided among specialist bots,
each with its own mission and tools. Compound messages spawn a **squad**:

| Bot | Owns | Tools |
|---|---|---|
| 🔬 ResearchBot | factual, comparison | knowledge + wiki |
| 👩‍🏫 TeacherBot | explain, howto | knowledge + wiki |
| 🧑‍💻 CodeBot | code | code runner |
| 🧮 MathBot | math | solver engine |
| ✍️ CreativeBot | poems, stories, captions | — |
| 🫂 DostiBot | emotional, greetings, thanks | — |
| 🤖 DeskBot | personal, misc chat | knowledge |
| 👁️ VisionBot | images & questions | vision + solver |

```
you:  "explain photosynthesis and likho ek poem barish pe"
fleet: 👩‍🏫 TeacherBot:
       <steps of photosynthesis>

       ✍️ CreativeBot:
       <the poem>
```

Single replies are signed (`— 🧑‍💻 CodeBot`, `AGENT_TAG=off` to disable). `/agents`
shows fleet status. Squad detection is conservative — "what is light and sound"
stays one research question; only real compound requests ("…and likho…") split.

## Architecture map

```
src/neural/
├── nn.js        MLP engine — init/forward/backprop/Adam/quantize (XOR-proven)
├── text.js      406-dim featurizer + bilingual lexicon + 13-dim pair features
├── dataset.js   371 labelled examples, 12 classes, templates, 42 paraphrase groups
├── train.js     stratified split → augment → train → honest validation metrics
├── index.js     runtime API: classifyIntent / matchScore / rankMatches / learnExample
└── weights.json trained checkpoint (shipped, auto-loaded)
src/agents.js    multi-agent fleet — dispatcher, missions, squad merge
```

Retraining is honest: validation examples are **never** augmented or templated,
the held-out split is fixed (seed 42), and the trainer reports per-class weak
spots. The honest number: **86.0%** on genuinely unseen handwritten Hinglish —
the remaining misses are ambiguous short strings ("gn", "ok bye") where even a
human needs context.

_Built as pure JS on purpose: one `npm install`, zero native deps, trains on
the laptop in 20 seconds, works offline._
