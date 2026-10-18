// The 1.28.1 probe programs, verbatim (ProbeDialog.jsx at e4dd881, lines 51-190), so probe-sim.py can
// check that 1.29.0 measures and sets zero exactly the same way. Only `send` is replaced: it returns the text.
// One probe sequence for every corner (shared by both center placements).
function cornerProbeSequence(o) {
  const keep = (name, param) => (o.remember ? `#<_ofprobe_${name}> = ${param}` : "");
  return `
                G38.2 Z -25 F${o.fastSeek}
                G91 G1 Z 1
                G38.2 Z -2 F${o.slowSeek}
                ${keep("zt", "#5063")}
                ${keep("ok", "-1")}
                ${o.afterZ}

                G91 G0 Z ${o.zLift}
                G91 G0 X ${20 * o.sx}
                G91 G0 Z ${-o.plunge}
                G38.2 X ${-20 * o.sx} F${o.fastSeek}
                G91 G1 X ${1 * o.sx}
                G38.2 X ${-2 * o.sx} F${o.slowSeek}
                ${keep("xa", "#5061")}
                ${o.afterX}

${o.probeY === false ? `
                G91 G0 X ${1 * o.sx}
` : `                G91 G0 X ${1 * o.sx}
                G91 G0 Y ${20 * o.sy}
                G91 G0 X ${-20 * o.sx}
                G38.2 Y ${-20 * o.sy} F${o.fastSeek}
                G91 G1 Y ${1 * o.sy}
                G38.2 Y ${-2 * o.sy} F${o.slowSeek}
                ${keep("ya", "#5062")}
                ${o.afterY}

                G91 G0 Y ${3 * o.sy}
`}                G91 G0 Z 25
`;
}

function executeProbe({ config, rotary, type, loc, dia: d, send }) {
    const cfg = rotary ? config["probe-rotary"] : config.probe;
    const w = cfg["probe-xdim"], l = cfg["probe-ydim"], zOffset = cfg["probe-zdim"], slow = cfg["probe-slow-seek"], fast = cfg["probe-fast-seek"];
    const cutterLength = 12.7, zLift = 1, cd = d.mm;
    const xOffset = w + cd / 2, yOffset = l + cd / 2;
    const S = send;
    if (type === "z") {
      S(`
                G21
                G92 Z0

                G38.2 Z -25.4 F${fast}
                G91 G1 Z 1
                G38.2 Z -2 F${slow}
                G92 Z ${zOffset}

                G91 G0 Z 25

                M2
            `);
      return;
    }
    const plunge = Math.min(cutterLength, zOffset * 0.9) + zLift;
    if (rotary) {
      S(`
                  G21
                  G92 X0 Y0 Z0

                  G38.2 Z -25 F${fast}
                  G91 G1 Z 1
                  G38.2 Z -2 F${slow}
                  G92 Z ${zOffset}

                  G91 G0 Z ${zLift}
                  G91 G0 X 20
                  G91 G0 Z ${-plunge}
                  G38.2 X -20 F${fast}
                  G91 G1 X 1
                  G38.2 X -2 F${slow}
                  G92 X ${xOffset}

                  G91 G0 X 1
                  G91 G0 Y 20
                  G91 G0 X -20
                  G38.2 Y -20 F${fast}
                  G91 G1 Y 1
                  G38.2 Y -2 F${slow}
                  G92 Y ${yOffset}

                  G91 G0 Y 3
                  G91 G0 Z 25

                  M2
              `);
      return;
    }
    const sx = loc === "front-right" || loc === "back-right" ? -1 : 1;
    const sy = loc === "back-left" || loc === "back-right" ? -1 : 1;
    const rotated90 = loc === "front-right" || loc === "back-left";
    const xOff = rotated90 ? yOffset : xOffset, yOff = rotated90 ? xOffset : yOffset;
    const keepY = loc === "center-x";
    S(`
                G21
                ${keepY ? "G92 X0 Z0" : "G92 X0 Y0 Z0"}
${cornerProbeSequence({ sx, sy, plunge, zLift, fastSeek: fast, slowSeek: slow, afterZ: `G92 Z ${zOffset}`, afterX: `G92 X ${sx * xOff}`, afterY: `G92 Y ${sy * yOff}`, remember: loc === "center" || keepY, probeY: !keepY })}
                M2
            `);
  }

  // Second placement for center probing: mirror of the first, then take the midpoints.
function executeCenterSecondProbe({ config, loc, dia: d, send }) {
    const cfg = config.probe;
    const h = cfg["probe-zdim"], slow = cfg["probe-slow-seek"], fast = cfg["probe-fast-seek"];
    const zLift = 1, plunge = Math.min(12.7, h * 0.9) + zLift, r = d.mm / 2;
    const keepY = loc === "center-x";
    const leftDim = cfg["probe-xdim"], rightDim = keepY ? cfg["probe-ydim"] : cfg["probe-xdim"], frontDim = cfg["probe-ydim"], backDim = cfg["probe-ydim"];
    const halfX = `[[#5061 - #<_ofprobe_xa> + ${leftDim} + ${rightDim}] / 2 + ${r}]`;
    const halfY = `[[#5062 - #<_ofprobe_ya> + ${frontDim} + ${backDim}] / 2 + ${r}]`;
    const rest = cornerProbeSequence({
      sx: -1, sy: -1, plunge, zLift, fastSeek: fast, slowSeek: slow, afterZ: "",
      afterX: `#<_ofprobe_hx> = ${halfX}
                G92 X [[#5061 - #<_ofprobe_xa> + ${leftDim} - ${rightDim}] / 2]`,
      afterY: `#<_ofprobe_hy> = ${halfY}
                G92 Y [[#5062 - #<_ofprobe_ya>] / 2]`,
      probeY: !keepY,
    }).replace(/^\s*G38\.2 Z -25 F\S+\n\s*G91 G1 Z 1\n\s*G38\.2 Z -2 F\S+\n/, "");
    send(`
            G21
            G38.2 Z -25 F${fast}
            G91 G1 Z 1
            G38.2 Z -2 F${slow}
            #<_ofprobe_dz> = [#5063 - #<_ofprobe_zt>]
            o100 if [ABS[#<_ofprobe_dz>] GT 0.5]
                G91 G0 Z 25
                #<_ofprobe_ok> = 0
            o100 else
${rest}
                #<_ofprobe_ok> = 1
            o100 endif
            G90

            M2
        `);
  }

const capture = (f) => (o) => { let out = ""; f({ ...o, send: (t) => { out = t; } }); return out; };
export const oldProbe = capture(executeProbe);
export const oldCenterSecond = capture(executeCenterSecondProbe);
