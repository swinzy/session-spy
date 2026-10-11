/* systemMenu.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import GObject from "gi://GObject";
import St from "gi://St";
import Clutter from "gi://Clutter";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import { QuickToggle, SystemIndicator } from "resource:///org/gnome/shell/ui/quickSettings.js";
import { gettext as _, ngettext } from "resource:///org/gnome/shell/extensions/extension.js";

import { fillSessionList } from "./sessionList.js";
import { indicatorState } from "./sessionMonitor.js";

const ICON_NAMES = { local: "system-users-symbolic", remote: "utilities-terminal-symbolic" };

const SessionsToggle = GObject.registerClass(
class SessionsToggle extends QuickToggle {
    _init(monitor) {
        super._init({ hasMenu: true, iconName: "go-next-symbolic" });
        this._monitor = monitor;
        this._worthShowing = false;
        // Looks like GNOME's Background Apps row: flat, with the arrow at the end
        this.add_style_class_name("background-apps-quick-toggle");
        this._box.set_child_above_sibling(this._icon, null);

        this.menu.setHeader("system-users-symbolic", _("Login Sessions"));
        this._listSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._listSection);

        this.connect("popup-menu", () => this.menu.open());
        this.menu.connectObject("open-state-changed", (menu, open) => {
            if (open)
                this._monitor.refresh();
            this._syncVisible();
        }, this);
    }

    vfunc_clicked() {
        this.menu.open();
    }

    // Hiding the row while its list is open misplaces the menu, as for Background Apps
    _syncVisible() {
        this.visible = this.menu.isOpen || this._worthShowing;
    }

    sync() {
        const { counts, groups, error } = this._monitor;
        this._worthShowing = counts
            ? indicatorState(counts, "local").visible || indicatorState(counts, "remote").visible
            : Boolean(error);
        this._syncVisible();
        this.title = counts ? this._titleFor(counts, groups) : _("Login Sessions");
        fillSessionList(this._listSection, this._monitor, ["remote", "local", "closing"],
            () => Main.panel.statusArea.quickSettings.menu.close());
    }

    _titleFor(counts, groups) {
        const open = counts.local + counts.remote;
        const parts = [ngettext("%d Login Session", "%d Login Sessions", open).format(open)];
        const closing = groups.closing.length;
        if (closing)
            parts.push(ngettext("%d Disconnected", "%d Disconnected", closing).format(closing));
        return parts.join(" · ");
    }
});

const SessionSystemIndicator = GObject.registerClass(
class SessionSystemIndicator extends SystemIndicator {
    _init(monitor, settings, showIcons) {
        super._init();
        this._monitor = monitor;
        this._settings = settings;

        this._parts = {};
        for (const kind of showIcons ? ["remote", "local"] : []) {
            const icon = this._addIndicator();
            icon.icon_name = ICON_NAMES[kind];
            const label = new St.Label({ y_expand: true, y_align: Clutter.ActorAlign.CENTER });
            label.add_style_class_name("session-spy-count");
            if (kind === "remote") {
                icon.add_style_class_name("privacy-indicator");
                label.add_style_class_name("privacy-indicator");
            }
            this.add_child(label);
            label.connect("notify::visible", () => this._syncIndicatorsVisible());
            this._parts[kind] = { icon, label };
        }

        this._toggle = new SessionsToggle(monitor);
        this.quickSettingsItems.push(this._toggle);
        this._settings.connectObject("changed::show-counts", () => this.sync(), this);
    }

    destroy() {
        this._settings.disconnectObject(this);
        this.quickSettingsItems.forEach(item => item.destroy());
        this.quickSettingsItems = [];
        this._toggle = null;
        super.destroy();
    }

    sync() {
        const { counts } = this._monitor;
        const showCounts = this._settings.get_boolean("show-counts");
        for (const [kind, { icon, label }] of Object.entries(this._parts)) {
            const state = counts ? indicatorState(counts, kind) : { visible: false, count: 0, countWorthShowing: false };
            icon.visible = state.visible;
            label.text = String(state.count);
            label.visible = state.visible && showCounts && state.countWorthShowing;
        }
        this._toggle.sync();
    }
});

export class SystemMenuView {
    constructor(monitor, settings, showIcons) {
        this._indicator = new SessionSystemIndicator(monitor, settings, showIcons);
        // Full width; GNOME places it just above the Background Apps row
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator, 2);
    }

    get indicator() {
        return this._indicator;
    }

    sync() {
        this._indicator.sync();
    }

    destroy() {
        this._indicator.destroy();
        this._indicator = null;
    }
}
