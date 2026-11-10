// gmailsignup.js — 🪪 Google account banane ka *assistant* (jhooth nahi).
//
// Google ke paas @gmail.com account banane ka koi API nahi hai. Signup ek
// browser form hai jisme phone OTP + captcha aata hai, aur automated signup
// Google ke Terms ke against hai. Isliye ye module "account bana do" ka waada
// nahi karta — ye teen cheezein karta hai jo sach me ho sakti hain:
//
//   1. Username availability ka *hint* (Google ka apna gxlu endpoint).
//   2. Form ke fields ka plan — naam / username / password (password sealed
//      rehta hai aur screen pe type hota hai, chat me kabhi nahi).
//   3. Har field ko label se dhoondh ke click+type karna (OCR/AT-SPI), aur jo
//      na mile use imaandari se "chhoot gaya" report karna.
//
// Baaki — phone OTP aur captcha — aapke haath me hi rahega. Wahi Google ka
// design hai, kisi tool se bypass nahi hota.

export const SIGNUP_URL = 'https://accounts.google.com/signup/v2/createaccount?flowName=GlifWebSignIn';
export const AVAILABILITY_URL = (address) => `https://mail.google.com/mail/gxlu?email=${encodeURIComponent(address)}`;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Pavit Kumar Singh" → {first:'Pavit', last:'Kumar Singh'} (last name me poora bacha hua). */
export function splitName(raw) {
  const parts = String(raw ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/**
 * Memory facts se profile nikaalo. Jo nahi mila wo khaali — guess NAHI karte
 * (galat birthday Google ko permanently chala jayega).
 */
export function profileFromFacts(facts = {}) {
  const get = (...keys) => {
    for (const key of keys) {
      const value = facts?.[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (value && typeof value === 'object' && typeof value.value === 'string') return value.value.trim();
    }
    return '';
  };
  const fullName = get('naam', 'name', 'full name', 'fullname', 'first name');
  const { first, last } = splitName(fullName);
  const dobRaw = get('birthday', 'bday', 'janamdin', 'dob', 'date of birth');
  return {
    first,
    last,
    dobRaw,
    birthday: parseBirthday(dobRaw),
    gender: get('gender', 'ling') || null,
    fullName,
  };
}

/** dd/mm/yyyy, yyyy-mm-dd, "12 March 2006", "12 march 2006" — sab. */
export function parseBirthday(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  let day = null;
  let month = null;
  let year = null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];

  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (dmy) [day, month, year] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];

  const named = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(text);
  if (named) {
    const index = MONTHS.findIndex((name) => name.toLowerCase().startsWith(named[2].toLowerCase().slice(0, 3)));
    if (index >= 0) [day, month, year] = [Number(named[1]), index + 1, Number(named[3])];
  }

  if (!day || !month || !year) return null;
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  const nowYear = new Date().getFullYear();
  if (year < 1900 || year > nowYear) return null;
  return { day, month, year, monthName: MONTHS[month - 1] };
}

/**
 * Kaun-kaun se field bharenge, kis order me. `secret: true` wale values kabhi
 * kisi reply me nahi jaate — sirf screen pe type hote hain.
 */
export function signupFieldPlan({ username, profile = {}, gender = null } = {}) {
  const plan = [];
  if (profile.first) plan.push({ label: 'First name', value: profile.first });
  if (profile.last) plan.push({ label: 'Last name', value: profile.last });
  if (username) plan.push({ label: 'Username', value: username });
  plan.push({ label: 'Password', value: 'secret', secret: true });
  plan.push({ label: 'Confirm', value: 'secret', secret: true });
  if (profile.birthday) {
    plan.push({ label: 'Month', value: profile.birthday.monthName });
    plan.push({ label: 'Day', value: String(profile.birthday.day) });
    plan.push({ label: 'Year', value: String(profile.birthday.year) });
  }
  if (gender) plan.push({ label: 'Gender', value: gender });
  return plan;
}

/** WhatsApp-friendly plan: password ki jagah ••••••••. */
export function describePlan(plan, { filled = [], skipped = [] } = {}) {
  const rows = (plan ?? []).map((field) => `• ${field.label}: ${field.secret ? '••••••••' : field.value}`);
  const lines = ['🪪 *Signup fill plan*', ...rows];
  if (filled.length) lines.push('', `✅ Bhar diya: ${filled.join(', ')}`);
  if (skipped.length) lines.push(`⚠️ Nahi mila (agli card pe dobara \`/email signup fill\`): ${skipped.join(', ')}`);
  return lines.join('\n');
}

/**
 * Google ka gxlu endpoint account exist karta hai to COMPASS cookie set karta
 * hai. Best-effort hint — final faisla Google ka signup form karega.
 */
export function parseAvailability(headers, status = 0) {
  const text = Array.isArray(headers)
    ? headers.map((entry) => (Array.isArray(entry) ? entry.join(': ') : String(entry))).join('\n')
    : String(headers ?? '');
  if (/compass\s*=/i.test(text)) return 'taken';
  if (status >= 400 && status < 500) return 'free';
  if (status >= 200 && status < 400) return 'free';
  return 'unknown';
}

export async function checkUsername(username, opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = 8000,
    domain = 'gmail.com',
  } = opts;
  const local = String(username ?? '').trim().replace(/@.*$/, '');
  if (!/^[a-zA-Z0-9._-]{5,30}$/.test(local)) return { username: local, state: 'invalid' };
  const address = `${local}@${domain}`;
  if (typeof fetchImpl !== 'function') return { username: local, address, state: 'unknown' };
  try {
    const response = await fetchImpl(AVAILABILITY_URL(address), {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'ObserverWhatsAppAgent/3.14.2 (+personal assistant)' },
    });
    const headers = typeof response.headers?.raw === 'function' ? response.headers.raw() : response.headers;
    return { username: local, address, state: parseAvailability(headers, response.status ?? 0) };
  } catch {
    return { username: local, address, state: 'unknown' };
  }
}

export function describeAvailability(result) {
  const { username, address, state } = result ?? {};
  if (state === 'invalid') return `🪪 \`${username || '?'}\` valid Gmail username nahi hai (5–30 chars: a-z, 0-9, dot, underscore).`;
  if (state === 'taken') return `❌ *${address}* lagta hai pehle se kisi ka hai.\nWarna aap khud try karo — agar available hua to seedha signup me daal do.\nAlternatives: \`${username}.ai\`, \`${username}01\`, \`${username}.official\`, \`psd.ai.${new Date().getFullYear()}\``;
  if (state === 'free') return `✅ *${address}* khali lag raha hai (hint) — signup me daal ke confirm karo.`;
  return `🤔 *${address}* ka status pata nahi chala (Google ne jawab nahi diya) — signup form hi final batayega.`;
}

/** Signup ke liye ek hi jagah instructions. */
export function signupChecklist({ username = 'psd_ai', profile = {} } = {}) {
  const missing = [];
  if (!profile.first) missing.push('naam → `/remember mera naam <naam>`');
  if (!profile.birthday) missing.push('birthday → `/remember meri birthday 12 March 2006`');
  return [
    `🪪 *Naya Gmail — ${username}@gmail.com*`,
    '',
    '1️⃣ `/email signup check` — naam pehle se taken hai ya nahi (hint).',
    '2️⃣ `/email signup start` — signup page khulta hai, password pehle se ready (sealed).',
    '3️⃣ `/email signup fill` — jo field screen pe dikh raha hai, wo bhar deta hoon (naam/username/password/birthday).',
    '4️⃣ Phone OTP + captcha **aap** karo — Google yahi maangta hai, koi API/script ise bypass nahi kar sakta.',
    '5️⃣ Account ban gaya → `/email auto create` (app password khud banwaye + padhe).',
    '',
    missing.length ? `⚠️ Pehle ye bhar do: ${missing.join(' · ')}` : '✅ Naam + birthday memory me mile — fill ready hai.',
    '',
    '_Password screen pe type hoga, chat me kabhi nahi._',
  ].join('\n');
}
