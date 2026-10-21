#!/usr/bin/env node
/**
 * patch-voip-engine.mjs — make the experimental baileys-caller engine answer
 * inbound WhatsApp calls at all.
 *
 * What the real machine's journal + sandbox WASM runs + WhatsApp Web's own
 * extracted JS proved, step by step:
 *
 *  1. The VoIP WASM *buffers* an inbound offer as a "pending call"
 *     ("Recording call offer received") unless the host claims the call via
 *     `checkOngoingCalls(callIds, callCreatorJids)`. Claiming it only AFTER
 *     feeding the offer made the stack treat its own call as a missed one
 *     to REJOIN through the server lobby (which nacks 1:1 calls, error 404).
 *     WhatsApp Web's socket layer claims first, then delivers. (v3 moves the
 *     claim before the offer feed; v1 had it after.)
 *  2. If a call still goes the buffered route, the lobby promotes it to a
 *     *joinable ongoing call* (WASM event 93, UpdateJoinableCallLog) and the
 *     host must `joinVoipOngoingCall(...)` to create the ACTIVE call the
 *     library's deferred `acceptCall()` polls for. (v2)
 *  3. WASM event **2 is `CallOfferReceived`** — the stack RINGING — per
 *     WhatsApp Web's own CallEvent enum. Upstream treats it as a remote
 *     hangup (`_forceEnd("remote_end")`), killing every inbound call at the
 *     exact moment the WASM engages it. (v3)
 *  4. Stanzas the WASM addresses to the call room (`<callId>@call`, e.g.
 *     `<lobby>`) must keep that address; the bridge rewrote them to the
 *     peer's bare JID (`<callId>@s.whatsapp.net`). (v1)
 *
 * Every part is individually idempotent (needle check), so it is safe on
 * fresh installs, on older patched installs (only missing parts land; the
 * superseded v1 after-feed claim is removed) and on every update. Patched
 * files are syntax-verified; originals are restored on any failure. If
 * upstream's dist layout changes so an anchor is missing, it reports that
 * and changes nothing for that part.
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
const M3 = 'observer-patch: claim-offer-first v3';

// Remove the superseded v1/v2 after-feed claim block from index.mjs, whatever
// comment wording the patcher version that wrote it used. The block sits
// immediately before the `incoming` emit line.
function removeLegacyAfterFeedClaim(src) {
  const emitAnchor = '        this.emit("incoming", call, { isVideo, isGroup, peerJid });';
  const emitAt = src.indexOf(emitAnchor);
  if (emitAt < 0) return src;
  const commentAt = src.lastIndexOf('/* observer-patch: check-ongoing-calls v1', emitAt);
  if (commentAt < 0 || emitAt - commentAt > 900) return src;
  if (!src.slice(commentAt, emitAt).includes('checkOngoingCalls?.([callId], [peerJid])')) return src;
  return src.slice(0, commentAt) + src.slice(emitAt);
}

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
      needle: 'claim the call BEFORE feeding',
      apply: (src) => {
        const anchor = '            const delivered = this.#signaling.processIncomingCall(node, this.#engine, this.#activeCall?.callId ?? "");';
        if (!src.includes(anchor)) return null;
        let out = removeLegacyAfterFeedClaim(src);
        const insertion = `            /* ${M3} — claim the call BEFORE feeding the offer stanza, the
               order WhatsApp Web's socket layer uses. Claiming only after
               delivery made the stack treat its own fresh call as a missed
               one to rejoin via the server lobby (which 404s for 1:1). With
               the claim first, the offer rings live (CallOfferReceived). */
            try {
                const offerChild = this.#baileys?.getBinaryNodeChild?.(node, "offer");
                const claimId = String(offerChild?.attrs?.["call-id"] ?? "");
                if (claimId) {
                    const claimCreator = String(offerChild?.attrs?.["call-creator"] ?? node.attrs?.from ?? "");
                    this.#engine?.checkOngoingCalls?.([claimId], [claimCreator]);
                }
            }
            catch { }
`;
        out = out.replace(anchor, insertion + anchor);
        return out;
      },
    },
    {
      needle: 'CallOfferReceived (ringing)',
      apply: (src) => {
        const anchor = `        else if (eventType === 2) {
            this.#activeCall?._forceEnd("remote_end");
        }`;
        if (!src.includes(anchor)) return null;
        return src.replace(anchor, `        else if (eventType === 2) {
            /* ${M3} — WA_CALL_EVENT 2 is CallOfferReceived (WhatsApp Web's
               own CallEvent enum): the stack is RINGING, not hanging up.
               Upstream force-ended the call here, killing every inbound call
               at the exact moment the WASM engaged it. Real hangups still
               land via <terminate>/<reject> stanzas and event 10. */
            console.log(\`[baileys-caller] WASM event CallOfferReceived (ringing) for \${this.#activeCall?.callId ?? "?"}\`);
        }`);
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
      // v3 guard: never join a call that is already ringing/active/accepted —
      // on the claim-first live path event 93 may exist as pure telemetry.
      needle: '!call._accepted && !_active93',
      apply: (src) => {
        const anchor = '            if (call?.incoming && !call._joinedLobby && (!evCallId || evCallId === call.callId)) {';
        if (!src.includes(anchor)) return null;
        return src.replace(anchor, `            const _info93 = (() => { try { return this.#engine.getCallInfo(); } catch { return null; } })();
            const _active93 = typeof _info93 === "string" ? _info93.trim().length > 0 && !_info93.startsWith("getCallInfo threw") : !!_info93;
            if (call?.incoming && !call._joinedLobby && !call._accepted && !_active93 && (!evCallId || evCallId === call.callId)) {`);
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
