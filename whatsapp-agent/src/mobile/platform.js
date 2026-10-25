import path from 'node:path';
import os from 'node:os';
import { createDevices } from './devices.js';
import { createEvents } from './events.js';
import { createJobs } from './jobs.js';
import { createWorkspaces } from './workspaces.js';
import { createWorkflows } from './workflows.js';
import { createRTC } from './rtc.js';
import { createAssets } from './assets.js';
import { createDiscovery } from './discovery.js';
import { createPush } from './push.js';
import { createUpdateChannel } from './update.js';
import { readAudit } from '../audit.js';
import { error } from './records.js';
export function privateIPv4(ip) {
  const a = ip.split('.').map(Number); return a.length === 4 && a.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) && (a[0] === 10 || a[0] === 192 && a[1] === 168 || a[0] === 172 && a[1] >= 16 && a[1] <= 31 || a[0] === 100 && a[1] >= 64 && a[1] <= 127);
}
export function pairingOrigin(raw) {
  let u; try { u = new URL(raw); } catch { throw error(400, 'Valid bridge origin required'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/' || /^(localhost|127\.|\[?::1)/i.test(u.hostname) || u.protocol === 'http:' && !privateIPv4(u.hostname)) throw error(400, 'Use HTTPS or a private LAN/VPN IP origin, without credentials/path');
  return u.origin;
}
export function createMobilePlatform({ config, app, runOwner, voice, normalise, solve, now = Date.now, pushFetch } = {}) {
  const root = config.dataDir ? path.join(config.dataDir, 'mobile') : null;
  const file = (name) => root ? path.join(root, name) : null;
  // The audit trail follows DATA_DIR like every other store, so a relocated
  // agent keeps one log instead of silently starting a second one.
  const auditFile = () => path.join(config.dataDir, 'audit.jsonl');
  const devices = createDevices({ file: file('devices.json'), now });
  let push;
  try { push = createPush({ credentialsFile: config.appFcmCredentials || null, targets: () => devices.pushTargets(), fetchImpl: pushFetch, now }); }
  catch { push = { status: () => ({ configured: false, provider: 'fcm', error: 'Private PC push credentials could not be loaded; other mobile features remain available.' }), send: async () => ({ configured: false }) }; }
  const events = createEvents({ file: file('events.json'), now, push: (event) => push.send({ ...event, serverId: devices.serverId }) });
  const assets = createAssets({ dir: root ? path.join(root, 'assets') : null, now });
  const projects = createWorkspaces({ file: file('projects.json'), now });
  const workflows = createWorkflows({ file: file('workflows.json'), now, timezone: config.timezone || 'Asia/Kolkata', runOwner, pending: () => Boolean(app?.state?.().pending?.length) });
  const rtc = createRTC({ now });
  const updates = createUpdateChannel({ dir: file('updates'), currentNative: () => config.packageVersion || '' });
  const discovery = createDiscovery({ file: file('discovery.json'), host: config.host, port: config.port, serverId: devices.serverId, version: config.appVersion || '3.10.0', enabled: Boolean(config.appDiscovery) });
  let timer = null, lastApproval = '';
  const jobs = createJobs({ file: file('jobs.json'), now, events, busy: () => app?.busy?.() || false, run: async (input, context) => {
    let reply;
    if (input.kind === 'solve') { if (!solve) throw error(503, 'Upload solver unavailable'); reply = await solve(input); }
    else if (input.kind === 'workflow') reply = await workflows.run(input.text, context.cancelled);
    else if (input.kind === 'voice') {
      if (!voice) throw error(503, 'PC voice engine unavailable');
      const result = await voice.say(input.sessionId, input.text, { source: 'app' });
      reply = { ...result, awaitingConfirm: Boolean(result.awaitingConfirm || app?.state?.().pending?.length), extraImages: result.images, audio: result.audio?.buffer, mimetype: result.audio?.mimetype };
    } else {
      const project = input.kind === 'reference' ? { id: 'reference00', name: 'Shared reference', privateChat: true, memories: [] } : input.projectId ? projects.get(input.projectId) : null;
      reply = await runOwner(input.text, { source: 'app', isOwner: true, appHistory: input.history, readOnlyReference: input.kind === 'reference', ...(project?.privateChat ? { mobileProject: project } : {}) });
    }
    if (reply == null && context.cancelled()) return { ok: false, stopped: true, text: 'Stopped. Already-started actions may still have finished; inspect before repeating.' };
    return assets.shape(reply, normalise);
  } });
  const removeStop = app?.onStop?.(() => { if (jobs.active) jobs.requestStop(jobs.active); });
  const capabilities = () => ({ jobs: true, durableJobs: Boolean(root), deviceSessions: true, qrPairing: true, events: true, privateAlerts: true, push: push.status(), workspaces: true, workflows: true, rtc: true, protocol: 2 });
  return {
    devices, events, jobs, projects, workflows, rtc, assets, discovery, updates, capabilities,
    controlsAllowed: () => Boolean(config.allowPcControl),
    /** Read-only audit entries, newest first. Never writes, never truncates. */
    auditEntries(limit = 40) {
      const wanted = Math.min(200, Math.max(1, Number(limit) || 40));
      return readAudit({ file: auditFile(), limit: wanted }).reverse();
    },
    diagnostics() { return { serverId: devices.serverId, capabilities: capabilities(), port: config.port, host: config.host, addresses: Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal && privateIPv4(n.address)).map((n) => n.address), loopbackOnly: config.host === '127.0.0.1', pcControl: Boolean(config.allowPcControl), note: 'Reachability cannot be proven from the PC alone. No firewall, permission or router settings were changed.' }; },
    start() {
      if (timer) return;
      discovery.start().catch(() => {});
      timer = setInterval(() => {
        try {
          const pending = app?.state?.().pending || [], key = pending.map((p) => p.id).join(',');
          // The approval id travels with the event so the phone can act on that
          // exact request from the notification; the PC still re-checks it.
          if (key && key !== lastApproval) events.publish('approval', 'Your PC has an exact action waiting for review.', { approvalId: pending[pending.length - 1].id });
          lastApproval = key;
          for (const due of workflows.scheduled()) {
            workflows.markScheduled(due.id, due.day); // Commit the day BEFORE dispatch; no catch-up/replay after restart.
            if (jobs.active || app?.busy?.() || pending.length) { events.publish('routine_missed', 'A scheduled workflow was not started because the agent was busy or awaiting approval.'); continue; }
            jobs.submit({ id: `routine_${due.id}_${due.day.replaceAll('-', '')}`, kind: 'workflow', text: due.id }, { id: 'scheduler-owner', name: 'Owner schedule' });
          }
        } catch { /* Surface storage/API errors to callers; never retry an action from this timer. */ }
      }, 15_000); timer.unref?.();
    },
    stop() { clearInterval(timer); jobs.close(); discovery.close(); removeStop?.(); rtc.close(); events.clear(); devices.clear(); },
  };
}
