// intents.js — the layer that works with no model at all.
//
// Borrowed straight from the WhatsApp agent's best idea: a plain message like
// "wifi off karo" or "chrome kholo" should act immediately instead of waiting
// for a 7B model to decide it needs a tool. This parser is deterministic and
// runs in under a millisecond, so the notch feels instant even before the model
// has warmed up. Anything it cannot parse goes to the model.

const POLITE = /^(?:please|pls|plz|bhai|bro|yaar|suno|hey|ok|arre|oye|boss|sir|psd)[,\s]+/i;
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

const has = (text, ...words) => words.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(text));

/**
 * @returns {null | {tool: string, args: object, label: string, reply?: string}}
 */
export function parseIntent(input) {
  const original = clean(input);
  if (!original || original.length > 400) return null;
  const text = original.replace(POLITE, '').toLowerCase();

  // Questions are never commands: "what is my battery" must not switch Wi-Fi.
  const question = /\?$/.test(original) || has(text, 'kya', 'kaise', 'kyun', 'kyu', 'what', 'why', 'how', 'explain', 'samjhao', 'meaning', 'who', 'when');

  // ── system status ────────────────────────────────────────────────────────
  if (/^(?:system|pc|computer)?\s*(status|stats|health|haal|haalchaal|kitna (?:ram|cpu|battery))\b/.test(text) ||
      /^(?:what(?:'s| is)|how(?:'s| is)|kitna|kaisa)\b.*\b(battery|ram|cpu|memory|load|uptime|system|pc)\b/.test(text) ||
      /^(battery|ram|cpu|memory|uptime|load)\b.*\b(status|kitna|percent|haal|level)\b/.test(text) ||
      /^how('s| is) (?:my |the )?(?:pc|system|machine)\b/.test(text)) {
    return { tool: 'system_status', args: {}, label: 'Checking the system' };
  }
  if (/\b(?:disk|storage)\b/.test(text) && !question) return { tool: 'disk_space', args: {}, label: 'Disk space' };
  if (/^(?:show |list |meri? )?(?:reminders?)\b/.test(text) && !question) return { tool: 'list_reminders', args: {}, label: 'Reminders' };
  if (/^(?:what(?:'s| is) on )?(?:the )?clipboard\b/.test(text) || /clipboard (?:padho|read|dekho)/.test(text)) {
    return { tool: 'clipboard_read', args: {}, label: 'Clipboard' };
  }
  if (/^(?:time|samay|date|tarikh)\b/.test(text) || /^what(?:'s| is) the time\b/.test(text)) {
    return {
      tool: null, args: {}, label: 'Clock',
      reply: new Date().toLocaleString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }),
    };
  }

  // ── open an app ──────────────────────────────────────────────────────────
  const open = text.match(/^(?:please\s+)?(?:open|launch|start|kholo|khol|chalu)\s+(?:the\s+)?([a-z0-9 .+#_-]{2,40})$/i) ||
    text.match(/^([a-z0-9 .+#_-]{2,40})\s+(?:kholo|khol do|kholo na|open karo|chalu karo)$/i);
  const COMPOUND = /\b(aur|phir|uske baad|and then|then|also)\b/i;
  if (open && !question && !COMPOUND.test(open[1])) {
    const name = clean(open[1]).replace(/\s+(app|application)$/i, '');
    return { tool: 'open_app', args: { name }, label: `Opening ${name}` };
  }

  // ── close/focus a window ─────────────────────────────────────────────────
  const focus = text.match(/^(?:focus|switch to|bring up|window)\s+(.{2,40})$/);
  if (focus) return { tool: 'focus_window', args: { title: clean(focus[1]) }, label: `Focusing ${clean(focus[1])}` };
  if (/^(?:what|which)\s+(?:apps|windows)\b/.test(text) || /windows (?:are )?open/.test(text)) {
    return { tool: 'list_windows', args: {}, label: 'Listing windows' };
  }
  if (/^(?:list|show)\s+(?:my\s+)?apps\b/.test(text)) return { tool: 'list_apps', args: {}, label: 'Listing apps' };

  // ── volume / music ───────────────────────────────────────────────────────
  if (/\b(mute|unmute)\b/.test(text)) return { tool: 'volume', args: { action: 'mute' }, label: 'Toggling mute' };
  if (/\b(volume|awaaz|sound)\b/.test(text) && !question) {
    const up = /\b(up|badhao|badha|increase|louder|zyada)\b/.test(text);
    const down = /\b(down|kam|decrease|quieter|reduce)\b/.test(text);
    const set = text.match(/(\d{1,3})\s*(?:%|percent)/);
    if (set) return { tool: 'volume', args: { action: 'set', value: Number(set[1]) }, label: `Volume ${set[1]}%` };
    return { tool: 'volume', args: { action: up ? 'up' : down ? 'down' : 'get' }, label: 'Adjusting volume' };
  }
  if (/^(?:pause|resume|next|previous|play|stop)\b/.test(text) && !/\b(open|kholo)\b/.test(text)) {
    const word = text.match(/^(pause|resume|next|previous|play|stop)/)?.[1];
    const action = { resume: 'play', play: 'play', pause: 'pause', next: 'next', previous: 'previous', stop: 'stop' }[word];
    return { tool: 'media_control', args: { action }, label: `Music: ${action}` };
  }
  if (/^(?:what(?:'s| is) playing|kaun sa (?:song|gaana)|current (?:song|track))\b/.test(text)) {
    return { tool: 'media_control', args: { action: 'status' }, label: 'Reading the track' };
  }

  // ── toggles ──────────────────────────────────────────────────────────────
  if (question) return null;
  if (/\b(aur|phir|uske baad|and then|then also|and also)\b/i.test(text)) return null;
  const toggle = (word, tool, key) => {
    const on = new RegExp(`\\b(?:turn |switch )?(?:${word})\\s*(?:on|chalu|enable)\\b`).test(text);
    const off = new RegExp(`\\b(?:turn |switch )?(?:${word})\\s*(?:off|band|disable)\\b`).test(text);
    if (on || off) return { tool, args: { [key]: on && !off }, label: `${word} ${on && !off ? 'on' : 'off'}` };
    return null;
  };
  const dnd = toggle('(?:dnd|do not disturb|silent|sannata)', 'do_not_disturb', 'enabled');
  if (dnd) return dnd;
  const dark = toggle('(?:dark mode|dark|night mode)', 'dark_mode', 'enabled');
  if (dark) return dark;
  const light = /\b(?:light mode|turn off dark)\b/.test(text) ? { tool: 'dark_mode', args: { enabled: false }, label: 'Light mode' } : null;
  if (light) return light;
  const night = toggle('(?:night light|nightlight|blue light)', 'night_light', 'enabled');
  if (night) return night;

  // ── wifi / bluetooth ─────────────────────────────────────────────────────
  if (/\bwifi|wi-fi\b/.test(text)) {
    if (!question) {
      if (/\b(off|band|disable)\b/.test(text)) return { tool: 'wifi', args: { action: 'off' }, label: 'Wi-Fi off' };
      if (/\b(on|chalu|enable)\b/.test(text)) return { tool: 'wifi', args: { action: 'on' }, label: 'Wi-Fi on' };
      if (/\b(network|networks|list|scan)\b/.test(text)) return { tool: 'wifi', args: { action: 'list' }, label: 'Scanning Wi-Fi' };
    }
    return { tool: 'wifi', args: { action: 'status' }, label: 'Wi-Fi status' };
  }
  if (/\bbluetooth\b/.test(text) && !question) {
    if (/\b(off|band)\b/.test(text)) return { tool: 'bluetooth', args: { action: 'off' }, label: 'Bluetooth off' };
    if (/\b(on|chalu)\b/.test(text)) return { tool: 'bluetooth', args: { action: 'on' }, label: 'Bluetooth on' };
    return { tool: 'bluetooth', args: { action: 'status' }, label: 'Bluetooth status' };
  }

  // ── screen ───────────────────────────────────────────────────────────────
  if (/^(?:take |grab |le )?(?:a )?screenshot\b/.test(text) || /screenshot (?:le|lo|bhej|send)/.test(text) || /screen ?shot/.test(text)) {
    return { tool: 'screenshot', args: {}, label: 'Taking a screenshot' };
  }
  if (/^(?:lock)\b/.test(text) && !question) return { tool: 'lock_screen', args: {}, label: 'Locking the screen' };

  // ── reminders / memory ────────────────────────────────────────────────────
  //
  // People say this both ways round, and the second way is the natural one:
  //
  //   remind me in 10 minutes to stretch     (time first)
  //   remind me to stretch in 10 minutes     (task first)
  //   remind me to call mum at 6:30          (task first, clock time)
  //
  // The original pattern only matched the first, so "remind me to stretch in 10
  // minutes" fell through to a keyword match and ran list_reminders — answering
  // "No reminders pending" to somebody who had just asked to set one. Accept
  // both orders; the when/task split is the same either way.
  const stripWhen = (value) => clean(value)
    .replace(/^(?:in|at|by|after)\s+/i, '')
    .replace(/\s+(?:in|at|by|after)$/i, '')
    .trim();

  // "remind me to stretch in 10m" and "remind me in 10m to stretch" both leave
  // the infinitive attached to the task; it belongs to neither.
  const taskOf = (value) => clean(value).replace(/^(?:to|that|for)\s+/i, '').trim();

  const remindPrefix = text.match(/^(?:remind me|reminder|yaad dila(?:o|na))\b\s*(.*)$/i);
  if (remindPrefix) {
    let rest = clean(remindPrefix[1]).replace(/^(?:in|after|at|by)\s+/i, '');

    // ── time first: "in 10 minutes to stretch" / "25m to stretch" ──────────
    // The duration must be a bare number+unit (or a clock time); "at 6:30 to X"
    // and "tomorrow 9am X" land here too.
    const leading = rest.match(/^(\d+\s*(?:seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b|\d{1,2}:\d{2}(?:\s*(?:am|pm))?|tomorrow\b[^,]*|tonight|noon|midnight)\s*(?:to|that|for|ke liye|ki)?\s*(.*)$/i);
    if (leading && clean(leading[2])) {
      const when = stripWhen(leading[1]);
      return { tool: 'remind', args: { text: taskOf(leading[2]), when }, label: `Reminder for ${when}` };
    }

    // ── task first: "to stretch in 10 minutes" / "call mum at 6:30" ────────
    const trailing = rest.match(/^(.+?)\s+(?:in|after|at|by)\s+(\d+\s*(?:seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b|\d{1,2}:\d{2}(?:\s*(?:am|pm))?|tomorrow\b[^,]*|tonight|noon|midnight)\s*$/i);
    if (trailing) {
      const when = stripWhen(trailing[2]);
      return { tool: 'remind', args: { text: taskOf(trailing[1]), when }, label: `Reminder for ${when}` };
    }

    // A bare time with no task is still a reminder — "remind me in 20 minutes".
    const bare = rest.match(/^(\d+\s*(?:seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b|\d{1,2}:\d{2}(?:\s*(?:am|pm))?)$/i);
    if (bare) {
      const when = stripWhen(bare[1]);
      return { tool: 'remind', args: { text: 'Reminder', when }, label: `Reminder for ${when}` };
    }
    rest = null;
  }

  const remember = text.match(/^(?:remember|note that|yaad rakho)\b[:\s]+(.+)$/i);
  if (remember) {
    const fact = clean(remember[1]);
    const about = fact.match(/^(?:my |mera |meri )?(.{2,40}?)\s+(?:is|hai|=)\s+(.{1,200})$/i);
    if (about) return { tool: 'remember', args: { key: clean(about[1]), value: clean(about[2]) }, label: 'Saving a fact' };
    return { tool: 'remember', args: { key: `note ${new Date().toISOString().slice(0, 10)}`, value: fact }, label: 'Saving a note' };
  }

  // ── web ──────────────────────────────────────────────────────────────────
  const search = text.match(/^(?:search|google|dhundo|khojo|look up)\s+(?:for\s+|web\s+)?(.{2,200})$/i);
  if (search) return { tool: 'web_search', args: { query: clean(search[1]) }, label: `Searching "${clean(search[1])}"` };
  const read = text.match(/^(?:read|open|fetch)\s+(https?:\/\/\S+)$/i);
  if (read) return { tool: 'read_url', args: { url: read[1] }, label: 'Reading the page' };

  // ── notch ────────────────────────────────────────────────────────────────
  const note = text.match(/^(?:notch|notify(?: me)?)\s*[:\s]\s*(.+)$/i);
  if (note) return { tool: 'notch_show', args: { title: 'PSD', body: clean(note[1]), open: true }, label: 'Showing in the notch' };

  return null;
}

/**
 * Last-resort keyword → tool map. Only consulted when no model answered, so a
 * miss costs nothing and a hit keeps the agent useful on a brainless machine.
 */
const KEYWORDS = [
  [/\b(?:disk|storage|space|jagah)\b/, 'disk_space', () => ({})],
  [/\b(?:battery|charge|batteri)\b/, 'system_status', () => ({})],
  [/\b(?:uptime|load average)\b/, 'system_status', () => ({})],
  [/\b(?:ram|memory|mem)\b/, 'system_status', () => ({})],
  [/\b(?:cpu|processor)\b/, 'system_status', () => ({})],
  [/\b(?:clipboard|paste)\b/, 'clipboard_read', () => ({})],
  [/\b(?:reminders?|remind)\b/, 'list_reminders', () => ({})],
  [/\b(?:windows?|tasks?)\b/, 'list_windows', () => ({})],
  [/\b(?:apps?|applications?)\b/, 'list_apps', () => ({})],
  [/\b(?:screenshot|screen)\b/, 'screenshot', () => ({})],
  [/\b(?:volume|awaaz|mute)\b/, 'volume', () => ({ action: 'get' })],
  [/\b(?:music|song|playing)\b/, 'media_control', () => ({ action: 'status' })],
  [/\b(?:wifi|network)\b/, 'wifi', () => ({ action: 'status' })],
  [/\b(?:bluetooth)\b/, 'bluetooth', () => ({ action: 'status' })],
  [/\b(?:lock)\b/, 'lock_screen', () => ({})],
];

export function keywordTool(input, tools) {
  const text = clean(input).toLowerCase();
  for (const [pattern, tool, build] of KEYWORDS) {
    if (!pattern.test(text)) continue;
    if (tools && !tools.byName.has(tool)) continue;
    return { tool, args: build() };
  }
  return null;
}

/** Small talk / identity answers that never need a model. */
export function quickReply(input) {
  const text = clean(input).toLowerCase().replace(POLITE, '');
  if (/^(?:hi|hello|hey|yo|namaste|namaskar|salaam|good (?:morning|evening|afternoon))\b/.test(text)) {
    return 'Sir — PSD online. Notch, phone and WhatsApp are all wired to the same hands. What are we doing?';
  }
  if (/^(?:who are you|tum kaun|kaun ho|what are you)\b/.test(text)) {
    return 'PSD — your personal agent. OpenJarvis-style agents and skills running on your Fedora box, with the notch as the face, the phone app as the remote and WhatsApp as the line to you.';
  }
  if (/^(?:thanks|thank you|shukriya|dhanyavad)\b/.test(text)) return 'Anytime, Sir.';
  if (/^(?:help|commands|kya kar sakte ho|what can you do)\b/.test(text)) {
    return [
      'Try any of these — no model needed:',
      '• system status · screenshot · volume up · mute · next',
      '• open chrome · what windows are open · focus code',
      '• wifi off · bluetooth on · dark mode on · night light off',
      '• remind me in 25m to stretch · remember: my editor is neovim',
      '• search quantum error correction · read https://…',
      '• notch: build finished',
      'Anything else goes to the agent loop with tools (files, shell if enabled, web, reminders, notch, WhatsApp).',
    ].join('\n');
  }
  return null;
}
