import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { Mailbox } from '../src/mailbox.js';
import { createAgent } from '../src/commands.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createBridgeServer } from '../src/server.js';
import { parseIntent } from '../src/nlp.js';
import { isSupportedDshNodeVersion } from '../src/harness.js';

function tempWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-dsh-test-'));
  const dataDir = path.join(root, 'data');
  const dshHome = path.join(root, 'dsh-home');
  const projDir = path.join(root, 'project');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(dshHome, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  return {
    root,
    dataDir,
    dshHome,
    projDir,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Lightweight mock `dsh` executable for deterministic fast offline CI when real `@deepseek-ai/dsh` is absent. */
function writeMockDshBinary(dir) {
  const script = path.join(dir, 'mock-dsh.mjs');
  fs.writeFileSync(script, `#!/usr/bin/env node
import readline from 'node:readline';
import http from 'node:http';

const args = process.argv.slice(2);
const profileIdx = args.indexOf('--profile');
const profile = profileIdx >= 0 ? args[profileIdx + 1] : 'sdk';

if (profile === 'web') {
  const portIdx = args.indexOf('--port');
  const reqPort = portIdx >= 0 ? Number(args[portIdx + 1]) : 0;
  const tok = 'test-token-12345';
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
    if (u.searchParams.get('token') === tok) {
      res.writeHead(303, {
        location: './',
        'set-cookie': 'dsh-auth=ok; Path=/; HttpOnly',
      });
      res.end();
      return;
    }
    if ((req.headers.cookie || '').includes('dsh-auth=ok')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><script>window.__DSH_BOOT__={}</script><body>DeepSeek Harness Web</body></html>');
      return;
    }
    res.writeHead(401);
    res.end('unauthorized');
  });
  srv.listen(reqPort, '127.0.0.1', () => {
    process.stdout.write('dsh web: http://127.0.0.1:' + srv.address().port + '/?token=' + tok + '\\n');
  });
} else {
  let turns = 0;
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
  rl.on('line', (line) => {
    if (!line.trim()) return;
    const req = JSON.parse(line);
    if (req.method === 'initialize') {
      send({ jsonrpc: '2.0', id: req.id, result: { serverInfo: { name: 'mock-dsh', version: '0.2.1-test' } } });
      return;
    }
    if (req.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: req.id, result: {} });
      process.exit(0);
    }
    if (req.method === 'session/prompt') {
      turns += 1;
      const sid = req.params.sessionId || 'sess-mock-0001';
      const txt = req.params.contentBlocks.map((c) => c.type === 'text' ? c.text : '[IMAGE:' + c.mimeType + ']').join(' ');
      send({ jsonrpc: '2.0', id: req.id, result: { messageId: 'msg-' + turns } });
      send({
        jsonrpc: '2.0',
        method: 'session.event',
        params: { sessionId: sid, event: { type: 'tool/call', data: { name: 'bash', arguments: { command: 'uname -s' } } } },
      });
      send({
        jsonrpc: '2.0',
        method: 'session.event',
        params: {
          sessionId: sid,
          event: {
            type: 'assistant/message',
            data: { message: { role: 'assistant', content: [{ type: 'text', text: 'DSH_REPLY #' + turns + ': ' + txt }] } },
          },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'session.event',
        params: { sessionId: sid, event: { type: 'turn/end', data: { turn: turns, reason: { kind: 'completed' } } } },
      });
      return;
    }
    if (req.method === 'session/wait' || req.method === 'session/resume' || req.method === 'session/working-directory/set') {
      send({ jsonrpc: '2.0', id: req.id, result: { status: 'idle', cwd: req.params?.path || '' } });
    }
  });
}
`, { mode: 0o755 });
  return script;
}

test('Node version gate + Hinglish DeepSeek Harness intents', () => {
  assert.equal(isSupportedDshNodeVersion('20.18.0'), false);
  assert.equal(isSupportedDshNodeVersion('22.18.2'), false);
  assert.equal(isSupportedDshNodeVersion('22.19.0'), true);
  assert.equal(isSupportedDshNodeVersion('v22.22.3'), true);
  assert.equal(isSupportedDshNodeVersion('24.1.0'), true);

  assert.deepEqual(parseIntent('deepseek harness status'), { cmd: 'dsh', args: 'status' });
  assert.deepEqual(parseIntent('harness web kholo'), { cmd: 'dsh', args: 'web open' });
  assert.deepEqual(parseIntent('dsh web band karo'), { cmd: 'dsh', args: 'web stop' });
  assert.deepEqual(parseIntent('dsh se repo ke sare tests chala ke dikhao'), {
    cmd: 'dsh',
    args: 'repo ke sare tests chala ke dikhao',
  });
});

test('Observer MCP stdio server + live Bridge /api/whatsapp/send outbound delivery', async () => {
  const ws = tempWorkspace();
  const outbound = [];
  const config = loadConfig({
    dryRun: true,
    env: {
      OWNER_NUMBER: '919528923866',
      AGENT_NUMBER: '918859555795',
      DATA_DIR: ws.dataDir,
      DSH_HOME: ws.dshHome,
      PORT: '0',
      HOST: '127.0.0.1',
    },
  });
  const store = new Store(config.storeFile);
  store.data.notes.push({ id: 1, text: 'Deploy Fedora build', ts: Date.now() });
  store.saveNow();

  const mailbox = new Mailbox({ waitMs: 500 });
  const agent = createAgent({ config, store, notify: (m) => outbound.push(m) });
  const fakeWa = {
    state: { pairingCode: null, lastQr: null },
    status: () => 'dry-run',
    sendToOwner: async (msg) => { outbound.push(msg); },
    simulate: async () => ({ ok: true }),
  };
  const bridge = createBridgeServer({
    config,
    store,
    whatsapp: fakeWa,
    mailbox,
    actions: agent.actions,
    harness: agent.harness,
    runOwner: (t) => agent.handle(t),
  });
  const httpSrv = await bridge.start();
  const actualPort = httpSrv.address().port;

  const mcp = spawn(process.execPath, [path.resolve('src/mcp-server.js')], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      OBSERVER_BRIDGE_HOST: '127.0.0.1',
      OBSERVER_BRIDGE_PORT: String(actualPort),
      OBSERVER_BRIDGE_TOKEN: config.bridgeToken,
      OBSERVER_DATA_DIR: ws.dataDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rl = readline.createInterface({ input: mcp.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let idSeq = 1;
  rl.on('line', (l) => {
    if (!l.trim()) return;
    const m = JSON.parse(l);
    if (pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const rpc = (method, params = {}) => new Promise((resolve) => {
    const id = idSeq++;
    pending.set(id, resolve);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  try {
    const init = await rpc('initialize', { protocolVersion: '2024-11-05' });
    assert.equal(init.result.serverInfo.name, 'observer-whatsapp-linux');

    const toolsList = await rpc('tools/list');
    const names = toolsList.result.tools.map((t) => t.name);
    assert.ok(names.includes('whatsapp_send_message'));
    assert.ok(names.includes('whatsapp_send_file'));
    assert.ok(names.includes('pc_screenshot'));

    const reportPath = path.join(ws.projDir, 'summary.txt');
    fs.writeFileSync(reportPath, 'Fedora full power summary\n');

    const rMsg = await rpc('tools/call', {
      name: 'whatsapp_send_message',
      arguments: { text: 'Hello live from DeepSeek Harness MCP!' },
    });
    assert.equal(rMsg.result.isError, false);

    const rFile = await rpc('tools/call', {
      name: 'whatsapp_send_file',
      arguments: { filePath: reportPath, caption: 'Build artifact' },
    });
    assert.equal(rFile.result.isError, false);

    const rMem = await rpc('tools/call', {
      name: 'observer_memory',
      arguments: { op: 'summary' },
    });
    assert.match(rMem.result.content[0].text, /Deploy Fedora build/);

    assert.equal(outbound[0], 'Hello live from DeepSeek Harness MCP!');
    assert.equal(outbound[1].fileName, 'summary.txt');
  } finally {
    rl.close();
    mcp.kill('SIGTERM');
    httpSrv.closeAllConnections?.();
    bridge.stop();
    await agent.harness.close();
    ws.cleanup();
  }
});

test('Full WhatsApp `/dsh` suite, auto-route, image passthrough, and Web UI tunnel', async () => {
  const ws = tempWorkspace();
  const realDsh = process.env.DSH_BIN && fs.existsSync(process.env.DSH_BIN) ? process.env.DSH_BIN : null;

  // When real `@deepseek-ai/dsh` is present, start a local OpenAI-compatible mock brain
  // that exercises BOTH native `bash` tool AND `mcp__observer__whatsapp_send_message`!
  let mockLlm = null;
  let mockLlmPort = 0;
  if (realDsh) {
    let calls = 0;
    mockLlm = http.createServer(async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      const body = JSON.parse(raw || '{}');
      calls += 1;
      const lastRole = body.messages?.[body.messages.length - 1]?.role;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const base = { id: `cmpl_${calls}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'test-model' };
      if (lastRole === 'user') {
        const deltaCalls = [
          {
            index: 0,
            id: `bash_${calls}`,
            type: 'function',
            function: {
              name: 'bash',
              arguments: JSON.stringify({ description: 'Check Linux kernel', command: 'echo LINUX_POWER_OK' }),
            },
          },
          {
            index: 1,
            id: `mcp_${calls}`,
            type: 'function',
            function: {
              name: 'mcp__observer__whatsapp_send_message',
              arguments: JSON.stringify({ text: 'Live push from real DSH!' }),
            },
          },
        ];
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: deltaCalls }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: `REAL_DSH_VERIFIED_TURN_${calls}` }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    });
    await new Promise((r) => mockLlm.listen(0, '127.0.0.1', r));
    mockLlmPort = mockLlm.address().port;
  }

  const dshBin = realDsh || writeMockDshBinary(ws.root);
  const progressNotes = [];
  const outbound = [];

  const config = loadConfig({
    dryRun: true,
    env: {
      OWNER_NUMBER: '919528923866',
      AGENT_NUMBER: '918859555795',
      DATA_DIR: ws.dataDir,
      DSH_HOME: ws.dshHome,
      DSH_BIN: dshBin,
      DSH_WEB_PORT: '0',
      DSH_REMOTE_PORT: '0',
      GROQ_API_KEY: 'gsk_test_key_sync',
      ...(mockLlmPort ? {
        DSH_CUSTOM_BASE_URL: `http://127.0.0.1:${mockLlmPort}/v1`,
        DSH_CUSTOM_API_KEY: 'local-test',
        DSH_CUSTOM_MODEL: 'test-model',
      } : {}),
      PORT: '0',
      HOST: '127.0.0.1',
    },
  });

  const store = new Store(config.storeFile);
  const mailbox = new Mailbox({ waitMs: 500 });
  const agent = createAgent({ config, store, notify: (m) => progressNotes.push(m) });
  const fakeWa = {
    state: { pairingCode: null, lastQr: null },
    status: () => 'dry-run',
    sendToOwner: async (msg) => { outbound.push(msg); },
    simulate: async () => ({ ok: true }),
  };
  const bridge = createBridgeServer({
    config,
    store,
    whatsapp: fakeWa,
    mailbox,
    actions: agent.actions,
    harness: agent.harness,
    runOwner: (t) => agent.handle(t),
  });
  const srv = await bridge.start();
  config.port = srv.address().port;

  try {
    // 1. Status + patch YAML + 0600 credentials check
    const stReply = await agent.handle('/dsh status');
    assert.match(stReply, /DeepSeek Harness/);
    const patchYaml = fs.readFileSync(path.join(ws.dshHome, 'observer.patch.yml'), 'utf8');
    assert.match(patchYaml, /mcp-observer/);
    assert.match(patchYaml, /observer-groq/);

    // 2. Working directory + task execution with attached image
    const cdReply = await agent.handle(`/dsh cd ${ws.projDir}`);
    assert.match(cdReply, new RegExp(ws.projDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const taskReply = await agent.handle('/dsh check system and report', {
      mediaMeta: {
        buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
        savedPath: path.join(ws.projDir, 'screen.png'),
        mimeType: 'image/png',
        mediaKind: 'image',
      },
    });

    if (realDsh) {
      assert.match(taskReply, /REAL_DSH_VERIFIED_TURN_/);
      assert.equal(outbound[0], 'Live push from real DSH!');
    } else {
      assert.match(taskReply, /DSH_REPLY #1/);
      assert.match(taskReply, /\[IMAGE:image\/png\]/);
    }

    // 3. Auto-route mode routes plain WhatsApp messages straight to DeepSeek Harness
    await agent.handle('/dsh auto on');
    assert.equal(agent.isHarnessAuto(), true);
    const plainReply = await agent.handle('now build the second step in the same session');
    assert.match(plainReply, /DeepSeek Harness · session/);

    const sessionsReply = await agent.handle('/dsh sessions');
    assert.match(sessionsReply, /Recent DeepSeek Harness Sessions/);

    await agent.handle('/dsh auto off');
    assert.equal(agent.isHarnessAuto(), false);

    // 4. Official `dsh web` startup + cookie handshake verification
    const webReply = await agent.handle('/dsh web');
    assert.match(webReply, /http:\/\/127\.0\.0\.1:\d+\/\?token=/);
    const urlMatch = webReply.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/);
    assert.ok(urlMatch, 'printed authenticated local Web UI URL');

    const r1 = await fetch(urlMatch[0], { redirect: 'manual' });
    assert.equal(r1.status, 303);
    const cookie = r1.headers.get('set-cookie').split(';')[0];
    const r2 = await fetch(new URL(r1.headers.get('location'), urlMatch[0]), { headers: { cookie } });
    assert.equal(r2.status, 200);
    assert.match(await r2.text(), /__DSH_BOOT__/);
  } finally {
    srv.closeAllConnections?.();
    bridge.stop();
    await agent.harness.close();
    if (mockLlm) { mockLlm.closeAllConnections?.(); mockLlm.close(); }
    ws.cleanup();
  }
});
