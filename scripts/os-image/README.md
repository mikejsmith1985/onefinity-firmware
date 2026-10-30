# Onefinity OS image (1.50.0)

Raspberry Pi OS Lite 32-bit (Trixie, Debian 13, kernel 6.18) for the Gen 1
controller's Raspberry Pi 3B, with the controller firmware, the motion planner
and serial driver built for it, and the touchscreen kiosk.

## Build (as root on x86 Linux or WSL, with qemu-user-static)

    build.sh <work dir> <onefinity-1.50.0.tar.bz2> [onefinity-data.tar.gz]

The work dir needs `2026-10-06-raspios-trixie-armhf-lite.img.xz` from
downloads.raspberrypi.com.  Output: `onefinity-os-<ver>.img.xz` + `.sha256`
and `build-info-<ver>.txt` (what was built, checksums).

What's in it, besides Raspberry Pi OS Lite:

| Part | How |
|---|---|
| Controller (bbctrl) | `/opt/bbctrl/venv`, Python 3.13, Debian's Tornado 6.4; firmware installs use `scripts/install-os2.sh` |
| Motion planner | CAMotics gplan rebuilt from the same pinned commits as the 2017 build (cbang 18f1e963, camotics ec876c80), OpenSSL/libevent off; `/usr/local/lib/onefinity/gplan-cp313.so` |
| Serial to the motion board | `bbserial` (Buildbotics' driver, ported to Linux 6.x) on `/dev/ttyAMA0`; `/etc/onefinity-serial` = `bbserial` or `stock` (Linux's own PL011 driver) |
| UART pins | `dtoverlay=disable-bt`, `gpio=16=a3` (CTS) in config.txt; no serial console |
| Screen | pi auto-logs in on tty1, X + ratpoison + Chromium kiosk on http://localhost/, 750 MB memory cap |
| Network | NetworkManager; `config-wifi` hands over to `config-wifi-nm` |
| Settings from the old card | `onefinity-data.tar.gz` on the boot partition is imported on first boot (`pull-controller-data.py` makes it from a running controller) |
| Login | bbmc (uid 1001) has no password; put `onefinity-password.txt` (one line) on the boot partition to set one at the next start (the file is deleted). SSH is on, so without a password there is no SSH login |
| Updates | apt timers off, kernel held (bbserial is built for this kernel) |

## Checks

- `plan_check.sh`: the 2017 planner (Python 3.5, in Raspbian Stretch) and the
  new one on the same programs; every command must match.
- `boot_check.sh`: boots a copy of the image's system in a container and
  checks the services and web server.
