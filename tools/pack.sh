#!/bin/bash
# Packs the extension into dist/sessionspy@dev.swz.zip, the file uploaded
# to extensions.gnome.org and attached to GitHub releases.
#
# Usage: tools/pack.sh
# Needs msgfmt (gettext) and zip.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=sessionspy@dev.swz
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

"$ROOT/tools/build.sh" "$STAGE"
mkdir -p "$ROOT/dist"
rm -f "$ROOT/dist/$UUID.zip"
# GNOME 45+ compiles the schemas itself on install, so only the XML is shipped
rm -f "$STAGE/$UUID/schemas/gschemas.compiled"
(cd "$STAGE/$UUID" && zip -q -X -r "$ROOT/dist/$UUID.zip" .)
unzip -l "$ROOT/dist/$UUID.zip"
