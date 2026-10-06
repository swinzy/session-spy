// Test driver for tests/run.sh. Waits for Session Spy, checks its counts and
// what the top bar shows against SS_EXPECT ("<local> <remote> <local closing>
// <remote closing>", from loginctl) in both indicator styles, opens the session
// lists, then disables and re-enables the extension. With SS_SCREENSHOT_DIR
// set, it then shows made-up sessions and saves screenshots of each case in
// each style. Writes "ok" or the failure to $SS_TEST_DIR/done.

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Shell from "gi://Shell";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

const UUID = "sessionspy@dev.swz";
const log = msg => console.log(`SSTEST: ${msg}`);
const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

async function waitFor(what, check, timeoutMs = 10000) {
    for (let waited = 0; waited < timeoutMs; waited += 100) {
        const value = check();
        if (value)
            return value;
        await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
}

function setMenuOpen(menu, open) {
    // GNOME 51 takes {animate}, older versions a BoxPointer animation
    const animate = parseInt(GLib.getenv("SS_SHELL_MAJOR") ?? "0") >= 51 ? { animate: false } : 0;
    if (open)
        menu.open(animate);
    else
        menu.close(animate);
}

const extensionState = () => Main.extensionManager.lookup(UUID)?.stateObj;
const monitor = () => extensionState()?._monitor;
const settings = () => extensionState()._settings;
const location = () => settings().get_string("display-location");
// The system menu part, if the current location has one
const systemMenuView = () => extensionState()?._views?.find(v => v.indicator);
const topBarButton = kind => Main.panel.statusArea[`${UUID}-${kind}`];

// What the top bar shows for a kind ("local" or "remote") at the current location
function shown(kind) {
    if (location() !== "system-menu") {
        const button = Main.panel.statusArea[`${UUID}-${kind}`];
        return { visible: button.visible, text: button._label.text };
    }
    const { icon, label } = systemMenuView().indicator._parts[kind];
    return { visible: icon.visible, text: label.visible ? label.text : "" };
}

// Checks what the indicators show for the given counts. Leftover sessions
// force the icon to show; quick settings counts only show from two above
// normal (1 local, 0 remote) on, panel buttons always show them.
function checkIndicators(local, remote, localClosing, remoteClosing) {
    const pills = location() !== "system-menu";
    const showCounts = settings().get_boolean("show-counts");
    const countText = (count, normal) => pills || (showCounts && count > normal + 1) ? String(count) : "";
    const want = {
        local: { visible: local > 1 || localClosing > 0, text: countText(local, 1) },
        remote: { visible: remote > 0 || remoteClosing > 0, text: countText(remote, 0) },
    };
    for (const kind of ["local", "remote"]) {
        const { visible, text } = shown(kind);
        const wantText = want[kind].text;
        if (visible !== want[kind].visible || (visible && text !== wantText))
            throw new Error(`${location()}: ${kind} visible=${visible} "${text}", expected ${want[kind].visible} "${wantText}"`);
    }
}

// Checks which parts exist for the current location
function checkLocation() {
    const value = location();
    const buttons = Boolean(topBarButton("local")) + Boolean(topBarButton("remote"));
    const icons = Object.keys(systemMenuView()?.indicator._parts ?? {}).length;
    const want = {
        "system-menu": [0, 2, 1],
        "top-bar": [2, 0, 0],
        "both": [2, 0, 1],
    }[value];
    const got = [buttons, icons, sessionRows()];
    log(`${value}: ${got[0]} top bar buttons, ${got[1]} status icons, ${got[2]} session rows`);
    if (got.join() !== want.join())
        throw new Error(`${value}: expected ${want.join()} top bar buttons, status icons, session rows`);
}

const openDialogs = () => Main.layoutManager.modalDialogGroup.get_children()
    .filter(d => d.constructor.name === "EndSessionDialog" && d.visible);

// Session rows in the quick settings menu
function sessionRows() {
    return Main.panel.statusArea.quickSettings.menu._grid.get_children()
        .filter(child => child.constructor.name === "SessionsToggle").length;
}

function menuItems(menu) {
    return menu._getMenuItems().flatMap(s => s._getMenuItems?.() ?? [s]);
}

async function checkMenu(menu, name) {
    setMenuOpen(menu, true);
    await sleep(500);
    const items = menuItems(menu);
    log(`${name} menu has ${items.length} items`);
    setMenuOpen(menu, false);
    const sessions = Object.values(monitor().groups).flat().length;
    if (items.length < sessions)
        throw new Error(`${name} menu lists ${items.length} items for ${sessions} sessions`);
}

async function setLocation(value, showCounts = false) {
    settings().set_string("display-location", value);
    settings().set_boolean("show-counts", showCounts);
    await sleep(300);
}

async function screenshot(name, height = 640, rect = null) {
    const dir = GLib.getenv("SS_SCREENSHOT_DIR");
    const file = Gio.File.new_for_path(`${dir}/${name}.png`);
    const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    const width = Math.min(1200, global.stage.width);
    const { x, y, w, h } = rect ?? { x: global.stage.width - width, y: 0, w: width, h: height };
    await new Shell.Screenshot().screenshot_area(x, y, w, h, stream);
    stream.close(null);
    log(`saved ${file.get_path()}`);
}

// Made-up sessions start at fixed times before 14:30 today, so screenshots
// from separate runs match (tools/transparent.py needs that)
const FAKE_NOW = new Date().setHours(14, 30, 0, 0);

function fakeSession(id, name, minutesAgo, props) {
    return {
        id: String(id), Name: name, Class: "user", State: "active", Active: false, Remote: false,
        Timestamp: (FAKE_NOW - minutesAgo * 60_000) * 1000, ...props,
    };
}

const own = fakeSession(2, "swz", 300, { Seat: ["seat0", "/"], Service: "gdm-password", Type: "wayland", Active: true });
const tty = fakeSession(7, "alice", 45, { TTY: "tty3", Service: "login", Type: "tty", State: "online" });
const ttyLeft = { ...tty, State: "closing" };
const ssh = fakeSession(11, "swz", 12, { Remote: true, RemoteHost: "10.10.21.3", Service: "sshd", Type: "tty", TTY: "pts/0" });
const rdp = fakeSession(14, "bob", 3, { Remote: true, RemoteHost: "192.168.1.50", Service: "gnome-remote-desktop", Type: "wayland" });
const tmux = fakeSession(4, "swz", 900, { Remote: true, RemoteHost: "10.10.21.3", Service: "sshd", TTY: "pts/1", State: "closing" });

const CASES = [
    ["1-only-own-session", [own], [1, 0, 0, 0]],
    ["2-local-other-user", [own, tty], [2, 0, 0, 0]],
    ["3-remote-ssh", [own, ssh], [1, 1, 0, 0]],
    ["4-remote-leftover", [own, tmux], [1, 0, 0, 1]],
    ["5-local-leftover", [own, ttyLeft], [1, 0, 1, 0]],
    ["6-local-and-remote", [own, tty, ssh, rdp, tmux], [2, 2, 0, 1]],
    ["7-three-local", [own, tty, { ...tty, id: "8", Name: "carol", TTY: "tty4" }, ssh], [3, 1, 0, 0]],
];

async function showcase() {
    let m = monitor();
    m.refresh = async () => {}; // keep the made-up sessions
    m.ownSessionId = own.id;
    Main.overview.hide();
    await sleep(1500);

    for (const [prefix, styleName, showCounts] of [
        ["qs-icons", "system-menu", false],
        ["qs-counts", "system-menu", true],
        ["pills", "top-bar", false],
    ]) {
        await setLocation(styleName, showCounts);
        for (const [name, sessions, counts] of CASES) {
            m.setSessions(sessions);
            await sleep(300);
            checkIndicators(...counts);
            await screenshot(`${prefix}-${name}`, 64);
        }
    }

    // The quick settings menu, then the session list opened from its row,
    // with the longest row title
    await setLocation("system-menu", false);
    m.setSessions(CASES.find(([name]) => name === "6-local-and-remote")[1]);
    const quickSettings = Main.panel.statusArea.quickSettings;
    setMenuOpen(quickSettings.menu, true);
    await sleep(1000);
    await screenshot("qs-menu", 1000);
    let toggle = systemMenuView().indicator._toggle;
    log(`quick settings row: "${toggle.title}", visible=${toggle.visible}`);
    setMenuOpen(toggle.menu, true);
    await sleep(1000);
    await screenshot("qs-session-list", 1000);

    // This session comes first
    const texts = actor => [actor.text, ...actor.get_children().flatMap(texts)].filter(Boolean);
    const firstItem = menuItems(toggle.menu)[0];
    log(`first session in the list: ${texts(firstItem)[0]}`);
    if (!texts(firstItem)[0].startsWith(`${own.Name} (#${own.id})`))
        throw new Error("this session is not first in the list");

    // End buttons: on every session but this one
    const buttons = menuItems(toggle.menu).flatMap(item => item.get_children?.() ?? [])
        .filter(child => child.has_style_class_name?.("session-spy-end-button"));
    const sessions = CASES.find(([name]) => name === "6-local-and-remote")[1];
    log(`${buttons.length} end buttons for ${sessions.length} sessions`);
    if (buttons.length !== sessions.length - 1)
        throw new Error("expected an end button on every session but this one");

    // The confirmation dialog for the SSH session, with made-up processes
    const listProcesses = async () => ({
        processes: [
            { pid: 4821, name: "sshd-session", command: "sshd-session: swz@pts/0" },
            { pid: 4822, name: "zsh", command: "-zsh" },
            { pid: 5310, name: "tmux", command: "tmux new -s work" },
            { pid: 5402, name: "vim", command: "vim src/extension.js" },
            { pid: 6118, name: "python3", command: "python3 -m http.server 8000" },
        ],
        total: 5,
    });
    m.listProcesses = listProcesses;
    const ended = [];
    m.terminateSession = async id => ended.push(id);
    const sshButton = buttons.find(b => texts(b.get_parent()).some(t => t.startsWith("swz (#11)")));
    sshButton.emit("clicked", 1);
    const dialog = await waitFor("end session dialog", () => openDialogs()[0]);
    await sleep(1000);
    await screenshot("end-session-dialog", 0, { x: 0, y: 0, w: global.stage.width, h: global.stage.height });
    const confirm = dialog.buttonLayout.get_children().at(-1);
    log(`dialog buttons: ${dialog.buttonLayout.get_children().map(b => b.label).join(", ")}`);
    confirm.emit("clicked", 1);
    await waitFor("session to be ended", () => ended.length > 0);
    log(`ended sessions: ${ended.join(", ")}`);
    if (ended.join() !== "11")
        throw new Error("wrong session ended");
    if (quickSettings.menu.isOpen)
        throw new Error("quick settings stayed open behind the dialog");

    // Expanding sessions in place: the menu stays open, one session is
    // expanded at a time, and it stays expanded when the list is rebuilt
    m.setSessions(sessions);
    setMenuOpen(quickSettings.menu, true);
    await sleep(500);
    setMenuOpen(toggle.menu, true);
    await sleep(500);
    const itemOf = prefix => menuItems(toggle.menu).find(item => texts(item)[0]?.startsWith(prefix));
    itemOf("swz (#4)").activate();
    itemOf("bob (#14)").activate();
    await sleep(800);
    const expandedNow = menuItems(toggle.menu).filter(item => item._expanded).map(item => item._session.id);
    if (expandedNow.join() !== "14")
        throw new Error(`expanded: ${expandedNow.join()}, expected only the last one, 14`);
    if (!toggle.menu.isOpen || !quickSettings.menu.isOpen)
        throw new Error("expanding a session closed the menu");
    await screenshot("qs-session-expanded", 1000);
    m.setSessions(sessions);
    await sleep(300);
    const expanded = menuItems(toggle.menu).filter(item => item._expanded).map(item => item._session.id);
    log(`expanded after rebuild: ${expanded.join(", ")}`);
    if (expanded.join() !== "14")
        throw new Error("expanded session not kept across a rebuild");
    log(`details of #14: ${itemOf("bob (#14)")._details.text.replaceAll("\n", " | ")}`);
    setMenuOpen(toggle.menu, false);
    setMenuOpen(quickSettings.menu, false);

    // Disabling the extension, e.g. by locking the screen, closes an open
    // end session dialog and ends its modal grab
    const modalCount = Main.modalCount;
    setMenuOpen(quickSettings.menu, true);
    await sleep(500);
    setMenuOpen(toggle.menu, true);
    await sleep(500);
    menuItems(toggle.menu).flatMap(item => item.get_children?.() ?? [])
        .find(child => child.has_style_class_name?.("session-spy-end-button")).emit("clicked", 1);
    await waitFor("end session dialog", () => openDialogs().length);
    await Main.extensionManager.disableExtension(UUID);
    await sleep(500);
    log(`after disable: ${openDialogs().length} dialogs, modal count ${Main.modalCount} (was ${modalCount})`);
    if (openDialogs().length || Main.modalCount !== modalCount)
        throw new Error("end session dialog left behind by disable()");
    await Main.extensionManager.enableExtension(UUID);
    await waitFor("system menu view after re-enable", () => systemMenuView());
    m = monitor();
    m.refresh = async () => {};
    m.ownSessionId = own.id;
    m.listProcesses = listProcesses;
    m.setSessions(sessions);
    toggle = systemMenuView().indicator._toggle;

    // The same list in the top bar buttons' menus
    await setLocation("top-bar");
    m.setSessions(sessions);
    for (const kind of ["remote", "local"]) {
        const menu = topBarButton(kind).menu;
        setMenuOpen(menu, true);
        await sleep(500);
        const item = menuItems(menu).find(i => texts(i)[0]?.startsWith(kind === "remote" ? "swz (#11)" : "alice (#7)"));
        item.activate();
        await sleep(800);
        if (!menu.isOpen || !item._expanded)
            throw new Error(`expanding in the ${kind} top bar menu failed`);
        await screenshot(`pill-${kind}-expanded`, 1000);
        setMenuOpen(menu, false);
        await sleep(300);
    }
    await setLocation("system-menu");

}

async function run() {
    const expected = GLib.getenv("SS_EXPECT").split(" ").map(Number);
    await waitFor("Main.layoutManager startup", () => !Main.layoutManager._startingUp);

    await waitFor("system menu view", () => systemMenuView());
    let counts = await waitFor("counts", () => monitor()?.counts);
    const actual = [counts.local, counts.remote, counts.localClosing, counts.remoteClosing];
    log(`counts ${actual.join(" ")}, expected ${expected.join(" ")}, own session ${monitor().ownSessionId}`);
    if (actual.join(" ") !== expected.join(" "))
        throw new Error("counts differ from loginctl");

    // Default location: system menu icons without counts, and a session row
    if (location() !== "system-menu")
        throw new Error(`default location is ${location()}`);
    checkIndicators(...expected);
    await setLocation("system-menu", true);
    checkIndicators(...expected);
    checkLocation();
    const toggle = systemMenuView().indicator._toggle;
    log(`quick settings row: "${toggle.title}"`);
    setMenuOpen(Main.panel.statusArea.quickSettings.menu, true);
    await sleep(500);
    await checkMenu(toggle.menu, "session row");
    setMenuOpen(Main.panel.statusArea.quickSettings.menu, false);

    // The other locations, then back
    for (const value of ["top-bar", "both", "system-menu"]) {
        await setLocation(value);
        checkIndicators(...expected);
        checkLocation();
    }
    await setLocation("top-bar");
    const button = ["remote", "local"].map(topBarButton).find(b => b.visible);
    if (button)
        await checkMenu(button.menu, "top bar button");
    await setLocation("system-menu");

    // Re-enabling must not leave the old indicators or fail
    const manager = Main.extensionManager;
    const qsChildren = Main.panel.statusArea.quickSettings._indicators.get_n_children();
    await manager.disableExtension(UUID);
    await sleep(500);
    if (Main.panel.statusArea.quickSettings._indicators.get_n_children() !== qsChildren - 1 || sessionRows() !== 0)
        throw new Error("indicator or session row left in quick settings after disable");
    await manager.enableExtension(UUID);
    await waitFor("system menu view after re-enable", () => systemMenuView());
    counts = await waitFor("counts after re-enable", () => monitor()?.counts);
    log(`after re-enable local=${counts.local} remote=${counts.remote}`);

    await checkProcesses();
    await checkPrefs();

    if (GLib.getenv("SS_SCREENSHOT_DIR"))
        await showcase();
}

// Lists the processes of a real session (read only)
async function checkProcesses() {
    const session = Object.values(monitor().groups).flat().find(s => s.Scope);
    if (!session) {
        log("no session with a scope to list processes of");
        return;
    }
    const { processes, total } = await monitor().listProcesses(session);
    log(`session ${session.id} (${session.Scope}): ${total} processes, e.g. ${processes.slice(0, 3).map(p => p.name).join(", ")}`);
    if (!total || !processes.length)
        throw new Error("no processes listed");
}

// Opens the preferences window (a separate D-Bus activated process) and
// screenshots it
async function checkPrefs() {
    Main.overview.hide();
    await sleep(1000);
    Main.extensionManager.openExtensionPrefs(UUID, "", {});
    const prefsWindow = () => global.get_window_actors()
        .map(actor => actor.get_meta_window())
        .find(w => w.get_title() === "Session Spy");
    const window = await waitFor("preferences window", prefsWindow, 20000);
    log(`preferences window opened (${window.get_wm_class()})`);
    await sleep(3000);
    if (GLib.getenv("SS_SCREENSHOT_DIR")) {
        const { x, y, width, height } = window.get_frame_rect();
        await screenshot("prefs", 0, { x, y, w: width, h: height });
    }
    window.delete(global.get_current_time());
    await sleep(500);
}

function finish(result) {
    GLib.file_set_contents(`${GLib.getenv("SS_TEST_DIR")}/done`, result);
}

export default class TestExtension extends Extension {
    enable() {
        // Disabling sessionspy reloads extensions enabled after it, so this can run twice
        if (globalThis.__ssTestStarted)
            return;
        globalThis.__ssTestStarted = true;
        run().then(() => finish("ok"), e => {
            log(`FAIL: ${e.message}\n${e.stack}`);
            finish(`fail: ${e.message}`);
        });
    }

    disable() {}
}
