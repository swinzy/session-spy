/* endSession.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Clutter from "gi://Clutter";

import * as Dialog from "resource:///org/gnome/shell/ui/dialog.js";
import * as ModalDialog from "resource:///org/gnome/shell/ui/modalDialog.js";
import { gettext as _, ngettext } from "resource:///org/gnome/shell/extensions/extension.js";

// More would only make the dialog slow to open; the list scrolls anyway
const MAX_LISTED_PROCESSES = 100;

function callSystemd(path, iface, method, params, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.DBus.system.call(
            "org.freedesktop.systemd1", path, iface, method, params, null,
            Gio.DBusCallFlags.NONE, -1, cancellable,
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
 * Calls an asynchronous GIO method and resolves with what its finish method
 * returns. (Gio._promisify would change GIO's prototypes for all of GNOME
 * Shell, which an extension must not do.)
 */
function callAsync(object, method, finish, ...args) {
    return new Promise((resolve, reject) => {
        object[method](...args, (source, result) => {
            try {
                resolve(source[finish](result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function readText(path, cancellable) {
    const [, bytes] = await callAsync(Gio.File.new_for_path(path),
        "load_contents_async", "load_contents_finish", cancellable);
    return new TextDecoder().decode(bytes);
}

/** Process IDs in a cgroup and the cgroups below it. */
async function readCgroupPids(dir, cancellable) {
    const pids = (await readText(`${dir}/cgroup.procs`, cancellable))
        .split("\n").filter(Boolean).map(Number);

    const enumerator = await callAsync(Gio.File.new_for_path(dir),
        "enumerate_children_async", "enumerate_children_finish",
        "standard::name,standard::type", Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
    for (;;) {
        const infos = await callAsync(enumerator, "next_files_async", "next_files_finish",
            50, GLib.PRIORITY_DEFAULT, cancellable);
        if (!infos.length)
            break;
        for (const info of infos) {
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                pids.push(...await readCgroupPids(`${dir}/${info.get_name()}`, cancellable));
        }
    }
    return pids;
}

/** The name and command line of a process, or null if it has gone. */
async function describeProcess(pid, cancellable) {
    try {
        const argv = (await readText(`/proc/${pid}/cmdline`, cancellable)).split("\0").filter(Boolean);
        // Kernel threads and zombies have no command line
        const name = argv.length
            ? GLib.path_get_basename(argv[0])
            : (await readText(`/proc/${pid}/comm`, cancellable)).trim();
        return { pid, name, command: argv.join(" ") };
    } catch {
        return null;
    }
}

/**
 * Lists the processes of a logind session, from its systemd scope unit.
 * Resolves with { processes, total }, where processes holds at most
 * MAX_LISTED_PROCESSES of the total, by process ID.
 */
export async function listSessionProcesses(scope, cancellable = null) {
    const [unitPath] = await callSystemd("/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager",
        "GetUnit", new GLib.Variant("(s)", [scope]), cancellable);
    const [controlGroup] = await callSystemd(unitPath, "org.freedesktop.DBus.Properties",
        "Get", new GLib.Variant("(ss)", ["org.freedesktop.systemd1.Scope", "ControlGroup"]), cancellable);
    const pids = (await readCgroupPids(`/sys/fs/cgroup${controlGroup}`, cancellable)).sort((a, b) => a - b);
    const processes = (await Promise.all(pids.slice(0, MAX_LISTED_PROCESSES)
        .map(pid => describeProcess(pid, cancellable)))).filter(Boolean);
    return { processes, total: pids.length };
}

/**
 * Asks before ending a session, styled like GNOME's own log out dialog: the
 * warning about the session's processes is in its amber list title, above the
 * processes themselves.
 */
export const EndSessionDialog = GObject.registerClass(
class EndSessionDialog extends ModalDialog.ModalDialog {
    /**
     * @param {string} name the session's name, e.g. "swz (#11)"
     * @param {string} details where the session comes from
     * @param {?object} processes from listSessionProcesses(), or null if unknown
     * @param {Function} onConfirm called once the dialog has closed
     */
    _init(name, details, processes, onConfirm) {
        super._init({ styleClass: "end-session-dialog", destroyOnClose: true });

        this.contentLayout.add_child(new Dialog.MessageDialogContent({
            title: _("End Session?"),
            description: `${name}\n${details}`,
        }));

        const list = new Dialog.ListSection({
            title: _("This will also stop all processes associated with this session."),
        });
        for (const { pid, name: processName, command } of processes?.processes ?? []) {
            list.list.add_child(new Dialog.ListSectionItem({
                title: processName,
                description: `${pid} · ${command || processName}`,
            }));
        }
        const unlisted = processes ? processes.total - processes.processes.length : 0;
        if (unlisted > 0) {
            list.list.add_child(new Dialog.ListSectionItem({
                title: ngettext("%d more process", "%d more processes", unlisted).format(unlisted),
            }));
        }
        this.contentLayout.add_child(list);

        this.addButton({
            action: () => this.close(),
            label: _("Cancel"),
            key: Clutter.KEY_Escape,
        });
        this.addButton({
            action: () => {
                this.connect("closed", () => onConfirm());
                this.close();
            },
            label: _("End Session"),
        });
    }
});
