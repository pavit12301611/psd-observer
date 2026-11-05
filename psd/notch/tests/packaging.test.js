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

// ── the schema must actually contain every key the code uses ────────────────
//
// Reported from the Extensions app:
//
//   Error: GSettings key psd-url not found in schema io.github.pavit12301611.Notch
//
// GJS resolves the schema *id* and then rejects any key the compiled schema does
// not list, so a missing key is not "a setting with its default" — it is a hard
// failure that stops the Preferences window from opening at all. The XML is the
// contract between three files that never get compiled together: prefs.js,
// lib/*.js, and the .gschema.xml. Check them against each other.

const extensionSettingsKeys = () => {
    const files = [path.join(extensionDir, 'prefs.js'), path.join(extensionDir, 'extension.js')];
    for (const file of fs.readdirSync(path.join(extensionDir, 'lib')))
        if (file.endsWith('.js')) files.push(path.join(extensionDir, 'lib', file));

    const used = new Map();
    for (const file of files) {
        if (!fs.existsSync(file)) continue;
        const code = fs.readFileSync(file, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n]*/g, '');
        // Any get_*/set_* on a Gio.Settings-ish receiver, plus the add* helpers
        // prefs.js uses to build rows from a key name.
        const patterns = [
            /\.(?:get|set)_(?:boolean|int|double|string|strv|value|enum|flags)\s*\(\s*'([^']+)'/g,
            /\.(?:bind|bind_writable|create_action|get_default_value|is_writable)\s*\(\s*'([^']+)'/g,
        ];
        for (const pattern of patterns) {
            for (const match of code.matchAll(pattern)) {
                const key = match[1];
                if (!used.has(key)) used.set(key, new Set());
                used.get(key).add(path.basename(file));
            }
        }
    }
    return used;
};

const schemaKeys = () => {
    const file = path.join(extensionDir, 'schemas/io.github.pavit12301611.Notch.gschema.xml');
    const xml = fs.readFileSync(file, 'utf8');
    return new Set([...xml.matchAll(/<key\s+name="([^"]+)"/g)].map(match => match[1]));
};

test('every settings key the extension reads exists in its own schema', () => {
    // Keys that belong to *other* schemas, not ours. Listing them explicitly
    // means a new cross-schema key has to be considered rather than guessed at.
    const OTHER_SCHEMAS = new Set([
        'show-banners',        // org.gnome.desktop.notifications (Do Not Disturb)
        'color-scheme',        // org.gnome.desktop.interface
        'night-light-enabled', // org.gnome.settings-daemon.plugins.color
    ]);

    const declared = schemaKeys();
    const missing = [];
    for (const [key, where] of extensionSettingsKeys()) {
        if (OTHER_SCHEMAS.has(key)) continue;
        if (!declared.has(key)) missing.push(`${key} (used in ${[...where].join(', ')})`);
    }
    assert.deepEqual(missing, [],
        'these keys are read from io.github.pavit12301611.Notch but the schema does not ' +
        'declare them — GJS throws "GSettings key ... not found in schema ..." and ' +
        'Preferences will not open');
});

test('the keys Preferences binds are a subset of the schema', () => {
    // prefs.js is the file that failed in the report, and it fails at
    // fillPreferencesWindow() — the whole window dies on the first bad key.
    const prefs = fs.readFileSync(path.join(extensionDir, 'prefs.js'), 'utf8');
    const declared = schemaKeys();
    const used = new Set();
    // prefs.js builds rows through helpers that take a key as their second arg.
    for (const match of prefs.matchAll(/add(?:Switch|Spin|Entry|Row|Combo|Scale|Color|Font)\s*\(\s*\w+\s*,\s*'([^']+)'/g))
        used.add(match[1]);
    // …and sometimes reads settings directly.
    for (const match of prefs.matchAll(/settings\.(?:get|set)_\w+\s*\(\s*'([^']+)'/g))
        used.add(match[1]);
    // …and the PSD entries, which are plain addEntry() calls.
    for (const match of prefs.matchAll(/addEntry\s*\(\s*'([^']+)'/g))
        used.add(match[1]);

    const missing = [...used].filter(key => !declared.has(key));
    assert.deepEqual(missing, [],
        'prefs.js binds keys the schema does not declare — the Preferences window throws ' +
        'before it renders anything');
    assert.ok(used.size > 20, `expected prefs.js to bind many keys, found ${used.size}`);
});

test('the schema parses as XML and declares the id and path the code expects', () => {
    const file = path.join(extensionDir, 'schemas/io.github.pavit12301611.Notch.gschema.xml');
    const xml = fs.readFileSync(file, 'utf8');
    // A malformed schema is never compiled, which on an existing install leaves
    // the previous gschemas.compiled in place — the exact reported failure.
    assert.match(xml, /<schema\s+id="io\.github\.pavit12301611\.Notch"/);
    assert.match(xml, /<schema[^>]*path="\/io\/github\/pavit12301611\/Notch\/"/);
    // Every key needs a type — either type="…" or enum="…" for an enumerated
    // one — or glib-compile-schemas refuses the whole file.
    for (const match of xml.matchAll(/<key\s+name="([^"]+)"([^>]*)>/g)) {
        assert.match(match[2], /\b(?:type|enum)="/, `key ${match[1]} declares no type`);
    }
    // Tags must balance, which is all a regex-level check can honestly promise.
    const opens = [...xml.matchAll(/<(schema|key)\b/g)].length;
    const closes = [...xml.matchAll(/<\/(schema|key)>/g)].length;
    assert.equal(opens, closes, 'unbalanced <schema>/<key> tags');
});


// ── the schema the Shell actually loads ─────────────────────────────────────
//
// Extension.getSettings() does NOT read the system-wide schema database. From
// js/extensions/sharedInternals.js:
//
//   const schemaDir = this.dir.get_child('schemas');
//   if (schemaDir.query_exists(null))
//       schemaSource = Gio.SettingsSchemaSource.new_from_directory(
//           schemaDir.get_path(), defaultSource, false);
//   const schemaObj = schemaSource.lookup(schema, true);
//
// new_from_directory(..., trusted=false) reads gschemas.compiled *from that
// directory*. So the file that decides whether the Agent tab exists is
// $EXTDIR/schemas/gschemas.compiled — not the one in glib-2.0/schemas.
//
// The upstream notch ships a compiled database there; ours used to leave it in
// place while adding keys, which is exactly:
//   Error: GSettings key psd-url not found in schema io.github.pavit12301611.Notch

test('the installer compiles the schema inside the extension directory', () => {
    const sh = fs.readFileSync(path.resolve(here, '../../scripts/psd.sh'), 'utf8');
    assert.match(sh, /install_schema_db\s+"\$EXTDIR\/schemas"/,
        'the extension-local schemas/ directory needs its own gschemas.compiled — ' +
        'that is the one Extension.getSettings() loads');
    // And it must be verified there too, not only in the shared location.
    assert.match(sh, /verify_schema_keys\s+"\$EXTDIR\/schemas"/,
        'verification must cover the directory the Shell reads');
});

test('install_schema_db removes a stale database before rebuilding it', () => {
    const sh = fs.readFileSync(path.resolve(here, '../../scripts/psd.sh'), 'utf8');
    const body = /install_schema_db\(\)\s*\{([\s\S]*?)\n\}/.exec(sh)?.[1];
    assert.ok(body, 'install_schema_db() must exist');
    // Copying a new .xml over an existing gschemas.compiled changes nothing;
    // the database has to go first or the key list stays astern.
    assert.match(body, /rm -f "\$dir\/gschemas\.compiled"/,
        'a stale compiled database must be deleted before recompiling');
    // And a missing compiler must be a hard failure, not a warning: the old
    // code warned and carried on, leaving exactly the reported breakage.
    assert.doesNotMatch(body, /^\s*warn /m,
        'being unable to compile must fail the install, not warn');
});

test('the shipped extension does not contain a prebuilt schema database', () => {
    // A committed gschemas.compiled would pin the key list at whatever the
    // builder had, for ever, on every machine.
    const found = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name === 'gschemas.compiled') found.push(path.relative(extensionDir, full));
        }
    };
    walk(extensionDir);
    assert.deepEqual(found, [], 'gschemas.compiled is generated at install time, never shipped');
});
