#!/bin/bash
#
# Runs inside the Raspberry Pi OS image (under qemu) from build.sh.
# Installs and configures everything the controller needs.  $1 = firmware
# version being installed.

set -e
VER=$1
B=/root/onefinity-build
F=$B/files
INFO=$B/build-info.txt
export DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8
step() { echo; echo "== $*"; echo "== $*" >> $INFO; }

# Network names for apt inside the chroot
if [ -e /etc/resolv.conf -o -L /etc/resolv.conf ]; then
    mv /etc/resolv.conf /etc/resolv.conf.orig
fi
cp /etc/resolv.conf.build /etc/resolv.conf
# No services start while building
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
chmod +x /usr/sbin/policy-rc.d

KVER=$(ls /lib/modules | grep -- '-rpi-v7$' | sort -V | tail -1)
echo "Onefinity OS $VER, built $(date -u '+%Y-%m-%d %H:%M UTC')" > $INFO
echo "Base: $(. /etc/os-release; echo $PRETTY_NAME), kernel $KVER" >> $INFO

step "Packages"
apt-get update -q
apt-get install -y -q --no-install-recommends \
    xserver-xorg-core xserver-xorg-input-libinput xserver-xorg-video-fbdev \
    xserver-xorg-legacy \
    xinit x11-xserver-utils \
    ratpoison chromium rpi-chromium-mods fonts-dejavu-core \
    python3-venv python3-setuptools python3-tornado python3-serial \
    python3-pyudev python3-smbus2 python3-watchdog python3-rpi-lgpio \
    libpython3.13 wireless-tools i2c-tools avahi-daemon logrotate \
    openssh-server
# Build-only packages, removed at the end
# (No libevent/re2: with libevent present the 2021 build also wants re2's
# headers, which its configure check can't compile; gplan uses neither)
# (The kernel headers stay: the image ships with them, and bbserial can be
# rebuilt on the controller with them)
BUILD_PKGS="build-essential scons git python3-dev zlib1g-dev libbz2-dev
  libexpat1-dev libsqlite3-dev libyaml-dev liblz4-dev"
apt-get install -y -q --no-install-recommends $BUILD_PKGS linux-headers-$KVER

step "Users: pi (screen), bbmc (owner of the controller's files, uid 1001)"
usermod -s /bin/bash pi
for g in netdev video dialout i2c gpio; do groupadd -f $g; done
id bbmc >/dev/null 2>&1 || useradd -m -u 1001 -s /bin/bash -G netdev,video,dialout,i2c,gpio bbmc
# No password is built into the image (the build script is public).  The
# account stays locked unless onefinity-password.txt is put on the boot
# partition; onefinity-import sets it on the next start and deletes the file.
passwd -l bbmc >/dev/null
passwd -l pi >/dev/null
for g in video input render tty dialout; do usermod -aG $g pi 2>/dev/null || true; done
systemctl disable userconfig.service 2>/dev/null || true
systemctl mask userconfig.service 2>/dev/null || true
# cloud-init would set up a user and network from the boot partition; the
# image is already set up
touch /etc/cloud/cloud-init.disabled
rm -f /boot/firmware/user-data /boot/firmware/meta-data /boot/firmware/network-config
ssh-keygen -A >/dev/null
systemctl enable ssh

step "Host name, time zone, keyboard"
echo onefinitycnc > /etc/hostname
sed -i 's/^127\.0\.1\.1.*/127.0.1.1\tonefinitycnc/' /etc/hosts
grep -q onefinitycnc /etc/hosts || echo -e "127.0.1.1\tonefinitycnc" >> /etc/hosts
ln -sf /usr/share/zoneinfo/America/New_York /etc/localtime
echo America/New_York > /etc/timezone
sed -i 's/^XKBLAYOUT=.*/XKBLAYOUT="us"/' /etc/default/keyboard 2>/dev/null || true

step "Boot settings: serial port for the motion board, I2C, no serial console"
# config.txt: the 2017 card's hardware settings (legacy framebuffer turned
# 180°, HDMI boost, power-off line on GPIO 21) instead of Raspberry Pi OS's
# defaults (KMS, camera/display auto-detect), plus the new OS's needs
CFG=/boot/firmware/config.txt
cp $F/config-onefinity.txt $CFG
cat >> $CFG <<'EOT'

# First start of a single-system card: the initramfs grows the root file
# system to fill the card ("resize" in cmdline.txt, removed once done)
auto_initramfs=1
EOT
CMD=/boot/firmware/cmdline.txt
sed -i 's/console=serial0,[0-9]* \?//; s/console=ttyAMA0,[0-9]* \?//' $CMD
grep -q ' quiet' $CMD || sed -i 's/$/ quiet/' $CMD
# Wi-Fi country (Raspberry Pi OS blocks Wi-Fi until one is set)
grep -q ieee80211_regdom $CMD || sed -i 's/$/ cfg80211.ieee80211_regdom=US/' $CMD
cat $CMD >> $INFO
systemctl mask serial-getty@ttyAMA0.service serial-getty@serial0.service \
    hciuart.service bluetooth.service 2>/dev/null || true
echo i2c-dev > /etc/modules-load.d/onefinity.conf

step "Motion planner (CAMotics gplan) for Python $(python3 -c 'import sys;print(sys.version.split()[0])')"
PYV=$(python3 -c 'import sys; print("%d%d" % sys.version_info[:2])')
mkdir -p /usr/local/lib/onefinity
if [ -e $B/gplan-cache/gplan-cp$PYV.so ]; then
    # Built by an earlier run of build.sh from the same pinned sources
    echo "Using the planner from an earlier build" | tee -a $INFO
    cp $B/gplan-cache/gplan-cp$PYV.so /usr/local/lib/onefinity/
    sha256sum /usr/local/lib/onefinity/gplan-cp$PYV.so >> $INFO
    mkdir -p /root/gplan-test/camotics
    cp $B/gplan-cache/gplan-cp$PYV.so /root/gplan-test/camotics/gplan.so
    touch /root/gplan-test/camotics/__init__.py
else
GP=/root/gplan-build
rm -rf $GP; mkdir -p $GP; cd $GP
fetch() {   # repo commit
    mkdir $1; git -C $1 init -q
    git -C $1 remote add origin https://github.com/CauldronDevelopmentLLC/$1
    git -C $1 fetch -q --depth 1 origin $2
    git -C $1 reset -q --hard FETCH_HEAD
}
# The same commits scripts/gplan-init-build.sh pins for the 2017 build
fetch cbang 18f1e963107ef26abe750c023355a5c40dd07853
fetch camotics ec876c80d20fc19837133087cef0c447df5a939d
NJ=$(nproc)
# OpenSSL off: its 2021 code doesn't build with OpenSSL 3, and gplan never uses it
scons -j$NJ -C cbang disable_local="re2 libevent" with_openssl=0 >$GP/cbang.log 2>&1 ||
    { tail -40 $GP/cbang.log; exit 1; }
export CBANG_HOME=$GP/cbang
P=camotics/src/gcode/plan
# The same edits scripts/gplan-build.sh makes
for v in maxVel maxJerk maxAccel; do
    perl -i -0pe "s/(fabs\((config\.$v\[axis\]) \/ unit\[axis\]\));/std::min(\2, \1);/gm" \
        $P/LineCommand.cpp $P/LinePlanner.cpp
done
git -C camotics diff --stat >> $INFO
mkdir -p camotics/build; touch camotics/build/version.txt
scons -j$NJ -C camotics gplan.so with_gui=0 with_tpl=0 >$GP/gplan.log 2>&1 ||
    { tail -40 $GP/gplan.log; exit 1; }
mkdir -p /usr/local/lib/onefinity
cp camotics/gplan.so /usr/local/lib/onefinity/gplan-cp$PYV.so
sha256sum /usr/local/lib/onefinity/gplan-cp$PYV.so >> $INFO
mkdir -p /root/gplan-test/camotics
cp camotics/gplan.so /root/gplan-test/camotics/; touch /root/gplan-test/camotics/__init__.py
cd /; rm -rf $GP
fi

step "Serial driver bbserial for kernel $KVER"
BS=/root/bbserial-build
rm -rf $BS; mkdir -p $BS
tar -xjf $B/firmware.tar.bz2 -C $BS --wildcards '*/src/bbserial/bbserial.c' '*/src/bbserial/Kbuild'
cd $BS/*/src/bbserial
SERIAL=stock
if make -C /lib/modules/$KVER/build M=$PWD modules > $BS/make.log 2>&1; then
    install -D -m 644 bbserial.ko /lib/modules/$KVER/extra/bbserial.ko
    depmod $KVER
    SERIAL=bbserial
    echo "bbserial built: $(modinfo -F vermagic bbserial.ko)" >> $INFO
else
    echo "bbserial did NOT build; the standard driver is used" | tee -a $INFO
    grep -E "error|bbserial.c:[0-9]+" $BS/make.log | head -20 | tee -a $INFO
fi
cd /; rm -rf $BS
echo $SERIAL > /etc/onefinity-serial

step "Controller firmware $VER"
mkdir -p /etc
echo "$VER" > /etc/onefinity-os
python3 -m venv --system-site-packages /opt/bbctrl/venv
/opt/bbctrl/venv/bin/pip install -q --no-cache-dir sockjs-tornado==1.0.7
mkdir -p /var/lib/bbctrl /tmp/fw
tar -xjf $B/firmware.tar.bz2 -C /tmp/fw
cd /tmp/fw/*/
./scripts/install.sh --no-avr
cd /; rm -rf /tmp/fw
/usr/local/bin/bbctrl --help >/dev/null
/opt/bbctrl/venv/bin/python -c "import bbctrl, camotics.gplan; print('bbctrl', bbctrl.get_version(), 'imports with its planner')" | tee -a $INFO

step "Services: serial, settings import, kiosk, USB drives"
install -m 755 $F/onefinity-serial /usr/local/sbin/onefinity-serial
install -m 755 $F/onefinity-import /usr/local/sbin/onefinity-import
install -m 644 $F/onefinity-serial.service $F/onefinity-import.service /etc/systemd/system/
systemctl enable onefinity-serial.service onefinity-import.service
mkdir -p /etc/systemd/system/bbctrl.service.d
install -m 644 $F/bbctrl-after.conf /etc/systemd/system/bbctrl.service.d/onefinity-os.conf
install -m 644 $F/11-automount.rules /etc/udev/rules.d/11-automount.rules
# Screen: pi logs in on the console by itself and starts X with Chromium
mkdir -p /etc/systemd/system/getty@tty1.service.d
install -m 644 $F/autologin.conf /etc/systemd/system/getty@tty1.service.d/autologin.conf
install -m 755 -o 1000 -g 1000 $F/xinitrc /home/pi/.xinitrc
install -m 644 -o 1000 -g 1000 $F/bash_profile /home/pi/.bash_profile
install -m 644 -o 1000 -g 1000 /dev/null /home/pi/.hushlogin
install -m 644 $F/xorg-onefinity.conf /etc/X11/xorg.conf.d/10-onefinity.conf 2>/dev/null ||
    { mkdir -p /etc/X11/xorg.conf.d; install -m 644 $F/xorg-onefinity.conf /etc/X11/xorg.conf.d/10-onefinity.conf; }
# Raspberry Pi OS ships the console login on tty1 switched off; its first
# start wizard (userconfig, masked above) is what switches it on.  Without
# it there is no autologin, so no X and no screen app (found on the machine
# Oct 30 with the 1.50.0 image)
systemctl enable getty@tty1.service
# X on the firmware framebuffer isn't a KMS driver, so it runs with root
# rights through the Xorg wrapper (as the 2017 card's X did)
printf 'allowed_users=console\nneeds_root_rights=yes\n' > /etc/X11/Xwrapper.config
[ -e /etc/systemd/system/getty.target.wants/getty@tty1.service ] ||
    { echo "getty@tty1 not enabled"; exit 1; }
step "Logs kept across restarts, hardware watchdog, A/B trial check"
mkdir -p /etc/systemd/journald.conf.d /etc/systemd/system.conf.d /var/log/journal
install -m 644 $F/journald-onefinity.conf /etc/systemd/journald.conf.d/99-onefinity.conf
install -m 644 $F/watchdog-onefinity.conf /etc/systemd/system.conf.d/99-onefinity-watchdog.conf
install -m 644 $F/onefinity-trial-check.service /etc/systemd/system/
systemctl enable onefinity-trial-check.service
systemctl set-default multi-user.target
# The OS never changes under the machine: no automatic updates (a new kernel
# would also leave bbserial behind)
systemctl disable apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
systemctl mask apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
apt-mark hold linux-image-rpi-v7 linux-image-$KVER linux-headers-rpi-v7 \
    linux-image-rpi-v6 linux-image-rpi-v8 raspi-firmware >/dev/null 2>&1 || true
rm -f /etc/rc.local

step "Planner self-check (new build, inside the image)"
cd /root/gplan-test
printf 'G21 G90\nG0 X10 Y10 Z5\nG38.2 Z-20 F100\nG0 Z5\nG2 X20 Y10 I5 J0 F800\nG1 X30 Y30\nM2\n' > t.nc
echo '{"motors":[{"axis":"X"},{"axis":"Y"},{"axis":"Z"}]}' > c.json
PYTHONPATH=. /opt/bbctrl/venv/bin/python $B/plan_dump.py c.json t.jsonl t.nc 2>&1 | tee -a $INFO
cd /; rm -rf /root/gplan-test

step "Removing build-only packages"
apt-mark manual libpython3.13 libbz2-1.0 >/dev/null
apt-get purge -y -q $BUILD_PKGS >/dev/null
apt-get autoremove -y -q --purge >/dev/null
apt-get clean
rm -rf /var/lib/apt/lists/*

dpkg -l | awk '/^ii/ {print $2, $3}' > $B/packages.txt
grep -E "^(chromium|python3-tornado|python3 |xserver-xorg-core|linux-image-$KVER) " $B/packages.txt >> $INFO

rm -f /usr/sbin/policy-rc.d /etc/resolv.conf
[ -e /etc/resolv.conf.orig -o -L /etc/resolv.conf.orig ] && mv /etc/resolv.conf.orig /etc/resolv.conf
echo; cat $INFO
echo CHROOT-OK
