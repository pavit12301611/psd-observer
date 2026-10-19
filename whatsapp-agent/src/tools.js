// tools.js — everything here is FREE: offline math/units, or public APIs that
// need no key and no account (Open-Meteo, Wikipedia, dictionaryapi.dev,
// Frankfurter/ECB rates, Google News RSS, is.gd). Each network tool has a
// short timeout and fails with a friendly message, never a stack trace.
import os from 'node:os';
import crypto from 'node:crypto';

const FETCH_TIMEOUT_MS = 10_000;

const friendlyNetworkError = (err) =>
  err?.name === 'TimeoutError' || err?.name === 'AbortError'
    ? new Error('that free lookup timed out — try again in a bit')
    : new Error('network problem reaching that free lookup service — check this PC\'s internet and try again');

async function fetchJson(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, { ...opts, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) { throw friendlyNetworkError(err); }
  if (!res.ok) throw new Error(`lookup service said ${res.status} — try again in a bit`);
  return res.json();
}

async function fetchText(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...opts,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'user-agent': 'ObserverWhatsAppAgent/1.0 (+personal assistant)', ...(opts.headers ?? {}) },
    });
  } catch (err) { throw friendlyNetworkError(err); }
  if (!res.ok) throw new Error(`that site said ${res.status} — check the link and try again`);
  return res.text();
}

// ── Time parsing ("in 10m", "at 18:30", "tomorrow 9am", "in 2 hours") ─────────

const UNIT_MS = {
  s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
};

/**
 * Parse the "when" part of a reminder. Returns { dueTs, rest } where `rest` is
 * the remaining text, or null if no time was understood.
 *   "in 10m call mom" | "in 1 hour 30 minutes stretch" | "at 18:30 gym"
 *   "tomorrow 9am standup" | "today 7:30pm dinner" | "10m chai"
 */
export function parseWhen(input, now = new Date()) {
  const text = String(input ?? '').trim();
  let m;

  // Relative: [in] N unit [N unit ...]
  m = text.match(/^(?:in\s+)?((?:\d+(?:\.\d+)?\s*(?:seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\s*)+)(?:to\s+|that\s+)?([\s\S]*)$/i);
  if (m) {
    let total = 0;
    for (const part of m[1].matchAll(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)/gi)) {
      total += Number(part[1]) * (UNIT_MS[part[2].toLowerCase()] ?? 0);
    }
    if (total > 0) return { dueTs: now.getTime() + total, rest: m[2].trim() };
  }

  const clock = (base, hh, mm, ampm) => {
    let hour = Number(hh);
    const minute = Number(mm ?? 0);
    if (ampm) {
      const ap = ampm.toLowerCase();
      if (ap === 'pm' && hour < 12) hour += 12;
      if (ap === 'am' && hour === 12) hour = 0;
    }
    const due = new Date(base);
    due.setHours(hour, minute, 0, 0);
    return due;
  };

  // today/tomorrow at H[:MM] am/pm
  m = text.match(/^(today|tomorrow)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(?:to\s+)?([\s\S]+)$/i);
  if (m) {
    const base = new Date(now);
    if (/tomorrow/i.test(m[1])) base.setDate(base.getDate() + 1);
    const due = clock(base, m[2], m[3], m[4]);
    if (/today/i.test(m[1]) && due.getTime() <= now.getTime()) due.setDate(due.getDate() + 1);
    return { dueTs: due.getTime(), rest: m[5].trim() };
  }

  // at H[:MM] am/pm  (today, or tomorrow if already past)
  m = text.match(/^at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(?:to\s+)?([\s\S]+)$/i);
  if (m) {
    const due = clock(now, m[1], m[2], m[3]);
    if (due.getTime() <= now.getTime()) due.setDate(due.getDate() + 1);
    return { dueTs: due.getTime(), rest: m[4].trim() };
  }

  // Trailing relative: "buy milk in 10 minutes" / "to call mom in 2 hours"
  m = text.match(/^([\s\S]+?)\s+in\s+((?:\d+(?:\.\d+)?\s*(?:seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\s*)+)$/i);
  if (m) {
    let total = 0;
    for (const part of m[2].matchAll(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/gi)) {
      total += Number(part[1]) * (UNIT_MS[part[2].toLowerCase()] ?? 0);
    }
    const rest = m[1].trim().replace(/^to\s+/i, '');
    if (total > 0 && rest) return { dueTs: now.getTime() + total, rest };
  }
  return null;
}

export function formatDateTime(ts, timezone = 'Asia/Kolkata') {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(ts));
}

export function humanDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ── Safe calculator (tokeniser + shunting-yard; eval is never involved) ──────

const CALC_FUNCS = { sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, log: Math.log10, ln: Math.log, sin: Math.sin, cos: Math.cos, tan: Math.tan };
const CALC_CONSTS = { pi: Math.PI, e: Math.E };

export function calc(expression) {
  const src = String(expression ?? '')
    .replace(/,/g, '')
    .replace(/(\d+(?:\.\d+)?)\s*%/g, '($1/100)')
    .replace(/\^/g, '**')
    .trim();
  if (!src) throw new Error('nothing to calculate');
  if (!/^[\d\s.+\-*/()a-z*]+$/i.test(src)) throw new Error('only numbers, + - * / ^ % ( ) and sqrt/abs/round/pi… are allowed');

  const tokens = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([a-z]+)|(\*\*|[-+*/()]))/iy;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) throw new Error(`could not read "${src.slice(pos, pos + 12)}"`);
    pos = re.lastIndex;
    if (m[1] != null) tokens.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] != null) {
      const name = m[2].toLowerCase();
      if (name in CALC_CONSTS) tokens.push({ t: 'num', v: CALC_CONSTS[name] });
      else if (name in CALC_FUNCS) tokens.push({ t: 'func', v: name });
      else throw new Error(`unknown name "${name}"`);
    } else tokens.push({ t: m[3] === '(' || m[3] === ')' ? m[3] : 'op', v: m[3] });
    if (tokens.length > 200) throw new Error('expression too long');
  }

  // Shunting-yard → RPN. Unary minus becomes 0 - x.
  const prec = { '+': 1, '-': 1, '*': 2, '/': 2, '**': 3 };
  const out = [];
  const ops = [];
  let prev = null;
  for (const tok of tokens) {
    if (tok.t === 'num') out.push(tok);
    else if (tok.t === 'func') ops.push(tok);
    else if (tok.t === '(') ops.push(tok);
    else if (tok.t === ')') {
      while (ops.length && ops.at(-1).t !== '(') out.push(ops.pop());
      if (!ops.length) throw new Error('unbalanced brackets');
      ops.pop();
      if (ops.at(-1)?.t === 'func') out.push(ops.pop());
    } else {
      let { v } = tok;
      if (v === '-' && (prev === null || prev.t === 'op' || prev.t === '(')) out.push({ t: 'num', v: 0 });
      while (ops.length && ops.at(-1).t === 'op' &&
        (prec[ops.at(-1).v] > prec[v] || (prec[ops.at(-1).v] === prec[v] && v !== '**'))) out.push(ops.pop());
      ops.push({ t: 'op', v });
    }
    prev = tok;
  }
  while (ops.length) {
    const op = ops.pop();
    if (op.t === '(') throw new Error('unbalanced brackets');
    out.push(op);
  }

  const stack = [];
  for (const tok of out) {
    if (tok.t === 'num') stack.push(tok.v);
    else if (tok.t === 'func') {
      if (!stack.length) throw new Error('bad expression');
      stack.push(CALC_FUNCS[tok.v](stack.pop()));
    } else {
      const b = stack.pop();
      const a = stack.pop();
      if (a == null || b == null) throw new Error('bad expression');
      const v = tok.v === '+' ? a + b : tok.v === '-' ? a - b : tok.v === '*' ? a * b : tok.v === '/' ? a / b : a ** b;
      stack.push(v);
    }
  }
  if (stack.length !== 1 || !Number.isFinite(stack[0])) throw new Error('could not calculate that');
  const value = stack[0];
  return Math.abs(value - Math.round(value)) < 1e-10 ? Math.round(value) : Number(value.toPrecision(12));
}

/** True if a plain message is just a maths expression: "45*12+3", "sqrt(81)+pi". */
export function looksLikeCalc(text) {
  const t = String(text ?? '').trim();
  const withoutNames = t.replace(/sqrt|abs|round|floor|ceil|log|ln|sin|cos|tan|pi|e/gi, '');
  return /^[\d\s.+\-*/%^()]+$/.test(withoutNames) && /\d/.test(t) && /[+\-*/%^]|sqrt|pi/i.test(t);
}

// ── Units (offline) ───────────────────────────────────────────────────────────

const UNITS = {
  km: ['length', 1000], m: ['length', 1], cm: ['length', 0.01], mm: ['length', 0.001],
  mi: ['length', 1609.344], mile: ['length', 1609.344], miles: ['length', 1609.344],
  ft: ['length', 0.3048], feet: ['length', 0.3048], in: ['length', 0.0254], inch: ['length', 0.0254], inches: ['length', 0.0254],
  kg: ['mass', 1], g: ['mass', 0.001], gram: ['mass', 0.001], grams: ['mass', 0.001],
  lb: ['mass', 0.45359237], lbs: ['mass', 0.45359237], pound: ['mass', 0.45359237], pounds: ['mass', 0.45359237],
  l: ['volume', 1], litre: ['volume', 1], liter: ['volume', 1], ml: ['volume', 0.001],
  gal: ['volume', 3.78541], gallon: ['volume', 3.78541], gallons: ['volume', 3.78541],
  kb: ['data', 1e3], mb: ['data', 1e6], gb: ['data', 1e9], tb: ['data', 1e12],
  kmh: ['speed', 1], mph: ['speed', 1.609344],
};

export function convertUnit(value, fromRaw, toRaw) {
  const from = String(fromRaw).toLowerCase().replace(/[^a-z]/g, '');
  const to = String(toRaw).toLowerCase().replace(/[^a-z]/g, '');
  if (from === 'c' || from === 'celsius' || to === 'c' || to === 'celsius' || from === 'f' || from === 'fahrenheit' || to === 'f' || to === 'fahrenheit') {
    const isFromC = ['c', 'celsius'].includes(from);
    const result = isFromC ? (value * 9) / 5 + 32 : ((value - 32) * 5) / 9;
    return `${value}°${isFromC ? 'C' : 'F'} = *${round(result)}°${isFromC ? 'F' : 'C'}*`;
  }
  const a = UNITS[from];
  const b = UNITS[to];
  if (!a || !b) throw new Error(`I don't know "${!a ? fromRaw : toRaw}". Try km/mi, kg/lb, l/gal, gb/mb, c/f…`);
  if (a[0] !== b[0]) throw new Error(`Can't convert ${a[0]} to ${b[0]}.`);
  return `${value} ${from} = *${round((value * a[1]) / b[1])} ${to}*`;
}

const round = (n) => (Math.abs(n) >= 1000 ? n.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : String(Number(n.toPrecision(6))));

// ── Free network tools ────────────────────────────────────────────────────────

const WMO = { 0: 'Clear sky ☀️', 1: 'Mostly clear 🌤️', 2: 'Partly cloudy ⛅', 3: 'Overcast ☁️', 45: 'Fog 🌫️', 48: 'Fog 🌫️', 51: 'Light drizzle 🌦️', 53: 'Drizzle 🌦️', 55: 'Drizzle 🌦️', 61: 'Light rain 🌧️', 63: 'Rain 🌧️', 65: 'Heavy rain 🌧️', 71: 'Snow ❄️', 73: 'Snow ❄️', 75: 'Heavy snow ❄️', 80: 'Rain showers 🌦️', 81: 'Rain showers 🌦️', 82: 'Violent showers ⛈️', 95: 'Thunderstorm ⛈️', 96: 'Thunderstorm + hail ⛈️', 99: 'Thunderstorm + hail ⛈️' };

export async function weather(city) {
  const geo = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en`);
  const place = geo.results?.[0];
  if (!place) throw new Error(`couldn't find a place called "${city}"`);
  const wx = await fetchJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=3&timezone=auto`,
  );
  const c = wx.current;
  const days = wx.daily.time.map((d, i) =>
    `• ${new Date(`${d}T12:00:00`).toLocaleDateString('en-IN', { weekday: 'short' })}: ${Math.round(wx.daily.temperature_2m_min[i])}–${Math.round(wx.daily.temperature_2m_max[i])}°C, rain ${wx.daily.precipitation_probability_max[i] ?? 0}%`,
  ).join('\n');
  return `🌍 *${place.name}${place.admin1 ? `, ${place.admin1}` : ''}* (${place.country})\n` +
    `${WMO[c.weather_code] ?? '—'}\n🌡️ ${Math.round(c.temperature_2m)}°C (feels ${Math.round(c.apparent_temperature)}°C) · 💧 ${c.relative_humidity_2m}% · 🌬️ ${Math.round(c.wind_speed_10m)} km/h\n\n${days}\n\n_Source: Open-Meteo (free, no key)_`;
}

export async function wiki(query) {
  const search = await fetchJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=1&format=json`);
  const title = search.query?.search?.[0]?.title;
  if (!title) throw new Error(`nothing on Wikipedia for "${query}"`);
  const page = await fetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
  const extract = String(page.extract ?? '').slice(0, 1200);
  return `📚 *${page.title}*\n\n${extract}${page.content_urls?.desktop?.page ? `\n\n${page.content_urls.desktop.page}` : ''}`;
}

export async function define(word) {
  const entries = await fetchJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.trim().toLowerCase())}`);
  const entry = Array.isArray(entries) ? entries[0] : null;
  if (!entry) throw new Error(`no dictionary entry for "${word}"`);
  const lines = [`🔤 *${entry.word}*${entry.phonetic ? ` ${entry.phonetic}` : ''}`];
  for (const meaning of (entry.meanings ?? []).slice(0, 3)) {
    lines.push(`\n_${meaning.partOfSpeech}_`);
    for (const def of (meaning.definitions ?? []).slice(0, 2)) {
      lines.push(`• ${def.definition}${def.example ? `\n  e.g. “${def.example}”` : ''}`);
    }
  }
  return lines.join('\n');
}

export async function currency(amount, fromRaw, toRaw) {
  const from = fromRaw.toUpperCase();
  const to = toRaw.toUpperCase();
  const res = await fetchJson(`https://api.frankfurter.dev/v1/latest?amount=${amount}&base=${from}&symbols=${to}`);
  const converted = res.rates?.[to];
  if (converted == null) throw new Error(`couldn't convert ${from} → ${to}`);
  return `💱 *${amount.toLocaleString('en-IN')} ${from} = ${Number(converted).toLocaleString('en-IN', { maximumFractionDigits: 2 })} ${to}*\n_(ECB reference rate, ${res.date}; banks/UPI will differ a little)_`;
}

export async function news(topic = '') {
  const feed = topic
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-IN&gl=IN&ceid=IN:en`
    : 'https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en';
  const xml = await fetchText(feed);
  const items = [...xml.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>/g)]
    .slice(0, 7)
    .map((m, i) => `${i + 1}. ${decodeEntities(m[1].trim())}\n${m[2].trim()}`);
  if (!items.length) throw new Error('no headlines came back just now');
  return `🗞️ *Top news${topic ? `: ${topic}` : ' (India)'}*\n\n${items.join('\n\n')}`;
}

export async function shorten(url) {
  const clean = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const short = await fetchText(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(clean)}`);
  if (!/^https?:\/\//.test(short)) throw new Error('shortener refused that URL');
  return `🔗 ${short.trim()}`;
}

/** Fetch a page and pull out readable text (deliberately simple, no dependency). */
export async function fetchPageText(url, maxChars = 12_000) {
  const html = await fetchText(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? url);
  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(p|div|li|h\d|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n\n')
      .trim(),
  ).slice(0, maxChars);
  return { title, text };
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
}

// ── Small utilities ───────────────────────────────────────────────────────────

export function generatePassword(length = 16) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$%^&*';
  const len = Math.min(Math.max(length, 8), 64);
  let out = '';
  for (const byte of crypto.randomBytes(len * 2)) {
    if (out.length >= len) break;
    if (byte < 252) out += chars[byte % chars.length];
  }
  return out;
}

export function systemInfo(startedAt) {
  const total = os.totalmem();
  const free = os.freemem();
  const gb = (n) => `${(n / 1024 ** 3).toFixed(1)} GB`;
  const nets = Object.values(os.networkInterfaces()).flat().filter((n) => n && !n.internal && n.family === 'IPv4').map((n) => n.address);
  return [
    `🖥️ *${os.hostname()}* — ${os.type()} ${os.release()} (${os.arch()})`,
    `CPU: ${os.cpus()[0]?.model ?? '?'} × ${os.cpus().length}`,
    `RAM: ${gb(total - free)} used / ${gb(total)}`,
    `Load (1m): ${os.loadavg()[0].toFixed(2)}`,
    `LAN IP: ${nets.join(', ') || '—'}`,
    `PC uptime: ${humanDuration(os.uptime() * 1000)} · Agent uptime: ${humanDuration(Date.now() - startedAt)}`,
    `Node ${process.version} · Agent RAM: ${Math.round(process.memoryUsage().rss / 1024 ** 2)} MB`,
  ].join('\n');
}

const JOKES = [
  'Why do programmers prefer dark mode? Because light attracts bugs. 🐛',
  'I told my computer I needed a break — now it won\'t stop sending me Kit-Kat ads.',
  'Why did the phone go to therapy? Too many unresolved notifications.',
  'There are only 10 kinds of people: those who understand binary and those who don\'t.',
  'My Wi-Fi went down for five minutes today, so I had to talk to my family. They seem like nice people.',
];
const FACTS = [
  'Honey never spoils — pots found in 3,000-year-old Egyptian tombs are still edible.',
  'Octopuses have three hearts and blue blood.',
  'The first computer bug was a real moth, found in Harvard\'s Mark II in 1947.',
  'India\'s first computer, TIFRAC, was commissioned in 1960 in Mumbai.',
  'A day on Venus is longer than a year on Venus.',
];
const QUOTES = [
  '“The best time to plant a tree was 20 years ago. The second best time is now.”',
  '“Make it work, make it right, make it fast.” — Kent Beck',
  '“Simplicity is the soul of efficiency.” — Austin Freeman',
  '“What gets measured gets managed.” — Peter Drucker',
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const joke = () => pick(JOKES);
export const fact = () => `💡 ${pick(FACTS)}`;
export const quote = () => pick(QUOTES);
