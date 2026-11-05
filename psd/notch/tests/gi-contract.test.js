// gi-contract.test.js — the other half of "does it load": does it *run*?
//
// The load test proves imports resolve. This one exercises lib/dbus.js against
// a Gio stub that behaves like real introspection, including its type checks.
//
// The bug this exists for: extension.js passes `this.dir` to interfaceXml().
// Extension.dir is a Gio.File, not a string. lib/dbus.js called
// Gio.File.new_for_path(dir), and the Shell died with
//
//   Error: Expected type string for argument 'path' but got type GObject.Object
//
// A syntax check cannot see it, and neither can the load test — the module
// imports fine and only explodes on the code path that runs at enable().
// So: strict stubs, and call the functions with the real argument shapes.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {registerHooks} from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, '../extension');

// ── a Gio that enforces the same argument types as the real bindings ─────────
class GObjectObject {}

class File extends GObjectObject {
    constructor(filePath) {
        super();
        this._path = filePath;
    }

    get_path() {
        return this._path;
    }

    get_child(name) {
        return new File(`${this._path}/${name}`);
    }

    load_contents() {
        try {
            const data = fs.readFileSync(this._path);
            return [true, data, null];
        } catch (error) {
            // Gio surfaces this as a GLib.Error, not a JS exception type.
            throw Object.assign(new Error(error.message), {domain: 'g-file-error-quark'});
        }
    }
}

const expectString = (value, argument) => {
    // This is the exact shape of the Shell's complaint.
    if (typeof value !== 'string')
        throw new Error(`Expected type string for argument '${argument}' but got type ${typeof value === 'object' ? 'GObject.Object' : typeof value}`);
    return value;
};

const Gio = {
    File: Object.assign(
        function FileFactory() {},
        {new_for_path: (p) => new File(expectString(p, 'path'))}
    ),
    FileIcon: class extends GObjectObject {
        constructor({file} = {}) {
            super();
            this.file = file;
        }
    },
    ThemedIcon: {new: (name) => ({themed: expectString(name, 'name')})},
};

const stubs = new Map([
    ['gi://Gio', {default: Gio}],
    ['gi://GLib', {default: {get_home_dir: () => '/home/tester', build_filenamev: (parts) => parts.join('/'), getenv: () => null}}],
]);
const prefix = 'notch-gi:';
const key = '__notchGiContractStubs';
globalThis[key] = stubs;
const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
        if (stubs.has(specifier)) return {url: `${prefix}${specifier}`, shortCircuit: true};
        return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
        if (!url.startsWith(prefix)) return nextLoad(url, context);
        const specifier = url.slice(prefix.length);
        const exports = stubs.get(specifier);
        const lines = [`const values = globalThis.${key}.get(${JSON.stringify(specifier)});`];
        for (const name of Object.keys(exports)) {
            lines.push(name === 'default' ? 'export default values.default;' :
                `export const ${name} = values.${name};`);
        }
        return {format: 'module', source: lines.join('\n'), shortCircuit: true};
    },
});

const dbus = await import('../extension/lib/dbus.js');
hooks.deregister();
delete globalThis[key];

test('interfaceXml accepts the Gio.File that Extension.dir actually is', () => {
    // This is what extension.js does: this.dir is a Gio.File.
    const dir = new File(extensionDir);
    const {xml} = dbus.interfaceXml(dir, 'io.github.pavit12301611.Notch.xml');
    assert.match(xml, /<node>/);
    assert.match(xml, /method name="Toggle"/);
});

test('interfaceXml also accepts a plain path', () => {
    const {xml} = dbus.interfaceXml(extensionDir, 'io.github.pavit12301611.Notch.Psd.xml');
    assert.match(xml, /PsdMessage/);
});

test('the PSD interface the agent calls is loadable from disk', () => {
    const {xml} = dbus.interfaceXml(new File(extensionDir), 'io.github.pavit12301611.Notch.Psd.xml');
    for (const method of ['PsdMessage', 'PsdOpen', 'PsdState'])
        assert.match(xml, new RegExp(`method name="${method}"`));
});

test('a missing interface file fails with a readable error, not a crash', () => {
    assert.throws(() => dbus.interfaceXml(new File(extensionDir), 'nope.xml'), /nope\.xml|ENOENT/);
});

test('a non-GFile, non-string directory is rejected with an explanation', () => {
    assert.throws(() => dbus.interfaceXml(42, 'x.xml'), /extension directory/);
    assert.throws(() => dbus.interfaceXml(null, 'x.xml'), /extension directory/);
});

test('the constants the agent depends on are exported', () => {
    assert.equal(dbus.APP_ID, 'io.github.pavit12301611.Notch');
    assert.equal(dbus.EXTENSION_PATH, '/io/github/pavit12301611/Notch');
    assert.equal(dbus.PSD_INTERFACE, `${dbus.APP_ID}.Psd`);
    assert.equal(dbus.EXTENSION_ID, `${dbus.APP_ID}.Extension`);
});
