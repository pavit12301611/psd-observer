// PC-side WebRTC publisher. No remote page ever receives a privileged WebView bridge.
let token = '', stream = null, timer = null, running = false;
const peers = new Map(), $ = (s) => document.querySelector(s);
const problem = (e) => { $('#error').textContent = e?.message || String(e); };
async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-bridge-token': token }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', redirect: 'error' });
  const data = await r.json(); if (!r.ok) throw Error(data.detail || `HTTP ${r.status}`); return data;
}
function closePeers() { for (const p of peers.values()) p.pc.close(); peers.clear(); }
async function stop() {
  running = false; clearTimeout(timer); closePeers(); stream?.getTracks().forEach((t) => t.stop()); stream = null; $('#preview').srcObject = null;
  $('#stop').disabled = true; $('#share').disabled = false; $('#status').textContent = 'Sharing stopped. No capture is armed.';
  if (token) await api('/api/app/rtc/publisher', { op: 'stop' }).catch(() => {});
}
async function loop() {
  if (!running) return;
  try {
    const data = await api('/api/app/rtc/publisher', { op: 'heartbeat' });
    for (const [id, p] of peers) if (!data.sessions.some((s) => s.id === id)) { p.pc.close(); peers.delete(id); }
    for (const s of data.sessions) {
      let p = peers.get(s.id);
      if (!p) {
        const pc = new RTCPeerConnection({ iceServers: [] }); p = { pc, remote: false, candidateCount: 0, pending: [] }; peers.set(s.id, p);
        const policy = { saver: [960, 540, 6], balanced: [1280, 720, 15], quality: [1920, 1080, 24] }[s.quality];
        const track = stream.getVideoTracks()[0]; await track.applyConstraints({ width: { ideal: policy[0] }, height: { ideal: policy[1] }, frameRate: { ideal: policy[2], max: policy[2] } }).catch(() => {});
        pc.addTrack(track, stream); pc.onicecandidate = (e) => { if (e.candidate) p.pending.push(e.candidate.toJSON()); };
        const offer = await pc.createOffer(); await pc.setLocalDescription(offer); await api('/api/app/rtc/' + s.id, { description: { type: 'offer', sdp: offer.sdp } });
      }
      if (s.answer && !p.remote) { await p.pc.setRemoteDescription(s.answer); p.remote = true; }
      if (p.remote) for (const c of s.viewerCandidates.slice(p.candidateCount)) { await p.pc.addIceCandidate(c).catch(() => {}); p.candidateCount++; }
      if (p.pending.length) await api('/api/app/rtc/' + s.id, { candidates: p.pending.splice(0, 20) });
    }
    $('#status').textContent = data.sessions.length ? `Live viewer: ${data.sessions[0].viewerName}. Requested ${data.sessions[0].quality} quality. No recording.` : 'Screen capture armed; no live viewer connected. Stop sharing to release capture.';
  } catch (e) { problem(e); await stop(); return; }
  if (running) timer = setTimeout(loop, 900);
}
$('#login').addEventListener('submit', async (e) => {
  e.preventDefault(); try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: $('#pin').value }), cache: 'no-store', redirect: 'error' }); const data = await r.json(); if (!r.ok) throw Error(data.detail);
    token = data.token; $('#pin').value = ''; $('#login').hidden = true; $('#controls').hidden = false;
    const diag = await api('/api/app/diagnostics'); if (diag.addresses[0]) $('#origin').value = `http://${diag.addresses[0]}:${diag.port}`;
  } catch (e) { problem(e); }
});
$('#share').addEventListener('click', async () => {
  try {
    if (!navigator.mediaDevices?.getDisplayMedia) throw Error('Screen capture needs this page on the PC at localhost or verified HTTPS.');
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 6, max: 24 } }, audio: false });
    stream.getVideoTracks()[0].addEventListener('ended', () => void stop()); $('#preview').srcObject = stream;
    await api('/api/app/rtc/publisher', { op: 'start' }); running = true; $('#share').disabled = true; $('#stop').disabled = false; void loop();
  } catch (e) { problem(e); stream?.getTracks().forEach((t) => t.stop()); stream = null; }
});
$('#stop').addEventListener('click', () => void stop());
$('#pair-code').addEventListener('click', async () => { try { const code = await api('/api/app/pair-code', { origin: $('#origin').value }); $('#qr').src = code.qr; $('#qr').hidden = false; } catch (e) { problem(e); } });
window.addEventListener('pagehide', () => { running = false; clearTimeout(timer); closePeers(); stream?.getTracks().forEach((t) => t.stop()); });
