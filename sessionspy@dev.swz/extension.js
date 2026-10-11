/* extension.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import { SessionMonitor } from "./sessionMonitor.js";
import { SystemMenuView } from "./systemMenu.js";
import { TopBarView } from "./topBar.js";

export default class SessionSpyExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._views = [];
        this._monitor = new SessionMonitor(() => this._views.forEach(v => v.sync()));
        this._settings.connectObject(
            "changed::display-location", () => this._createViews(),
            "changed::show-session-list", () => this._createViews(),
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
        if (this._settings.get_string("display-location") === "top-bar") {
            this._views.push(new TopBarView(this.uuid, this._monitor));
            if (this._settings.get_boolean("show-session-list"))
                this._views.push(new SystemMenuView(this._monitor, this._settings, false));
        } else {
            this._views.push(new SystemMenuView(this._monitor, this._settings, true));
        }
        this._views.forEach(v => v.sync());
    }
}
