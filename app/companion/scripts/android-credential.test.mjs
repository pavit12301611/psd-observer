import test from 'node:test';
import assert from 'node:assert/strict';
import { credentialTarget, center, enterEmulatorCredential } from '../e2e/android-credential.mjs';
const appEntry = '<node package="in.observer.companion.preview" class="android.widget.EditText" password="true" resource-id="app:pin" bounds="[0,0][30,30]" />';
const systemEntry = '<node package="com.android.settings" class="android.widget.EditText" password="true" resource-id="com.android.settings:id/password_entry" bounds="[20,40][220,140]" />';
const choose = '<node package="com.android.systemui" class="android.widget.Button" clickable="true" text="Use PIN" bounds="[10,20][110,80]" />';
test('credential automation never treats an app/web password field as system authentication', () => {
  assert.equal(credentialTarget(appEntry), null); assert.equal(credentialTarget(systemEntry).kind, 'entry'); assert.deepEqual(center(credentialTarget(systemEntry).node), { x: 120, y: 90 });
});
test('credential automation waits for the real system entry and types only once', async () => {
  const trees = [appEntry, choose, systemEntry]; let typed = 0, submitted = 0, taps = 0, clock = 0;
  await enterEmulatorCredential({ readTree: async () => trees.shift() || systemEntry, tap: async () => { taps++; }, typeOnce: async () => { typed++; }, submit: async () => { submitted++; }, now: () => clock, delay: async () => { clock += 300; } });
  assert.equal(typed, 1); assert.equal(submitted, 1); assert.equal(taps, 2);
});
test('missing native prompt fails without entering a PIN anywhere', async () => {
  let typed = 0, clock = 0;
  await assert.rejects(enterEmulatorCredential({ readTree: async () => appEntry, tap: async () => {}, typeOnce: async () => { typed++; }, submit: async () => {}, now: () => clock, delay: async () => { clock += 300; }, timeout: 1000 }), /No system credential entry/);
  assert.equal(typed, 0);
});
