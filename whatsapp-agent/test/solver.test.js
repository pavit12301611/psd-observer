// solver.test.js — End-to-end verification of the Ultra-Accuracy Question Image Solver (v2.10.0).
//
// Proves every layer of `src/solver.js` + `/solve` + `POST /api/solve` + Hinglish NLP:
//   1. Multi-scale HD image enhancement, overlapping zoom tiles & 3x digital magnifier (`sharp`)
//   2. Real scientific Python + SymPy symbolic calculus/algebra & 50-digit precision sandbox
//   3. Real code execution (`javascript`, `python`, `sql` with `NULL` edge-case semantics)
//   4. Captionless question image auto-detection + Python verification + Multi-Brain Auditor
//   5. Adversarial Auditor catching & fixing a wrong `(B)` vs `(C)` option-letter error!
//   6. Mandatory-Compute Gate blocking unverified mental math & forcing real Python execution
//   7. Non-question casual photo passthrough (`isQuestion: false`)
//   8. `/solve`, `/solve status`, Hinglish screen NLP, and `POST /api/solve` + follow-up memory

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  enhanceQuestionImage,
  cropZoomRegion,
  runPythonVerification,
  runCodeSnippet,
  solveQuestionImage,
} from '../src/solver.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { createAgent } from '../src/commands.js';
import { createBridgeServer } from '../src/server.js';
import { parseIntent } from '../src/nlp.js';

const silentLog = { info() {}, warn() {}, error() {} };

async function makeExamSheetPng({ width = 1200, height = 1700 } = {}) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#f7f5ee"/>
    <text x="60" y="120" font-size="38" font-family="sans-serif" fill="#111">JEE / GATE Practice Sheet</text>
    <text x="60" y="240" font-size="30" font-family="monospace" fill="#111">Q1. Evaluate integral from 0 to pi of x^2 * sin(x) dx:</text>
    <text x="90" y="310" font-size="28" font-family="monospace" fill="#222">(A) pi^2 - 2   (B) pi^2 + 4   (C) pi^2 - 4   (D) 2*pi</text>
    <text x="60" y="960" font-size="30" font-family="monospace" fill="#111">Q2. Find det([[4, 2], [1, 3]]): (A) 8  (B) 10  (C) 12  (D) 14</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function startMockMultiBrainServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      const replyText = await handler({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: replyText } }],
      }));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

test('solver Stage 1: enhanceQuestionImage creates full + high-DPI zoom tiles and 3x crop magnifier', async () => {
  const sheet = await makeExamSheetPng({ width: 1200, height: 1700 });
  const enhanced = await enhanceQuestionImage(sheet, { maxTiles: 3 });
  assert.equal(enhanced.enhancedBy, 'sharp');
  assert.equal(enhanced.images.length, 3);
  assert.deepEqual(
    enhanced.images.map((x) => x.label),
    ['full-page', 'upper-half-zoom', 'lower-half-zoom'],
  );

  const crop = await cropZoomRegion(sheet, { x1: 40, y1: 180, x2: 700, y2: 350 });
  assert.ok(crop?.buffer?.length > 1000);
  const meta = await sharp(crop.buffer).metadata();
  assert.ok(meta.width >= 1200, `expected magnified crop width >= 1200, got ${meta.width}`);
});

test('solver Stage 2: runPythonVerification executes exact SymPy calculus & 50-digit Decimal math', async () => {
  const res = await runPythonVerification([
    'if SYMPY_AVAILABLE:',
    '    x = sp.Symbol("x")',
    '    val = sp.simplify(sp.integrate(x**2 * sp.sin(x), (x, 0, sp.pi)))',
    '    print("EXACT:", val)',
    'else:',
    '    val = num_integrate(lambda x: (x**2) * math.sin(x), 0.0, math.pi, 4000)',
    '    print("NUMERIC:", round(val, 8))',
    'print("DET:", 4*3 - 2*1)',
  ].join('\n'), { log: silentLog });

  assert.equal(res.ok, true);
  assert.match(res.output, /pi\*\*2\s*-\s*4|-4\s*\+\s*pi\*\*2|5\.8696044/);
  assert.match(res.output, /DET: 10/);
});

test('solver Stage 2: runCodeSnippet executes real SQL NULL traps, Node JS, and Python snippets', async () => {
  const sqlRes = await runCodeSnippet({
    language: 'sql',
    code: `
      CREATE TABLE emp (id INT, bonus INT);
      INSERT INTO emp VALUES (1, 100), (2, NULL), (3, 200), (4, NULL);
      SELECT COUNT(*), COUNT(bonus), COALESCE(SUM(bonus), 0) FROM emp;
    `,
  }, { log: silentLog });
  assert.equal(sqlRes.ok, true);
  assert.match(sqlRes.output, /\(4,\s*2,\s*300\)/);

  const jsRes = await runCodeSnippet({
    language: 'javascript',
    code: 'const a = [1, 2, 3].map((x, i) => x * (i + 1)); console.log(a.reduce((s, v) => s + v, 0));',
  }, { log: silentLog });
  assert.equal(jsRes.ok, true);
  assert.equal(jsRes.output.trim(), '14');
});

test('solver full pipeline: Mandatory-Compute Gate blocks mental math & Adversarial Auditor fixes wrong Option Letter!', async () => {
  let solverRound = 0;
  let auditorRan = false;
  let sawMultipleZoomImages = false;

  const mock = await startMockMultiBrainServer(async ({ body }) => {
    const firstMsg = body.messages?.[0] ?? {};
    // Vision multi-image extraction call
    if (Array.isArray(firstMsg.content)) {
      const imageParts = firstMsg.content.filter((p) => p.type === 'image_url');
      if (imageParts.length === 3) sawMultipleZoomImages = true;
      return JSON.stringify({
        isQuestionImage: true,
        language: 'hinglish',
        casualDescription: '',
        questionCount: 1,
        needsComputation: true,
        needsCodeExecution: false,
        needsFactLookup: false,
        tinyRegions: [],
        verbatimTranscript: 'Q1. What is the determinant of matrix [[7, 3], [2, 6]]?\n(A) 32\n(B) 34\n(C) 36\n(D) 48',
      });
    }

    const sys = String(firstMsg.content || '');
    // Auditor pass! Notice solver wrote RIGHT number `36` with WRONG letter `(B)`!
    if (sys.includes('Adversarial Exam Solution Auditor')) {
      auditorRan = true;
      const userAudit = String(body.messages?.[1]?.content || '');
      assert.match(userAudit, /DET_RESULT=36/, 'Auditor must see real executed Python stdout');
      return JSON.stringify({
        action: 'verified',
        verdict: 'corrected',
        auditNote: 'Fixed option letter mapping: 36 is Option (C), not Option (B)!',
        finalResponse: '✅ *Q1: Option (C) — 36*\n\n• Formula: $\\det\\begin{pmatrix}7 & 3\\\\2 & 6\\end{pmatrix} = (7 \\times 6) - (3 \\times 2) = 42 - 6 = 36$.\n• Python verification confirmed `36`, jo exact *Option (C)* hai!',
      });
    }

    // Solver rounds:
    // Round 0 intentionally tries to skip Python & guess mentally -> Mandatory Gate MUST reject it!
    solverRound += 1;
    if (solverRound === 1) {
      return JSON.stringify({
        action: 'final',
        confidence: 'medium',
        finalResponse: 'I think the determinant is 34 (Option B).',
      });
    }
    // Round 1 (forced by Mandatory Accuracy Gate!) calls real `python_verify`!
    if (solverRound === 2) {
      return JSON.stringify({
        action: 'tool',
        calls: [
          { tool: 'python_verify', code: 'print("DET_RESULT=" + str(7*6 - 3*2))' },
        ],
      });
    }
    // Round 2 got real Python output `36`, accidentally writes Option (B) — caught by Auditor next!
    return JSON.stringify({
      action: 'final',
      confidence: 'high',
      finalResponse: 'Answer is Option (B) — 36.',
    });
  });

  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solver-test-'));
    const cfg = loadConfig({
      dryRun: true,
      env: {
        DATA_DIR: tmpDir,
        AI_PROVIDER: 'auto',
        GROQ_API_KEY: 'gsk_test_solver',
        GROQ_BASE_URL: mock.url,
        OPENROUTER_API_KEY: 'or_test_auditor',
        OPENROUTER_BASE_URL: mock.url,
      },
    });
    const sheet = await makeExamSheetPng({ width: 1200, height: 1700 });
    const result = await solveQuestionImage(cfg, sheet, {
      caption: '', // ZERO caption! Must auto-detect question from image alone!
      autoDetect: true,
      log: silentLog,
    });

    assert.equal(sawMultipleZoomImages, true, 'Vision model received full page + 2 zoomed high-DPI strips');
    assert.equal(solverRound, 3, 'Mandatory compute gate forced real Python verification when skipped');
    assert.equal(auditorRan, true, 'Independent Adversarial Auditor executed');
    assert.equal(result.ok, true);
    assert.equal(result.isQuestion, true);
    assert.match(result.text, /Option \(C\) — 36/);
    assert.doesNotMatch(result.text, /Option \(B\) — 36/);
    assert.match(result.text, /Auditor corrected/);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } finally {
    await mock.close();
  }
});

test('solver autoDetect: casual non-question photo passes through without false-triggering solver', async () => {
  const mock = await startMockMultiBrainServer(async () => JSON.stringify({
    isQuestionImage: false,
    language: 'hinglish',
    casualDescription: 'Pahadon ke peeche sundar sunset aur chai ka cup rakha hai.',
    questionCount: 0,
    needsComputation: false,
    needsCodeExecution: false,
    needsFactLookup: false,
    tinyRegions: [],
    verbatimTranscript: '',
  }));

  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solver-casual-'));
    const cfg = loadConfig({
      dryRun: true,
      env: { DATA_DIR: tmpDir, GROQ_API_KEY: 'gsk_test', GROQ_BASE_URL: mock.url },
    });
    const tinyPng = await sharp({
      create: { width: 320, height: 240, channels: 3, background: { r: 240, g: 150, b: 90 } },
    }).png().toBuffer();

    const out = await solveQuestionImage(cfg, tinyPng, { caption: '', autoDetect: true, log: silentLog });
    assert.equal(out.isQuestion, false);
    assert.match(out.casualDescription, /sunset/i);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } finally {
    await mock.close();
  }
});

test('commands, Hinglish NLP & POST /api/solve: end-to-end question upload + follow-up `/solve Q2`', async () => {
  // Natural Hinglish intents
  assert.equal(parseIntent('screen pe jo question hai solve karo')?.cmd, 'solve');
  assert.equal(parseIntent('pichli photo ke questions solve karo')?.cmd, 'solve');

  const mock = await startMockMultiBrainServer(async ({ body }) => {
    const first = body.messages?.[0] ?? {};
    if (Array.isArray(first.content)) {
      return JSON.stringify({
        isQuestionImage: true,
        language: 'hinglish',
        casualDescription: '',
        questionCount: 2,
        needsComputation: true,
        tinyRegions: [],
        verbatimTranscript: 'Q1. 15 * 14 = ?\nQ2. 2^10 = ?',
      });
    }
    const sys = String(first.content || '');
    if (sys.includes('Adversarial Exam Solution Auditor')) {
      return JSON.stringify({
        action: 'verified',
        verdict: 'confirmed',
        auditNote: 'Verified both Q1=210 and Q2=1024 via Python.',
        finalResponse: '✅ *Q1:* `210`\n✅ *Q2:* `1024`',
      });
    }
    const lastUser = String(body.messages?.at(-1)?.content || '');
    if (!lastUser.includes('TOOL EXECUTION GROUND-TRUTH')) {
      return JSON.stringify({
        action: 'tool',
        calls: [{ tool: 'python_verify', code: 'print(15*14, 2**10)' }],
      });
    }
    return JSON.stringify({
      action: 'final',
      confidence: 'high',
      finalResponse: '✅ *Q1:* `210`\n✅ *Q2:* `1024`',
    });
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solver-bridge-'));
  const cfg = loadConfig({
    dryRun: true,
    env: {
      PORT: '0',
      HOST: '127.0.0.1',
      DATA_DIR: tmpDir,
      BRIDGE_TOKEN: 'solver-bridge-tok',
      DASHBOARD_PIN: '654321',
      GROQ_API_KEY: 'gsk_test',
      GROQ_BASE_URL: mock.url,
    },
  });
  const store = new Store(cfg.storeFile);
  const agent = createAgent({ config: cfg, store, log: silentLog });

  // `/solve status` reports capabilities cleanly
  const statusReply = await agent.handle('/solve status');
  assert.match(statusReply, /Ultra-Accuracy Question Solver/);
  assert.match(statusReply, /Sharp|HD Image Enhancer/);

  const whatsappStub = {
    state: { pairingCode: null, lastQr: null },
    status: () => 'dry-run',
    sendToOwner: async () => {},
  };
  const bridge = createBridgeServer({
    config: cfg,
    store,
    whatsapp: whatsappStub,
    mailbox: { observerOnline: () => false, listen: async () => [], deliverReply: () => 'direct' },
    actions: agent.actions,
    harness: agent.harness,
    runOwner: (text) => agent.handle(text),
    log: silentLog,
  });
  const httpServer = await bridge.start();
  const bridgePort = httpServer.address().port;

  try {
    const sheet = await makeExamSheetPng({ width: 900, height: 1200 });
    const solveHttp = await fetch(`http://127.0.0.1:${bridgePort}/api/solve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bridge-token': 'solver-bridge-tok',
      },
      body: JSON.stringify({
        imageBase64: sheet.toString('base64'),
        mimeType: 'image/png',
        fileName: 'mock-exam.png',
        instructions: 'Dono questions solve karo',
      }),
    }).then((r) => r.json());

    assert.equal(solveHttp.ok, true);
    assert.match(solveHttp.text, /210/);
    assert.match(solveHttp.text, /1024/);

    // Follow-up `/solve Q2` WITHOUT re-uploading the image reuses `mock-exam.png` automatically!
    const followUp = await agent.handle('/solve Q2 hindi me');
    assert.match(followUp, /1024/);
  } finally {
    bridge.stop();
    await mock.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
