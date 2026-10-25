// updates.js — "updated!" message after every real update.
//
// The owner should never have to guess whether an update landed or what it
// changed. On startup we compare the running version with the last version we
// announced, and if it moved we send one WhatsApp message:
//
//     🔄 Observer updated · 2.6.0 → 2.7.0 · 1m 42s
//     Kya naya: /stop, screen vision, ...
//
// Where "what changed" comes from, best first:
//   1. release-notes.json in the install (shipped with the code)
//   2. the BUILD-LOG.md heading for that version
//   3. package.json description
// And "how long" comes from data/last-update.json, which observer.sh writes
// while updating (data/ survives updates, so the marker is still there when
// the new process starts).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const NOTES_FILE = path.join(ROOT, 'release-notes.json');
const BUILD_LOG = path.join(ROOT, 'BUILD-LOG.md');
const PKG_FILE = path.join(ROOT, 'package.json');

/** "1m 42s", "8.4s", "0s" — short on purpose (WhatsApp line). */
export function humanSeconds(total) {
  const n = Math.max(0, Math.round(Number(total) || 0));
  if (n < 60) return `${n}s`;
  const m = Math.floor(n / 60);
  const s = n % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function loadReleaseNotes(file = NOTES_FILE) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export function packageVersion(file = PKG_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Bullets for a version from BUILD-LOG.md: everything up to the first blank
 * line after `## <version> —` (headings and bold lines only, trimmed).
 * Used when release-notes.json has no entry (older/newer builds).
 */
export function bulletsFromBuildLog(version, file = BUILD_LOG) {
  if (!version) return [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${version.replace(/\./g, '\\.')}\\b`).test(l.trim()));
  if (start === -1) return [];
  const heading = lines[start].replace(/^##\s+/, '').replace(new RegExp(`^${version.replace(/\./g, '\\.')}\\s*[—-]\\s*`), '').trim();
  const out = [];
  const title = heading.replace(/\*/g, '');
  for (let i = start + 1; i < lines.length && out.length < 4; i++) {
    const line = lines[i].trim();
    if (/^##\s/.test(line)) break; // next version
    if (!line || /^```/.test(line) || /^---$/.test(line)) continue;
    const bullet = line.match(/^[-*]\s+(.*)$/);
    const source = bullet ? bullet[1] : line;
    const cleaned = source.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
    if (cleaned.length >= 12) out.push(cleaned.slice(0, 150));
  }
  return title && title.length < 90 ? [`**${title}**`, ...out].slice(0, 4) : out.slice(0, 4);
}

/** What to show for `version` — release notes first, BUILD-LOG second. */
export function changesFor(version, notes = loadReleaseNotes()) {
  const entry = notes?.[version];
  if (entry && Array.isArray(entry.bullets) && entry.bullets.length) {
    return entry.title ? [`*${entry.title}*`, ...entry.bullets] : [...entry.bullets];
  }
  const fromLog = bulletsFromBuildLog(version);
  if (fromLog.length) return fromLog;
  try {
    const desc = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8')).description;
    if (desc) return [desc];
  } catch { /* no package.json: nothing to add */ }
  return [];
}

/** data/last-update.json — written by observer.sh before it restarts us. */
export function readUpdateMarker(dataDir) {
  if (!dataDir) return null;
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dataDir, 'last-update.json'), 'utf8'));
    return marker && typeof marker === 'object' ? marker : null;
  } catch {
    return null;
  }
}

export function clearUpdateMarker(dataDir) {
  if (!dataDir) return;
  try {
    fs.rmSync(path.join(dataDir, 'last-update.json'), { force: true });
  } catch { /* not fatal */ }
}

/** The WhatsApp message itself. Pure on purpose (easy to test). */
export function buildUpdateMessage({ from, to, seconds, changes = [], brains, app = null }) {
  const head = from && from !== to
    ? `🔄 *Observer updated* · ${from} → ${to}${Number.isFinite(seconds) ? ` · ${humanSeconds(seconds)}` : ''}`
    : `🔄 *Observer updated* · ${to || '?'}${Number.isFinite(seconds) ? ` · ${humanSeconds(seconds)}` : ''}`;
  const lines = [head, ''];
  if (changes.length) {
    lines.push('*Kya naya:*');
    // 1 title line + 6 bullets; the biggest changes must survive the cut.
    for (const change of changes.slice(0, 7)) lines.push(`• ${change}`);
  } else {
    lines.push('_Release notes nahi mile — /help se naye commands dekho._');
  }
  if (brains?.text) lines.push('', brains.text);
  // The phone app rides the same update: a signed web bundle is already
  // waiting on this PC, so paired phones install it themselves.
  if (app?.version) {
    lines.push('', `📱 *Phone app ${app.version}* bhi ready hai — Observer app kholo, update apne aap install ho jayega (APK install ki zaroorat nahi).`);
  }
  lines.push('', '_Purani settings, WhatsApp login aur data sab waise hi hain._');
  return lines.join('\n');
}

/**
 * Send the update message once per version. Returns { sent, text, reason }.
 *
 * `send` is a function (text) => Promise. Tests pass a fake; the app passes
 * whatsapp.sendToOwner.
 */
export async function announceUpdate({
  config = {}, store, log = console, send, version = packageVersion(),
  notes = loadReleaseNotes(), marker = readUpdateMarker(config.dataDir),
  brains = null,
} = {}) {
  if (!store?.data || !version) return { sent: false, reason: 'no store/version' };
  const markerForThis = marker && (!marker.to || marker.to === version) ? marker : null;
  // An install that predates this messenger has no store.lastVersion, but
  // observer.sh left a marker for THIS version — so we still know what it
  // moved from and can send the "updated" message the first time too.
  const fromMarker = markerForThis?.from && markerForThis.from !== version ? markerForThis.from : null;
  const previous = store.data.lastVersion ?? fromMarker;
  const brainIds = Array.isArray(brains?.ids) ? [...brains.ids].sort() : null;
  const prevBrains = Array.isArray(store.data.lastBrainIds) ? [...store.data.lastBrainIds].sort() : null;

  // First ever run: remember silently (nobody wants a "what's new" on install).
  if (!previous) {
    store.data.lastVersion = version;
    if (brainIds) store.data.lastBrainIds = brainIds;
    store.save?.();
    return { sent: false, reason: 'first run' };
  }

  const versionChanged = previous !== version;
  const brainsChanged = Boolean(brainIds && prevBrains && brainIds.join() !== prevBrains.join());
  if (!versionChanged && !brainsChanged) return { sent: false, reason: 'unchanged' };

  const seconds = markerForThis ? Number(markerForThis.seconds) : NaN;
  const changes = versionChanged ? changesFor(version, notes) : [];

  let brainText = null;
  if (brainsChanged) {
    const added = brainIds.filter((id) => !prevBrains.includes(id));
    const removed = prevBrains.filter((id) => !brainIds.includes(id));
    const bits = [];
    if (added.length) bits.push(`+${added.length} naya`);
    if (removed.length) bits.push(`-${removed.length} hata`);
    brainText = `🧠 *Brains:* ${bits.join(', ') || 'badle'} (${brainIds.length} active) — /brains`;
  } else if (brains?.text) {
    brainText = brains.text;
  }

  const text = buildUpdateMessage({
    from: previous,
    to: version,
    seconds,
    changes,
    app: markerForThis?.app && markerForThis.app.version ? markerForThis.app : null,
    brains: brainText ? { text: brainText } : null,
  });

  if (typeof send !== 'function') {
    store.data.lastVersion = version;
    if (brainIds) store.data.lastBrainIds = brainIds;
    store.save?.();
    return { sent: false, text, reason: 'no send function' };
  }
  try {
    await send(text);
  } catch (err) {
    // Do NOT remember this version: the next connect tries again, so an update
    // announced while WhatsApp was still offline is not silently lost.
    log?.warn?.(`[update] announcement failed: ${err.message}`);
    return { sent: false, text, reason: `send failed: ${err.message}` };
  }
  store.data.lastVersion = version;
  if (brainIds) store.data.lastBrainIds = brainIds;
  store.save?.();
  clearUpdateMarker(config.dataDir);
  log?.info?.(`[update] announced ${previous} → ${version}${Number.isFinite(seconds) ? ` in ${humanSeconds(seconds)}` : ''}`);
  return { sent: true, text, reason: versionChanged ? 'version' : 'brains' };
}

/** Brain catalogue summary for /status and the update message. */
export function brainSummary(catalog = []) {
  const ids = catalog.map((m) => m.id).filter(Boolean);
  const local = catalog.filter((m) => m.local).length;
  const vision = catalog.filter((m) => m.vision).length;
  return {
    ids,
    text: `🧠 *Brains:* ${catalog.length} (${local} local, ${vision} vision) — /brains`,
  };
}
