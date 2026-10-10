# Onefinity Firmware (Mike Smith's fork)

A fork of the [Onefinity CNC controller firmware](https://github.com/OneFinityCNC/onefinity-firmware) (itself based on Buildbotics `bbctrl`) with extra features for day-to-day machining. It runs on the Raspberry Pi inside the Onefinity controller and is installed from the controller's own web interface.

## What this fork adds

| Feature | Since | What it does |
|---|---|---|
| Corner, center and center-X probing | 1.6.7 | The probe dialog finds a stock corner, the center of a piece, or the center in X only. It remembers the measured stock size. |
| Depth view | 1.7.0 | Simulates cut depth under the tool path, with a play slider. It also works on controllers without WebGL. |
| Mist off on pause | 1.7.0 | Mist turns off while a job is paused and comes back on resume. |
| New UI at `/next` | 1.8.0 | A React interface where every page is a tab across the top: Control, Macros, Settings, Motors, Tool, I/O, Admin, Cheat sheet, Help. |
| VFD register editor | 1.11.0 | The Tool tab shows the active Modbus program, lets you customize or clear it for a custom VFD, and shows the front-panel setup notes for each supported VFD. |
| Hold-to-jog | 1.11.0 | Choose Step or Hold in the jog pad. In Hold mode the machine moves while you hold a key, at 1 to 100% of max speed. The controller stops the jog by itself if the page stops sending updates. |
| Run checklist | 1.11.0 | Pressing Run shows homing, fit, work zero and spindle drive status first. Can be turned off per device. |
| Connection drop log | 1.11.0 | Admin shows each time the page lost its link to the controller, with how long and why. |
| Plain-language errors | 1.12.0 | E-stop and error messages come with what happened and what to do next. Messages the controller sends that aren't recognized are shown unchanged. |
| Remembered Depth view settings | 1.12.0 | Tool diameter, shape and stock top are remembered per program file. |
| Tool-change helper | 1.13.0 | The Job panel shows the next tool change in the program (tool, line, and which of how many). When a tool-change message stops the job, the pop-up says which tool to install. |
| Run history, file notes, camera snapshot | 1.14.0 | A History tab lists each run with time and result (finished, stopped or E-stop). A Notes tab keeps a note per program, with its first line shown in the Job panel. The Camera tab can save a snapshot to your PC. In 1.15.0 history and notes are saved on the controller, so every device and browser sees the same ones. |
| UI toggle | 1.10.0 | "Try the new UI" button in the classic menu and "Classic UI" in the new tab bar. |

The classic UI at `/` is unchanged and always available as a fallback. The new UI is at `http://<controller-address>/next/`.

## Download the latest firmware to your PC

Firmware packages are single files named `onefinity-X.Y.Z.tar.bz2` (a fix to a release adds `-pN`, for example `onefinity-1.6.7-p10.tar.bz2`).

1. On your PC, open the [Releases page](https://github.com/mikejsmith1985/onefinity-firmware/releases).
2. Open the newest release (the top one, not marked pre-release).
3. Under **Assets**, click the `onefinity-X.Y.Z.tar.bz2` file to download it.
   - Do **not** use "Source code (zip)" or "Source code (tar.gz)". Those are the source files, not an installable package.
   - Do **not** extract the `.tar.bz2`. The controller installs it as is.
4. Keep the file somewhere easy to find, such as your Downloads folder.

Command-line alternative, if you use the GitHub CLI:

    gh release download --repo mikejsmith1985/onefinity-firmware --pattern "onefinity-*.tar.bz2"

Optional check that the download is intact (a damaged file prints an error):

    tar tjf onefinity-X.Y.Z.tar.bz2 > /dev/null

## Install it on the controller

1. Connect your PC to the same network as the controller and open its address in a browser (the IP address is shown on the controller's screen and in the Admin tab).
2. Make sure the machine is idle and nothing is running.
3. Go to **Admin → General → Firmware** (classic UI: **Admin → General**) and choose **Upgrade from file**.
4. Select the `onefinity-X.Y.Z.tar.bz2` you downloaded and confirm.
5. Wait for the upgrade to finish. It should take under 5 minutes. If it takes longer, restart the controller and try again, or install from a USB stick.
6. Reload the page. The version shown in the tab bar should match the file you installed.

Your settings and macros are kept. You can still back them up first from **Admin → General → Configuration → Back up**.

To go back to an older version, install that version's package the same way.

## Release status

Release packages are published on the Releases page above. If a version you expect isn't there, it hasn't been published yet.

## Build from source

Development is supported on Debian Linux only. See [docs/development.md](docs/development.md) for the full setup. In short:

    git clone https://github.com/mikejsmith1985/onefinity-firmware
    cd onefinity-firmware
    make pkg          # writes dist/onefinity-<version>.tar.bz2

The new UI lives in `src/react-ui/`:

    cd src/react-ui
    npm install
    npm run build     # writes to src/resources/next/
    npm run mock      # fake controller on :8080 that also serves /next/

Version numbers are set in `package.json` and `src/py/bbctrl/Config.py`. A new feature is a version bump (1.9.0 to 1.10.0). A fix is a `-pN` suffix.

## Known limitations of the new UI

- Hold-to-jog has not been tested on a real machine. Test it at 1% first with the tool well above the work.
- The old 3D path viewer is replaced by the Depth view and a 2D tool-path view.
- The VFD register editor has not been tried against a real VFD.
- Camera and probing in the new UI have not been tested on real hardware.

## Camera

Any USB UVC webcam that outputs MJPEG works, from `/dev/video0`. The default is 640×480 at 15 fps. Change it with the `--width`, `--height` and `--fps` flags when `bbctrl` starts (see `scripts/bbctrl.service`).

## Credits and licence

Based on the Buildbotics controller firmware and the Onefinity fork of it. See [LICENSE](LICENSE) and [CHANGELOG.md](CHANGELOG.md).
