#!/bin/bash
# Extracts translatable strings into po/<gettext-domain>.pot and merges them
# into the existing po/<lang>.po files.
#
# Usage: tools/update-pot.sh
# To start a new translation: msginit -i po/<domain>.pot -o po/<lang>.po -l <lang>
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=sessionspy@dev.swz
DOMAIN=$(sed -n 's/.*"gettext-domain": *"\([^"]*\)".*/\1/p' "$ROOT/$UUID/metadata.json")
POT=po/$DOMAIN.pot

cd "$ROOT"
xgettext --from-code=UTF-8 --language=JavaScript \
    --keyword=_ --keyword=ngettext:1,2 --keyword=pgettext:1c,2 \
    --package-name="Session Spy" --msgid-bugs-address="https://github.com/swinzy/session-spy/issues" \
    --add-comments=Translators: --sort-by-file \
    --output="$POT" "$UUID"/*.js

for po in po/*.po; do
    [ -e "$po" ] || continue
    msgmerge --quiet --update --backup=none "$po" "$POT"
done
