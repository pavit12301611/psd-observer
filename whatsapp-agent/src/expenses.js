// expenses.js — 💰 Expense Tracker: "250 khana" type messages become a
// ledger. Monthly reports, budget alerts, undo. Bills can also arrive as
// photos later (OCR layer) — the ledger stays the same.
// `/exp <amount> <note>` · `/exp report [month]` · `/exp budget <amt>` ·
// `/exp undo` · `/exp list`

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_FILE = path.join(ROOT, 'data', 'expenses.json');

export function loadExpenses(file = DEFAULT_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { entries: [], budget: null };
  }
}

function saveExpenses(data, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch { /* best effort */ }
}

/**
 * Parse "250 khana", "₹120 auto", "rs 99.5 recharge" → { amount, note }.
 * Returns null when there is no leading amount.
 */
export function parseExpense(text) {
  const s = String(text ?? '').trim();
  const m = s.match(/^(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d{1,2})?)\s*(.*)$/i);
  if (!m) return null;
  const amount = Number(m[1]);
  if (!(amount > 0) || amount > 1_000_000) return null;
  return { amount, note: (m[2] ?? '').trim() || 'kharcha' };
}

export function addExpense(text, opts = {}) {
  const { file = DEFAULT_FILE, now = Date.now } = opts;
  const parsed = parseExpense(text);
  if (!parsed) return { ok: false, error: 'Format: `/exp <amount> <note>` — e.g. `/exp 250 khana`' };
  const data = loadExpenses(file);
  const entry = { ...parsed, at: now(), id: `${now()}-${Math.floor(Math.random() * 1000)}` };
  data.entries.push(entry);
  saveExpenses(data, file);
  const monthKey = monthOf(entry.at);
  const spent = monthTotal(data, monthKey);
  let alert = '';
  if (data.budget && spent > data.budget) {
    alert = `\n⚠️ *Budget ${data.budget} cross!* Is mahine ₹${spent.toFixed(0)} ho gaye.`;
  } else if (data.budget && spent > data.budget * 0.85) {
    alert = `\n⚠️ Budget ka 85%+ kharch — ₹${spent.toFixed(0)}/${data.budget}.`;
  }
  return { ok: true, entry, spent, reply: `💰 Saved: *₹${entry.amount}* — ${entry.note}\nIs mahine total: *₹${spent.toFixed(0)}*${alert}` };
}

export function monthOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function monthTotal(data, monthKey) {
  return (data.entries ?? [])
    .filter((e) => monthOf(e.at) === monthKey)
    .reduce((sum, e) => sum + e.amount, 0);
}

export function setBudget(amount, opts = {}) {
  const { file = DEFAULT_FILE } = opts;
  const data = loadExpenses(file);
  data.budget = Number(amount) || null;
  saveExpenses(data, file);
  return data.budget
    ? `💰 Monthly budget set: *₹${data.budget}*`
    : '💰 Budget hata diya.';
}

export function undoLast(opts = {}) {
  const { file = DEFAULT_FILE } = opts;
  const data = loadExpenses(file);
  const last = data.entries.pop();
  if (!last) return '💰 Ledger khaali hai — undo karne ko kuch nahi.';
  saveExpenses(data, file);
  return `↩️ Undo: *₹${last.amount}* (${last.note}) hata diya.`;
}

export function report(opts = {}) {
  const { file = DEFAULT_FILE, month = null, now = Date.now } = opts;
  const data = loadExpenses(file);
  const key = month ?? monthOf(now());
  const entries = (data.entries ?? []).filter((e) => monthOf(e.at) === key);
  if (!entries.length) return `💰 *${key}* me koi kharcha nahi. 🎉`;
  const total = entries.reduce((s, e) => s + e.amount, 0);
  const byNote = {};
  for (const e of entries) byNote[e.note] = (byNote[e.note] ?? 0) + e.amount;
  const top = Object.entries(byNote).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([note, amt]) => `  • ${note}: ₹${amt.toFixed(0)}`)
    .join('\n');
  const budgetLine = data.budget ? `\nBudget: ₹${data.budget} — ${total > data.budget ? '*OVER* ⚠️' : `bachat ₹${(data.budget - total).toFixed(0)}`}` : '';
  return `💰 *Expense report — ${key}*\nTotal: *₹${total.toFixed(0)}* (${entries.length} entries)\nTop kharche:\n${top}${budgetLine}`;
}

export function lastEntries(n = 5, opts = {}) {
  const { file = DEFAULT_FILE } = opts;
  const data = loadExpenses(file);
  const entries = (data.entries ?? []).slice(-n).reverse();
  if (!entries.length) return '💰 Ledger khaali hai.';
  return `💰 *Last ${entries.length} entries*\n${entries.map((e) => `  • ₹${e.amount} — ${e.note}`).join('\n')}`;
}
