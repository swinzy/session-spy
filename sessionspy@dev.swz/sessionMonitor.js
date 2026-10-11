/* sessionMonitor.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Gio from "gi://Gio";
import GLib from "gi://GLib";

import { callSystemBus, isCancelled } from "./async.js";
import { listSessionProcesses } from "./endSession.js";

const LOGIND_BUS_NAME = "org.freedesktop.login1";
const LOGIND_PATH = "/org/freedesktop/login1";
const LOGIND_MANAGER_IFACE = "org.freedesktop.login1.Manager";
const LOGIND_SESSION_IFACE = "org.freedesktop.login1.Session";

// logind does not signal a session turning "closing", so poll as well
const POLL_INTERVAL_SECONDS = 10;
const REFRESH_DELAY_MS = 300;

const NORMAL_COUNTS = { local: 1, remote: 0 };

function callLogind(path, iface, method, params, cancellable, flags) {
    return callSystemBus(LOGIND_BUS_NAME, path, iface, method, params, cancellable, flags);
}

async function readSession(id, path, cancellable) {
    try {
        const [props] = await callLogind(path, "org.freedesktop.DBus.Properties",
            "GetAll", new GLib.Variant("(s)", [LOGIND_SESSION_IFACE]), cancellable);
        return { id, ...props };
    } catch (e) {
        if (isCancelled(e))
            throw e;
        return null;
    }
}

async function listUserSessions(cancellable) {
    const [entries] = await callLogind(LOGIND_PATH, LOGIND_MANAGER_IFACE, "ListSessions", null, cancellable);
    const sessions = await Promise.all(entries.map(([id, , , , path]) => readSession(id, path, cancellable)));
    return sessions
        .filter(s => s && (s.Class === "user" || s.Class.startsWith("user-")))
        .sort((a, b) => a.Timestamp - b.Timestamp);
}

async function findOwnSessionId(cancellable) {
    const id = GLib.getenv("XDG_SESSION_ID");
    if (id)
        return id;
    // "auto" falls back to the user's graphical session, as in GNOME Shell's login manager
    try {
        const [ownId] = await callLogind(`${LOGIND_PATH}/session/auto`, "org.freedesktop.DBus.Properties",
            "Get", new GLib.Variant("(ss)", [LOGIND_SESSION_IFACE, "Id"]), cancellable);
        return ownId;
    } catch (e) {
        if (isCancelled(e))
            throw e;
        return null;
    }
}

export function indicatorState(counts, kind) {
    const count = counts[kind];
    return {
        visible: count > NORMAL_COUNTS[kind] || counts[`${kind}Closing`] > 0,
        count,
        countWorthShowing: count > NORMAL_COUNTS[kind] + 1,
    };
}

export class SessionMonitor {
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._cancellable = new Gio.Cancellable();
        this._generation = 0;
        this._refreshSourceId = 0;
        this._dialog = null;
        this.groups = null;
        this.error = null;
        this.expandedSessionId = null;
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

    destroy() {
        GLib.source_remove(this._pollSourceId);
        if (this._refreshSourceId)
            GLib.source_remove(this._refreshSourceId);
        this._pollSourceId = this._refreshSourceId = 0;
        this._signalIds.forEach(id => Gio.DBus.system.signal_unsubscribe(id));
        this._signalIds = null;
        this._cancellable.cancel();
        this._closeDialog();
    }

    _queueRefresh() {
        if (this._refreshSourceId)
            GLib.source_remove(this._refreshSourceId);
        this._refreshSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_DELAY_MS, () => {
            this._refreshSourceId = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    async refresh() {
        // Only the latest refresh may update; older ones finishing late are dropped
        const generation = ++this._generation;
        let sessions;
        try {
            if (this.ownSessionId === undefined)
                this.ownSessionId = await findOwnSessionId(this._cancellable);
            sessions = await listUserSessions(this._cancellable);
        } catch (e) {
            if (!isCancelled(e) && generation === this._generation)
                this.setSessions(null, e);
            return;
        }
        if (generation === this._generation)
            this.setSessions(sessions);
    }

    setSessions(sessions, error = null) {
        this.error = error;
        this.groups = null;
        if (sessions) {
            const open = sessions.filter(s => s.State !== "closing");
            this.groups = {
                local: open.filter(s => !s.Remote),
                remote: open.filter(s => s.Remote),
                closing: sessions.filter(s => s.State === "closing"),
            };
        }
        this._onChanged();
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

    async terminateSession(id) {
        await callLogind(LOGIND_PATH, LOGIND_MANAGER_IFACE, "TerminateSession",
            new GLib.Variant("(s)", [id]), this._cancellable, Gio.DBusCallFlags.ALLOW_INTERACTIVE_AUTHORIZATION);
        this._queueRefresh();
    }

    listProcesses(session) {
        return listSessionProcesses(session.Scope, this._cancellable);
    }

    openDialog(dialog) {
        this._closeDialog();
        this._dialog = dialog;
        dialog.connect("destroy", () => {
            if (this._dialog === dialog)
                this._dialog = null;
        });
        dialog.open();
    }

    _closeDialog() {
        if (!this._dialog)
            return;
        // Destroying an open dialog does not end its modal grab
        this._dialog.popModal();
        this._dialog.destroy();
        this._dialog = null;
    }
}
