import { randomBytes } from 'node:crypto';
import { error } from './records.js';
export function createRTC({ now = Date.now } = {}) {
  let publisher = null; const sessions = new Map();
  function expire() {
    if (publisher && now() - publisher.seen > 90_000) publisher = null;
    for (const [id, s] of sessions) if (!publisher || now() - s.viewerSeen > 25_000 || now() - s.created > 30 * 60_000) sessions.delete(id);
  }
  return {
    publisher(principal, op) {
      expire();
      if (principal.kind !== 'owner') throw error(403, 'Unlock the PC publisher with the owner dashboard PIN.');
      if (op === 'stop') { if (publisher && publisher.id !== principal.id && principal.kind !== 'owner') throw error(403, 'Another publisher owns this capture'); publisher = null; sessions.clear(); }
      else if (op === 'start') { if (publisher && publisher.id !== principal.id) throw error(409, 'A PC publisher is already sharing'); publisher = { id: principal.id, seen: now() }; }
      else if (op === 'heartbeat') { if (!publisher || publisher.id !== principal.id) throw error(409, 'Start a new explicit screen share'); publisher.seen = now(); }
      else throw error(400, 'Invalid publisher operation');
      return { ready: Boolean(publisher), sessions: [...sessions.values()].map((s) => structuredClone(s)) };
    },
    status() { expire(); return { ready: Boolean(publisher), active: sessions.size, transport: 'webrtc', internetRelayConfigured: false }; },
    create(principal, quality) {
      expire(); if (principal.kind !== 'device') throw error(403, 'Use a revocable paired device for the live viewer.'); if (!publisher) throw error(409, 'Open the PC sharing page and explicitly choose a screen first');
      if (sessions.size >= 1) throw error(409, 'One live viewer at a time. Stop the current view first.');
      if (!['saver', 'balanced', 'quality'].includes(quality)) throw error(400, 'Invalid video quality');
      const id = randomBytes(16).toString('hex'); sessions.set(id, { id, deviceId: principal.id, viewerName: principal.name || 'Owner', quality, created: now(), viewerSeen: now(), offer: null, answer: null, publisherCandidates: [], viewerCandidates: [] });
      return { id, iceServers: [], quality };
    },
    signal(id, principal, body = null) {
      expire(); const s = sessions.get(id); if (!s) throw error(410, 'Screen share ended or expired');
      const isPublisher = publisher?.id === principal.id;
      if (s.deviceId !== principal.id && !isPublisher && principal.kind !== 'owner') throw error(403, 'This stream belongs to another device');
      if (!isPublisher) s.viewerSeen = now();
      if (body?.end) { sessions.delete(id); return { ended: true }; }
      if (body) {
        if (body.description) {
          const { type, sdp } = body.description;
          if (typeof sdp !== 'string' || sdp.length > 64_000 || type !== (isPublisher ? 'offer' : 'answer')) throw error(400, 'Invalid bounded session description');
          s[isPublisher ? 'offer' : 'answer'] = { type, sdp };
        }
        if (body.candidates) {
          if (!Array.isArray(body.candidates) || body.candidates.length > 20) throw error(400, 'Too many ICE candidates');
          const key = isPublisher ? 'publisherCandidates' : 'viewerCandidates';
          for (const c of body.candidates) {
            if (!c || typeof c.candidate !== 'string' || c.candidate.length > 2500 || c.sdpMid != null && typeof c.sdpMid !== 'string' || c.sdpMLineIndex != null && !Number.isInteger(c.sdpMLineIndex)) throw error(400, 'Invalid ICE candidate');
            s[key].push({ candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null });
          }
          s[key] = s[key].slice(-80);
        }
      }
      return structuredClone(s);
    },
    revokeDevice(id) { for (const [key, session] of sessions) if (session.deviceId === id) sessions.delete(key); },
    close() { publisher = null; sessions.clear(); },
  };
}
