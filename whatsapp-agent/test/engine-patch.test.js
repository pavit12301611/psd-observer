// Tests for scripts/patch-voip-engine.mjs — the inbound-pickup patch applied
// to the installed baileys-caller engine. Fixture dist files carry the exact
// anchor lines of upstream's real dist; the patcher must patch them once,
// stay idempotent, report missing anchors without touching files, and never
// leave syntactically broken JS behind.
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
  'export class VoipClient extends EventEmitter {',
  '    #engine = null;',
  '    #activeCall = null;',
  '    #registerCall(call) {}',
  '    setupLog() {',
  '        const CALL_LOG_RE = /offer|reject|reason|preprocess|pending|contact|accept|missed|expired|silence|terminat|relay|call.?state|not.?authoriz|privacy/i;',
  '        return CALL_LOG_RE;',
  '    }',
  '    handleOffer(offer, call, callId, peerJid, isVideo, isGroup) {',
  '        call.peerJid = peerJid;',
  '        this.#registerCall(call);',
  '        if (this.listenerCount("incoming") === 0) {',
  '            return;',
  '        }',
  '        this.emit("incoming", call, { isVideo, isGroup, peerJid });',
  '    }',
  '    #handleCallEvent = (eventType, eventData) => {',
  '        if (eventType === 16) {',
  '        }',
  '        else if (eventType === WASM_EVENT_CALL_REJECTED) {',
  '        }',
  '    };',
  '}',
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

test('engine patch: applies to all three dist files, once', async () => {
  const dir = makeFixture();
  const r1 = patchEngineDir(dir, quiet);
  assert.equal(r1.state, 'patched');
  const wasm = fs.readFileSync(path.join(dir, 'dist/wasm-engine.mjs'), 'utf8');
  const idx = fs.readFileSync(path.join(dir, 'dist/index.mjs'), 'utf8');
  const sig = fs.readFileSync(path.join(dir, 'dist/signaling.mjs'), 'utf8');
  assert.match(wasm, /checkOngoingCalls = \(callIds, callCreatorJids\)/);
  assert.match(idx, /this\.#engine\?\.checkOngoingCalls\?\.\(\[callId\], \[peerJid\]\)/);
  assert.match(idx, /call\._callerPn =/, 'v2: caller PN stashed at offer time');
  assert.match(idx, /joining lobby call/, 'v2: event-93 lobby join');
  assert.match(idx, /joinOngoingCall\(\{/, 'v2: join invoked');
  assert.match(idx, /joinAndAccept: false/, 'v2: single accept stays with answer() poll');
  assert.match(idx, /relay\|lobby\|buffered\|ongoing\|join\|ack\|/, 'v2: widened WASM log filter');
  assert.match(sig, /isCallRoomPeer/);
  // patched wasm-engine imports and the wrapper is a safe no-op pre-init
  const mod = await import(path.join(dir, 'dist/wasm-engine.mjs'));
  const eng = new mod.WasmEngine();
  eng.checkOngoingCalls(['X'], ['1@lid']);

  const r2 = patchEngineDir(dir, quiet);
  assert.equal(r2.state, 'already');
  const wasm2 = fs.readFileSync(path.join(dir, 'dist/wasm-engine.mjs'), 'utf8');
  assert.equal((wasm2.match(/observer-patch: check-ongoing-calls v1/g) || []).length, 1, 'marker exactly once');
});

test('engine patch: missing anchor is reported, that part skipped', () => {
  const mangled = INDEX.replace('this.emit("incoming"', 'this.emit("renamed"');
  const dir = makeFixture({ index: mangled });
  const r = patchEngineDir(dir, quiet);
  assert.equal(r.state, 'anchor-missing');
  const after = fs.readFileSync(path.join(dir, 'dist/index.mjs'), 'utf8');
  assert.match(after, /this\.emit\("renamed"/, 'mangled line itself untouched');
  assert.doesNotMatch(after, /checkOngoingCalls\?\./, 'skipped part not inserted');
});

test('engine patch: v1-patched install gets only the v2 parts', () => {
  // Simulate a 3.1.3 (v1) install: v1 needles present, v2 parts absent.
  const v1Index = INDEX.replace(
    '        this.emit("incoming", call, { isVideo, isGroup, peerJid });',
    '        try {\n            this.#engine?.checkOngoingCalls?.([callId], [peerJid]);\n        }\n        catch { }\n        this.emit("incoming", call, { isVideo, isGroup, peerJid });',
  );
  const dir = makeFixture({ index: v1Index });
  const r = patchEngineDir(dir, quiet);
  assert.equal(r.state, 'patched');
  const idx = fs.readFileSync(path.join(dir, 'dist/index.mjs'), 'utf8');
  assert.equal((idx.match(/checkOngoingCalls\?\.\(\[callId\]/g) || []).length, 1, 'v1 part not duplicated');
  assert.match(idx, /joining lobby call/, 'v2 part added');
});

test('engine patch: absent engine dir is a clean skip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-absent-'));
  assert.equal(patchEngineDir(dir, quiet).state, 'absent');
});
