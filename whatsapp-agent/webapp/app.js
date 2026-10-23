/* Observer Agent — phone app shell (vanilla JS, no build step).
   Talks only to this PC's local bridge; the token is the credential. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const TOKEN_KEY = 'observer-agent-token';
  const CHAT_KEY = 'observer-agent-chat';

  let token = localStorage.getItem(TOKEN_KEY) || '';
  let sessionEpoch = 0;
  let statusTimer = null;
  let screenBusy = false;
  let screenEtag = '';
  let screenUrlLive = null;
  let installEvent = null;

  // ── tiny formatting helpers ───────────────────────────────────────────────
  const escapeHtml = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function waFormat(text) {
    let out = escapeHtml(text);
    out = out.replace(/```([\s\S]*?)```/g, (_, code) => `<code style="display:block;white-space:pre-wrap;margin:4px 0">${code}</code>`);
    out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<b>$2</b>');
    out = out.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<i>$2</i>');
    out = out.replace(/(^|[\s(])~([^~\n]+)~/g, '$1<s>$2</s>');
    out = out.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:#53bdeb">$1</a>');
    return out;
  }

  const timeStr = (ts) => new Date(ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const humanSize = (n) => {
    const b = Number(n) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  };

  async function api(path, { method = 'GET', body } = {}) {
    const epoch = sessionEpoch, requestToken = token;
    const res = await fetch(path, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-bridge-token': requestToken,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (epoch !== sessionEpoch || requestToken !== token) throw new Error('session changed');
    if (res.status === 401) {
      token = ''; localStorage.removeItem(TOKEN_KEY);
      showLogin('Session expired — PIN dobara daalo.');
      throw new Error('unauthorised');
    }
    const data = await res.json().catch(() => ({}));
    if (epoch !== sessionEpoch || requestToken !== token) throw new Error('session changed');
    if (!res.ok) throw new Error(data.detail || `Request failed (${res.status})`);
    return data;
  }

  // ── screens ───────────────────────────────────────────────────────────────
  function showLogin(message) {
    sessionEpoch++;
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
    const box = $('#login-error');
    if (!message) box.classList.add('hidden');
    if (message) {
      const err = $('#login-error');
      err.textContent = message;
      err.classList.remove('hidden');
    }
  }

  async function showApp() {
    const epoch = sessionEpoch;
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    renderChat();
    await refreshStatus();
    if (epoch !== sessionEpoch || !token) return;
    loadFiles();
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(refreshStatus, 15000);
  }

  // ── chat ──────────────────────────────────────────────────────────────────
  function loadChat() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CHAT_KEY) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.slice(-80).filter((m) => m && typeof m === 'object' && ['user', 'bot', 'assistant'].includes(m.role)).map((m) => ({
        ...m, text: String(m.text ?? ''), images: Array.isArray(m.images) ? m.images.filter((src) => typeof src === 'string') : [],
        documentName: String(m.documentName ?? ''), documentPath: String(m.documentPath ?? ''),
      }));
    } catch { return []; }
  }
  function saveChat(list) {
    // Screenshots are big; keep image data only for the last few messages so
    // localStorage (≈5 MB) never overflows and the app still opens instantly.
    const slim = list.slice(-80).map((m, i, arr) => (arr.length - i > 4 ? { ...m, images: [], audio: '' } : m));
    try { localStorage.setItem(CHAT_KEY, JSON.stringify(slim)); } catch {
      try { localStorage.setItem(CHAT_KEY, JSON.stringify(slim.map((m) => ({ ...m, images: [] })))); } catch { /* full */ }
    }
  }

  let chat = loadChat();

  function addMessage(role, text, extras = {}) {
    chat.push({ role, text, ts: Date.now(), images: extras.images || [], documentName: extras.documentName || '', documentPath: extras.documentPath || '' });
    saveChat(chat);
    renderChat();
  }

  function renderChat() {
    const box = $('#messages');
    box.innerHTML = '';
    if (!chat.length) {
      const hello = document.createElement('div');
      hello.className = 'msg bot';
      hello.innerHTML = waFormat('👋 *Observer Agent* — aapke PC ka control, bilkul free.\n\nTry: “screenshot bhej do”, “chrome kholo”, “wifi off”, “screen pe kya hai”, ya /help') + `<span class="time">${timeStr()}</span>`;
      box.appendChild(hello);
    }
    for (const m of chat) {
      const el = document.createElement('div');
      el.className = `msg ${m.role === 'user' ? 'user' : 'bot'}`;
      el.innerHTML = waFormat(m.text || '');
      if (m.images && m.images.length) {
        for (const src of m.images) {
          const img = document.createElement('img');
          img.src = src;
          img.alt = 'screenshot';
          img.loading = 'lazy';
          el.appendChild(img);
        }
      }
      if (m.documentName) {
        const doc = document.createElement('div');
        doc.className = 'doc';
        const name = escapeHtml(m.documentName);
        doc.innerHTML = m.documentPath
          ? `📄 <a href="/api/download?path=${encodeURIComponent(m.documentPath)}&t=${encodeURIComponent(token)}" download>${name}</a>`
          : `📄 <span>${name}</span>`;
        el.appendChild(doc);
      }
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = timeStr(m.ts);
      el.appendChild(time);
      box.appendChild(el);
    }
    box.scrollTop = box.scrollHeight;
  }

  function showTyping() {
    const box = $('#messages');
    const el = document.createElement('div');
    el.className = 'typing';
    el.id = 'typing';
    el.innerHTML = '<i></i><i></i><i></i>';
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    return el;
  }

  let pendingUpload = null; // { base64, dataUrl, mimeType, fileName, size }

  function renderPendingUpload() {
    const bar = $('#attach-preview');
    if (!bar) return;
    if (!pendingUpload) {
      bar.hidden = true;
      bar.innerHTML = '';
      return;
    }
    bar.hidden = false;
    bar.innerHTML = `<span class="chip">🧠 <b>${escapeHtml(pendingUpload.fileName)}</b> (${humanSize(pendingUpload.size)}) — Send dabao 100% verified answer ke liye!</span><button type="button" id="clear-upload" class="ghost">✕ Hatao</button>`;
    $('#clear-upload')?.addEventListener('click', () => {
      pendingUpload = null;
      if ($('#question-file')) $('#question-file').value = '';
      renderPendingUpload();
    });
  }

  function loadSelectedFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || '');
      const comma = url.indexOf(',');
      pendingUpload = {
        base64: comma >= 0 ? url.slice(comma + 1) : url,
        dataUrl: url,
        mimeType: file.type || 'image/png',
        fileName: file.name || `question-${Date.now()}.png`,
        size: file.size || 0,
      };
      renderPendingUpload();
      $('#chat-input')?.focus();
    };
    reader.readAsDataURL(file);
  }

  async function sendText(text) {
    const epoch = sessionEpoch;
    const clean = String(text || '').trim();
    if (pendingUpload) {
      const upload = pendingUpload;
      pendingUpload = null;
      if ($('#question-file')) $('#question-file').value = '';
      renderPendingUpload();
      const isImg = /^image\//i.test(upload.mimeType);
      addMessage('user', clean ? `📷 ${clean}` : `📷 *${upload.fileName}* — Solve accurately`, {
        images: isImg ? [upload.dataUrl] : [],
        documentName: isImg ? '' : upload.fileName,
      });
      $('#chat-input').value = '';
      autosize($('#chat-input'));
      const typing = showTyping();
      try {
        const data = await api('/api/solve', {
          method: 'POST',
          body: {
            imageBase64: upload.base64,
            mimeType: upload.mimeType,
            fileName: upload.fileName,
            instructions: clean,
          },
        });
        typing.remove();
        if (epoch !== sessionEpoch || !token) return;
        addMessage('bot', data.text || '✅ Solved.', { images: data.images || [] });
      } catch (err) {
        typing.remove();
        if (epoch !== sessionEpoch || !token) return;
        if (err.message !== 'unauthorised') addMessage('bot', `⚠️ ${err.message}`);
      }
      return;
    }
    if (!clean) return;
    addMessage('user', clean);
    $('#chat-input').value = '';
    autosize($('#chat-input'));
    const typing = showTyping();
    try {
      const data = await api('/api/chat', { method: 'POST', body: { text: clean } });
      typing.remove();
      if (epoch !== sessionEpoch || !token) return;
      const reply = data.text || (data.ok ? '✅ Done.' : '⚠️ Kuch gadbad ho gayi.');
      addMessage('bot', reply, {
        images: data.images || [],
        documentName: data.documentName || '',
        documentPath: data.documentPath || '',
      });
    } catch (err) {
      typing.remove();
      if (epoch !== sessionEpoch || !token) return;
      if (err.message !== 'unauthorised') addMessage('bot', `⚠️ ${err.message}`);
    }
  }

  async function refreshStatus() {
    try {
      const s = await api('/api/status');
      const online = /connected|dry-run/i.test(s.whatsapp || '');
      $('#conn').textContent = s.whatsapp || 'unknown';
      $('#dot').classList.toggle('on', online);
      renderSettings(s);
      renderQr(s);
    } catch { /* login screen handles 401 */ }
  }

  function renderSettings(s) {
    const list = $('#status-list');
    if (!list) return;
    const rows = [
      ['WhatsApp', s.whatsapp],
      ['Owner', `+${s.owner}`],
      ['Agent number', `+${s.agent}`],
      ['Access level', s.access?.level ?? '—'],
      ['Tools available', s.access?.actions ?? '—'],
      ['Shell', s.access?.shell ? 'on (PIN)' : 'off'],
      ['Observer tab', s.observerTabConnected ? 'connected' : 'not needed'],
      ['Messages', `${s.stats?.received ?? 0} in · ${s.stats?.replied ?? 0} out`],
      ['Reminders', s.reminders ?? 0],
      ['Open to-dos', s.openTodos ?? 0],
    ];
    list.innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v ?? '—'))}</dd>`).join('');

    const hList = $('#harness-list');
    if (hList && s.harness) {
      const h = s.harness;
      const hRows = [
        ['Installed', h.installed ? `Yes (${h.version || 'ready'})` : 'Pending (/dsh install)'],
        ['SDK Daemon', h.sdkRunning ? 'Warm & active' : 'Idle (auto-starts)'],
        ['Primary Mode', h.autoRoute ? 'ON (all WhatsApp msgs)' : 'Off (/dsh <task>)'],
        ['Permission', h.permissionMode || 'danger-full-access'],
        ['Model', h.selectedModel || 'auto'],
        ['Web UI', h.web?.running ? `Running (port ${h.web.port})` : 'Stopped'],
      ];
      hList.innerHTML = hRows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v ?? '—'))}</dd>`).join('');
      const autoBtn = $('#dsh-toggle-auto');
      if (autoBtn) autoBtn.textContent = h.autoRoute ? '⚡ Turn Auto Mode OFF' : '⚡ Turn Auto Mode ON';
    }
    if (s.pairingCode) {
      const card = $('#qr-card');
      card.hidden = false;
      $('#qr-number').textContent = s.agent;
    }
  }

  function renderQr(s) {
    const card = $('#qr-card');
    const img = $('#qr-img');
    if (!s.hasQr) { card.hidden = true; return; }
    card.hidden = false;
    $('#qr-number').textContent = s.agent;
    img.src = `/qr.png?t=${encodeURIComponent(token)}&_=${Date.now()}`;
  }

  // ── controls ──────────────────────────────────────────────────────────────
  const CONTROLS = [
    ['📸', 'Screenshot', '/screenshot'],
    ['🔊', 'Volume +', '/pc volume up'],
    ['🔉', 'Volume −', '/pc volume down'],
    ['🔇', 'Mute', '/pc volume mute'],
    ['⏯️', 'Play/Pause', '/pc media play'],
    ['⏭️', 'Next song', '/pc media next'],
    ['☀️', 'Bright +', '/pc brightness up'],
    ['🌙', 'Bright −', '/pc brightness down'],
    ['🔒', 'Lock PC', '/pc lock'],
    ['📶', 'Wi-Fi', '/wifi status'],
    ['🔋', 'Battery', '/pc battery'],
    ['🖥️', 'PC status', '/pc status'],
  ];
  const PC = [
    ['🏠', 'Home files', '/ls ~'],
    ['🚀', 'Apps', '/apps'],
    ['🪟', 'Windows', '/windows'],
    ['🎥', 'Record 10s', '/record 10'],
    ['📸', 'Webcam', '/webcam'],
    ['⚡', 'Processes', '/pc top'],
    ['💾', 'Disk', '/pc disk'],
    ['🌐', 'IP', '/pc ip'],
    ['📡', 'Networks', '/wifi list'],
    ['🔵', 'Bluetooth', '/bt status'],
  ];

  function renderGrids() {
    const make = (items, target) => {
      const box = $(target);
      box.innerHTML = '';
      for (const [icon, label, cmd] of items) {
        const b = document.createElement('button');
        b.className = 'ctl';
        b.innerHTML = `<b>${icon}</b><span>${label}</span>`;
        b.addEventListener('click', () => { switchTab('chat'); sendText(cmd); });
        box.appendChild(b);
      }
    };
    make(CONTROLS, '#control-grid');
    make(PC, '#pc-grid');
  }

  const CHIPS = [
    ['🚀 DSH Status', '/dsh status'],
    ['🌐 DSH Web UI', '/dsh web'],
    ['📸 Screenshot', '/screenshot'],
    ['🧠 Screen pe kya hai?', '/look screen pe kya hai'],
    ['🚀 Apps dikhao', '/apps'],
    ['📶 Wi-Fi status', '/wifi status'],
    ['🔋 Battery', '/pc battery'],
    ['🧹 Downloads', '/downloads'],
    ['❓ Help', '/help'],
  ];
  function renderChips() {
    const box = $('#chips');
    box.innerHTML = '';
    for (const [label, cmd] of CHIPS) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = label;
      b.addEventListener('click', () => sendText(cmd));
      box.appendChild(b);
    }
  }

  // ── files ─────────────────────────────────────────────────────────────────
  async function loadFiles() {
    try {
      const data = await api('/api/files');
      const downloads = $('#downloads');
      const shared = $('#shared');
      downloads.innerHTML = (data.downloads || []).length
        ? data.downloads.map((d) => fileRow(d.name || d.file, `${d.kind || 'file'} · ${timeStr(d.ts)}`, d.path)).join('')
        : '<p class="muted">Abhi kuch receive nahi hua. WhatsApp pe photo/PDF bhejo.</p>';
      shared.innerHTML = (data.shared || []).length
        ? data.shared.map((f) => fileRow(f.name, humanSize(f.size), f.path)).join('')
        : '<p class="muted">Shared folder khaali hai — PC pe <code>data/shared/</code> me files rakho.</p>';
      $$('.file button', downloads).concat($$('.file button', shared)).forEach((btn) => {
        btn.addEventListener('click', () => { switchTab('chat'); sendText(`/send ${btn.dataset.path}`); });
      });
    } catch { /* auth handled */ }
  }

  function fileRow(name, sub, path) {
    return `<div class="file">
      <span style="font-size:20px">📄</span>
      <div class="meta"><div class="name">${escapeHtml(name)}</div><div class="sub">${escapeHtml(sub || '')}</div></div>
      <button data-path="${escapeHtml(path || '')}">Send</button>
    </div>`;
  }

  // ── tabs ──────────────────────────────────────────────────────────────────
  function switchTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
    $$('.bottom-nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    if (name === 'files') loadFiles();
    if (name === 'settings') refreshStatus();
    // Screen is never polled: one frame when the tab opens, then only when
    // the owner asks (Refresh) or does something (tap/type/key).
    if (name === 'screen') loadScreen({ force: true, note: 'Screenshot on demand — koi auto polling nahi.' });
  }

  // ── remote screen ─────────────────────────────────────────────────────────
  // The phone is just another client: /api/screen returns one JPEG, /api/tap
  // clicks at a 0-1000 relative point. There is deliberately NO timer here —
  // a screenshot every 1s/5s/10s is exactly what the owner did not want (and
  // on Wayland every capture may pop the portal prompt). One frame per action,
  // one per Refresh, nothing in between.
  async function loadScreen({ force = false, note = '' } = {}) {
    if (screenBusy) return;
    screenBusy = true;
    const img = $('#screen-img');
    const status = $('#screen-status');
    try {
      const headers = {};
      if (!force && screenEtag) headers['if-none-match'] = screenEtag;
      const res = await fetch(`/api/screen?w=1280&t=${encodeURIComponent(token)}`, { headers });
      if (res.status === 401) { showLogin('Session expired — PIN dobara daalo.'); return; }
      if (res.status === 304) {
        if (status) status.textContent = `Same screen · ${timeStr()} (naya frame nahi bheja)`;
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || `Screen failed (${res.status})`);
      }
      screenEtag = res.headers.get('etag') || '';
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const previous = screenUrlLive;
      img.src = url;
      screenUrlLive = url;
      if (previous) URL.revokeObjectURL(previous);
      if (status) status.textContent = note || `${timeStr()} · tap karo wahin click hoga`;
    } catch (err) {
      if (err.message !== 'unauthorised' && status) status.textContent = err.message || 'Screen nahi aayi';
    } finally {
      screenBusy = false;
    }
  }

  async function tapAt(ev) {
    const img = $('#screen-img');
    if (!img.naturalWidth) return;
    const box = img.getBoundingClientRect();
    const rx = Math.round(((ev.clientX - box.left) / box.width) * 1000);
    const ry = Math.round(((ev.clientY - box.top) / box.height) * 1000);
    if (rx < 0 || ry < 0 || rx > 1000 || ry > 1000) return;
    const wrap = img.parentElement;
    const dot = document.createElement('span');
    dot.className = 'ripple';
    dot.style.left = `${ev.clientX - box.left}px`;
    dot.style.top = `${ev.clientY - box.top}px`;
    wrap.appendChild(dot);
    setTimeout(() => dot.remove(), 520);
    try {
      await api('/api/tap', { method: 'POST', body: { x: rx, y: ry, relative: true } });
    } catch (err) {
      $('#screen-status').textContent = err.message;
    }
    // One frame after the click: the owner must SEE what changed, otherwise
    // tapping blind. Still not a timer.
    loadScreen({ note: `${timeStr()} · tap bheja (${rx}, ${ry})` });
  }

  const KEY_BUTTONS = [
    ['Return', '⏎'], ['Escape', 'Esc'], ['Tab', 'Tab'], ['BackSpace', '⌫'],
    ['ctrl+l', 'Ctrl+L'], ['ctrl+a', 'Ctrl+A'], ['Page_Down', 'PgDn'], ['Page_Up', 'PgUp'],
  ];

  function renderKeyPad() {
    const grid = $('#key-grid');
    if (!grid || grid.dataset.ready) return;
    grid.dataset.ready = '1';
    for (const [key, label] of KEY_BUTTONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ghost';
      b.textContent = label;
      b.addEventListener('click', async () => {
        try { await api('/api/key', { method: 'POST', body: { key } }); } catch (err) { $('#screen-status').textContent = err.message; }
        loadScreen({ note: `${timeStr()} · ${label} bheja` });
      });
      grid.appendChild(b);
    }
  }

  // ── command console (Screen tab) ──────────────────────────────────────────
  // Every slash command already works through /api/chat; this is just another
  // view of it, so the owner never has to leave the screen to run /brief,
  // /usage, /watch … while looking at the PC.
  const CONSOLE_CHIPS = ['/dsh status', '/dsh web', '/help', '/brief', '/usage', '/watch list', '/undo list', '/screenshot', '/status'];

  function cmdLine(kind, text, { images = [], documentName = '', documentPath = '' } = {}) {
    const box = $('#cmd-out');
    if (!box) return null;
    if (box.dataset.placeholder !== 'gone') { box.innerHTML = ''; box.dataset.placeholder = 'gone'; }
    const line = document.createElement('div');
    line.className = `cmd-line ${kind}`;
    line.innerHTML = waFormat(text || '');
    for (const src of images) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = 'screenshot';
      line.appendChild(img);
    }
    if (documentName) {
      const doc = document.createElement('div');
      doc.innerHTML = documentPath
        ? `📄 <a href="/api/download?path=${encodeURIComponent(documentPath)}&t=${encodeURIComponent(token)}" download>${escapeHtml(documentName)}</a>`
        : `📄 ${escapeHtml(documentName)}`;
      line.appendChild(doc);
    }
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = timeStr();
    line.appendChild(time);
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
    return line;
  }

  async function runConsoleCommand(raw) {
    const text = String(raw || '').trim();
    if (!text) return;
    const input = $('#cmd-input');
    if (input) input.value = '';
    cmdLine('me', text);
    const pending = cmdLine('bot', '⏳ chal raha hai…');
    try {
      const data = await api('/api/chat', { method: 'POST', body: { text } });
      pending.remove();
      cmdLine('bot', data.text || (data.ok ? '✅ Done.' : '⚠️ Kuch gadbad ho gayi.'), {
        images: data.images || [],
        documentName: data.documentName || '',
        documentPath: data.documentPath || '',
      });
      // /screenshot, /look … change what is on the screen: show it here too.
      if (/^\/?(screenshot|shot|screen|look|ocr|tap)\b/i.test(text) || (data.images && data.images.length)) {
        loadScreen({ note: `${timeStr()} · ${text.split(' ')[0]} ke baad` });
      }
    } catch (err) {
      pending.remove();
      if (err.message !== 'unauthorised') cmdLine('bot err', `⚠️ ${err.message}`);
    }
  }

  function renderConsoleChips() {
    const box = $('#cmd-chips');
    if (!box || box.dataset.ready) return;
    box.dataset.ready = '1';
    for (const cmd of CONSOLE_CHIPS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = cmd;
      b.addEventListener('click', () => runConsoleCommand(cmd));
      box.appendChild(b);
    }
  }

  // ── JARVIS voice call ─────────────────────────────────────────────────────
  // The loop JARVIS is famous for: you speak → the API model turns it into
  // commands and executes them on the PC → JARVIS speaks the result → the mic
  // reopens by itself. Speech-to-text prefers the browser (instant, free);
  // browsers without it record WebM and the PC transcribes with Whisper.
  // Speech back is the server's real JARVIS voice (Piper/Edge/XTTS), with a
  // British browser voice as the instant fallback. Talk over him (or tap the
  // orb) and he stops mid-sentence — barge-in, like a real call.
  const Call = {
    active: false, session: '', muted: false, speaking: false, busy: false,
    rec: null, recWanted: false, stream: null, recorder: null, audioCtx: null,
    player: null, events: null, startedAt: 0, timer: null, wakeLock: null,
  };

  const orb = () => $('#orb');
  function setOrb(state, label) {
    const el = orb();
    if (el) el.className = `orb ${state}`;
    if (label != null) $('#call-state').textContent = label;
  }

  function callCaption(who, text, { interim = false, images = [] } = {}) {
    const box = $('#call-captions');
    if (!box) return null;
    box.querySelector('.cap.interim')?.remove();
    const el = document.createElement('div');
    el.className = `cap ${who}${interim ? ' interim' : ''}`;
    el.innerHTML = `<b class="who">${who === 'owner' ? 'YOU' : 'JARVIS'}</b>${waFormat(text || '')}`;
    for (const src of images) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = 'screenshot';
      el.appendChild(img);
    }
    box.appendChild(el);
    while (box.children.length > 40) box.firstChild.remove();
    box.scrollTop = box.scrollHeight;
    return el;
  }

  function pickBrowserVoice() {
    const voices = window.speechSynthesis?.getVoices?.() || [];
    const gb = voices.filter((v) => /^en[-_]GB/i.test(v.lang));
    return gb.find((v) => /ryan|george|arthur|brian|male/i.test(v.name)) || gb[0]
      || voices.find((v) => /^en[-_]/i.test(v.lang) && /male/i.test(v.name))
      || voices.find((v) => /^en[-_]/i.test(v.lang)) || voices[0] || null;
  }

  function speakInBrowser(text) {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window) || !text) return resolve();
      const utter = new SpeechSynthesisUtterance(text);
      const voice = pickBrowserVoice();
      if (voice) utter.voice = voice;
      utter.lang = voice?.lang || 'en-GB';
      utter.rate = 0.98;
      utter.pitch = 0.82; // the butler register
      utter.onend = resolve;
      utter.onerror = resolve;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utter);
    });
  }

  async function playJarvis(audioDataUrl, spokenText) {
    const useBrowser = $('#call-browser-voice')?.checked || !audioDataUrl;
    Call.speaking = true;
    setOrb('speaking', 'JARVIS bol raha hai… (rokne ke liye orb tap karo ya bolna shuru karo)');
    try {
      if (useBrowser) {
        await speakInBrowser(spokenText);
      } else {
        await new Promise((resolve) => {
          const audio = new Audio(audioDataUrl);
          Call.player = audio;
          audio.onended = resolve;
          audio.onerror = resolve;
          audio.play().catch(resolve);
        });
      }
    } finally {
      Call.speaking = false;
      Call.player = null;
      if (Call.active) setOrb('listening', 'Sun raha hoon, Sir… bolo.');
    }
  }

  function stopPlayback() {
    if (Call.player) { try { Call.player.pause(); } catch { /* done */ } Call.player = null; }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    if (Call.speaking && Call.session) {
      api('/api/call/interrupt', { method: 'POST', body: { sessionId: Call.session } }).catch(() => {});
    }
    Call.speaking = false;
    if (Call.active) setOrb('listening', 'Sun raha hoon, Sir… bolo.');
  }

  async function callSay(text) {
    const clean = String(text || '').trim();
    if (!clean || !Call.active || Call.busy) return;
    Call.busy = true;
    callCaption('owner', clean);
    setOrb('thinking', 'Samajh gaya — kaam kar raha hoon, Sir…');
    try {
      const res = await api('/api/call/say', { method: 'POST', body: { sessionId: Call.session, text: clean } });
      Call.session = res.sessionId || Call.session;
      const shown = res.text && res.text.length <= 600 ? res.text : (res.spoken || res.text || '✅ Done, Sir.');
      callCaption('jarvis', shown, { images: res.images || [] });
      if (res.awaitingConfirm) setOrb('confirming', 'Confirmation chahiye — "haan" ya "nahi" bolo.');
      await playJarvis(res.audio, res.spoken || shown);
      if (res.ended) { endCall('Call khatm. Phir milenge, Sir.'); return; }
    } catch (err) {
      if (err.message !== 'unauthorised') {
        callCaption('jarvis', `⚠️ ${err.message}`);
        await playJarvis(null, 'My apologies, Sir. Something went wrong on the computer.');
      }
    } finally {
      Call.busy = false;
      if (Call.active && !Call.muted) restartListening();
    }
  }

  // ── listening: browser SR loop ────────────────────────────────────────────
  function startSrLoop() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return false;
    const rec = new SR();
    rec.lang = $('#call-lang')?.value || 'en-IN';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (ev) => {
      let finalText = '';
      let interimText = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const piece = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalText += piece;
        else interimText += piece;
      }
      if (interimText.trim()) {
        // Owner talking over JARVIS = barge-in.
        if (Call.speaking && interimText.trim().length > 2) stopPlayback();
        callCaption('owner', interimText.trim(), { interim: true });
      }
      if (finalText.trim()) {
        $('#call-captions')?.querySelector('.cap.interim')?.remove();
        callSay(finalText.trim());
      }
    };
    rec.onerror = (ev) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        Call.recWanted = false;
        setOrb('idle', 'Mic permission nahi mili. Browser me mic allow karo, ya neeche text box use karo.');
      }
    };
    rec.onend = () => {
      // Chrome stops continuous SR every so often — quietly re-arm it.
      if (Call.active && Call.recWanted && !Call.muted && !Call.busy && !Call.speaking) {
        setTimeout(() => { try { rec.start(); } catch { /* already running */ } }, 250);
      }
    };
    Call.rec = rec;
    Call.recWanted = true;
    try { rec.start(); } catch { /* onend re-arms */ }
    return true;
  }

  // ── listening fallback: MediaRecorder + silence detection + Whisper ──────
  async function startRecorderLoop() {
    try {
      Call.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setOrb('idle', 'Mic nahi mila. Permission allow karo ya text box se bolo.');
      return false;
    }
    Call.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = Call.audioCtx.createAnalyser();
    analyser.fftSize = 512;
    Call.audioCtx.createMediaStreamSource(Call.stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const level = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += Math.abs(s - 128);
      return sum / samples.length;
    };
    const recordOnce = () => new Promise((resolve) => {
      const chunks = [];
      let mime = 'audio/webm';
      try { Call.recorder = new MediaRecorder(Call.stream); mime = Call.recorder.mimeType || mime; }
      catch { return resolve(null); }
      const rec = Call.recorder;
      let sawSpeech = false;
      let silenceMs = 0;
      const started = Date.now();
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => resolve(sawSpeech ? { blob: new Blob(chunks, { type: mime }), mime } : null);
      rec.start(200);
      const watcher = setInterval(() => {
        if (!Call.active || Call.muted || Call.busy) { clearInterval(watcher); try { rec.stop(); } catch { } return; }
        const loud = level() > 4.2;
        if (loud) {
          if (Call.speaking) stopPlayback(); // barge-in
          sawSpeech = true;
          silenceMs = 0;
        } else if (sawSpeech) silenceMs += 140;
        if ((sawSpeech && silenceMs > 1000) || Date.now() - started > 15_000) {
          clearInterval(watcher);
          try { rec.stop(); } catch { /* stopped */ }
        }
      }, 140);
    });
    (async () => {
      while (Call.active) {
        if (Call.muted || Call.busy) { await new Promise((r) => setTimeout(r, 400)); continue; }
        const clip = await recordOnce();
        if (!clip) continue;
        setOrb('thinking', 'Sun liya — samajh raha hoon…');
        try {
          const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
            reader.onerror = reject;
            reader.readAsDataURL(clip.blob);
          });
          const heard = await api('/api/call/transcribe', { method: 'POST', body: { audioBase64: base64, mimeType: clip.mime } });
          if (heard.text) await callSay(heard.text);
          else setOrb('listening', 'Kuch sunai nahi diya — phir se bolo.');
        } catch (err) {
          callCaption('jarvis', `⚠️ ${err.message}`);
          setOrb('listening', 'Sun raha hoon, Sir… bolo.');
        }
      }
    })();
    return true;
  }

  function restartListening() {
    if (!Call.active || Call.muted) return;
    if (Call.rec && Call.recWanted) { try { Call.rec.start(); } catch { /* running */ } }
    // The MediaRecorder loop self-perpetuates; nothing to do.
  }

  function stopListening() {
    Call.recWanted = false;
    try { Call.rec?.stop(); } catch { /* stopped */ }
    Call.rec = null;
    try { Call.recorder?.stop(); } catch { /* stopped */ }
    Call.stream?.getTracks().forEach((t) => t.stop());
    Call.stream = null;
    Call.audioCtx?.close().catch(() => {});
    Call.audioCtx = null;
  }

  async function startCall() {
    if (Call.active) return;
    stopPlayback();
    try {
      const res = await api('/api/call/start', { method: 'POST', body: {} });
      Call.session = res.sessionId;
      Call.active = true;
      Call.muted = false;
      Call.startedAt = Date.now();
      $('#call-start').hidden = true;
      $('#call-mute').hidden = false;
      $('#call-end').hidden = false;
      $('#call-captions').innerHTML = '';
      callCaption('jarvis', res.greeting);
      setOrb('listening', 'Line par hoon, Sir. Bolo, main sun raha hoon.');
      clearInterval(Call.timer);
      Call.timer = setInterval(() => {
        const s = Math.floor((Date.now() - Call.startedAt) / 1000);
        $('#call-timer').textContent = `⏱ ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      }, 1000);
      try { Call.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
      try {
        Call.events = new EventSource(`/api/call/events?session=${encodeURIComponent(Call.session)}&t=${encodeURIComponent(token)}`);
        Call.events.addEventListener('thinking', () => { if (!Call.speaking) setOrb('thinking', 'Kaam kar raha hoon, Sir…'); });
      } catch { /* SSE is decoration */ }
      const srOk = startSrLoop();
      if (!srOk) await startRecorderLoop();
      await playJarvis(res.audio, res.spoken || res.greeting);
      restartListening();
    } catch (err) {
      Call.active = false;
      setOrb('idle', err.message === 'unauthorised' ? 'Session khatm — PIN dobara daalo.' : `Call shuru nahi hui: ${err.message}`);
    }
  }

  function endCall(note = 'Call khatm. Kuch aur chahiye ho to main yahin hoon, Sir.') {
    if (Call.session) api('/api/call/stop', { method: 'POST', body: { sessionId: Call.session } }).catch(() => {});
    Call.active = false;
    Call.session = '';
    stopPlayback();
    stopListening();
    clearInterval(Call.timer);
    $('#call-timer').textContent = '';
    Call.events?.close();
    Call.events = null;
    try { Call.wakeLock?.release(); } catch { /* noop */ }
    $('#call-start').hidden = false;
    $('#call-mute').hidden = true;
    $('#call-end').hidden = true;
    setOrb('idle', note);
  }

  async function loadVoiceInfo() {
    try {
      const data = await api('/api/voice');
      const rows = [
        ['Voice engine', data.best || '— (setup baaki)'],
        ['Sunna (Whisper)', data.transcription ? 'ready ✅' : 'setup baaki (observer.sh voice whisper)'],
        ['WhatsApp voice mode', data.callMode ? 'ON' : 'off (/call on)'],
        ['Asli WhatsApp call', data.wavoip?.connected ? '📞 READY — call karo, JARVIS uthayega' : (data.wavoip?.hint || 'engine off')],
      ];
      const list = $('#voice-list');
      if (list) list.innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');
      const hint = $('#call-wa-hint');
      if (hint) {
        hint.textContent = data.wavoip?.connected
          ? '✅ Asli WhatsApp call READY hai — agent number pe voice call karo, JARVIS utha ke jawab dega. Niche Test se awaaz check kar lo.'
          : `Asli WhatsApp call: ${data.wavoip?.hint || 'engine off'}. Tab tak WhatsApp call par JARVIS voice-note line milegi, aur ye Call tab hamesha kaam karta hai.`;
      }
    } catch { /* login handles 401 */ }
  }

  async function testJarvisVoice(btn) {
    btn.disabled = true;
    btn.textContent = '⏳ JARVIS bol raha hai…';
    try {
      const res = await fetch('/api/voice/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bridge-token': token },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.audio) {
        await new Promise((resolve) => {
          const audio = new Audio(data.audio);
          audio.onended = resolve;
          audio.onerror = resolve;
          audio.play().catch(resolve);
        });
      } else if (data.speakInBrowser) {
        await speakInBrowser(data.speakInBrowser);
        alert(`PC pe JARVIS voice setup baaki hai, isliye browser ki awaaz sunai di.\n\n${data.detail || ''}`);
      } else {
        alert(data.detail || 'Voice test fail hua.');
      }
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '▶ Test JARVIS Voice';
    }
  }

  function wireCallUi() {
    $('#call-start')?.addEventListener('click', startCall);
    $('#call-end')?.addEventListener('click', () => {
      if (Call.session) callSay('goodbye jarvis').catch(() => endCall());
      else endCall();
      // callSay ends the UI on the farewell; this is the safety net.
      setTimeout(() => { if (Call.active && !Call.speaking) endCall(); }, 6000);
    });
    $('#call-mute')?.addEventListener('click', (e) => {
      Call.muted = !Call.muted;
      e.target.textContent = Call.muted ? '🔇 Unmute' : '🎤 Mute';
      if (Call.muted) { try { Call.rec?.stop(); } catch { /* stopped */ } setOrb('listening', 'Mic band hai. Unmute karo jab bolna ho.'); }
      else restartListening();
    });
    orb()?.addEventListener('click', () => {
      if (!Call.active) { startCall(); return; }
      if (Call.speaking) stopPlayback();
    });
    $('#call-text-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('#call-text');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      if (!Call.active) await startCall();
      callSay(text);
    });
    $('#call-lang')?.addEventListener('change', () => { if (Call.rec) { try { Call.rec.stop(); } catch { } Call.rec = null; if (Call.active) startSrLoop(); } });
    $('#voice-test')?.addEventListener('click', (e) => testJarvisVoice(e.target));
    $('#voice-callmode')?.addEventListener('click', async () => {
      const data = await api('/api/voice').catch(() => ({}));
      switchTab('chat');
      await sendText(data.callMode ? '/call off' : '/call on');
      loadVoiceInfo();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && Call.active) { /* keep call alive; SR may pause, onend re-arms on return */ }
      else if (!document.hidden && Call.active) restartListening();
    });
  }

  // ── input helpers ─────────────────────────────────────────────────────────
  function autosize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }

  // ── boot ──────────────────────────────────────────────────────────────────
  function boot() {
    renderGrids();
    renderChips();
    renderChat();

    // token from private dashboard URL (?t=…) → store and clean the address bar
    const params = new URLSearchParams(location.search);
    if (params.get('t')) {
      token = params.get('t'); sessionEpoch++;
      localStorage.setItem(TOKEN_KEY, token);
      history.replaceState(null, '', location.pathname);
    }

    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const loginEpoch = sessionEpoch;
      const pin = $('#pin').value.trim();
      if (!pin) return;
      const err = $('#login-error');
      err.classList.add('hidden');
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pin }),
        });
        const data = await res.json().catch(() => ({}));
        if (loginEpoch !== sessionEpoch) return;
        if (!res.ok || !data.token) throw new Error(data.detail || 'Wrong PIN');
        token = data.token; sessionEpoch++;
        localStorage.setItem(TOKEN_KEY, token);
        $('#pin').value = '';
        showApp();
      } catch (e2) {
        if (loginEpoch !== sessionEpoch) return;
        err.textContent = e2.message;
        err.classList.remove('hidden');
      }
    });

    $('#chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      sendText($('#chat-input').value);
    });
    if ($('#attach-question')) {
      $('#attach-question').addEventListener('click', () => $('#question-file')?.click());
    }
    if ($('#question-file')) {
      $('#question-file').addEventListener('change', (e) => {
        const f = e.target.files?.[0];
        if (f) loadSelectedFile(f);
      });
    }
    // Support pasting a screenshot straight from clipboard (`Ctrl+V`) OR dragging a file onto Chat!
    window.addEventListener('paste', (e) => {
      const items = [...(e.clipboardData?.items || [])];
      const imgItem = items.find((i) => i.type?.startsWith('image/'));
      if (imgItem) {
        const file = imgItem.getAsFile();
        if (file) {
          switchTab('chat');
          loadSelectedFile(file);
        }
      }
    });
    const chatTab = $('#tab-chat');
    if (chatTab) {
      chatTab.addEventListener('dragover', (e) => { e.preventDefault(); });
      chatTab.addEventListener('drop', (e) => {
        e.preventDefault();
        const f = e.dataTransfer?.files?.[0];
        if (f) loadSelectedFile(f);
      });
    }
    $('#chat-input').addEventListener('input', (e) => autosize(e.target));
    $('#chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && window.innerWidth > 700) {
        e.preventDefault();
        sendText(e.target.value);
      }
    });

    $$('.bottom-nav button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    renderKeyPad();
    renderConsoleChips();
    if ($('#cmd-form')) $('#cmd-form').addEventListener('submit', (e) => {
      e.preventDefault();
      runConsoleCommand($('#cmd-input').value);
    });
    if ($('#cmd-clear')) $('#cmd-clear').addEventListener('click', () => {
      const box = $('#cmd-out');
      box.innerHTML = '<p class="muted small">Abhi kuch nahi chalaya.</p>';
      delete box.dataset.placeholder;
    });
    const screenImg = $('#screen-img');
    if (screenImg) {
      screenImg.addEventListener('click', tapAt);
      // A broken screenshot (no desktop / PC locked) must say so, not show a
      // broken-image icon forever.
      screenImg.addEventListener('error', () => {
        const status = $('#screen-status');
        if (status) status.textContent = 'Screen nahi aayi — PC unlocked hai? /doctor chalao.';
      });
      screenImg.addEventListener('load', () => {
        const status = $('#screen-status');
        if (status) status.textContent = '';
      });
    }
    if ($('#screen-refresh')) $('#screen-refresh').addEventListener('click', () => loadScreen({ force: true, note: `${timeStr()} · refresh` }));
    if ($('#type-form')) $('#type-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('#type-text');
      const text = input.value;
      if (!text) return;
      try {
        await api('/api/type', { method: 'POST', body: { text } });
        input.value = '';
      } catch (err) {
        $('#screen-status').textContent = err.message;
      }
      loadScreen({ note: `${timeStr()} · type bheja` });
    });
    $('#files-refresh').addEventListener('click', loadFiles);
    $('#file-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const p = $('#file-path').value.trim();
      if (!p) return;
      $('#file-path').value = '';
      switchTab('chat');
      sendText(`/send ${p}`);
    });
    if ($('#dsh-open-web')) $('#dsh-open-web').addEventListener('click', async () => {
      const btn = $('#dsh-open-web');
      btn.disabled = true;
      btn.textContent = '⏳ Starting DSH Web UI…';
      try {
        const out = await api('/api/harness/web', { method: 'POST', body: { action: 'start' } });
        const ws = out.web || {};
        const parsed = new URL(ws.localUrl || 'http://127.0.0.1:3080/');
        const tok = parsed.searchParams.get('token') || '';
        let targetHref = ws.localUrl;
        if (location.hostname.endsWith('.e2b.app') && ws.remotePort) {
          targetHref = `${location.protocol}//${location.host.replace(/^\d+-/, `${ws.remotePort}-`)}/?token=${encodeURIComponent(tok)}`;
        } else if (!['127.0.0.1', 'localhost'].includes(location.hostname) && ws.remotePort) {
          targetHref = `${location.protocol}//${location.hostname}:${ws.remotePort}/?token=${encodeURIComponent(tok)}`;
        }
        window.open(targetHref, '_blank', 'noopener');
        await refreshStatus();
      } catch (err) {
        alert(`Could not launch DeepSeek Harness Web UI: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = '🌐 Open Official DSH Web UI';
      }
    });
    if ($('#dsh-toggle-auto')) $('#dsh-toggle-auto').addEventListener('click', async () => {
      const s = await api('/api/status').catch(() => ({}));
      const next = s.harness?.autoRoute ? 'off' : 'on';
      switchTab('chat');
      await sendText(`/dsh auto ${next}`);
      await refreshStatus();
    });
    if ($('#dsh-install-btn')) $('#dsh-install-btn').addEventListener('click', async () => {
      switchTab('chat');
      await sendText('/dsh install');
      await refreshStatus();
    });

    $('#logout').addEventListener('click', () => {
      localStorage.removeItem(TOKEN_KEY);
      token = '';
      if (statusTimer) clearInterval(statusTimer);
      chat = []; pendingUpload = null; renderPendingUpload();
      if ($('#question-file')) $('#question-file').value = '';
      saveChat(chat);
      showLogin();
    });

    // Coming back to the tab shows one fresh frame (the screen may have moved
    // while the phone was locked) — still event-driven, never a timer.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && $('#tab-screen')?.classList.contains('active')) {
        loadScreen({ force: true, note: 'Wapas aaye — ek fresh frame.' });
      }
    });

    // browser dictation (free, built into Chrome/Android; hidden if unsupported)
    // For a full two-way voice conversation use the 📞 Call tab — this button
    // is one-shot dictation into the chat box.
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) $('#mic').style.display = 'none';
    else $('#mic').addEventListener('click', () => {
      const rec = new SR();
      rec.lang = $('#call-lang')?.value || 'en-IN';
      rec.interimResults = true;
      $('#mic').textContent = '🔴';
      rec.onresult = (ev) => {
        let finalText = '';
        let interimText = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          if (ev.results[i].isFinal) finalText += ev.results[i][0].transcript;
          else interimText += ev.results[i][0].transcript;
        }
        $('#chat-input').value = finalText || interimText;
        autosize($('#chat-input'));
        if (finalText.trim()) sendText(finalText.trim());
      };
      rec.onend = () => { $('#mic').textContent = '🎤'; };
      rec.onerror = () => { $('#mic').textContent = '🎤'; };
      rec.start();
    });

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      installEvent = e;
      $('#install').hidden = false;
    });
    $('#install').addEventListener('click', async () => {
      if (!installEvent) return;
      installEvent.prompt();
      await installEvent.userChoice;
      installEvent = null;
      $('#install').hidden = true;
    });

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    if (token) showApp();
    else showLogin();
  }

  boot();
})();
