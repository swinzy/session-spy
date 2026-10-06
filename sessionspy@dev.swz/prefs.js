/* prefs.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Gio from "gi://Gio";
import Adw from "gi://Adw";
import Gtk from "gi://Gtk?version=4.0";

import { ExtensionPreferences, gettext as _ } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

const LOCATIONS = [
    ["system-menu", () => _("System Menu")],
    ["top-bar", () => _("Top Bar")],
    ["both", () => _("Both")],
];

export default class SessionSpyPreferences extends ExtensionPreferences {
    /**
     * A segmented control for "display-location": Adw.ToggleGroup where
     * libadwaita has it (1.7, GNOME 48), else linked toggle buttons that look
     * much the same.
     */
    _makeLocationChooser(settings) {
        if (Adw.ToggleGroup) {
            const group = new Adw.ToggleGroup({ valign: Gtk.Align.CENTER });
            for (const [name, label] of LOCATIONS)
                group.add(new Adw.Toggle({ name, label: label() }));
            settings.bind("display-location", group, "active-name", Gio.SettingsBindFlags.DEFAULT);
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
                    settings.set_string("display-location", name);
            });
            buttons.set(name, button);
            box.append(button);
        }
        const sync = () => {
            buttons.get(settings.get_string("display-location")).active = true;
        };
        settings.connect("changed::display-location", sync);
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

        const showCountsRow = new Adw.SwitchRow({
            title: _("Show Session Counts"),
            subtitle: _("Show the number of sessions next to the icon if multiple " +
                "sessions (except for this local session) are running."),
        });
        displayGroup.add(showCountsRow);

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
            uri: "https://github.com/swinzy/session-spy",
        }));
        linkBox.append(new Gtk.LinkButton({
            label: _("Report an Issue"),
            uri: "https://github.com/swinzy/session-spy/issues",
        }));

        window._settings = this.getSettings();
        locationRow.add_suffix(this._makeLocationChooser(window._settings));
        window._settings.bind("show-counts", showCountsRow,
            "active", Gio.SettingsBindFlags.DEFAULT);
        // The top bar buttons always show counts
        const syncShowCounts = () => {
            showCountsRow.sensitive = window._settings.get_string("display-location") === "system-menu";
        };
        window._settings.connect("changed::display-location", syncShowCounts);
        syncShowCounts();
    }
}
