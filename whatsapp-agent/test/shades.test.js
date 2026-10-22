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
  loadShadeState,
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

test('shades: update announcement is armed for 3.4.0 (WhatsApp what\'s-new)', async () => {
  const u = await import('../src/updates.js');
  assert.equal(u.packageVersion(), '3.4.0');
  const changes = u.changesFor('3.4.0');
  assert.ok(changes.length >= 4, `announcement has bullets (${changes.length})`);
  assert.ok(changes.some((c) => /Neural/i.test(c)), 'mentions neural brain');
  assert.ok(changes.some((c) => /Shades/i.test(c)), 'mentions shades');
});
