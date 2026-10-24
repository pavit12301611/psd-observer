import { previewWorkflow } from './workflows.js';
import { pairingOrigin } from './platform.js';
import QRCode from 'qrcode';

/** Only called AFTER owner/device authentication. */
export async function mobileRoute({ req, res, url, principal, platform: p, json, body, runOwner }) {
  const route = `${req.method} ${url.pathname}`;
  if (url.pathname.startsWith('/api/app/rtc') && !p.controlsAllowed()) { json(res,403,{detail:'PC capture/control is disabled by owner policy.'}); return true; }
  if (route === 'GET /api/app/update/status') { json(res, 200, { ...p.updates.status(), installed: null }); return true; }
  if (route === 'GET /api/app/update/key') { json(res, 200, p.updates.key()); return true; }
  if (route === 'GET /api/app/update/manifest') {
    const manifest = p.updates.manifest(), signature = p.updates.signature(), key = p.updates.key();
    if (!manifest || !signature) { json(res, 404, { detail: 'No signed web update has been packed on this PC yet.' }); return true; }
    json(res, 200, { manifest, signature, keyId: key.keyId }); return true;
  }
  if (route === 'GET /api/app/update/bundle') {
    const manifest = p.updates.manifest(), bundle = p.updates.bundle();
    if (!manifest || !bundle) { json(res, 404, { detail: 'No verified signed web update is available.' }); return true; }
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': bundle.length, 'cache-control': 'no-store', 'x-update-version': manifest.version, 'x-update-sha256': manifest.sha256, 'content-disposition': 'attachment; filename="observer-web-update.zip"' });
    res.end(bundle); return true;
  }
  if (route === 'GET /api/app/discovery') { json(res, 200, p.discovery.status()); return true; }
  if (route === 'POST /api/app/discovery') { json(res, 200, await p.discovery.set((await body(req)).enabled)); return true; }
  if (route === 'GET /api/app/diagnostics') { json(res, 200, p.diagnostics()); return true; }
  if (route === 'GET /api/app/devices') { json(res, 200, { devices: p.devices.list(), currentId: principal.id, legacySession: principal.kind === 'owner' }); return true; }
  if (route === 'POST /api/app/devices/revoke') { const b = await body(req); const result = p.devices.revoke(b.id); p.rtc.revokeDevice(b.id); p.events.publish('device_revoked', 'A paired device was revoked.'); json(res, 200, result); return true; }
  if (route === 'POST /api/app/devices/push') { if (principal.kind !== 'device') { json(res, 403, { detail: 'Pair this app with a per-device session first' }); return true; } const b = await body(req); json(res, 200, p.devices.push(principal.id, b.token)); return true; }
  if (route === 'POST /api/app/pair-code') {
    const b = await body(req), code = p.devices.code(pairingOrigin(b.origin));
    const payload = 'observer-companion://pair?payload=' + Buffer.from(JSON.stringify(code)).toString('base64url');
    json(res, 200, { ...code, payload, qr: await QRCode.toDataURL(payload, { width: 320, margin: 2, color: { dark: '#000000', light: '#ffffff' } }) }); return true;
  }
  if (route === 'GET /api/app/jobs') { json(res, 200, { jobs: p.jobs.list() }); return true; }
  if (route === 'POST /api/app/jobs') { const result = p.jobs.submit(await body(req), principal); json(res, result.existing ? 200 : 202, result.job); return true; }
  if (/^\/api\/app\/jobs\/[a-zA-Z0-9_-]{8,100}$/.test(url.pathname)) {
    const id = url.pathname.split('/').pop();
    if (req.method === 'GET') { const job = p.jobs.get(id); json(res, job ? 200 : 404, job || { detail: 'No retained record for that ID. Nothing was replayed. Inspect before submitting a new request.' }); return true; }
  }
  if (route === 'POST /api/app/jobs/stop') { const b = await body(req); const job = p.jobs.requestStop(b.id); const reply = await runOwner('/stop'); json(res, 200, { job, text: typeof reply === 'string' ? reply : reply?.text || 'Stop requested; inspect the settled outcome.' }); return true; }
  if (/^\/api\/app\/assets\/[a-f0-9]{32}$/.test(url.pathname) && req.method === 'GET') {
    const data = p.assets.get(url.pathname.split('/').pop());
    if (!data) json(res, 404, { detail: 'Private attachment expired or was evicted' });
    else { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length, 'content-disposition': 'attachment', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(data); }
    return true;
  }
  if (route === 'GET /api/app/events') { json(res, 200, { ...p.events.status(), events: p.events.list(url.searchParams.get('after')) }); return true; }
  if (route === 'GET /api/app/events/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`event: ready\ndata: ${JSON.stringify(p.events.status())}\n\n`);
    for (const event of p.events.list(url.searchParams.get('after'))) res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    const off = p.events.on((event) => { try { if (principal.kind === 'device' && p.devices.list().find((d) => d.id === principal.id)?.revokedAt) { res.end(); return; } res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`); } catch { /* gone */ } });
    const tick = setInterval(() => { try { if (principal.kind === 'device' && p.devices.list().find((d) => d.id === principal.id)?.revokedAt) return res.end(); res.write(': heartbeat\n\n'); } catch { /* gone */ } }, 20_000); tick.unref?.();
    res.on('close', () => { clearInterval(tick); off(); }); return true;
  }
  if (route === 'GET /api/app/projects') { json(res, 200, { projects: p.projects.list() }); return true; }
  if (route === 'POST /api/app/projects') { json(res, 200, p.projects.save(await body(req))); return true; }
  if (route === 'POST /api/app/projects/delete') { json(res, 200, p.projects.remove((await body(req)).id)); return true; }
  if (route === 'GET /api/app/workflows') { json(res, 200, { workflows: p.workflows.list() }); return true; }
  if (route === 'POST /api/app/workflows/preview') { json(res, 200, previewWorkflow(await body(req))); return true; }
  if (route === 'POST /api/app/workflows') { json(res, 200, p.workflows.save(await body(req))); return true; }
  if (route === 'POST /api/app/workflows/delete') { json(res, 200, p.workflows.remove((await body(req)).id)); return true; }
  if (route === 'GET /api/app/rtc') { json(res, 200, p.rtc.status()); return true; }
  if (route === 'POST /api/app/rtc/publisher') { json(res, 200, p.rtc.publisher(principal, (await body(req)).op)); return true; }
  if (route === 'POST /api/app/rtc/session') { json(res, 200, p.rtc.create(principal, (await body(req)).quality || 'saver')); return true; }
  if (/^\/api\/app\/rtc\/[a-f0-9]{32}$/.test(url.pathname)) {
    if (req.method === 'GET' || req.method === 'POST') { json(res, 200, p.rtc.signal(url.pathname.split('/').pop(), principal, req.method === 'POST' ? await body(req) : null)); return true; }
  }
  return false;
}
