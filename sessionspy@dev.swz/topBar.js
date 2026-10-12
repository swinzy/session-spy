/* topBar.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import GObject from "gi://GObject";
import St from "gi://St";
import Clutter from "gi://Clutter";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import { gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";

import { fillSessionList } from "./sessionList.js";
import { indicatorState } from "./sessionMonitor.js";
import { ICON_NAMES, KIND_LOCAL, KIND_REMOTE, listOrder } from "./sessionKinds.js";

const SessionIndicator = GObject.registerClass(
class SessionIndicator extends PanelMenu.Button {
    _init(kind, monitor) {
        super._init(0.5, _("Session Spy"));
        this._kind = kind;
        this._monitor = monitor;
        this.add_style_class_name(`session-spy-${kind}-indicator`);

        const box = new St.BoxLayout();
        // Without system-status-icon: its padding would push the pill content off centre
        box.add_child(new St.Icon({ icon_name: ICON_NAMES[kind] }));
        this._label = new St.Label({ y_align: Clutter.ActorAlign.CENTER });
        box.add_child(this._label);
        this.add_child(box);

        this.menu.connectObject("open-state-changed", (menu, open) => {
            if (open)
                this._monitor.refresh();
        }, this);
        this.visible = false;
    }

    sync() {
        const { counts, error } = this._monitor;
        if (!counts) {
            // One pill is enough to show the error
            this.visible = this._kind === KIND_LOCAL && Boolean(error);
            this._label.text = "?";
            fillSessionList(this.menu, this._monitor, [], () => this.menu.close());
            return;
        }

        const { visible, count } = indicatorState(counts, this._kind);
        this.visible = visible;
        this._label.text = String(count);
        if (!visible) {
            this.menu.close();
            return;
        }
        fillSessionList(this.menu, this._monitor, listOrder(this._kind), () => this.menu.close());
    }
});

export class TopBarView {
    constructor(uuid, monitor) {
        this._indicators = [KIND_LOCAL, KIND_REMOTE].map(kind => {
            const indicator = new SessionIndicator(kind, monitor);
            Main.panel.addToStatusArea(`${uuid}-${kind}`, indicator, 0, "right");
            return indicator;
        });
    }

    sync() {
        this._indicators.forEach(i => i.sync());
    }

    destroy() {
        this._indicators.forEach(i => i.destroy());
        this._indicators = null;
    }
}
