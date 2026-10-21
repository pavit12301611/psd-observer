#!/usr/bin/env node
/**
 * patch-voip-engine.mjs — make the experimental baileys-caller engine answer
 * inbound WhatsApp calls at all.
 *
 * The problem (proven from a real machine's journal + sandbox WASM runs):
 * the WhatsApp Web VoIP WASM *buffers* an inbound offer as a "pending call"
 * ("Recording call offer received") and waits for the host to report which
 * calls are ongoing via `checkOngoingCalls(callIds, callCreatorJids)`. Only
 * then does it engage: it sends `<lobby>` to `<callId>@call`, processes the
 * offer in the lobby, sends `<preaccept>`, and promotes the call to ACTIVE —
 * which is what the library's deferred `acceptCall()` polls for. baileys-caller
 * (as of upstream main 574f666) never calls `checkOngoingCalls`, so every
 * inbound call rings out with `accept_timeout` / WASM status 670007, and the
 * caller's RelayLatency stanzas are dropped as "no active call".
 *
 * This patcher applies three small, guarded text patches to the installed
 * engine's dist files:
 *   1. `wasm-engine.mjs` — expose a `checkOngoingCalls()` wrapper.
 *   2. `index.mjs` — call it for every inbound offer, right before the
 *      `incoming` event fires (the offer is already recorded by then).
 *   3. `signaling.mjs` — stanzas the WASM addresses to the call room
 *      (`<callId>@call`, e.g. `<lobby>`) must keep that address; the bridge
 *      otherwise rewrites them to the peer's bare JID (`<callId>@s.whatsapp.net`)
 *      and the server never promotes the call.
 *
 * Idempotent (marker comments), syntax-verified after writing (originals are
 * restored on any failure), and safe to run on every install/update: if the
 * upstream dist layout ever changes so an anchor is missing, it reports that
 * and changes nothing.
 *
 * Usage: node scripts/patch-voip-engine.mjs <engineDir> [<engineDir> ...]
 * Exit codes: 0 ok (patched/already), 2 anchor missing somewhere, 1 hard error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MARKER = 'observer-patch: check-ongoing-calls v1';

function patchWasmEngine(src) {
  const anchor = '    getCallInfo = () => {';
  if (!src.includes(anchor)) return null;
  const insertion = `    /* ${MARKER} */
    checkOngoingCalls = (callIds, callCreatorJids) => {
        if (!this.#instance || typeof this.#instance.checkOngoingCalls !== "function")
            return;
        const ids = this.#makeStringList(Array.isArray(callIds) ? callIds : []);
        const creators = this.#makeStringList(Array.isArray(callCreatorJids) ? callCreatorJids : []);
        try {
            this.#instance.checkOngoingCalls(ids, creators);
        }
        finally {
            ids?.delete?.();
            creators?.delete?.();
        }
    };
`;
  return src.replace(anchor, insertion + anchor);
}

function patchIndex(src) {
  const anchor = '        this.emit("incoming", call, { isVideo, isGroup, peerJid });';
  if (!src.includes(anchor)) return null;
  const insertion = `        /* ${MARKER} — the WASM buffers the offer as a pending call and only
           engages it (lobby -> preaccept -> active) once the host reports the
           call as ongoing. Without this, answer() polls an offer that never
           promotes and every inbound call dies with accept_timeout. */
        try {
            this.#engine?.checkOngoingCalls?.([callId], [peerJid]);
        }
        catch { }
`;
  return src.replace(anchor, insertion + anchor);
}

function patchSignaling(src) {
  const anchorA = '        const effectivePeerJid = this.#resolveOutboundPeerJid(callId, peerJid);';
  const anchorB = `        const routeTo = isGroupOffer
            ? \`\${callId}@call\`
            : (signalingTag !== "offer" && signalingTag !== "enc_rekey")
                ? this.#toBareJid(effectivePeerJid)
                : this.#toCallDeviceJid(effectivePeerJid);`;
  if (!src.includes(anchorA) || !src.includes(anchorB)) return null;
  let out = src.replace(anchorA, `        /* ${MARKER} — stanzas the WASM addresses to the call room
           (\`<callId>@call\`, e.g. <lobby>) must keep that address. Resolving them
           to the peer device / bare JID misroutes them (#toBareJid even rewrites
           the server part to s.whatsapp.net), and the call is never promoted. */
        const isCallRoomPeer = String(peerJid ?? "").endsWith("@call");
        const effectivePeerJid = isCallRoomPeer ? peerJid : this.#resolveOutboundPeerJid(callId, peerJid);`);
  out = out.replace(anchorB, `        const routeTo = isCallRoomPeer
            ? effectivePeerJid
            : isGroupOffer
                ? \`\${callId}@call\`
                : (signalingTag !== "offer" && signalingTag !== "enc_rekey")
                    ? this.#toBareJid(effectivePeerJid)
                    : this.#toCallDeviceJid(effectivePeerJid);`);
  return out;
}

const FILES = [
  ['wasm-engine.mjs', patchWasmEngine],
  ['index.mjs', patchIndex],
  ['signaling.mjs', patchSignaling],
];

function syntaxOk(file) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  return res.status === 0;
}

/**
 * Patch one installed engine copy (the dir containing dist/).
 * @returns {{dir:string, state:'patched'|'already'|'anchor-missing'|'absent', files:string[]}}
 */
export function patchEngineDir(dir, log = console.log) {
  const dist = path.join(dir, 'dist');
  if (!fs.existsSync(path.join(dist, 'index.mjs'))) {
    return { dir, state: 'absent', files: [] };
  }
  const done = [];
  let newlyPatched = 0;
  let anyMissing = false;
  for (const [name, fn] of FILES) {
    const file = path.join(dist, name);
    if (!fs.existsSync(file)) { anyMissing = true; continue; }
    const original = fs.readFileSync(file, 'utf8');
    if (original.includes(MARKER)) { done.push(name); continue; }
    const next = fn(original);
    if (next === null) { anyMissing = true; continue; }
    fs.writeFileSync(file, next);
    if (!syntaxOk(file)) {
      fs.writeFileSync(file, original); // never leave a broken engine behind
      throw new Error(`patched ${file} failed node --check; original restored`);
    }
    done.push(name);
    newlyPatched += 1;
    log(`   🔩 engine patch applied: ${path.join('dist', name)}`);
  }
  if (anyMissing) return { dir, state: 'anchor-missing', files: done };
  return { dir, state: newlyPatched > 0 ? 'patched' : 'already', files: done };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dirs = process.argv.slice(2);
  if (!dirs.length) {
    console.error('usage: node scripts/patch-voip-engine.mjs <engineDir> [...]');
    process.exit(1);
  }
  let exit = 0;
  for (const dir of dirs) {
    try {
      const r = patchEngineDir(dir);
      if (r.state === 'absent') console.log(`   · engine not at ${dir} (skip)`);
      else if (r.state === 'anchor-missing') {
        console.log(`   ⚠ engine patch anchors missing in ${dir} — upstream layout changed? patch NOT fully applied`);
        exit = 2;
      } else console.log(`   ✅ engine patch (${r.state}): ${dir}`);
    } catch (err) {
      console.error(`   ❌ engine patch failed for ${dir}: ${err.message}`);
      exit = 1;
    }
  }
  process.exit(exit);
}
