// commands.js — the agent's behaviour: slash commands, plain-language
// intents, AI chat, and forwarding to Observer. Pure of WhatsApp: it takes
// text and returns a reply object, so it is fully testable offline.
//
// Reply shape: string, or { text?, image?: Buffer, document?: {buffer,
// fileName, mimetype}, sticker?: Buffer, poll?: {name, values} }

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import QRCode from 'qrcode';
import * as tools from './tools.js';
import * as ai from './ai.js';

const execAsync = promisify(exec);
const HELP = `🤖 *Observer WhatsApp Agent* — free, native, owner-only

*Chat*
• Just type normally — I answer with the free local AI (Ollama) if it's running
• /ask <question> · /forget (clear chat memory) · /model (AI status)
• /remember <thing> · /memory · e.g. "remember wifi is on the fridge"
• /summarize <text or URL> · /improve <text>

*Do things*
• /remind in 10m <text> · /remind at 18:30 <text> · /remind tomorrow 9am <text>
• /reminders · /remind del <id> · /timer 5m <label>
• /todo add <text> · /todo · /todo done <id> · /todo del <id>
• /note <text> · /notes · /note del <id>
• /observer <text> — hand it to Observer on my PC (screen/camera/tools)
• /screen — ask Observer what's on the PC screen right now
• /pc status · /pc disk · /pc ip

*Look things up (all free, no keys)*
• /weather <city> · /wiki <topic> · /define <word> · /news [topic]
• /currency 100 USD to INR · /unit 10 km to mi · /calc 45*12+sqrt(81)
• /url <link> — read + summarise a page

*Utilities*
• /qr <text/link> · /sticker (send with a photo) · /poll Q | A | B
• /password [length] · /shorten <url> · /time · /date · /choose a, b, c
• /files · /get <filename> (shared folder) · /downloads
• /joke · /fact · /quote · /coin · /dice
• /ping · /status · /me · /help

_You can also talk naturally: "remind me in 5 minutes to drink water", "note: gate code is 4321", "what's the weather in Nainital", "45*12"._`;

const num = (s) => Number.parseInt(String(s ?? ''), 10);

export function createAgent({ config, store, log = console, forwardToObserver = async () => null, observerOnline = () => false }) {
  const tz = config.timezone;

  // ── individual commands ──────────────────────────────────────────────────

  function remind(args) {
    if (!args || args === 'list') return listReminders();
    const del = args.match(/^del(?:ete)?\s+(\d+)$/i);
    if (del) return store.deleteReminder(num(del[1])) ? `🗑️ Reminder #${del[1]} deleted.` : `No reminder #${del[1]}. See /reminders`;
    const parsed = tools.parseWhen(args);
    if (!parsed || !parsed.rest) {
      return '⏰ I didn\'t get the time. Try:\n/remind in 10m drink water\n/remind at 18:30 gym\n/remind tomorrow 9am standup';
    }
    const r = store.addReminder(parsed.rest, parsed.dueTs);
    return `⏰ Done — I'll remind you about *${r.text}* on ${tools.formatDateTime(r.dueTs, tz)} (in ${tools.humanDuration(r.dueTs - Date.now())}).`;
  }

  function listReminders() {
    if (!store.data.reminders.length) return '⏰ No reminders set. Try: /remind in 10m drink water';
    return '⏰ *Reminders*\n\n' + store.data.reminders.map((r) => `#${r.id} · ${tools.formatDateTime(r.dueTs, tz)} — ${r.text}`).join('\n');
  }

  function todo(args) {
    const [sub, ...rest] = (args || '').split(/\s+/);
    const restText = rest.join(' ');
    if (!args || sub === 'list') {
      if (!store.data.todos.length) return '✅ To-do list is empty. Add: /todo add buy milk';
      return '✅ *To-dos*\n\n' + store.data.todos.map((t) => `#${t.id} ${t.done ? '✔️~~' : '▫️'}${t.text}${t.done ? '~~' : ''}`).join('\n');
    }
    if (sub === 'add' && restText) { const t = store.addTodo(restText); return `✅ Added #${t.id}: ${t.text}`; }
    if ((sub === 'done' || sub === 'undone') && rest[0]) {
      const t = store.setTodoDone(num(rest[0]), sub === 'done');
      return t ? `${t.done ? '✔️ Done' : '↩️ Reopened'}: ${t.text}` : `No to-do #${rest[0]}.`;
    }
    if ((sub === 'del' || sub === 'delete' || sub === 'rm') && rest[0]) {
      return store.deleteTodo(num(rest[0])) ? `🗑️ To-do #${rest[0]} deleted.` : `No to-do #${rest[0]}.`;
    }
    if (sub === 'clear') return `🧹 Cleared ${store.clearDoneTodos()} completed to-do(s).`;
    // "/todo buy milk" = add
    const t = store.addTodo(args);
    return `✅ Added #${t.id}: ${t.text}`;
  }

  function note(args) {
    const del = (args || '').match(/^del(?:ete)?\s+(\d+)$/i);
    if (del) return store.deleteNote(num(del[1])) ? `🗑️ Note #${del[1]} deleted.` : `No note #${del[1]}.`;
    if (!args) return '📝 Usage: /note <text> — see all with /notes';
    const n = store.addNote(args);
    return `📝 Saved note #${n.id}.`;
  }

  function notes() {
    if (!store.data.notes.length) return '📝 No notes yet. Save one: /note gate code is 4321';
    return '📝 *Notes*\n\n' + store.data.notes.map((n) => `#${n.id} · ${n.text}`).join('\n');
  }

  function remember(args) {
    const text = (args || '').replace(/^that\s+/i, '').trim();
    if (!text) return '🧠 Usage: /remember <thing> — e.g. /remember my bike number is UK04 AB 1234';
    const key = text.slice(0, 48);
    store.data.facts[key] = text;
    store.save();
    return '🧠 Remembered. I\'ll keep it in mind in our chats. (/memory to see all)';
  }

  function memory() {
    const facts = Object.values(store.data.facts ?? {});
    if (!facts.length) return '🧠 I haven\'t memorised anything yet. Try: /remember my office Wi-Fi password is …';
    return '🧠 *What I remember*\n\n' + facts.map((f) => `• ${f}`).join('\n') + '\n\n/forget memory — wipe these';
  }

  function pcInfo(args) {
    const what = (args || 'status').trim().toLowerCase();
    if (what === 'disk') {
      try {
        const s = fs.statfsSync(config.dataDir);
        const total = s.blocks * s.bsize;
        const free = s.bavail * s.bsize;
        return `💾 Disk: *${(free / 1024 ** 3).toFixed(1)} GB free* of ${(total / 1024 ** 3).toFixed(1)} GB (${Math.round(((total - free) / total) * 100)}% used)`;
      } catch { return '💾 Could not read disk info on this system.'; }
    }
    if (what === 'ip') return tools.systemInfo(store.data.stats.startedAt).split('\n').find((l) => l.startsWith('LAN IP')) ?? 'No LAN IP found.';
    return tools.systemInfo(store.data.stats.startedAt);
  }

  function files() {
    let names = [];
    try { names = fs.readdirSync(config.sharedDir).filter((f) => fs.statSync(path.join(config.sharedDir, f)).isFile()); } catch { /* no dir yet */ }
    if (!names.length) return `📂 Shared folder is empty.\nPut files in:\n${config.sharedDir}\nThen /get <filename> sends one to you here.`;
    return '📂 *Shared files*\n\n' + names.map((n) => `• ${n}`).join('\n') + '\n\nSend one with /get <filename>';
  }

  function getFile(name) {
    const base = path.basename(String(name ?? '')); // basename kills ../ traversal by construction
    const file = path.join(config.sharedDir, base);
    if (!base || !fs.existsSync(file)) return `📂 "${base || name}" isn't in the shared folder. /files lists what's there.`;
    const stat = fs.statSync(file);
    if (stat.size > 64 * 1024 * 1024) return '📂 That file is over WhatsApp\'s 64 MB document limit.';
    return { text: `📄 ${base} (${(stat.size / 1024).toFixed(0)} KB)`, document: { buffer: fs.readFileSync(file), fileName: base } };
  }

  async function runShell(args) {
    if (!config.allowShell) return '🔒 Shell is OFF (ALLOW_SHELL=false). That\'s the safe default — /pc status, /pc disk and /observer cover most needs.';
    const m = (args || '').match(/^(\S+)\s+([\s\S]+)$/);
    if (!m || m[1] !== config.shellPin) return '🔒 Usage: /run <PIN> <command>';
    try {
      const { stdout, stderr } = await execAsync(m[2], { timeout: 15_000, maxBuffer: 1024 * 1024, cwd: config.dataDir });
      const out = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim().slice(0, 3500);
      return `\`\`\`\n${out || '(no output)'}\n\`\`\``;
    } catch (err) {
      return `\`\`\`\n${String(err.stdout ?? '')}\n${String(err.stderr ?? err.message).slice(0, 2000)}\n\`\`\``;
    }
  }

  async function askObserver(text) {
    if (!observerOnline()) {
      return '🖥️ Observer isn\'t open on the PC right now, so I can\'t use its screen/camera tools.\nOpen Observer there, then send /observer again. (I can still chat and run my own commands.)';
    }
    const reply = await forwardToObserver(text);
    if (!reply) return '🖥️ Observer didn\'t answer in time. It may still be working — its reply will arrive here when ready. Otherwise check the PC.';
    const out = { text: reply.text };
    if (reply.images?.length) {
      out.image = Buffer.from(reply.images[0], 'base64');
      out.extraImages = reply.images.slice(1).map((b64) => Buffer.from(b64, 'base64'));
    }
    return out;
  }

  // ── router ───────────────────────────────────────────────────────────────

  async function handleCommand(cmd, args, ctx) {
    switch (cmd) {
      case 'help': case 'commands': case 'menu': case 'start': return HELP;
      case 'ping': return `🏓 Pong! Agent is alive (uptime ${tools.humanDuration(Date.now() - store.data.stats.startedAt)}).`;
      case 'me': case 'id': case 'whoami':
        return `👤 You (owner): +${config.ownerNumber}\n🤖 Me (agent): +${config.agentNumber}\nI ignore every other number completely.`;
      case 'status': {
        const s = store.data.stats;
        return [
          `🤖 *Agent status*`,
          `Owner: +${config.ownerNumber} · Agent: +${config.agentNumber}`,
          `WhatsApp: ${ctx.waStatus?.() ?? '?'}`,
          `Uptime: ${tools.humanDuration(Date.now() - s.startedAt)}`,
          `Messages: ${s.received} in · ${s.replied} out · ${s.ignoredNonOwner} non-owner ignored`,
          `Data: ${store.data.todos.filter((t) => !t.done).length} open to-dos · ${store.data.notes.length} notes · ${store.data.reminders.length} reminders`,
          `Observer bridge: ${observerOnline() ? 'tab connected 🖥️' : 'no Observer tab polling'}`,
          `Cost so far: ₹0 (native WhatsApp, local tools)`,
        ].join('\n');
      }
      case 'time': return `🕐 ${new Date().toLocaleTimeString('en-IN', { timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })} (${tz})`;
      case 'date': return `📅 ${new Date().toLocaleDateString('en-IN', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`;
      case 'remind': case 'reminder': return remind(args);
      case 'reminders': return listReminders();
      case 'timer': return remind(args);
      case 'todo': case 'todos': case 'task': return todo(args);
      case 'note': return note(args);
      case 'notes': return notes();
      case 'remember': return remember(args);
      case 'memory': return memory();
      case 'forget':
        if (/^memory$/i.test(args || '')) { store.data.facts = {}; store.save(); return '🧠 Memorised facts wiped.'; }
        store.clearHistory();
        return '🧹 Chat memory cleared. Fresh start!';
      case 'model': case 'ai': if (!args) return ai.aiStatus(config); return askAI(args);
      case 'ask': return args ? askAI(args) : '💬 Usage: /ask <question> — or just type your question normally.';
      case 'summarize': case 'summarise': case 'tldr': {
        if (!args) return '📄 Usage: /summarize <text or URL>';
        const body = /^https?:\/\//i.test(args.trim()) ? (await tools.fetchPageText(args.trim())).text : args;
        const done = await ai.complete(config, `Summarise this in a short WhatsApp-friendly way with bullet points:\n\n${body.slice(0, 8000)}`, log);
        return done ? `📄 *Summary*\n\n${done.text}` : `${body.slice(0, 1500)}\n\n_(No AI brain reachable for a summary — showing the start instead. See /model)_`;
      }
      case 'improve': case 'rewrite': {
        if (!args) return '✍️ Usage: /improve <your text>';
        const done = await ai.complete(config, `Improve this text (clearer, polite, same language, keep it short). Reply with only the improved text:\n\n${args}`, log);
        return done ? done.text : '✍️ No AI brain reachable right now (see /model). Your text was:\n' + args;
      }
      case 'weather': return args ? tools.weather(args) : '🌤️ Usage: /weather <city> — e.g. /weather Nainital';
      case 'wiki': return args ? tools.wiki(args) : '📚 Usage: /wiki <topic>';
      case 'define': return args ? tools.define(args) : '🔤 Usage: /define <word>';
      case 'news': return tools.news(args || '');
      case 'calc': {
        if (!args) return '🧮 Usage: /calc 45*12 + sqrt(81)';
        const percentOf = args.match(/^([\d.]+)\s*%\s*of\s*([\d.]+)$/i);
        if (percentOf) return `🧮 ${percentOf[1]}% of ${percentOf[2]} = *${(Number(percentOf[1]) / 100) * Number(percentOf[2])}*`;
        return `🧮 ${args} = *${tools.calc(args)}*`;
      }
      case 'unit': case 'convert': {
        const m = (args || '').match(/^(-?[\d.]+)\s*([a-zA-Z°]+)\s+(?:to|in|->)\s*([a-zA-Z°]+)$/);
        return m ? `🔁 ${tools.convertUnit(Number(m[1]), m[2], m[3])}` : '🔁 Usage: /unit 10 km to mi';
      }
      case 'currency': case 'fx': {
        const m = (args || '').match(/^([\d.]+)\s*([A-Za-z]{3})\s+(?:to|in)\s+([A-Za-z]{3})$/);
        return m ? tools.currency(Number(m[1]), m[2], m[3]) : '💱 Usage: /currency 100 USD to INR';
      }
      case 'url': {
        if (!args) return '🌐 Usage: /url <link>';
        const page = await tools.fetchPageText(args.trim());
        const done = await ai.complete(config, `Summarise this web page ("${page.title}") briefly for WhatsApp with bullet points:\n\n${page.text.slice(0, 8000)}`, log);
        return done ? `🌐 *${page.title}*\n\n${done.text}` : `🌐 *${page.title}*\n\n${page.text.slice(0, 1500)}\n\n_(No AI brain for a summary — see /model)_`;
      }
      case 'qr': {
        if (!args) return '🔳 Usage: /qr <text or link>';
        return { image: await QRCode.toBuffer(args, { width: 640, margin: 2 }), text: `🔳 QR for: ${args.slice(0, 200)}` };
      }
      case 'password': case 'pw': return `🔐 \`${tools.generatePassword(num(args) || 16)}\`\n_(generated on your PC, never stored)_`;
      case 'uuid': return `🆔 \`${crypto.randomUUID()}\``;
      case 'shorten': return args ? tools.shorten(args.trim()) : '🔗 Usage: /shorten <url>';
      case 'coin': return Math.random() < 0.5 ? '🪙 Heads' : '🪙 Tails';
      case 'dice': return `🎲 ${1 + Math.floor(Math.random() * 6)}`;
      case 'choose': {
        const options = (args || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
        return options.length > 1 ? `🎯 I pick: *${options[Math.floor(Math.random() * options.length)]}*` : '🎯 Usage: /choose pizza, burger, dosa';
      }
      case 'joke': return `😄 ${tools.joke()}`;
      case 'fact': return tools.fact();
      case 'quote': return tools.quote();
      case 'poll': {
        const parts = (args || '').split('|').map((s) => s.trim()).filter(Boolean);
        return parts.length >= 3
          ? { poll: { name: parts[0], values: parts.slice(1, 13) }, text: undefined }
          : '📊 Usage: /poll Lunch today? | Dosa | Pizza | Thali';
      }
      case 'files': return files();
      case 'get': case 'sendfile': return getFile(args);
      case 'downloads': {
        if (!store.data.downloads.length) return '⬇️ Nothing received yet. Send me a photo/file and I\'ll save it on the PC.';
        return '⬇️ *Recently received*\n\n' + store.data.downloads.slice(0, 10).map((d) => `• ${d.file} (${d.kind}, ${tools.formatDateTime(d.ts, tz)})`).join('\n');
      }
      case 'pc': case 'system': case 'sysinfo': return pcInfo(cmd === 'pc' ? args : '');
      case 'observer': case 'obs': return args ? askObserver(args) : '🖥️ Usage: /observer <what to do/look at on the PC>';
      case 'screen': return askObserver(args ? `Look at my screen and answer: ${args}` : 'Look at my screen and tell me briefly what is on it right now. Include a screenshot if you can.');
      case 'run': case 'exec': case 'shell': return runShell(args);
      case 'sticker': return '🎨 Send /sticker *with a photo* (as its caption) and I\'ll turn it into a sticker.';
      default:
        return `🤖 I don't know /${cmd} yet.\n\n${HELP.split('\n').slice(0, 6).join('\n')}\n…full list: /help`;
    }
  }

  async function askAI(text) {
    const result = await ai.chat(config, store, text, log);
    if (result) return result.text;
    // No brain: still try to be useful offline for factual questions.
    const q = text.replace(/^(what is|who is|tell me about)\s+/i, '').replace(/\?$/, '').trim();
    try {
      if (q.length >= 3 && q.length <= 80 && /^(what|who|where|when)/i.test(text)) {
        return `${await tools.wiki(q)}\n\n_(from Wikipedia — local AI is off, see /model)_`;
      }
    } catch { /* fall through to hint */ }
    return ai.NO_BRAIN_HINT;
  }

  /** Natural-language shortcuts. Returns a reply, or undefined to continue to AI/Observer. */
  function intent(text) {
    let m;
    if (/^remind me\b/i.test(text)) {
      // "remind me in 5 minutes to drink water" → remind("in 5 minutes to drink water")
      // parseWhen already swallows the "to" after the duration / clock time.
      return remind(text.replace(/^remind me\s+/i, ''));
    }
    if ((m = text.match(/^(?:note(?:\s+kar\s+lo)?\s*[:\-]?\s+|note that\s+)([\s\S]+)$/i))) return note(m[1]);
    if ((m = text.match(/^(?:add\s+(?:a\s+)?todo[:\s]+|todo[:\s]+)([\s\S]+)$/i))) return todo(`add ${m[1]}`);
    if ((m = text.match(/^remember\s+(?:that\s+)?([\s\S]+)$/i))) return remember(m[1]);
    if ((m = text.match(/^(?:what(?:'s| is) the )?weather\s+(?:in|at)\s+([\s\S]+?)\??$/i))) return tools.weather(m[1]);
    if ((m = text.match(/^([\s\S]+?)\s+ka\s+mausam\??$/i))) return tools.weather(m[1]);
    if ((m = text.match(/^(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)\??$/i))) {
      return `🧮 ${m[1]}% of ${m[2]} = *${(Number(m[1]) / 100) * Number(m[2])}*`;
    }
    if (tools.looksLikeCalc(text)) {
      try { return `🧮 ${text.trim()} = *${tools.calc(text)}*`; } catch { /* not maths after all */ }
    }
    if (/^(hi|hello|hey|namaste|hii+|yo)[!. ]*$/i.test(text)) {
      return `👋 Namaste! I'm your Observer agent on +${config.agentNumber} — free, native WhatsApp, listening only to you.\n\nAsk me anything, or try /help, /weather <city>, /remind in 10m <text>.`;
    }
    return undefined;
  }

  /** Main entry: owner text → reply. `ctx` may carry { waStatus(), quotedMedia }. */
  async function handle(text, ctx = {}) {
    const clean = String(text ?? '').trim();
    if (!clean) return '🤖 I got an empty message. Try /help';
    try {
      const cmdMatch = clean.match(/^\/([a-zA-Z]+)\s*([\s\S]*)$/);
      if (cmdMatch) return await handleCommand(cmdMatch[1].toLowerCase(), cmdMatch[2].trim(), ctx);

      const quick = intent(clean);
      if (quick !== undefined) return await quick;

      if (config.forwardToObserver && observerOnline()) {
        const fromObserver = await askObserver(clean);
        // askObserver already explains failures; only fall through on timeout handled there.
        return fromObserver;
      }
      return await askAI(clean);
    } catch (err) {
      log.error?.(`[commands] failed on "${clean.slice(0, 60)}": ${err.message}`);
      return `⚠️ That didn't work: ${err.message}\nNothing was charged (everything here is free). Try /help`;
    }
  }

  return { handle, HELP };
}
