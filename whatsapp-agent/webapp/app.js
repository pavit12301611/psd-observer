/* Observer Agent — phone app shell (vanilla JS, no build step).
   Talks only to this PC's local bridge; the token is the credential. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const TOKEN_KEY = 'observer-agent-token';
  const CHAT_KEY = 'observer-agent-chat';

  let token = localStorage.getItem(TOKEN_KEY) || '';
  let statusTimer = null;
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
    const res = await fetch(path, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-bridge-token': token,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      showLogin('Session expired — PIN dobara daalo.');
      throw new Error('unauthorised');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `Request failed (${res.status})`);
    return data;
  }

  // ── screens ───────────────────────────────────────────────────────────────
  function showLogin(message) {
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
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    renderChat();
    await refreshStatus();
    loadFiles();
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(refreshStatus, 15000);
  }

  // ── chat ──────────────────────────────────────────────────────────────────
  function loadChat() {
    try { return JSON.parse(localStorage.getItem(CHAT_KEY) || '[]'); } catch { return []; }
  }
  function saveChat(list) {
    // Screenshots are big; keep image data only for the last few messages so
    // localStorage (≈5 MB) never overflows and the app still opens instantly.
    const slim = list.slice(-80).map((m, i, arr) => (arr.length - i > 4 ? { ...m, images: [] } : m));
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

  async function sendText(text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    addMessage('user', clean);
    $('#chat-input').value = '';
    autosize($('#chat-input'));
    const typing = showTyping();
    try {
      const data = await api('/api/chat', { method: 'POST', body: { text: clean } });
      typing.remove();
      const reply = data.text || (data.ok ? '✅ Done.' : '⚠️ Kuch gadbad ho gayi.');
      addMessage('bot', reply, {
        images: data.images || [],
        documentName: data.documentName || '',
        documentPath: data.documentPath || '',
      });
    } catch (err) {
      typing.remove();
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
      token = params.get('t');
      localStorage.setItem(TOKEN_KEY, token);
      history.replaceState(null, '', location.pathname);
    }

    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
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
        if (!res.ok || !data.token) throw new Error(data.detail || 'Wrong PIN');
        token = data.token;
        localStorage.setItem(TOKEN_KEY, token);
        $('#pin').value = '';
        showApp();
      } catch (e2) {
        err.textContent = e2.message;
        err.classList.remove('hidden');
      }
    });

    $('#chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      sendText($('#chat-input').value);
    });
    $('#chat-input').addEventListener('input', (e) => autosize(e.target));
    $('#chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && window.innerWidth > 700) {
        e.preventDefault();
        sendText(e.target.value);
      }
    });

    $$('.bottom-nav button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    $('#files-refresh').addEventListener('click', loadFiles);
    $('#file-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const p = $('#file-path').value.trim();
      if (!p) return;
      $('#file-path').value = '';
      switchTab('chat');
      sendText(`/send ${p}`);
    });
    $('#logout').addEventListener('click', () => {
      localStorage.removeItem(TOKEN_KEY);
      token = '';
      if (statusTimer) clearInterval(statusTimer);
      chat = [];
      saveChat(chat);
      showLogin();
    });

    // browser dictation (free, built into Chrome/Android; hidden if unsupported)
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) $('#mic').style.display = 'none';
    else $('#mic').addEventListener('click', () => {
      const rec = new SR();
      rec.lang = 'hi-IN';
      rec.interimResults = false;
      rec.onresult = (ev) => {
        const text = ev.results[0][0].transcript;
        $('#chat-input').value = text;
        autosize($('#chat-input'));
        sendText(text);
      };
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
