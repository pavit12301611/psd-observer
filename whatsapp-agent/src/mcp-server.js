#!/usr/bin/env node
// mcp-server.js — Native Model Context Protocol (MCP) server ("observer")
// mounted directly inside DeepSeek Harness (`dsh --profile sdk` AND `dsh web`).
//
// Gives EVERY DeepSeek Harness session (both WhatsApp `/dsh` tasks AND browser
// `dsh web` sessions on Fedora Linux) native access to:
//   • Outbound WhatsApp delivery (`whatsapp_send_message`, `whatsapp_send_file`,
//     `whatsapp_send_screenshot`)
//   • Real Fedora desktop vision (`pc_screenshot` returning MCP `image` + OCR)
//   • Fedora desktop GUI automation (`pc_ui_act`: open apps/URLs, list/focus
//     windows, OCR `tap_text`, coordinate `click`, `type`, `paste`, `key`, `scroll`)
//   • Full Observer action catalog (`observer_action`: all 60+ PC/system/hardware
//     actions via local bridge IPC)
//   • Shared Observer memory, notes, to-dos, & WhatsApp downloads (`observer_memory`)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import * as pc from './pccontrol.js';
import * as apps from './apps.js';
import * as systemx from './systemx.js';
import * as ocr from './ocr.js';
import * as finder from './elementfinder.js';
import * as reach from './reach.js';
import * as grounding from './grounding.js';

const BRIDGE_HOST = process.env.OBSERVER_BRIDGE_HOST || '127.0.0.1';
const BRIDGE_PORT = Number(process.env.OBSERVER_BRIDGE_PORT || process.env.PORT || 8787);
const BRIDGE_TOKEN = process.env.OBSERVER_BRIDGE_TOKEN || process.env.BRIDGE_TOKEN || '';
const DATA_DIR = path.resolve(process.env.OBSERVER_DATA_DIR || process.env.DATA_DIR || './data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

function readStoreData() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    return { memory: [], notes: [], todos: [], downloads: [] };
  }
}

async function callBridge(endpoint, body = {}) {
  const res = await fetch(`http://${BRIDGE_HOST}:${BRIDGE_PORT}${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(BRIDGE_TOKEN ? { 'x-bridge-token': BRIDGE_TOKEN } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.detail || `Observer bridge HTTP ${res.status}`);
  }
  return data;
}

const TOOLS = [
  {
    name: 'whatsapp_send_message',
    description: 'Send a live WhatsApp text message directly to the owner on WhatsApp (works from both WhatsApp tasks and browser dsh web sessions).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message text to send on WhatsApp (supports *bold*, _italic_, ```code```).' },
      },
      required: ['text'],
    },
  },
  {
    name: 'whatsapp_send_file',
    description: 'Send any local file, PDF, ZIP, image, video, or generated artifact from the Linux PC straight to the owner on WhatsApp.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute or ~ path to the file on the Linux PC.' },
        caption: { type: 'string', description: 'Optional WhatsApp caption.' },
        asImage: { type: 'boolean', description: 'Send inline as an image if true (auto-detected from extension by default).' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'whatsapp_send_screenshot',
    description: 'Capture a real Fedora desktop screenshot right now and deliver it immediately to the owner on WhatsApp.',
    inputSchema: {
      type: 'object',
      properties: {
        caption: { type: 'string', description: 'Optional caption for the screenshot.' },
      },
    },
  },
  {
    name: 'pc_screenshot',
    description: 'Capture the live Fedora Linux desktop screen and return BOTH the image (for vision models) and optional Tesseract OCR text with screen dimensions.',
    inputSchema: {
      type: 'object',
      properties: {
        includeOcr: { type: 'boolean', description: 'Also run offline Tesseract OCR on the screen (default true).' },
      },
    },
  },
  {
    name: 'pc_ui_act',
    description: 'Control the Fedora Linux desktop GUI: launch apps/URLs, list or focus windows, click visible on-screen text via OCR (`tap_text`), click coordinates, type/paste text, press keyboard shortcuts, or scroll.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open_app', 'open_url', 'list_apps', 'list_windows', 'focus_window', 'tap_text', 'click', 'type', 'paste', 'key', 'scroll'],
          description: 'Desktop GUI action to run.',
        },
        target: { type: 'string', description: 'App name, URL, window title, or visible button/link text for `tap_text`.' },
        x: { type: 'number', description: 'X coordinate in pixels for `click`.' },
        y: { type: 'number', description: 'Y coordinate in pixels for `click`.' },
        text: { type: 'string', description: 'Text to type or paste.' },
        key: { type: 'string', description: 'Keyboard combo such as "Return", "ctrl+l", "ctrl+w", "alt+Tab".' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction for `scroll`.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'pc_system',
    description: 'Inspect or control Fedora Linux hardware & desktop settings: status, top, volume, brightness, wifi, bluetooth, clipboard_get, clipboard_set, notify.',
    inputSchema: {
      type: 'object',
      properties: {
        what: {
          type: 'string',
          enum: ['status', 'top', 'volume', 'brightness', 'wifi', 'bluetooth', 'clipboard_get', 'clipboard_set', 'notify'],
        },
        value: { type: 'string', description: 'Optional argument (e.g. "50", "up", "down", "mute", "on", "off", or clipboard/notification text).' },
      },
      required: ['what'],
    },
  },
  {
    name: 'observer_action',
    description: 'Run any named Observer Agent action directly via the local Observer bridge (e.g. webcam_photo, record_screen, battery, disk_usage, network_ip, weather, news).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Observer action name.' },
        args: { type: 'object', description: 'Action arguments object.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'observer_memory',
    description: 'Read or update shared Observer WhatsApp memory, quick notes, to-dos, and files recently sent from the owner\'s phone (`downloads`).',
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['summary', 'downloads', 'remember', 'note_add', 'todo_add'],
          description: 'Memory operation.',
        },
        text: { type: 'string', description: 'Fact, note, or to-do text when adding.' },
      },
      required: ['op'],
    },
  },
  {
    name: 'solve_question_image',
    description: 'Solve exam / math / physics / coding / SQL / MCQ questions from an image path, live PC screen (`screen: true`), or question text using HD zoom tiling + OCR + Python/SymPy + real compilers + live fact search + independent adversarial audit.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Optional path to question image or PDF' },
        screen: { type: 'boolean', description: 'Capture and solve questions on live PC screen' },
        text: { type: 'string', description: 'Optional typed question text' },
        instructions: { type: 'string', description: 'Optional instructions (e.g. "Solve Q3 & Q4 in Hinglish")' },
      },
    },
  },
  {
    name: 'agent_reach',
    description: 'Zero-guesswork Agent-Reach internet router: read any URL cleanly as Markdown (`op="read"`), search the web (`op="search"`), run multi-platform research (`op="research"`), extract YouTube video transcripts or play directly (`op="youtube"`), query GitHub repos/issues/PRs (`op="github"`), query Reddit/Twitter/HN/StackOverflow/RSS (`op="social"`), or run `op="doctor"`.',
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['read', 'search', 'research', 'youtube', 'github', 'reddit', 'twitter', 'hackernews', 'stackoverflow', 'rss', 'doctor'],
          description: 'Agent-Reach operation.',
        },
        query: { type: 'string', description: 'URL, search query, topic, or owner/repo.' },
        mode: { type: 'string', description: 'Optional sub-mode (e.g. "play" or "transcript" for youtube).' },
      },
      required: ['op'],
    },
  },
  {
    name: 'pc_inspect_ui',
    description: 'Agent-S Desktop Grounding Inspector: inspect the active Linux desktop window and list interactive UI widgets from the AT-SPI accessibility tree + OCR text bounding boxes with exact pixel coordinates (no coordinate guessing).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

const expandHome = (p) => (String(p || '').startsWith('~/')
  ? path.join(os.homedir(), String(p).slice(2))
  : path.resolve(String(p || '.')));

async function handleToolCall(name, args = {}) {
  switch (name) {
    case 'whatsapp_send_message': {
      const res = await callBridge('/api/whatsapp/send', {
        kind: 'text',
        text: String(args.text ?? ''),
      });
      return [{ type: 'text', text: `Sent WhatsApp message (${res.via || 'whatsapp'}): ${String(args.text ?? '').slice(0, 140)}` }];
    }

    case 'whatsapp_send_file': {
      const filePath = expandHome(args.filePath);
      if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
      const res = await callBridge('/api/whatsapp/send', {
        kind: 'file',
        filePath,
        caption: args.caption || '',
        asImage: Boolean(args.asImage),
      });
      return [{ type: 'text', text: `Sent file to WhatsApp (${res.via || 'whatsapp'}): ${filePath}` }];
    }

    case 'whatsapp_send_screenshot': {
      const res = await callBridge('/api/whatsapp/send', {
        kind: 'screenshot',
        caption: args.caption || '📸 Fedora Desktop',
      });
      return [{ type: 'text', text: `Captured and sent desktop screenshot to WhatsApp (${res.via || 'whatsapp'}).` }];
    }

    case 'pc_screenshot': {
      const buf = await pc.captureScreenshot({ portalTimeoutMs: 30_000 });
      const size = finder.pngSize(buf) ?? { width: 0, height: 0 };
      let summary = `Screen captured (${size.width || '?'}x${size.height || '?'}, ${buf.length} bytes).`;
      if (args.includeOcr !== false) {
        try {
          const text = await ocr.ocrImage(buf);
          if (text?.trim()) summary += `\n\nVisible OCR text:\n${text.trim().slice(0, 3000)}`;
        } catch { /* OCR optional */ }
      }
      return [
        { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: summary },
      ];
    }

    case 'pc_ui_act': {
      const act = String(args.action || '');
      if (act === 'list_apps') {
        const list = apps.appList(apps.discoverApps(), 100);
        return [{ type: 'text', text: list.map((a) => `${a.name} (${a.exec || ''})`).join('\n') || 'No desktop apps found.' }];
      }
      if (act === 'open_app') {
        const out = await apps.launchApp(String(args.target || ''));
        return [{ type: 'text', text: out.text }];
      }
      if (act === 'open_url') {
        return [{ type: 'text', text: await pc.openTarget(String(args.target || '')) }];
      }
      if (act === 'list_windows') {
        const wins = await apps.listWindows();
        return [{ type: 'text', text: typeof wins === 'string' ? wins : JSON.stringify(wins, null, 2) }];
      }
      if (act === 'focus_window') {
        return [{ type: 'text', text: await apps.windowAction('focus', String(args.target || '')) }];
      }
      if (act === 'tap_text') {
        const hit = await finder.locateOnScreen({}, String(args.target || ''), console);
        await pc.click(hit.x, hit.y);
        return [{ type: 'text', text: `Clicked "${hit.matched || args.target}" at (${hit.x}, ${hit.y}).` }];
      }
      if (act === 'click') {
        return [{ type: 'text', text: await pc.click(Number(args.x) || 0, Number(args.y) || 0) }];
      }
      if (act === 'type') {
        return [{ type: 'text', text: await pc.typeText(String(args.text ?? '')) }];
      }
      if (act === 'paste') {
        return [{ type: 'text', text: await pc.pasteText(String(args.text ?? '')) }];
      }
      if (act === 'key') {
        return [{ type: 'text', text: await pc.keyCombo(String(args.key || 'Return')) }];
      }
      if (act === 'scroll') {
        return [{ type: 'text', text: await pc.scrollMouse(args.direction === 'up' ? 'up' : 'down', 5) }];
      }
      throw new Error(`Unknown pc_ui_act action: ${act}`);
    }

    case 'pc_system': {
      const what = String(args.what || 'status');
      const val = String(args.value ?? '').trim();
      let out = '';
      if (what === 'status') out = await systemx.uptimeInfo();
      else if (what === 'top') out = await pc.topProcesses();
      else if (what === 'volume') {
        out = /^\d+$/.test(val) ? await pc.volume('set', Number(val)) : await pc.volume(val || 'get');
      } else if (what === 'brightness') {
        out = /^\d+$/.test(val) ? await pc.brightness('set', Number(val)) : await pc.brightness(val || 'get');
      } else if (what === 'wifi') {
        out = ['on', 'off'].includes(val.toLowerCase()) ? await systemx.wifiSet(val.toLowerCase()) : await systemx.wifiStatus();
      } else if (what === 'bluetooth') {
        out = ['on', 'off'].includes(val.toLowerCase()) ? await systemx.bluetoothSet(val.toLowerCase()) : await systemx.bluetoothStatus();
      } else if (what === 'clipboard_get') out = await pc.clipboardGet();
      else if (what === 'clipboard_set') out = await pc.clipboardSet(val);
      else if (what === 'notify') out = await pc.desktopNotify('DeepSeek Harness', val || 'Task update');
      else throw new Error(`Unknown pc_system query: ${what}`);
      return [{ type: 'text', text: String(out) }];
    }

    case 'solve_question_image': {
      const payload = { instructions: String(args.instructions || '') };
      if (args.screen) {
        payload.screen = true;
      } else if (args.filePath) {
        const filePath = expandHome(args.filePath);
        if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
        payload.imageBase64 = fs.readFileSync(filePath).toString('base64');
        payload.fileName = path.basename(filePath);
      } else if (args.text) {
        payload.text = String(args.text);
      } else {
        throw new Error('Provide filePath, screen: true, or text.');
      }
      const data = await callBridge('/api/solve', payload);
      return [{ type: 'text', text: data.text || JSON.stringify(data) }];
    }

    case 'agent_reach': {
      const op = String(args.op || 'doctor').toLowerCase();
      const q = String(args.query || '').trim();
      if (op === 'doctor') return [{ type: 'text', text: (await reach.reachDoctor()).text }];
      if (op === 'read') return [{ type: 'text', text: (await reach.reachUrl(q)).text }];
      if (op === 'search') return [{ type: 'text', text: (await reach.webSearch(q)).text }];
      if (op === 'research') return [{ type: 'text', text: (await reach.reachResearch(q)).text }];
      if (op === 'github') return [{ type: 'text', text: (await reach.githubLookup(q, { mode: args.mode || 'auto' })).text }];
      if (op === 'reddit') return [{ type: 'text', text: (await reach.redditLookup(q)).text }];
      if (op === 'twitter') return [{ type: 'text', text: (await reach.twitterLookup(q)).text }];
      if (op === 'hackernews') return [{ type: 'text', text: (await reach.hackerNewsLookup(q)).text }];
      if (op === 'stackoverflow') return [{ type: 'text', text: (await reach.stackOverflowLookup(q)).text }];
      if (op === 'rss') return [{ type: 'text', text: (await reach.rssLookup(q)).text }];
      if (op === 'youtube') {
        if (args.mode === 'play') {
          const s = await reach.youtubeSearch(q, { limit: 1 });
          const top = s.videos?.[0];
          if (!top) throw new Error(`No YouTube video found for "${q}"`);
          await pc.openTarget(top.url);
          return [{ type: 'text', text: `Playing YouTube video: ${top.title} (${top.url})` }];
        }
        if (args.mode === 'transcript' || /^https?:\/\//i.test(q) || reach.extractYoutubeId(q)) {
          return [{ type: 'text', text: (await reach.reachUrl(q)).text }];
        }
        const s = await reach.youtubeSearch(q, { limit: 5 });
        return [{ type: 'text', text: JSON.stringify(s, null, 2) }];
      }
      throw new Error(`Unsupported agent_reach op: ${op}`);
    }

    case 'pc_inspect_ui': {
      const desktop = await grounding.inspectDesktopElements({ timeoutMs: 2500 });
      return [{ type: 'text', text: JSON.stringify(desktop, null, 2) }];
    }

    case 'observer_action': {
      const data = await callBridge('/api/action', {
        name: String(args.name || ''),
        args: args.args || {},
      });
      return [{ type: 'text', text: data.text || JSON.stringify(data) }];
    }

    case 'observer_memory': {
      const op = String(args.op || 'summary');
      if (op === 'remember' && args.text) {
        await callBridge('/api/chat', { text: `/remember ${args.text}` });
        return [{ type: 'text', text: `Saved to Observer memory: ${args.text}` }];
      }
      if (op === 'note_add' && args.text) {
        await callBridge('/api/chat', { text: `/note add ${args.text}` });
        return [{ type: 'text', text: `Added Observer note: ${args.text}` }];
      }
      if (op === 'todo_add' && args.text) {
        await callBridge('/api/chat', { text: `/todo add ${args.text}` });
        return [{ type: 'text', text: `Added Observer to-do: ${args.text}` }];
      }
      const data = readStoreData();
      if (op === 'downloads') {
        const list = (data.downloads || []).slice(-20);
        return [{
          type: 'text',
          text: list.length
            ? list.map((d) => `${path.join(DATA_DIR, 'downloads', d.file)} (${d.kind || 'file'}, ${new Date(d.ts || Date.now()).toISOString()})`).join('\n')
            : `No files recorded yet in ${path.join(DATA_DIR, 'downloads')}.`,
        }];
      }
      return [{
        type: 'text',
        text: JSON.stringify({
          memory: Object.values(data.facts || {}),
          facts: data.facts || {},
          rules: data.rules || [],
          notes: (data.notes || []).slice(-20),
          todos: (data.todos || []).filter((t) => !t.done),
          recentDownloads: (data.downloads || []).slice(-10),
        }, null, 2),
      }];
    }

    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (req.id === undefined || req.id === null) return;

  try {
    switch (req.method) {
      case 'initialize':
        send({
          jsonrpc: '2.0',
          id: req.id,
          result: {
            protocolVersion: req.params?.protocolVersion || '2024-11-05',
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: 'observer-whatsapp-linux', version: '2.9.0' },
          },
        });
        break;

      case 'ping':
        send({ jsonrpc: '2.0', id: req.id, result: {} });
        break;

      case 'resources/list':
        send({
          jsonrpc: '2.0',
          id: req.id,
          result: {
            resources: [
              {
                uri: 'observer://memory',
                name: 'Observer Shared WhatsApp Memory & Downloads',
                mimeType: 'application/json',
              },
            ],
          },
        });
        break;

      case 'resources/templates/list':
        send({ jsonrpc: '2.0', id: req.id, result: { resourceTemplates: [] } });
        break;

      case 'resources/read':
        send({
          jsonrpc: '2.0',
          id: req.id,
          result: {
            contents: [{
              uri: req.params?.uri || 'observer://memory',
              mimeType: 'application/json',
              text: JSON.stringify(readStoreData(), null, 2),
            }],
          },
        });
        break;

      case 'tools/list':
        send({ jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } });
        break;

      case 'tools/call': {
        try {
          const content = await handleToolCall(req.params?.name, req.params?.arguments || {});
          send({ jsonrpc: '2.0', id: req.id, result: { content, isError: false } });
        } catch (err) {
          send({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              content: [{ type: 'text', text: `Observer MCP error: ${err?.message || String(err)}` }],
              isError: true,
            },
          });
        }
        break;
      }

      default:
        send({
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        });
    }
  } catch (err) {
    send({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32603, message: err?.message || String(err) },
    });
  }
});
