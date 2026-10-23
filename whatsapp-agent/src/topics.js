// topics.js — 🗂️ Topic channels: alag-alag topics ka apna memory namespace
// (Duet ke "channels with shared memory" jaisa). `/topic <name>` switch —
// uske baad ki baat-uske topic me record hoti hai; brain ko topic preamble
// milta hai. Global knowledge sab channels me shared.

const topics = new Map(); // name -> { messages: [], pins: [], at }
let current = 'general';

export function normalizeTopic(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 24) || 'general';
}

export function switchTopic(name) {
  const t = normalizeTopic(name);
  if (!topics.has(t)) topics.set(t, { messages: [], pins: [], at: Date.now() });
  current = t;
  const info = topics.get(t);
  return `🗂️ *Channel: #${t}*${info.messages.length ? ` (${info.messages.length} msgs yahan pehle se)` : ' — naya channel'}\nPin: \`/pin <text>\` · List: \`/topic list\``;
}

export function currentTopic() {
  return current;
}

export function recordMessage(role, text) {
  const t = topics.get(current) ?? { messages: [], pins: [], at: Date.now() };
  topics.set(current, t);
  t.messages.push({ role, text: String(text ?? '').slice(0, 400), at: Date.now() });
  if (t.messages.length > 30) t.messages.shift();
}

export function pinToTopic(text) {
  const t = topics.get(current);
  if (!t) return '🗂️ Pehle channel switch karo: `/topic <name>`';
  t.pins.push(String(text).slice(0, 300));
  return `📌 #${current} me pin: *${String(text).slice(0, 80)}*`;
}

/** Recent context for the brain prompt (only non-default topics). */
export function topicContext() {
  if (current === 'general') return '';
  const t = topics.get(current);
  if (!t) return '';
  const pins = t.pins.map((p) => `📌 ${p}`).join('\n');
  const recent = t.messages.slice(-6).map((m) => `${m.role}: ${m.text}`).join('\n');
  return `[#channel:${current}${pins ? ` | pins: ${t.pins.join('; ')}` : ''}]\n${recent}`;
}

export function listTopics() {
  const rows = [...topics.entries()].map(([name, t]) =>
    `  ${name === current ? '➡️' : '•'} #${name} — ${t.messages.length} msgs, ${t.pins.length} pins`);
  return rows.length
    ? `🗂️ *Channels*\n${rows.join('\n')}`
    : '🗂️ Sirf #general active hai. Naya: `/topic work`';
}

export function deleteTopic(name) {
  const t = normalizeTopic(name);
  if (t === 'general') return '🗂️ #general delete nahi hoga.';
  topics.delete(t);
  if (current === t) current = 'general';
  return `🗂️ #${t} hata diya.`;
}
