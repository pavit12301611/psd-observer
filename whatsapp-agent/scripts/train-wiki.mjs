#!/usr/bin/env node
// train-wiki.mjs — "Wikipedia se train karo" ka command-line engine.
//
// Fetches Wikipedia summaries for a topic list and bakes them into
// data/wiki-knowledge.json, which the agent loads automatically at startup
// (src/index.js) and answers from — instantly and offline. Every topic is
// also reusable via /wiki in chat.
//
// Usage:
//   node scripts/train-wiki.mjs --common                # 60+ essential topics
//   node scripts/train-wiki.mjs "Narendra Modi" "Photosynthesis" "Mars"
//   node scripts/train-wiki.mjs --file topics.txt       # one topic per line
//   node scripts/train-wiki.mjs --common --out data/wiki-knowledge.json
//   node scripts/train-wiki.mjs --base http://127.0.0.1:9 # tests / mirrors
//
// The agent itself learns the same way at runtime: every /wiki lookup and
// every factual chat that gets grounded is remembered in store.data.wikiKnowledge.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wikiSummary } from '../src/wiki.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.join(ROOT, 'data', 'wiki-knowledge.json');

// The starter curriculum — evergreen, high-value topics for a personal agent.
const COMMON_TOPICS = [
  // India
  'India', 'New Delhi', 'History of India', 'Indian independence movement',
  'Constitution of India', 'Mahatma Gandhi', 'Jawaharlal Nehru', 'B. R. Ambedkar',
  'Sardar Vallabhbhai Patel', 'Bhagat Singh', 'Ashoka', 'Mughal Empire',
  'Taj Mahal', 'Ganges', 'Himalayas', 'Indian Space Research Organisation',
  'Chandrayaan-3', 'Mangalyaan', 'Aditya-L1', 'Economy of India', 'Cricket in India',
  // World
  'Earth', 'Sun', 'Moon', 'Solar System', 'Mount Everest', 'Nile', 'Amazon River',
  'Pacific Ocean', 'Sahara', 'United Nations', 'World War I', 'World War II',
  'French Revolution', 'Industrial Revolution', 'Roman Empire', 'Pyramids of Giza',
  // Science
  'Photosynthesis', 'DNA', 'Atom', 'Newton\u2019s laws of motion', 'Periodic table',
  'Speed of light', 'Gravity', 'Absolute zero', 'Black hole', 'Big Bang',
  'Photosynthesis', 'Vitamin C', 'Blood type', 'pH scale', 'Light-year',
  // Tech
  'World Wide Web', 'Internet', 'Python (programming language)', 'JavaScript',
  'Linux', 'Artificial intelligence', 'ChatGPT', 'Bitcoin', 'Blockchain',
  'HTML', 'Central processing unit', 'Open-source software',
  // Sports & misc
  'Olympic Games', 'FIFA World Cup', 'Sachin Tendulkar', 'Mahendra Singh Dhoni',
  'Neeraj Chopra', 'Abhinav Bindra', 'Pythagorean theorem', 'Prime number',
  'Pi', 'E (mathematical constant)',
];

function parseArgs(argv) {
  const out = { topics: [], file: null, outPath: DEFAULT_OUT, base: null, common: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--common') out.common = true;
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--out') out.outPath = path.resolve(argv[++i]);
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else out.topics.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/train-wiki.mjs [--common] [--file topics.txt] [--out data/wiki-knowledge.json] [--base URL] [topic ...]');
    process.exit(0);
  }

  const topics = [...args.topics];
  if (args.common) topics.push(...COMMON_TOPICS);
  if (args.file) {
    const lines = fs.readFileSync(args.file, 'utf8').split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (t && !t.startsWith('#')) topics.push(t);
    }
  }
  const unique = [...new Set(topics.map((t) => t.trim()).filter(Boolean))];
  if (!unique.length) {
    console.error('No topics. Use --common, --file <txt>, or pass topics as arguments.');
    process.exit(1);
  }

  const config = args.base ? { wikiBaseUrl: args.base } : {};
  console.log(`Training from Wikipedia: ${unique.length} topics → ${args.outPath}\n`);

  const entries = [];
  const failed = [];
  for (const topic of unique) {
    process.stdout.write(`  • ${topic} … `);
    try {
      const rec = await wikiSummary(topic, config);
      if (!rec?.extract) throw new Error('empty extract');
      entries.push({ query: rec.query, title: rec.title, extract: rec.extract, url: rec.url, ts: Date.now() });
      console.log(`ok (${rec.title})`);
    } catch (err) {
      failed.push({ topic, error: String(err?.message || err) });
      console.log(`FAILED — ${String(err?.message || err).slice(0, 60)}`);
    }
  }

  // Merge with an existing knowledge file so re-runs only add/refresh.
  let merged = entries;
  try {
    const prev = JSON.parse(fs.readFileSync(args.outPath, 'utf8'));
    const prevList = Array.isArray(prev) ? prev : prev?.entries ?? [];
    const keep = prevList.filter((e) => !entries.some((n) => n.title === e.title));
    merged = [...keep, ...entries];
  } catch { /* first run */ }

  fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
  fs.writeFileSync(args.outPath, JSON.stringify({ trainedAt: new Date().toISOString(), entries: merged }, null, 2));

  console.log(`\n✅ Trained: ${entries.length} new/updated · ${failed.length} failed · total stored: ${merged.length}`);
  console.log(`   File: ${args.outPath}`);
  console.log('   The agent loads this automatically at startup (and via /wiki).');
  if (failed.length) {
    console.log('\n   Failed topics:');
    for (const f of failed) console.log(`   - ${f.topic}: ${f.error}`);
    process.exitCode = 0; // partial success is still success — network hiccups shouldn't fail the build
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
