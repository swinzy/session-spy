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

import { callAsync, callSystemBus } from "./async.js";

// More would only slow the dialog down; its list scrolls anyway
const MAX_LISTED_PROCESSES = 100;

function callSystemd(path, iface, method, params, cancellable) {
    return callSystemBus("org.freedesktop.systemd1", path, iface, method, params, cancellable);
}

async function readText(path, cancellable) {
    const [, bytes] = await callAsync(Gio.File.new_for_path(path),
        "load_contents_async", "load_contents_finish", cancellable);
    return new TextDecoder().decode(bytes);
}

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

export const EndSessionDialog = GObject.registerClass(
class EndSessionDialog extends ModalDialog.ModalDialog {
    _init(name, details, processes, onConfirm) {
        // GNOME's log out dialog style shows the list title as an amber warning
        super._init({ styleClass: "end-session-dialog", destroyOnClose: true });

        this.contentLayout.add_child(new Dialog.MessageDialogContent({
            title: _("End Session?"),
            description: `${name}\n${details}`,
        }));

        const list = new Dialog.ListSection({
            title: _("This will also stop all processes associated with this session."),
        });
        const listed = processes ? processes.processes : [];
        for (const { pid, name: processName, command } of listed) {
            list.list.add_child(new Dialog.ListSectionItem({
                title: processName,
                description: `${pid} · ${command || processName}`,
            }));
        }
        const unlisted = processes ? processes.total - listed.length : 0;
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
