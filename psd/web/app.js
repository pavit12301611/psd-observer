// app.js — the PSD client. No build step, no framework, ~600 lines.
//
// Talks to the same HTTP API the notch and curl use. Auth: token from
// localStorage, or the ?token= query the PC prints on first boot.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
/**
 * On phones the app is served by a tiny reverse proxy (scripts/psd-phone-proxy.mjs)
 * that adds the token and the Origin header, so the phone never has to store a
 * secret and PSD keeps refusing anonymous browsers.
 */
const proxied = () => document.documentElement.dataset.proxied === '1';
const store = {
  get token() { return proxied() ? '' : (localStorage.getItem('psd.token') || ''); },
  set token(value) { value ? localStorage.setItem('psd.token', value) : localStorage.removeItem('psd.token'); },
  get url() { return proxied() ? '' : (localStorage.getItem('psd.url') || location.origin).replace(/\/+$/, ''); },
  set url(value) { value ? localStorage.setItem('psd.url', value.replace(/\/+$/, '')) : localStorage.removeItem('psd.url'); },
};

const params = new URLSearchParams(location.search);
if (params.get('token')) {
  store.token = params.get('token');
  params.delete('token');
  history.replaceState(null, '', `${location.pathname}${params.toString() ? `?${params}` : ''}`);
}

const state = {
  thread: 'chat',
  sending: false,
  controller: null,
  system: null,
};

/** Fetch with auth + a friendly error shape. */
async function api(path, { method = 'GET', body = null, timeout = 130_000, signal = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeout);
  signal?.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  try {
    const res = await fetch(`${store.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(store.token ? { 'x-psd-token': store.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { text }; }
    if (res.status === 401) { showSheet(true); throw new Error('Token required'); }
    if (res.status === 403) { showSheet(true); throw new Error(data?.detail || 'This origin is not allowed to talk to PSD'); }
    if (!res.ok) throw new Error(data?.detail || data?.error || `HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ── ui helpers ─────────────────────────────────────────────────────────────
let toastTimer = 0;
function toast(message, tone = '') {
  const node = $('#toast');
  node.textContent = message;
  node.dataset.tone = tone;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
}

function showSheet(force = false) {
  // A saved-but-wrong token must still be able to reopen this: otherwise a
  // rejected token leaves a blank app with no way back in.
  if (!force && (store.token || proxied())) return;
  $('#conn-url').value = store.url;
  $('#conn-token').value = '';
  $('#sheet-conn').classList.remove('hidden');
  $('#conn-error').textContent = '';
}

function selectView(name) {
  $$('.view').forEach((view) => view.classList.toggle('is-active', view.dataset.view === name));
  $$('.tab').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.view === name));
  if (name === 'system') refreshStatus();
  if (name === 'agents') loadAgents();
  if (name === 'more') loadMemory();
  if (name === 'files') loadFiles($('#files-path').value || '~');
}

// ── chat ───────────────────────────────────────────────────────────────────
function scrollThread() {
  const thread = $('#thread');
  thread.scrollTop = thread.scrollHeight;
}

function hideHello() {
  const hello = $('#hello');
  if (hello) hello.remove();
}

function addMessage(role, text, meta = {}) {
  hideHello();
  const node = document.createElement('div');
  node.className = `msg ${role}${meta.error ? ' error' : ''}`;
  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = text;
  node.appendChild(body);
  if (meta.streaming) {
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    body.appendChild(cursor);
  }
  if (meta.images?.length) {
    for (const image of meta.images) {
      const img = document.createElement('img');
      img.src = image.startsWith('data:') ? image : `data:image/png;base64,${image}`;
      img.alt = 'screenshot from the PC';
      node.appendChild(img);
    }
  }
  if (role === 'agent' && (meta.path || meta.tools?.length || meta.ms)) {
    const bar = document.createElement('div');
    bar.className = 'meta';
    if (meta.path) {
      const path = document.createElement('span');
      path.className = 'path';
      path.textContent = meta.path;
      bar.appendChild(path);
    }
    for (const tool of (meta.tools ?? []).slice(0, 4)) {
      const chip = document.createElement('span');
      chip.className = 'tool';
      chip.textContent = tool;
      bar.appendChild(chip);
    }
    if (meta.ms) {
      const ms = document.createElement('span');
      ms.textContent = meta.ms < 1000 ? `${meta.ms} ms` : `${(meta.ms / 1000).toFixed(1)} s`;
      bar.appendChild(ms);
    }
    node.appendChild(bar);
  }
  $('#thread').appendChild(node);
  scrollThread();
  return { node, body };
}

function typingNode() {
  const node = document.createElement('div');
  node.className = 'msg agent';
  node.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  $('#thread').appendChild(node);
  scrollThread();
  return node;
}

async function send(text) {
  const value = String(text ?? $('#input').value ?? '').trim();
  if (!value || state.sending) return;
  addMessage('user', value);
  $('#input').value = '';
  autoGrow();
  setSending(true);

  const placeholder = typingNode();
  let agentNode = null;
  let buffer = '';

  try {
    state.controller = new AbortController();
    const res = await fetch(`${store.url}/psd/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(store.token ? { 'x-psd-token': store.token } : {}) },
      body: JSON.stringify({ text: value, source: 'web', thread: state.thread }),
      signal: state.controller.signal,
    });
    if (res.status === 401) { showSheet(); throw new Error('Token required'); }
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let done = null;

    while (true) {
      const { value: chunk, done: finished } = await reader.read();
      if (finished) break;
      pending += decoder.decode(chunk, { stream: true });
      const blocks = pending.split('\n\n');
      pending = blocks.pop() ?? '';
      for (const block of blocks) {
        const eventLine = block.split('\n').find((l) => l.startsWith('event:'));
        const dataLine = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!eventLine || !dataLine) continue;
        const event = eventLine.slice(6).trim();
        let payload = {};
        try { payload = JSON.parse(dataLine); } catch { continue; }

        if (event === 'token') {
          if (placeholder.isConnected) placeholder.remove();
          buffer += payload.text ?? '';
          if (!agentNode) agentNode = addMessage('agent', '', { streaming: true });
          agentNode.body.textContent = buffer;
          const cursor = document.createElement('span');
          cursor.className = 'cursor';
          agentNode.body.appendChild(cursor);
          scrollThread();
        } else if (event === 'image') {
          if (placeholder.isConnected) placeholder.remove();
          if (!agentNode) agentNode = addMessage('agent', buffer, {});
          const img = document.createElement('img');
          img.src = `data:image/png;base64,${payload.image}`;
          img.alt = 'screenshot from the PC';
          agentNode.node.appendChild(img);
          scrollThread();
        } else if (event === 'done') {
          done = payload;
        } else if (event === 'error') {
          throw new Error(payload.detail || 'Stream failed');
        }
      }
    }

    if (placeholder.isConnected) placeholder.remove();
    if (agentNode?.node.isConnected) agentNode.node.remove();
    const finalText = done?.text ?? buffer;
    addMessage('agent', finalText || '(no reply)', {
      path: done?.path, tools: done?.toolsUsed, ms: done?.ms,
      images: done?.image ? [done.image] : [],
    });
    if (done?.needsConfirmation) toast('Waiting for your approval — send /approve ' + done.approvalId, '');
  } catch (err) {
    if (placeholder.isConnected) placeholder.remove();
    if (err.name === 'AbortError') addMessage('agent', 'Stopped.', { path: 'cancelled' });
    else addMessage('agent', `Could not reach PSD: ${err.message}`, { error: true, path: 'network' });
  } finally {
    state.controller = null;
    setSending(false);
    refreshStatus({ silent: true });
  }
}

function setSending(value) {
  state.sending = value;
  $('#btn-send').disabled = value;
  $('#btn-stop').classList.toggle('hidden', !value);
  $('#hint-line').textContent = value ? 'working…' : '⏎ send · ⇧⏎ newline';
}

function autoGrow() {
  const input = $('#input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(132, input.scrollHeight)}px`;
}

// ── status ─────────────────────────────────────────────────────────────────
function ring(id, percent, tone = '') {
  const node = $(id);
  if (!node) return;
  const clamped = Math.max(0, Math.min(100, percent ?? 0));
  node.style.strokeDashoffset = String(327 - (327 * clamped) / 100);
  if (tone) node.dataset.tone = tone; else delete node.dataset.tone;
}

function fillKv(id, rows) {
  const node = $(id);
  if (!node) return;
  node.innerHTML = '';
  for (const [key, value] of rows) {
    if (value === undefined || value === null || value === '') continue;
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = String(value);
    dd.title = String(value);
    node.append(dt, dd);
  }
}

const seconds = (value) => {
  const s = Number(value) || 0;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

async function refreshStatus({ silent = false } = {}) {
  try {
    const data = await api('/psd/status');
    state.system = data;
    const brain = data.brain ?? {};
    const label = brain.model ? String(brain.model).split(':')[0] : (brain.healthy ? 'model' : 'intents');
    $('#brain-label').textContent = label;
    $('#pill-brain .dot').dataset.state = brain.healthy ? 'ok' : 'idle';
    $('#pill-brain').title = brain.brains.map((b) => `${b.id}: ${b.ok ? b.model || 'ok' : b.error}`).join('\n');

    const notchOk = data.surfaces?.notch?.available;
    const waOk = data.surfaces?.whatsapp?.linked;
    $('#surface-label').textContent = `notch ${notchOk ? 'on' : 'off'} · wa ${waOk ? 'on' : 'off'}`;
    const glyph = $('#pill-surfaces svg');
    if (glyph) glyph.style.opacity = notchOk || waOk ? 1 : 0.4;

    const sys = data.system ?? {};
    $('#val-cpu').textContent = sys.cpu == null ? '—' : `${sys.cpu}%`;
    ring('#ring-cpu', sys.cpu, sys.cpu > 85 ? 'bad' : sys.cpu > 65 ? 'warn' : '');
    $('#val-mem').textContent = sys.mem == null ? '—' : `${sys.mem}%`;
    ring('#ring-mem', sys.mem, sys.mem > 88 ? 'bad' : sys.mem > 70 ? 'warn' : '');
    if (sys.battery?.percent != null) {
      $('#val-battery').textContent = `${sys.battery.percent}%`;
      ring('#ring-battery', sys.battery.percent, sys.battery.percent < 15 ? 'bad' : '');
      $('#val-battery-state').textContent = sys.battery.status.toLowerCase();
    } else {
      $('#val-battery').textContent = 'AC';
      ring('#ring-battery', 100);
      $('#val-battery-state').textContent = 'no battery';
    }

    fillKv('#kv-system', [
      ['host', data.host], ['kernel', sys.kernel], ['ip', sys.ip],
      ['load', (sys.load ?? []).join(' / ')], ['uptime', seconds(sys.uptime ?? data.uptimeSec)],
    ]);
    fillKv('#kv-brain', [
      ['active', brain.active ?? 'none'], ['model', brain.model ?? '—'],
      ['latency', brain.deepLatencyMs ? `${brain.deepLatencyMs} ms` : 'not measured'],
    ]);
    const brains = $('#brains');
    brains.innerHTML = '';
    for (const entry of brain.brains ?? []) {
      const row = document.createElement('div');
      row.className = 'brain-row';
      row.dataset.ok = String(Boolean(entry.ok));
      const name = document.createElement('span');
      name.textContent = `${entry.id} · ${entry.ok ? entry.model || 'ready' : 'offline'}`;
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = entry.ok ? entry.kind : (entry.error ?? '').slice(0, 22);
      row.append(name, tag);
      brains.appendChild(row);
    }

    fillKv('#kv-surfaces', [
      ['notch', notchOk ? 'connected' : (data.surfaces?.notch?.lastError || 'not running')],
      ['notch bus', data.surfaces?.notch?.bus],
      ['whatsapp', data.surfaces?.whatsapp?.whatsapp ?? 'unknown'],
      ['agent line', data.surfaces?.whatsapp?.agent],
      ['queued', data.surfaces?.whatsapp?.queued ? `${data.surfaces.whatsapp.queued} message(s)` : ''],
      ['web', data.surfaces?.web?.url],
    ]);
    fillKv('#kv-health', [
      ['version', data.version], ['access', `${data.access?.level} · ${data.access?.tools} tools`],
      ['shell', data.access?.shell ? 'on' : 'off'],
      ['turns', data.stats?.turns], ['tools run', data.stats?.tools],
      ['reminders', data.reminders], ['approvals', (data.pending ?? []).length],
      ['skills', (data.skills ?? []).length],
    ]);
    $('#foot-version').textContent = data.version ?? '1.0';
    $('#hint-line').textContent = state.sending ? 'working…' : '⏎ send · ⇧⏎ newline';
  } catch (err) {
    if (!silent) toast(err.message, 'bad');
    $('#pill-brain .dot').dataset.state = 'bad';
    $('#brain-label').textContent = 'offline';
  }
}

// ── files ──────────────────────────────────────────────────────────────────
async function loadFiles(target) {
  const list = $('#files-list');
  list.innerHTML = '<div class="empty">reading…</div>';
  $('#files-path').value = target;
  $('#files-crumb').textContent = target;
  try {
    const result = await api('/psd/tool', { method: 'POST', body: { tool: 'list_dir', args: { path: target } } });
    if (!result.ok) throw new Error(result.text);
    const lines = String(result.text).split('\n').slice(1).filter(Boolean);
    list.innerHTML = '';
    if (!lines.length) {
      list.innerHTML = '<div class="empty">empty folder</div>';
      return;
    }
    for (const line of lines) {
      const isDir = line.startsWith('📁');
      const name = line.replace(/^📁|^📄/, '').replace(/\s*\([^)]*\)$/, '').replace(/\/(?=\s*$)/, '').trim();
      const size = line.match(/\(([^)]+)\)$/)?.[1] ?? '';
      const row = document.createElement('button');
      row.className = 'row';
      row.innerHTML = `<span class="glyph">${isDir ? '▸' : '·'}</span><span class="name"></span><span class="sub"></span>`;
      row.querySelector('.name').textContent = name;
      row.querySelector('.sub').textContent = size;
      row.onclick = () => isDir
        ? loadFiles(target.replace(/\/+$/, '') === '~' ? `~/${name}` : `${target.replace(/\/+$/, '')}/${name}`)
        : readFile(target.replace(/\/+$/, '') === '~' ? `~/${name}` : `${target.replace(/\/+$/, '')}/${name}`);
      list.appendChild(row);
    }
  } catch (err) {
    list.innerHTML = `<div class="empty">${err.message}</div>`;
  }
}

async function readFile(path) {
  try {
    const result = await api('/psd/tool', { method: 'POST', body: { tool: 'read_file', args: { path, max_bytes: 4000 } } });
    if (!result.ok) throw new Error(result.text);
    addMessage('agent', `${path}\n\n${result.text}`, { path: 'file' });
    selectView('chat');
  } catch (err) { toast(err.message, 'bad'); }
}

// ── agents, memory ─────────────────────────────────────────────────────────
async function loadAgents() {
  const wrap = $('#agents-cards');
  wrap.innerHTML = '<div class="empty">loading…</div>';
  try {
    const data = await api('/psd/agents');
    wrap.innerHTML = '';
    $('#agents-count').textContent = `${data.agents.length} agents · ${data.skills.length} skills`;
    const agentCard = document.createElement('article');
    agentCard.className = 'card';
    agentCard.innerHTML = '<h3>Agents</h3>';
    for (const agent of data.agents) {
      const row = document.createElement('div');
      row.className = 'brain-row';
      row.innerHTML = `<span></span><span class="tag">agent</span>`;
      row.firstChild.textContent = `${agent.name} — ${agent.description || 'no description'}`;
      agentCard.appendChild(row);
    }
    wrap.appendChild(agentCard);
    const skillCard = document.createElement('article');
    skillCard.className = 'card';
    skillCard.innerHTML = '<h3>Skills</h3>';
    for (const skill of data.skills) {
      const row = document.createElement('div');
      row.className = 'brain-row';
      row.innerHTML = `<span></span><span class="tag"></span>`;
      row.firstChild.textContent = `${skill.name} — ${skill.description}`;
      row.lastChild.textContent = (skill.tags ?? []).slice(0, 2).join(' · ') || 'skill';
      skillCard.appendChild(row);
    }
    wrap.appendChild(skillCard);
  } catch (err) {
    wrap.innerHTML = `<div class="empty">${err.message}</div>`;
  }
}

async function loadMemory() {
  const reminders = $('#reminders-list');
  const facts = $('#memory-list');
  try {
    const data = await api('/psd/memory');
    $('#reminders-count').textContent = `${data.reminders.length} pending`;
    reminders.innerHTML = '';
    if (!data.reminders.length) reminders.innerHTML = '<div class="empty">nothing scheduled</div>';
    for (const reminder of data.reminders) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = '<span class="glyph">⏰</span><span class="name"></span><span class="sub"></span>';
      row.querySelector('.name').textContent = reminder.text;
      row.querySelector('.sub').textContent = new Date(reminder.at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      reminders.appendChild(row);
    }
    facts.innerHTML = '';
    if (!data.facts.length) facts.innerHTML = '<div class="empty">nothing remembered yet — say “remember: my editor is neovim”</div>';
    for (const fact of data.facts) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = '<span class="glyph">·</span><span class="name"></span><span class="sub"></span>';
      row.querySelector('.name').textContent = fact.key;
      row.querySelector('.sub').textContent = fact.value;
      facts.appendChild(row);
    }
    $('#set-url').value = store.url;
    $('#set-token').value = store.token ? '••••••••' : '';
  } catch (err) {
    reminders.innerHTML = `<div class="empty">${err.message}</div>`;
  }
}

// ── voice input ────────────────────────────────────────────────────────────
function voice() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) { toast('This browser has no speech recognition', 'bad'); return; }
  const recognition = new Recognition();
  recognition.lang = 'en-IN';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  const button = $('#btn-mic');
  button.classList.add('recording');
  recognition.onresult = (event) => {
    const text = event.results[0][0].transcript;
    $('#input').value = text;
    autoGrow();
    send(text);
  };
  recognition.onerror = () => toast('Voice input failed', 'bad');
  recognition.onend = () => button.classList.remove('recording');
  recognition.start();
}

// ── wiring ─────────────────────────────────────────────────────────────────
function bind() {
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => selectView(tab.dataset.view)));
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-send]');
    if (target) { send(target.dataset.send); selectView('chat'); }
    const viewTarget = event.target.closest('[data-view]');
    if (viewTarget && !viewTarget.classList.contains('tab')) selectView(viewTarget.dataset.view);
  });

  $('#btn-send').addEventListener('click', () => send());
  $('#btn-stop').addEventListener('click', () => state.controller?.abort(new Error('stopped')));
  $('#btn-mic').addEventListener('click', voice);
  $('#input').addEventListener('input', autoGrow);
  $('#input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
  });

  $('#btn-refresh-system').addEventListener('click', () => refreshStatus());
  $('#btn-probe').addEventListener('click', async () => {
    toast('probing every brain…');
    try { await api('/psd/probe', { method: 'POST' }); await refreshStatus(); toast('probe done'); }
    catch (err) { toast(err.message, 'bad'); }
  });
  $('#btn-wa-test').addEventListener('click', async () => {
    try {
      const result = await api('/psd/whatsapp', { method: 'POST', body: { text: '✅ PSD online — notch, phone and WhatsApp are wired to the same agent.' } });
      toast(result.ok ? 'sent on WhatsApp' : `not sent: ${result.error}`, result.ok ? '' : 'bad');
    } catch (err) { toast(err.message, 'bad'); }
  });

  $('#btn-files-go').addEventListener('click', () => loadFiles($('#files-path').value.trim() || '~'));
  $('#files-path').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') loadFiles($('#files-path').value.trim() || '~');
  });

  $('#btn-save-conn').addEventListener('click', saveConnection);
  $('#btn-conn-save').addEventListener('click', saveConnection);
  $('#btn-forget').addEventListener('click', () => {
    store.token = '';
    store.url = '';
    toast('signed out');
    showSheet();
  });

  window.addEventListener('online', () => refreshStatus({ silent: true }));
  setInterval(() => { if (!document.hidden) refreshStatus({ silent: true }); }, 20_000);
}

async function saveConnection() {
  const url = ($('#conn-url').value || $('#set-url').value || '').trim();
  const token = ($('#conn-token').value || $('#set-token').value || '').trim();
  if (url) store.url = url;
  if (token && !token.startsWith('•')) store.token = token;
  try {
    await api('/psd/status', { timeout: 8000 });
    $('#sheet-conn').classList.add('hidden');
    toast('connected');
    refreshStatus({ silent: true });
  } catch (err) {
    $('#conn-error').textContent = err.message;
    toast(err.message, 'bad');
  }
}

bind();
if (!store.token && !proxied()) showSheet();
else refreshStatus({ silent: true });
navigator.serviceWorker?.register?.('/sw.js')?.catch?.(() => {});
