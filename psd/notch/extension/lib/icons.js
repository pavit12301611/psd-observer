// icons.js — the extension ships its own symbolic icons.
//
// They live beside the extension, not in the icon theme, so the notch looks the
// same on every Fedora release. A Gio.FileIcon is built from the real path:
// ThemeIcon would only find them if they were installed system-wide.

import Gio from 'gi://Gio';

const FALLBACK_THEME_DIRS = [
    '/usr/share/icons/hicolor/scalable/actions',
    '/usr/share/icons/hicolor/symbolic/actions',
];

let iconDirectory = null;

/**
 * Point the helper at the extension's icons/ directory.
 * @param {Gio.File} directory the extension's `dir` resolved to icons/
 */
export function setIconDirectory(directory) {
    iconDirectory = directory ?? null;
}

/** True when this extension's own copy of `name.svg` exists. */
export function hasLocalIcon(name) {
    if (!iconDirectory) return false;
    try {
        const file = iconDirectory.get_child(`${name}.svg`);
        return Boolean(file?.query_exists(null));
    } catch {
        return false;
    }
}

/**
 * A GIcon for `name`. Local file when we ship it, themed icon otherwise, so a
 * missing asset degrades to the system icon set instead of a blank square.
 */
export function giconFor(name) {
    const clean = String(name ?? '').replace(/\.svg$/, '');
    if (hasLocalIcon(clean)) {
        try {
            return new Gio.FileIcon({file: iconDirectory.get_child(`${clean}.svg`)});
        } catch {
            /* fall through to the theme */
        }
    }
    return Gio.ThemedIcon.new(clean);
}

/** The icon file used when a page has nothing to show. */
export const EMPTY_ICON = 'utilities-system-monitor-symbolic';
export {FALLBACK_THEME_DIRS};
