#!/bin/bash
#
# Builds an A/B card image (1.51.0) from two single-system images:
#
#   slot A  the original controller card, copied file for file (the normal
#           slot: the card starts it unless told otherwise)
#   slot B  the Onefinity OS image (build.sh), tried with "Try slot B" on the
#           Admin > SD card page; it goes back to A by itself if it doesn't
#           work (see ab-card trial-check)
#
#   build-ab.sh <old card .img> <onefinity-os-X.img> <out .img> [data.tar.gz]
#
# The layout is the one "ab-card make" makes (scripts/ab-card), so the A/B
# page and tool on either slot know the card:
#   p1  FAT32 boot (512 MiB): boot firmware from the new OS; a/ and b/ hold
#       each slot's kernel, device trees, overlays and cmdline.txt; slot A's
#       kernel files are also at the top level (used if os_prefix is ignored)
#   p2  slot A's root (ext4 with the old card's own features, so its 4.9
#       kernel can mount it)
#   p3  slot B's root
#
# Both slots start with one config.txt: the old card's, with the lines the
# new OS also needs.  "os_prefix=a/" at its end picks the slot; tryboot.txt
# is the same file with "os_prefix=b/".
#
# Slot B also gets the old card's Wi-Fi network (as a NetworkManager
# connection; the key is copied, never printed) and, if given, the
# controller's settings and programs (pull-controller-data.py makes the file).
#
# Needs root, sfdisk, losetup, mkfs.vfat, mkfs.ext4, rsync, xz.

set -e
OLD=$(realpath "$1"); NEW=$(realpath "$2"); OUT=$(realpath -m "$3")
DATA=${4:+$(realpath "$4")}
A_GiB=${A_GiB:-6}; B_GiB=${B_GiB:-8}
[ -e "$OLD" ] && [ -e "$NEW" ] || { echo "usage: $0 old.img new.img out.img [data.tar.gz]"; exit 1; }
for t in sfdisk losetup mkfs.vfat mkfs.ext4 rsync xz dumpe2fs; do
    command -v $t >/dev/null || { echo "missing: $t"; exit 1; }
done

W=$(dirname "$OUT")/ab-build
mkdir -p $W/{oldb,oldr,newb,newr,b,ra,rb}
LOOPS=()
cleanup() {
    set +e
    for m in ra rb b newr newb oldr oldb; do mountpoint -q $W/$m && umount $W/$m; done
    for l in "${LOOPS[@]}"; do losetup -d $l; done
}
trap cleanup EXIT
attach() { local l; l=$(losetup -fP --show "$@"); LOOPS+=($l); echo $l; }

echo "== Opening the two images (read-only)"
LO=$(attach -r "$OLD"); LN=$(attach -r "$NEW")
mount -o ro ${LO}p1 $W/oldb; mount -o ro,noload ${LO}p2 $W/oldr
mount -o ro ${LN}p1 $W/newb; mount -o ro,noload ${LN}p2 $W/newr
VER=$(cat $W/newr/etc/onefinity-os)
OLDVER=$(python3 -c "import json,sys;c=json.load(open(sys.argv[1]));print(c.get('version') or '')" \
         $W/oldr/var/lib/bbctrl/config.json 2>/dev/null || true)
osname() { sed -n 's/^PRETTY_NAME="\?\([^"]*\)"\?/\1/p' $1/etc/os-release; }
echo "slot A: $(osname $W/oldr), controller ${OLDVER:-?}"
echo "slot B: $(osname $W/newr), Onefinity OS $VER"

echo "== Partitions"
rm -f "$OUT"
S1=8192; N1=$((512 * 2048))
S2=$((S1 + N1)); N2=$((A_GiB * 1024 * 2048))
S3=$((S2 + N2)); N3=$((B_GiB * 1024 * 2048))
truncate -s $(( (S3 + N3) * 512 )) "$OUT"
sfdisk --quiet "$OUT" <<EOF
label: dos
start=$S1, size=$N1, type=c, bootable
start=$S2, size=$N2, type=83
start=$S3, size=$N3, type=83
EOF
sfdisk -d "$OUT"
L=$(attach "$OUT")
mkfs.vfat -F 32 -n BOOT ${L}p1 >/dev/null
# Slot A: the old card's ext4 features only (a newer mkfs adds ones Linux 4.9
# can't mount)
FEAT=$(dumpe2fs -h ${LO}p2 2>/dev/null | sed -n 's/^Filesystem features: *//p' |
       tr ' ' '\n' | grep -v -E '^(needs_recovery|)$' | paste -sd,)
echo "slot A ext4 features: $FEAT"
mkfs.ext4 -F -q -L rootA -O none,$FEAT ${L}p2
mkfs.ext4 -F -q -L rootB ${L}p3
mount ${L}p1 $W/b; mount ${L}p2 $W/ra; mount ${L}p3 $W/rb

echo "== Slot A: copying the old card's system"
rsync -aHAX --numeric-ids $W/oldr/ $W/ra/
cat $W/ra/etc/fstab | grep -v '^#'

echo "== Slot B: copying the Onefinity OS system"
rsync -aHAX --numeric-ids $W/newr/ $W/rb/
cat > $W/rb/etc/fstab <<'EOF'
proc            /proc           proc    defaults          0       0
/dev/mmcblk0p1  /boot/firmware  vfat    defaults          0       2
/dev/mmcblk0p3  /               ext4    defaults,noatime  0       1
EOF

echo "== Slot B: the old card's Wi-Fi network"
WL=$W/oldr/etc/network/interfaces.d/wlan0
if [ -e $WL ]; then
    python3 - "$WL" $W/rb/etc/NetworkManager/system-connections/onefinity-wifi.nmconnection <<'PY'
import sys, re, uuid, os
text = open(sys.argv[1]).read()
def val(key):
    m = re.search(r'^\s*' + key + r'\s+(.+?)\s*$', text, re.M)
    if not m: return None
    v = m.group(1)
    return v[1:-1] if len(v) > 1 and v[0] == v[-1] == '"' else v
ssid, psk = val('wpa-ssid'), val('wpa-psk')
if not ssid:
    print('no Wi-Fi network on the old card'); sys.exit(0)
sec = ('\n[wifi-security]\nkey-mgmt=wpa-psk\npsk=%s\n' % psk) if psk else ''
out = sys.argv[2]
os.makedirs(os.path.dirname(out), exist_ok = True)
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    f.write('[connection]\nid=onefinity-wifi\nuuid=%s\ntype=wifi\nautoconnect=true\n'
            '\n[wifi]\nmode=infrastructure\nssid=%s\n%s'
            '\n[ipv4]\nmethod=auto\n\n[ipv6]\nmethod=auto\n' % (uuid.uuid4(), ssid, sec))
print('Wi-Fi network "%s" (%s) added' % (ssid, 'with its key' if psk else 'open'))
PY
    ls -la $W/rb/etc/NetworkManager/system-connections/
else
    echo "the old card has no Wi-Fi settings"
fi

if [ -n "$DATA" ]; then
    echo "== Slot B: the controller's settings and programs"
    mkdir -p $W/rb/var/lib/bbctrl
    tar -xzf "$DATA" -C $W/rb/var/lib/bbctrl --no-same-owner
    echo "$(ls $W/rb/var/lib/bbctrl/upload 2>/dev/null | wc -l) programs; config.json from" \
        "$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('version'))" \
           $W/rb/var/lib/bbctrl/config.json)"
fi

echo "== Boot partition"
B=$W/b
# Boot firmware: the new OS's (it knows os_prefix and tryboot)
for f in $W/newb/bootcode.bin $W/newb/start*.elf $W/newb/fixup*.dat $W/newb/LICENCE.broadcom; do
    cp $f $B/
done
slot_files() {   # from to
    mkdir -p $2
    for f in $1/kernel*.img $1/*.dtb; do cp $f $2/; done
    cp -r $1/overlays $2/
}
# Slot A: the old card's kernel, device trees and overlays; also at the top
slot_files $W/oldb $B/a
slot_files $W/oldb $B
A_CMD="$(tr -s ' \n' ' ' < $W/oldb/cmdline.txt | sed 's/ *$//')"
A_CMD=$(echo "$A_CMD" | sed -E 's/(^| )root=[^ ]+/\1root=\/dev\/mmcblk0p2/')
echo "$A_CMD panic=10" > $B/a/cmdline.txt
cp $B/a/cmdline.txt $B/cmdline.txt
# Slot B: the new OS's 32-bit kernel (no initramfs: it would grow the root
# partition), device trees and overlays
mkdir -p $B/b
cp $W/newb/kernel7.img $W/newb/*.dtb $B/b/
cp -r $W/newb/overlays $B/b/
# config.txt names the old overlay; the new firmware maps it, and this copy
# makes sure
cp $B/b/overlays/disable-bt.dtbo $B/b/overlays/pi3-disable-bt.dtbo
echo "console=tty1 root=/dev/mmcblk0p3 rootfstype=ext4 fsck.repair=yes rootwait quiet cfg80211.ieee80211_regdom=US panic=10" > $B/b/cmdline.txt

NOW=$(date '+%Y-%m-%d %H:%M')
python3 - "$B" "$NOW" "$OLDVER" "$(osname $W/oldr)" "$VER" "$(osname $W/newr)" <<'PY'
import json, sys, os
b, now, oldver, oldos, ver, newos = sys.argv[1:]
json.dump({'label': 'Original card (%s)' % (oldver or 'old system'),
           'version': oldver, 'os': oldos, 'written': now, 'proven': True},
          open(os.path.join(b, 'a', 'slot.json'), 'w'))
json.dump({'label': 'Onefinity OS %s' % ver, 'version': ver, 'os': newos,
           'written': now, 'proven': False},
          open(os.path.join(b, 'b', 'slot.json'), 'w'))
PY

# config.txt: the old card's settings (without the SD clock overclock: this
# is a different card), plus what the new OS needs, then the slot
MARK='# --- A/B card (ab-card): the slot that starts normally ---'
{
    sed -e 's/^\(\s*dtparam=sd_overclock=.*\)$/# A\/B card (new card, default SD clock): \1/' \
        $W/oldb/config.txt | sed -e '$a\'
    cat <<'EOF'

# --- Onefinity OS (slot B) also needs; the same for slot A ---
# 32-bit kernel; the UART on; CTS from the motion board on GPIO 16 (slot A's
# rc.local also sets it)
arm_64bit=0
enable_uart=1
gpio=16=a3
EOF
} > $W/config-body.txt
printf '%s\n%s\n[all]\nos_prefix=a/\n' "$(cat $W/config-body.txt)" "$MARK" > $B/config.txt
printf '%s\n%s\n[all]\nos_prefix=b/\n' "$(cat $W/config-body.txt)" "$MARK" > $B/tryboot.txt
sync

echo "== Checks"
fail=0
chk() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
chk "boot firmware" "[ -s $B/bootcode.bin ] && [ -s $B/start.elf ] && [ -s $B/fixup.dat ]"
chk "slot A kernel + Pi 3 device tree" "[ -s $B/a/kernel7.img ] && [ -s $B/a/bcm2710-rpi-3-b.dtb ]"
chk "slot B kernel + Pi 3 device tree" "[ -s $B/b/kernel7.img ] && [ -s $B/b/bcm2710-rpi-3-b.dtb ]"
chk "slot A overlays (pi3-disable-bt, gpio-poweroff)" "[ -s $B/a/overlays/pi3-disable-bt.dtbo ] && [ -s $B/a/overlays/gpio-poweroff.dtbo ]"
chk "slot B overlays (pi3-disable-bt, gpio-poweroff)" "[ -s $B/b/overlays/pi3-disable-bt.dtbo ] && [ -s $B/b/overlays/gpio-poweroff.dtbo ]"
chk "slot A root=p2" "grep -q 'root=/dev/mmcblk0p2 ' $B/a/cmdline.txt"
chk "slot B root=p3" "grep -q 'root=/dev/mmcblk0p3 ' $B/b/cmdline.txt"
chk "config.txt -> a, tryboot.txt -> b" "[ \"\$(tail -1 $B/config.txt)\" = os_prefix=a/ ] && [ \"\$(tail -1 $B/tryboot.txt)\" = os_prefix=b/ ]"
chk "no KMS overlay (both slots use the firmware framebuffer)" "! grep -q '^dtoverlay=vc4' $B/config.txt"
chk "screen turned 180 and power-off line kept" "grep -q '^display_rotate=2' $B/config.txt && grep -q '^dtoverlay=gpio-poweroff,gpiopin=21' $B/config.txt"
chk "slot A: same number of files as the old card" "[ \$(find $W/oldr -xdev | wc -l) -eq \$(find $W/ra -xdev | wc -l) ]"
chk "slot A fstab: root on p2" "grep -qE '^/dev/mmcblk0p2 +/ ' $W/ra/etc/fstab"
chk "slot B fstab: root on p3" "grep -qE '^/dev/mmcblk0p3 +/ ' $W/rb/etc/fstab"
chk "slot B: tty1 login on" "[ -L $W/rb/etc/systemd/system/getty.target.wants/getty@tty1.service ]"
chk "slot B: trial check on" "[ -L $W/rb/etc/systemd/system/multi-user.target.wants/onefinity-trial-check.service ]"
chk "slot B: ab-card has trial-check" "grep -q trial-check $W/rb/usr/local/bin/ab-card || grep -rqs 'def cmd_trial_check' $W/rb/opt/bbctrl/venv/bin/ab-card"
chk "slot B: Wi-Fi connection private" "[ ! -e $W/rb/etc/NetworkManager/system-connections/onefinity-wifi.nmconnection ] || [ \$(stat -c %a $W/rb/etc/NetworkManager/system-connections/onefinity-wifi.nmconnection) = 600 ]"
chk "slot A: A/B tool present" "[ -e $W/ra/usr/local/bin/ab-card ]"
df -h $W/b $W/ra $W/rb
[ $fail = 0 ] || { echo "CHECKS FAILED"; exit 1; }

cleanup; trap - EXIT
echo "== Compressing"
rm -f "$OUT.xz"
xz -T0 -6 -k "$OUT"
( cd $(dirname "$OUT") && sha256sum $(basename "$OUT").xz > $(basename "$OUT").xz.sha256 )
ls -la "$OUT" "$OUT.xz"
cat "$OUT.xz.sha256"
echo AB-DONE
