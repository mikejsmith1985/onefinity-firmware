#!/bin/bash
#
# Makes a patch file for the A/B card (1.52.0): only the files that change,
# written over the other slot by "ab-card patch" (Admin > SD card > Load a
# patch, or from a USB stick).  Nothing else in the slot is touched.
#
#   build-patch.sh <out.tar.gz> <label> <dir> [version] [os_match]
#
# <dir> holds root/ (files at their place in the system, e.g.
# root/opt/bbctrl/venv/bin/ab-card) and/or boot/ (the slot's boot files,
# e.g. boot/cmdline.txt).  version: the slot's version afterwards (optional).
# os_match: text the slot's OS name must contain, e.g. "trixie" (optional;
# keeps a patch for the new OS off the 2017 system).

set -e
OUT=$(realpath -m "$1"); LABEL=$2; DIR=$(realpath "$3"); VER=$4; OSM=$5
[ -n "$LABEL" ] && [ -d "$DIR" ] || { echo "usage: $0 out.tar.gz label dir [version] [os_match]"; exit 1; }
[ -d "$DIR/root" ] || [ -d "$DIR/boot" ] || { echo "$DIR has no root/ or boot/"; exit 1; }
for x in "$DIR"/*; do
    case "$(basename "$x")" in root|boot) ;; *) echo "only root/ and boot/ may be in $DIR: $x"; exit 1 ;; esac
done
T=$(mktemp -d); trap 'rm -rf $T' EXIT
python3 - "$T/ab-patch.json" "$LABEL" "$VER" "$OSM" <<'PY'
import json, sys
m = {'format': 1, 'label': sys.argv[2]}
if sys.argv[3]: m['version'] = sys.argv[3]
if sys.argv[4]: m['os_match'] = sys.argv[4]
json.dump(m, open(sys.argv[1], 'w'))
PY
PARTS=$(cd "$DIR" && ls -d root boot 2>/dev/null || true)
# ab-patch.json first (the tool reads only the first entry to know the kind)
tar -C "$T" -cf "$T/p.tar" --owner=0 --group=0 ab-patch.json
# Files and links only: directory entries would reset existing folders'
# owners and modes on the controller
( cd "$DIR" && find $PARTS ! -type d | sort ) > "$T/list"
[ -s "$T/list" ] || { echo "nothing to patch in $DIR"; exit 1; }
tar -C "$DIR" -rf "$T/p.tar" --numeric-owner --owner=0 --group=0 --no-recursion -T "$T/list"
gzip -9 -c "$T/p.tar" > "$OUT"
( cd "$(dirname "$OUT")" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256" )
tar -tvzf "$OUT"
cat "$OUT.sha256"
