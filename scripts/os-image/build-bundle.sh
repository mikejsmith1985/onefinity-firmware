#!/bin/bash
#
# Makes an OS file for the A/B card (1.51.1) from an Onefinity OS image, so
# the running slot can write it into the other slot over the network
# (Admin > SD card, or PUT /api/abcard/upload; scripts/ab-card "write").
#
#   build-bundle.sh <onefinity-os-X.img> <out.tar> [old card .img]
#
# The file is a plain tar (no compression: the 2017 system's tar reads it
# without guessing): ab-bundle.json first, then boot/ (32-bit kernel, device
# trees, overlays, cmdline.txt) and root/.  Writing it carries the running
# slot's controller data, host name and SSH keys into the new slot.
#
# With the old card's image, its Wi-Fi network is added as a NetworkManager
# connection (key copied, never printed).  The file then holds the Wi-Fi key:
# keep it on the PC, don't publish it.

set -e
IMG=$(realpath "$1"); OUT=$(realpath -m "$2"); OLD=${3:+$(realpath "$3")}
W=$(dirname "$OUT")/bundle-build
mkdir -p $W/b $W/r $W/o $W/stage
LOOPS=()
cleanup() {
    set +e
    for m in o r b; do mountpoint -q $W/$m && umount $W/$m; done
    for l in "${LOOPS[@]}"; do losetup -d $l; done
}
trap cleanup EXIT
attach() { local l; l=$(losetup -fP --show -r "$1"); LOOPS+=($l); echo $l; }

L=$(attach "$IMG")
mount -o ro ${L}p1 $W/b; mount -o ro,noload ${L}p2 $W/r
VER=$(cat $W/r/etc/onefinity-os)
OS=$(sed -n 's/^PRETTY_NAME="\?\([^"]*\)"\?/\1/p' $W/r/etc/os-release)
echo "Onefinity OS $VER ($OS)"

S=$W/stage; rm -rf $S; mkdir -p $S/boot/overlays
python3 - "$S/ab-bundle.json" "$VER" "$OS" <<'PY'
import json, sys, time
json.dump({'format': 1, 'label': 'Onefinity OS %s' % sys.argv[2],
           'version': sys.argv[2], 'os': sys.argv[3],
           'made': time.strftime('%Y-%m-%d %H:%M')}, open(sys.argv[1], 'w'))
PY
cp $W/b/kernel7.img $W/b/*.dtb $S/boot/
cp -r $W/b/overlays/. $S/boot/overlays/
# The shared config.txt names the old overlay; the new firmware maps it, and
# this copy makes sure
cp $S/boot/overlays/disable-bt.dtbo $S/boot/overlays/pi3-disable-bt.dtbo
# No initramfs (it would grow the root partition); ab-card sets root= and panic=
echo "console=tty1 root=/dev/mmcblk0p3 rootfstype=ext4 fsck.repair=yes rootwait quiet cfg80211.ieee80211_regdom=US panic=10" \
    > $S/boot/cmdline.txt

EXTRA=
if [ -n "$OLD" ]; then
    LO=$(attach "$OLD"); mount -o ro,noload ${LO}p2 $W/o
    mkdir -p $S/extra/etc/NetworkManager/system-connections
    python3 - $W/o/etc/network/interfaces.d/wlan0 \
        $S/extra/etc/NetworkManager/system-connections/onefinity-wifi.nmconnection <<'PY'
import sys, re, uuid, os
try: text = open(sys.argv[1]).read()
except OSError: print('the old card has no Wi-Fi settings'); sys.exit(0)
def val(key):
    m = re.search(r'^\s*' + key + r'\s+(.+?)\s*$', text, re.M)
    if not m: return None
    v = m.group(1)
    return v[1:-1] if len(v) > 1 and v[0] == v[-1] == '"' else v
ssid, psk = val('wpa-ssid'), val('wpa-psk')
if not ssid: print('no Wi-Fi network on the old card'); sys.exit(0)
sec = ('\n[wifi-security]\nkey-mgmt=wpa-psk\npsk=%s\n' % psk) if psk else ''
fd = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    f.write('[connection]\nid=onefinity-wifi\nuuid=%s\ntype=wifi\nautoconnect=true\n'
            '\n[wifi]\nmode=infrastructure\nssid=%s\n%s'
            '\n[ipv4]\nmethod=auto\n\n[ipv6]\nmethod=auto\n' % (uuid.uuid4(), ssid, sec))
print('Wi-Fi network "%s" (%s) added' % (ssid, 'with its key' if psk else 'open'))
PY
    EXTRA=1
fi

echo "== Writing $OUT"
rm -f "$OUT"
tar -C $S -cf "$OUT" ab-bundle.json
tar -C $S -rf "$OUT" --owner=0 --group=0 boot
# The transform's S flag renames entries only, never symlink targets.  /dev
# is made at boot (devtmpfs), and the 2017 system's tar can't recreate
# /etc/mtab's absolute link (found rehearsing the write): it goes in as a
# relative link instead
tar -C $W/r -rf "$OUT" --numeric-owner --xattrs --xattrs-include='*' \
    --exclude='./dev/*' --exclude=./etc/mtab --transform 's,^\.,root,S' .
mkdir -p $S/extra/etc
ln -sfn ../proc/self/mounts $S/extra/etc/mtab
X=./etc/mtab
[ -n "$EXTRA" ] && X="$X ./etc/NetworkManager/system-connections/onefinity-wifi.nmconnection"
tar -C $S/extra -rf "$OUT" --numeric-owner --transform 's,^\.,root,S' $X
rm -rf $S

echo "== Checks"
fail=0
chk() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
LIST=$W/list.txt; tar -tvf "$OUT" > $LIST
chk "ab-bundle.json first" "[ \"\$(head -1 $LIST | awk '{print \$NF}')\" = ab-bundle.json ]"
chk "kernel7.img and the Pi 3 device tree" "grep -q ' boot/kernel7.img$' $LIST && grep -q ' boot/bcm2710-rpi-3-b.dtb$' $LIST"
chk "overlays pi3-disable-bt, gpio-poweroff" "grep -q 'boot/overlays/pi3-disable-bt.dtbo$' $LIST && grep -q 'boot/overlays/gpio-poweroff.dtbo$' $LIST"
chk "root: tty1 login, trial check" "grep -q 'root/etc/systemd/system/getty.target.wants/getty@tty1.service' $LIST && grep -q 'root/etc/systemd/system/multi-user.target.wants/onefinity-trial-check.service' $LIST"
chk "root: Wi-Fi radio on" "tar -xOf '$OUT' root/var/lib/NetworkManager/NetworkManager.state | grep -q '^WirelessEnabled=true'"
chk "root: NetworkManager keyfile only" "tar -xOf '$OUT' root/etc/NetworkManager/conf.d/99-onefinity.conf | grep -q '^plugins=keyfile'"
chk "root: touch turned with the screen" "tar -xOf '$OUT' root/usr/share/X11/xorg.conf.d/40-libinput.conf | grep -q 'TransformationMatrix.*-1 0 1 0 -1 1 0 0 1'"
chk "symlink targets untouched (none start with root.)" "! grep -q -- '-> root\\.' $LIST"
chk "relative links kept (var/log/README -> ../..)" "grep -q 'root/var/log/README -> \\.\\./' $LIST"
chk "etc/mtab relative" "grep -q 'root/etc/mtab -> \\.\\./proc/self/mounts' $LIST"
chk "root: ab-card checks the network" "tar -xOf '$OUT' root/opt/bbctrl/venv/bin/ab-card | grep -q \"h\\['network'\\]\""
[ -z "$EXTRA" ] || chk "root: Wi-Fi connection, private" "grep -q -- '-rw------- 0/0 .* root/etc/NetworkManager/system-connections/onefinity-wifi.nmconnection$' $LIST"
[ $fail = 0 ] || { echo "CHECKS FAILED"; exit 1; }
( cd $(dirname "$OUT") && sha256sum $(basename "$OUT") > $(basename "$OUT").sha256 )
ls -la "$OUT"; cat "$OUT.sha256"
echo BUNDLE-DONE
