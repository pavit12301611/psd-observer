// layout.js — the fit maths for the header and the page body.
//
// The header must never overflow: five tabs, a clock, and the settings/close
// controls all compete for the same strip. Rather than let St clip it, we
// *measure* the requirement and pick a mode that fits:
//
//   labels  clock + text tab labels      (roomy)
//   icons   clock + icon-only tabs       (default)
//   ultra   icons + a tighter gutter     (narrow or large text)
//
// Everything here is pure so it can be proved in tests.

/** How much of the monitor an open notch may use, once margins are honoured. */
export function availableOpenSize(monitor, options = {}) {
    const margin = Math.max(0, options.floatingMargin ?? 12);
    return {
        // An open notch never touches a screen edge: leave the margin on both
        // sides, whether it is docked to the panel or floating.
        width: Math.max(1, monitor.width - margin * 2),
        // Always leave the panel's height at the top, and breathe at the bottom.
        height: Math.max(1, monitor.height - (options.panelHeight ?? 32) - margin),
    };
}

/** Home, Agent, Media, Alerts, System. */
export const TAB_COUNT = 5;

const LABEL_THRESHOLD = 660;
const ICON_THRESHOLD = 300;

/** Which header mode suits this width? */
export function headerMode(width) {
    if (width >= LABEL_THRESHOLD) return 'labels';
    if (width <= ICON_THRESHOLD) return 'ultra';
    return 'icons';
}

/**
 * Width the header needs, and whether the requested mode fits.
 *
 * @param {number} width available width in logical pixels
 * @param {number} textScale the Shell's text scaling factor
 */
export function headerLayout(width, textScale = 1) {
    const scale = Math.max(0.8, Number(textScale) || 1);
    // Bigger text makes every label wider, so the mode is chosen on the width
    // the header effectively has. This is why a wide notch at 125% still uses
    // icons: the text would not fit at 125%.
    const preferred = headerMode(width / scale);

    // Text scaling must not push the header wider than the notch: at 2x the
    // labels become icons instead, and the clock only ever uses two digits'
    // worth of room. Each mode is measured on its own terms.
    // The header never grows with text scale — it sheds things instead, in this
    // order: tab labels → text in tabs → the settings button. Only the close
    // button and the tabs themselves are non-negotiable.
    const budget = (mode) => {
        const tab = mode === 'labels' ? 84 : mode === 'icons' ? 26 : 22;
        const clock = mode === 'labels' ? 56 : 40;
        const button = 24;
        const gutter = 6 + (mode === 'ultra' ? button : button * 2);
        const required = tab * TAB_COUNT + clock + gutter;
        return {tab, clock, button, gutter, required};
    };

    // Walk down from the preferred mode until something fits, so a very narrow
    // notch still shows its tabs instead of clipping them.
    let mode = preferred;
    let size = budget(mode);
    while (size.required > width && mode !== 'ultra') {
        mode = mode === 'labels' ? 'icons' : 'ultra';
        size = budget(mode);
    }
    return {
        mode,
        ultra: mode === 'ultra',
        showLabels: mode === 'labels',
        showSettings: mode !== 'ultra',
        tabWidth: size.tab,
        clockWidth: size.clock,
        controlsWidth: size.gutter,
        gutter: size.gutter,
        requiredWidth: size.required,
        fits: size.required <= width,
        spacing: Math.round(6 * scale),
    };
}

/** Columns for the System page's stat cards. */
export function statColumns(width) {
    if (width >= 420) return 2;
    return 1;
}

/**
 * The content box inside the notch rectangle: everything below the panel, at a
 * scale that cannot overflow.
 */
export function contentLayout(rect, options = {}) {
    const panelHeight = Math.max(1, options.panelHeight ?? 32);
    const height = Math.max(1, rect.height - panelHeight);
    // The notch rect is already scaled into stage pixels; the content inside it
    // is laid out at 1:1 so text stays crisp. Only text genuinely scales.
    const layoutScale = 1;
    const textScale = Math.max(0.8, options.textScale ?? 1);
    // Effective width is what text actually wraps in: a 2x text scale halves it.
    const effectiveWidth = Math.max(1, rect.width / textScale);
    // Never scale content *up*; only compress it when the notch is tiny.
    const scale = Math.min(1, layoutScale);
    return {
        width: rect.width,
        height,
        scale,
        layoutScale,
        textScale,
        effectiveWidth,
        pageHeight: Math.max(1, height / scale),
        columns: statColumns(effectiveWidth),
        header: headerLayout(rect.width, textScale),
    };
}
