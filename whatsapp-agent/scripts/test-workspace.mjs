// Shared isolation for the test runner and mutation checks. Copy only public
// source/test assets, never an installed agent's data, .env or WhatsApp login.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function testFiles(dir = path.join(root, 'test')) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? testFiles(file) : entry.name.endsWith('.test.js') ? [file] : [];
  }).sort();
}
export function workspace(prefix = 'run', { sourceRoot = root } = {}) {
  const cache = path.join(root, '.cache/deep-audit'); fs.mkdirSync(cache, { recursive: true });
  const dir = fs.mkdtempSync(path.join(cache, `${prefix}-`));
  try {
    for (const name of ['src', 'test', 'scripts', 'webapp', 'systemd', 'benchmarks', 'audits']) {
      if (fs.existsSync(path.join(sourceRoot, name))) fs.cpSync(path.join(sourceRoot, name), path.join(dir, name), { recursive: true, filter(file) { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Public test source cannot contain symlinks'); return true; } });
    }
    for (const name of fs.readdirSync(sourceRoot)) {
      if (name === 'release-bundle.tar.gz' || name === '.env.example' || /\.(?:md|json|sh)$/.test(name) && !name.startsWith('.')) {
        if (fs.lstatSync(path.join(sourceRoot, name)).isSymbolicLink()) throw new Error('Public test files cannot be symlinks');
        if (fs.statSync(path.join(sourceRoot, name)).isFile()) fs.copyFileSync(path.join(sourceRoot, name), path.join(dir, name));
      }
    }
    fs.symlinkSync(path.join(sourceRoot, 'node_modules'), path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const name of ['home', 'tmp', 'home/.config', 'home/.cache', 'home/.local/share']) fs.mkdirSync(path.join(dir, name), { recursive: true, mode: 0o700 });
    return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  } catch (err) { fs.rmSync(dir, { recursive: true, force: true }); throw err; }
}
export function testEnvironment(dir) {
  // An explicit allowlist avoids inheriting live provider/password/token vars,
  // desktop D-Bus/display addresses or caller-supplied NODE_OPTIONS preloads.
  const env = Object.fromEntries(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'LANG', 'LC_ALL', 'TERM', 'CI', 'TZ', 'NODE_V8_COVERAGE'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  return { ...env, HOME: path.join(dir, 'home'), USERPROFILE: path.join(dir, 'home'), TMPDIR: path.join(dir, 'tmp'), TMP: path.join(dir, 'tmp'), TEMP: path.join(dir, 'tmp'), XDG_CONFIG_HOME: path.join(dir, 'home/.config'), XDG_CACHE_HOME: path.join(dir, 'home/.cache'), XDG_DATA_HOME: path.join(dir, 'home/.local/share'), OBSERVER_TEST_SANDBOX: dir, PYTHONDONTWRITEBYTECODE: '1', NO_COLOR: '1' };
}

export function runtimeFingerprint(sourceRoot = root) {
  function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(file) : entry.name.endsWith('.js') ? [file] : [];
    }).sort();
  }
  const hash = (data) => createHash('sha256').update(data).digest('hex');
  return hash(['src', 'webapp'].flatMap((name) => walk(path.join(sourceRoot, name))).map((file) => `${path.relative(sourceRoot, file).split(path.sep).join('/')}\0${hash(fs.readFileSync(file))}`).join('\n'));
}
