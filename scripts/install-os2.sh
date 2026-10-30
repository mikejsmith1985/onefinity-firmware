#!/bin/bash
#
# Firmware install on the Onefinity OS image (1.50.0+): Raspberry Pi OS
# Trixie, built by scripts/os-image/build.sh.  scripts/install.sh hands over
# to this when /etc/onefinity-os exists; the 2017 Raspbian card keeps using
# install.sh as before.
#
# Differences from the old card:
#  - bbctrl lives in a Python venv (/opt/bbctrl/venv); Debian blocks pip on the
#    system Python.
#  - The motion planner (camotics/gplan.so) in a firmware package is built for
#    the old card's Python 3.5. The image carries one built for its own Python
#    (/usr/local/lib/onefinity/gplan-cpXY.so) and that one is used.
#  - The serial driver, X session, Wi-Fi and boot settings belong to the image
#    (systemd units in scripts/os-image), so none of that is edited here.

UPDATE_AVR=true
UPDATE_PY=true

while [ $# -gt 0 ]; do
    case "$1" in
        --no-avr) UPDATE_AVR=false ;;
        --no-py) UPDATE_PY=false ;;
    esac
    shift 1
done

VENV=/opt/bbctrl/venv
LIB=/usr/local/lib/onefinity

fail() { echo "Install failed: $*"; systemctl start bbctrl; exit 1; }

PYV=$($VENV/bin/python -c 'import sys; print("%d%d" % sys.version_info[:2])')
GPLAN=$LIB/gplan-cp$PYV.so
[ -e "$GPLAN" ] || fail "no motion planner built for Python $PYV ($GPLAN)"

if $UPDATE_PY; then systemctl stop bbctrl; fi

if $UPDATE_AVR; then
    python3 ./scripts/avr109-flash.py src/avr/bbctrl-avr-firmware.hex ||
        fail "flashing the motion board"
fi

if $UPDATE_PY; then
    cp "$GPLAN" src/py/camotics/gplan.so
    $VENV/bin/pip install --no-deps --no-build-isolation --no-index \
        --force-reinstall . || fail "installing bbctrl"

    # Commands the controller and its scripts call by name
    for f in $VENV/bin/*; do
        n=$(basename "$f")
        case "$n" in
            python*|pip*|activate*|Activate*|wheel*) continue ;;
        esac
        ln -sf "$f" /usr/local/bin/"$n"
    done

    cp scripts/bbctrl.service /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable bbctrl
fi

cp ./scripts/bbctrl-logrotate /etc/logrotate.d/bbctrl
chown root:root /etc/logrotate.d/bbctrl

sync
if $UPDATE_PY; then systemctl restart bbctrl; fi
echo "Install complete"
