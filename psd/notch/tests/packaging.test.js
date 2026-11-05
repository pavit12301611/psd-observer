// packaging.test.js — the failure that broke the extension once, guarded.
//
// The repo root .gitignore carried a bare `lib/` rule for Python build output.
// It also matched the GNOME extension's lib/, so every module the extension
// imports was silently never committed: extension.js shipped, lib/ did not,
// and the Shell refused to load the extension with
//   "does not provide an export named: 'PSD_INTERFACE'".
//
// A syntax check cannot catch that — the imported file simply is not there.
// So: walk the extension, resolve every relative import, and require that the
// file exists on disk AND is tracked by git.

import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const extensionDir = path.join(repoRoot, 'psd/notch/extension');

const walk = (dir) => fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);

const isTracked = (file) => {
    try {
        execFileSync('git', ['ls-files', '--error-unmatch', file], {cwd: repoRoot, stdio: 'ignore'});
        return true;
    } catch {
        return false;
    }
};

test('every module the extension imports exists and is committed', (t) => {
    if (!fs.existsSync(path.join(repoRoot, '.git'))) {
        t.skip('not a git checkout');
        return;
    }
    const sources = walk(extensionDir).filter((file) => file.endsWith('.js'));
    assert.ok(sources.length > 0, 'the extension must have sources');

    const problems = [];
    for (const file of sources) {
        const code = fs.readFileSync(file, 'utf8');
        for (const match of code.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) {
            const target = path.resolve(path.dirname(file), match[1]);
            const relative = path.relative(repoRoot, target);
            if (!fs.existsSync(target)) problems.push(`${relative} is imported but missing`);
            else if (!isTracked(relative)) problems.push(`${relative} is imported but not committed`);
        }
    }
    assert.deepEqual(problems, [], `the extension would fail to load:\n  ${problems.join('\n  ')}`);
});

test('the extension declares the files GNOME Shell needs', () => {
    for (const required of ['metadata.json', 'extension.js', 'prefs.js', 'stylesheet.css',
        'schemas/io.github.pavit12301611.Notch.gschema.xml',
        'dbus/io.github.pavit12301611.Notch.xml',
        'dbus/io.github.pavit12301611.Notch.Psd.xml'])
        assert.ok(fs.existsSync(path.join(extensionDir, required)), `${required} is missing`);

    const metadata = JSON.parse(fs.readFileSync(path.join(extensionDir, 'metadata.json'), 'utf8'));
    assert.equal(metadata.uuid, 'notch@pavit12301611.github.io');
    assert.ok(metadata['shell-version'].includes('50'), 'must declare support for GNOME 50');
});

test('the D-Bus interfaces PSD calls are exactly the ones the extension exports', () => {
    const psdXml = fs.readFileSync(path.join(extensionDir, 'dbus/io.github.pavit12301611.Notch.Psd.xml'), 'utf8');
    for (const method of ['PsdMessage', 'PsdOpen', 'PsdState'])
        assert.match(psdXml, new RegExp(`method name="${method}"`), `${method} must exist for the agent`);
    assert.match(psdXml, /interface name="io\.github\.pavit12301611\.Notch\.Psd"/);

    const mainXml = fs.readFileSync(path.join(extensionDir, 'dbus/io.github.pavit12301611.Notch.xml'), 'utf8');
    for (const method of ['Toggle', 'SetExpanded', 'GetState'])
        assert.match(mainXml, new RegExp(`method name="${method}"`));

    // extension.js must import the constants it uses from lib/dbus.js.
    const code = fs.readFileSync(path.join(extensionDir, 'extension.js'), 'utf8');
    const imported = /import \{([^}]+)\} from '\.\/lib\/dbus\.js'/.exec(code)?.[1] ?? '';
    for (const name of ['APP_ID', 'EXTENSION_ID', 'EXTENSION_PATH', 'PSD_INTERFACE', 'interfaceXml', 'interfaceNameOf'])
        assert.ok(imported.includes(name), `lib/dbus.js must export ${name}`);
});
