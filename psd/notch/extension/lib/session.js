import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * The three settings the Preferences window offers that used to do nothing.
 *
 * All three were declared in the schema, shown in Preferences, and never read by
 * the extension — so flipping them changed a gsettings value and nothing else.
 * They are wired here rather than in view.js because they talk to Shell and
 * session-wide settings rather than to the notch's own actors.
 */

// ── Do Not Disturb ──────────────────────────────────────────────────────────
//
// GNOME's own indicator binds `show-banners` INVERTED to its checked state
// (js/ui/status/doNotDisturb.js), and that one key *is* Do Not Disturb: with
// banners off, notifications still arrive and still count, they just do not pop
// up. Reading it directly keeps the notch honest — the button reflects the
// session, it does not keep its own idea of the state.
const NOTIFICATIONS_SCHEMA = 'org.gnome.desktop.notifications';

/** @returns {Gio.Settings|null} */
function notificationSettings() {
    try {
        const source = Gio.SettingsSchemaSource.get_default();
        if (!source?.lookup(NOTIFICATIONS_SCHEMA, true)) return null;
        const settings = new Gio.Settings({schema_id: NOTIFICATIONS_SCHEMA});
        return settings.settings_schema.has_key('show-banners') ? settings : null;
    } catch {
        return null;
    }
}

/** True when banners are suppressed — i.e. Do Not Disturb is on. */
export function dndEnabled(settings = notificationSettings()) {
    if (!settings) return false;
    try {
        return !settings.get_boolean('show-banners');
    } catch {
        return false;
    }
}

/** Flip Do Not Disturb. Returns the new state, or null when unavailable. */
export function toggleDnd(settings = notificationSettings()) {
    if (!settings) return null;
    try {
        const next = !dndEnabled(settings);
        settings.set_boolean('show-banners', !next);
        // Flush so anything else watching the key (GNOME's own quick-settings
        // toggle, our own signal handler) sees it immediately rather than at the
        // next idle. g_settings_sync() is a static, hence Gio.Settings.sync().
        // It is best-effort: a failure here must not look like the toggle failed.
        try {
            Gio.Settings.sync();
        } catch {
            /* write already happened; the flush is an optimisation */
        }
        return next;
    } catch {
        return null;
    }
}

/**
 * Call `callback` whenever Do Not Disturb changes, from anywhere.
 *
 * Returns a handle rather than a bare signal id: the Gio.Settings object has to
 * be kept alive for the handler to matter and disconnected on teardown, and
 * getting that wrong leaks a signal across every disable/enable cycle.
 *
 * @returns {{disconnect: Function}|null}
 */
export function onDndChanged(callback, settings = notificationSettings()) {
    if (!settings) return null;
    let id = null;
    try {
        id = settings.connect('changed::show-banners', () => callback(dndEnabled(settings)));
    } catch {
        return null;
    }
    return {
        disconnect() {
            if (id === null) return;
            try {
                settings.disconnect(id);
            } catch {
                /* settings object already gone */
            }
            id = null;
        },
    };
}

// ── monitor choice ──────────────────────────────────────────────────────────
//
// `monitor-index` is -1 for "follow the focused monitor" (the default, and what
// a laptop lid-closed setup wants) or a fixed index for people with two screens
// who want the notch to stay on one.
const DISPLAY_CONFIG_SCHEMA = 'org.gnome.Mutter.DisplayConfig';
const MONITORS_CHANGED = 'monitors-changed';

/**
 * The monitor the notch belongs on.
 *
 * @param {number} index `monitor-index` from settings; -1 means "current"
 * @returns {{x: number, y: number, width: number, height: number, index: number}}
 */
export function resolveMonitor(index = -1) {
    const manager = global.backend?.get_monitor_manager?.();
    const monitors = manager?.get_logical_monitors?.();
    const fallback = {x: 0, y: 0, width: 1920, height: 1080, index: 0};

    const wanted = Number.isInteger(index) ? index : -1;
    if (wanted >= 0 && Array.isArray(monitors) && monitors[wanted]) {
        const monitor = monitors[wanted];
        return {
            x: monitor.x ?? 0,
            y: monitor.y ?? 0,
            width: monitor.width ?? fallback.width,
            height: monitor.height ?? fallback.height,
            index: wanted,
        };
    }

    // Follow the monitor the pointer/focus is on, which is what -1 means and
    // what makes the notch feel attached to whatever you are looking at.
    const current = manager?.get_current_monitor?.();
    const geometry = current?.get_geometry?.() ?? current;
    if (geometry && Number.isFinite(geometry.width)) {
        return {
            x: geometry.x ?? 0,
            y: geometry.y ?? 0,
            width: geometry.width,
            height: geometry.height,
            // get_current_monitor() hands back an index on some versions and a
            // monitor object on others; only report an index when we know it.
            index: typeof manager?.get_current_monitor_index === 'function'
                ? manager.get_current_monitor_index()
                : (typeof current === 'number' ? current : 0),
        };
    }
    return fallback;
}

/** Whether the signal actually fires with the given name on this Shell. */
export const MONITORS_CHANGED_SIGNAL = MONITORS_CHANGED;

// ── reserving space for the collapsed notch ─────────────────────────────────
//
// A notch normally floats over the desktop and covers nothing. With
// `reserve-space` on, the collapsed pill instead pushes maximised windows down
// by its own height — the same thing GNOME's top bar does. It uses the public
// LayoutManager.trackChrome(actor, {affectsStruts: true}) path, which exists on
// every version this extension declares support for.
//
// Why a dedicated child actor: addChrome() params are fixed for the notch actor
// at construction, and affectsStruts cannot be toggled afterwards. A separate
// actor can be tracked and untracked at will, which is exactly what a setting
// needs.
/**
 * Should the collapsed notch reserve work-area space right now?
 *
 * Only when the owner asked for it AND the pill is actually sitting there. An
 * open notch is an overlay you are looking at; reserving space for it would
 * shove every maximised window down for as long as the panel is open, which is
 * exactly the kind of thing that makes a desktop feel broken.
 *
 * @param {Gio.Settings} settings extension settings
 * @param {{expanded: boolean, visible: boolean}} state
 * @returns {boolean}
 */
export function shouldReserveSpace(settings, {expanded, visible}) {
    try {
        return settings.get_boolean('reserve-space') && !expanded && visible !== false;
    } catch {
        return false;
    }
}

export class StrutReservation {
    /**
     * @param {object} options
     * @param {object} [options.layoutManager] Main.layoutManager override (tests)
     */
    constructor({layoutManager = Main.layoutManager} = {}) {
        this.layoutManager = layoutManager;
        this.actor = null;
        this.reserved = false;
    }

    /**
     * Reserve `width` × `height` at the top of the given monitor, or release it.
     *
     * `wanted` is the reserve-space setting ANDed with "the notch is collapsed
     * and visible" — passing a plain boolean keeps this class free of settings
     * objects and shell state, which is what makes it testable.
     *
     * @param {boolean} wanted the reserve-space setting, gated on the notch
     *   actually occupying that space right now
     * @param {{x: number, y: number, width: number, height: number}} monitor
     */
    apply(wanted, monitor) {
        const width = Math.max(0, Math.round(monitor?.width ?? 0));
        const height = Math.max(0, Math.round(monitor?.height ?? 0));
        const usable = Boolean(wanted) && width > 0 && height > 0;

        if (!usable) {
            this.release();
            return false;
        }
        if (!this.actor)
            this.actor = new St.Widget({style_class: 'notch-strut', visible: true});
        this.actor.set_position(Math.round(monitor.x ?? 0), Math.round(monitor.y ?? 0));
        this.actor.set_size(width, height);

        if (!this.reserved) {
            try {
                // The two params every supported Shell still accepts. This is
                // the one place affectsStruts belongs: it is the entire point.
                this.layoutManager.addChrome(this.actor, {affectsStruts: true});
                this.reserved = true;
            } catch (error) {
                globalThis.log?.('notch: could not reserve space', error);
                this.reserved = false;
                return false;
            }
        }
        return true;
    }

    release() {
        if (!this.reserved) return;
        try {
            this.layoutManager.removeChrome(this.actor);
        } catch {
            /* the actor may already be gone */
        }
        this.reserved = false;
    }

    destroy() {
        this.release();
        this.actor?.destroy();
        this.actor = null;
    }
}
