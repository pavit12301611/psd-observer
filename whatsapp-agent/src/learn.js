// learn.js — teach the agent custom keywords like /work → open all your apps
// Free, offline, no AI needed. Owner-only, persisted in store.json (learned: [])

const RESERVED = new Set([
  'help','commands','menu','start','ping','me','id','whoami','status','time','date',
  'remind','reminder','reminders','timer','todo','todos','task','note','notes','remember','memory','forget',
  'model','ai','ask','summarize','summarise','tldr','improve','rewrite',
  'weather','wiki','define','news','calc','unit','convert','currency','fx','url','qr','password','pw','uuid','shorten','coin','dice','choose','joke','fact','quote','poll',
  'files','get','sendfile','downloads','pc','system','sysinfo','observer','obs','screen','look','lookscreen','ocr','screenshot','shot','webcam','cam','record','screencast','run','exec','shell','sticker',
  'apps','applications','windows','tasks','focus','switch','open','close','quit','wifi','bt','bluetooth','kill','svc','service','notify','doctor','diag','diagnose','access',
  'ls','dir','read','cat','write','savefile','send','getfile','download','dl','mv','move','rename','cp','copy','mkdir','zip','unzip','rm','delete',
  'agent','do','yes','haan','no','nahi','cancel','link',
  'cron','schedule','repeat','jobs','voicereply','voice','tts','bol','speak',
  'learn','teach','alias','unlearn','undefine','forgetword','work' // work is allowed actually, but keep reserved minimal; we allow overriding? but we reserve core to avoid confusion
]);

// Actually allow 'work' as custom — so remove it from reserved if present
RESERVED.delete('work');

export function normalizeKeyword(raw) {
  const k = String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return k.slice(0, 24); // max 24 chars
}

export function isReserved(keyword) {
  return RESERVED.has(String(keyword).toLowerCase());
}

// Parse a learn command string into array of {cmd, args, raw}
// Input examples:
//   "open chrome | open slack | open vs code"
//   "open chrome; open slack"
//   "chrome, slack, vscode"  → each single word = open that app
//   "chrome slack vscode" (space separated single words, no delimiter) → treat as 3 opens if no known command matches
export function parseLearnCommands(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;

  // First try delimiters: | ; newline ; && ; and then
  // Split by | ; \n  ; also handle " and " and " then " as separators only when they look like separators
  let parts = [];
  // primary split by | ; newline
  if (/[|;\n]/.test(text)) {
    parts = text.split(/[|;\n]+/).map(s => s.trim()).filter(Boolean);
  } else if (text.includes(',')) {
    parts = text.split(',').map(s => s.trim()).filter(Boolean);
  } else {
    // No delimiter — could be space-separated single-word apps or a single command
    // If text looks like one command: starts with known verb, keep as one
    const firstWord = text.split(/\s+/)[0].toLowerCase();
    const singleCommandVerbs = new Set(['open','close','apps','pc','screenshot','wifi','todo','remind','cron','voicereply','notify','ls','read','write','send','download','mv','cp','mkdir','zip','unzip','rm','kill','svc','doctor','weather','wiki','calc','quote','joke','screen','look','ocr']);
    if (singleCommandVerbs.has(firstWord) || text.startsWith('/')) {
      parts = [text];
    } else {
      // Space-separated single words like "chrome slack vscode" → each is an app to open
      const tokens = text.split(/\s+/).map(t => t.trim()).filter(Boolean);
      // Heuristic: if tokens are all single words without spaces, treat each as app
      if (tokens.length > 1 && tokens.every(t => !t.includes(' ') && t.length <= 30)) {
        parts = tokens;
      } else {
        parts = [text];
      }
    }
  }

  const commands = [];
  for (const raw of parts) {
    if (!raw) continue;
    // Allow leading slash
    const trimmed = raw.replace(/^\//, '').trim();
    if (!trimmed) continue;
    // Single word without space and no explicit verb → interpret as open <app>
    if (!trimmed.includes(' ') && !trimmed.includes('|') && !trimmed.includes(';')) {
      const w = trimmed.toLowerCase();
      // If it's already a known command verb alone, keep as is
      const knownSingle = new Set(['apps','windows','tasks','files','downloads','screenshot','ocr','status','time','date','help','ping']);
      if (knownSingle.has(w)) {
        commands.push({ cmd: w, args: '', raw: trimmed });
      } else {
        // treat as app name to open: chrome → open_app chrome
        commands.push({ cmd: 'open', args: trimmed, raw: trimmed, inferredOpen: true });
      }
    } else {
      // Contains space → first word is cmd, rest is args
      const m = trimmed.match(/^([a-zA-Z_]+)\s*([\s\S]*)$/);
      if (!m) continue;
      commands.push({ cmd: m[1].toLowerCase(), args: (m[2] ?? '').trim(), raw: trimmed });
    }
    if (commands.length >= 12) break; // max 12 steps per keyword to avoid abuse
  }

  return commands.length ? commands : null;
}

export function formatLearned(entry) {
  if (!entry) return '';
  const steps = entry.commands.map(c => c.inferredOpen ? `${c.args}` : `/${c.cmd}${c.args ? ' '+c.args : ''}`).join(' | ');
  return `/${entry.keyword} → ${steps}`;
}

export function validateKeyword(keyword) {
  const k = normalizeKeyword(keyword);
  if (!k) return 'Keyword khali nahi ho sakta. e.g. /learn work open chrome | open slack';
  if (k.length < 2) return 'Keyword kam se kam 2 letters ka ho. e.g. /learn work open chrome';
  if (isReserved(k)) return `/${k} built-in command hai, is naam se learn nahi kar sakte. Koi dusra naam use karo jaise /learn mywork ...`;
  if (!/^[a-z][a-z0-9_-]*$/i.test(k)) return 'Keyword sirf letters, numbers, - _ se bane. e.g. /learn work, /learn morning-routine';
  return null;
}
