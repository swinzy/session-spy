/* sessionKinds.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const KIND_LOCAL = "local";
export const KIND_REMOTE = "remote";
export const KIND_CLOSING = "closing";

export const ICON_NAMES = {
    [KIND_LOCAL]: "system-users-symbolic",
    [KIND_REMOTE]: "utilities-terminal-symbolic",
};

// Session list order: the given kind's sessions, then the other open ones, then closing ones
export function listOrder(firstKind) {
    const otherKind = firstKind === KIND_REMOTE ? KIND_LOCAL : KIND_REMOTE;
    return [firstKind, otherKind, KIND_CLOSING];
}
