// geometry.js — where the notch sits and how big it is. Pure functions only:
// no St, no Clutter, so the maths is testable outside GNOME Shell.

import {availableOpenSize} from './layout.js';

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const containsPoint = (rect, x, y) =>
    x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;

/** Page sizes in logical pixels at 100% scale. The agent page is the roomiest. */
export const PAGE_SIZES = Object.freeze({
    home: {width: 640, height: 220},
    // The agent page needs room for a real conversation: prompt row, history
    // and suggestion chips at 820x560.
    chat: {width: 820, height: 560},
    media: {width: 640, height: 320},
    notifications: {width: 640, height: 380},
    system: {width: 640, height: 360},
});

/**
 * The corner treatment. A docked notch is fused to the top edge: hard, nearly
 * square top corners with wings, and the familiar rounded bottom. Floating
 * presets round all four.
 */
export function surfaceRadii(mode, options = {}) {
    const scale = (options.cssScale ?? 1) * (options.layoutScale ?? 1);
    const opened = mode === 'open' || mode === 'peek';
    const base = Math.round((options.cornerRadius ?? 24) * scale);
    if (options.adaptiveCorners === false)
        return {topRadius: base, bottomRadius: base};
    if ((options.placement ?? 'panel') !== 'panel')
        return {topRadius: base, bottomRadius: base};
    return {
        topRadius: Math.round((opened ? 19 : 6) * scale),
        bottomRadius: Math.round((opened ? 24 : 14) * scale),
    };
}

/**
 * Rect for the notch in stage pixels.
 *
 * @param {{x:number,y:number,width:number,height:number}} monitor monitor geometry
 * @param {object} options settings snapshot (see ../lib/view.js #options)
 * @param {boolean} expanded open or closed
 * @param {string|null} mode override: 'closed' | 'open' | 'peek'
 */
export function notchGeometry(monitor, options, expanded = false, mode = null) {
    const cssScale = Math.max(1, options.cssScale ?? 1);
    const layoutScale = Math.max(0.5, options.layoutScale ?? 1);
    const scale = cssScale * layoutScale;
    const state = mode ?? (expanded ? 'open' : 'closed');
    const page = PAGE_SIZES[options.tab] ?? PAGE_SIZES.home;
    const panelHeight = Math.max(1, options.panelHeight ?? 32);
    const available = availableOpenSize(monitor, options);
    let width;
    let height;

    if (state === 'open') {
        width = Math.min(page.width * scale, (options.expandedWidth ?? 640) * scale, available.width);
        const textScale = Math.max(0.8, options.textScale ?? 1);
        const effectiveWidth = Math.min(page.width, options.expandedWidth ?? 640) / textScale;
        // Narrow/large-text layouts wrap more. Reserve extra height instead of
        // introducing scrollbars on non-Alert pages.
        const narrowBoost = effectiveWidth < 420 ? 80 : 0;
        const veryNarrowBoost = effectiveWidth < 340 ? 160 : 0;
        height = Math.min(page.height * scale + narrowBoost + veryNarrowBoost,
            (options.expandedHeight ?? 480) * scale, available.height);
    } else if (state === 'peek') {
        width = Math.min(440 * scale, available.width);
        height = Math.min(panelHeight + 112 * scale, available.height);
    } else {
        width = (options.collapsedWidth ?? 185) * scale;
        // matchPanelHeight is the MacBook docked preset: the pill is exactly the
        // panel's height. Otherwise the owner's collapsed height wins.
        height = (options.matchPanelHeight ? panelHeight : (options.collapsedHeight ?? 32) * scale);
        if (options.mediaWings) width += 64 * scale;
        if (options.hovered) {
            width += 12 * scale;
            height += 4 * scale;
        }
        width = Math.min(width, available.width);
        height = Math.min(height, available.height);
    }

    const placement = options.placement ?? 'panel';
    let x;
    let y;
    if (placement === 'panel') {
        y = monitor.y;
        // The closed/open pair shares a centre so opening grows outward.
        x = monitor.x + (monitor.width - width) / 2 + (options.horizontalOffset ?? 0);
        if (state === 'open') {
            // Keep the *expanded* width centred even when the closed pill was
            // measured first.
            x = monitor.x + (monitor.width - width) / 2 + (options.horizontalOffset ?? 0);
        }
    } else if (placement === 'floating') {
        y = monitor.y + (options.floatingMargin ?? 12);
        x = monitor.x + (monitor.width - width) / 2 + (options.horizontalOffset ?? 0);
    } else {
        y = monitor.y + panelHeight + 6;
        x = monitor.x + (monitor.width - width) / 2 + (options.horizontalOffset ?? 0);
    }

    x = clamp(x, monitor.x, monitor.x + monitor.width - width);
    y = clamp(y, monitor.y, monitor.y + monitor.height - height);

    const radii = surfaceRadii(state, options);
    return {
        x, y, width, height,
        topRadius: radii.topRadius,
        bottomRadius: radii.bottomRadius,
    };
}
