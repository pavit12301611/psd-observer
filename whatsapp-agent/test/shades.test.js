// shades.test.js — 🕶️ SHADES: physical screen blackout, CLEAR screenshots.
// The darkening must hit only the panel (backlight) or the output gamma ramp
// — never the framebuffer — so the bot's screenshot eyes stay open.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  shadesOn, shadesOff, shadesStatus, maybeAutoRestore, initShades,
  loadShadeState, stopShadeGuard,
} from '../src/shades.js';

// ── fake shell runner: records calls, serves canned outputs ─────────────────
function fakeRun(handlers = {}) {
  const calls = [];
  const run = async (bin, args = []) => {
    calls.push([bin, ...args]);
    const key = `${bin} ${args.join(' ')}`.trim();
    for (const [pattern, out] of Object.entries(handlers)) {
      if (key === pattern || key.startsWith(pattern)) {
        if (out instanceof Error) throw out;
        return out;
      }
    }
    const err = new Error(`unexpected: ${key}`);
    err.code = 'ENOENT';
    throw err;
  };
  run.calls = calls;
  return run;
}

const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shades-')), 'state.json');

// ── 1. Backlight path (laptops — the normal case) ───────────────────────────

test('shades: ON saves backlight level, sets 0, and writes state', async () => {
  const stateFile = tmpState();
  const run = fakeRun({
    'brightnessctl -m': 'intel_backlight,backlight,937,47%,2000',
    'brightnessctl set 0': '',
  });
  const msg = await shadesOn({ run, stateFile, timeoutMs: 0, now: () => 1000 });
  assert.match(msg, /SHADES ON/);
  assert.match(msg, /BLACK/);
  assert.match(msg, /clear/i, 'must promise clear screenshots');
  assert.ok(run.calls.some((c) => c.join(' ') === 'brightnessctl set 0'), 'panel dimmed');
  const state = loadShadeState(stateFile);
  assert.equal(state.enabled, true);
  assert.equal(state.method, 'backlight');
  assert.equal(state.savedPct, 47);
  assert.equal(state.savedRaw, '937');
});

test('shades: OFF restores the exact saved backlight value', async () => {
  const stateFile = tmpState();
  const run = fakeRun({
    'brightnessctl -m': 'intel_backlight,backlight,937,47%,2000',
    'brightnessctl set 0': '',
    'brightnessctl set 937': '',
  });
  await shadesOn({ run, stateFile, timeoutMs: 0, now: () => 1000 });
  const msg = await shadesOff({ run, stateFile, now: () => 2000 });
  assert.match(msg, /SHADES OFF/);
  assert.ok(run.calls.some((c) => c.join(' ') === 'brightnessctl set 937'), 'raw value restored');
  assert.equal(loadShadeState(stateFile), null, 'state cleared');
});

test('shades: ON twice is idempotent, OFF when already off says so', async () => {
  const stateFile = tmpState();
  const run = fakeRun({
    'brightnessctl -m': 'intel_backlight,backlight,937,47%,2000',
    'brightnessctl set 0': '',
    'brightnessctl set 937': '',
    'brightnessctl set 50%': '',
  });
  await shadesOn({ run, stateFile, timeoutMs: 0, now: () => 1 });
  const again = await shadesOn({ run, stateFile, timeoutMs: 0, now: () => 2 });
  assert.match(again, /already ON/);
  await shadesOff({ run, stateFile, now: () => 3 });
  const off = await shadesOff({ run, stateFile, now: () => 4 });
  assert.match(off, /already \*OFF\*/i);
});

// ── 2. Gamma fallback (desktop monitors / X11) ──────────────────────────────

test('shades: falls back to xrandr gamma when brightnessctl is missing', async () => {
  const stateFile = tmpState();
  const run = fakeRun({
    'brightnessctl -m': Object.assign(new Error('nope'), { code: 'ENOENT' }),
    'xrandr --query': 'eDP-1 connected primary 1920x1080\nHDMI-1 connected 1920x1080\nDP-2 disconnected',
    'xrandr --output eDP-1 --brightness 0': '',
    'xrandr --output HDMI-1 --brightness 0': '',
    'xrandr --output eDP-1 --brightness 1': '',
    'xrandr --output HDMI-1 --brightness 1': '',
  });
  const msg = await shadesOn({ run, stateFile, timeoutMs: 0, now: () => 1 });
  assert.match(msg, /SHADES ON/);
  const state = loadShadeState(stateFile);
  assert.equal(state.method, 'gamma');
  assert.deepEqual(state.outputs, ['eDP-1', 'HDMI-1'], 'only connected outputs');
  const offMsg = await shadesOff({ run, stateFile, now: () => 2 });
  assert.match(offMsg, /SHADES OFF/);
  assert.ok(run.calls.some((c) => c.join(' ') === 'xrandr --output eDP-1 --brightness 1'));
  assert.ok(run.calls.some((c) => c.join(' ') === 'xrandr --output HDMI-1 --brightness 1'));
});

test('shades: clear error when neither brightnessctl nor xrandr exists', async () => {
  const stateFile = tmpState();
  const run = fakeRun({
    'brightnessctl -m': Object.assign(new Error('x'), { code: 'ENOENT' }),
    'xrandr --query': Object.assign(new Error('x'), { code: 'ENOENT' }),
  });
  const msg = await shadesOn({ run, stateFile, timeoutMs: 0 });
  assert.match(msg, /nahi chale|failed/i);
  assert.equal(loadShadeState(stateFile), null, 'no half-enabled state');
});

// ── 3. Failsafes — the screen must never stay black forever ─────────────────

test('shades: auto-restore timer fires after timeoutMs', async () => {
  const stateFile = tmpState();
  const run = fakeRun({
    'brightnessctl -m': 'intel_backlight,backlight,937,47%,2000',
    'brightnessctl set 0': '',
    'brightnessctl set 937': '',
  });
  let t = 1_000_000;
  await shadesOn({ run, stateFile, timeoutMs: 50, now: () => t });
  assert.equal(loadShadeState(stateFile)?.enabled, true);
  t += 60_000; // timeout passed
  const restored = await maybeAutoRestore({ run, stateFile, timeoutMs: 50, now: () => t });
  assert.equal(restored, true);
  assert.equal(loadShadeState(stateFile), null);
  assert.ok(run.calls.some((c) => c.join(' ') === 'brightnessctl set 937'));
});

test('shades: auto-restore does NOT fire before the deadline', async () => {
  const stateFile = tmpState();
  const run = fakeRun({
    'brightnessctl -m': 'intel_backlight,backlight,937,47%,2000',
    'brightnessctl set 0': '',
    'brightnessctl set 937': '',
  });
  await shadesOn({ run, stateFile, timeoutMs: 60_000, now: () => 1000 });
  const restored = await maybeAutoRestore({ run, stateFile, timeoutMs: 60_000, now: () => 2000 });
  assert.equal(restored, false);
  assert.equal(loadShadeState(stateFile)?.enabled, true);
});

test('shades: initShades restores a stale blackout from a crash', async () => {
  const stateFile = tmpState();
  const run = fakeRun({
    'brightnessctl set 937': '',
  });
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    enabled: true, at: 0, timeoutMs: 100, method: 'backlight', savedPct: 47, savedRaw: '937',
  }));
  const restored = await initShades({ run, stateFile, timeoutMs: 100, now: () => 10 * 60_000 });
  assert.equal(restored, true);
  assert.equal(loadShadeState(stateFile), null);
});

test('shades: recovery — state lost while backlight sits at 0', async () => {
  const stateFile = tmpState();
  const run = fakeRun({
    'brightnessctl -m': 'intel_backlight,backlight,0,0%,2000',
    'brightnessctl set 50%': '',
  });
  const msg = await shadesOff({ run, stateFile, now: () => 1 });
  assert.match(msg, /recovery/i);
  assert.ok(run.calls.some((c) => c.join(' ') === 'brightnessctl set 50%'));
});

// ── 4. Status + invariants ──────────────────────────────────────────────────

test("shades: OWNER RULE — default has NO auto-restore, only /shades off", async () => {
  const stateFile = tmpState();
  const run = fakeRun({
    'brightnessctl -m': 'intel_backlight,backlight,937,47%,2000',
    'brightnessctl set 0': '',
    'brightnessctl set 937': '',
  });
  // No timeoutMs passed — must default to 0 = never.
  let t = 1_000_000;
  const onMsg = await shadesOn({ run, stateFile, now: () => t });
  assert.match(onMsg, /koi auto-restore NAHI|no auto-restore/i, 'promise: nothing restores automatically');
  assert.equal(loadShadeState(stateFile).timeoutMs, 0, 'default timer is 0');

  // Hours later — still black. Only the owner's command restores it.
  t += 24 * 60 * 60 * 1000;
  const restored = await maybeAutoRestore({ run, stateFile, now: () => t });
  assert.equal(restored, false, '24 hours later: STILL black');
  assert.equal(loadShadeState(stateFile)?.enabled, true);
  const status = await shadesStatus({ run, stateFile, now: () => t });
  assert.match(status, /auto-restore \*off\*/i, 'status says no auto-restore');

  // The ONLY way back: /shades off.
  const offMsg = await shadesOff({ run, stateFile, now: () => t + 1 });
  assert.match(offMsg, /SHADES OFF/);
  assert.equal(loadShadeState(stateFile), null);
});

test('shades: opt-in timer still works when explicitly configured', async () => {
  const stateFile = tmpState();
  const run = fakeRun({
    'brightnessctl -m': 'intel_backlight,backlight,937,47%,2000',
    'brightnessctl set 0': '',
    'brightnessctl set 937': '',
  });
  let t = 0;
  const onMsg = await shadesOn({ run, stateFile, timeoutMs: 10 * 60_000, now: () => t });
  assert.match(onMsg, /Opt-in auto-restore: 10 min/);
  t += 11 * 60_000;
  assert.equal(await maybeAutoRestore({ run, stateFile, timeoutMs: 10 * 60_000, now: () => t }), true);
  assert.equal(loadShadeState(stateFile), null);
});

test('shades: status reflects state and counts down to auto-restore', async () => {
  const stateFile = tmpState();
  const run = fakeRun({
    'brightnessctl -m': 'intel_backlight,backlight,937,47%,2000',
    'brightnessctl set 0': '',
    'brightnessctl set 937': '',
  });
  let t = 0;
  const off = await shadesStatus({ run, stateFile, now: () => t });
  assert.match(off, /OFF/);
  await shadesOn({ run, stateFile, timeoutMs: 30 * 60_000, now: () => t });
  const on = await shadesStatus({ run, stateFile, now: () => t + 5 * 60_000 });
  assert.match(on, /ON/);
  assert.match(on, /~25 min/);
});

test('shades: never touches the framebuffer — only panel commands', async () => {
  const stateFile = tmpState();
  const run = fakeRun({
    'brightnessctl -m': 'intel_backlight,backlight,937,47%,2000',
    'brightnessctl set 0': '',
    'brightnessctl set 937': '',
  });
  await shadesOn({ run, stateFile, timeoutMs: 0, now: () => 1 });
  await shadesOff({ run, stateFile, now: () => 2 });
  for (const c of run.calls) {
    const line = c.join(' ');
    assert.ok(/^(brightnessctl|xrandr)/.test(line), `only panel-level tools, got: ${line}`);
    assert.ok(!/gnome-screenshot|grim|scrot|maim|import|pipewire/.test(line), 'capture tools untouched');
  }
});

// ── 5. End-to-end: "/shades" must route through the REAL WhatsApp dispatcher ──
// (unit tests above cover shades.js itself; these prove createAgent.handle()
// actually reaches it — the regression that matters after updates).

test('shades: /shades routes end-to-end through createAgent.handle()', async () => {
  const { createAgent } = await import('../src/commands.js');
  const data = { history: [], memory: { facts: [], rules: [] }, todos: [], guests: {} };
  const store = {
    data,
    save() {},
    pushHistory(role, content) { data.history.push({ role, content }); },
    listCronJobs: () => [],
    getLearned: () => null,
  };
  const config = {
    ownerNumber: '911234567890', agentNumber: '919876543210', timezone: 'Asia/Kolkata',
    shellPin: '', dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'shades-data-')),
  };
  const agent = createAgent({ config, store, log: { info() {}, warn() {}, error() {} } });

  // status: no exec needed when shades are off — pure routing proof
  const status = await agent.handle('/shades status', { isOwner: true });
  assert.match(String(status), /Shades/i, '/shades status must reach the shades module');

  // bare /shades: routes into shadesOn (on a test box with no panel tools it
  // returns the honest "nahi chale/failed" message — still proves the route)
  const on = await agent.handle('/shades', { isOwner: true });
  assert.match(String(on), /SHADES (ON|failed)|nahi chale/i, '/shades must reach shadesOn');

  // off + alias work through the same dispatcher
  const off = await agent.handle('/shades off', { isOwner: true });
  assert.match(String(off), /SHADES OFF|already \*OFF\*/i);
  const alias = await agent.handle('/privacy status', { isOwner: true });
  assert.match(String(alias), /Shades/i, '/privacy alias routes too');

  // help must advertise the feature
  const help = await agent.handle('/help', { isOwner: true });
  assert.match(String(help), /\/shades/, 'help lists /shades');
});

test('shades: update announcement is armed for the current release (WhatsApp what\'s-new)', async () => {
  const u = await import('../src/updates.js');
  const version = u.packageVersion();
  assert.ok(version >= '3.4.0', `version ${version}`);
  const changes = u.changesFor(version);
  assert.ok(changes.length >= 3, `announcement has bullets (${changes.length})`);
  assert.ok(changes.some((c) => /Shades|shades/i.test(c)), 'mentions shades');
  assert.ok(changes.some((c) => /shades off|auto-restore/i.test(c)), 'mentions the manual-restore rule');
});

// ── 6. ShadeGuard: brightness changes can NEVER reveal the screen ───────────
// The bug: laptop brightness keys moved the backlight off 0 and instantly
// revealed the panel. The guard clamps every change straight back to 0.

test('guard: a brightness keypress gets clamped back to 0 within one tick', async () => {
  const { shadeGuardTick, startShadeGuard, isGuardActive, stopShadeGuard } = await import('../src/shades.js');
  const stateFile = tmpState();
  // state as left by a real shadesOn (backlight method, saved 47%)
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    enabled: true, at: 0, timeoutMs: 0, method: 'backlight',
    savedPct: 47, savedRaw: '937', device: 'intel_backlight',
  }));

  // Someone presses brightness-up → sysfs now reports 38%
  const run = fakeRun({ 'brightnessctl set 0': '', 'brightnessctl set 937': '' });
  let pct = 38;
  const result = await shadeGuardTick({ run, stateFile, readPct: async () => pct });
  assert.equal(result, 'clamped', 'guard detected the reveal attempt');
  assert.ok(run.calls.some((c) => c.join(' ') === 'brightnessctl set 0'), 'clamped back to 0');

  // Already at 0 → no commands fired
  pct = 0;
  const run2 = fakeRun({ 'brightnessctl set 0': '' });
  const result2 = await shadeGuardTick({ run: run2, stateFile, readPct: async () => pct });
  assert.equal(result2, 'ok');
  assert.equal(run2.calls.length, 0, 'no fork when nothing to clamp');

  // Lifecycle: start/stop
  assert.equal(startShadeGuard({ run, stateFile, readPct: async () => 0, intervalMs: 60_000 }), true);
  assert.equal(isGuardActive(), true);
  stopShadeGuard();
  assert.equal(isGuardActive(), false);
});

test('guard: initShades RE-ARMS the guard after an agent restart (still black)', async () => {
  const { initShades, isGuardActive, stopShadeGuard, shadeGuardTick } = await import('../src/shades.js');
  const stateFile = tmpState();
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    enabled: true, at: 0, timeoutMs: 0, method: 'backlight',
    savedPct: 47, savedRaw: '937', device: 'intel_backlight',
  }));
  const run = fakeRun({ 'brightnessctl set 0': '' });
  const restored = await initShades({ run, stateFile, readPct: async () => 0, intervalMs: 60_000 });
  assert.equal(restored, false, 'no auto-restore on restart (owner rule)');
  assert.equal(isGuardActive(), true, 'guard armed again after restart');
  // and the tick still clamps
  const r = await shadeGuardTick({ run, stateFile, readPct: async () => 22 });
  assert.equal(r, 'clamped');
  stopShadeGuard();
});

test('guard: ticks are inert once shades are off', async () => {
  const { shadeGuardTick, startShadeGuard, isGuardActive, stopShadeGuard } = await import('../src/shades.js');
  const stateFile = tmpState(); // no state file → shades off
  const run = fakeRun({});
  const result = await shadeGuardTick({ run, stateFile, readPct: async () => 55 });
  assert.equal(result, 'off');
  assert.equal(startShadeGuard({ run, stateFile, readPct: async () => 0 }), false);
  assert.equal(isGuardActive(), false);
  stopShadeGuard();
});

// ── 7. Stealth brightness: remote control without breaking stealth ─────────

test('stealth: /pc brightness while shades ON adjusts the SAVED level only', async () => {
  const { shadeAwareBrightness, shadesOn, shadesOff } = await import('../src/shades.js');
  const stateFile = tmpState();
  const run = fakeRun({
    'brightnessctl -m': 'intel_backlight,backlight,937,47%,2000',
    'brightnessctl set 0': '',
    'brightnessctl set 52': '',
    'brightnessctl set 937': '',
  });
  // shades off first → shadeAwareBrightness must defer to normal flow
  assert.equal(await shadeAwareBrightness('set', 80, { run, stateFile }), null);
  await shadesOn({ run, stateFile, timeoutMs: 0, now: () => 1 });
  try {
    const get = await shadeAwareBrightness('get', null, { run, stateFile });
    assert.match(get, /panel \*0%\*/);
    assert.match(get, /47%/);
    const up = await shadeAwareBrightness('up', null, { run, stateFile });
    assert.match(up, /52%/);
    assert.match(up, /BLACK/, 'panel promise stays black');
    const set = await shadeAwareBrightness('set', 80, { run, stateFile });
    assert.match(set, /80%/);
    // panel was NEVER touched by these commands — only the state file moved
    const panelTouched = run.calls.some((c) => /^brightnessctl set (?!0$)/.test(c.join(' ')));
    assert.equal(panelTouched, false, 'no live panel change during stealth');
    // restore level now comes from the stealth-adjusted value (percent path:
    // savedRaw was cleared when the owner moved the level remotely)
    const off = await shadesOff({ run, stateFile, now: () => 2 });
    assert.match(off, /80%/);
    assert.ok(run.calls.some((c) => c.join(' ') === 'brightnessctl set 80%'), 'restores the stealth-adjusted 80%');
  } finally {
    stopShadeGuard();
  }
});
