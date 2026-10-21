#!/usr/bin/env node
/**
 * patch-voip-engine.mjs — make the experimental baileys-caller engine answer
 * inbound WhatsApp calls at all.
 *
 * The problem (proven from a real machine's journal + sandbox WASM runs):
 * the WhatsApp Web VoIP WASM *buffers* an inbound offer as a "pending call"
 * ("Recording call offer received") and waits for the host to report which
 * calls are ongoing via `checkOngoingCalls(callIds, callCreatorJids)`. Only
 * then does it engage: it sends `<lobby>` to `<callId>@call`, the server
 * promotes the call to a *joinable ongoing call* (WASM event 93,
 * UpdateJoinableCallLog), and the host must then `joinVoipOngoingCall(...)`
 * to create the ACTIVE call — which is what the library's deferred
 * `acceptCall()` polls for. baileys-caller (upstream main 574f666) does
 * neither step, so every inbound call rings out with `accept_timeout` /
 * WASM status 670007 and the caller's RelayLatency stanzas are dropped as
 * "no active call".
 *
 * This patcher applies small, guarded text patches to the installed
 * engine's dist files. Every part is individually idempotent (needle
 * check), so it is safe on fresh installs, on v1-patched installs (only the
 * new parts land) and on every update. Patched files are syntax-verified;
 * originals are restored on any failure. If upstream's dist layout changes
 * so an anchor is missing, it reports that and changes nothing for that part.
 *
 * v1: checkOngoingCalls wrapper + call on inbound offer + keep `<callId>@call`
 *     stanza addressing (bridge rewrote it to a bare JID, misrouting <lobby>).
 * v2: on WASM event 93 (call became joinable) join it via joinOngoingCall
 *     with joinAndAccept=false (the existing answer() poll performs the one
 *     real accept), stash caller PN at offer time for the join params, and
 *     widen the WASM log keyword filter (lobby|buffered|ongoing|join|ack) so
 *     `voice doctor` journals show the promotion chain at the default level.
 *
 * Usage: node scripts/patch-voip-engine.mjs <engineDir> [<engineDir> ...]
 * Exit codes: 0 ok (patched/already), 2 anchor missing somewhere, 1 hard error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const M1 = 'observer-patch: check-ongoing-calls v1';
const M2 = 'observer-patch: join-ongoing-call v2';

// Each part: { needle } = text present when the part is applied;
// apply(src) returns patched src, or null when its anchor is missing.
const PARTS = {
  'wasm-engine.mjs': [
    {
      needle: 'checkOngoingCalls = (callIds, callCreatorJids)',
      apply: (src) => {
        const anchor = '    getCallInfo = () => {';
        if (!src.includes(anchor)) return null;
        const insertion = `    /* ${M1} */
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
      },
    },
  ],
  'index.mjs': [
    {
      needle: 'checkOngoingCalls?.([callId], [peerJid])',
      apply: (src) => {
        const anchor = '        this.emit("incoming", call, { isVideo, isGroup, peerJid });';
        if (!src.includes(anchor)) return null;
        const insertion = `        /* ${M1} — the WASM buffers the offer as a pending call and only
           engages it (lobby -> joinable -> active) once the host reports the
           call as ongoing. Without this, answer() polls an offer that never
           promotes and every inbound call dies with accept_timeout. */
        try {
            this.#engine?.checkOngoingCalls?.([callId], [peerJid]);
        }
        catch { }
`;
        return src.replace(anchor, insertion + anchor);
      },
    },
    {
      needle: 'call._callerPn =',
      apply: (src) => {
        const anchor = '        call.peerJid = peerJid;';
        if (!src.includes(anchor)) return null;
        return src.replace(anchor, anchor + `
        /* ${M2} — join params for when the lobby promotes this call. */
        call._callerPn = String(offer.attrs?.caller_pn ?? "");
        call._isVideoOffer = isVideo;`);
      },
    },
    {
      needle: 'joining lobby call',
      apply: (src) => {
        const anchor = '        else if (eventType === WASM_EVENT_CALL_REJECTED) {';
        if (!src.includes(anchor)) return null;
        const insertion = `        else if (eventType === 93) {
            /* ${M2} — UpdateJoinableCallLog: the lobby promoted the buffered
               offer to a JOINABLE ongoing call. Joining it creates the active
               call the deferred acceptCall() polls for. joinAndAccept stays
               false so the existing answer() poll performs the single real
               accept once the call reports active. */
            const call = this.#activeCall;
            let evCallId = "";
            try {
                evCallId = String(JSON.parse(eventData ?? "{}").call_id ?? "");
            }
            catch { }
            if (call?.incoming && !call._joinedLobby && (!evCallId || evCallId === call.callId)) {
                call._joinedLobby = true;
                try {
                    console.log(\`[baileys-caller] joining lobby call \${call.callId} (${M2})\`);
                    this.#engine.joinOngoingCall({
                        callId: call.callId,
                        callCreatorJid: call.peerJid,
                        initialPeerJid: call.peerJid,
                        pnUserJids: call._callerPn ? [call._callerPn] : [],
                        lidUserJids: [call.peerJid],
                        deviceJidsCsv: [call.peerJid],
                        hasVideo: !!call._isVideoOffer,
                        groupJid: "",
                        callCreatorIsNotContact: false,
                        joinAndAccept: false,
                    });
                }
                catch (err) {
                    console.log(\`[baileys-caller] joinOngoingCall failed: \${err?.message || err}\`);
                }
            }
        }
`;
        return src.replace(anchor, insertion + anchor);
      },
    },
    {
      needle: 'terminat|relay|lobby|',
      apply: (src) => {
        const anchor = 'const CALL_LOG_RE = /offer|reject|reason|preprocess|pending|contact|accept|missed|expired|silence|terminat|relay|call.?state|not.?authoriz|privacy/i;';
        if (!src.includes(anchor)) return null;
        return src.replace(anchor,
          'const CALL_LOG_RE = /offer|reject|reason|preprocess|pending|contact|accept|missed|expired|silence|terminat|relay|lobby|buffered|ongoing|join|ack|call.?state|not.?authoriz|privacy/i; /* ' + M2 + ': widened so doctor journals show the promotion chain */');
      },
    },
  ],
  'signaling.mjs': [
    {
      needle: 'isCallRoomPeer',
      apply: (src) => {
        const anchorA = '        const effectivePeerJid = this.#resolveOutboundPeerJid(callId, peerJid);';
        const anchorB = `        const routeTo = isGroupOffer
            ? \`\${callId}@call\`
            : (signalingTag !== "offer" && signalingTag !== "enc_rekey")
                ? this.#toBareJid(effectivePeerJid)
                : this.#toCallDeviceJid(effectivePeerJid);`;
        if (!src.includes(anchorA) || !src.includes(anchorB)) return null;
        let out = src.replace(anchorA, `        /* ${M1} — stanzas the WASM addresses to the call room
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
      },
    },
  ],
};

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
  for (const [name, parts] of Object.entries(PARTS)) {
    const file = path.join(dist, name);
    if (!fs.existsSync(file)) { anyMissing = true; continue; }
    const original = fs.readFileSync(file, 'utf8');
    let src = original;
    let changed = false;
    for (const part of parts) {
      if (src.includes(part.needle)) continue;
      const next = part.apply(src);
      if (next === null) { anyMissing = true; continue; }
      src = next;
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(file, src);
      if (!syntaxOk(file)) {
        fs.writeFileSync(file, original); // never leave a broken engine behind
        throw new Error(`patched ${file} failed node --check; original restored`);
      }
      newlyPatched += 1;
      log(`   🔩 engine patch applied: ${path.join('dist', name)}`);
    }
    if (parts.every((p) => src.includes(p.needle))) done.push(name);
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
