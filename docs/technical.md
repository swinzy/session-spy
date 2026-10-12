# Technical notes

How Session Spy works, what it relies on in GNOME Shell and systemd, and how it is tested and released. Supported GNOME Shell versions: 46 to 51.

## Modules

| File | Runs in | What it does |
|---|---|---|
| `extension.js` | GNOME Shell | `enable()`/`disable()`; creates the views for the chosen display location |
| `sessionMonitor.js` | GNOME Shell | Reads sessions from logind, keeps them current, counts them, owns the end session dialog |
| `sessionList.js` | GNOME Shell | The session list shared by all menus: rows, expanding, the end button |
| `topBar.js` | GNOME Shell | "Top Bar Pills": two top bar buttons |
| `systemMenu.js` | GNOME Shell | "System Menu Icons": status icons and the Login Sessions row in quick settings |
| `endSession.js` | GNOME Shell | Lists a session's processes and the confirmation dialog |
| `async.js` | GNOME Shell | Promise wrappers for D-Bus and GIO calls, cancellation check |
| `sessionKinds.js` | GNOME Shell | Session kinds (local, remote, closing), their icons and list order |
| `settings.js` | Both | GSettings key names and display location values |
| `prefs.js` | Preferences | The preferences window |

`sessionMonitor.js` and `async.js` use only GLib/Gio; everything that builds UI uses St and the shell's own widgets.

## Sessions

All data comes from systemd-logind over D-Bus (`org.freedesktop.login1`), the same list as `loginctl list-sessions`:

1. `ListSessions()`, then `GetAll` on each session object. A session that disappears between the two calls is skipped.
2. Only sessions of class `user` (and `user-early`, `user-incomplete`) are kept. Greeter, lock-screen, background and `manager` (`user@.service`) sessions are left out.
3. Sessions are grouped:
   - **closing**: `State` is `closing`. The terminal or connection is gone but processes are left (e.g. tmux after an SSH connection dropped). Listed dimmed, not counted.
   - **remote**: logind's `Remote` is true (it has a remote host: SSH, remote desktop login).
   - **local**: the rest (seat or TTY logins, other users' graphical sessions).

**This session** is `XDG_SESSION_ID` if set, else the `Id` of logind's `session/auto` object, which falls back to the user's graphical session when the caller (GNOME Shell as a systemd user service) has no session of its own. GNOME Shell's own login manager does the same.

**Updates** come from logind's `SessionNew`/`SessionRemoved` signals (coalesced with a 300 ms timeout), a 10 second poll (logind does not signal a session turning `closing`), and every time a session list opens. Each refresh has a generation number, so a slow refresh finishing after a newer one is dropped.

## What shows

Normally there is one local session (this one) and no remote ones. An indicator shows when its side is above that, or while its side has a closing session:

| | Icon shows | Count shows (System Menu Icons, Show Session Counts on) |
|---|---|---|
| Local | 2+ local, or a local closing session | 3+ local |
| Remote | 1+ remote, or a remote closing session | 2+ remote |

The icon alone already means "one more than normal", so a count adds something only from two more on. The top bar pills always show their count.

- **System Menu Icons** (`display-location` = `system-menu`): a `SystemIndicator` added with `addExternalIndicator(indicator, 2)`, so GNOME puts its quick settings item full width just above the Background Apps row. The remote icon uses GNOME's `privacy-indicator` style class (the orange of the camera, microphone and screen recording indicators).
- **Top Bar Pills** (`top-bar`): two `PanelMenu.Button`s placed left of the other status icons, like the screen sharing and recording indicators. The remote one is a blue pill styled after `screen-sharing-indicator`. With `show-session-list` on, the Login Sessions row is added to quick settings as well, without the status icons.
- **The Login Sessions row** is a `QuickToggle` with GNOME's `background-apps-quick-toggle` style class and its arrow moved to the end, as GNOME's Background Apps row does. It shows only when an indicator would, and is not hidden while its list is open (that misplaces the menu, as GNOME notes for Background Apps).

## The session list

Shared by the row and both pills (`fillSessionList()`): this session first, then the groups in the menu's order; icons tell them apart (one user: this session, users: other local, terminal: remote). Each row is a `PopupBaseMenuItem` whose `activate()` expands it in place instead of closing the menu; one row is expanded at a time, and the monitor remembers which, since the list is rebuilt on every refresh. Expanded rows show logind's details and the process count.

## Ending a session

1. The row's close button closes the menu and lists the session's processes: the session's systemd scope (`Scope` property) → `GetUnit` → the unit's `ControlGroup` → `cgroup.procs` of that cgroup and the ones below it → `/proc/<pid>/cmdline` (or `comm` for kernel threads and zombies). At most 100 processes are listed.
2. `EndSessionDialog` is a `ModalDialog` with GNOME's `end-session-dialog` style class, so the warning is the amber list title of GNOME's log out dialog, above the processes.
3. Confirming calls logind's `TerminateSession()` with `ALLOW_INTERACTIVE_AUTHORIZATION`: ending another user's session asks for an administrator password through polkit. Failures show as a notification.

This session has no close button: "Log Out" is for that.

## Enabling and disabling

`disable()` runs, among others, when the screen locks (no `session-modes`). It destroys the views, then the monitor, which:

- removes its poll and refresh timeouts and unsubscribes from logind's signals,
- cancels its `Gio.Cancellable`: every D-Bus call and file read in flight rejects with `CANCELLED`, so no late callback opens a dialog or adds a timeout after `disable()`,
- closes an open end session dialog: `popModal()` first, as destroying an open `ModalDialog` does not end its modal grab.

Async GIO calls go through small Promise wrappers (`async.js`) rather than `Gio._promisify`, which would change GIO's prototypes for all of GNOME Shell when the module loads.

## Version differences

- `St.BoxLayout:vertical` became `:orientation` in GNOME 48; the session list checks which one exists.
- `Adw.ToggleGroup` is new in libadwaita 1.7 (GNOME 48, but not RHEL 10's GNOME 49); older versions get linked `Gtk.ToggleButton`s in the preferences.
- GNOME 51 opens menus with `{animate}` instead of a BoxPointer animation (tests only).

## Tests

`tests/run.sh` runs the extension in a throw-away headless GNOME Shell (own HOME, XDG dirs and session bus; works over SSH) with the test extension `tests/sstest@local`. It reads the real sessions from the system bus and compares the counts with `loginctl`, checks every display location, the session list, the preferences window, and that disabling with the end session dialog open leaves nothing behind. With `SS_SCREENSHOT_DIR` set it also shows made-up sessions in seven situations and saves screenshots; ending a session is replaced by a stub, so nothing is ended. `SS_BACKGROUND` sets the desktop colour; `tools/transparent.py` combines white and black background screenshots into transparent ones.

Before an upload, the tests run on this machine (GNOME 50) and on the LinuxDev VMs (GNOME 46, 48, 49, 51).

## Release

Work happens on `devel`; `version` in `metadata.json` is bumped when work on a new version starts. `tools/pack.sh` builds `dist/sessionspy@dev.swz.zip` (compiled translations, the schema XML without `gschemas.compiled`), which is uploaded to extensions.gnome.org. Only reviewed code goes to `main`; the manual `Release` workflow (`.github/workflows/release.yml`) then makes the GitHub release from `main`.
