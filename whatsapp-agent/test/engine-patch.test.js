// Tests for scripts/patch-voip-engine.mjs — the inbound-pickup patches
// applied to the installed baileys-caller engine. Fixture dist files carry
// the exact anchor lines of upstream's real dist; the patcher must apply
// every part once, stay idempotent, upgrade older patched installs (incl.
// removing the superseded v1 after-feed claim), report missing anchors, and
// never leave syntactically broken JS behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { patchEngineDir } from '../scripts/patch-voip-engine.mjs';

const WASM_ENGINE = [
  'export class WasmEngine {',
  '    #instance = null;',
  '    #makeStringList = (arr) => arr;',
  '    getCallInfo = () => {',
  '        if (!this.#instance)',
  '            return null;',
  '        return null;',
  '    };',
  '}',
  '',
].join('\n');

const INDEX = [
  "import { EventEmitter } from 'node:events';",
  'const WASM_EVENT_CALL_REJECTED = 92;',
  'const ACCEPT_WAIT_MS = 20000;',
  'const ACCEPT_POLL_MS = 250;',
  'export class VoipClient extends EventEmitter {',
  '    #engine = null;',
  '    #signaling = null;',
  '    #baileys = null;',
  '    #sock = null;',
  '    #activeCall = null;',
  '    #registerCall(call) {}',
  '    #endActiveCallOnPeerTerminate(node) {}',
  '    #handleIncomingOffer(node) {}',
  '    setupEngine() {',
  '        const wasmLogEnabled = false;',
  '        const wasmLogVerbose = false;',
  '        const CALL_LOG_RE = /offer|reject|reason|preprocess|pending|contact|accept|missed|expired|silence|terminat|relay|call.?state|not.?authoriz|privacy/i;',
  '        const callbacks = {',
  '                onSignalingXmpp: (peerJid, callId, xmlPayload) => this.#signaling.sendSignaling(peerJid, callId, xmlPayload),',
  '                onLog: (level, message) => {',
  '                    if (!wasmLogEnabled && !wasmLogVerbose)',
  '                        return;',
  '                    if (CALL_LOG_RE.test(message)) console.log(message);',
  '                },',
  '        };',
  '        return callbacks;',
  '    }',
  '    wireCalls() {',
  '        this.#sock.ws.on("CB:call", (node) => {',
  '            this.#endActiveCallOnPeerTerminate(node);',
  '            const delivered = this.#signaling.processIncomingCall(node, this.#engine, this.#activeCall?.callId ?? "");',
  '            void delivered',
  '                .then(() => this.#handleIncomingOffer(node))',
  '                .catch((err) => this.emit("error", err));',
  '        });',
  '    }',
  '    handleOffer(offer, call, callId, peerJid, isVideo, isGroup) {',
  '        call.peerJid = peerJid;',
  '        this.#registerCall(call);',
  '        call._answer = () => {',
  '            const deadline = Date.now() + ACCEPT_WAIT_MS;',
  '            let logged = false;',
  '            const waitThenAccept = () => {',
  '                if (call.ended || call._accepted)',
  '                    return;',
  '                let info;',
  '                try {',
  '                    info = this.#engine.getCallInfo();',
  '                }',
  '                catch { }',
  '                const active = typeof info === "string"',
  '                    ? info.trim().length > 0 && !info.startsWith("getCallInfo threw")',
  '                    : !!info;',
  '                if (active) {',
  '                    call._accepted = true;',
  '                    console.log(`[baileys-caller] call ${call.callId} is active; accepting now`);',
  '                    this.#engine.acceptCall(true, false);',
  '                    return;',
  '                }',
  '                if (Date.now() > deadline) {',
  '                    call._forceEnd("accept_timeout");',
  '                    return;',
  '                }',
  '                if (!logged) logged = true;',
  '                const t = setTimeout(waitThenAccept, ACCEPT_POLL_MS);',
  '                if (t.unref)',
  '                    t.unref();',
  '            };',
  '            waitThenAccept();',
  '        };',
  '        if (this.listenerCount("incoming") === 0) {',
  '            return;',
  '        }',
  '        this.emit("incoming", call, { isVideo, isGroup, peerJid });',
  '    }',
  '    #handleCallEvent = (eventType, eventData) => {',
  '        if (eventType === 16) {',
  '        }',
  '        else if (eventType === 2) {',
  '            this.#activeCall?._forceEnd("remote_end");',
  '        }',
  '        else if (eventType === WASM_EVENT_CALL_REJECTED) {',
  '        }',
  '    };',
  '}',
  '',
].join('\n');

// Exactly what the 3.1.3 patcher inserted (note the older comment wording).
const LEGACY_V1_BLOCK = [
  '        /* observer-patch: check-ongoing-calls v1 — the WASM buffers the offer as a pending call and only',
  '           engages it (lobby -> preaccept -> active) once the host reports the',
  '           call as ongoing. Without this, answer() polls an offer that never',
  '           promotes and every inbound call dies with accept_timeout. */',
  '        try {',
  '            this.#engine?.checkOngoingCalls?.([callId], [peerJid]);',
  '        }',
  '        catch { }',
  '',
].join('\n');

const SIGNALING = [
  'export class SignalingBridge {',
  '    #resolveOutboundPeerJid(callId, jid) { return jid; }',
  '    #toBareJid(j) { return j; }',
  '    #toCallDeviceJid(j) { return j; }',
  '    #sendCallStanza(...a) {}',
  '    #doSendSignaling = async (peerJid, callId, xmlPayload) => {',
  '        const signalingTag = "lobby";',
  '        const effectivePeerJid = this.#resolveOutboundPeerJid(callId, peerJid);',
  '        const isGroupOffer = false;',
  '        const routeTo = isGroupOffer',
  '            ? `${callId}@call`',
  '            : (signalingTag !== "offer" && signalingTag !== "enc_rekey")',
  '                ? this.#toBareJid(effectivePeerJid)',
  '                : this.#toCallDeviceJid(effectivePeerJid);',
  '        await this.#sendCallStanza(routeTo, null, signalingTag, effectivePeerJid, peerJid);',
  '        return routeTo;',
  '    };',
  '    routeIncoming(usableNode, voip, callIdForRouting, b64) {',
  '        switch (usableNode.tag) {',
  '            case "offer":',
  '                voip.handleSignalingOffer({ payload: b64 });',
  '                break;',
  '            case "ack":',
  '                voip.handleSignalingAck({',
  '                    payload: b64,',
  '                    ackError: usableNode.attrs.error ?? "0",',
  '                    msgType: usableNode.attrs.type ?? "",',
  '                });',
  '                break;',
  '            default:',
  '                voip.handleSignalingMessage({ payload: b64 });',
  '                break;',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

function makeFixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-patch-'));
  const dist = path.join(dir, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'wasm-engine.mjs'), overrides.wasm ?? WASM_ENGINE);
  fs.writeFileSync(path.join(dist, 'index.mjs'), overrides.index ?? INDEX);
  fs.writeFileSync(path.join(dist, 'signaling.mjs'), overrides.signaling ?? SIGNALING);
  return dir;
}

const quiet = () => {};
const readIdx = (dir) => fs.readFileSync(path.join(dir, 'dist/index.mjs'), 'utf8');

test('engine patch: all parts apply once on a fresh engine', async () => {
  const dir = makeFixture();
  const r1 = patchEngineDir(dir, quiet);
  assert.equal(r1.state, 'patched');
  const wasm = fs.readFileSync(path.join(dir, 'dist/wasm-engine.mjs'), 'utf8');
  const idx = readIdx(dir);
  const sig = fs.readFileSync(path.join(dir, 'dist/signaling.mjs'), 'utf8');
  assert.match(wasm, /checkOngoingCalls = \(callIds, callCreatorJids\)/);
  assert.match(idx, /claim the call BEFORE feeding/, 'v3: claim inserted');
  assert.ok(idx.indexOf('checkOngoingCalls?.([claimId], [claimCreator])') < idx.indexOf('processIncomingCall(node'),
    'v3: claim really is BEFORE the offer feed');
  assert.doesNotMatch(idx, /checkOngoingCalls\?\.\(\[callId\], \[peerJid\]\)/, 'no after-feed claim');
  assert.doesNotMatch(idx, /_forceEnd\("remote_end"\)/, 'v3: event-2 remote_end bug gone');
  assert.match(idx, /CallOfferReceived \(ringing\)/, 'v3: event 2 treated as ringing');
  assert.match(idx, /call\._callerPn =/, 'v2: caller PN stashed');
  assert.match(idx, /joining lobby call/, 'v2: event-93 join');
  assert.match(idx, /!call\._accepted && !_active93/, 'v3: join guard never touches live calls');
  assert.match(idx, /relay\|lobby\|buffered\|ongoing\|join\|ack\|/, 'v2: widened log filter');
  assert.match(idx, /lobby-ack-gate v4 \(send\)/, 'v4: outbound lobby sniffed');
  assert.match(idx, /_lobbySentCallId/, 'v4: lobby-sent flag');
  assert.match(idx, /lobby-ack-gate v4 \(log\)/, 'v4: LobbyAck log sniffed');
  assert.match(idx, /_lobbyWaitLogged/, 'v4: accept gate present');
  assert.ok(idx.indexOf('_lobbyWaitLogged') < idx.indexOf('call._accepted = true;'),
    'v4: gate really runs BEFORE the accept');
  assert.match(idx, /_lobbySentCallId = claimId/, 'v5: claim flags the gate');
  assert.match(idx, /_lobbySentCallId = call\.callId/, 'v5: join flags the gate');
  assert.match(idx, /_lobbySentBytes/, 'v5: byte-wise lobby sniff');
  assert.doesNotMatch(idx, /String\(xmlPayload\)\.includes\("<lobby"\)/, 'v5: impossible text sniff gone');
  assert.match(idx, /_gateLogged/, 'v5: gate diagnostics logged');
  assert.match(idx, /lobby-ack-reset v6 \(join\)/, 'v6: join forgets the claim ack');
  assert.match(idx, /lobby-ack-reset v6 \(send\)/, 'v6: every lobby send forgets earlier acks');
  assert.equal((idx.match(/_lobbyAckCallId = "";+?/g) || []).length, 2, 'v6: exactly two ack resets');
  assert.match(sig, /isCallRoomPeer/);
  assert.match(sig, /lobby-ack-gate v4 \(stanza\)/, 'v4: lobby ack stanza sniffed');
  assert.match(sig, /_lobbyAckCallId = String\(callIdForRouting/, 'v4: stanza feeds the gate');
  // patched wasm-engine imports and the wrapper is a safe no-op pre-init
  const mod = await import(path.join(dir, 'dist/wasm-engine.mjs'));
  const eng = new mod.WasmEngine();
  eng.checkOngoingCalls(['X'], ['1@lid']);

  const r2 = patchEngineDir(dir, quiet);
  assert.equal(r2.state, 'already');
});

test('engine patch: v1/v2 install upgrades — legacy claim removed, nothing duplicated', () => {
  // Simulate a 3.1.3/3.1.4 install: legacy after-feed claim present.
  const legacyIndex = INDEX.replace(
    '        this.emit("incoming", call, { isVideo, isGroup, peerJid });',
    LEGACY_V1_BLOCK + '        this.emit("incoming", call, { isVideo, isGroup, peerJid });',
  );
  const dir = makeFixture({ index: legacyIndex });
  const r = patchEngineDir(dir, quiet);
  assert.equal(r.state, 'patched');
  const idx = readIdx(dir);
  assert.doesNotMatch(idx, /checkOngoingCalls\?\.\(\[callId\], \[peerJid\]\)/, 'legacy after-feed claim removed');
  assert.equal((idx.match(/checkOngoingCalls\?\.\(\[claimId\]/g) || []).length, 1, 'claim present exactly once');
  assert.match(idx, /this\.emit\("incoming"/, 'emit line intact');
  assert.match(idx, /lobby-ack-gate v4/, 'v4 lands on upgraded installs too');
  assert.match(idx, /lobby-sent-flags v5/, 'v5 lands on upgraded installs too');
  const r2 = patchEngineDir(dir, quiet);
  assert.equal(r2.state, 'already');
});

test('engine patch: missing anchor is reported, that part skipped', () => {
  const mangled = INDEX.replace('processIncomingCall(node', 'renamedFeed(node');
  const dir = makeFixture({ index: mangled });
  const r = patchEngineDir(dir, quiet);
  assert.equal(r.state, 'anchor-missing');
  const after = readIdx(dir);
  assert.doesNotMatch(after, /claim the call BEFORE feeding/, 'skipped part not inserted');
});

test('engine patch: absent engine dir is a clean skip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-absent-'));
  assert.equal(patchEngineDir(dir, quiet).state, 'absent');
});
