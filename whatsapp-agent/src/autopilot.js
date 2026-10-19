// autopilot.js — one-command browser/desktop automation.
//  "open agent, click battle, pick agent from dropdown, type, enter, ss"
//
// Usage:
//   /auto open agent | tap battle | tap agent | type how to use ai | key enter | screenshot
//   /auto open agent and click battle then select agent and ask how to use ai
//
// The explicit pipe syntax is the reliable path (no AI guessing). The natural
// language path is best-effort and falls back to the same steps.
//
// Pipeline per step:
//   open <app>  -> apps.launchApp (or URL via pc.openTarget)
//   tap <label> -> finder.locateOnScreen + pc.click  (OCR, falls back to vision model)
//   click x y   -> pc.click
//   type <text> -> pc.pasteText (fast, keeps unicode)
//   key <combo> -> pc.keyCombo  (e.g. enter, ctrl+l)
//   wait <ms>   -> sleep
//   screenshot / ss -> pc.captureScreenshot
//   look [q]    -> ocr.lookAtScreen

import * as apps from './apps.js';
import * as pc from './pccontrol.js';
import * as finder from './elementfinder.js';
import * as ocr from './ocr.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WEB_URLS = {
  gemini: 'https://gemini.google.com',
  bard: 'https://gemini.google.com',
  chatgpt: 'https://chatgpt.com',
  'chat gpt': 'https://chatgpt.com',
  gpt: 'https://chatgpt.com',
  claude: 'https://claude.ai',
  perplexity: 'https://www.perplexity.ai',
  copilot: 'https://copilot.microsoft.com',
  arena: 'https://arena.ai/agent',
  'arena ai': 'https://arena.ai/agent',
  agent: 'https://arena.ai/agent',
  'agent mode': 'https://arena.ai/agent',
  'arena agent': 'https://arena.ai/agent',
};

function clean(s) { return String(s ?? '').replace(/\s+/g, ' ').trim(); }

function resolveWebUrl(appName) {
  const low = normalizeApp(appName);
  if (WEB_URLS[low]) return WEB_URLS[low];
  for (const [k, url] of Object.entries(WEB_URLS)) {
    if (low.includes(k) || k.includes(low)) return url;
  }
  return null;
}

function normalizeApp(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function parseAutoSteps(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return [];
  // Explicit pipe syntax:  open agent | tap battle | tap agent | type how to use ai | key enter | screenshot
  // Only treat as explicit if it actually contains a separator — otherwise natural phrases like
  // "open agent and click battle..." would be mis-split into a single open.
  if (t.includes('|') || t.includes(';') || t.includes('\n')) {
    const parts = t.split(/[|;]+/).map(s => s.trim()).filter(Boolean);
    // also handle newline
    const expanded = [];
    for (const p of parts) expanded.push(...p.split(/\n/).map(s => s.trim()).filter(Boolean));
    return expanded.map(parseSingleStep).filter(Boolean);
  }
  // Natural language fallback
  return parseNaturalLanguage(t);
}

function parseSingleStep(part) {
  const p = clean(part);
  if (!p) return null;
  let m;
  if ((m = p.match(/^(?:open|launch)\s+(.+)$/i))) return { op: 'open', target: clean(m[1]) };
  if ((m = p.match(/^(?:tap|click)\s+(.+)$/i))) return { op: 'tap', label: clean(m[1]) };
  if ((m = p.match(/^tap\s+on\s+(.+)$/i))) return { op: 'tap', label: clean(m[1]) };
  if ((m = p.match(/^click\s+(-?\d+)\s+(-?\d+)$/i))) return { op: 'click', x: Number(m[1]), y: Number(m[2]) };
  if ((m = p.match(/^(?:type|paste)\s+(.+)$/i))) return { op: 'type', text: m[1] };
  if ((m = p.match(/^(?:key|press)\s+(.+)$/i))) return { op: 'key', combo: clean(m[1]) };
  if ((m = p.match(/^(?:wait|sleep)\s+(\d+)\s*(?:ms|s|sec)?$/i))) {
    let ms = Number(m[1]);
    // if user wrote "wait 5" assume seconds if <= 30, else ms
    if (/s|sec/i.test(p)) ms *= 1000;
    else if (ms <= 30) ms *= 1000;
    return { op: 'wait', ms };
  }
  if (/^(?:screenshot|ss|screen)$/i.test(p)) return { op: 'screenshot' };
  if ((m = p.match(/^look(?:\s+(.+))?$/i))) return { op: 'look', question: m[1] ? clean(m[1]) : '' };
  // bare label like "battle" in pipe mode -> treat as tap
  if (/^[\w\- ]{2,40}$/.test(p) && !/\s/.test(p) || p.split(/\s+/).length <= 3) {
    // heuristic: single word in pipe sequence is likely a tap target if not matched above
    // but to avoid misclassifying, only if previous steps suggest tapping
    // we treat unknown short phrase as tap (caller can be explicit with "tap battle")
    // For safety, return null here and let caller decide — we will handle via tap inference
    // Instead, treat bare phrase as tap
    return { op: 'tap', label: p };
  }
  return null;
}

function parseNaturalLanguage(task) {
  const steps = [];
  const t = clean(task);
  const low = t.toLowerCase();

  // 1) open/launch — take the first 1-2 words after "open" until a verb
  let m = t.match(/open\s+([a-z0-9_\- ]{1,40})/i);
  if (m) {
    let cand = clean(m[1]);
    const verbs = new Set(['go','and','then','click','clicking','tap','tapping','select','selecting','type','typing','ask','asking','by','to','on','in','for','with']);
    const parts = cand.split(/\s+/);
    const appParts = [];
    for (const w of parts) {
      if (verbs.has(w.toLowerCase())) break;
      appParts.push(w);
      if (appParts.length >= 2) break;
    }
    let app = appParts.join(' ').trim().replace(/^(the\s+)?app\s+/i, '').trim();
    // Brave PWA installs are named like "Arena" but user says "agent" — keep as-is, launchApp will fuzzy-match
    if (app) steps.push({ op: 'open', target: app });
  } else if ((m = t.match(/^(?:launch|open)\s+(.+)$/i))) {
    steps.push({ op: 'open', target: clean(m[1]) });
  }

  // 2) battle -> tap battle
  if (/\bbattle\b/i.test(low)) steps.push({ op: 'tap', label: 'battle' });

  // 3) selecting agent from dropdown -> tap agent
  // The phrase "selecting agent from drop down" -> tap agent
  if (/(?:select|choose).*agent.*drop/i.test(low) || /drop\s*down.*agent/i.test(low)) {
    steps.push({ op: 'tap', label: 'agent' });
  } else if (/\bagent mode\b/i.test(low)) {
    // agent mode might be separate tap
    if (!steps.some(s => s.label && s.label.toLowerCase() === 'agent')) steps.push({ op: 'tap', label: 'agent' });
  }

  // 4) type / ask
  let typed = null;
  if ((m = t.match(/type\s+(.+?)(?:\s+then\s+enter|\s+and\s+enter|\s+enter|$)/i))) typed = clean(m[1]);
  else if ((m = t.match(/(?:ask|how to use.+|type how.+|say\s+)(.+?)(?:\s+then\s+enter|\s+and\s+press|\s*enter|$)/i))) typed = clean(m[1]);
  if (typed) {
    typed = typed.replace(/^["']|["']$/g, '').trim();
    if (typed) {
      steps.push({ op: 'type', text: typed });
      // asking implies submit — auto-add enter unless user already said enter and we will dedup below
      if (!/\benter\b/i.test(low)) steps.push({ op: 'key', combo: 'enter' });
    }
  }

  // 5) enter (if not already added via type->enter)
  if (/\benter\b/i.test(low) && !steps.some(s => s.op === 'key')) steps.push({ op: 'key', combo: 'enter' });

  // 6) always finish with screenshot
  steps.push({ op: 'screenshot' });
  return steps;
}

export async function runAutopilot(rawTask, { config, log } = {}) {
  const steps = parseAutoSteps(rawTask);
  if (!steps.length) throw new Error('usage: /auto open <app> | tap <label> | type <text> | key enter | screenshot\nExample: /auto open agent | tap battle | tap agent | type how to use ai | key enter | screenshot');

  const outLines = [];
  let lastImage = null;
  let waitAfterOpen = 4500;

  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    outLines.push(`Step ${i + 1}/${steps.length}: ${describeStep(st)}`);
    try {
      if (st.op === 'open') {
        const target = String(st.target ?? '').trim();
        if (!target) throw new Error('open needs an app name');
        const url = resolveWebUrl(target);
        if (url) {
          log?.info?.(`[auto] opening URL ${url} for "${target}"`);
          try {
            await pc.openTarget(url);
            outLines[outLines.length - 1] += ` → opened ${url}`;
          } catch (e) {
            // Fallback: try desktop app if URL open fails
            log?.info?.(`[auto] URL open failed (${e.message}), trying desktop app "${target}"`);
            const r = await apps.launchApp(target);
            outLines[outLines.length - 1] += ` → ${r.text} (fallback)`;
          }
        } else {
          try {
            const r = await apps.launchApp(target);
            outLines[outLines.length - 1] += ` → ${r.text}`;
          } catch (e) {
            // If desktop app not found but it's a known web app alias (agent/arena), try URL
            const fbUrl = target.toLowerCase().includes('agent') ? WEB_URLS['agent'] : null;
            if (fbUrl && /couldn't find an app|could not find|not found/i.test(String(e.message))) {
              log?.info?.(`[auto] app "${target}" not found, falling back to URL ${fbUrl}`);
              await pc.openTarget(fbUrl);
              outLines[outLines.length - 1] += ` → opened ${fbUrl} (desktop miss, URL fallback)`;
            } else {
              throw e;
            }
          }
        }
        await sleep(waitAfterOpen);
      } else if (st.op === 'tap') {
        const label = String(st.label ?? '').trim();
        if (!label) throw new Error('tap needs a label');
        log?.info?.(`[auto] locate "${label}"`);
        // Try OCR/vision first, then coordinate fallback for known Arena buttons
        let hit = null;
        let usedFallback = false;
        // Try case variants for Arena (Battle/Agent are capital B/A in dark UI)
        const variants = [label, label.charAt(0).toUpperCase()+label.slice(1).toLowerCase(), label.toUpperCase(), label.toLowerCase()];
        const tried = new Set();
        for (const v of variants) {
          if (tried.has(v)) continue;
          tried.add(v);
          try {
            hit = await finder.locateOnScreen(config, v, log);
            if (hit) break;
          } catch {}
        }
        if (hit) {
          await pc.click(hit.x, hit.y);
          outLines[outLines.length - 1] += ` → clicked "${hit.matched}" @ ${hit.x},${hit.y} (${hit.source}${hit.confidence ? ` ${hit.confidence}%` : ''})`;
        } else {
          // Coordinate fallback — measured from Arena screenshot (1920x1080, Brave PWA)
          // Battle ▾ is below "Ask anything..." box, Agent is first item in its dropdown
          const low = label.toLowerCase();
          const FALLBACK = {
            'battle': { rx: 0.422, ry: 0.492 },
            'agent':  { rx: 0.422, ry: 0.545 },
            'auto':   { rx: 0.470, ry: 0.492 },
          };
          const fb = FALLBACK[low];
          if (fb) {
            // Need screen size — capture a throwaway screenshot to learn dimensions
            let size = null;
            try {
              const tmp = await pc.captureScreenshot({ portalTimeoutMs: config?.portalTimeoutMs });
              const sz = finder.pngSize(tmp);
              if (sz) size = sz;
              // keep this screenshot as well if we haven't yet
              if (!lastImage) lastImage = tmp;
            } catch {}
            const W = size?.width ?? 1920;
            const H = size?.height ?? 1080;
            const x = Math.round(W * fb.rx);
            const y = Math.round(H * fb.ry);
            log?.info?.(`[auto] tap "${label}" OCR miss — fallback click @ ${x},${y} (${Math.round(fb.rx*100)}%,${Math.round(fb.ry*100)}% of ${W}x${H})`);
            await pc.click(x, y);
            outLines[outLines.length - 1] += ` → fallback click @ ${x},${y} (OCR miss, used coords)`;
            usedFallback = true;
          } else {
            throw new Error(`I couldn't find "${label}" on the screen. Try /pc screenshot + /ocr to see exact label, or use: click X Y`);
          }
        }
        await sleep(usedFallback ? 1500 : 1200);
      } else if (st.op === 'click') {
        await pc.click(Number(st.x), Number(st.y));
        outLines[outLines.length - 1] += ` → clicked ${st.x},${st.y}`;
        await sleep(800);
      } else if (st.op === 'type') {
        const text = String(st.text ?? '');
        if (!text) throw new Error('type needs text');
        // paste is faster + keeps formatting, but on some Wayland setups wl-copy/xclip hangs — fallback to ydotool typing
        try {
          await pc.pasteText(text);
          outLines[outLines.length - 1] += ` → pasted ${text.length} chars (clipboard)`;
        } catch (e) {
          log?.info?.(`[auto] pasteText failed (${e.message}), falling back to typeText`);
          await pc.typeText(text);
          outLines[outLines.length - 1] += ` → typed ${text.length} chars (fallback)`;
        }
        await sleep(700);
      } else if (st.op === 'key') {
        await pc.keyCombo(String(st.combo ?? 'enter'));
        outLines[outLines.length - 1] += ` → key ${st.combo}`;
        // If next step is screenshot, wait for AI/page to respond (Arena/ChatGPT etc ~5s)
        const nextIsScreenshot = steps[i+1]?.op === 'screenshot';
        await sleep(nextIsScreenshot ? 6000 : 900);
      } else if (st.op === 'wait') {
        const ms = Math.min(Math.max(Number(st.ms) || 1000, 200), 20000);
        await sleep(ms);
        outLines[outLines.length - 1] += ` → waited ${ms}ms`;
      } else if (st.op === 'screenshot') {
        const img = await pc.captureScreenshot({ portalTimeoutMs: config?.portalTimeoutMs });
        lastImage = img;
        outLines[outLines.length - 1] += ` → captured ${img.length} bytes`;
        await sleep(400);
      } else if (st.op === 'look') {
        const res = await ocr.lookAtScreen(config, st.question ?? '', log);
        const txt = typeof res === 'string' ? res : String(res?.text ?? res ?? '');
        outLines[outLines.length - 1] += ` → look: ${txt.slice(0, 120)}`;
        if (res?.image) lastImage = res.image;
      }
    } catch (err) {
      const msg = String(err?.message ?? err).slice(0, 500);
      outLines.push(`❌ Failed at step ${i + 1}: ${msg}`);
      // capture failure screenshot for debugging
      try {
        const failImg = await pc.captureScreenshot({ portalTimeoutMs: config?.portalTimeoutMs }).catch(() => null);
        if (failImg) lastImage = failImg;
      } catch {}
      const text = `🤖 Autopilot stopped at step ${i + 1}/${steps.length}\n\n${outLines.join('\n')}\n\nTip: /auto uses OCR (tesseract) to find button text. If "battle" not found, try exact label from /screenshot + /ocr, or use coordinates: tap battle → click 800 400.`;
      return lastImage ? { text, image: lastImage } : text;
    }
  }

  // Final polish: if last step was not screenshot, take one
  if (!lastImage && steps[steps.length - 1]?.op !== 'screenshot') {
    try { lastImage = await pc.captureScreenshot({ portalTimeoutMs: config?.portalTimeoutMs }); } catch {}
  }

  let finalText = `🤖 Autopilot done (${steps.length} steps)\n\n${outLines.join('\n')}`;
  // Try to add OCR summary if we have time
  try {
    const look = await ocr.lookAtScreen(config, 'summarize what is on the screen in one short paragraph', log).catch(() => null);
    const summary = typeof look === 'string' ? look : look?.text;
    if (summary && summary.length > 20) finalText += `\n\n📝 Screen says:\n${String(summary).slice(0, 1200)}`;
  } catch {}

  return lastImage ? { text: finalText, image: lastImage } : finalText;
}

function describeStep(st) {
  if (st.op === 'open') return `open "${st.target}"`;
  if (st.op === 'tap') return `tap "${st.label}"`;
  if (st.op === 'click') return `click ${st.x} ${st.y}`;
  if (st.op === 'type') return `type "${String(st.text).slice(0, 40)}${String(st.text).length > 40 ? '…' : ''}"`;
  if (st.op === 'key') return `key ${st.combo}`;
  if (st.op === 'wait') return `wait ${st.ms}ms`;
  if (st.op === 'screenshot') return `screenshot`;
  if (st.op === 'look') return `look "${st.question ?? ''}"`;
  return JSON.stringify(st);
}
