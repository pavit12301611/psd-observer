import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

// Exercise the real widgets.js against a strict St.Icon contract. The property
// list matches GNOME Shell 50.6 st-icon.c plus the inherited actor properties we
// use. This catches invalid constructor properties and later invalid writes;
// a syntax-only check cannot do either.
const iconProperties = new Set([
    'gicon', 'fallback_gicon', 'icon_name', 'icon_size', 'fallback_icon_name',
    'style_class', 'style', 'x_expand', 'y_expand', 'x_align', 'y_align', 'visible',
]);

class Actor {
    constructor(properties = {}) {
        this.children = [];
        Object.assign(this, properties);
    }
    add_child(child) { this.children.push(child); }
    connect() { return 1; }
    add_style_class_name() {}
}

class Icon extends Actor {
    constructor(properties = {}) {
        for (const name of Object.keys(properties)) {
            if (!iconProperties.has(name)) throw new Error(`No property ${name} on StIcon`);
        }
        super();
        this._gicon = null;
        this._icon_name = null;
        this.icon_size = -1;
        this.fallback_gicon = null;
        Object.assign(this, properties);
        return new Proxy(this, {
            set(target, name, value) {
                if (typeof name === 'string' && !name.startsWith('_') && !iconProperties.has(name))
                    throw new Error(`No property ${name} on StIcon`);
                target[name] = value;
                return true;
            },
        });
    }
    get icon_name() { return this._icon_name; }
    set icon_name(name) {
        this._icon_name = name;
        // Upstream icon_name is a convenience setter that replaces gicon.
        this._gicon = name ? {themed: name} : null;
    }
    get gicon() { return this._gicon; }
    set gicon(gicon) {
        this._gicon = gicon;
        this._icon_name = gicon?.themed ?? null;
    }
}

class Label extends Actor {
    constructor(properties = {}) {
        super(properties);
        this.clutter_text = {};
    }
}
class Button extends Actor {}
class BoxLayout extends Actor {
    constructor(properties = {}) {
        if (Object.hasOwn(properties, 'spacing'))
            throw new Error('No property spacing on StBoxLayout');
        super(properties);
    }
}
class Slider {
    constructor(value) { this.value = value; }
    connect() { return 1; }
    add_style_class_name() {}
}

class FileIcon {
    constructor(properties = {}) { Object.assign(this, properties); }
}
const Gio = {FileIcon, ThemedIcon: {new: name => ({themed: name})}};
const GLib = {get_monotonic_time: () => 1_000_000};
const St = {Icon, Label, Button, BoxLayout};
const Clutter = {ActorAlign: {START: 0, CENTER: 1, FILL: 2, END: 3}};
const Pango = {EllipsizeMode: {NONE: 0, END: 3}, WrapMode: {WORD_CHAR: 2}, Alignment: {CENTER: 1}};
const stubs = new Map([
    ['gi://St', {default: St}],
    ['gi://Gio', {default: Gio}],
    ['gi://GLib', {default: GLib}],
    ['gi://Clutter', {default: Clutter}],
    ['gi://Pango', {default: Pango}],
    ['resource:///org/gnome/shell/ui/slider.js', {Slider}],
]);
const prefix = 'notch-stub:';
const globalKey = '__notchStContractStubs';
globalThis[globalKey] = stubs;
const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
        if (stubs.has(specifier)) return {url: `${prefix}${specifier}`, shortCircuit: true};
        return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
        if (!url.startsWith(prefix)) return nextLoad(url, context);
        const specifier = url.slice(prefix.length);
        const exports = stubs.get(specifier);
        const lines = [`const values = globalThis.${globalKey}.get(${JSON.stringify(specifier)});`];
        for (const name of Object.keys(exports)) {
            lines.push(name === 'default' ? 'export default values.default;' :
                `export const ${name} = values.${name};`);
        }
        return {format: 'module', source: lines.join('\n'), shortCircuit: true};
    },
});
const widgets = await import('../../extension/lib/widgets.js');
const icons = await import('../../extension/lib/icons.js');
icons.setIconDirectory({get_child: name => ({name, query_exists: () => true})});
hooks.deregister();
delete globalThis[globalKey];

test('icon helper constructs a valid GNOME 50 St.Icon without icon_type', () => {
    const widget = widgets.icon('user-home-symbolic', 22);
    assert.equal(widget.gicon.file.name, 'user-home-symbolic.svg');
    assert.equal(widget.icon_name, null);
    assert.equal(widget.icon_size, 22);
    assert.equal(Object.hasOwn(widget, 'icon_type'), false);
    assert.throws(() => { widget.icon_type = 0; }, /No property icon_type on StIcon/);
});

test('artwork switching keeps the loaded gicon and restores a themed fallback', () => {
    const cover = {file: '/tmp/cover.png'};
    const widget = widgets.sourceIcon(cover, 'audio-x-generic-symbolic', 72);
    assert.equal(widget.gicon, cover);
    assert.equal(widget.icon_name, null);
    widgets.setIconSource(widget, null, 'audio-x-generic-symbolic');
    assert.equal(widget.gicon.file.name, 'audio-x-generic-symbolic.svg');
    assert.equal(widget.icon_name, null);
    widgets.setIconSource(widget, cover, 'audio-x-generic-symbolic');
    assert.equal(widget.gicon, cover);
    assert.equal(widget.fallback_gicon, null);
});

test('button, label and box helpers use valid St construction properties', () => {
    const widget = widgets.button({text: 'Home', iconName: 'user-home-symbolic', accessibleName: 'Home'});
    assert.equal(widget.accessible_name, 'Home');
    assert.equal(widget._notchLabel.text, 'Home');
    assert.equal(widget._notchIcon.gicon.file.name, 'user-home-symbolic.svg');
    const wrapped = widgets.wrapLabel('A long status message');
    assert.equal(wrapped.clutter_text.line_wrap, true);
    assert.equal(wrapped.clutter_text.ellipsize, Pango.EllipsizeMode.NONE);
    const container = widgets.box(true, 'notch-page', 6);
    assert.equal(container.vertical, true);
    assert.match(container.style, /spacing: 6px/);
});

test('empty states are centered text cards with title and body', () => {
    const widget = widgets.emptyState('Nothing playing', 'Start a song to see controls.');
    assert.equal(widget.vertical, true);
    assert.equal(widget.children.length, 2);
    assert.equal(widget.children[0].text, 'Nothing playing');
    assert.equal(widget.children[1].clutter_text.line_wrap, true);
});

test('disabled controls lose focus and look disabled', () => {
    const widget = widgets.button({text: 'Play', iconName: 'media-playback-start-inverse-symbolic'});
    widgets.setSensitive(widget, false);
    assert.equal(widget.reactive, false);
    assert.equal(widget.can_focus, false);
    assert.equal(widget.opacity, 110);
    widgets.setSensitive(widget, true);
    assert.equal(widget.reactive, true);
    assert.equal(widget.opacity, 255);
});
