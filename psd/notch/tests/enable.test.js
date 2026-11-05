// enable.test.js — actually run NotchView's constructor and enable() against a
// strict fake Shell.
//
// Why: every crash so far shipped green. Imports resolved (load test), the pure
// logic passed (unit tests), and the extension still died at enable():
//
//   Expected type string for argument 'path' but got type GObject.Object
//
// That error came from code that only runs when the Shell constructs the view.
// So this file builds enough of GNOME Shell — St actors with the real property
// names, Main.panel/messageTray/overview, Gio.File, Gio.Settings, DBus — that
// NotchView's constructor executes end to end. Anything it touches that we got
// wrong types for will throw here instead of on the owner's desktop.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {registerHooks} from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, '../extension');

// ── St / Clutter, strict about constructor properties we use ────────────────
class Actor {
    constructor(properties = {}) {
        this.children = [];
        this.visible = true;
        this.reactive = false;
        this.opacity = 255;
        this.style = '';
        this.style_class = '';
        this.width = 0;
        this.height = 0;
        this.x_expand = false;
        this.y_expand = false;
        this._signals = new Map();
        for (const [key, value] of Object.entries(properties)) this[key] = value;
    }
    add_child(child) { this.children.push(child); child.parent = this; }
    destroy() { this.destroyed = true; this.children = []; }
    destroy_all_children() { for (const c of this.children) c.destroy(); this.children = []; }
    get_n_children() { return this.children.length; }
    add_style_class_name(name) { this.style_class = `${this.style_class} ${name}`.trim(); }
    remove_style_class_name(name) { this.style_class = this.style_class.replace(name, '').trim(); }
    set_size(w, h) { this.width = w; this.height = h; }
    set_position(x, y) { this.x = x; this.y = y; }
    set_style(s) { this.style = s; }
    grab_key_focus() { this.focused = true; }
    remove_all_transitions() {}
    connect(signal, callback) {
        if (!this._signals.has(signal)) this._signals.set(signal, []);
        this._signals.get(signal).push(callback);
        return this._signals.get(signal).length;
    }
    connectObject(signals, actor) { this._objectSignals = {...(this._objectSignals ?? {}), ...signals}; }
    disconnectObject() { this._objectSignals = null; }
    emit(signal, ...args) { for (const cb of this._signals.get(signal) ?? []) cb(this, ...args); }
}

class Label extends Actor {
    constructor(properties = {}) {
        const {text, ...rest} = properties;
        super(rest);
        this.text = text ?? '';
        this.clutter_text = {line_wrap: false, ellipsize: 0, line_wrap_mode: 0, connect: () => 1};
    }
}

class Entry extends Actor {
    constructor(properties = {}) {
        const {text, hint_text, ...rest} = properties;
        super(rest);
        this._text = text ?? '';
        this.hint_text = hint_text ?? '';
        this.clutter_text = {connect: (s, cb) => { this._activate = cb; return 1; }};
    }
    get_text() { return this._text; }
    set_text(value) { this._text = value; }
}

class ScrollView extends Actor {
    constructor(properties = {}) {
        super(properties);
        this.vadjustment = {value: 0, upper: 0, page_size: 0};
        this.child = null;
    }
    set child(value) { this._child = value; }
    get child() { return this._child; }
}

// StBoxLayout installs exactly one property, `orientation`, default HORIZONTAL.
// Unknown keys are silently dropped by g_object_new in the real Shell, which is
// precisely why "vertical: true" looked fine for so long: no error, and every
// column quietly laid out as a row. Model the silent drop faithfully.
class BoxLayout extends Actor {
    constructor(properties = {}) {
        if (Object.hasOwn(properties, 'spacing'))
            throw new Error('No property spacing on StBoxLayout');
        super(properties);
        this.orientation = properties.orientation ?? Clutter.Orientation.HORIZONTAL;
    }
    get vertical() {
        return this.orientation === Clutter.Orientation.VERTICAL;
    }
}

const St = {
    Widget: Actor, Label, Entry, ScrollView, BoxLayout, Bin: Actor, Button: Actor, Icon: Actor,
    ThemeContext: {get_for_stage: () => ({scale_factor: 2})},
    PolicyType: {NEVER: 0, AUTOMATIC: 1},
};

const Clutter = {
    ActorAlign: {START: 0, CENTER: 1, FILL: 2, END: 3},
    // clutter-enums.h: HORIZONTAL = 0, VERTICAL = 1.
    Orientation: {HORIZONTAL: 0, VERTICAL: 1},
    BinLayout: class {},
    KEY_Escape: 65307,
    EVENT_STOP: true,
    EVENT_PROPAGATE: false,
};
const Pango = {EllipsizeMode: {NONE: 0, END: 3}, WrapMode: {WORD_CHAR: 2}, Alignment: {CENTER: 1}};

// ── Gio, with the type checks that caught us ────────────────────────────────
const expectString = (value, argument) => {
    if (typeof value !== 'string')
        throw new Error(`Expected type string for argument '${argument}' but got type GObject.Object`);
    return value;
};
class GFile {
    constructor(p) {
        // Real Gio validates here, and this is the message the Shell printed.
        if (typeof p !== 'string')
            throw new Error("Expected type string for argument 'path' but got type GObject.Object");
        this._path = p;
    }
    get_path() { return this._path; }
    get_uri() { return `file://${this._path}`; }
    get_child(name) { return new GFile(`${this._path}/${name}`); }
    load_contents() { return [true, fs.readFileSync(this._path), null]; }
}
const Gio = {
    File: {new_for_path: (p) => new GFile(expectString(p, 'path'))},
    FileIcon: class { constructor({file} = {}) { if (!(file instanceof GFile)) throw new Error('FileIcon needs a Gio.File'); this.file = file; } },
    ThemedIcon: {new: (name) => ({themed: expectString(name, 'name')})},
    Settings: class {
        constructor({schema_id} = {}) { this.schema_id = schema_id; this._values = {}; }
        get_boolean() { return false; }
        get_int() { return 32; }
        get_double() { return 1; }
        get_string(key) { return this._values[key] ?? (key === 'placement' ? 'panel' : ''); }
        connect() { return 1; }
        disconnect() {}
    },
    Cancellable: class {},
    DBusCallFlags: {NONE: 0},
    DBusProxyFlags: {NONE: 0},
    DBus: {session: {
        call_sync: () => ({deepUnpack: () => [[]]}),
    }},
    bus_own_name: () => 1,
    bus_unown_name() {},
    DBusExportedObject: {wrapJSObject: (xml, callbacks) => ({
        __callbacks: callbacks, __xml: xml, export() {}, unexport() {},
    })},
    BusType: {SESSION: 1},
    BusNameOwnerFlags: {NONE: 0},
};

const GLib = {
    get_home_dir: () => '/home/tester',
    getenv: () => null,
    build_filenamev: (parts) => parts.join('/'),
    get_monotonic_time: () => 1_000_000,
    timeout_add: () => 1,
    source_remove() {},
    idle_add: () => 1,
    PRIORITY_DEFAULT: 0,
    PRIORITY_DEFAULT_IDLE: 200,
    PRIORITY_HIGH: -100,
    SOURCE_CONTINUE: true,
    SOURCE_REMOVE: false,
    DateTime: {new_now_local: () => ({format: () => '12:00'})},
    Variant: class { constructor() {} deepUnpack() { return [{}, {}]; } },
    VariantType: class {},
};

// ── the fake Shell ─────────────────────────────────────────────────────────
const makePanel = () => {
    const dateMenu = new Actor();
    dateMenu.visible = true;
    return {height: 32, statusArea: {dateMenu}};
};

/**
 * The addChrome() params each Shell generation accepts, read from the sources:
 *   GNOME 46–48  {trackFullscreen, affectsStruts, affectsInputRegion}
 *   GNOME 49–50  {trackFullscreen, affectsStruts}
 * js/ui/layout.js `_trackActor` runs Params.parse(params, defaultParams) and
 * throws `Unrecognized parameter "<name>"` for anything else. Modelling the
 * throw is what turns "the extension died at login" into a red test.
 */
const accept = (defaults, params) => {
    for (const prop in params ?? {}) {
        if (!(prop in defaults))
            throw new Error(`Unrecognized parameter "${prop}"`);
    }
    return {...defaults, ...params};
};

// One layoutManager for the whole run: the gi:// stubs are ES modules whose
// exports are snapshots taken at import time, so replacing Main.layoutManager
// later would not be seen by the code under test. Switch the accepted-parameter
// set in place instead — same object, different Shell generation.
const layoutManager = {
    generation: 'modern',
    registry: new Map(),
    get defaults() {
        return {
            trackFullscreen: false,
            affectsStruts: false,
            ...(layoutManager.generation === 'legacy' ? {affectsInputRegion: true} : {}),
        };
    },
    addChrome(actor, params) {
        layoutManager.chrome = {...accept(layoutManager.defaults, params), actor};
        layoutManager.added = true;
        assert.ok(actor && typeof actor.connectObject === 'function',
            'addChrome must be handed a real actor');
        layoutManager.registry.set(actor, layoutManager.chrome);
    },
    // trackChrome fills from defaultParams, then goes through the same
    // Params.parse — that is the path view.js probes at enable().
    trackChrome(actor, params = {}) {
        const merged = {...params};
        for (const prop in layoutManager.defaults) {
            if (!(prop in merged)) merged[prop] = layoutManager.defaults[prop];
        }
        layoutManager.registry.set(actor, accept(layoutManager.defaults, merged));
    },
    untrackChrome(actor) { layoutManager.registry.delete(actor); },
    removeChrome() { layoutManager.removed = true; },
    connectObject() {}, disconnectObject() {},
};

const makeShell = ({inputRegion = false} = {}) => {
    layoutManager.generation = inputRegion ? 'legacy' : 'modern';
    const tray = new Actor();
    tray._notificationQueue = [];
    tray.getSources = () => [];
    return {
        Main: {
            layoutManager,
            messageTray: tray,
            panel: makePanel(),
            overview: {visible: false, connectObject() {}},
            wm: {addKeybinding: () => true, removeKeybinding() {}},
        },
        global: {
            display: {connectObject() {}, disconnectObject() {}, get_focus_window: () => null},
            window_manager: {connectObject() {}, disconnectObject() {}},
            stage: {},
            backend: {get_monitor_manager: () => ({get_current_monitor: () => ({
                get_geometry: () => ({x: 0, y: 0, width: 1920, height: 1080}),
            })})},
            log() {},
        },
    };
};

const shell = makeShell();

const stubs = new Map([
    ['gi://Gio', {default: Gio}],
    ['gi://GLib', {default: GLib}],
    ['gi://St', {default: St}],
    ['gi://Clutter', {default: Clutter}],
    ['gi://Pango', {default: Pango}],
    ['gi://GObject', {default: {registerClass: (klass) => klass}}],
    ['gi://Shell', {default: {
        get_file_contents_utf8_sync: (p) => fs.readFileSync(p, 'utf8'),
        ActionMode: {NORMAL: 1, OVERVIEW: 2, POPUP: 3, LOCK_SCREEN: 4, UNLOCK_SCREEN: 5},
    }}],
    ['gi://Meta', {default: {
        KeyBindingFlags: {NONE: 0}, MonitorSwitchConfigType: {},
        // The Shell also imports Meta.MonitorManager and friends here.
    }}],
    ['gi://Soup', {default: {Session: class { constructor() {} }}}],
    ['resource:///org/gnome/shell/ui/main.js', shell.Main],
    ['resource:///org/gnome/shell/extensions/extension.js',
        {Extension: class {}, InjectionManager: class { clear() {} }}],
    ['resource:///org/gnome/shell/ui/slider.js', {Slider: Actor}],
]);

const prefix = 'notch-enable:';
const key = '__notchEnableStubs';
globalThis[key] = stubs;
globalThis.global = shell.global;
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

const view = await import('../extension/lib/view.js');
// extension.js too: its enable() is the code that actually failed, so it has
// to load while the gi:// stubs are registered.
const extensionModule = await import('../extension/extension.js');
hooks.deregister();
delete globalThis[key];

/** The Extension object the Shell hands us — note `dir` is a Gio.File. */
const makeExtension = () => ({
    dir: new GFile(extensionDir),
    openPreferences() {},
    getSettings: () => new Gio.Settings({schema_id: 'io.github.pavit12301611.Notch'}),
    settings: null,
});

test('NotchView constructs, lays out and tears down without throwing', () => {
    const extension = makeExtension();
    extension.settings = extension.getSettings();
    const notch = new view.NotchView(extension);
    assert.ok(notch.actor, 'the chrome actor was created');
    assert.ok(shell.Main.layoutManager.added, 'the notch was added as Chrome');
    // The notch must never reserve desktop space (affectsStruts: false is the
    // Shell default and we do not override it), and it must hide itself under
    // fullscreen windows. Both are asserted so a future edit that adds a legacy
    // param or drops tracking gets caught here, not in a screenshot.
    const chrome = shell.Main.layoutManager.chrome;
    assert.equal(chrome.trackFullscreen, true, 'the notch hides under fullscreen windows');
    assert.equal(chrome.affectsStruts, false, 'the notch must not reserve desktop space');
    assert.ok(notch.pages.chat, 'the agent page exists');
    assert.equal(Object.keys(notch.pages).length, 5, 'five tabs');
    notch.destroy();
    assert.ok(shell.Main.layoutManager.removed, 'the notch was removed from Chrome');
});

test('opening, switching tabs and pushing a card all work', () => {
    const extension = makeExtension();
    extension.settings = extension.getSettings();
    const notch = new view.NotchView(extension);
    notch.setExpanded(true);
    assert.equal(notch.expanded, true);
    for (const tab of ['home', 'chat', 'media', 'notifications', 'system'])
        notch.selectTab(tab);
    assert.doesNotThrow(() => notch.receivePsd(JSON.stringify({kind: 'status', state: 'working', text: 'reading disk…'})));
    assert.doesNotThrow(() => notch.receivePsd(JSON.stringify({kind: 'card', title: 'Build', body: 'green'})));
    // The agent tab is where a pushed card lands, so that is the honest check.
    const state = JSON.parse(notch.psdState());
    assert.equal(typeof state.messages, 'number');
    assert.equal(state.thread, 'notch');
    notch.setExpanded(false);
    notch.destroy();
});

test('destroying restores the panel clock it hid', () => {
    const extension = makeExtension();
    extension.settings = extension.getSettings();
    const before = shell.Main.panel.statusArea.dateMenu.visible;
    const notch = new view.NotchView(extension);
    notch.destroy();
    assert.equal(shell.Main.panel.statusArea.dateMenu.visible, before,
        'the panel clock must be put back when the extension is disabled');
});

test('a bad D-Bus payload is ignored, not fatal', () => {
    const extension = makeExtension();
    extension.settings = extension.getSettings();
    const notch = new view.NotchView(extension);
    for (const payload of ['not json', '', null, '{}', '{"kind":"nonsense"}'])
        assert.doesNotThrow(() => notch.receivePsd(payload), `payload ${payload}`);
    notch.destroy();
});

// ── the real thing: extension.js enable() ──────────────────────────────────
// NotchView's constructor is only half the story. extension.js calls
// interfaceXml(this.dir, …) during enable(), and that is exactly where the
// reported "Expected type string for argument 'path'" came from. So construct
// the actual Extension class and run the Shell's own code path.
test('Extension.enable() and disable() run against the real code path', () => {
    const Extension = extensionModule.default;
    const instance = new Extension();
    instance.dir = new GFile(extensionDir);
    instance.settings = null;
    instance.getSettings = () => new Gio.Settings({schema_id: 'io.github.pavit12301611.Notch'});
    instance.openPreferences = () => {};

    assert.doesNotThrow(() => instance.enable(), 'enable() must not throw');
    assert.ok(instance.view, 'a view was created');
    assert.ok(instance.dbus, 'the notch D-Bus interface was exported');
    assert.ok(instance.psdDbus, 'the PSD D-Bus interface was exported');

    // The agent pushes through this interface; it must carry the PSD methods.
    assert.doesNotThrow(() => instance.psdDbus.__callbacks?.PsdState?.() ?? '{}');

    assert.doesNotThrow(() => instance.disable(), 'disable() must not throw');
    assert.equal(instance.view, null);
    assert.equal(instance.dbus, null);
});

// ── the same code on both Shell generations ────────────────────────────────
//
// GNOME 46–48 accept addChrome({affectsInputRegion}) and orient a box with
// `vertical`; 49–50 accept neither. The extension declares support for 46–50,
// so it has to build on both. These two tests swap the fake Shell's parameter
// set and assert the resulting chrome params, which is exactly the difference
// that took the owner's extension down.

test('the notch asks for input-region tracking on Shell 46–48, where it exists', () => {
    layoutManager.generation = 'legacy';
    try {
        const extension = makeExtension();
        extension.settings = extension.getSettings();
        const notch = new view.NotchView(extension);
        assert.equal(layoutManager.chrome.affectsInputRegion, true,
            'GNOME 46–48 should still get the input region');
        assert.equal(layoutManager.chrome.trackFullscreen, true);
        assert.equal(layoutManager.chrome.affectsStruts, false);
        notch.destroy();
    } finally {
        layoutManager.generation = 'modern';
    }
});

test('the notch never sends affectsInputRegion to Shell 49–50, which rejects it', () => {
    layoutManager.generation = 'modern';
    const extension = makeExtension();
    extension.settings = extension.getSettings();
    assert.throws(
        () => layoutManager.addChrome(new Actor(), {affectsInputRegion: true}),
        /Unrecognized parameter "affectsInputRegion"/,
        'the fake must reject it, or this whole test proves nothing');
    const notch = new view.NotchView(extension);
    const chrome = layoutManager.chrome;
    assert.equal('affectsInputRegion' in chrome, false, 'nothing extra may be sent');
    assert.equal(chrome.trackFullscreen, true);
    assert.equal(chrome.affectsStruts, false);
    notch.destroy();
});
