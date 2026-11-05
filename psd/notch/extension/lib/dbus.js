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

/**
 * Read an interface definition from the extension's dbus/ directory.
 *
 * The path comes from the Extension object's `dir`, so the extension works
 * wherever it is installed — no hard-coded home paths, no ESM import of XML.
 *
 * @param {string} dir extension directory (extension.dir)
 * @param {string} file file name inside dbus/, e.g. 'io.github.pavit12301611.Notch.Psd.xml'
 * @returns {{xml: string}}
 */
export function interfaceXml(dir, file) {
    const path = `${dir}/dbus/${file}`;
    const file_ = Gio.File.new_for_path(path);
    const [, bytes] = file_.load_contents(null);
    const text = new TextDecoder().decode(bytes);
    if (!text.includes('<node')) throw new Error(`Not a D-Bus interface file: ${path}`);
    return {xml: text};
}
