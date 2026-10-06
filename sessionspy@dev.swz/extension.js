/* extension.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import St from "gi://St";
import Clutter from "gi://Clutter";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import { QuickToggle, SystemIndicator } from "resource:///org/gnome/shell/ui/quickSettings.js";
import { Extension, gettext as _, ngettext } from "resource:///org/gnome/shell/extensions/extension.js";

import { EndSessionDialog, listSessionProcesses } from "./endSession.js";

const LOGIND_BUS_NAME = "org.freedesktop.login1";
const LOGIND_PATH = "/org/freedesktop/login1";
const LOGIND_MANAGER_IFACE = "org.freedesktop.login1.Manager";
const LOGIND_SESSION_IFACE = "org.freedesktop.login1.Session";

// logind does not signal every state change (e.g. a session going to "closing"
// when its SSH connection drops but tmux keeps running), so also poll
const POLL_INTERVAL_SECONDS = 10;
// Coalesces bursts of SessionNew/SessionRemoved signals into one refresh
const REFRESH_DELAY_MS = 300;

/**
 * Calls a D-Bus method on logind and resolves with the unpacked reply.
 */
function callLogind(path, iface, method, params, cancellable, flags = Gio.DBusCallFlags.NONE) {
    return new Promise((resolve, reject) => {
        Gio.DBus.system.call(
            LOGIND_BUS_NAME, path, iface, method, params, null,
            flags, -1, cancellable,
            (connection, result) => {
                try {
                    resolve(connection.call_finish(result).recursiveUnpack());
                } catch (e) {
                    reject(e);
                }
            });
    });
}

/**
 * Lists the logind sessions that belong to people, with the properties shown in
 * the menu. Sessions that vanish while being read are skipped.
 */
async function listSessions(cancellable) {
    const [entries] = await callLogind(LOGIND_PATH, LOGIND_MANAGER_IFACE,
        "ListSessions", null, cancellable);

    const sessions = await Promise.all(entries.map(async ([id, , , , path]) => {
        try {
            const [props] = await callLogind(path, "org.freedesktop.DBus.Properties",
                "GetAll", new GLib.Variant("(s)", [LOGIND_SESSION_IFACE]), cancellable);
            return { id, ...props };
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            return null;
        }
    }));

    // Skip greeter, lock-screen, background and manager (user@.service) sessions
    return sessions
        .filter(s => s && (s.Class === "user" || s.Class?.startsWith("user-")))
        .sort((a, b) => a.Timestamp - b.Timestamp);
}

/**
 * Finds the ID of the session GNOME Shell runs in, or null if there is none
 * (e.g. a headless shell).
 */
async function findOwnSessionId(cancellable) {
    const id = GLib.getenv("XDG_SESSION_ID");
    if (id)
        return id;
    // Like GNOME Shell's own login manager: "auto" is the caller's session, or
    // the user's graphical session when the caller (a systemd user service) has none
    try {
        const [ownId] = await callLogind(`${LOGIND_PATH}/session/auto`, "org.freedesktop.DBus.Properties",
            "Get", new GLib.Variant("(ss)", [LOGIND_SESSION_IFACE, "Id"]), cancellable);
        return ownId;
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            throw e;
        return null;
    }
}

function describeSession(session) {
    const where = session.Remote
        ? [session.RemoteUser && `${session.RemoteUser}@`, session.RemoteHost].filter(Boolean).join("") ||
            _("unknown host")
        : session.Seat?.[0] || session.TTY || session.Display;
    const via = session.Service || session.Type;
    return [where, via].filter(Boolean).join(" · ");
}

function formatSince(timestampUsec) {
    if (!timestampUsec)
        return "";
    const time = GLib.DateTime.new_from_unix_local(Math.floor(timestampUsec / 1_000_000));
    const today = GLib.DateTime.new_now_local();
    const sameDay = time.get_year() === today.get_year() &&
        time.get_day_of_year() === today.get_day_of_year();
    return time.format(sameDay ? "%H:%M" : "%Y-%m-%d %H:%M");
}

/**
 * Keeps the list of logind sessions up to date and tells its listener after
 * every refresh. Sessions come in three groups: local and remote ones, and
 * "closing" ones, which have lost their terminal or connection and only have
 * leftover processes (e.g. tmux). Closing sessions are not counted, but they
 * make the indicator of their side show.
 */
class SessionMonitor {
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._cancellable = new Gio.Cancellable();
        this._generation = 0;
        this._refreshSourceId = 0;
        this.groups = null;
        this.error = null;
        // The session expanded in the list, kept across its rebuilds
        this.expandedSessionId = null;
        this._dialog = null;
        // undefined until looked up, then the ID or null
        this.ownSessionId = undefined;

        this._signalIds = ["SessionNew", "SessionRemoved"].map(member =>
            Gio.DBus.system.signal_subscribe(LOGIND_BUS_NAME, LOGIND_MANAGER_IFACE, member,
                LOGIND_PATH, null, Gio.DBusSignalFlags.NONE, () => this._queueRefresh()));
        this._pollSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_SECONDS, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
        this.refresh();
    }

    _queueRefresh() {
        // Also called when a call to logind finishes, which may be after destroy()
        if (this._refreshSourceId || this._cancellable.is_cancelled())
            return;
        this._refreshSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_DELAY_MS, () => {
            this._refreshSourceId = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    async refresh() {
        if (this._cancellable.is_cancelled())
            return;
        // Only the latest refresh may update the UI; older ones finishing late are dropped
        const generation = ++this._generation;
        let sessions;
        try {
            if (this.ownSessionId === undefined)
                this.ownSessionId = await findOwnSessionId(this._cancellable);
            sessions = await listSessions(this._cancellable);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            if (generation === this._generation)
                this.setSessions(null, e);
            return;
        }
        if (generation === this._generation)
            this.setSessions(sessions);
    }

    setSessions(sessions, error = null) {
        this.error = error;
        if (sessions) {
            const open = sessions.filter(s => s.State !== "closing");
            this.groups = {
                local: open.filter(s => !s.Remote),
                remote: open.filter(s => s.Remote),
                closing: sessions.filter(s => s.State === "closing"),
            };
        } else {
            this.groups = null;
        }
        this._onChanged();
    }

    /**
     * Ends a session and its processes. Ending another user's session needs
     * an administrator, so this lets polkit ask for a password.
     */
    async terminateSession(id) {
        try {
            await callLogind(LOGIND_PATH, LOGIND_MANAGER_IFACE, "TerminateSession",
                new GLib.Variant("(s)", [id]), this._cancellable,
                Gio.DBusCallFlags.ALLOW_INTERACTIVE_AUTHORIZATION);
        } finally {
            this._queueRefresh();
        }
    }

    listProcesses(session) {
        return listSessionProcesses(session.Scope, this._cancellable);
    }

    /**
     * Opens a dialog that belongs to the monitor: destroy() closes it, so
     * none is left behind when the extension is disabled (e.g. by locking
     * the screen). Does nothing once the monitor is destroyed, as the dialog
     * may be ready only after an asynchronous step.
     */
    openDialog(dialog) {
        if (this._cancellable.is_cancelled()) {
            dialog.destroy();
            return;
        }
        this._closeDialog();
        this._dialog = dialog;
        dialog.connect("destroy", () => {
            if (this._dialog === dialog)
                this._dialog = null;
        });
        dialog.open();
    }

    get counts() {
        const { groups } = this;
        return groups && {
            local: groups.local.length,
            remote: groups.remote.length,
            localClosing: groups.closing.filter(s => !s.Remote).length,
            remoteClosing: groups.closing.filter(s => s.Remote).length,
        };
    }

    _closeDialog() {
        if (!this._dialog)
            return;
        // Destroying an open dialog does not end its modal grab
        this._dialog.popModal();
        this._dialog.destroy();
        this._dialog = null;
    }

    destroy() {
        this._cancellable.cancel();
        this._closeDialog();
        for (const id of this._signalIds)
            Gio.DBus.system.signal_unsubscribe(id);
        this._signalIds = [];
        if (this._pollSourceId)
            GLib.source_remove(this._pollSourceId);
        if (this._refreshSourceId)
            GLib.source_remove(this._refreshSourceId);
        this._pollSourceId = this._refreshSourceId = 0;
    }
}

// What a count normally is: the session GNOME runs in, and nobody remote
const NORMAL_COUNTS = { local: 1, remote: 0 };

const ICON_NAMES = { local: "system-users-symbolic", remote: "utilities-terminal-symbolic" };

/**
 * Whether the local or remote indicator shows, its count, and whether that
 * count is worth showing. An indicator shows when its count is above normal,
 * or while its side has a disconnected session with leftover processes. The
 * icon alone already says "one more than normal", so the count only adds
 * something from two more on.
 */
function indicatorState(counts, kind) {
    const count = counts[kind];
    return {
        visible: count > NORMAL_COUNTS[kind] || counts[`${kind}Closing`] > 0,
        count,
        countWorthShowing: count > NORMAL_COUNTS[kind] + 1,
    };
}

/**
 * Lists the session's processes, then asks before ending the session.
 */
async function confirmEndSession(monitor, session, name, details) {
    let processes = null;
    try {
        processes = await monitor.listProcesses(session);
    } catch (e) {
        // The dialog still warns about the processes, it just cannot list them
        console.warn(`Session Spy: cannot list the processes of session ${session.id}: ${e.message}`);
    }
    monitor.openDialog(new EndSessionDialog(name, details, processes, () => {
        monitor.terminateSession(session.id).catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                Main.notifyError(_("Cannot end session %s").format(name), e.message);
        });
    }));
}

const LIST_ICON_NAMES = {
    own: "avatar-default-symbolic",
    local: "system-users-symbolic",
    remote: "utilities-terminal-symbolic",
};

function formatTime(timestampUsec) {
    return GLib.DateTime.new_from_unix_local(Math.floor(timestampUsec / 1_000_000)).format("%Y-%m-%d %H:%M");
}

/**
 * A session in the list: its icon, name and a one line summary, and its end
 * button. Clicking the row expands it in place to the full details instead of
 * the summary, which may not fit; the menu stays open.
 */
const SessionItem = GObject.registerClass(
class SessionItem extends PopupMenu.PopupBaseMenuItem {
    _init(session, dimmed, monitor, closeMenu) {
        super._init({ style_class: "session-spy-item" });
        this._session = session;
        this._monitor = monitor;
        const name = `${session.Name} (#${session.id})`;
        const own = session.id === monitor.ownSessionId;

        // Like the app icons of GNOME's background apps list, telling apart
        // this session, other local ones and remote ones
        const icon = new St.Icon({
            icon_name: LIST_ICON_NAMES[own ? "own" : session.Remote ? "remote" : "local"],
            style_class: "popup-menu-icon session-spy-icon",
            y_align: Clutter.ActorAlign.START,
        });
        this.add_child(icon);

        const box = new St.BoxLayout({ x_expand: true });
        // GNOME 48 replaced St.BoxLayout:vertical with :orientation
        if ("orientation" in box)
            box.orientation = Clutter.Orientation.VERTICAL;
        else
            box.vertical = true;
        box.add_child(new St.Label({
            text: own ? _("%s (this session)").format(name) : name,
            style_class: "session-spy-title",
        }));
        const summary = describeSession(session);
        this._summary = new St.Label({ text: summary, style_class: "session-spy-details" });
        box.add_child(this._summary);
        this._details = new St.Label({ style_class: "session-spy-details", visible: false });
        this._details.clutter_text.set({ line_wrap: true });
        box.add_child(this._details);
        this.add_child(box);

        // Like the close buttons of GNOME's background apps list; ending the
        // session GNOME runs in is what "Log Out" is for
        if (!own) {
            const endButton = new St.Button({
                icon_name: "window-close-symbolic",
                style_class: "icon-button session-spy-end-button",
                accessible_name: _("End Session"),
                y_align: Clutter.ActorAlign.START,
            });
            endButton.connect("clicked", () => {
                closeMenu();
                const details = [summary, formatSince(session.Timestamp)].filter(Boolean).join(" · ");
                confirmEndSession(monitor, session, name, details).catch(logError);
            });
            this.add_child(endButton);
        }
        // Only the icon and text: the end button stays as clickable looking as
        // the others
        if (dimmed)
            icon.opacity = box.opacity = 128;

        // The list is rebuilt on every refresh, so the monitor keeps which
        // session is expanded
        this._setExpanded(monitor.expandedSessionId === session.id);
    }

    // Expands or collapses instead of activating, which would close the menu
    activate() {
        this._setExpanded(!this._expanded);
    }

    // Only one session is expanded at a time: expanding one collapses the
    // other
    _setExpanded(expanded) {
        this._expanded = expanded;
        if (expanded) {
            this._monitor.expandedSessionId = this._session.id;
            for (const sibling of this.get_parent()?.get_children() ?? []) {
                if (sibling !== this && sibling._expanded)
                    sibling._collapse();
            }
        } else if (this._monitor.expandedSessionId === this._session.id) {
            this._monitor.expandedSessionId = null;
        }
        this._summary.visible = !expanded;
        this._details.visible = expanded;
        if (expanded)
            this._showDetails();
    }

    _collapse() {
        this._expanded = false;
        this._summary.visible = true;
        this._details.visible = false;
    }

    async _showDetails() {
        const lines = this._detailLines();
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

    _detailLines() {
        const s = this._session;
        const lines = [];
        if (s.Remote) {
            lines.push(_("From: %s").format(
                [s.RemoteUser && `${s.RemoteUser}@`, s.RemoteHost].filter(Boolean).join("") || _("unknown host")));
        } else if (s.Seat?.[0]) {
            lines.push(_("Seat: %s").format(s.Seat[0]));
        }
        if (s.TTY)
            lines.push(_("Terminal: %s").format(s.TTY));
        if (s.Display)
            lines.push(_("Display: %s").format(s.Display));
        if (s.Service)
            lines.push(_("Login service: %s").format(s.Service));
        if (s.Type)
            lines.push(_("Type: %s").format(s.Type));
        if (s.Timestamp)
            lines.push(_("Started: %s").format(formatTime(s.Timestamp)));
        if (s.State === "closing")
            lines.push(_("Disconnected, processes left running"));
        else if (s.IdleHint && s.IdleSinceHint)
            lines.push(_("Idle since %s").format(formatTime(s.IdleSinceHint)));
        return lines;
    }
});

/**
 * Replaces the items of a menu or menu section with the monitor's sessions,
 * in the given order of the "local", "remote" and "closing" groups. closeMenu
 * closes the whole menu before a dialog opens from it.
 */
function fillSessionList(menu, monitor, order, closeMenu) {
    const { groups, error } = monitor;
    menu.removeAll();
    if (!groups) {
        if (error) {
            menu.addMenuItem(new PopupMenu.PopupMenuItem(
                _("Cannot read sessions: %s").format(error.message), { reactive: false }));
        }
        return;
    }

    // This session first, then the groups, which the icons tell apart
    const isOwn = session => session.id === monitor.ownSessionId;
    const ordered = order.flatMap(key => groups[key].map(session => ({ session, key })));
    ordered.sort((x, y) => isOwn(y.session) - isOwn(x.session));
    for (const { session, key } of ordered)
        menu.addMenuItem(new SessionItem(session, key === "closing", monitor, closeMenu));
}

/**
 * Top bar buttons, one per kind, always with its count.
 * "remote" is a blue pill like the screen sharing indicator, "local" a plain
 * icon. Both open the same list of all sessions.
 */
const SessionIndicator = GObject.registerClass(
class SessionIndicator extends PanelMenu.Button {
    _init(kind, monitor) {
        super._init(0.5, _("Session Spy"));
        this._kind = kind;
        this._monitor = monitor;
        this.add_style_class_name(`session-spy-${kind}-indicator`);

        const box = new St.BoxLayout();
        // No system-status-icon class, like the screen sharing indicator: its
        // padding and margin would push the content off centre in the pill
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
            // Show the failure once, on the local indicator
            this.visible = this._kind === "local" && Boolean(error);
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
        // The list starts with the group of this indicator
        fillSessionList(this.menu, this._monitor,
            this._kind === "remote" ? ["remote", "local", "closing"] : ["local", "remote", "closing"],
            () => this.menu.close());
    }
});

class PanelButtonsView {
    constructor(uuid, monitor) {
        // Like the screen recording and sharing indicators: left of the other
        // status icons, with the coloured remote pill first
        this._indicators = ["local", "remote"].map(kind => {
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

/**
 * The session row among the system menu's quick settings, which looks like
 * GNOME's own "Background Apps" row and opens the session list.
 */
const SessionsToggle = GObject.registerClass(
class SessionsToggle extends QuickToggle {
    _init(monitor) {
        super._init({
            hasMenu: true,
            // Like the background apps toggle: a flat row with an arrow and no
            // separate menu button
            iconName: "go-next-symbolic",
        });
        this.add_style_class_name("background-apps-quick-toggle");
        this._box?.set_child_above_sibling(this._icon, null);
        this._monitor = monitor;

        this.menu.setHeader("system-users-symbolic", _("Login Sessions"));
        this._listSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._listSection);

        this.connect("popup-menu", () => this.menu.open());
        this.menu.connectObject("open-state-changed", (menu, open) => {
            if (open)
                this._monitor.refresh();
        }, this);
    }

    sync() {
        const { counts, groups } = this._monitor;
        if (!counts) {
            this.title = _("Login Sessions");
        } else {
            const open = counts.local + counts.remote;
            const parts = [ngettext("%d Login Session", "%d Login Sessions", open).format(open)];
            if (groups.closing.length) {
                parts.push(ngettext("%d Disconnected", "%d Disconnected", groups.closing.length)
                    .format(groups.closing.length));
            }
            this.title = parts.join(" · ");
        }
        fillSessionList(this._listSection, this._monitor, ["remote", "local", "closing"],
            () => Main.panel.statusArea.quickSettings.menu.close());
    }

    vfunc_clicked() {
        this.menu.open();
    }
});

/**
 * Session Spy's part of the system menu: the session row in its quick settings
 * and, unless the top bar buttons show instead, icons among its status icons.
 * The remote icon is in the orange of GNOME's privacy indicators (camera,
 * microphone, screen recording), with optional counts from two above normal on.
 */
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

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

class SystemMenuView {
    constructor(monitor, settings, showIcons) {
        this._indicator = new SessionSystemIndicator(monitor, settings, showIcons);
        // Full width, placed by GNOME just above the background apps row
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

export default class SessionSpyExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._views = [];
        this._monitor = new SessionMonitor(() => this._views.forEach(v => v.sync()));
        this._settings.connectObject("changed::display-location", () => this._createViews(), this);
        this._createViews();
    }

    /**
     * "system-menu": status icons and the session row in the system menu.
     * "top-bar": separate top bar buttons. "both": the top bar buttons, and
     * the session row without the then duplicate status icons.
     */
    _createViews() {
        this._views.forEach(v => v.destroy());
        const location = this._settings.get_string("display-location");
        this._views = [];
        if (location !== "system-menu")
            this._views.push(new PanelButtonsView(this.uuid, this._monitor));
        if (location !== "top-bar")
            this._views.push(new SystemMenuView(this._monitor, this._settings, location === "system-menu"));
        this._views.forEach(v => v.sync());
    }

    disable() {
        this._settings?.disconnectObject(this);
        this._settings = null;
        this._monitor?.destroy();
        this._monitor = null;
        this._views?.forEach(v => v.destroy());
        this._views = null;
    }
}
