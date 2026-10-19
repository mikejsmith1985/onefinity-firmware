# Start job wizard and two-sided (flip) jobs (1.31.0)

Not yet run on a machine. Everything below is tested against simulators and the mock controller only.

## What the wizard does

**Start job…** in the Job panel walks through a job from the program's setup sheet:

1. **Load stock**: size from `(SETUP stock: …)`; for side B, how to turn it over.
2. **3D probe**: put the probe in; the step moves on by itself when you push the stylus (checks the probe input).
3. **Measure stock**: the Measure stock program (top, then the edges) sets Z on the top and X/Y on the
   sheet's `probe-corner`. If the size matches the last job, **Move over the middle of the stock** takes the
   stylus there with a guarded descent. If a tool setter is saved, the probe then touches it, so every cutter
   can be measured against the same stock top.
4. **Line up side B** (only when the sheet lists reference bores, below).
5. For each tool (one *part* per tool, split at the M6 tool changes):
   **Cutter** (swap; the sheet's stick-out is shown) → **Z for the cutter** (tool setter, or Probe Z with the
   touch plate) → **Router** (dial setting, when the router has its own switch) → **Run** (the normal Run
   checklist and controller checks apply).

Every step can be skipped. The wizard is shared by every screen and remembers its step: close it (or reload)
and **Start job…** offers **Continue at …**. **Hide to jog** hides it while you jog or use the camera.

### Tool changes

The controller can't run the setter program while a program is paused at M6, so a program with tool changes
is split into `part<k>of<n>-<program>.nc` files, written on the controller when each part is about to run.
Part 1 runs from the top to the line before the second tool's M6. Each later part:

- starts with the setup sheet;
- then M5, M9, the units, plane and work offset;
- then a lift to the top of Z travel (G53);
- then the feed, the tool and the spindle (with a 10 s pause) if the part cuts without starting it;
- then the motion mode.

Every part except the last ends with M5, M9 and a lift to the top. The M6 words are taken out, so your
*On tool change* setting does not run inside the wizard. The wizard refuses to split a program it can't
follow safely: variables, G92/G10/G52, G93, a canned cycle or arc mode at a change, or G91 at a change.

## Two-sided jobs: reference bores

Side A cuts two (or more) small **through** bores in the waste. After the stock is turned over, the 3D
probe finds the centre of each bore. The controller then works out how far the stock is turned and
shifted, and writes `flip-<program>.nc`: the side B program turned about its X0 Y0 (the same code as
camera alignment), with X/Y zero set on the program's X0 Y0.

### In Fusion

1. In the **side A** setup, sketch 2 (better 3) circles in the waste, at least 20 mm apart (the further,
   the better the angle), **not** placed symmetrically about the stock centre, ideally not on one line
   parallel to the flip axis. 8 to 12 mm across works well with a 2 mm stylus (they must be larger than
   the stylus ball plus about 1 mm; 2 to 60 mm is accepted). Put them away from clamps and tabs.
2. Cut them **all the way through** with a 2D Bore or helical 2D Pocket in the side A program (the probe
   touches the walls 3 mm below the side B top; a blind bore would only be open on side A).
3. Write down their centres in **side A's WCS** (the X/Y the side A program uses), and the side A stock box.
4. In the **side B** setup, keep the usual setup sheet lines (stock, probe-corner, tool, …) and add the
   lines below. The side B program's own stock line and corner are used for the rough zero.

```
(SETUP flip: y)                         y: turned over left to right (about the Y axis, X mirrored)
                                        x: turned over front to back (about the X axis, Y mirrored)
                                        none: the ref positions are already in side B's coordinates
(SETUP ref1: bore x=20 y=20 d=10)       side A coordinates, mm (add units=in for inches)
(SETUP ref2: bore x=170 y=95 d=10)
(SETUP ref-stock: x=0..200 y=0..120)    side A's stock box, only if it isn't side B's stock line
```

The controller maps them onto side B as:

- **flip y:** `x_b = B.xmax − (x_a − A.xmin)` and `y_b = B.ymin + (y_a − A.ymin)`.
- **flip x:** `x_b = B.xmin + (x_a − A.xmin)` and `y_b = B.ymax − (y_a − A.ymin)`.

A and B are the stock boxes from the ref-stock and stock lines.

### Post processor snippet (Fusion .cps)

The post is not in this repository. Add properties and write the lines in `onOpen()` next to the other
`(SETUP …)` lines (untested sketch; adapt to your post's comment writer, which must not put brackets
inside a comment):

```js
properties.flipAxis = { title: "Flip: axis turned over (none, x, y)", type: "enum",
  values: [{ id: "", title: "Not a flip job" }, { id: "y", title: "y (left-right)" },
           { id: "x", title: "x (front-back)" }, { id: "none", title: "none" }], value: "", scope: "post" };
properties.flipRefs = { title: "Flip: side A ref bores x,y,d;x,y,d (mm)", type: "string", value: "", scope: "post" };
properties.flipRefStock = { title: "Flip: side A stock x0..x1 y0..y1 (blank = same)", type: "string", value: "", scope: "post" };

// in onOpen(), after the stock/probe-corner setup lines:
if (getProperty("flipAxis")) {
  writeln("(SETUP flip: " + getProperty("flipAxis") + ")");
  var refs = String(getProperty("flipRefs")).split(";");
  for (var i = 0; i < refs.length; i++) {
    var v = refs[i].split(",");
    if (v.length == 3) {
      writeln("(SETUP ref" + (i + 1) + ": bore x=" + xyzFormat.format(+v[0]) + " y=" + xyzFormat.format(+v[1]) +
              " d=" + xyzFormat.format(+v[2]) + ")");
    }
  }
  var rs = String(getProperty("flipRefStock")).match(/(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)/);
  if (rs) writeln("(SETUP ref-stock: x=" + rs[1] + ".." + rs[2] + " y=" + rs[3] + ".." + rs[4] + ")");
}
```

`xyzFormat` must write mm here. If the post outputs inches, write `units=in` on each ref line instead.

### On the machine

After Measure stock on side B, **Line up side B** lists the bores, nearest the zero corner first:

- **Find and probe:** the stylus rises to travel height and moves over where the bore should be. It goes
  down with a guarded move at a few spots across the line from the zero corner, covering a turn of up to
  2°. Once it is in, it finds the centre with four touches (X, then Y, twice). The second bore is looked
  for from the first one measured, so a turned stock doesn't make it miss.
- **Probe here:** the same, from where you jogged the stylus.
- **From the camera:** starts from the camera crosshair, when the camera offset is calibrated.
- **Use this position:** a centre set by eye, which can be typed.

Each bore reports its diameter, how far it is out of round and how well the two rounds agree, and is
refused past 0.25, 0.08 and 0.03 mm. The fit is refused if:

- the distance between two bores differs from the program by more than 0.05 mm;
- the stock is turned more than 5°.

It warns if the pattern would fit just as well turned over another way. **Line up** then writes
`flip-<program>.nc`, sets X/Y zero and records the zero as `flip`. A flip copy only runs with that record:
the Run check shows WRONG ZERO after any other probe. Z is set per cutter as usual.

### Which frame #5061 to #5063 are in

The 1.29.0 notes left open whether the probe result variables are in work or machine coordinates on
this controller. The new programs don't depend on it:

- The bore program moves itself to the measured centre using only differences between touches. The
  wizard then reads the machine position.
- The tool setter touch stops exactly 1 mm above the trip, and the wizard reads the machine Z.
- Measure stock already only used differences.

The simulator runs every program in both frames and gets the same centres.
