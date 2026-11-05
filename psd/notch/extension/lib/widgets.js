// widgets.js — the small vocabulary every page is built from.
//
// Two GNOME 50 details drive this file:
//   1. St.Icon has no `icon_type` property any more; setting one is a hard
//      error inside the Shell. We only ever pass `gicon`, `icon_size` and
//      layout properties.
//   2. St.BoxLayout has no constructor `spacing`; spacing is a CSS property,
//      so it goes through `style`.
//
// Everything returns a real St actor, ready to add_child().

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {giconFor} from './icons.js';

/**
 * St.BoxLayout's orientation property is not the same across the Shell versions
 * this extension declares support for. Measured from the sources:
 *
 *   GNOME 45–47   StBoxLayout: "vertical"     (boolean, default FALSE)
 *   GNOME 48      StBoxLayout: "orientation" AND "vertical"
 *   GNOME 49–50   StBoxLayout: "orientation" only
 *
 * So `{vertical: true}` is a silent no-op on 49+, and
 * `{orientation: Clutter.Orientation.VERTICAL}` is a silent no-op on 45–47.
 * Either way the box keeps its horizontal default and a column renders as a
 * row — no error, just a broken layout. Ask the object which property it has.
 */
const ORIENTATION_PROPERTY = (() => {
    try {
        if (GObject.Object.find_property.call(St.BoxLayout, 'orientation'))
            return 'orientation';
        if (GObject.Object.find_property.call(St.BoxLayout, 'vertical'))
            return 'vertical';
    } catch {
        /* fall through */
    }
    return 'orientation';
})();

/** The constructor properties that make a St.BoxLayout a column (or a row). */
export function boxOrientation(vertical) {
    if (ORIENTATION_PROPERTY === 'vertical')
        return {vertical: Boolean(vertical)};
    return {
        orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
    };
}

/** An icon that is safe to construct on GNOME 46–50. */
export function icon(iconName, size = 16, styleClass = null) {
    const widget = new St.Icon({
        gicon: giconFor(iconName),
        icon_size: size,
        y_align: Clutter.ActorAlign.CENTER,
    });
    if (styleClass) widget.add_style_class_name(styleClass);
    return widget;
}

/** Artwork for media: a cover file when we have one, a themed fallback otherwise. */
export function sourceIcon(gicon, fallbackName, size = 48) {
    const widget = new St.Icon({
        gicon: gicon ?? giconFor(fallbackName),
        icon_size: size,
        y_align: Clutter.ActorAlign.CENTER,
    });
    widget._fallbackName = fallbackName;
    return widget;
}

/** Swap the artwork, keeping the loaded GIcon when there is one. */
export function setIconSource(widget, gicon, fallbackName = widget._fallbackName) {
    if (!widget) return;
    widget._fallbackName = fallbackName;
    widget.gicon = gicon ?? giconFor(fallbackName);
    // Construction-time only for GNOME 50; make sure nothing leaks an icon_name.
    widget.fallback_gicon = null;
}

/** A label. `wrap` enables multi-line text with no ellipsis. */
export function label(text = '', styleClass = null, wrap = false) {
    const widget = new St.Label({
        text: String(text ?? ''),
        y_align: Clutter.ActorAlign.CENTER,
    });
    if (styleClass) widget.add_style_class_name(styleClass);
    if (wrap) {
        widget.clutter_text.line_wrap = true;
        widget.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        widget.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    }
    return widget;
}

/** A wrapping label for bodies of text (status lines, notification previews). */
export function wrapLabel(text = '', styleClass = null) {
    return label(text, styleClass, true);
}

/**
 * A button with an optional icon and an optional text label.
 *
 * @param {{text?: string, iconName?: string, accessibleName?: string, style?: string,
 *          onClick?: Function}} options
 */
export function button({text, iconName, accessibleName, style, onClick, styleClass} = {}) {
    const content = new St.BoxLayout({
        ...boxOrientation(false),
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    content.style = 'spacing: 6px;';

    const widget = new St.Button({
        style_class: style ?? styleClass ?? 'notch-button',
        can_focus: true,
        reactive: true,
        track_hover: true,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        child: content,
    });
    if (accessibleName ?? text) widget.accessible_name = accessibleName ?? text;

    if (iconName) {
        const glyph = icon(iconName, 16);
        widget._notchIcon = glyph;
        content.add_child(glyph);
    }
    if (text) {
        const textLabel = label(text);
        widget._notchLabel = textLabel;
        widget._notchLabelStyle = null;
        content.add_child(textLabel);
    }
    if (onClick) widget.connect('clicked', onClick);
    return widget;
}

/** A box: vertical by default; spacing goes through CSS. */
export function box(vertical = true, styleClass = null, spacing = 0) {
    const widget = new St.BoxLayout(boxOrientation(vertical));
    if (styleClass) widget.add_style_class_name(styleClass);
    if (spacing) widget.style = `spacing: ${spacing}px;`;
    return widget;
}

/** A centered empty state: a title and one line of guidance. */
export function emptyState(title, body, iconName = null) {
    const container = new St.BoxLayout({
        ...boxOrientation(true),
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
        y_expand: true,
    });
    container.add_style_class_name('notch-empty');
    if (iconName) container.add_child(icon(iconName, 32, 'notch-empty-icon'));
    const titleLabel = label(title, 'notch-empty-title');
    titleLabel.x_align = Clutter.ActorAlign.CENTER;
    const bodyLabel = wrapLabel(body, 'notch-empty-body');
    bodyLabel.x_align = Clutter.ActorAlign.CENTER;
    container.add_child(titleLabel);
    container.add_child(bodyLabel);
    return container;
}

/** Visually and functionally disable a control. */
export function setSensitive(widget, sensitive) {
    if (!widget) return;
    widget.reactive = Boolean(sensitive);
    widget.can_focus = Boolean(sensitive);
    widget.opacity = sensitive ? 255 : 110;
}

/** Replace a label's text without rebuilding the widget. */
export function setText(widget, text) {
    if (widget) widget.text = String(text ?? '');
}

export {Clutter, Pango, St};
