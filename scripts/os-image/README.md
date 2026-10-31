# Onefinity OS image (1.51.0)

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
| Screen | pi auto-logs in on tty1 (enabled by the build: Raspberry Pi OS ships it off), X on the firmware framebuffer (fbdev, as on the 2017 card: `display_rotate=2`, 1280×720, no KMS) + ratpoison + Chromium kiosk on http://localhost/, 750 MB memory cap; X output in `~pi/xsession.log` |
| config.txt | The 2017 card's hardware settings (`files/config-onefinity.txt`): rotation, HDMI boost, `gpio-poweroff` on GPIO 21, `pi3-disable-bt`, plus `arm_64bit=0`, `enable_uart=1`, `gpio=16=a3` |
| Logs | Journal kept across restarts (`/var/log/journal`, 64 MB) |
| Watchdog | systemd drives the Pi's hardware watchdog (10 s) |
| Network | NetworkManager; `config-wifi` hands over to `config-wifi-nm` |
| Settings from the old card | `onefinity-data.tar.gz` on the boot partition is imported on first boot (`pull-controller-data.py` makes it from a running controller) |
| Login | bbmc (uid 1001) has no password; put `onefinity-password.txt` (one line) on the boot partition to set one at the next start (the file is deleted). SSH is on, so without a password there is no SSH login |
| Updates | apt timers off, kernel held (bbserial is built for this kernel) |

## A/B card (1.51.0): the old system and this one on one card

    build-ab.sh <old card .img> <onefinity-os-X.img> <out .img> [onefinity-data.tar.gz]

Slot A is the original card copied file for file (the normal slot); slot B is
this image, with the old card's Wi-Fi network (as a NetworkManager connection,
key copied, not printed) and the controller's data.  The layout is the one
`ab-card make` makes, so Admin > SD card works from either slot.  Both slots
start with the old card's config.txt plus the three lines the new OS needs.

Trying slot B is one-shot (the firmware's tryboot flag).  It goes back to A
when the kernel panics (`panic=10`), the system hangs (hardware watchdog), the
power is cycled, or `ab-card trial-check` finds the web server, X or the
browser not up within 7 minutes.  Keep makes B the normal slot.

## Checks

- `plan_check.sh`: the 2017 planner (Python 3.5, in Raspbian Stretch) and the
  new one on the same programs; every command must match.
- `boot_check.sh`: boots a copy of the image's system in a container and
  checks the services and web server, and that the tty1 login, the trial
  check and the persistent journal are switched on.
- `src/py/tests/test_ab_trial.py`: the trial check's decisions;
  `src/py/tests/test_ab_card.py`: the A/B tool on loop devices.
- build-ab.sh checks its own result (boot files per slot, root partitions,
  config.txt/tryboot.txt, slot A file for file).

## OS file for the A/B card (1.51.1): a new slot B over the network

    build-bundle.sh <onefinity-os-X.img> <out.tar> [old card .img]

Makes the file `ab-card write` takes (plain tar: ab-bundle.json, boot/,
root/), so the running slot writes a new system into the other slot without
the card coming out (Admin > SD card, or `PUT /api/abcard/upload?sha256=...`
with the file as the body).  With the old card's image it adds that card's
Wi-Fi network, so the file holds the Wi-Fi key: keep it on the PC.

Found on the machine Oct 31 (fixed in 1.51.1): Raspberry Pi OS also ships
NetworkManager's Wi-Fi switched off (`WirelessEnabled=false`) until its wizard
sets a country, and the touch must be turned with the screen
(`TransformationMatrix "-1 0 1 0 -1 1 0 0 1"` in 40-libinput.conf, as the 2017
card and the screen-rotation setting have it).  trial-check also needs a
network address, and records diagnostics in ab-trial.json, which the normal
slot shows (`trial_ended` in `/api/abcard`).

## Patch files and USB sticks (1.52.0)

    build-patch.sh <out.tar.gz> <label> <dir> [version] [os_match]

A patch file holds only the files that change (`<dir>/root/...` at their place
in the system, `<dir>/boot/...` for the slot's boot files). `ab-card patch`
writes them over the other slot; nothing is erased, existing folders keep
their owners and modes, and the slot has to be tried again before it can be
kept. `os_match` (e.g. `trixie`) keeps a patch for the new OS off the 2017
system.

Admin > SD card: **Load a patch into slot X** (upload), or **Look on the USB
stick**: the tool mounts the stick itself, read-only (the 2017 system's udev
mounts sticks where other programs can't see them), and lists OS files and
patch files in its top folder, to write or patch the other slot straight from
the stick. API: `GET /api/abcard/usb`; `PUT /api/abcard` with
`{"action": "write_file"|"patch_file", "path": ...}`; uploads take
`?kind=patch`; `fetch` takes `"kind": "patch"`.

An upload cut off part way no longer leaves the card "being written" until a
restart: an upload quiet for two minutes stops counting.
