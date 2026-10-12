/* extension.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import { SessionMonitor } from "./sessionMonitor.js";
import { SystemMenuView } from "./systemMenu.js";
import { TopBarView } from "./topBar.js";
import { LOCATION_TOP_BAR, SETTINGS_KEY_DISPLAY_LOCATION, SETTINGS_KEY_SHOW_SESSION_LIST } from "./settings.js";

export default class SessionSpyExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._views = [];

        // Main logic class
        this._monitor = new SessionMonitor(() => this._views.forEach(v => v.sync()));
        this._settings.connectObject(
            `changed::${SETTINGS_KEY_DISPLAY_LOCATION}`, () => this._createViews(),
            `changed::${SETTINGS_KEY_SHOW_SESSION_LIST}`, () => this._createViews(),
            this);
        this._createViews();
    }

    disable() {
        this._settings.disconnectObject(this);
        this._settings = null;
        this._views.forEach(v => v.destroy());
        this._views = null;
        this._monitor.destroy();
        this._monitor = null;
    }

    _createViews() {
        this._views.forEach(v => v.destroy());
        this._views = [];
        if (this._settings.get_string(SETTINGS_KEY_DISPLAY_LOCATION) === LOCATION_TOP_BAR) {
            this._views.push(new TopBarView(this.uuid, this._monitor));
            // Only show session menu in quick settings, but does not show icon
            if (this._settings.get_boolean(SETTINGS_KEY_SHOW_SESSION_LIST))
                this._views.push(new SystemMenuView(this._monitor, this._settings, false));
        } else {
            // Show session menu in quick settings + icon in system menu
            this._views.push(new SystemMenuView(this._monitor, this._settings, true));
        }
        this._views.forEach(v => v.sync());
    }
}
