// Reproduce what GNOME Shell does: load extension.js and follow every import.
// gi:// and resource:// modules are stubbed; local files must exist and must
// export the names that are imported from them.
import {registerHooks, isBuiltin} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Usage: node tests/load.test.mjs <extension-dir>   (defaults to extension/)
const ext = process.argv[2] ?? new URL('../extension', import.meta.url).pathname;
const problems = [];

// Stub the Shell's module space so the real code can be instantiated.
const guards = ['Gio','GLib','GObject','Clutter','Pango','St','Shell','Meta','Soup','Gdk','GdkPixbuf','Graphene','Atk','cairo','Gvc'];
const stubUrl = (s) => `notchstub:${s}`;
// The stub must answer *any* named export (Extension, InjectionManager,
// ExtensionPreferences, ...), so only genuinely missing local modules fail.
const KNOWN_EXPORTS = ['Extension', 'ExtensionPreferences', 'InjectionManager', 'Slider',
  'QuickToggle', 'QuickMenuToggle', 'PopupMenu', 'PopupMenuItem', 'ModalDialog',
  'PanelMenu', 'SystemIndicator', 'Button', 'St', 'Clutter', 'Gio', 'GLib', 'Pango', 'Main'];
const stubSource = (s) => {
  const name = s.replace(/^gi:\/\//, '').replace(/^.*\//, '').replace(/\.js$/, '');
  return `
    const handler = new Proxy(function(){}, {
      get: (t, p) => {
        if (p === 'then') return undefined;
        if (p === Symbol.toPrimitive) return () => name;
        if (p === 'new') return () => makeAll();
        return () => undefined;
      },
      apply: () => undefined,
      construct: () => ({}),
    });
    const name = ${JSON.stringify(name)};
    const makeAll = () => ({});
    const proxy = new Proxy({}, {
      get: (t, p) => {
        if (p === 'then') return undefined;
        if (p === 'default') return proxy;
        return handler;
      },
    });
    export default proxy;
    export const __stub = name;
    class StubBase { constructor(...args) { this._args = args; } }
    Object.defineProperty(StubBase, 'name', {value: 'StubBase'});
    ${KNOWN_EXPORTS.map((n) => `export const ${n} = StubBase;`).join('\n    ')}
  `;
};
const stubs = new Map();
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('gi://')) return {url: stubUrl(specifier), shortCircuit: true};
    if (specifier.startsWith('resource:///')) return {url: stubUrl(specifier), shortCircuit: true};
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('notchstub:')) {
      const spec = url.slice('notchstub:'.length);
      return {format: 'module', source: stubSource(spec), shortCircuit: true};
    }
    return nextLoad(url, context);
  },
});

// 1. every local module must exist
const walk = (dir) => fs.readdirSync(dir, {withFileTypes: true}).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
for (const file of walk(ext).filter((f) => f.endsWith('.js'))) {
  const code = fs.readFileSync(file, 'utf8');
  for (const m of code.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) {
    const target = path.resolve(path.dirname(file), m[1]);
    if (!fs.existsSync(target)) problems.push(`missing ${m[1]} (imported by ${path.basename(file)})`);
  }
}

// 2. actually import every module; named exports must resolve
const modules = walk(ext).filter((f) => f.endsWith('.js'));
for (const file of modules) {
  try {
    await import(pathToFileURL(file).href);
  } catch (error) {
    problems.push(`${path.relative(ext, file)}: ${error.message.split('\n')[0]}`);
  }
}

if (problems.length) {
  console.log('FAILED TO LOAD:');
  for (const p of problems) console.log('  ✗', p);
  process.exit(1);
}
console.log(`loaded ${modules.length} modules cleanly — every import resolves and every named export exists`);
process.exit(0);
