/* sessionList.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import GLib from "gi://GLib";
import GObject from "gi://GObject";
import St from "gi://St";
import Clutter from "gi://Clutter";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import { gettext as _, ngettext } from "resource:///org/gnome/shell/extensions/extension.js";

import { EndSessionDialog } from "./endSession.js";
import { isCancelled } from "./async.js";

const ICON_NAMES = {
    own: "avatar-default-symbolic",
    local: "system-users-symbolic",
    remote: "utilities-terminal-symbolic",
};

function remoteOrigin(session) {
    const user = session.RemoteUser ? `${session.RemoteUser}@` : "";
    return session.RemoteHost ? `${user}${session.RemoteHost}` : _("unknown host");
}

function describeSession(session) {
    const where = session.Remote ? remoteOrigin(session) : session.Seat[0] || session.TTY || session.Display;
    return [where, session.Service || session.Type].filter(Boolean).join(" · ");
}

function toDateTime(timestampUsec) {
    return GLib.DateTime.new_from_unix_local(Math.floor(timestampUsec / 1_000_000));
}

function formatStart(timestampUsec) {
    const time = toDateTime(timestampUsec);
    const today = GLib.DateTime.new_now_local();
    const sameDay = time.get_year() === today.get_year() && time.get_day_of_year() === today.get_day_of_year();
    return time.format(sameDay ? "%H:%M" : "%Y-%m-%d %H:%M");
}

function detailLines(session) {
    const lines = [];
    if (session.Remote)
        lines.push(_("From: %s").format(remoteOrigin(session)));
    else if (session.Seat[0])
        lines.push(_("Seat: %s").format(session.Seat[0]));
    if (session.TTY)
        lines.push(_("Terminal: %s").format(session.TTY));
    if (session.Display)
        lines.push(_("Display: %s").format(session.Display));
    if (session.Service)
        lines.push(_("Login service: %s").format(session.Service));
    if (session.Type)
        lines.push(_("Type: %s").format(session.Type));
    if (session.Timestamp)
        lines.push(_("Started: %s").format(toDateTime(session.Timestamp).format("%Y-%m-%d %H:%M")));
    if (session.State === "closing")
        lines.push(_("Disconnected, processes left running"));
    else if (session.IdleHint && session.IdleSinceHint)
        lines.push(_("Idle since %s").format(toDateTime(session.IdleSinceHint).format("%Y-%m-%d %H:%M")));
    return lines;
}

async function confirmEndSession(monitor, session, name, details) {
    let processes = null;
    try {
        processes = await monitor.listProcesses(session);
    } catch (e) {
        if (isCancelled(e))
            return;
        console.warn(`Session Spy: cannot list the processes of session ${session.id}: ${e.message}`);
    }
    monitor.openDialog(new EndSessionDialog(name, details, processes, () => {
        monitor.terminateSession(session.id).catch(e => {
            if (!isCancelled(e))
                Main.notifyError(_("Cannot end session %s").format(name), e.message);
        });
    }));
}

function verticalBox(params) {
    const box = new St.BoxLayout(params);
    // St.BoxLayout:vertical became :orientation in GNOME 48
    if ("orientation" in box)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
}

const SessionItem = GObject.registerClass(
class SessionItem extends PopupMenu.PopupBaseMenuItem {
    _init(session, dimmed, monitor, closeMenu) {
        super._init({ style_class: "session-spy-item" });
        this._session = session;
        this._monitor = monitor;
        const name = `${session.Name} (#${session.id})`;
        const own = session.id === monitor.ownSessionId;

        const icon = new St.Icon({
            icon_name: ICON_NAMES[own ? "own" : session.Remote ? "remote" : "local"],
            style_class: "popup-menu-icon session-spy-icon",
            y_align: Clutter.ActorAlign.START,
        });
        this.add_child(icon);

        const box = verticalBox({ x_expand: true });
        box.add_child(new St.Label({
            text: own ? _("%s (this session)").format(name) : name,
            style_class: "session-spy-title",
        }));
        const summary = describeSession(session);
        this._summary = new St.Label({ text: summary, style_class: "session-spy-details" });
        box.add_child(this._summary);
        this._details = new St.Label({ style_class: "session-spy-details", visible: false });
        this._details.clutter_text.line_wrap = true;
        box.add_child(this._details);
        this.add_child(box);

        // Ending this session is what "Log Out" is for
        if (!own) {
            const endButton = new St.Button({
                icon_name: "window-close-symbolic",
                style_class: "icon-button session-spy-end-button",
                accessible_name: _("End Session"),
                y_align: Clutter.ActorAlign.START,
            });
            endButton.connect("clicked", () => {
                closeMenu();
                const details = [summary, formatStart(session.Timestamp)].filter(Boolean).join(" · ");
                confirmEndSession(monitor, session, name, details).catch(logError);
            });
            this.add_child(endButton);
        }
        if (dimmed)
            icon.opacity = box.opacity = 128;

        this._expanded = monitor.expandedSessionId === session.id;
        this._showExpanded();
    }

    // Expand instead of activating, which would close the menu
    activate() {
        this._expanded = !this._expanded;
        this._monitor.expandedSessionId = this._expanded ? this._session.id : null;
        if (this._expanded) {
            for (const sibling of this.get_parent().get_children()) {
                if (sibling !== this && sibling._expanded) {
                    sibling._expanded = false;
                    sibling._showExpanded();
                }
            }
        }
        this._showExpanded();
    }

    _showExpanded() {
        this._summary.visible = !this._expanded;
        this._details.visible = this._expanded;
        if (this._expanded)
            this._showDetails().catch(logError);
    }

    async _showDetails() {
        const lines = detailLines(this._session);
        this._details.text = lines.join("\n");
        try {
            const { total } = await this._monitor.listProcesses(this._session);
            lines.push(ngettext("%d process", "%d processes", total).format(total));
        } catch {
            return;
        }
        // The list may have been rebuilt meanwhile
        if (this._details.get_stage())
            this._details.text = lines.join("\n");
    }
});

export function fillSessionList(menu, monitor, order, closeMenu) {
    const { groups, error } = monitor;
    menu.removeAll();
    if (!groups) {
        if (error) {
            menu.addMenuItem(new PopupMenu.PopupMenuItem(
                _("Cannot read sessions: %s").format(error.message), { reactive: false }));
        }
        return;
    }

    const isOwn = session => session.id === monitor.ownSessionId;
    const ordered = order.flatMap(key => groups[key].map(session => ({ session, key })));
    ordered.sort((x, y) => isOwn(y.session) - isOwn(x.session));
    for (const { session, key } of ordered)
        menu.addMenuItem(new SessionItem(session, key === "closing", monitor, closeMenu));
}
