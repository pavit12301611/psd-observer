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
 *  5. A lobby-entered call must not be accepted until the server acks the
 *     lobby join. Upstream's deferred accept fires the moment `getCallInfo`
 *     returns anything, which is ~1s BEFORE the LobbyAck; the server then
 *     404-NACKs the accept (3.1.5 journal: `joinable_accept_before_lobby_ack:
 *     1`, "Accept ACK: error code = 404") and the peer terminates. (v4)
 *  6. v4's outbound-lobby sniff could never fire: `onSignalingXmpp` receives
 *     WABinary BYTES (Uint8Array), not an XML string — sandbox probe:
 *     `0,248,7,252,5,108,111,98,98,121,…` ("lobby" as ASCII codes) — so the
 *     lobby-sent flag stayed unset and the gate let the accept race again in
 *     3.1.6. v5 sets the flag at the two places that KNOW a lobby is going
 *     out (the claim and the join — both emit <lobby>, sandbox-proven),
 *     byte-decodes the sniff as a backup, and logs the gate's decision once
 *     per call so the next journal is self-explaining. (v5)
 *  7. TWO lobbies go out per call: the claim's (its ack only updates the
 *     call LOG — that's what produces event 93) and the join's (the actual
 *     room entry; `joinable_accept_before_lobby_ack` refers to THIS one).
 *     In 3.1.7 the gate read the claim-lobby's ack as "acked" and let the
 *     accept race the join-lobby's ack. v6 forgets any earlier ack whenever
 *     a lobby goes out (reset at the join and at the byte sniff), so the
 *     gate always waits for the LATEST lobby's ack. (v6)
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
const M4 = 'observer-patch: lobby-ack-gate v4';
const M5 = 'observer-patch: lobby-sent-flags v5';
const M6 = 'observer-patch: lobby-ack-reset v6';

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
    {
      needle: 'lobby-ack-gate v4 (send)',
      apply: (src) => {
        const anchor = '                onSignalingXmpp: (peerJid, callId, xmlPayload) => this.#signaling.sendSignaling(peerJid, callId, xmlPayload),';
        if (!src.includes(anchor)) return null;
        return src.replace(anchor, `                onSignalingXmpp: (peerJid, callId, xmlPayload) => {
                    /* ${M4} (send) — remember outbound <lobby> joins so the
                       deferred accept can wait for the server's LobbyAck. */
                    try {
                        if (this.#engine && String(xmlPayload).includes("<lobby"))
                            this.#engine._lobbySentCallId = String(callId ?? "");
                    }
                    catch { }
                    return this.#signaling.sendSignaling(peerJid, callId, xmlPayload);
                },`);
      },
    },
    {
      needle: 'lobby-ack-gate v4 (log)',
      apply: (src) => {
        const anchor = `                onLog: (level, message) => {
                    if (!wasmLogEnabled && !wasmLogVerbose)
                        return;`;
        if (!src.includes(anchor)) return null;
        return src.replace(anchor, `                onLog: (level, message) => {
                    /* ${M4} (log) — the WASM announces the completed lobby
                       handshake ("LobbyAck from: ... call_id: ..."). Remember
                       it (before the log-level gate, so it works with logs
                       off) so the deferred accept never races the ack. */
                    try {
                        const s = String(message);
                        if (this.#engine && s.includes("LobbyAck from")) {
                            const m = s.match(/call_id:([0-9A-Fa-f]{32})/);
                            this.#engine._lobbyAckCallId = m ? m[1].toUpperCase() : String(this.#activeCall?.callId ?? "");
                        }
                    }
                    catch { }
                    if (!wasmLogEnabled && !wasmLogVerbose)
                        return;`);
      },
    },
    {
      needle: '_lobbyWaitLogged',
      apply: (src) => {
        const anchor = `                if (active) {
                    call._accepted = true;`;
        if (!src.includes(anchor)) return null;
        return src.replace(anchor, `                if (active) {
                    /* ${M4} — never accept a lobby-entered call before the
                       server acks our lobby join: the accept is 404-NACKed
                       and the peer terminates (3.1.5 journal:
                       joinable_accept_before_lobby_ack=1). Flags are fed by
                       the (send)/(log)/(stanza) sniffers. Calls that never
                       sent a lobby keep the original behaviour. */
                    try {
                        const cid = String(call.callId ?? "").toUpperCase();
                        const lobbyPending = String(this.#engine?._lobbySentCallId ?? "").toUpperCase() === cid
                            && String(this.#engine?._lobbyAckCallId ?? "").toUpperCase() !== cid;
                        if (lobbyPending && Date.now() <= deadline) {
                            if (!call._lobbyWaitLogged) {
                                call._lobbyWaitLogged = true;
                                console.log(\`[baileys-caller] call \${call.callId} active, but lobby unacked — waiting for LobbyAck before accepting\`);
                            }
                            const t = setTimeout(waitThenAccept, ACCEPT_POLL_MS);
                            if (t.unref)
                                t.unref();
                            return;
                        }
                        if (lobbyPending)
                            console.log(\`[baileys-caller] lobby ack never arrived for \${call.callId}; accepting anyway as a last resort\`);
                    }
                    catch { }
                    call._accepted = true;`);
      },
    },
    {
      // v5: the claim itself emits <lobby> (sandbox-proven), so flag it here —
      // before the offer is even fed, hence before any accept poll can tick.
      needle: '_lobbySentCallId = claimId',
      apply: (src) => {
        const anchor = '                    this.#engine?.checkOngoingCalls?.([claimId], [claimCreator]);';
        if (!src.includes(anchor)) return null;
        return src.replace(anchor, anchor + `
                    /* ${M5} — claiming emits <lobby>; tell the accept gate. */
                    if (this.#engine)
                        this.#engine._lobbySentCallId = claimId;`);
      },
    },
    {
      // v5: joining also emits <lobby>; flag it at the join itself.
      needle: '_lobbySentCallId = call.callId',
      apply: (src) => {
        const anchor = '                call._joinedLobby = true;';
        if (!src.includes(anchor)) return null;
        return src.replace(anchor, anchor + `
                /* ${M5} — joining emits <lobby>; tell the accept gate. */
                if (this.#engine)
                    this.#engine._lobbySentCallId = call.callId;`);
      },
    },
    {
      // v5: fix the (send) sniff — xmlPayload is WABinary bytes, not XML text.
      needle: '_lobbySentBytes',
      apply: (src) => {
        const anchor = '                        if (this.#engine && String(xmlPayload).includes("<lobby"))';
        if (!src.includes(anchor)) return null;
        return src.replace(anchor, `                        /* ${M5} — xmlPayload is WABinary BYTES; the tag
                           name sits as ASCII in the first bytes ("lobby"
                           at offset ~5). The v4 text search never matched. */
                        let _lobbySentBytes = "";
                        if (typeof xmlPayload === "string")
                            _lobbySentBytes = xmlPayload.slice(0, 64);
                        else if (xmlPayload && typeof xmlPayload.length === "number") {
                            for (let i = 0; i < Math.min(xmlPayload.length, 48); i++)
                                _lobbySentBytes += String.fromCharCode(xmlPayload[i]);
                        }
                        if (this.#engine && _lobbySentBytes.includes("lobby"))`);
      },
    },
    {
      // v5: one diagnostic line per call so journals show the gate's inputs.
      needle: '_gateLogged',
      apply: (src) => {
        const anchor = `                        const lobbyPending = String(this.#engine?._lobbySentCallId ?? "").toUpperCase() === cid
                            && String(this.#engine?._lobbyAckCallId ?? "").toUpperCase() !== cid;`;
        if (!src.includes(anchor)) return null;
        return src.replace(anchor, anchor + `
                        /* ${M5} — self-explaining journals */
                        if (!call._gateLogged) {
                            call._gateLogged = true;
                            console.log(\`[baileys-caller] accept gate for \${call.callId}: lobbySent=\${this.#engine?._lobbySentCallId ?? "-"} lobbyAck=\${this.#engine?._lobbyAckCallId ?? "-"} pending=\${lobbyPending}\`);
                        }`);
      },
    },
    {
      // v6: the JOIN's lobby is the room entry — forget the claim-lobby's ack.
      needle: 'lobby-ack-reset v6 (join)',
      apply: (src) => {
        const anchor = `                if (this.#engine)
                    this.#engine._lobbySentCallId = call.callId;`;
        if (!src.includes(anchor)) return null;
        return src.replace(anchor, `                if (this.#engine) {
                    this.#engine._lobbySentCallId = call.callId;
                    /* ${M6} (join) — THIS lobby is the room entry; the
                       claim-lobby's earlier ack only updated the call log.
                       Forget it so the gate waits for the join's own ack. */
                    this.#engine._lobbyAckCallId = "";
                }`);
      },
    },
    {
      // v6: same reset at the actual byte emission (covers every lobby send).
      needle: 'lobby-ack-reset v6 (send)',
      apply: (src) => {
        const anchor = `                        if (this.#engine && _lobbySentBytes.includes("lobby"))
                            this.#engine._lobbySentCallId = String(callId ?? "");`;
        if (!src.includes(anchor)) return null;
        return src.replace(anchor, `                        if (this.#engine && _lobbySentBytes.includes("lobby")) {
                            this.#engine._lobbySentCallId = String(callId ?? "");
                            /* ${M6} (send) — a lobby just went out; any earlier
                               ack belonged to a previous lobby. */
                            this.#engine._lobbyAckCallId = "";
                        }`);
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
    {
      needle: 'lobby-ack-gate v4 (stanza)',
      apply: (src) => {
        const anchor = `            case "ack":
                voip.handleSignalingAck({`;
        if (!src.includes(anchor)) return null;
        return src.replace(anchor, `            case "ack":
                /* ${M4} (stanza) — a successful <ack type="lobby"> is the
                   server's LobbyAck; tell the accept gate (index.mjs). */
                try {
                    if (/lobby/i.test(String(usableNode.attrs.type ?? "")) && ["", "0"].includes(String(usableNode.attrs.error ?? "0")))
                        voip._lobbyAckCallId = String(callIdForRouting ?? "");
                }
                catch { }
                voip.handleSignalingAck({`);
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
