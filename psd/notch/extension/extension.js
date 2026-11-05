import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {NotchView} from './lib/view.js';
import {APP_ID, EXTENSION_ID, EXTENSION_PATH, PSD_INTERFACE, interfaceXml, interfaceNameOf} from './lib/dbus.js';

export default class NotchExtension extends Extension {
    enable() {
        if (this.view) return;
        this.settings = this.getSettings();
        // Migrate untouched earlier presets to the MacBook-native v2 geometry.
        // Customized geometries are left alone; the preset is also available in Settings.
        const untouchedV1 = this.settings.get_string('placement') === 'panel' &&
            this.settings.get_int('collapsed-width') === 220 &&
            this.settings.get_int('expanded-width') === 760 &&
            this.settings.get_int('expanded-height') === 480;
        const untouchedLegacy = this.settings.get_string('placement') === 'top-center' &&
            this.settings.get_int('collapsed-width') === 240 &&
            this.settings.get_int('expanded-width') === 720;
        // v10: the old 320px maximum was too short for centered pages.
        const untouchedV9 = this.settings.get_string('placement') === 'panel' &&
            this.settings.get_int('collapsed-width') === 185 &&
            this.settings.get_int('expanded-width') === 640 &&
            this.settings.get_int('expanded-height') === 320;
        // v15: non-scrolling centered pages need more vertical budget than v10.
        const untouchedV14 = this.settings.get_string('placement') === 'panel' &&
            this.settings.get_int('collapsed-width') === 185 &&
            this.settings.get_int('expanded-width') === 640 &&
            this.settings.get_int('expanded-height') === 360;
        if (untouchedV1 || untouchedLegacy || untouchedV9 || untouchedV14) {
            this.settings.set_string('placement', 'panel');
            this.settings.set_int('collapsed-width', 185);
            this.settings.set_int('collapsed-height', 32);
            this.settings.set_int('expanded-width', 640);
            this.settings.set_int('expanded-height', 480);
            this.settings.set_int('corner-radius', 24);
            this.settings.set_double('notch-scale', 1.0);
            this.settings.set_boolean('match-panel-height', true);
            this.settings.set_boolean('adaptive-corners', true);
            this.settings.set_boolean('closed-media', true);
            this.settings.set_string('animation-profile', 'mac-spring');
            this.settings.set_int('open-animation-ms', 420);
            this.settings.set_int('close-animation-ms', 450);
            this.settings.set_int('peek-duration-ms', 5000);
        }
        this.view = new NotchView(this);
        this.keybindingAdded = Main.wm.addKeybinding('toggle-notch', this.settings,
            Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this.view?.toggle());
        const xml = interfaceXml(this.dir, `${APP_ID}.xml`);
        this.dbus = Gio.DBusExportedObject.wrapJSObject(xml, {
            Toggle: () => this.view?.toggle(),
            SetExpanded: expanded => this.view?.setExpanded(expanded),
            GetState: () => this.view?.state() ?? '{}',
        });
        this.dbus.export(Gio.DBus.session, EXTENSION_PATH);
        // PSD → notch: one JSON method, so the agent can push a card, a live
        // status, a streamed token or a system snapshot with a single D-Bus call.
        const psdXml = interfaceXml(this.dir, `${APP_ID}.Psd.xml`);
        // export() takes no interface name (the skeleton reads it from the XML),
        // so make sure the XML still describes the name PSD calls. A silent
        // mismatch here is an UnknownInterface error on the client side.
        const exportedName = interfaceNameOf(psdXml);
        if (exportedName !== PSD_INTERFACE)
            throw new Error(`PSD interface XML says "${exportedName}", but clients call "${PSD_INTERFACE}"`);
        this.psdDbus = Gio.DBusExportedObject.wrapJSObject(psdXml, {
            PsdMessage: (payload) => this.view?.receivePsd(payload),
            PsdOpen: (tab) => this.view?.openPsd(tab || 'chat'),
            PsdState: () => this.view?.psdState() ?? '{}',
        });
        // GjsDBusImplementation extends GDBusInterfaceSkeleton, and
        // skeleton.export() takes exactly (connection, object_path) — the
        // interface name is inside the XML, not a third argument. Passing one
        // only earns a "Too many arguments" warning, so keep it to two.
        this.psdDbus.export(Gio.DBus.session, EXTENSION_PATH);
        this.busOwnerId = Gio.bus_own_name(Gio.BusType.SESSION, EXTENSION_ID,
            Gio.BusNameOwnerFlags.NONE, null, null, null);
    }

    disable() {
        if (this.busOwnerId) Gio.bus_unown_name(this.busOwnerId);
        this.busOwnerId = 0;
        this.dbus?.unexport();
        this.dbus = null;
        this.psdDbus?.unexport();
        this.psdDbus = null;
        if (this.keybindingAdded) Main.wm.removeKeybinding('toggle-notch');
        this.keybindingAdded = false;
        this.view?.destroy();
        this.view = null;
        this.settings = null;
    }
}
