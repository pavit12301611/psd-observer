// dbus.js — the extension's D-Bus identity and interface loading.
//
// Everything PSD and the notch itself call goes through here. Keep tenancy in
// one place: the bus name, the object path and the interface names are the
// contract the agent's src/notch.js relies on.

import Gio from 'gi://Gio';

export const APP_ID = 'io.github.pavit12301611.Notch';

/** The well-known name the extension owns on the session bus. */
export const EXTENSION_ID = `${APP_ID}.Extension`;

/** Second name, kept for the panel/pill tooling that predates the rename. */
export const BUS_NAME = APP_ID;

export const EXTENSION_PATH = '/io/github/pavit12301611/Notch';

/** PSD → notch push channel (PsdMessage / PsdOpen / PsdState). */
export const PSD_INTERFACE = `${APP_ID}.Psd`;

/** A directory handle or a path, always as a string. */
function toPath(dir) {
    if (typeof dir === 'string') return dir;
    // Extension.dir is a Gio.File, not a path string. Passing it straight to
    // Gio.File.new_for_path() is what fails with
    //   Expected type string for argument 'path' but got type GObject.Object
    if (dir && typeof dir.get_path === 'function') return dir.get_path();
    if (dir && typeof dir.get_uri === 'function') return dir.get_uri();
    throw new Error(`Cannot find the extension directory (got ${typeof dir})`);
}

/**
 * Read an interface definition from the extension's dbus/ directory.
 *
 * Accepts either the Extension object's `dir` (a Gio.File) or a plain path, so
 * the call site does not have to care which the Shell hands us.
 *
 * Returns the XML *string*, not a wrapper object. That matters:
 * Gio.DBusExportedObject.wrapJSObject(xml, obj) hands its first argument
 * straight to Gio.DBusInterfaceInfo.new_for_xml(), and GJS's override for that
 * accepts a string only —
 *
 *   function _newNodeInfo(constructor, value) {
 *       if (typeof value === 'string') return constructor(value);
 *       throw TypeError(`Invalid type ${Object.prototype.toString.call(value)}`);
 *   }
 *
 * — so anything object-shaped surfaces on the desktop as the wonderfully
 * unhelpful `TypeError: Invalid type [object Object]` and the extension refuses
 * to enable. Return the string and there is nothing to unwrap.
 *
 * @param {string|Gio.File} dir extension directory
 * @param {string} file file name inside dbus/, e.g. 'io.github.pavit12301611.Notch.Psd.xml'
 * @returns {string} the interface XML
 */
export function interfaceXml(dir, file) {
    const base = toPath(dir).replace(/\/+$/, '');
    const path = `${base}/dbus/${file}`;
    const source = Gio.File.new_for_path(path);
    const [, bytes] = source.load_contents(null);
    const text = new TextDecoder().decode(bytes);
    if (!text.includes('<node')) throw new Error(`Not a D-Bus interface file: ${path}`);
    return text;
}

/**
 * The interface name inside an interface XML document.
 *
 * `export()` does not take an interface name — the skeleton reads it from the
 * XML — so the XML is the only place the name exists. If it drifts from the
 * constant PSD calls, the method call just fails with UnknownInterface at
 * runtime, which is a miserable thing to debug from the client side. Read it
 * back and compare instead.
 *
 * @param {string} xml interface XML, as returned by interfaceXml()
 * @returns {string}
 */
export function interfaceNameOf(xml) {
    const match = /<interface\s+name="([^"]+)"/.exec(typeof xml === 'string' ? xml : '');
    if (!match) throw new Error('D-Bus interface XML has no <interface name="...">');
    return match[1];
}
