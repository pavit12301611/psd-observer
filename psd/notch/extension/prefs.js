import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/** Native Libadwaita preferences shown directly by GNOME Extensions. */
export default class NotchPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const handlers = [];
        const track = (object, id) => handlers.push([object, id]);
        window.connect('close-request', () => {
            for (const [object, id] of handlers) {
                try { object.disconnect(id); } catch { /* already disconnected */ }
            }
            return false;
        });

        const addSwitch = (group, key, title, subtitle = '') => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
            return row;
        };
        const addSpin = (group, key, title, lower, upper, step = 1, subtitle = '') => {
            const row = new Adw.SpinRow({title, subtitle,
                adjustment: new Gtk.Adjustment({lower, upper, step_increment: step,
                    page_increment: step * 10, value: settings.get_int(key)})});
            track(row, row.connect('notify::value', () => {
                const value = Math.round(row.value);
                if (settings.get_int(key) !== value) settings.set_int(key, value);
            }));
            track(settings, settings.connect(`changed::${key}`, () => {
                const value = settings.get_int(key);
                if (Math.round(row.value) !== value) row.value = value;
            }));
            group.add(row);
            return row;
        };
        const group = (page, title, description = '') => {
            const widget = new Adw.PreferencesGroup({title, description});
            page.add(widget);
            return widget;
        };

        const appearance = new Adw.PreferencesPage({title: 'Appearance',
            icon_name: 'preferences-desktop-appearance-symbolic'});
        const shape = group(appearance, 'Shape & position',
            'Logical pixels. The notch is clamped to the selected monitor.');
        const placementValues = ['top-center', 'floating', 'panel'];
        const placementModel = new Gtk.StringList();
        ['Below panel (legacy)', 'Floating island (optional)', 'MacBook top edge (default)'].forEach(s => placementModel.append(s));
        const placement = new Adw.ComboRow({title: 'Placement', subtitle: 'MacBook mode replaces the centered top-bar clock', model: placementModel,
            selected: Math.max(0, placementValues.indexOf(settings.get_string('placement')))});
        track(placement, placement.connect('notify::selected', () => {
            settings.set_string('placement', placementValues[placement.selected]);
        }));
        track(settings, settings.connect('changed::placement', () => {
            const index = placementValues.indexOf(settings.get_string('placement'));
            if (index >= 0 && placement.selected !== index) placement.selected = index;
        }));
        shape.add(placement);
        const preset = new Adw.ActionRow({title: 'MacBook preset',
            subtitle: 'Top-edge notch, idle clock, notification routing and smooth open/close animation'});
        const presetButton = new Gtk.Button({label: 'Apply', valign: Gtk.Align.CENTER});
        presetButton.connect('clicked', () => {
            settings.set_string('placement', 'panel');
            settings.set_int('collapsed-width', 185);
            settings.set_int('collapsed-height', 32);
            settings.set_int('expanded-width', 640);
            settings.set_int('expanded-height', 480);
            settings.set_int('corner-radius', 24);
            settings.set_double('notch-scale', 1.0);
            settings.set_boolean('match-panel-height', true);
            settings.set_boolean('adaptive-corners', true);
            settings.set_boolean('closed-media', true);
            settings.set_string('animation-profile', 'mac-spring');
            settings.set_double('opacity', 1.0);
            settings.set_boolean('replace-panel-clock', true);
            settings.set_boolean('idle-clock', true);
            settings.set_boolean('notifications-in-notch', true);
            settings.set_boolean('auto-open-notifications', true);
            settings.set_boolean('animations', true);
            settings.set_int('open-animation-ms', 420);
            settings.set_int('close-animation-ms', 450);
            settings.set_int('peek-duration-ms', 5000);
            window.add_toast(new Adw.Toast({title: 'MacBook preset applied'}));
        });
        preset.add_suffix(presetButton);
        preset.set_activatable_widget(presetButton);
        shape.add(preset);
        addSpin(shape, 'monitor-index', 'Monitor', -1, 15, 1, '-1 = primary monitor');
        addSpin(shape, 'collapsed-width', 'Collapsed base width', 150, 520, 10);
        addSpin(shape, 'collapsed-height', 'Collapsed height', 24, 64);
        addSpin(shape, 'expanded-width', 'Maximum page width', 480, 1100, 10);
        addSpin(shape, 'expanded-height', 'Maximum page height', 200, 720, 10);
        addSwitch(shape, 'match-panel-height', 'Match panel height when closed');
        addSwitch(shape, 'adaptive-corners', 'Adaptive MacBook corners');
        addSpin(shape, 'floating-margin', 'Floating top margin', 0, 200);
        addSpin(shape, 'horizontal-offset', 'Horizontal offset', -2000, 2000, 10);
        const finish = group(appearance, 'Finish');
        addSpin(finish, 'corner-radius', 'Corner radius', 8, 40);
        const opacityRow = new Adw.ActionRow({title: 'Opacity'});
        const opacity = new Gtk.Scale({orientation: Gtk.Orientation.HORIZONTAL,
            hexpand: true, digits: 2, draw_value: true});
        opacity.set_range(0.5, 1.0);
        opacity.set_size_request(220, -1);
        opacity.set_value(settings.get_double('opacity'));
        track(opacity, opacity.connect('value-changed', () => {
            settings.set_double('opacity', Math.round(opacity.get_value() * 100) / 100);
        }));
        track(settings, settings.connect('changed::opacity', () => {
            const value = settings.get_double('opacity');
            if (Math.abs(opacity.get_value() - value) > 0.001) opacity.set_value(value);
        }));
        opacityRow.add_suffix(opacity);
        opacityRow.set_activatable_widget(opacity);
        finish.add(opacityRow);
        const scaleRow = new Adw.ActionRow({title: 'Notch scale'});
        const notchScale = new Gtk.Scale({orientation: Gtk.Orientation.HORIZONTAL, hexpand: true, digits: 2, draw_value: true});
        notchScale.set_range(0.75, 1.5);
        notchScale.set_size_request(220, -1);
        notchScale.set_value(settings.get_double('notch-scale'));
        track(notchScale, notchScale.connect('value-changed', () => settings.set_double('notch-scale', Math.round(notchScale.get_value() * 100) / 100)));
        track(settings, settings.connect('changed::notch-scale', () => {
            const value = settings.get_double('notch-scale');
            if (Math.abs(notchScale.get_value() - value) > 0.001) notchScale.set_value(value);
        }));
        scaleRow.add_suffix(notchScale);
        scaleRow.set_activatable_widget(notchScale);
        finish.add(scaleRow);
        window.add(appearance);

        const behavior = new Adw.PreferencesPage({title: 'Behavior',
            icon_name: 'preferences-system-symbolic'});
        const macbook = group(behavior, 'MacBook notch',
            'The default is a top-edge notch, not a floating Dynamic Island.');
        addSwitch(macbook, 'replace-panel-clock', 'Replace top-bar date & time');
        addSwitch(macbook, 'idle-clock', 'Show time when idle');
        addSwitch(macbook, 'notifications-in-notch', 'Show notifications in the notch');
        addSwitch(macbook, 'auto-open-notifications', 'Compact notification peeks');
        addSpin(macbook, 'peek-duration-ms', 'Peek duration (ms)', 2000, 15000, 500);
        addSwitch(macbook, 'closed-media', 'Closed music wings');
        const profileValues = ['mac-spring', 'smooth'];
        const profileModel = new Gtk.StringList();
        ['Mac spring', 'Smooth easing'].forEach(s => profileModel.append(s));
        const profile = new Adw.ComboRow({title: 'Motion profile', model: profileModel,
            selected: Math.max(0, profileValues.indexOf(settings.get_string('animation-profile')))});
        track(profile, profile.connect('notify::selected', () => settings.set_string('animation-profile', profileValues[profile.selected])));
        track(settings, settings.connect('changed::animation-profile', () => {
            const index = profileValues.indexOf(settings.get_string('animation-profile'));
            if (index >= 0 && profile.selected !== index) profile.selected = index;
        }));
        macbook.add(profile);
        addSpin(macbook, 'open-animation-ms', 'Smooth open duration (ms)', 0, 1000, 20);
        addSpin(macbook, 'close-animation-ms', 'Smooth close duration (ms)', 0, 1000, 20);
        const opening = group(behavior, 'Opening & hiding');
        addSwitch(opening, 'open-on-hover', 'Open on hover');
        addSpin(opening, 'hover-delay-ms', 'Hover delay (ms)', 0, 1500, 50);
        addSpin(opening, 'auto-hide-ms', 'Auto-hide delay (ms)', 0, 60000, 500, '0 disables');
        addSwitch(opening, 'animations', 'Smooth animations');
        addSwitch(opening, 'hide-on-fullscreen', 'Hide on fullscreen');
        addSwitch(opening, 'hide-in-overview', 'Hide in Activities overview');
        addSwitch(opening, 'reserve-space', 'Reserve collapsed space (experimental)');
        const actions = group(behavior, 'Quick actions');
        addSwitch(actions, 'show-dnd', 'Do Not Disturb');
        addSwitch(actions, 'show-night-light', 'Night Light');
        addSwitch(actions, 'show-dark-mode', 'Dark Mode');
        window.add(behavior);

        // ── Agent (PSD) ──────────────────────────────────────────────────
        // Two fields, because the extension must not guess where the agent
        // lives. `psd url` prints the exact URL+token to paste here.
        const agent = new Adw.PreferencesPage({title: 'Agent', icon_name: 'psd-symbolic'});
        const psdGroup = group(agent, 'PSD connection',
            'Run `psd url` in a terminal, paste both values. Leave empty to keep the Agent tab off.');
        const addEntry = (key, title, subtitle, placeholder = '') => {
            const row = new Adw.EntryRow({title, show_apply_button: true});
            if (placeholder) row.text = settings.get_string(key) || placeholder;
            else row.text = settings.get_string(key);
            track(row, row.connect('apply', () => {
                const value = row.text.trim();
                if (settings.get_string(key) !== value) settings.set_string(key, value);
            }));
            track(settings, settings.connect(`changed::${key}`, () => {
                if (row.text !== settings.get_string(key)) row.text = settings.get_string(key);
            }));
            if (subtitle) row.tooltip_text = subtitle;
            psdGroup.add(row);
            return row;
        };
        addEntry('psd-url', 'Agent URL', 'Example: http://127.0.0.1:7788', 'http://127.0.0.1:7788');
        addEntry('psd-token', 'Agent token', 'Printed by `psd token`. Empty = ask the local CLI.');
        const testRow = new Adw.ActionRow({title: 'Test the connection',
            subtitle: 'Sends one status request through the same client the notch uses'});
        const testButton = new Gtk.Button({label: 'Test', valign: Gtk.Align.CENTER});
        track(testButton, testButton.connect('clicked', async () => {
            testButton.sensitive = false;
            testButton.label = 'Testing…';
            try {
                const {PsdClient} = await import('./lib/psd.js');
                const client = new PsdClient(settings);
                await client.resolveToken();
                const health = await client.status({maxAgeMs: 0});
                const brain = health?.brain;
                testButton.label = health?.ok
                    ? `✓ ${brain?.model || (brain?.healthy ? 'model' : 'intents')}`
                    : `✗ ${client.lastError || 'not answering'}`.slice(0, 28);
                testButton.tooltip_text = client.lastError || '';
                client.destroy();
            } catch (err) {
                testButton.label = `✗ ${String(err.message ?? err).slice(0, 28)}`;
                testButton.tooltip_text = String(err.message ?? err);
            }
            testButton.sensitive = true;
        }));
        testRow.add_suffix(testButton);
        psdGroup.add(testRow);
        window.add(agent);

    }
}
