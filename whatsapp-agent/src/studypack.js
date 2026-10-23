// studypack.js — 📚 Study Pack: topic → summary + flashcards + quiz, with
// spaced-repetition revision. `/study <topic>` builds a pack (AI-generated,
// injected in tests), `/revise [topic]` shows cards due today, `/quiz
// <topic>` runs the quiz. Packs live in data/study/ — yours forever.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STUDY_DIR = path.join(ROOT, 'data', 'study');
// spaced repetition ladder (days) — reviewCount indexes into it
export const INTERVALS_DAYS = [1, 3, 7, 14, 30];

function slug(topic) {
  return String(topic ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'pack';
}

export function savePack(pack, dir = STUDY_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug(pack.topic)}.json`);
  fs.writeFileSync(file, JSON.stringify(pack, null, 2));
  return file;
}

export function loadPack(topic, dir = STUDY_DIR) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${slug(topic)}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export function listPacks(dir = STUDY_DIR) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
      .map((p) => p.topic);
  } catch {
    return [];
  }
}

/**
 * Validate + shape an AI-generated pack. Accepts {summary, flashcards, quiz}
 * and attaches revision tracking.
 */
export function buildPack(topic, generated, now = Date.now()) {
  const cards = (generated?.flashcards ?? [])
    .filter((c) => c && (c.q ?? c.question) && (c.a ?? c.answer))
    .map((c) => ({
      q: String(c.q ?? c.question),
      a: String(c.a ?? c.answer),
      reviewCount: 0,
      nextDue: now,
    }));
  const quiz = (generated?.quiz ?? [])
    .filter((q) => q && q.q && Array.isArray(q.options) && q.answer != null)
    .map((q) => ({ q: String(q.q), options: q.options.map(String), answer: String(q.answer) }));
  return {
    topic: String(topic),
    summary: String(generated?.summary ?? '').slice(0, 2000),
    flashcards: cards,
    quiz,
    createdAt: now,
  };
}

/** Which cards are due for revision right now? */
export function dueCards(pack, now = Date.now()) {
  return (pack?.flashcards ?? []).filter((c) => (c.nextDue ?? 0) <= now);
}

/** After a review, schedule the card on the ladder (again = restart). */
export function reviewCard(card, remembered, now = Date.now()) {
  const step = remembered ? Math.min((card.reviewCount ?? 0) + 1, INTERVALS_DAYS.length - 1) : 0;
  card.reviewCount = remembered ? step : 0;
  card.nextDue = now + INTERVALS_DAYS[step] * 24 * 60 * 60 * 1000;
  return card;
}

/** Friendly revise message for due cards. */
export function reviseMessage(pack, now = Date.now()) {
  const due = dueCards(pack, now);
  if (!pack) return '📚 Koi study pack nahi mila. Banao: `/study <topic>`';
  if (!due.length) return `📚 *${pack.topic}* — aaj ke liye sab revise ho gaya! ✅ Next batch kal+.`;
  const lines = due.slice(0, 8).map((c, i) => `${i + 1}. *Q:* ${c.q}\n   *A:* ||${c.a}||`);
  return `📚 *Revision — ${pack.topic}* (${due.length} cards due)\n${lines.join('\n')}\n\nYaad aaya? \`/revise ok\` · Nahi? \`/revise again\``;
}

export function quizMessage(pack) {
  if (!pack?.quiz?.length) return '📚 Is pack me quiz nahi hai — `/study <topic>` se nara.';
  const lines = pack.quiz.slice(0, 8).map((q, i) => {
    const opts = q.options.map((o, j) => `  ${String.fromCharCode(65 + j)}. ${o}`).join('\n');
    return `${i + 1}. ${q.q}\n${opts}`;
  });
  return `📝 *Quiz — ${pack.topic}*\n${lines.join('\n')}\n\nAnswers: \`/quiz answers ${pack.topic}\``;
}

export function quizAnswers(pack) {
  if (!pack?.quiz?.length) return '📚 Quiz nahi hai is pack me.';
  return `📝 *Answers — ${pack.topic}*\n${pack.quiz.map((q, i) => `${i + 1}. ${q.answer}`).join('\n')}`;
}
