#!/bin/bash
# Runs the extension in an isolated headless GNOME Shell and drives it with
# tests/sstest@local. Needs no graphical session (works over SSH) and does not
# touch the user's real settings: HOME, XDG dirs and the session bus are all
# temporary. Sessions are read from the real system bus, and the expected counts
# come from loginctl.
#
# Usage: tests/run.sh
# Set SS_SCREENSHOT_DIR to an existing directory to also save screenshots of the
# indicators with made-up sessions (at scale 2, on a plain white desktop, or
# the colour in SS_BACKGROUND); LANG is passed through to the shell.
# Exit status is 0 if all checks pass.
set -u

TESTS=$(cd "$(dirname "$0")" && pwd)
REPO=$(dirname "$TESTS")
TIMEOUT=120

# Expected "<local> <remote> <local closing> <remote closing>" user-class sessions
local_count=0 remote_count=0 local_closing=0 remote_closing=0
for id in $(loginctl list-sessions --no-legend | awk '{print $1}'); do
    eval "$(loginctl show-session "$id" -p Class -p State -p Remote | sed 's/^/S_/')"
    [[ $S_Class == user* ]] || continue
    side=local
    [ "$S_Remote" = yes ] && side=remote
    [ "$S_State" = closing ] && side=${side}_closing || side=${side}_count
    eval "$side=\$(($side + 1))"
done

T=$(mktemp -d "${TMPDIR:-/tmp}/ss-test.XXXXXX")
mkdir -p "$T"/{home,config,data/gnome-shell/extensions,cache}
"$REPO/tools/build.sh" "$T/data/gnome-shell/extensions" || { echo "RESULT: build failed"; exit 1; }
cp -r "$TESTS/sstest@local" "$T/data/gnome-shell/extensions/"

export HOME=$T/home XDG_CONFIG_HOME=$T/config XDG_DATA_HOME=$T/data XDG_CACHE_HOME=$T/cache
export SS_TEST_DIR=$T SS_EXPECT="$local_count $remote_count $local_closing $remote_closing" TIMEOUT
export SS_SHELL_MAJOR=$(gnome-shell --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')
unset DBUS_SESSION_BUS_ADDRESS DISPLAY WAYLAND_DISPLAY

dbus-run-session -- bash -c '
    gsettings set org.gnome.shell enabled-extensions "[\"sessionspy@dev.swz\", \"sstest@local\"]"
    gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"
    monitor=1280x800
    if [ -n "${SS_SCREENSHOT_DIR:-}" ]; then
        gsettings set org.gnome.desktop.interface scaling-factor 2
        monitor=2560x2000
        # A plain desktop (white unless SS_BACKGROUND says otherwise), so
        # screenshots crop cleanly
        gsettings set org.gnome.desktop.background picture-uri ""
        gsettings set org.gnome.desktop.background picture-uri-dark ""
        gsettings set org.gnome.desktop.background picture-options none
        gsettings set org.gnome.desktop.background color-shading-type solid
        gsettings set org.gnome.desktop.background primary-color "${SS_BACKGROUND:-#ffffff}"
    fi
    # Lets the D-Bus activated preferences process find the display
    dbus-update-activation-environment WAYLAND_DISPLAY=ss-test-0 2>/dev/null
    gnome-shell --headless --wayland --no-x11 --wayland-display=ss-test-0 \
        --virtual-monitor "$monitor" > "$SS_TEST_DIR/shell.log" 2>&1 &
    pid=$!
    for _ in $(seq 1 "$TIMEOUT"); do
        [ -f "$SS_TEST_DIR/done" ] && break
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
    done
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
' > /dev/null 2>&1

grep -E "SSTEST:|JS ERROR|JS WARNING|sessionspy|Gjs-CRITICAL" "$T/shell.log" | sed -E "s/^.*SSTEST: //"
RESULT=$(cat "$T/done" 2>/dev/null || echo "no result (timeout or crash)")
echo "RESULT: $RESULT"
echo "Full log: $T/shell.log"
[ "$RESULT" = ok ]
