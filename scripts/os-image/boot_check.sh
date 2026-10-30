#!/bin/bash
#
# Boots a copy of the built image's system in a container (systemd-nspawn,
# ARM code under qemu) and reports which services started and whether the
# controller's web server answers.  No Raspberry Pi hardware is there, so the
# motion board, screen, camera and Wi-Fi are expected to be missing; this is
# about systemd units, Python and the web server.
#
#   boot_check.sh <onefinity-os-X.img> <report file>

set -e
IMG=$(realpath "$1"); REPORT=$(realpath -m "$2")
WORK=$(dirname "$IMG")/bootcheck
rm -rf "$WORK"; mkdir -p "$WORK/root"
cp --sparse=always "$IMG" "$WORK/test.img"
L=$(losetup -fP --show "$WORK/test.img")
cleanup() { set +e; umount -R "$WORK/root" 2>/dev/null; losetup -d $L; }
trap cleanup EXIT
mount ${L}p2 "$WORK/root"
mount ${L}p1 "$WORK/root/boot/firmware"
R=$WORK/root

cat > $R/etc/systemd/system/onefinity-bootcheck.service <<'EOF'
[Unit]
Description=Boot check (test copy only)
After=bbctrl.service multi-user.target

[Service]
Type=oneshot
ExecStart=/bin/bash /root/bootcheck.sh

[Install]
WantedBy=multi-user.target
EOF
cat > $R/root/bootcheck.sh <<'EOF'
#!/bin/bash
sleep 120          # everything is slow under qemu
O=/root/bootcheck.txt
{
  echo "== failed units"; systemctl --failed --no-legend
  echo "== bbctrl"; systemctl is-active bbctrl
  # The screen needs the tty1 login (autologin starts X); Raspberry Pi OS
  # ships it off.  No screen here, so only whether it's switched on
  echo "== tty1 login (must be enabled)"; systemctl is-enabled getty@tty1
  echo "== A/B trial check"; systemctl is-enabled onefinity-trial-check
  echo "== journal kept"; systemd-analyze cat-config systemd/journald.conf | grep -i '^Storage'
  echo "== web"
  /opt/bbctrl/venv/bin/python - <<'PY'
import urllib.request, json
try:
    c = json.load(urllib.request.urlopen('http://127.0.0.1/api/config/load', timeout=60))
    print('config/load OK, version', c.get('full_version'))
    h = urllib.request.urlopen('http://127.0.0.1/', timeout=60).read()
    print('screen page OK,', len(h), 'bytes')
    n = urllib.request.urlopen('http://127.0.0.1/api/network', timeout=60).read()
    print('network:', n[:200])
except Exception as e: print('web FAILED', e)
PY
  echo "== bbctrl log"; tail -40 /var/log/bbctrl.log
  echo "== journal (bbctrl, onefinity-*)"; journalctl -b -u bbctrl -u onefinity-serial -u onefinity-import --no-pager | tail -40
  echo "== kiosk (expected to fail without a screen)"; systemctl status getty@tty1 --no-pager | head -5
} > $O 2>&1
systemctl poweroff
EOF
ln -sf /etc/systemd/system/onefinity-bootcheck.service \
    $R/etc/systemd/system/multi-user.target.wants/onefinity-bootcheck.service
umount "$R/boot/firmware"

timeout 1200 systemd-nspawn -q -D "$R" --boot --console=pipe \
    --bind-ro=/dev/null:/dev/ttyAMA0 > "$WORK/console.txt" 2>&1 || true
cp "$R/root/bootcheck.txt" "$REPORT" 2>/dev/null || echo "no report (see $WORK/console.txt)" > "$REPORT"
tail -20 "$WORK/console.txt" >> "$REPORT"
cat "$REPORT"
