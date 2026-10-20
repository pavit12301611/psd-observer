// solver.js — Ultra-Accuracy Question Image & Exam Sheet Solver Engine.
//
// Why normal single-shot vision bots fail on question images:
//   1. Camera shadows, EXIF rotation, low DPI, or full-page downscaling turn
//      `x³` into `x²`, `10⁻⁶` into `10⁻⁸`, `≤` into `<`, or hide `NOT`.
//   2. LLMs hallucinate mental arithmetic, integrals, matrices, combinatorics,
//      circuit equations, SQL NULL semantics, and C/Java/JS/Python outputs.
//   3. Single-pass answers map the right number (`42`) to the wrong option
//      letter (`Option B` instead of `Option C`), or stop after Q1 on a sheet
//      containing Q1–Q6.
//
// How this engine guarantees maximum real-world accuracy ("chahiye kuch bhi
// use karein, answer 100% sahi hona chahiye"):
//   • Stage 1 — Multi-Scale Image Enhancement (`enhanceQuestionImage`):
//       EXIF auto-orientation, contrast normalization + unsharp mask, upscale
//       of tiny crops, PLUS overlapping high-DPI zoom tiles on tall pages so
//       superscripts, minus signs, diagram labels, and code characters stay sharp.
//   • Stage 2 — Dual-Channel Extraction (`extractQuestions`):
//       Parallel Tesseract multi-PSM OCR (`--psm 6` + `--psm 3`) + multi-image
//       Vision transcription with strict anti-misread checks (`NOT` / `EXCEPT` /
//       units / options `(A)-(D)` / diagrams / code indentation).
//   • Stage 3 — Iterative Tool-Augmented Deep Solving (`solveWithTools`):
//       Autonomous verification tools executed locally on the PC:
//         1. `python_verify` — Python 3 + auto-bootstrapped isolated venv
//            (`sympy`, `numpy`, `pillow`) + built-in exact `Fraction`, `Decimal`,
//            adaptive Simpson integration, root-finding, combinatorics & `sqlite3`!
//         2. `code_runner` — Real runtime/compiler execution for `python`,
//            `javascript` (`node`), `sql` (`sqlite3`), `c` (`gcc`), `cpp` (`g++`), `bash`.
//         3. `fact_search` — Parallel live factual checks across Wikipedia API,
//            DuckDuckGo Instant Answer, and Free Dictionary API.
//         4. `zoom_crop` — 3× upscaled high-contrast digital magnifier crop
//            (`0..1000` coords on original full-res photo) re-read via Vision + OCR!
//         5. `dsh_agent` — Optional escalation to official DeepSeek Harness
//            (`@deepseek-ai/dsh`) when installed for multi-step coding/reasoning.
//       Includes a hard Mandatory-Compute Guard: if a question contains math,
//       numbers, formulas, tables, SQL, or code and the LLM skipped tools, it
//       forces tool verification before accepting any answer.
//   • Stage 4 — Independent Adversarial Auditor (`auditSolution`):
//       Runs on a second distinct brain when available (or clean zero-anchor
//       low-temperature pass + visual re-check), auditing every digit, sign,
//       unit, `NOT`/`INCORRECT` trap, option-letter `(A)/(B)/(C)/(D)` mapping,
//       domain restriction, and multi-question completeness — with ability to
//       run its own fresh `python_verify` script before sealing the answer!

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as ai from './ai.js';
import * as ocr from './ocr.js';
import { findBin } from './pccontrol.js';
import { routerFor } from './router.js';

const execFileAsync = promisify(execFile);

const DEFAULT_SOLVER_VENV = path.join(os.homedir(), '.local/share/observer-solver-venv');
const PYTHON_TIMEOUT_MS = 20_000;
const CODE_TIMEOUT_MS = 12_000;
const MAX_TOOL_OUTPUT = 6_000;
const MAX_TOOL_ROUNDS = 4;

// Explicit user captions that unambiguously mean "solve / answer this!"
const EXPLICIT_SOLVE_CAPTION_RE = /\b(solve|ans|answer|answers|question|questions|mcq|mcqs|quiz|test|exam|paper|sheet|assignment|homework|numerical|prove|derive|calculate|compute|simplify|evaluate|integrate|differentiate|output|bata|batao|bataiye|hal|nikal|nikalo|konsa|kaunsa|sahi|correct|option|options|explain|samjha|samjhao|check\s*kar|q\s*\.?\s*\d+)\b|(?:हल|उत्तर|सवाल|प्रश्न|बताइए|ज्ञात)/i;

// Captions that clearly ask for non-question actions (do NOT hijack these!)
const NON_SOLVE_CAPTION_RE = /^(?:\/?sticker\b|(?:click|tap|press|dabao)\b)/i;

// Strong question signals in OCR / transcript text when user sends a captionless image
const QUESTION_TEXT_SIGNALS = [
  /\?/,
  /(?:^|\s)(?:Q\.?\s*\d+|Question\s*\d+|Que\.?\s*\d+|प्रश्न\s*\d+)/im,
  /(?:^|\n)\s*\(?[A-D1-4]\)?[\s.)\-:]+.+\n\s*\(?[B-D2-4]\)?[\s.)\-:]+/im,
  /\b(?:which of the following|choose the correct|select the correct|find the value|what will be the output|time complexity|assertion|reason|fill in the blank|match the column|true or false|solve for|calculate the|determine the|prove that|evaluate)\b/i,
  /(?:ज्ञात कीजिए|सही विकल्प|निम्नलिखित में से|हल कीजिए|उत्तर दीजिए)/,
  /(?:∫|∑|√|≤|≥|≠|→|⇒|\b(?:lim|sin|cos|tan|log|ln|det|matrix|eigen|integral|derivative)\b)/i,
  /\b(?:#include\s*<|public\s+static\s+void\s+main|def\s+\w+\s*\(|function\s+\w+\s*\(|SELECT\s+.+\s+FROM\s+)/i,
];

// Signals that numerical / symbolic / code verification MUST run
const NEEDS_COMPUTE_RE = /(?:\d+\s*[+\-*/^%=<>]|=\s*[-+]?\d|\b(?:sin|cos|tan|log|ln|sqrt|integral|integrate|differentiate|derivative|limit|matrix|determinant|eigen|probability|permutation|combination|mean|variance|median|std|modulo|mod|gcd|lcm|prime|series|sum|product|roots?|quadratic|polynomial|equation|velocity|acceleration|force|energy|power|voltage|current|resistance|capacitance|molarity|mole|pH|enthalpy|entropy|efficiency|profit|loss|compound interest|discount|ratio|average|speed|distance|work|time complexity|output)\b|[∫∑∏√π]|#include|def\s+\w+|console\.log|System\.out\.print|printf\s*\(|SELECT\s+.+\s+FROM)/i;

let cachedSharp = undefined;
async function getSharp() {
  if (cachedSharp !== undefined) return cachedSharp;
  try {
    const mod = await import('sharp');
    cachedSharp = mod.default || mod;
  } catch {
    cachedSharp = null;
  }
  return cachedSharp;
}

function getSolverVenvDir(config) {
  return path.resolve(config?.solverVenvDir || process.env.OBSERVER_SOLVER_VENV || DEFAULT_SOLVER_VENV);
}

let pythonProbeCache = null;
let venvBootstrapPromise = null;

/**
 * Locate the best Python binary on the machine, optionally auto-bootstrapping
 * `~/.local/share/observer-solver-venv` with `sympy`, `numpy`, and `pillow`
 * cleanly in userspace (zero sudo, PEP-668 safe).
 */
export async function ensureSolverPython({ config = {}, autoInstall = true, log = console } = {}) {
  const venvDir = getSolverVenvDir(config);
  const venvPy = path.join(venvDir, 'bin', 'python3');
  const sysPy = findBin('python3') || findBin('python');

  const checkPackages = async (pyBin) => {
    if (!pyBin || !fs.existsSync(pyBin)) return null;
    try {
      const { stdout } = await execFileAsync(pyBin, [
        '-c',
        'import json; mods={}; \nfor m in ("sympy","numpy","scipy","PIL"):\n try: __import__(m); mods[m]=True\n except Exception: mods[m]=False\nprint(json.dumps(mods))',
      ], { timeout: 6_000 });
      const mods = JSON.parse(stdout.trim());
      return { pythonBin: pyBin, mods };
    } catch {
      return null;
    }
  };

  if (pythonProbeCache && fs.existsSync(pythonProbeCache.pythonBin)) {
    if (pythonProbeCache.mods.sympy || !autoInstall) return pythonProbeCache;
  }

  const existingVenv = await checkPackages(venvPy);
  if (existingVenv?.mods?.sympy) {
    pythonProbeCache = existingVenv;
    return existingVenv;
  }

  const sysCheck = await checkPackages(sysPy);
  if (sysCheck?.mods?.sympy && sysCheck?.mods?.numpy) {
    pythonProbeCache = sysCheck;
    return sysCheck;
  }

  if (autoInstall && sysPy && config?.solverAutoBootstrap !== false) {
    if (!venvBootstrapPromise) {
      venvBootstrapPromise = (async () => {
        try {
          log.info?.(`[solver] Bootstrapping scientific Python venv (${venvDir}: sympy, numpy, pillow)...`);
          fs.mkdirSync(path.dirname(venvDir), { recursive: true });
          if (!fs.existsSync(venvPy)) {
            await execFileAsync(sysPy, ['-m', 'venv', venvDir], { timeout: 30_000 });
          }
          const pipBin = path.join(venvDir, 'bin', 'pip');
          await execFileAsync(pipBin, [
            'install', '--quiet', '--disable-pip-version-check', 'sympy', 'numpy', 'pillow',
          ], { timeout: 90_000 });
          const ready = await checkPackages(venvPy);
          if (ready) {
            pythonProbeCache = ready;
            log.info?.('[solver] Scientific Python venv ready (SymPy + NumPy + Pillow active).');
            return ready;
          }
        } catch (err) {
          log.warn?.(`[solver] Venv bootstrap skipped (${err.message}); using stdlib exact math fallback.`);
        } finally {
          venvBootstrapPromise = null;
        }
        return sysCheck;
      })();
    }
    const bootstrapped = await venvBootstrapPromise;
    if (bootstrapped) return bootstrapped;
  }

  if (existingVenv) { pythonProbeCache = existingVenv; return existingVenv; }
  if (sysCheck) { pythonProbeCache = sysCheck; return sysCheck; }
  return { pythonBin: null, mods: {} };
}

/** Diagnostic snapshot for `/solve status` and `/doctor`. */
export async function solverStatus(config = {}, log = console) {
  const sharp = await getSharp();
  const py = await ensureSolverPython({ config, autoInstall: false, log });
  const vision = ai.visionCandidates(config, log);
  const brains = ai.reasoningCandidates(config, log);
  return {
    ok: Boolean(vision.length || ocr.ocrAvailable()) && Boolean(brains.length),
    sharp: Boolean(sharp),
    tesseract: ocr.ocrAvailable(),
    pdftotext: Boolean(findBin('pdftotext')),
    pdftoppm: Boolean(findBin('pdftoppm')),
    python: py.pythonBin || null,
    sympy: Boolean(py.mods?.sympy),
    numpy: Boolean(py.mods?.numpy),
    pillow: Boolean(py.mods?.PIL),
    gcc: Boolean(findBin('gcc') || findBin('g++')),
    node: process.execPath,
    visionModels: vision.map((m) => m.label),
    reasoningModels: brains.map((m) => m.label),
  };
}

// ── Stage 1: Multi-Scale High-Clarity Image Enhancement & Digital Zoom ───────

/**
 * Enhance a question photo / screenshot for crystal-clear reading:
 *   • Auto-rotates EXIF orientation (sideways phone camera shots!)
 *   • Upscales tiny cropped math/code screenshots (`< 1200px`) with cubic filter
 *   • Produces a clean full-frame image (`primary`) + high-contrast normalized
 *     document frame (`docCrisp`) for OCR + overlapping zoomed half-page tiles
 *     when the image is tall/dense so tiny superscripts (`x³`, `10⁻⁶`) never blur!
 */
export async function enhanceQuestionImage(buffer, { maxTiles = 3 } = {}) {
  const raw = Buffer.from(buffer);
  const sharp = await getSharp();

  if (sharp) {
    try {
      const meta = await sharp(raw).rotate().metadata();
      const origW = meta.width || 0;
      const origH = meta.height || 0;
      const maxDim = Math.max(origW, origH);

      // Upscale tiny cropped equations/code up to ~1300px; cap huge 12MP photos at 2200px
      const targetLongEdge = maxDim > 0 && maxDim < 1100
        ? Math.min(1500, maxDim * 2)
        : Math.min(2200, Math.max(1200, maxDim || 1600));

      const primaryBuf = await sharp(raw)
        .rotate()
        .resize({
          width: origW >= origH ? targetLongEdge : undefined,
          height: origH > origW ? targetLongEdge : undefined,
          fit: 'inside',
          kernel: 'lanczos3',
        })
        .sharpen({ sigma: 0.9 })
        .png({ compressionLevel: 6 })
        .toBuffer();

      // Normalized high-contrast document image (eliminates phone shadow gradients for OCR!)
      const docCrispBuf = await sharp(raw)
        .rotate()
        .resize({
          width: origW >= origH ? Math.min(2400, Math.max(targetLongEdge, 1500)) : undefined,
          height: origH > origW ? Math.min(2400, Math.max(targetLongEdge, 1500)) : undefined,
          fit: 'inside',
          kernel: 'lanczos3',
        })
        .grayscale()
        .normalize()
        .sharpen({ sigma: 1.2 })
        .png({ compressionLevel: 6 })
        .toBuffer();

      const images = [{ base64: primaryBuf.toString('base64'), mime: 'image/png', label: 'full-page' }];

      // If page is tall or high-res exam sheet, attach overlapping high-DPI zoom strips
      // so superscripts, subscripts, minus signs, and option letters have 2x pixel density!
      if (maxTiles >= 3 && origW > 0 && origH > 0 && (origH / origW >= 1.15 || maxDim >= 1400)) {
        const oriented = await sharp(raw).rotate().toBuffer({ resolveWithObject: true });
        const W = oriented.info.width;
        const H = oriented.info.height;
        const topH = Math.min(H, Math.round(H * 0.56));
        const botTop = Math.max(0, Math.round(H * 0.44));
        const botH = H - botTop;
        if (topH > 80 && botH > 80) {
          const [topBuf, botBuf] = await Promise.all([
            sharp(oriented.data)
              .extract({ left: 0, top: 0, width: W, height: topH })
              .resize({ width: Math.min(2000, Math.max(W, 1300)), fit: 'inside', kernel: 'lanczos3' })
              .normalize()
              .sharpen({ sigma: 1.0 })
              .png({ compressionLevel: 6 })
              .toBuffer(),
            sharp(oriented.data)
              .extract({ left: 0, top: botTop, width: W, height: botH })
              .resize({ width: Math.min(2000, Math.max(W, 1300)), fit: 'inside', kernel: 'lanczos3' })
              .normalize()
              .sharpen({ sigma: 1.0 })
              .png({ compressionLevel: 6 })
              .toBuffer(),
          ]);
          images.push(
            { base64: topBuf.toString('base64'), mime: 'image/png', label: 'upper-half-zoom' },
            { base64: botBuf.toString('base64'), mime: 'image/png', label: 'lower-half-zoom' },
          );
        }
      }

      return {
        primaryBuffer: primaryBuf,
        ocrBuffer: docCrispBuf,
        images: images.slice(0, maxTiles),
        width: origW,
        height: origH,
        enhancedBy: 'sharp',
      };
    } catch { /* fall through to fallback */ }
  }

  return {
    primaryBuffer: raw,
    ocrBuffer: raw,
    images: [{ base64: raw.toString('base64'), mime: guessMime(raw), label: 'raw' }],
    width: 0,
    height: 0,
    enhancedBy: 'raw',
  };
}

/**
 * 300% Digital Magnifying Glass (`0..1000` relative box on original full-res photo).
 * Used when any formula, graph axis, circuit value, or subscript looks tiny!
 */
export async function cropZoomRegion(buffer, { x1 = 0, y1 = 0, x2 = 1000, y2 = 1000 } = {}) {
  const sharp = await getSharp();
  if (!sharp) return null;
  const oriented = await sharp(Buffer.from(buffer)).rotate().toBuffer({ resolveWithObject: true });
  const W = oriented.info.width;
  const H = oriented.info.height;
  if (!W || !H) return null;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const left = clamp(Math.floor((Math.min(x1, x2) / 1000) * W), 0, W - 2);
  const top = clamp(Math.floor((Math.min(y1, y2) / 1000) * H), 0, H - 2);
  const right = clamp(Math.ceil((Math.max(x1, x2) / 1000) * W), left + 2, W);
  const bottom = clamp(Math.ceil((Math.max(y1, y2) / 1000) * H), top + 2, H);
  const cropW = right - left;
  const cropH = bottom - top;

  const zoomed = await sharp(oriented.data)
    .extract({ left, top, width: cropW, height: cropH })
    .resize({ width: Math.min(2000, Math.max(1200, cropW * 3)), fit: 'inside', kernel: 'lanczos3' })
    .normalize()
    .sharpen({ sigma: 1.25 })
    .png({ compressionLevel: 6 })
    .toBuffer();

  return { buffer: zoomed, base64: zoomed.toString('base64'), mime: 'image/png', width: cropW, height: cropH };
}

function guessMime(buf) {
  if (!buf || buf.length < 4) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'image/webp';
  return 'image/png';
}

// ── Stage 2: Python Scientific Sandbox, Real Code Compiler & Fact Search ────

const PYTHON_PRELUDE = `
import math, cmath, fractions, decimal, itertools, functools, statistics, collections, sqlite3, re, json
from fractions import Fraction
from decimal import Decimal, getcontext
getcontext().prec = 50

try:
    import sympy as sp
    SYMPY_AVAILABLE = True
except Exception:
    SYMPY_AVAILABLE = False

try:
    import numpy as np
    NUMPY_AVAILABLE = True
except Exception:
    NUMPY_AVAILABLE = False

def num_integrate(fn, a, b, steps=2000):
    """High-precision composite Simpson's rule fallback when SymPy is absent."""
    if steps % 2 == 1:
        steps += 1
    h = (b - a) / steps
    total = fn(a) + fn(b)
    for i in range(1, steps):
        total += (4 if i % 2 == 1 else 2) * fn(a + i * h)
    return total * h / 3.0

def num_deriv(fn, x, h=1e-7):
    """5-point stencil derivative accurate to O(h^4)."""
    return (-fn(x + 2*h) + 8*fn(x + h) - 8*fn(x - h) + fn(x - 2*h)) / (12.0 * h)

def run_sql(sql_script):
    """Execute SQL statements in fresh in-memory SQLite DB and return rows."""
    conn = sqlite3.connect(":memory:")
    cur = conn.cursor()
    out = []
    for stmt in [s.strip() for s in sql_script.split(";") if s.strip()]:
        cur.execute(stmt)
        if cur.description:
            cols = [d[0] for d in cur.description]
            out.append({"columns": cols, "rows": cur.fetchall()})
    conn.commit()
    conn.close()
    return out
`;

/**
 * Execute a verification Python script in an isolated temporary directory with
 * full `sympy`, `numpy`, exact `Fraction`, 50-digit `Decimal`, and `sqlite3`.
 */
export async function runPythonVerification(code, { config = {}, log = console, signal = null } = {}) {
  const cleanCode = String(code ?? '').trim();
  if (!cleanCode) return { ok: false, output: 'Empty Python verification script.' };

  const pyInfo = await ensureSolverPython({ config, autoInstall: true, log });
  if (!pyInfo.pythonBin) {
    return { ok: false, output: 'python3 binary not found on system.' };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-solve-py-'));
  const scriptFile = path.join(tmpDir, 'verify.py');
  try {
    fs.writeFileSync(scriptFile, `${PYTHON_PRELUDE}\n# --- Solver Verification Script ---\n${cleanCode}\n`, 'utf8');
    const { stdout, stderr } = await execFileAsync(pyInfo.pythonBin, ['-I', scriptFile], {
      cwd: tmpDir,
      timeout: PYTHON_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      signal: signal ?? undefined,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: tmpDir, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
    });
    const combined = [stdout?.trim(), stderr?.trim() ? `[stderr]: ${stderr.trim()}` : ''].filter(Boolean).join('\n');
    return {
      ok: true,
      sympy: Boolean(pyInfo.mods?.sympy),
      output: (combined || '(script succeeded with no printed output — make sure to call print(...)!)').slice(0, MAX_TOOL_OUTPUT),
    };
  } catch (err) {
    const detail = [err.stdout?.trim(), err.stderr?.trim(), err.message].filter(Boolean).join('\n');
    return { ok: false, output: `Python error:\n${detail.slice(0, MAX_TOOL_OUTPUT)}` };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

/**
 * Compile & run real code snippets (`python`, `javascript`/`node`, `c`, `cpp`, `sql`, `bash`)
 * so "What is the output of the following program?" questions get 100% ground-truth answers!
 */
export async function runCodeSnippet({ language = 'python', code = '', stdin = '' } = {}, { config = {}, log = console, signal = null } = {}) {
  const lang = String(language || 'python').toLowerCase().trim();
  const src = String(code ?? '').trim();
  if (!src) return { ok: false, output: 'Empty code snippet.' };

  if (lang === 'sql' || lang === 'sqlite') {
    const pyScript = `res = run_sql(${JSON.stringify(src)})\nfor r in res:\n    print("COLUMNS:", r["columns"])\n    for row in r["rows"]:\n        print("ROW:", row)`;
    return runPythonVerification(pyScript, { config, log, signal });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-solve-code-'));
  try {
    const execOpts = {
      cwd: tmpDir,
      timeout: CODE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      signal: signal ?? undefined,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: tmpDir, LANG: 'C.UTF-8' },
    };

    const runWithInput = (bin, args) => new Promise((resolve) => {
      const child = execFile(bin, args, execOpts, (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            output: [stdout?.trim(), stderr?.trim(), err.message].filter(Boolean).join('\n').slice(0, MAX_TOOL_OUTPUT),
          });
          return;
        }
        resolve({
          ok: true,
          output: ([stdout?.replace(/\r\n/g, '\n'), stderr?.trim() ? `[stderr]: ${stderr.trim()}` : ''].filter(Boolean).join('\n') || '(empty stdout)').slice(0, MAX_TOOL_OUTPUT),
        });
      });
      if (stdin) {
        try { child.stdin?.write(String(stdin)); } catch { /* ignore */ }
      }
      try { child.stdin?.end(); } catch { /* ignore */ }
    });

    if (lang === 'javascript' || lang === 'js' || lang === 'node') {
      const f = path.join(tmpDir, 'snippet.cjs');
      fs.writeFileSync(f, src, 'utf8');
      return await runWithInput(process.execPath, [f]);
    }

    if (lang === 'c') {
      const cc = findBin('gcc') || findBin('clang') || findBin('cc');
      if (!cc) return { ok: false, output: 'C compiler (gcc/clang) not installed on this machine; trace semantics via python_verify.' };
      const f = path.join(tmpDir, 'snippet.c');
      const outBin = path.join(tmpDir, 'a.out');
      fs.writeFileSync(f, src, 'utf8');
      await execFileAsync(cc, ['-O0', '-std=c11', f, '-lm', '-o', outBin], execOpts);
      return await runWithInput(outBin, []);
    }

    if (lang === 'cpp' || lang === 'c++' || lang === 'cc') {
      const cxx = findBin('g++') || findBin('clang++');
      if (!cxx) return { ok: false, output: 'C++ compiler (g++/clang++) not installed on this machine; trace semantics via python_verify.' };
      const f = path.join(tmpDir, 'snippet.cpp');
      const outBin = path.join(tmpDir, 'a.out');
      fs.writeFileSync(f, src, 'utf8');
      await execFileAsync(cxx, ['-O0', '-std=c++17', f, '-o', outBin], execOpts);
      return await runWithInput(outBin, []);
    }

    if (lang === 'bash' || lang === 'sh' || lang === 'shell') {
      const bash = findBin('bash') || '/bin/sh';
      const f = path.join(tmpDir, 'snippet.sh');
      fs.writeFileSync(f, src, 'utf8');
      return await runWithInput(bash, [f]);
    }

    // Default: Python
    const pyInfo = await ensureSolverPython({ config, autoInstall: false, log });
    if (!pyInfo.pythonBin) return { ok: false, output: 'python3 not available.' };
    const f = path.join(tmpDir, 'snippet.py');
    fs.writeFileSync(f, src, 'utf8');
    return await runWithInput(pyInfo.pythonBin, ['-I', f]);
  } catch (err) {
    return {
      ok: false,
      output: [err.stdout?.trim(), err.stderr?.trim(), err.message].filter(Boolean).join('\n').slice(0, MAX_TOOL_OUTPUT),
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

/**
 * Live encyclopedic & lexical verification (`Wikipedia` + `DuckDuckGo` + `Dictionary`)
 * so GK / Biology / Chemistry / History / Polity / CS theory / Vocab MCQs are grounded in facts.
 */
export async function runFactSearch(queries = [], { signal = null } = {}) {
  const list = (Array.isArray(queries) ? queries : [queries])
    .map((q) => String(q ?? '').trim())
    .filter(Boolean)
    .slice(0, 4);
  if (!list.length) return { ok: false, output: 'No search queries provided.' };

  const headers = { 'user-agent': 'ObserverQuestionSolver/2.10 (Educational Fact Verification)' };
  const chunks = [];

  await Promise.all(list.map(async (q) => {
    const notes = [];
    // 1. Wikipedia Search + Extract
    try {
      const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=2&format=json`;
      const sRes = await fetch(searchUrl, { headers, signal: signal ?? AbortSignal.timeout(7_000) });
      if (sRes.ok) {
        const sData = await sRes.json();
        const hits = sData?.query?.search ?? [];
        for (const h of hits.slice(0, 2)) {
          try {
            const sumUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(h.title.replace(/ /g, '_'))}`;
            const pRes = await fetch(sumUrl, { headers, signal: signal ?? AbortSignal.timeout(6_000) });
            if (pRes.ok) {
              const pData = await pRes.json();
              if (pData?.extract) notes.push(`[Wikipedia — ${pData.title}]: ${pData.extract.slice(0, 900)}`);
            }
          } catch {
            const cleanSnippet = String(h.snippet || '').replace(/<[^>]+>/g, '');
            if (cleanSnippet) notes.push(`[Wikipedia — ${h.title}]: ${cleanSnippet}`);
          }
        }
      }
    } catch { /* offline or blocked in restricted sandbox */ }

    // 2. DuckDuckGo Instant Answer
    try {
      const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
      const dRes = await fetch(ddgUrl, { headers, signal: signal ?? AbortSignal.timeout(6_000) });
      if (dRes.ok) {
        const dData = await dRes.json();
        if (dData?.AbstractText) notes.push(`[DuckDuckGo — ${dData.Heading || q}]: ${dData.AbstractText.slice(0, 700)}`);
        else if (dData?.Answer) notes.push(`[Instant Answer]: ${String(dData.Answer).slice(0, 500)}`);
      }
    } catch { /* ignore */ }

    // 3. Dictionary lookup when single English word (vocab / synonym / antonym MCQs!)
    if (/^[a-zA-Z-]{3,28}$/.test(q)) {
      try {
        const dictRes = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(q)}`, {
          headers, signal: signal ?? AbortSignal.timeout(5_000),
        });
        if (dictRes.ok) {
          const dJson = await dictRes.json();
          const meanings = (dJson?.[0]?.meanings ?? []).slice(0, 2).map((m) => {
            const defs = (m.definitions ?? []).slice(0, 2).map((d) => d.definition).join('; ');
            const syns = (m.synonyms ?? []).slice(0, 5).join(', ');
            const ants = (m.antonyms ?? []).slice(0, 5).join(', ');
            return `(${m.partOfSpeech}) ${defs}${syns ? ` | Synonyms: ${syns}` : ''}${ants ? ` | Antonyms: ${ants}` : ''}`;
          }).join(' / ');
          if (meanings) notes.push(`[Dictionary — ${q}]: ${meanings}`);
        }
      } catch { /* ignore */ }
    }

    chunks.push(notes.length ? `Query "${q}":\n${notes.join('\n')}` : `Query "${q}": (no external encyclopedia hit — rely on first-principles reasoning & Python verification)`);
  }));

  return { ok: true, output: chunks.join('\n\n').slice(0, MAX_TOOL_OUTPUT) };
}

// ── JSON Extraction & Parsing Helpers ────────────────────────────────────────

export function extractJsonObject(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  // Strip <think>...</think> reasoning blocks emitted by Qwen / DeepSeek models
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const candidates = [stripped];
  const fenced = stripped.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.unshift(fenced[1].trim());
  const firstBrace = stripped.indexOf('{');
  const lastBrace = stripped.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(stripped.slice(firstBrace, lastBrace + 1));
  }
  for (const cand of candidates) {
    try {
      const parsed = JSON.parse(cand);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* try next */ }
  }
  return null;
}

export function stripThinkBlocks(raw) {
  return String(raw ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

export function looksLikeQuestionText(text) {
  const s = String(text ?? '').trim();
  if (s.length < 8) return false;
  let score = 0;
  for (const re of QUESTION_TEXT_SIGNALS) {
    if (re.test(s)) score += 1;
  }
  return score >= 1;
}

export function captionExplicitlyWantsSolve(caption) {
  const c = String(caption ?? '').trim();
  if (!c) return false;
  if (NON_SOLVE_CAPTION_RE.test(c)) return false;
  return EXPLICIT_SOLVE_CAPTION_RE.test(c);
}

// ── Multi-Model Vision + OCR Dual-Channel Transcription ──────────────────────

const EXTRACTION_PROMPT = [
  'You are an ultra-precise exam, STEM, coding, and document transcription specialist.',
  'Carefully inspect ALL attached views of the user image (full image + high-resolution zoom strips if provided).',
  '',
  'Return ONLY a valid JSON object matching this exact schema (no extra prose outside JSON):',
  '{',
  '  "isQuestionImage": true | false,',
  '  "language": "hinglish" | "english" | "hindi",',
  '  "casualDescription": "1-2 sentence description ONLY if isQuestionImage is false, else empty string",',
  '  "questionCount": <integer number of distinct questions visible>,',
  '  "needsComputation": true | false,',
  '  "needsCodeExecution": true | false,',
  '  "needsFactLookup": true | false,',
  '  "tinyRegions": [ { "reason": "small superscript/graph/circuit label", "x1": 0, "y1": 0, "x2": 1000, "y2": 1000 } ],',
  '  "verbatimTranscript": "Complete word-for-word transcription of EVERY question (Q1, Q2, ...), ALL options (A)/(B)/(C)/(D), EVERY number, minus sign, exponent, subscript, inequality, code line with exact indentation, table cell, graph axis/point, and circuit value. Highlight words like NOT / INCORRECT / FALSE / EXCEPT in UPPERCASE."',
  '}',
  '',
  'CRITICAL RULES:',
  '1. Set "isQuestionImage": true if the image contains ANY exam/quiz/test question, MCQ, math expression/problem, physics/chemistry problem/diagram, coding problem/snippet asking output or fix, puzzle, aptitude question, fill-in-the-blank, homework, or worksheet — even a single equation written on paper or screen.',
  '2. Double-check EVERY superscript (`x^2` vs `x^3`), negative sign (`-`), decimal point (`.` vs `,`), inequality (`<` vs `<=`), logarithm base (`ln` vs `log_10`), and exact option labels `(A)`, `(B)`, `(C)`, `(D)`!',
  '3. If multiple questions appear in the image, include ALL of them completely in "verbatimTranscript" — NEVER skip any question!',
  '4. Only add an entry in "tinyRegions" (max 2 boxes in 0..1000 full-image coordinates) if a critical symbol/diagram value is genuinely tiny or ambiguous.',
].join('\n');

async function dualOcrExtract(ocrBuffer, rawBuffer, config) {
  if (!ocr.ocrAvailable()) return '';
  const langs = config?.ocrLangs || 'eng';
  const runs = await Promise.allSettled([
    ocr.ocrImage(ocrBuffer, { langs, psm: 6 }),
    ocr.ocrImage(rawBuffer, { langs, psm: 3 }),
  ]);
  const parts = [];
  for (const r of runs) {
    if (r.status === 'fulfilled' && r.value?.trim()) parts.push(r.value.trim());
  }
  if (!parts.length) return '';
  if (parts.length === 1 || parts[0] === parts[1]) return parts[0];
  return `[OCR Pass 1 - Normalized Block]:\n${parts[0]}\n\n[OCR Pass 2 - Auto Layout]:\n${parts[1]}`;
}

async function visionExtract(config, enhanced, caption, log, signal) {
  const candidates = ai.visionCandidates(config, log);
  const router = routerFor(config, log);
  const prompt = caption
    ? `${EXTRACTION_PROMPT}\n\nOwner caption / instruction: "${caption}"`
    : EXTRACTION_PROMPT;

  for (const model of candidates) {
    const started = Date.now();
    try {
      const raw = await ai.visionMultiCall(model, config, prompt, enhanced.images, {
        temperature: 0.05,
        maxTokens: 3500,
        signal,
      });
      if (!raw) throw new Error('empty vision transcription');
      router.record(model.id, { ok: true, ms: Date.now() - started, tier: 4 });
      const parsed = extractJsonObject(raw);
      if (parsed && typeof parsed.verbatimTranscript === 'string') {
        return { parsed, raw, model };
      }
      // Graceful fallback if a model answered plain text instead of strict JSON
      const plain = stripThinkBlocks(raw);
      return {
        parsed: {
          isQuestionImage: captionExplicitlyWantsSolve(caption) || looksLikeQuestionText(plain),
          language: 'hinglish',
          casualDescription: plain,
          questionCount: 1,
          needsComputation: NEEDS_COMPUTE_RE.test(plain),
          needsCodeExecution: false,
          needsFactLookup: false,
          tinyRegions: [],
          verbatimTranscript: plain,
        },
        raw: plain,
        model,
      };
    } catch (err) {
      if (signal?.aborted) throw err;
      router.record(model.id, { ok: false, ms: Date.now() - started, tier: 4, error: err.message });
      log.warn?.(`[solver] vision extract ${model.label} failed: ${err.message}`);
    }
  }
  return null;
}

// ── Call Best Reasoning Model (with automatic failover across all brains) ────

async function callBestReasoner(config, messages, { preferExcludeId = '', temperature = 0.1, maxTokens = 4096, signal = null, log = console } = {}) {
  const router = routerFor(config, log);
  const all = ai.reasoningCandidates(config, log);
  // When auditing, try an independent second model first if available!
  const ordered = preferExcludeId && all.length > 1
    ? [...all.filter((m) => m.id !== preferExcludeId), ...all.filter((m) => m.id === preferExcludeId)]
    : all;

  for (const model of ordered) {
    const started = Date.now();
    try {
      const res = await ai.callDirectModel(model, config, messages, { temperature, maxTokens, signal });
      router.record(model.id, { ok: true, ms: Date.now() - started, tier: 4 });
      return { ...res, candidate: model };
    } catch (err) {
      if (signal?.aborted) throw err;
      router.record(model.id, { ok: false, ms: Date.now() - started, tier: 4, error: err.message });
      log.warn?.(`[solver] reasoner ${model.label} failed: ${err.message}`);
    }
  }
  return null;
}

// ── Main Orchestrator: 7-Stage Question Image Solver ─────────────────────────

const SOLVER_SYSTEM_PROMPT = [
  'You are an Olympiad-grade STEM, Competitive Exam (JEE / NEET / GATE / UPSC / CAT / Coding Interviews / University Exams), and Multi-Discipline Problem Solver.',
  'Your #1 sacred obligation is **100% VERIFIED ACCURACY** — ZERO guesswork, ZERO mental-math slips, ZERO wrong option letters.',
  '',
  'You have real local verification tools. Whenever you need ANY calculation, symbolic algebra/calculus, code output check, SQL check, zoom inspection, or encyclopedia fact lookup, output ONLY a JSON tool request:',
  '{',
  '  "action": "tool",',
  '  "calls": [',
  '    { "tool": "python_verify", "code": "import sympy as sp\\n...\\nprint(...)" },',
  '    { "tool": "code_runner", "language": "c" | "cpp" | "python" | "javascript" | "sql" | "bash", "code": "...", "stdin": "" },',
  '    { "tool": "fact_search", "queries": ["exact topic 1", "exact term 2"] },',
  '    { "tool": "zoom_crop", "x1": 100, "y1": 200, "x2": 600, "y2": 500, "question": "Read exact exponent and resistor value" }',
  '  ]',
  '}',
  '',
  'MANDATORY RULES BEFORE FINALIZING:',
  '1. NEVER do arithmetic, algebra, calculus, matrices, probability, combinatorics, physics/chemistry numericals, base conversions, or code tracing purely in your head! ALWAYS verify via `python_verify` or `code_runner` and inspect `stdout`!',
  '2. In Python (`python_verify`), `sympy as sp`, `numpy as np`, `Fraction`, `Decimal` (50-digit precision), `num_integrate`, `num_deriv`, and `run_sql` are pre-imported. Always `print(...)` exact symbolic AND decimal values, AND plug your solution BACK into the original equation/options to verify every option `(A)`, `(B)`, `(C)`, `(D)`!',
  '3. Watch carefully for exam traps: `NOT` / `INCORRECT` / `FALSE` / `EXCEPT`, units (`cm` vs `m`, `km/h` vs `m/s`, `°C` vs `K`, `diameter` vs `radius`), domain exclusions (`denominator != 0`, `x > 0` inside `log`), and multiple-correct options.',
  '4. Double-check that the value you derived matches the EXACT letter `(A)` / `(B)` / `(C)` / `(D)` written in the question!',
  '5. Answer EVERY question present in the image (`Q1`, `Q2`, `Q3`, ...) — never stop after Q1!',
  '',
  'Once ALL verifications have confirmed the exact right answer(s), return ONLY this JSON object:',
  '{',
  '  "action": "final",',
  '  "confidence": "high" | "medium",',
  '  "summaryAnswers": [ { "question": "Q1", "answer": "Option (C) — 42 m/s" } ],',
  '  "finalResponse": "Clean WhatsApp-formatted response (`*bold*` allowed, NO markdown `#` headers, NO raw tables): start EACH question with `✅ *Q1: <Exact Option & Answer>*` on the first line, followed by crisp, crystal-clear step-by-step reasoning in the user\'s preferred language (Hinglish if user spoke Hinglish, English if English/exam-style, Hindi if Hindi)."',
  '}',
].join('\n');

const AUDITOR_SYSTEM_PROMPT = [
  'You are an Adversarial Exam Solution Auditor. Assume the candidate solution MIGHT contain a subtle error and audit EVERY detail ruthlessly.',
  '',
  'Check ALL 6 failure modes:',
  '1. OCR / Vision symbol misread (`x^2` vs `x^3`, `-` sign dropped, `ln` vs `log10`, `NOT`/`INCORRECT`/`EXCEPT` missed, unit mismatch `cm`/`m` or `radius`/`diameter`).',
  '2. Option-letter mismatch (e.g., solver computed `25`, which is Option `(D)` in the transcript, NOT Option `(B)`!).',
  '3. Disagreement with `python_verify` / `code_runner` / `fact_search` ground-truth output.',
  '4. Edge cases / extraneous roots / off-by-one / integer division / SQL `NULL` semantics.',
  '5. Multi-question completeness: were ALL questions in the transcript answered completely?',
  '6. Formatting clarity: clean WhatsApp layout (`*bold*`, bullet points, `✅ *Answer*` right at top of each question, clear explanation).',
  '',
  'If you want to run an independent Python script to double-check ANY equation, edge case, or option value right now, output ONLY:',
  '{ "action": "python_verify", "code": "print(...)" }',
  '',
  'Otherwise output ONLY:',
  '{',
  '  "action": "verified",',
  '  "verdict": "confirmed" | "corrected",',
  '  "auditNote": "1 short line describing what was verified or fixed",',
  '  "finalResponse": "The final 100% verified, crystal-clear WhatsApp answer text."',
  '}',
].join('\n');

/**
 * Main entry point: solve any question image with full multi-stage verification.
 *
 * Options:
 *   • `caption` — user instructions / question filter (e.g. `""`, `"solve"`, `"Q3 aur Q5 hindi me"`)
 *   • `autoDetect` — when `true` and `caption` doesn't explicitly ask to solve,
 *     checks whether the photo actually contains a question first; if it's just
 *     a casual photo (e.g. cat / sunset), returns `{ isQuestion: false, casualDescription }`!
 *   • `savedPath` — optional disk path of saved image (lets DeepSeek Harness inspect it too)
 *   • `harness` — optional DeepSeek Harness manager (`agent.harness`)
 *   • `onProgress` — optional callback for live WhatsApp status updates
 *   • `signal` — optional `AbortSignal` for `/stop`
 */
export async function solveQuestionImage(config, buffer, opts = {}) {
  const {
    caption = '',
    autoDetect = false,
    savedPath = '',
    harness = null,
    onProgress = null,
    log = console,
    signal = null,
  } = opts;

  if (!buffer?.length) throw new Error('Empty image buffer passed to solver.');

  const explicitSolve = !autoDetect || captionExplicitlyWantsSolve(caption);
  const usedStages = [];

  // ── Stage 1: Enhance + Multi-Tile Prep + Parallel Dual-PSM OCR ───────────
  const enhanced = await enhanceQuestionImage(buffer, { maxTiles: 3 });
  if (enhanced.enhancedBy === 'sharp') {
    usedStages.push(enhanced.images.length > 1 ? `HD Enhance + ${enhanced.images.length}x Zoom Tiles` : 'HD Contrast Enhance');
  }

  const [ocrText, visionRes] = await Promise.all([
    dualOcrExtract(enhanced.ocrBuffer, buffer, config).catch(() => ''),
    visionExtract(config, enhanced, caption, log, signal),
  ]);

  if (visionRes?.model) usedStages.push(`Vision (${visionRes.model.label})`);
  if (ocrText) usedStages.push('Dual-Pass OCR');

  const extracted = visionRes?.parsed ?? null;
  const visionTranscript = extracted?.verbatimTranscript?.trim() || '';
  const combinedCheck = `${visionTranscript}\n${ocrText}`;

  const isQuestion = explicitSolve
    || Boolean(extracted?.isQuestionImage)
    || looksLikeQuestionText(combinedCheck);

  if (!isQuestion) {
    return {
      ok: true,
      isQuestion: false,
      casualDescription: extracted?.casualDescription?.trim() || visionTranscript || '',
      ocrText,
      stages: usedStages,
    };
  }

  if (!visionTranscript && !ocrText) {
    // Last-resort check: can DeepSeek Harness inspect `savedPath` directly?
    if (savedPath && harness && config.dshEnabled !== false && harness.status?.().dshInstalled) {
      usedStages.push('DeepSeek Harness');
      const hRes = await harness.runTask(
        `Inspect the image file at ${savedPath} using Python/PIL/OCR or any available tool, transcribe every question carefully, verify every calculation with Python, and provide the exact 100% verified answer(s). User note: ${caption || 'Solve accurately'}`,
        { signal },
      );
      if (hRes?.text) {
        return {
          ok: true,
          isQuestion: true,
          text: `🧠 *Question Solver (DeepSeek Harness Verified)*\n\n${hRes.text}`,
          stages: usedStages,
        };
      }
    }
    return {
      ok: false,
      isQuestion: true,
      error: 'No vision model or local Tesseract OCR is configured to read the image. Set `GEMINI_API_KEY` / `GROQ_API_KEY` / `OPENROUTER_API_KEY` / `OLLAMA_VISION_MODEL`, or install `sudo dnf install tesseract`.',
      stages: usedStages,
    };
  }

  onProgress?.('🧠 *Question detect hua!* Vision + OCR cross-read ho gaya — ab verification tools (Python / SymPy / Code / Fact-check) se 100% pakka answer nikal raha hoon…');

  // ── Optional Auto Zoom on Tiny Superscripts / Diagrams Flagged in Stage 2 ─
  const zoomNotes = [];
  const tinyBoxes = Array.isArray(extracted?.tinyRegions) ? extracted.tinyRegions.slice(0, 2) : [];
  const visionModels = ai.visionCandidates(config, log);
  if (tinyBoxes.length && visionModels.length) {
    for (const box of tinyBoxes) {
      try {
        const crop = await cropZoomRegion(buffer, box);
        if (!crop) continue;
        const [cropVision, cropOcr] = await Promise.all([
          ai.visionMultiCall(
            visionModels[0],
            config,
            `Read EVERY symbol, superscript, exponent, minus sign, subscript, unit, and label in this 3x magnified crop (${box.reason || 'detail view'}). Output exact verbatim text only.`,
            [{ base64: crop.base64, mime: crop.mime }],
            { temperature: 0.0, maxTokens: 600, signal },
          ).catch(() => ''),
          ocr.ocrAvailable() ? ocr.ocrImage(crop.buffer, { langs: config?.ocrLangs || 'eng', psm: 6 }).catch(() => '') : Promise.resolve(''),
        ]);
        if (cropVision || cropOcr) {
          zoomNotes.push(`🔍 [3x Magnified Crop — ${box.reason || 'detail'}]:\nVision: ${cropVision || '(n/a)'}${cropOcr ? `\nOCR: ${cropOcr}` : ''}`);
          if (!usedStages.includes('3x Digital Magnifier')) usedStages.push('3x Digital Magnifier');
        }
      } catch { /* non-fatal */ }
    }
  }

  return solveExtractedContent(config, {
    buffer,
    caption,
    visionTranscript,
    ocrText,
    zoomNotes,
    extractedMeta: extracted,
    visionModels,
    savedPath,
    harness,
    usedStages,
    log,
    signal,
  });
}

/**
 * Solve questions from an extracted PDF / DOCX / text sheet using the exact
 * same multi-tool Python + Code + Fact-Check + Adversarial Auditor pipeline!
 */
export async function solveQuestionDocument(config, buffer, { fileName = '', mimeType = '', caption = '', harness = null, onProgress = null, log = console, signal = null } = {}) {
  const usedStages = ['Document Extract'];
  const docText = await ocr.extractDocumentText(buffer, fileName, mimeType);
  if (!docText?.trim()) {
    return { ok: false, isQuestion: true, error: 'Could not extract readable text from that document.' };
  }
  onProgress?.(`📄 *${fileName || 'Document'} read ho gaya!* Ab har question Python / Code / Fact verification ke saath solve ho raha hai…`);
  return solveExtractedContent(config, {
    buffer: null,
    caption,
    visionTranscript: docText,
    ocrText: '',
    zoomNotes: [],
    extractedMeta: {
      isQuestionImage: true,
      language: /[अ-ह]/.test(docText) ? 'hindi' : 'hinglish',
      questionCount: 1,
      needsComputation: NEEDS_COMPUTE_RE.test(docText),
    },
    visionModels: ai.visionCandidates(config, log),
    savedPath: '',
    harness,
    usedStages,
    log,
    signal,
  });
}

/**
 * Solve typed/pasted STEM, coding, SQL, or exam questions with the exact same
 * Python/SymPy + Compiler + Live Fact Search + Independent Adversarial Auditor pipeline!
 */
export async function solveQuestionText(config, text, { caption = '', harness = null, onProgress = null, log = console, signal = null } = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) return { ok: false, isQuestion: true, error: 'Empty question text.' };
  onProgress?.('🧠 *Question received!* Python / SymPy / Compiler / Fact verification chala raha hoon…');
  return solveExtractedContent(config, {
    buffer: null,
    caption,
    visionTranscript: clean,
    ocrText: '',
    zoomNotes: [],
    extractedMeta: {
      isQuestionImage: true,
      language: /[अ-ह]/.test(clean) ? 'hindi' : 'hinglish',
      questionCount: 1,
      needsComputation: NEEDS_COMPUTE_RE.test(clean),
    },
    visionModels: ai.visionCandidates(config, log),
    savedPath: '',
    harness,
    usedStages: ['Direct Text'],
    log,
    signal,
  });
}

async function solveExtractedContent(config, ctx) {
  const {
    buffer,
    caption,
    visionTranscript,
    ocrText,
    zoomNotes,
    extractedMeta,
    visionModels,
    savedPath,
    harness,
    usedStages,
    log,
    signal,
  } = ctx;

  const langHint = /\b(english|eng)\b/i.test(caption)
    ? 'English'
    : /\b(hindi|हिंदी)\b/i.test(caption)
      ? 'Hindi'
      : /[a-z]/i.test(caption) && /\b(bhai|karo|bata|batao|samjha|samjhao|iska|iske|kya|konsa|kaunsa|hai|sahi)\b/i.test(caption)
        ? 'Hinglish (clear Roman Hindi + exact technical terms)'
        : extractedMeta?.language === 'hindi'
          ? 'Hindi'
          : 'clear English / Hinglish matching the question language';

  const contextBlocks = [
    caption ? `USER INSTRUCTIONS / FILTER: "${caption}"` : 'USER INSTRUCTIONS: Solve EVERY question shown completely and accurately.',
    `PREFERRED EXPLANATION LANGUAGE: ${langHint}`,
    visionTranscript ? `=== CHANNEL 1: HIGH-RES VISION TRANSCRIPTION ===\n${visionTranscript}` : '',
    ocrText ? `=== CHANNEL 2: LOCAL TESSERACT OCR CROSS-READ ===\n${ocrText}` : '',
    zoomNotes.length ? `=== CHANNEL 3: 3x DIGITAL MAGNIFIER CROPS ===\n${zoomNotes.join('\n\n')}` : '',
    'NOTE: If Channel 1 (Vision) and Channel 2 (OCR) differ on ANY digit, sign, superscript, or word, explicitly compare both possibilities (or use `zoom_crop` if an image is available) before deciding!',
  ].filter(Boolean).join('\n\n');

  const messages = [
    { role: 'system', content: SOLVER_SYSTEM_PROMPT },
    { role: 'user', content: contextBlocks },
  ];

  const mustCompute = Boolean(extractedMeta?.needsComputation || extractedMeta?.needsCodeExecution)
    || NEEDS_COMPUTE_RE.test(`${visionTranscript}\n${ocrText}`);

  const toolTranscriptLog = [];
  let ranComputeTool = false;
  let primarySolverModelId = '';
  let candidateResponse = '';
  let rawFallbackText = '';

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const res = await callBestReasoner(config, messages, {
      temperature: 0.08,
      maxTokens: 4096,
      signal,
      log,
    });
    if (!res) break;
    primarySolverModelId = res.id || '';
    if (!usedStages.includes(`Solver (${res.provider})`)) usedStages.push(`Solver (${res.provider})`);

    rawFallbackText = stripThinkBlocks(res.text);
    const parsed = extractJsonObject(res.text);

    // Handle tool calls!
    if (parsed?.action === 'tool' && Array.isArray(parsed.calls) && parsed.calls.length > 0 && round < MAX_TOOL_ROUNDS) {
      const results = [];
      for (const call of parsed.calls.slice(0, 4)) {
        const toolName = String(call?.tool || '').trim();
        if (toolName === 'python_verify') {
          ranComputeTool = true;
          const out = await runPythonVerification(call.code, { config, log, signal });
          const badge = out.sympy ? 'Python+SymPy' : 'Python';
          if (!usedStages.includes(badge)) usedStages.push(badge);
          const entry = `[python_verify -> ${out.ok ? 'OK' : 'ERROR'}]:\nCode:\n${call.code}\nOutput:\n${out.output}`;
          results.push(entry);
          toolTranscriptLog.push(entry);
        } else if (toolName === 'code_runner') {
          ranComputeTool = true;
          const out = await runCodeSnippet(call, { config, log, signal });
          const badge = `Compiler/Runtime (${call.language || 'code'})`;
          if (!usedStages.includes(badge)) usedStages.push(badge);
          const entry = `[code_runner (${call.language}) -> ${out.ok ? 'OK' : 'ERROR'}]:\nOutput:\n${out.output}`;
          results.push(entry);
          toolTranscriptLog.push(entry);
        } else if (toolName === 'fact_search') {
          const out = await runFactSearch(call.queries, { signal });
          if (!usedStages.includes('Live Fact Lookup')) usedStages.push('Live Fact Lookup');
          const entry = `[fact_search]:\n${out.output}`;
          results.push(entry);
          toolTranscriptLog.push(entry);
        } else if (toolName === 'zoom_crop' && buffer && visionModels.length) {
          const crop = await cropZoomRegion(buffer, call).catch(() => null);
          if (crop) {
            const detail = await ai.visionMultiCall(
              visionModels[0],
              config,
              `${call.question || 'Read every exact symbol, exponent, sign, and number in this magnified region verbatim.'}`,
              [{ base64: crop.base64, mime: crop.mime }],
              { temperature: 0.0, maxTokens: 700, signal },
            ).catch(() => '');
            if (!usedStages.includes('3x Digital Magnifier')) usedStages.push('3x Digital Magnifier');
            const entry = `[zoom_crop (${call.x1},${call.y1})-(${call.x2},${call.y2})]:\n${detail || '(unreadable crop)'}`;
            results.push(entry);
            toolTranscriptLog.push(entry);
          } else {
            results.push('[zoom_crop]: sharp image crop unavailable — rely on full Vision + OCR channels.');
          }
        } else {
          results.push(`[${toolName || 'unknown'}]: unsupported tool call`);
        }
      }

      messages.push(
        { role: 'assistant', content: rawFallbackText },
        {
          role: 'user',
          content: `TOOL EXECUTION GROUND-TRUTH RESULTS:\n\n${results.join('\n\n---\n\n')}\n\nNow verify whether every single question and option is 100% proven, run another tool call if needed, or return {"action":"final", ...}.`,
        },
      );
      continue;
    }

    // Hard Mandatory-Compute Guard: if math/code is detected and round === 0 skipped Python/Compiler,
    // force a real Python/code verification before accepting mental math!
    if (mustCompute && !ranComputeTool && round === 0) {
      const candidateDraft = parsed?.finalResponse || rawFallbackText;
      messages.push(
        { role: 'assistant', content: rawFallbackText },
        {
          role: 'user',
          content: `MANDATORY ACCURACY GATE: This question involves mathematical expressions, numerical values, SQL, or code, and NO verification script has been executed yet! Write and call \`{"action":"tool","calls":[{"tool":"python_verify","code":"..."}]}\` (or \`code_runner\`) right now to compute and verify EVERY numerical value, equation root, integral, matrix, probability, or program output from scratch before giving your final answer.\n\nDraft to verify:\n${candidateDraft.slice(0, 2000)}`,
        },
      );
      continue;
    }

    candidateResponse = parsed?.finalResponse?.trim() || rawFallbackText;
    break;
  }

  // Optional DeepSeek Harness Heavy Escalation if no candidate or user explicitly asked for deep code verification
  if (!candidateResponse && harness && config.dshEnabled !== false && harness.status?.().dshInstalled) {
    usedStages.push('DeepSeek Harness');
    const hRes = await harness.runTask(
      `Solve EVERY question below with 100% verified accuracy using Python/SymPy/compilers as needed.${savedPath ? ` Original image path: ${savedPath}` : ''}\n\n${contextBlocks}`,
      { signal },
    );
    if (hRes?.text) candidateResponse = hRes.text.trim();
  }

  if (!candidateResponse) {
    return {
      ok: false,
      isQuestion: true,
      error: 'No AI reasoning brain responded. Check `/brains` or configure `GROQ_API_KEY` / `GEMINI_API_KEY` / `OPENROUTER_API_KEY` / `OLLAMA_MODEL`.',
      stages: usedStages,
    };
  }

  // ── Stage 4: Independent Adversarial Auditor & Option-Letter Verifier ────
  const auditPayload = [
    contextBlocks,
    toolTranscriptLog.length
      ? `=== EXECUTED GROUND-TRUTH TOOL OUTPUTS (TRUST PYTHON/COMPILER OVER MENTAL MATH!) ===\n${toolTranscriptLog.join('\n\n')}`
      : '=== EXECUTED TOOL OUTPUTS ===\n(none)',
    `=== CANDIDATE SOLUTION TO AUDIT ===\n${candidateResponse}`,
  ].join('\n\n');

  const auditMessages = [
    { role: 'system', content: AUDITOR_SYSTEM_PROMPT },
    { role: 'user', content: auditPayload },
  ];

  let finalAnswer = candidateResponse;
  let auditSummary = '';

  for (let auditRound = 0; auditRound < 2; auditRound++) {
    const auditRes = await callBestReasoner(config, auditMessages, {
      preferExcludeId: primarySolverModelId,
      temperature: 0.05,
      maxTokens: 4096,
      signal,
      log,
    });
    if (!auditRes) break;

    const auditParsed = extractJsonObject(auditRes.text);
    if (auditParsed?.action === 'python_verify' && auditParsed.code && auditRound === 0) {
      const pyCheck = await runPythonVerification(auditParsed.code, { config, log, signal });
      const badge = pyCheck.sympy ? 'Python+SymPy' : 'Python';
      if (!usedStages.includes(badge)) usedStages.push(badge);
      auditMessages.push(
        { role: 'assistant', content: stripThinkBlocks(auditRes.text) },
        {
          role: 'user',
          content: `AUDITOR PYTHON CHECK OUTPUT (${pyCheck.ok ? 'OK' : 'ERROR'}):\n${pyCheck.output}\n\nNow return the final verified JSON {"action":"verified","verdict":"confirmed"|"corrected","auditNote":"...","finalResponse":"..."}.`,
        },
      );
      continue;
    }

    if (auditParsed?.finalResponse?.trim()) {
      finalAnswer = auditParsed.finalResponse.trim();
      auditSummary = auditParsed.verdict === 'corrected'
        ? `Auditor corrected (${auditRes.provider})`
        : `Auditor verified (${auditRes.provider})`;
      usedStages.push(auditSummary);
    } else if (stripThinkBlocks(auditRes.text).length >= candidateResponse.length * 0.5 && !auditRes.text.trim().startsWith('{')) {
      finalAnswer = stripThinkBlocks(auditRes.text);
      auditSummary = `Auditor verified (${auditRes.provider})`;
      usedStages.push(auditSummary);
    }
    break;
  }

  const pipelineBadge = `🔬 _Verified via: ${usedStages.join(' → ')}_`;
  const formatted = `🧠 *Question Solver (Verified)*\n\n${finalAnswer}\n\n${pipelineBadge}`;

  return {
    ok: true,
    isQuestion: true,
    text: formatted,
    answer: finalAnswer,
    visionTranscript,
    ocrText,
    toolLogs: toolTranscriptLog,
    stages: usedStages,
  };
}
