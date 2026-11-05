// shell-api.test.js — a written-down contract for the Shell APIs we call.
//
// Three crashes shipped green in a row, and every one was the same mistake in a
// different costume:
//
//   Expected type string for argument 'path' but got type GObject.Object
//   Unrecognized parameter "affectsInputRegion"
//   Unrecognized parameter "..."
//
// The unit tests passed, the import test passed, and the extension still died
// inside enable(). The lesson is not "test harder" — it is that the *Shell's API
// surface changes* and nothing in this repo noticed. GNOME removes and renames
// things between releases (affectsInputRegion was a real param once), and an
// extension that targets 46–50 has to be explicit about what it depends on.
//
// So this file keeps two lists:
//
//   1. SHELL_API — every namespace member the extension reaches for, with the
//      members it is allowed to touch. Any *new* name a developer adds has to be
//      added here deliberately, after checking it still exists upstream.
//
//   2. The behavioural contracts that bit us — the argument shapes of
//      addChrome(), export(), addKeybinding(), and the fact that a Gio.File is
//      not a path string — pinned as executable assertions.
//
// It cannot import the real Shell (there is no gjs in CI), so it enforces
// internal consistency plus the documented contract. That is still the thing
// that would have caught all three bugs at review time.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, '../extension');

/**
 * Drop comments but keep strings.
 *
 * Necessary, not cosmetic: our own comments *talk about* the APIs — "addChrome
 * used to take affectsInputRegion", "export() takes two arguments" — and a naive
 * scan reads those as calls. It also keeps the stale-member check honest, since
 * a name that survives only in a comment is a name nothing calls.
 */
const stripComments = (code) => {
    let out = '';
    let i = 0;
    let quote = null;
    while (i < code.length) {
        const char = code[i];
        const next = code[i + 1];
        if (quote) {
            out += char;
            if (char === '\\') { out += next ?? ''; i += 2; continue; }
            if (char === quote) quote = null;
            i++;
            continue;
        }
        if (char === '"' || char === "'" || char === '`') { quote = char; out += char; i++; continue; }
        if (char === '/' && next === '/') {
            while (i < code.length && code[i] !== '\n') i++;
            continue;
        }
        if (char === '/' && next === '*') {
            i += 2;
            while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        out += char;
        i++;
    }
    return out;
};

const sources = () => {
    const files = [path.join(extensionDir, 'extension.js'), path.join(extensionDir, 'prefs.js')];
    for (const file of fs.readdirSync(path.join(extensionDir, 'lib')))
        if (file.endsWith('.js')) files.push(path.join(extensionDir, 'lib', file));
    return files.filter(file => fs.existsSync(file))
        .map(file => ({
            name: path.relative(extensionDir, file),
            code: stripComments(fs.readFileSync(file, 'utf8')),
        }));
};

// ── the contract: namespace → the members we are allowed to use ──────────────
const SHELL_API = {
    Main: ['layoutManager', 'messageTray', 'overview', 'panel', 'wm'],
    St: ['Bin', 'BoxLayout', 'Button', 'Entry', 'Icon', 'Label', 'PolicyType',
        'ScrollView', 'ThemeContext', 'Widget'],
    Clutter: ['ActorAlign', 'BinLayout', 'EVENT_PROPAGATE', 'EVENT_STOP', 'KEY_Escape', 'Orientation'],
    Meta: ['KeyBindingFlags'],
    Shell: ['ActionMode', 'get_file_contents_utf8_sync'],
    GLib: ['Bytes', 'DateTime', 'PRIORITY_DEFAULT', 'PRIORITY_DEFAULT_IDLE', 'PRIORITY_HIGH',
        'SOURCE_CONTINUE', 'SOURCE_REMOVE', 'Variant', 'VariantType', 'build_filenamev',
        'get_home_dir', 'get_monotonic_time', 'getenv', 'idle_add', 'source_remove', 'timeout_add'],
    Gio: ['BusNameOwnerFlags', 'BusType', 'Cancellable', 'DBus', 'DBusCallFlags',
        'DBusExportedObject', 'DBusProxy', 'DBusProxyFlags', 'File', 'FileIcon', 'Settings',
        'SettingsBindFlags', 'SettingsSchemaSource', 'ThemedIcon', 'bus_own_name',
        'bus_unown_name'],
    // NOTE: GObject is deliberately absent. lib/view.js imported it for a long
    // time without ever using it; if a future edit needs GObject.Object or a
    // GObject.registerClass, add it here on purpose.
    Pango: ['EllipsizeMode', 'WrapMode'],
    Soup: ['Message', 'Session', 'Status'],
};

/** Members of a namespace that we reach for in the sources. */
const membersUsed = (code, namespace) => {
    const found = new Set();
    const re = new RegExp(`\\b${namespace}\\.([A-Za-z_][A-Za-z0-9_]*)`, 'g');
    for (const match of code.matchAll(re)) found.add(match[1]);
    return found;
};

test('the extension only touches Shell namespace members this repo has vetted', () => {
    const violations = [];
    for (const {name, code} of sources()) {
        for (const [namespace, allowed] of Object.entries(SHELL_API)) {
            for (const member of membersUsed(code, namespace)) {
                if (!allowed.includes(member))
                    violations.push(`${name}: ${namespace}.${member}`);
            }
        }
    }
    assert.deepEqual(violations, [],
        'unvetted Shell API. Check it still exists in the targeted Shell versions, ' +
        'then add it to SHELL_API in this test deliberately.');
});

test('the vetted list has no members the extension stopped using', () => {
    // Keep the contract honest: a stale entry means nobody would notice that
    // name going away upstream, and the list slowly stops describing reality.
    const code = sources().map(file => file.code).join('\n');
    const stale = [];
    for (const [namespace, allowed] of Object.entries(SHELL_API)) {
        for (const member of allowed)
            if (!membersUsed(code, namespace).has(member)) stale.push(`${namespace}.${member}`);
    }
    assert.deepEqual(stale, [], 'drop these from SHELL_API — nothing calls them any more');
});

// ── the contracts that actually caused crashes ───────────────────────────────

test('addChrome() is only ever given params some supported Shell accepts', () => {
    // js/ui/layout.js: _trackActor() runs Params.parse(params, defaultParams) and
    // throws `Unrecognized parameter "<name>"` on anything else. The accepted set
    // moved between releases:
    //
    //   GNOME 46–48   {trackFullscreen, affectsStruts, affectsInputRegion}
    //   GNOME 49–50   {trackFullscreen, affectsStruts}
    //
    // So the union is what may appear in the source at all, and the
    // version-specific ones (affectsInputRegion) must be gated behind a probe —
    // view.js `_chromeParams()` does that, and enable.test.js runs it against
    // both generations. This test makes sure no *other* key creeps in, and that
    // params are never written inline at a call site where they cannot be gated.
    const UNION = new Set(['trackFullscreen', 'affectsStruts', 'affectsInputRegion']);

    for (const {name, code} of sources()) {
        // Take the whole argument list (parens balanced) and split at the top
        // level, so `addChrome(actor, {affectsInputRegion: true})` and
        // `addChrome(actor, this._chromeParams())` both parse correctly.
        for (const match of code.matchAll(/add(?:Top)?Chrome\s*\(/g)) {
            let depth = 0;
            let args = '';
            for (let i = match.index + match[0].length - 1; i < code.length; i++) {
                const char = code[i];
                if (char === '(') { depth++; if (depth === 1) continue; }
                else if (char === ')') { depth--; if (depth === 0) break; }
                args += char;
            }
            let nest = 0;
            let split = -1;
            for (let i = 0; i < args.length; i++) {
                const char = args[i];
                if ('{(['.includes(char)) nest++;
                else if ('})]'.includes(char)) nest--;
                else if (char === ',' && nest === 0) { split = i; break; }
            }
            const params = args.slice(split + 1).trim();
            if (!params) continue;
            if (!params.startsWith('{')) {
                // A computed set is fine — but only from the one audited helper,
                // which has to be tested for both Shell generations.
                assert.match(params, /this\._chromeParams\(\)/,
                    `${name}: addChrome() params must be a literal or this._chromeParams()`);
                continue;
            }
            for (const key of [...params.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map(m => m[1])) {
                assert.ok(UNION.has(key),
                    `${name}: addChrome() param "${key}" is not accepted by any supported Shell — ` +
                    'the Shell throws Unrecognized parameter and the extension fails to enable');
                // affectsInputRegion is accepted by 46–48 and REJECTED by 49–50,
                // so it may never be written inline: it has to pass through
                // _chromeParams(), which asks the Shell first. Writing it at a
                // call site is exactly the bug that took the extension down.
                assert.notEqual(key, 'affectsInputRegion',
                    `${name}: affectsInputRegion is not valid on GNOME 49–50 — ` +
                    'do not pass it inline. Route addChrome() params through this._chromeParams().');
            }
        }
    }

    // _chromeParams() itself may only ever name keys from the union, and the
    // version-specific one must be conditional on the probe.
    const view = sources().find(file => file.name.endsWith('view.js')).code;
    const helper = /_chromeParams\(\)\s*\{([\s\S]*?)\n    \}/.exec(view)?.[1];
    assert.ok(helper, 'view.js must expose _chromeParams()');
    for (const key of [...helper.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:(?!=)/g)].map(m => m[1])) {
        if (key === 'wanted' || key === 'const') continue;
        assert.ok(UNION.has(key), `_chromeParams(): "${key}" is not a valid addChrome() param`);
    }
    assert.match(helper, /if \(acceptsInputRegion\(\)\)/,
        'affectsInputRegion must only be added when the Shell accepts it');

    // And the probe must exist and be the thing that decides it.
    assert.match(view, /function acceptsInputRegion\(\)/, 'the probe must exist');
});

test('struts are opt-in, and never applied to the notch actor itself', () => {
    // Two separate rules, because they protect different things.
    //
    // 1. The notch actor must never reserve space. It is positioned and sized
    //    every animation frame; a strut on it would resize the work area
    //    continuously and maximised windows would crawl.
    // 2. Reserving space IS a real feature — `reserve-space` in Preferences —
    //    but it goes through StrutReservation, which owns a separate, static
    //    actor and tracks/untracks it on demand. Only that file may pass
    //    affectsStruts: true, and only through a value the setting controls.

    for (const {name, code} of sources()) {
        const struts = [...code.matchAll(/affectsStruts\s*:\s*true/g)];
        if (struts.length === 0) continue;
        assert.equal(name, 'lib/session.js',
            `${name}: only StrutReservation may reserve space — the notch actor is ` +
            'repositioned every frame and a strut on it would make windows crawl');
        assert.match(code, /reserve-space/,
            'lib/session.js must derive struts from the reserve-space setting');
    }

    // The notch actor's own addChrome() call must not ask for a strut.
    const view = sources().find(file => file.name.endsWith('view.js')).code;
    for (const match of view.matchAll(/add(?:Top)?Chrome\s*\([^;]*?\)/g))
        assert.doesNotMatch(match[0], /affectsStruts\s*:\s*true/,
            'addChrome() on the notch actor must never set affectsStruts');

    // And the reservation has to be switchable off again.
    const session = sources().find(file => file.name.endsWith('session.js')).code;
    assert.match(session, /removeChrome\(/, 'the strut actor must be removable');
    assert.match(session, /release\(\)/, 'reservation needs a release path');
});

test('DBusExportedObject.export() is called with exactly (connection, objectPath)', () => {
    // GjsDBusImplementation extends GDBusInterfaceSkeleton, so `export` is
    // g_dbus_interface_skeleton_export(skeleton, connection, object_path, error).
    // The interface name lives in the XML, not in the call. A third argument is
    // silently ignored (with a "Too many arguments" warning) — harmless, but it
    // means the value it was passed is doing nothing, so catch the mistake.
    const calls = [];
    for (const {name, code} of sources()) {
        for (const match of code.matchAll(/\.export\s*\(([^)]*)\)/g)) calls.push({name, args: match[1]});
    }
    assert.ok(calls.length >= 2, 'both interfaces must be exported');
    for (const {name, args} of calls) {
        const count = args.split(',').filter(part => part.trim()).length;
        assert.equal(count, 2, `${name}: export(${args.trim()}) takes (connection, objectPath) only`);
    }
});

test('addKeybinding() gets the five arguments Main.wm.addKeybinding expects', () => {
    // addKeybinding(name, settings, flags, modes, handler)
    const calls = [...fs.readFileSync(path.join(extensionDir, 'extension.js'), 'utf8')
        .matchAll(/addKeybinding\s*\(/g)];
    assert.equal(calls.length, 1, 'one keybinding is registered');
    const code = fs.readFileSync(path.join(extensionDir, 'extension.js'), 'utf8');
    const block = /addKeybinding\(([\s\S]*?)\);/.exec(code)?.[1] ?? '';
    // Count top-level commas outside nested calls/parens.
    let depth = 0;
    let commas = 0;
    for (const char of block) {
        if (char === '(' || char === '[') depth++;
        else if (char === ')' || char === ']') depth--;
        else if (char === ',' && depth === 0) commas++;
    }
    assert.equal(commas, 4, 'addKeybinding(name, settings, flags, modes, handler) — 5 arguments');
});

test('Extension.dir (a Gio.File) is never treated as a path string', () => {
    // The original crash: Gio.File.new_for_path(this.dir).
    for (const {name, code} of sources()) {
        assert.doesNotMatch(code, /new_for_path\s*\(\s*(this\.)?(dir|extension\.dir)\s*[,)]/,
            `${name}: Extension.dir is a Gio.File — pass dir.get_path(), not the file itself`);
    }
});

test('St.BoxLayout is only ever oriented with the property it actually has', () => {
    // StBoxLayout installs exactly one property: `orientation`
    // (CLUTTER_TYPE_ORIENTATION, default HORIZONTAL). It has no `vertical`.
    //
    // This is the nastiest kind of Shell bug because it does not throw: the
    // unknown key is silently dropped by g_object_new, the box keeps its
    // horizontal default, and a vertical stack renders as a row. Every page in
    // the notch was laying out this way. Nothing failed — it just looked wrong.
    //
    // Keys are parsed rather than grepped, because `{vertical}` and
    // `{vertical: true}` are the same mistake, and only the second one matches
    // a naive search.
    const ALLOWED = new Set([
        // StBoxLayout
        'orientation',
        // StWidget
        'style_class', 'style', 'can_focus', 'track_hover', 'name', 'accessible_name',
        // ClutterActor
        'x_expand', 'y_expand', 'x_align', 'y_align', 'visible', 'reactive', 'opacity',
        'layout_manager', 'clip_to_allocation', 'width', 'height',
    ]);
    const problems = [];
    let boxes = 0;

    for (const {name, code} of sources()) {
        for (const match of code.matchAll(/new St\.BoxLayout\s*\(\s*\{/g)) {
            boxes++;
            // Walk to the matching brace so nested objects stay intact.
            let depth = 0;
            let i = match.index + match[0].length - 1;
            let body = '';
            for (; i < code.length; i++) {
                const char = code[i];
                if (char === '{') { depth++; if (depth === 1) continue; }
                else if (char === '}') { depth--; if (depth === 0) break; }
                body += char;
            }
            // Top-level keys only: split on commas outside nested brackets.
            let nest = 0;
            let part = '';
            const parts = [];
            for (const char of body) {
                if ('{(['.includes(char)) nest++;
                else if ('})]'.includes(char)) nest--;
                if (char === ',' && nest === 0) { parts.push(part); part = ''; } else part += char;
            }
            parts.push(part);
            for (const chunk of parts) {
                const key = chunk.split(':')[0].trim();
                if (!/^[a-z][a-z0-9_]*$/.test(key)) continue;
                if (!ALLOWED.has(key))
                    problems.push(`${name}: St.BoxLayout({${key}}) — not a property of StBoxLayout or its ancestors. ` +
                        'Use orientation: Clutter.Orientation.VERTICAL/HORIZONTAL.');
            }
        }
    }

    assert.deepEqual(problems, []);
    assert.ok(boxes > 0, 'the notch builds boxes');
    // And the property it does have must actually be used, or the guard could
    // pass on code that never builds a column at all.
    const code = sources().map(file => file.code).join('\n');
    assert.match(code, /orientation:\s*Clutter\.Orientation\.VERTICAL/, 'something must build a column');
});

test('interface XML reaches wrapJSObject() as a string, never as an object', () => {
    // Gio.DBusExportedObject.wrapJSObject(interfaceInfo, jsObj) passes its first
    // argument to Gio.DBusInterfaceInfo.new_for_xml(). GJS's override takes a
    // string only:
    //
    //   function _newNodeInfo(constructor, value) {
    //       if (typeof value === 'string') return constructor(value);
    //       throw TypeError(`Invalid type ${Object.prototype.toString.call(value)}`);
    //   }
    //
    // Handing it {xml: "..."} produced `TypeError: Invalid type [object Object]`
    // and the extension would not enable at all. interfaceXml() returns the
    // string; these assertions keep it that way without needing a fake Shell.
    const dbus = sources().find(file => file.name.endsWith('dbus.js')).code;
    assert.match(dbus, /return text;/,
        'interfaceXml() must return the XML string itself');
    assert.doesNotMatch(dbus, /return \{\s*xml\s*:/,
        'interfaceXml() must not wrap the XML in an object — wrapJSObject rejects it');

    // And no call site may unwrap it as if it were one.
    for (const {name, code} of sources()) {
        assert.doesNotMatch(code, /\{\s*xml\s*\}\s*=\s*interfaceXml/,
            `${name}: interfaceXml() returns a string now, not {xml}`);
        assert.doesNotMatch(code, /interfaceXml\([^)]*\)\s*\.xml\b/,
            `${name}: interfaceXml() returns a string, so there is no .xml on it`);
    }

    // The same rule for anything else handed to wrapJSObject().
    const extension = sources().find(file => file.name.endsWith('extension.js')).code;
    const wrappers = [...extension.matchAll(/wrapJSObject\s*\(\s*([A-Za-z_][\w.]*)/g)];
    assert.equal(wrappers.length, 2, 'both interfaces are exported');
    for (const match of wrappers) {
        assert.match(match[1], /^[a-z]*[Xx]ml$|^xml$/,
            `extension.js passes ${match[1]} to wrapJSObject() — it must be the XML string ` +
            'that interfaceXml() returned, not anything derived from it');
    }
});
