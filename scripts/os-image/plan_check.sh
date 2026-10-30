#!/bin/bash
#
# Planner equivalence: the 2017 planner (gplan.so for Python 3.5, run in
# Raspbian Stretch) against the one built into the new image, on the same
# programs and controller settings.  Every command they produce must match.
#
#   plan_check.sh <work dir> <onefinity-os-X.img> <old package .tar.bz2> \
#                 <controller config.json> <program.nc> [...]
#
# Needs the Stretch Lite image zip (2017-11-29, the one gplan was first built
# against) in the work dir.  Runs as root with qemu-arm binfmt.

set -e
WORK=$(realpath "$1"); NEWIMG=$(realpath "$2"); OLDPKG=$(realpath "$3")
CFG=$(realpath "$4"); shift 4
HERE=$(dirname "$(realpath "$0")")
cd "$WORK"

STRETCH=2017-11-29-raspbian-stretch-lite
[ -e $STRETCH.img ] || unzip -o $STRETCH.zip >/dev/null

mounts=()
cleanup() {
    set +e
    for ((i=${#mounts[@]}-1; i>=0; i--)); do umount -l "${mounts[$i]}"; done
    for l in $LOOPS; do losetup -d $l; done
}
trap cleanup EXIT
LOOPS=

run_in() {   # image dir label out
    local IMG=$1 DIR=$WORK/$2 OUT=$3 PYTHON=$4 GPLAN=$5
    local L=$(losetup -fP --show -r "$IMG"); LOOPS="$LOOPS $L"
    mkdir -p "$DIR"
    mount -o ro ${L}p2 "$DIR"; mounts+=("$DIR")
    mount -t tmpfs tmpfs "$DIR/tmp"; mounts+=("$DIR/tmp")
    mount -t proc proc "$DIR/proc"; mounts+=("$DIR/proc")
    mount --bind /dev "$DIR/dev"; mounts+=("$DIR/dev")
    mkdir -p "$DIR/tmp/t/camotics" "$DIR/tmp/t/progs"
    cp "$GPLAN" "$DIR/tmp/t/camotics/gplan.so"
    touch "$DIR/tmp/t/camotics/__init__.py"
    cp "$HERE/plan_dump.py" "$CFG" "$DIR/tmp/t/"
    local names=()
    for p in "${PROGS[@]}"; do cp "$p" "$DIR/tmp/t/progs/"; names+=("progs/$(basename "$p")"); done
    chroot "$DIR" /bin/sh -c "cd /tmp/t && PYTHONPATH=. $PYTHON plan_dump.py $(basename "$CFG") out.jsonl ${names[*]}"
    cp "$DIR/tmp/t/out.jsonl" "$OUT"
}

PROGS=("$@")
mkdir -p old-gplan
tar -xjOf "$OLDPKG" --wildcards '*/src/py/camotics/gplan.so' > old-gplan/gplan.so
NEWGP=$(ls "$WORK"/gplan-cp*.so | tail -1)

echo "== Old planner: $(sha256sum old-gplan/gplan.so | cut -c1-16)… in Stretch (Python 3.5)"
run_in "$WORK/$STRETCH.img" stretch-root "$WORK/plan-old.jsonl" python3 "$WORK/old-gplan/gplan.so"
echo "== New planner: $(sha256sum "$NEWGP" | cut -c1-16)… in the new image"
run_in "$NEWIMG" new-root "$WORK/plan-new.jsonl" /opt/bbctrl/venv/bin/python "$NEWGP"

echo "== Compare"
python3 "$HERE/plan_compare.py" "$WORK/plan-old.jsonl" "$WORK/plan-new.jsonl" && R=0 || R=$?
python3 "$HERE/plan_compare.py" "$WORK/plan-old.jsonl" "$WORK/plan-new.jsonl" --tol 1e-9 >/dev/null && T=0 || T=1
echo "exact: $([ $R = 0 ] && echo yes || echo no); within 1e-9: $([ $T = 0 ] && echo yes || echo no)"
exit $R
