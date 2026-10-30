#!/bin/bash
#
# Builds the Onefinity OS image (1.50.0): Raspberry Pi OS Lite 32-bit (Trixie)
# with the controller firmware, the motion planner and serial driver built for
# it, the touchscreen kiosk and the services the controller needs.
#
# Runs as root on an x86 Linux machine (WSL is fine) with qemu-user-static
# registered for ARM (binfmt).  Everything ARM is built inside the image, so
# what is tested is what ships.
#
#   build.sh <work dir> <onefinity-X.Y.Z.tar.bz2> [onefinity-data.tar.gz]
#
# The work dir holds the downloaded Raspberry Pi OS image (BASE below).
# Output: <work dir>/onefinity-os-<version>.img(.xz) and .sha256.

set -e
WORK=$(realpath "$1")
PKG=$(realpath "$2")
DATA=${3:+$(realpath "$3")}
HERE=$(dirname "$(realpath "$0")")

BASE=2026-10-06-raspios-trixie-armhf-lite.img.xz
SIZE=5G      # first boot grows the root partition to fill the card

VER=$(tar -xjOf "$PKG" --wildcards '*/package.json' | python3 -c \
      'import json,sys; print(json.load(sys.stdin)["version"])')
IMG=$WORK/onefinity-os-$VER.img
ROOT=$WORK/root
LOG=$WORK/build-$VER.log

cd "$WORK"
[ -e "$BASE" ] || { echo "Missing $WORK/$BASE"; exit 1; }
[ -e /proc/sys/fs/binfmt_misc/qemu-arm ] || { echo "qemu-arm binfmt missing"; exit 1; }

cleanup() {
    set +e
    for m in dev/pts dev proc sys run boot/firmware; do
        mountpoint -q "$ROOT/$m" && umount -l "$ROOT/$m"
    done
    mountpoint -q "$ROOT" && umount -l "$ROOT"
    [ -n "$LOOP" ] && losetup -d "$LOOP"
}
trap cleanup EXIT

echo "== Image $IMG from $BASE, firmware $VER"
xz -dc "$BASE" > "$IMG"
truncate -s $SIZE "$IMG"
parted -s "$IMG" resizepart 2 100%
LOOP=$(losetup -fP --show "$IMG")
e2fsck -fy ${LOOP}p2 >/dev/null || true
resize2fs ${LOOP}p2 >/dev/null

mkdir -p "$ROOT"
mount ${LOOP}p2 "$ROOT"
mount ${LOOP}p1 "$ROOT/boot/firmware"
mount --bind /dev "$ROOT/dev"
mount --bind /dev/pts "$ROOT/dev/pts"
mount -t proc proc "$ROOT/proc"
mount -t sysfs sys "$ROOT/sys"
mount -t tmpfs tmpfs "$ROOT/run"
cp /etc/resolv.conf "$ROOT/etc/resolv.conf.build"

# What the chroot step needs
STAGE=$ROOT/root/onefinity-build
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -r "$HERE"/files "$HERE"/chroot-setup.sh "$HERE"/plan_dump.py "$STAGE"/
cp "$HERE"/../gplan-patches.sh "$STAGE"/ 2>/dev/null || true
cp "$PKG" "$STAGE"/firmware.tar.bz2
[ -n "$DATA" ] && cp "$DATA" "$ROOT/boot/firmware/onefinity-data.tar.gz"

echo "== Setting up inside the image (log: $LOG)"
chroot "$ROOT" /bin/bash /root/onefinity-build/chroot-setup.sh "$VER" 2>&1 |
    tee "$LOG"
[ "${PIPESTATUS[0]}" -eq 0 ] || { echo "chroot setup failed"; exit 1; }

# Keep the planner and serial driver builds' records with the image
cp "$STAGE"/build-info.txt "$WORK/build-info-$VER.txt" 2>/dev/null || true
cp "$ROOT"/usr/local/lib/onefinity/gplan-cp*.so "$WORK"/ 2>/dev/null || true
rm -rf "$STAGE" "$ROOT/etc/resolv.conf.build"

df -h "$ROOT" "$ROOT/boot/firmware" | tee -a "$LOG"
cleanup
LOOP=
trap - EXIT

echo "== Shrinking unused space and compressing"
xz -T0 -6 -kf "$IMG"
sha256sum "$(basename "$IMG").xz" > "$IMG.xz.sha256"
ls -la "$IMG" "$IMG.xz"
cat "$IMG.xz.sha256"
echo BUILD-OK
