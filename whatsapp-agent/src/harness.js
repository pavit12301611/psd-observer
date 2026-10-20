// harness.js — DeepSeek Harness (`@deepseek-ai/dsh`) native Linux + WhatsApp
// full-power integration for Observer Agent.
//
// Architecture:
//   1. `SdkRuntime`: keeps a warm persistent `dsh --profile sdk --patch ...`
//      JSON-RPC 2.0 daemon alive over stdio (`DSH_PERMISSION_MODE=danger-full-access`
//      by default, switchable to `workspace-write` or `read-only`).
//      Every WhatsApp `/dsh <task>` (or plain message when `/dsh auto on` is
//      enabled) runs inside the real DeepSeek Harness agent runtime with ALL
//      native coding/system tools (`bash`, `read_file`, `write_file`,
//      `edit_file`, `glob`, `grep`, `subagent`, `skill`, `cron`, `lsp`,
//      `notebook_edit`) PLUS Observer's live MCP server (`mcp-observer`:
//      WhatsApp send text/file/screenshot, Fedora desktop screenshot + OCR,
//      GUI automation, hardware controls, and shared Observer memory).
//
//   2. `WebRuntime`: runs the official DeepSeek Harness Web UI on Linux
//      (`dsh --profile web --patch ... --port 3080 --no-open --trusted-host ...`)
//      alongside an authenticated HTTP + WebSocket upgrade tunnel proxy on
//      `0.0.0.0:3081` so both the Fedora desktop browser AND the owner's phone
//      (over Wi-Fi or Tailscale) open the exact same official DeepSeek Harness
//      Web UI sharing `$DSH_HOME` sessions, trajectories, and MCP tools live!

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StoppedError } from './cancel.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AGENT_ROOT = path.resolve(__dirname, '..');
const MCP_SERVER_PATH = path.resolve(__dirname, 'mcp-server.js');

export const PERMISSION_MODES = {
  full: 'danger-full-access',
  'danger-full-access': 'danger-full-access',
  safe: 'workspace-write',
  'workspace-write': 'workspace-write',
  readonly: 'read-only',
  'read-only': 'read-only',
};

const NODE_PORTABLE_VERSION = 'v22.22.0';

/** Check whether a semantic version string satisfies `>=22.19.0 <23 || >=24.0.0`. */
export function isSupportedDshNodeVersion(ver) {
  const clean = String(ver ?? '').trim().replace(/^v/i, '');
  const [maj, min] = clean.split('.').map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(maj) || !Number.isFinite(min)) return false;
  if (maj >= 24) return true;
  if (maj === 22 && min >= 19) return true;
  return false;
}

function probeNodeBinary(bin) {
  if (!bin) return null;
  try {
    const out = execFileSync(bin, ['-p', 'process.versions.node'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { bin, version: out, supported: isSupportedDshNodeVersion(out) };
  } catch {
    return null;
  }
}

/** Find a Node binary on Linux that satisfies DeepSeek Harness (`>=22.19 || >=24`). */
export function findSupportedNode(preferredBin = '') {
  const home = os.homedir();
  const candidates = [];
  if (preferredBin) candidates.push(preferredBin);
  if (process.env.DSH_NODE_BIN) candidates.push(process.env.DSH_NODE_BIN);
  candidates.push(process.execPath);
  candidates.push(path.join(home, '.local/share/observer-node/bin/node'));

  // Check common Linux version managers so systemd user services find Node 22/24 too.
  for (const nvmRoot of [
    path.join(home, '.nvm/versions/node'),
    path.join(home, '.local/share/fnm/node-versions'),
  ]) {
    try {
      const dirs = fs.readdirSync(nvmRoot).sort().reverse();
      for (const d of dirs) {
        candidates.push(path.join(nvmRoot, d, 'bin/node'));
        candidates.push(path.join(nvmRoot, d, 'installation/bin/node'));
      }
    } catch { /* ignore */ }
  }
  candidates.push(
    path.join(home, '.volta/bin/node'),
    '/usr/local/bin/node',
    '/usr/bin/node',
  );

  const seen = new Set();
  let bestUnsupported = null;
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    const info = probeNodeBinary(c);
    if (!info) continue;
    if (info.supported) return info;
    if (!bestUnsupported) bestUnsupported = info;
  }
  return bestUnsupported;
}

/** Locate installed `dsh` CLI script across override, managed prefix, local, or PATH. */
export function findDshBinary(config = {}) {
  const home = os.homedir();
  const prefix = config.dshInstallDir || path.join(home, '.local/share/observer-harness');
  const candidates = [
    config.dshBin,
    process.env.DSH_BIN,
    path.join(prefix, 'node_modules/.bin/dsh'),
    path.join(AGENT_ROOT, 'node_modules/.bin/dsh'),
    path.join(home, '.local/bin/dsh'),
    '/usr/local/bin/dsh',
    '/usr/bin/dsh',
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return fs.realpathSync(c);
    } catch { /* ignore */ }
  }
  try {
    const whichOut = execFileSync('sh', ['-lc', 'command -v dsh'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (whichOut && fs.existsSync(whichOut)) return fs.realpathSync(whichOut);
  } catch { /* ignore */ }
  return null;
}

function readDshVersion(dshRealPath) {
  if (!dshRealPath) return null;
  try {
    let dir = path.dirname(dshRealPath);
    for (let i = 0; i < 5; i += 1) {
      const pkgFile = path.join(dir, 'package.json');
      if (fs.existsSync(pkgFile)) {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
        if (pkg.name === '@deepseek-ai/dsh' && pkg.version) return pkg.version;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* ignore */ }
  return 'installed';
}

function resolveNodeModulesDir(dshRealPath) {
  if (!dshRealPath) return '';
  let dir = path.dirname(dshRealPath);
  for (let i = 0; i < 6; i += 1) {
    if (path.basename(dir) === 'node_modules') return dir;
    const nm = path.join(dir, 'node_modules');
    if (fs.existsSync(nm)) return nm;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

function localIpv4Addresses() {
  const out = new Set();
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const n of entries || []) {
      if (n && n.family === 'IPv4' && !n.internal && n.address) out.add(n.address);
    }
  }
  return [...out];
}

function yamlStr(val) {
  return JSON.stringify(String(val ?? ''));
}

function formatToolProgress(name, args = {}) {
  const short = (s, max = 72) => {
    const clean = String(s ?? '').replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max)}…` : clean;
  };
  if (name === 'bash') return `💻 \`$ ${short(args.command || args.description || 'bash')}\``;
  if (name === 'read_file') return `📖 Read \`${short(args.file_path || args.path || '')}\``;
  if (name === 'write_file') return `📝 Write \`${short(args.file_path || args.path || '')}\``;
  if (name === 'edit_file') return `✏️ Edit \`${short(args.file_path || args.path || '')}\``;
  if (name === 'glob' || name === 'grep') return `🔎 Search \`${short(args.pattern || '')}\``;
  if (name === 'subagent') return `🤖 Subagent: ${short(args.description || args.prompt || 'working')}`;
  if (name.startsWith('mcp__observer__')) {
    return `📱 Observer · \`${name.replace(/^mcp__observer__/, '')}\``;
  }
  return `🔧 \`${short(name, 48)}\``;
}

/** Parse Simple YAML `KEY: "VALUE"` lines in `$DSH_HOME/.credentials.yaml` without clobbering user entries. */
function readCredentialsMap(credFile) {
  const map = new Map();
  try {
    const raw = fs.readFileSync(credFile, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith('\'') && val.endsWith('\''))) {
        try { val = JSON.parse(val); } catch { val = val.slice(1, -1); }
      }
      map.set(m[1], val);
    }
  } catch { /* missing */ }
  return map;
}

function writeCredentialsMap(credFile, entries) {
  fs.mkdirSync(path.dirname(credFile), { recursive: true });
  const lines = ['# Managed by Observer WhatsApp Agent + DeepSeek Harness (0600)'];
  for (const [k, v] of entries.entries()) {
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      lines.push(`${k}: ${yamlStr(v)}`);
    }
  }
  fs.writeFileSync(credFile, `${lines.join('\n')}\n`, { mode: 0o600 });
  try { fs.chmodSync(credFile, 0o600); } catch { /* ignore on exotic fs */ }
}

/**
 * Create the unified DeepSeek Harness manager for Observer Agent.
 */
export function createHarness({ config, store, log = console }) {
  const dshHome = path.resolve(config.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const sdkHome = path.join(dshHome, 'sdk-runtime');
  const installDir = path.resolve(config.dshInstallDir || path.join(os.homedir(), '.local/share/observer-harness'));
  const patchFile = path.join(dshHome, 'observer.patch.yml');
  const credFile = path.join(dshHome, '.credentials.yaml');
  const sdkCredFile = path.join(sdkHome, '.credentials.yaml');

  const ensureState = () => {
    store.data.harness ??= {
      autoRoute: Boolean(config.dshAutoRoute),
      permissionMode: PERMISSION_MODES[config.dshPermissionMode] || 'danger-full-access',
      model: config.dshModel || '',
      cwd: config.dshWorkdir || os.homedir(),
      activeSessionId: '',
      sessions: [],
    };
    return store.data.harness;
  };

  /** Inspect `.credentials.yaml` non-destructively so DeepSeek Account OAuth grants written by `dsh web` are NEVER overwritten! */
  function syncConfig(dshRealPath) {
    fs.mkdirSync(dshHome, { recursive: true });
    fs.mkdirSync(sdkHome, { recursive: true });
    let rawCreds = '';
    try { rawCreds = fs.readFileSync(credFile, 'utf8'); } catch { /* not created yet */ }
    if (rawCreds) {
      try { fs.writeFileSync(sdkCredFile, rawCreds, { mode: 0o600 }); } catch { /* ignore */ }
    }
    const savedMap = readCredentialsMap(credFile);

    const dsKey = config.deepseekApiKey || process.env.DEEPSEEK_API_KEY || savedMap.get('DEEPSEEK_API_KEY') || '';
    const hasAccountToken = /\bkind:\s*["']?grant["']?/m.test(rawCreds)
      || /\btoken:\s*\S+/m.test(rawCreds)
      || Boolean(savedMap.get('DEEPSEEK_ACCOUNT_TOKEN'));

    const providers = [];
    const availableModels = [];

    if (hasAccountToken) {
      availableModels.push('deepseek-account/deepseek-chat', 'deepseek-account/deepseek-reasoner');
    }
    if (dsKey) {
      availableModels.push('deepseek-official/deepseek-chat', 'deepseek-official/deepseek-reasoner');
    }

    if (config.dshCustomBaseUrl) {
      const modelId = config.dshCustomModel || 'default';
      providers.push({
        id: 'observer-custom',
        apiKeyEnv: 'DSH_CUSTOM_API_KEY',
        baseURL: config.dshCustomBaseUrl,
        models: [{ id: modelId, name: `Custom · ${modelId}`, input: ['text', 'image'] }],
      });
      availableModels.push(`observer-custom/${modelId}`);
    }

    if (config.groqApiKey) {
      const uniq = [...new Set([
        config.groqModel || 'openai/gpt-oss-120b',
        config.groqVisionModel || 'qwen/qwen3.8-27b',
        config.groqModelSmall || 'openai/gpt-oss-20b',
      ].filter(Boolean))];
      providers.push({
        id: 'observer-groq',
        apiKeyEnv: 'GROQ_API_KEY',
        baseURL: config.groqBaseUrl || 'https://api.groq.com/openai/v1',
        models: uniq.map((id) => ({
          id,
          name: `Groq · ${id}`,
          input: /vl|vision|qwen3\.[5-9]|gemma-4/i.test(id) ? ['text', 'image'] : ['text'],
        })),
      });
      for (const id of uniq) availableModels.push(`observer-groq/${id}`);
    }

    if (config.openrouterApiKey) {
      const om = [...new Set([
        config.openrouterModel,
        config.openrouterVisionModel,
      ].filter(Boolean))];
      if (om.length) {
        providers.push({
          id: 'observer-openrouter',
          apiKeyEnv: 'OPENROUTER_API_KEY',
          baseURL: config.openrouterBaseUrl || 'https://openrouter.ai/api/v1',
          models: om.map((id) => ({ id, name: `OpenRouter · ${id}`, input: ['text', 'image'] })),
        });
        for (const id of om) availableModels.push(`observer-openrouter/${id}`);
      }
    }

    const localUrl = config.localApiUrl || config.localBaseUrl;
    if (localUrl && config.localModel) {
      providers.push({
        id: 'observer-local',
        apiKeyEnv: 'OBSERVER_LOCAL_KEY',
        baseURL: String(localUrl).replace(/\/+$/, ''),
        models: [{ id: config.localModel, name: `Local GGUF · ${config.localModel}`, input: ['text', 'image'] }],
      });
      availableModels.push(`observer-local/${config.localModel}`);
    }

    if (config.ollamaUrl && config.ollamaModel) {
      providers.push({
        id: 'observer-ollama',
        apiKeyEnv: 'OBSERVER_OLLAMA_KEY',
        baseURL: `${String(config.ollamaUrl).replace(/\/+$/, '')}/v1`,
        models: [{ id: config.ollamaModel, name: `Ollama · ${config.ollamaModel}`, input: ['text', 'image'] }],
      });
      availableModels.push(`observer-ollama/${config.ollamaModel}`);
    }

    const nodeInfo = findSupportedNode(config.dshNodeBin);
    const mcpNodeBin = nodeInfo?.bin || process.execPath;
    const extraNodeModules = resolveNodeModulesDir(dshRealPath);

    const yamlLines = ['# Auto-generated by Observer WhatsApp Agent for DeepSeek Harness'];
    if (providers.length) {
      yamlLines.push('- id: llm-pi-ai', '  config:', '    providers:');
      for (const p of providers) {
        yamlLines.push(
          `      ${yamlStr(p.id)}:`,
          '        api: "openai-completions"',
          `        apiKeyEnv: ${yamlStr(p.apiKeyEnv)}`,
          `        baseURL: ${yamlStr(p.baseURL)}`,
          '        compat:',
          '          supportsDeveloperRole: false',
          '          supportsStore: false',
          '          supportsStrictMode: false',
          '        models:',
        );
        for (const m of p.models) {
          yamlLines.push(
            `          - id: ${yamlStr(m.id)}`,
            `            name: ${yamlStr(m.name)}`,
            '            contextWindow: 128000',
            '            maxTokens: 8192',
            `            input: [${m.input.map((x) => yamlStr(x)).join(', ')}]`,
          );
        }
      }
    }

    yamlLines.push(
      '- insert:',
      '    - id: mcp-observer',
      '      name: "@deepseek-ai/dsh-mcp-client"',
      '      config:',
      '        transport: "stdio"',
      '        serverName: "observer"',
      `        command: ${yamlStr(mcpNodeBin)}`,
      '        args:',
      `          - ${yamlStr(MCP_SERVER_PATH)}`,
      `        cwd: ${yamlStr(AGENT_ROOT)}`,
      '        toolCallTimeoutMs: 120000',
      '        failOnStartupError: false',
      '        env:',
      '          OBSERVER_BRIDGE_HOST: "127.0.0.1"',
      `          OBSERVER_BRIDGE_PORT: ${yamlStr(String(config.port || config.bridgePort || 8787))}`,
      `          OBSERVER_BRIDGE_TOKEN: ${yamlStr(config.bridgeToken || '')}`,
      `          OBSERVER_DATA_DIR: ${yamlStr(path.resolve(config.dataDir || './data'))}`,
    );

    fs.writeFileSync(patchFile, `${yamlLines.join('\n')}\n`, 'utf8');

    const st = ensureState();
    const mergedNodePath = [extraNodeModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
    const childEnv = {
      ...process.env,
      ...(mergedNodePath ? { NODE_PATH: mergedNodePath } : {}),
      DSH_HOME: dshHome,
      DSH_PERMISSION_MODE: st.permissionMode || 'danger-full-access',
      DSH_TELEMETRY_MODE: 'DISABLED',
      OBSERVER_LOCAL_KEY: 'local',
      OBSERVER_OLLAMA_KEY: 'ollama',
      DSH_CUSTOM_API_KEY: config.dshCustomApiKey || 'local',
      ...(dsKey ? { DEEPSEEK_API_KEY: dsKey } : {}),
      ...(config.deepseekBaseUrl ? { DEEPSEEK_BASE_URL: config.deepseekBaseUrl } : {}),
      ...(config.groqApiKey ? { GROQ_API_KEY: config.groqApiKey } : {}),
      ...(config.openrouterApiKey ? { OPENROUTER_API_KEY: config.openrouterApiKey } : {}),
    };

    return { childEnv, availableModels, dsKey: Boolean(dsKey), hasAccountToken };
  }

  /** Pick `{ provider, model }` for SDK `initialize`, falling back gracefully across configured brains. */
  function selectModel(syncInfo) {
    const st = ensureState();
    const explicit = String(st.model || config.dshModel || '').trim();
    if (explicit) {
      const slash = explicit.indexOf('/');
      if (slash > 0) {
        const rawProv = explicit.slice(0, slash);
        return {
          provider: rawProv === 'deepseek' ? 'deepseek-official' : rawProv,
          model: explicit.slice(slash + 1),
        };
      }
      return { provider: 'deepseek-official', model: explicit };
    }
    if (syncInfo.dsKey) {
      return { provider: 'deepseek-official', model: 'deepseek-chat' };
    }
    if (syncInfo.hasAccountToken) {
      return { provider: 'deepseek-account', model: 'deepseek-chat' };
    }
    const first = syncInfo.availableModels[0];
    if (first && first.includes('/')) {
      const slash = first.indexOf('/');
      return { provider: first.slice(0, slash), model: first.slice(slash + 1) };
    }
    return { provider: 'deepseek-official', model: 'deepseek-chat' };
  }

  // ── Self-installer (portable Node 22 LTS if needed + `@deepseek-ai/dsh`) ──
  let installingPromise = null;

  async function ensurePortableNode(onProgress) {
    const existing = findSupportedNode(config.dshNodeBin);
    if (existing?.supported) return existing;

    const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
    if (!arch || process.platform !== 'linux') {
      throw new Error(`DeepSeek Harness requires Node.js >=22.19 or >=24 (found ${existing?.version || 'none'}).`);
    }
    const destRoot = path.join(os.homedir(), '.local/share/observer-node');
    const url = `https://nodejs.org/dist/${NODE_PORTABLE_VERSION}/node-${NODE_PORTABLE_VERSION}-linux-${arch}.tar.xz`;
    await onProgress?.(`⬇️ Downloading portable Node ${NODE_PORTABLE_VERSION} (${arch}) for DeepSeek Harness…`);
    fs.mkdirSync(destRoot, { recursive: true });
    await execFileAsync('sh', [
      '-lc',
      `curl -fsSL "${url}" | tar -xJ --strip-components=1 -C "${destRoot}"`,
    ], { timeout: 180_000 });
    const installed = probeNodeBinary(path.join(destRoot, 'bin/node'));
    if (!installed?.supported) throw new Error('Portable Node 22 install did not validate.');
    return installed;
  }

  async function install({ onProgress, force = false } = {}) {
    if (installingPromise) return installingPromise;
    installingPromise = (async () => {
      const nodeInfo = await ensurePortableNode(onProgress);
      const existingBin = !force ? findDshBinary(config) : null;
      if (existingBin) {
        syncConfig(existingBin);
        return {
          ok: true,
          alreadyInstalled: true,
          dshBin: existingBin,
          version: readDshVersion(existingBin),
          nodeBin: nodeInfo.bin,
          nodeVersion: nodeInfo.version,
        };
      }
      fs.mkdirSync(installDir, { recursive: true });
      const pkgJson = path.join(installDir, 'package.json');
      if (!fs.existsSync(pkgJson)) {
        fs.writeFileSync(pkgJson, JSON.stringify({ name: 'observer-deepseek-harness', private: true }, null, 2));
      }
      const npmBin = path.join(path.dirname(nodeInfo.bin), 'npm');
      const npmCmd = fs.existsSync(npmBin) ? npmBin : 'npm';
      await onProgress?.('📦 Installing official `@deepseek-ai/dsh` on Linux (one-time ~20–40s)…');
      await execFileAsync(npmCmd, [
        'install',
        '@deepseek-ai/dsh@latest',
        '--no-audit',
        '--no-fund',
      ], {
        cwd: installDir,
        timeout: 300_000,
        env: {
          ...process.env,
          PATH: `${path.dirname(nodeInfo.bin)}:${process.env.PATH || ''}`,
        },
      });
      const dshBin = findDshBinary(config);
      if (!dshBin) throw new Error('`@deepseek-ai/dsh` installed, but `dsh` binary was not found.');
      syncConfig(dshBin);
      await restartSdk();
      return {
        ok: true,
        alreadyInstalled: false,
        dshBin,
        version: readDshVersion(dshBin),
        nodeBin: nodeInfo.bin,
        nodeVersion: nodeInfo.version,
      };
    })();
    try {
      return await installingPromise;
    } finally {
      installingPromise = null;
    }
  }

  // ── Persistent `dsh --profile sdk` JSON-RPC 2.0 daemon ────────────────────
  let sdk = null;
  let bootPromise = null;

  async function killAndWait(child) {
    if (!child || child.exitCode !== null) return;
    await new Promise((resolve) => {
      const killer = setTimeout(() => {
        try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve();
      }, 1200);
      killer.unref();
      child.once('exit', () => {
        clearTimeout(killer);
        resolve();
      });
      try { child.kill('SIGTERM'); } catch { resolve(); }
    });
    try { child.stdin?.destroy(); } catch { /* ignore */ }
    try { child.stdout?.destroy(); } catch { /* ignore */ }
    try { child.stderr?.destroy(); } catch { /* ignore */ }
  }

  async function restartSdk() {
    const prev = sdk;
    sdk = null;
    if (prev?.child) {
      try { prev.rl?.close(); } catch { /* ignore */ }
      try { await prev.request('shutdown', {}, 1500); } catch { /* ignore */ }
      await killAndWait(prev.child);
    }
  }

  async function ensureSdk({ onProgress } = {}) {
    let dshBin = findDshBinary(config);
    if (!dshBin && config.dshAutoInstall !== false) {
      const res = await install({ onProgress });
      dshBin = res.dshBin;
    }
    if (!dshBin) {
      throw new Error('DeepSeek Harness (`@deepseek-ai/dsh`) abhi installed nahi hai. WhatsApp pe `/dsh install` bhejo ya terminal me `bash observer.sh harness setup` chalao.');
    }
    const nodeInfo = findSupportedNode(config.dshNodeBin);
    if (!nodeInfo?.supported) {
      if (config.dshAutoInstall !== false) {
        await ensurePortableNode(onProgress);
      } else {
        throw new Error(`DeepSeek Harness ko Node >=22.19 ya >=24 chahiye (abhi ${nodeInfo?.version || 'none'} mila).`);
      }
    }

    const syncInfo = syncConfig(dshBin);
    const modelChoice = selectModel(syncInfo);
    const st = ensureState();
    const effectiveCwd = fs.existsSync(st.cwd) ? st.cwd : os.homedir();
    const desiredSig = JSON.stringify({
      dshBin,
      mode: st.permissionMode,
      modelChoice,
      patch: fs.readFileSync(patchFile, 'utf8'),
    });

    if (sdk && sdk.alive && sdk.signature === desiredSig) {
      return { runtime: sdk, syncInfo, dshBin, modelChoice };
    }
    if (sdk) await restartSdk();
    if (bootPromise) return bootPromise;

    bootPromise = (async () => {
      const finalNode = findSupportedNode(config.dshNodeBin);
      const child = spawn(finalNode.bin, [
        dshBin,
        '--profile', 'sdk',
        '--patch', patchFile,
      ], {
        cwd: effectiveCwd,
        env: {
          ...syncInfo.childEnv,
          DSH_HOME: sdkHome,
          PATH: `${path.dirname(finalNode.bin)}:${process.env.PATH || ''}`,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const pending = new Map();
      const listeners = new Set();
      const openedSessions = new Set();
      let stderrTail = '';
      let nextId = 1;
      const rt = {
        child,
        alive: true,
        signature: desiredSig,
        startedAt: Date.now(),
        listeners,
        openedSessions,
        request(method, params = {}, timeoutMs = 60_000) {
          if (!rt.alive) return Promise.reject(new Error(`DSH SDK runtime exited: ${stderrTail.slice(-300)}`));
          const id = nextId++;
          return new Promise((resolve, reject) => {
            const timer = timeoutMs > 0
              ? setTimeout(() => {
                pending.delete(id);
                reject(new Error(`DSH RPC ${method} timed out after ${timeoutMs}ms`));
              }, timeoutMs)
              : null;
            pending.set(id, { resolve, reject, timer });
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
          });
        },
      };

      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      rt.rl = rl;
      rl.on('line', (line) => {
        if (!line.trim()) return;
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
          const entry = pending.get(msg.id);
          pending.delete(msg.id);
          if (entry.timer) clearTimeout(entry.timer);
          if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else entry.resolve(msg.result);
          return;
        }
        if (msg.method === 'session.event' && msg.params) {
          for (const fn of [...listeners]) {
            try { fn(msg.params); } catch { /* ignore */ }
          }
        }
      });

      child.stderr.on('data', (chunk) => {
        const txt = chunk.toString();
        stderrTail = (stderrTail + txt).slice(-4000);
        if (txt.trim()) log.debug?.(`[dsh-sdk] ${txt.trim()}`);
      });

      child.on('exit', (code, sig) => {
        rt.alive = false;
        if (sdk === rt) sdk = null;
        const err = new Error(`DeepSeek Harness exited (${sig || code || 0})${stderrTail ? `: ${stderrTail.trim().slice(-240)}` : ''}`);
        for (const [, entry] of pending) {
          if (entry.timer) clearTimeout(entry.timer);
          entry.reject(err);
        }
        pending.clear();
      });

      const init = await rt.request('initialize', {
        cwd: effectiveCwd,
        provider: modelChoice.provider,
        model: modelChoice.model,
      }, 45_000);
      rt.serverInfo = init?.serverInfo ?? {};
      sdk = rt;
      return { runtime: rt, syncInfo, dshBin, modelChoice };
    })();

    try {
      return await bootPromise;
    } finally {
      bootPromise = null;
    }
  }

  /** Run a full-power prompt through DeepSeek Harness and return structured response + trajectory summary. */
  async function runTask(promptText, {
    images = [],
    files = [],
    cwd = '',
    sessionId = '',
    newSession = false,
    signal = null,
    onProgress = null,
  } = {}) {
    if (signal?.aborted) throw new StoppedError();

    const { runtime, modelChoice } = await ensureSdk({ onProgress });
    const st = ensureState();
    const targetCwd = path.resolve(cwd || st.cwd || os.homedir());
    const activeSid = newSession
      ? `wa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      : (sessionId || st.activeSessionId || `wa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    const isExistingDiskSession = Boolean(!newSession && (sessionId || st.activeSessionId) && !runtime.openedSessions.has(activeSid));

    const contentBlocks = [];
    for (const img of images) {
      if (Buffer.isBuffer(img?.buffer)) {
        contentBlocks.push({
          type: 'image',
          data: img.buffer.toString('base64'),
          mimeType: img.mimeType || 'image/jpeg',
        });
      }
    }
    let fullText = String(promptText ?? '').trim();
    if (files.length) {
      const notes = files.map((f) => `[Attached file on Linux disk: ${f.path}${f.mimeType ? ` (${f.mimeType})` : ''}]`).join('\n');
      fullText = fullText ? `${fullText}\n\n${notes}` : notes;
    }
    contentBlocks.push({ type: 'text', text: fullText || 'Continue.' });

    const assistantChunks = [];
    const toolCalls = [];
    let turnError = null;
    let lastProgressTs = 0;

    const onEvent = (payload) => {
      if (payload.sessionId !== activeSid) return;
      const ev = payload.event;
      if (!ev) return;

      if (ev.type === 'tool/call') {
        const name = ev.data?.name || 'tool';
        const args = ev.data?.arguments || {};
        toolCalls.push({ name, args });
        const now = Date.now();
        if (onProgress && now - lastProgressTs >= 3500) {
          lastProgressTs = now;
          Promise.resolve(onProgress(formatToolProgress(name, args))).catch(() => {});
        }
      } else if (ev.type === 'assistant/message') {
        const parts = ev.data?.message?.content;
        if (Array.isArray(parts)) {
          const txt = parts
            .filter((p) => p?.type === 'text' && p.text)
            .map((p) => p.text)
            .join('\n')
            .trim();
          if (txt) assistantChunks.push(txt);
        }
        if (ev.data?.message?.stopReason === 'error' && ev.data?.message?.errorMessage) {
          turnError = ev.data.message.errorMessage;
        }
      } else if (ev.type === 'turn/end' && ev.data?.reason?.kind === 'error') {
        turnError = ev.data.reason.error?.message || turnError || 'DeepSeek Harness turn failed.';
      }
    };

    runtime.listeners.add(onEvent);

    const onAbort = () => {
      restartSdk().catch(() => {});
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      if (isExistingDiskSession) {
        await runtime.request('session/resume', { sessionId: activeSid }, 30_000).catch(() => {});
      }
      runtime.openedSessions.add(activeSid);
      if (fs.existsSync(targetCwd)) {
        await runtime.request('session/working-directory/set', {
          sessionId: activeSid,
          path: targetCwd,
        }, 15_000).catch(() => {});
      }

      await runtime.request('session/prompt', {
        sessionId: activeSid,
        contentBlocks,
      }, 60_000);

      if (signal?.aborted) {
        onAbort();
        throw new StoppedError();
      }

      const timeoutMs = Number(config.dshTaskTimeoutMs) || 600_000;
      await runtime.request('session/wait', { sessionId: activeSid }, timeoutMs);
      if (signal?.aborted) throw new StoppedError();

      st.activeSessionId = activeSid;
      const existingIdx = st.sessions.findIndex((s) => s.id === activeSid);
      const summary = String(promptText || 'Attachment task').replace(/\s+/g, ' ').trim().slice(0, 70);
      const meta = {
        id: activeSid,
        cwd: targetCwd,
        title: existingIdx >= 0 ? st.sessions[existingIdx].title : summary,
        updatedAt: Date.now(),
        turns: (existingIdx >= 0 ? (st.sessions[existingIdx].turns || 0) : 0) + 1,
      };
      if (existingIdx >= 0) st.sessions.splice(existingIdx, 1);
      st.sessions.unshift(meta);
      st.sessions = st.sessions.slice(0, 25);
      store.save();

      if (turnError && !assistantChunks.length) {
        throw new Error(turnError);
      }

      const finalText = assistantChunks.length
        ? assistantChunks[assistantChunks.length - 1]
        : '✅ Done.';

      return {
        text: finalText,
        allMessages: assistantChunks,
        sessionId: activeSid,
        cwd: targetCwd,
        toolCalls,
        model: modelChoice.provider ? `${modelChoice.provider}/${modelChoice.model}` : 'default',
      };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      runtime.listeners.delete(onEvent);
    }
  }

  // ── Official `dsh web` Desktop / LAN / Tunnel UI runtime ──────────────────
  let web = null;
  let webStarting = null;

  function createWebTunnelProxy(targetPort, remotePort) {
    const upstreamHost = `127.0.0.1:${targetPort}`;
    const upstreamOrigin = `http://127.0.0.1:${targetPort}`;
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        const fwdHeaders = { ...req.headers, host: upstreamHost };
        if (fwdHeaders.origin) fwdHeaders.origin = upstreamOrigin;
        if (fwdHeaders.referer) {
          try {
            const ref = new URL(fwdHeaders.referer);
            fwdHeaders.referer = `${upstreamOrigin}${ref.pathname}${ref.search}`;
          } catch { fwdHeaders.referer = `${upstreamOrigin}/`; }
        }
        const isHttpsProxy = req.headers['x-forwarded-proto'] === 'https';
        const up = http.request({
          hostname: '127.0.0.1',
          port: targetPort,
          path: req.url,
          method: req.method,
          headers: fwdHeaders,
        }, (upRes) => {
          const outHeaders = { ...upRes.headers };
          delete outHeaders['x-frame-options'];
          if (outHeaders['set-cookie']) {
            const cookies = Array.isArray(outHeaders['set-cookie']) ? outHeaders['set-cookie'] : [outHeaders['set-cookie']];
            outHeaders['set-cookie'] = cookies.map((c) => (isHttpsProxy
              ? c.replace(/SameSite=Strict/gi, 'SameSite=None; Secure')
              : c.replace(/SameSite=Strict/gi, 'SameSite=Lax')));
          }
          res.writeHead(upRes.statusCode || 502, outHeaders);
          upRes.pipe(res);
        });
        up.on('error', (err) => {
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(`DeepSeek Harness web proxy error: ${err.message}`);
        });
        req.pipe(up);
      });

      server.on('upgrade', (req, clientSocket, head) => {
        const upSocket = net.connect(targetPort, '127.0.0.1', () => {
          const reqLine = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
          const hdrLines = [];
          for (let i = 0; i < req.rawHeaders.length; i += 2) {
            const k = req.rawHeaders[i];
            const low = k.toLowerCase();
            if (low === 'host') hdrLines.push(`${k}: ${upstreamHost}`);
            else if (low === 'origin') hdrLines.push(`${k}: ${upstreamOrigin}`);
            else hdrLines.push(`${k}: ${req.rawHeaders[i + 1]}`);
          }
          upSocket.write(`${reqLine}${hdrLines.join('\r\n')}\r\n\r\n`);
          if (head?.length) upSocket.write(head);
          clientSocket.pipe(upSocket);
          upSocket.pipe(clientSocket);
        });
        upSocket.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => upSocket.destroy());
      });

      server.on('error', (err) => {
        log.warn?.(`dsh remote proxy port ${remotePort} unavailable: ${err.message}`);
        resolve(null);
      });
      server.listen(remotePort, '0.0.0.0', () => resolve(server));
    });
  }

  async function startWeb({ onProgress } = {}) {
    if (web?.alive) return webStatus();
    if (webStarting) return webStarting;

    webStarting = (async () => {
      let dshBin = findDshBinary(config);
      if (!dshBin && config.dshAutoInstall !== false) {
        const res = await install({ onProgress });
        dshBin = res.dshBin;
      }
      if (!dshBin) {
        throw new Error('DeepSeek Harness installed nahi hai. Pehle `/dsh install` chalao.');
      }
      const nodeInfo = await ensurePortableNode(onProgress);
      const syncInfo = syncConfig(dshBin);

      const webPort = Number.isFinite(Number(config.dshWebPort)) && config.dshWebPort !== '' && config.dshWebPort !== undefined
        ? Number(config.dshWebPort)
        : 3080;
      const remotePort = Number.isFinite(Number(config.dshRemotePort)) && config.dshRemotePort !== '' && config.dshRemotePort !== undefined
        ? Number(config.dshRemotePort)
        : (webPort === 0 ? 0 : webPort + 1);
      const ips = localIpv4Addresses();

      const trustedHosts = new Set([
        `127.0.0.1:${webPort}`,
        `localhost:${webPort}`,
      ]);
      if (remotePort > 0) {
        trustedHosts.add(`127.0.0.1:${remotePort}`);
        trustedHosts.add(`localhost:${remotePort}`);
        for (const ip of ips) trustedHosts.add(`${ip}:${remotePort}`);
      }
      for (const extra of config.dshTrustedHosts || []) {
        if (extra) trustedHosts.add(extra);
      }

      // Launcher flags (`--profile`, `--patch`) MUST precede web app flags (`--port`, `--no-open`, `--trusted-host`).
      const args = [
        dshBin,
        '--profile', 'web',
        '--patch', patchFile,
        '--port', String(webPort),
        '--no-open',
      ];
      for (const h of trustedHosts) {
        if (!h.endsWith(':0')) args.push('--trusted-host', h);
      }

      const child = spawn(nodeInfo.bin, args, {
        cwd: os.homedir(),
        env: {
          ...syncInfo.childEnv,
          PATH: `${path.dirname(nodeInfo.bin)}:${process.env.PATH || ''}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderrTail = '';
      const localUrl = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`dsh web startup timed out. ${stderrTail.slice(-300)}`));
        }, 30_000);

        child.stdout.on('data', (chunk) => {
          const text = chunk.toString();
          const m = text.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/);
          if (m) {
            clearTimeout(timer);
            resolve(m[0]);
          }
        });
        child.stderr.on('data', (chunk) => {
          stderrTail = (stderrTail + chunk.toString()).slice(-3000);
        });
        child.once('exit', (code, sig) => {
          clearTimeout(timer);
          reject(new Error(`dsh web exited early (${sig || code || 0}): ${stderrTail.trim().slice(-240)}`));
        });
      });

      const parsed = new URL(localUrl);
      const actualPort = Number(parsed.port);
      const token = parsed.searchParams.get('token') || '';
      const proxyServer = remotePort > 0 ? await createWebTunnelProxy(actualPort, remotePort) : null;
      const actualRemotePort = proxyServer ? proxyServer.address().port : null;

      web = {
        child,
        proxyServer,
        alive: true,
        port: actualPort,
        remotePort: actualRemotePort,
        token,
        localUrl,
        lanUrls: actualRemotePort
          ? ips.map((ip) => `http://${ip}:${actualRemotePort}/?token=${token}`)
          : [],
        startedAt: Date.now(),
      };

      child.on('exit', () => {
        if (web?.proxyServer) {
          try { web.proxyServer.close(); } catch { /* ignore */ }
        }
        if (web?.child === child) web = null;
      });

      return webStatus();
    })();

    try {
      return await webStarting;
    } finally {
      webStarting = null;
    }
  }

  async function stopWeb() {
    if (!web) return { running: false };
    const prev = web;
    web = null;
    if (prev.proxyServer) {
      try { prev.proxyServer.closeAllConnections?.(); prev.proxyServer.close(); } catch { /* ignore */ }
    }
    await killAndWait(prev.child);
    return { running: false };
  }

  function webStatus() {
    if (!web?.alive) return { running: false };
    return {
      running: true,
      port: web.port,
      remotePort: web.remotePort,
      localUrl: web.localUrl,
      lanUrls: web.lanUrls,
      startedAt: web.startedAt,
    };
  }

  /** Install a native Fedora GNOME `.desktop` launcher so DeepSeek Harness opens like a native desktop app! */
  async function installDesktopLauncher() {
    const ws = await startWeb();
    const appsDir = path.join(os.homedir(), '.local/share/applications');
    const binDir = path.join(os.homedir(), '.local/bin');
    fs.mkdirSync(appsDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    const launcherScript = path.join(binDir, 'deepseek-harness-desktop');
    const bridgePort = Number(config.port || config.bridgePort) || 8787;
    const bridgeTok = config.bridgeToken || '';
    fs.writeFileSync(launcherScript, `#!/usr/bin/env bash
set -euo pipefail
URL=$(curl -fsS -H "x-bridge-token: ${bridgeTok}" "http://127.0.0.1:${bridgePort}/api/harness/web-url" 2>/dev/null || true)
if [ -z "$URL" ]; then
  URL="${ws.localUrl}"
fi
for browser in google-chrome chromium chromium-browser brave-browser microsoft-edge; do
  if command -v "$browser" >/dev/null 2>&1; then
    exec "$browser" --app="$URL"
  fi
done
exec xdg-open "$URL"
`, { mode: 0o755 });

    const desktopFile = path.join(appsDir, 'deepseek-harness.desktop');
    fs.writeFileSync(desktopFile, `[Desktop Entry]
Type=Application
Name=DeepSeek Harness
Comment=DeepSeek Harness on Fedora Linux (connected to Observer WhatsApp Agent)
Exec=${launcherScript}
Icon=utilities-terminal
Terminal=false
Categories=Development;IDE;Utility;
StartupNotify=true
`, 'utf8');

    return { desktopFile, launcherScript, web: ws };
  }

  function status() {
    const st = ensureState();
    const dshBin = findDshBinary(config);
    const nodeInfo = findSupportedNode(config.dshNodeBin);
    const syncInfo = syncConfig(dshBin);
    const modelSel = selectModel(syncInfo);
    return {
      installed: Boolean(dshBin),
      version: readDshVersion(dshBin),
      dshBin,
      dshHome,
      patchFile,
      nodeVersion: nodeInfo?.version || null,
      nodeSupported: Boolean(nodeInfo?.supported),
      nodeBin: nodeInfo?.bin || null,
      sdkRunning: Boolean(sdk?.alive),
      autoRoute: Boolean(st.autoRoute),
      permissionMode: st.permissionMode,
      cwd: st.cwd,
      activeSessionId: st.activeSessionId || null,
      sessions: st.sessions || [],
      selectedModel: modelSel.provider ? `${modelSel.provider}/${modelSel.model}` : (st.model || 'auto (DeepSeek / configured brain)'),
      availableModels: syncInfo.availableModels,
      hasDeepSeekKey: syncInfo.dsKey,
      hasDeepSeekAccount: syncInfo.hasAccountToken,
      web: webStatus(),
    };
  }

  async function setApiKey(rawKey) {
    const key = String(rawKey ?? '').trim();
    if (!key) throw new Error('API key khali hai.');
    config.deepseekApiKey = key;
    const creds = readCredentialsMap(credFile);
    creds.set('DEEPSEEK_API_KEY', key);
    writeCredentialsMap(credFile, creds);
    await restartSdk();
    return status();
  }

  async function setPermissionMode(modeInput) {
    const mapped = PERMISSION_MODES[String(modeInput || '').trim().toLowerCase()];
    if (!mapped) throw new Error(`Unknown mode "${modeInput}". Choose: full, safe, readonly`);
    const st = ensureState();
    st.permissionMode = mapped;
    store.save();
    await restartSdk();
    return mapped;
  }

  function setModel(modelInput) {
    const st = ensureState();
    const clean = String(modelInput ?? '').trim();
    st.model = clean === 'auto' || clean === 'default' ? '' : clean;
    store.save();
    return st.model || 'auto';
  }

  function setAutoRoute(flag) {
    const st = ensureState();
    st.autoRoute = Boolean(flag);
    store.save();
    return st.autoRoute;
  }

  function setWorkdir(dirInput) {
    const st = ensureState();
    const target = String(dirInput ?? '').startsWith('~/')
      ? path.join(os.homedir(), String(dirInput).slice(2))
      : path.resolve(String(dirInput || os.homedir()));
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      throw new Error(`Folder nahi mila: ${target}`);
    }
    st.cwd = target;
    store.save();
    return target;
  }

  function resetSession() {
    const st = ensureState();
    st.activeSessionId = '';
    store.save();
  }

  function useSession(idPrefix) {
    const st = ensureState();
    const q = String(idPrefix ?? '').trim();
    const hit = st.sessions.find((s) => s.id === q || s.id.startsWith(q));
    if (!hit) {
      // Allow resuming ANY session ID created in `dsh web` too!
      st.activeSessionId = q;
      store.save();
      return { id: q, title: 'External / Web session' };
    }
    st.activeSessionId = hit.id;
    store.save();
    return hit;
  }

  async function close() {
    await stopWeb();
    await restartSdk();
  }

  return {
    install,
    ensureSdk,
    runTask,
    startWeb,
    stopWeb,
    webStatus,
    installDesktopLauncher,
    status,
    setApiKey,
    setPermissionMode,
    setModel,
    setAutoRoute,
    setWorkdir,
    resetSession,
    useSession,
    restartSdk,
    close,
  };
}
