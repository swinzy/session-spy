/* async.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Gio from "gi://Gio";
import GLib from "gi://GLib";

export function isCancelled(error) {
    return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export function callSystemBus(busName, path, iface, method, params, cancellable, flags = Gio.DBusCallFlags.NONE) {
    return new Promise((resolve, reject) => {
        Gio.DBus.system.call(busName, path, iface, method, params, null, flags, -1, cancellable,
            (connection, result) => {
                try {
                    resolve(connection.call_finish(result).recursiveUnpack());
                } catch (e) {
                    reject(e);
                }
            });
    });
}

// Not Gio._promisify, which would change GIO for all of GNOME Shell
export function callAsync(object, method, finish, ...args) {
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
