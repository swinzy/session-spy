/* prefs.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Gio from "gi://Gio";
import Adw from "gi://Adw";
import Gtk from "gi://Gtk?version=4.0";

import { ExtensionPreferences, gettext as _ } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import {
    LOCATION_SYSTEM_MENU,
    LOCATION_TOP_BAR,
    SETTINGS_KEY_DISPLAY_LOCATION,
    SETTINGS_KEY_SHOW_COUNTS,
    SETTINGS_KEY_SHOW_SESSION_LIST,
} from "./settings.js";

const LOCATIONS = [
    [LOCATION_TOP_BAR, () => _("Top Bar Pills")],
    [LOCATION_SYSTEM_MENU, () => _("System Menu Icons")],
];

export default class SessionSpyPreferences extends ExtensionPreferences {
    // Adw.ToggleGroup is new in libadwaita 1.7; older ones get linked toggle buttons
    _makeLocationChooser(settings) {
        if (Adw.ToggleGroup) {
            const group = new Adw.ToggleGroup({ valign: Gtk.Align.CENTER });
            for (const [name, label] of LOCATIONS)
                group.add(new Adw.Toggle({ name, label: label() }));
            settings.bind(SETTINGS_KEY_DISPLAY_LOCATION, group, "active-name", Gio.SettingsBindFlags.DEFAULT);
            return group;
        }

        const box = new Gtk.Box({ valign: Gtk.Align.CENTER, css_classes: ["linked"] });
        const buttons = new Map();
        for (const [name, label] of LOCATIONS) {
            const button = new Gtk.ToggleButton({ label: label() });
            if (buttons.size)
                button.set_group(buttons.values().next().value);
            button.connect("toggled", () => {
                if (button.active)
                    settings.set_string(SETTINGS_KEY_DISPLAY_LOCATION, name);
            });
            buttons.set(name, button);
            box.append(button);
        }
        const sync = () => {
            buttons.get(settings.get_string(SETTINGS_KEY_DISPLAY_LOCATION)).active = true;
        };
        settings.connect(`changed::${SETTINGS_KEY_DISPLAY_LOCATION}`, sync);
        sync();
        return box;
    }

    fillPreferencesWindow(window) {
        const page = new Adw.PreferencesPage({
            title: _("Preferences"),
        });
        window.add(page);

        const displayGroup = new Adw.PreferencesGroup();
        page.add(displayGroup);

        const locationRow = new Adw.ActionRow({
            title: _("Display Location"),
        });
        displayGroup.add(locationRow);

        // Only the settings that apply to the chosen location show
        const showCountsRow = new Adw.SwitchRow({
            title: _("Show Session Counts"),
            subtitle: _("Show the number of sessions next to the icon if multiple " +
                "sessions (except for this local session) are running."),
        });
        displayGroup.add(showCountsRow);

        const showSessionListRow = new Adw.SwitchRow({
            title: _("Show Session List in Quick Settings"),
        });
        displayGroup.add(showSessionListRow);

        const linkGroup = new Adw.PreferencesGroup();
        page.add(linkGroup);

        const linkBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            halign: Gtk.Align.CENTER,
            margin_top: 5,
        });
        linkGroup.add(linkBox);

        linkBox.append(new Gtk.LinkButton({
            label: "GitHub",
            uri: this.metadata.url,
        }));
        linkBox.append(new Gtk.LinkButton({
            label: _("Report an Issue"),
            uri: `${this.metadata.url}/issues`,
        }));

        window._settings = this.getSettings();
        locationRow.add_suffix(this._makeLocationChooser(window._settings));
        window._settings.bind(SETTINGS_KEY_SHOW_COUNTS, showCountsRow,
            "active", Gio.SettingsBindFlags.DEFAULT);
        window._settings.bind(SETTINGS_KEY_SHOW_SESSION_LIST, showSessionListRow,
            "active", Gio.SettingsBindFlags.DEFAULT);
        const syncRows = () => {
            const topBar = window._settings.get_string(SETTINGS_KEY_DISPLAY_LOCATION) === LOCATION_TOP_BAR;
            showCountsRow.visible = !topBar;
            showSessionListRow.visible = topBar;
        };
        window._settings.connect(`changed::${SETTINGS_KEY_DISPLAY_LOCATION}`, syncRows);
        syncRows();
    }
}
