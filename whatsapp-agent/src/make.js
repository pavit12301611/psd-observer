// make.js — 🛠️ /make deliverables: report (md), slides (self-contained
// HTML), dashboard (HTML), csv — files jo review/edit kar sakte ho (Duet ke
// "Make tab" jaisa). Content brain se aata hai; templates pure hain.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MAKE_DIR = path.join(ROOT, 'data', 'makes');

function save(kind, ext, body, topic, dir = MAKE_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const name = `${kind}-${String(topic).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30) || 'item'}-${Date.now().toString(36)}.${ext}`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

/** Markdown report from sections [{heading, body}]. */
export function buildReport(topic, sections, meta = {}) {
  const lines = [
    `# ${topic}`,
    '',
    `_Generated ${new Date(meta.now ?? Date.now()).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} · PSD_Ai /make_`,
    '',
  ];
  for (const s of sections ?? []) {
    lines.push(`## ${s.heading}`, '', s.body ?? '', '');
  }
  return lines.join('\n');
}

/** Self-contained HTML slide deck (arrow keys / click to advance). */
export function buildSlides(topic, slides) {
  const cards = (slides ?? []).map((s, i) => `
  <section class="slide${i === 0 ? ' active' : ''}">
    <h2>${esc(s.title)}</h2>
    <ul>${(s.bullets ?? []).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
    <footer>${i + 1}/${slides.length}</footer>
  </section>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(topic)}</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#0f1220;color:#e8eaf6}
.slide{display:none;height:100vh;padding:8vh 10vw;box-sizing:border-box}
.slide.active{display:flex;flex-direction:column;justify-content:center}
h1{font-size:2.2em;margin:0 0 .4em}h2{font-size:1.8em;margin:0 0 .6em;color:#8cf}
li{font-size:1.25em;margin:.45em 0}footer{position:fixed;bottom:2vh;right:3vw;opacity:.5}
</style></head><body>
<section class="slide active"><h1>${esc(topic)}</h1><p>PSD_Ai deck · ← → keys / click</p></section>${cards}
<script>
let i=0;const s=[...document.querySelectorAll('.slide')];
const go=(d)=>{s[i].classList.remove('active');i=(i+d+s.length)%s.length;s[i].classList.add('active')};
addEventListener('keydown',e=>{if(['ArrowRight',' ','PageDown'].includes(e.key))go(1);if(['ArrowLeft','PageUp'].includes(e.key))go(-1)});
addEventListener('click',()=>go(1));
</script></body></html>`;
}

/** Single-file HTML dashboard from [{label, value, hint?}] metrics. */
export function buildDashboard(topic, metrics) {
  const cards = (metrics ?? []).map((m) => `
  <div class="card"><div class="label">${esc(m.label)}</div><div class="value">${esc(String(m.value))}</div>
  ${m.hint ? `<div class="hint">${esc(m.hint)}</div>` : ''}</div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(topic)}</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#0b0e1a;color:#e8eaf6;padding:4vh 4vw}
h1{margin:0 0 3vh} .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}
.card{background:#161b33;border-radius:14px;padding:18px}
.label{opacity:.65;font-size:.85em}.value{font-size:2em;font-weight:700;margin:.15em 0;color:#8cf}
.hint{opacity:.55;font-size:.85em}
</style></head><body><h1>${esc(topic)}</h1><div class="grid">${cards}</div></body></html>`;
}

/** CSV from rows (first row = header). */
export function buildCSV(rows) {
  return (rows ?? [])
    .map((r) => r.map((c) => {
      const s = String(c ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','))
    .join('\n');
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Orchestrate: brain drafts content, template renders, file saved.
 * `draft(kind, topic)` is injected (brain) returning JSON-shaped content.
 */
export async function makeDeliverable(kind, topic, opts = {}) {
  const { draft, dir = MAKE_DIR } = opts;
  const k = String(kind ?? '').toLowerCase();
  if (!['report', 'slides', 'dashboard', 'csv'].includes(k)) {
    return '🛠️ Usage: `/make report|slides|dashboard|csv <topic>`';
  }
  let content;
  if (typeof draft === 'function') {
    try { content = await draft(k, topic); } catch { content = null; }
  }
  if (k === 'report') {
    const sections = content?.sections ?? [
      { heading: 'Overview', body: `${topic} ka overview (brain offline — manually edit kar sakte ho).` },
      { heading: 'Key Points', body: '- point 1\n- point 2' },
    ];
    return `📄 *Report ready:* ${save('report', 'md', buildReport(topic, sections), topic, dir)}`;
  }
  if (k === 'slides') {
    const slides = content?.slides ?? [
      { title: 'Agenda', bullets: [topic, 'Key points', 'Next steps'] },
      { title: 'Key Points', bullets: content?.bullets ?? ['point 1', 'point 2'] },
    ];
    return `🎞️ *Slides ready:* ${save('slides', 'html', buildSlides(topic, slides), topic, dir)}`;
  }
  if (k === 'dashboard') {
    const metrics = content?.metrics ?? [
      { label: 'Topic', value: topic },
      { label: 'Status', value: 'draft' },
    ];
    return `📊 *Dashboard ready:* ${save('dashboard', 'html', buildDashboard(topic, metrics), topic, dir)}`;
  }
  const rows = content?.rows ?? [['item', 'value'], ['example', 1]];
  return `📎 *CSV ready:* ${save('csv', 'csv', buildCSV(rows), topic, dir)}`;
}
