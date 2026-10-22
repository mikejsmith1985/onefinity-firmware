# Quick dry run (1.33.0).   python3 src/py/tests/test_dryrun.py
import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bbstub import check, done
import bbctrl
from bbctrl import DryRun, GCodeText


def moves(lines):
    '''(line number, mode, start, end) for every XYZ move, absolute G90.'''
    x = y = z = None; mode = 0; out = []
    for n, raw in enumerate(lines, 1):
        code = GCodeText.code_of(raw)
        w = dict((l.upper(), float(v)) for l, v in GCodeText.WORD.findall(code))
        gs = [float(v) for l, v in GCodeText.WORD.findall(code) if l.upper() == 'G']
        for g in gs:
            if g in (0, 1, 2, 3): mode = int(g)
        if not any(k in w for k in 'XYZ'): continue
        nx, ny, nz = w.get('X', x), w.get('Y', y), w.get('Z', z)
        out.append((n, mode, (x, y, z), (nx, ny, nz), w))
        x, y, z = nx, ny, nz
    return out


def square(z, f=400):
    return ['G1 Z%g F%g' % (z, f), 'G1 X50', 'G1 Y50', 'G1 X0', 'G1 Y0']


# 1. A profile at 5 levels: only the first level is kept
prog = ['(SETUP stock: x=0..60 y=0..60 z=-10..0)', 'G90 G21', '(PROFILE)', 'G0 Z5', 'G0 X0 Y0']
for z in (-1, -2, -3, -4, -5): prog += square(z)
prog += ['G0 Z5', 'M30']
r = DryRun.reduce_lines(prog)
out = r['lines']
check('same number of lines as the program', len(out) == len(prog))
cut = [m for m in moves(out) if m[3][2] is not None and m[3][2] < 0 and m[1] == 1]
check('first level kept', any(abs(m[3][2] + 1) < 1e-9 and m[3][0] == 50 for m in cut), cut[:6])
check('deeper levels left out', not any(m[3][2] < -1.5 and (m[2][0], m[2][1]) != (m[3][0], m[3][1]) for m in cut), [m for m in cut if m[3][2] < -1.5])
check('every kept feed is 3000', all(('F' not in m[4]) or m[4]['F'] == 3000 for m in moves(out) if m[1] == 1))
check('operation start pauses', any(l.startswith('G4 P0.7 (PROFILE)') for l in out))

# 2. Two holes in one operation, each a helix of several turns: both visited, first turn only
def helix(cx, cy, r=1.2, turns=5, pitch=0.5):
    l = ['G0 X%g Y%g' % (cx + r, cy), 'G1 Z0 F300']
    zz = 0.0
    for t in range(turns * 4):
        zz -= pitch / 4
        a = (t + 1) * math.pi / 2
        l.append('G3 X%.4f Y%.4f Z%.4f I%.4f J%.4f' % (cx + r * math.cos(a), cy + r * math.sin(a), zz,
                                                     cx - (cx + r * math.cos(a - math.pi / 2)), cy - (cy + r * math.sin(a - math.pi / 2))))
    return l + ['G0 Z5']
prog = ['(SETUP stock: x=0..100 y=0..100 z=-10..0)', 'G90 G21', '(HOLES)', 'G0 Z5'] + helix(20, 20) + helix(80, 70) + ['M30']
r = DryRun.reduce_lines(prog)
mv = [m for m in moves(r['lines']) if m[1] in (2, 3)]
near = lambda m, cx, cy: math.hypot(m[3][0] - cx, m[3][1] - cy) < 3
check('hole 1 visited', any(near(m, 20, 20) for m in mv))
check('hole 2 visited', any(near(m, 80, 70) for m in mv))
check('only about the first turn of each helix', len(mv) <= 2 * 6, len(mv))
# each kept arc starts where it started in the program
orig = dict((m[0], m) for m in moves(prog))
ok = True
for m in moves(r['lines']):
    o = orig.get(m[0])
    if o and o[1] in (2, 3) and m[1] in (2, 3):
        ok &= math.dist(o[2][:2], m[2][:2]) < 1e-6
check('kept arcs start exactly where they did (I/J stay right)', ok)

# 3. Facing over a big plate: cut short at about 30 s
prog = ['(SETUP stock: x=0..300 y=0..300 z=-10..0)', 'G90 G21', '(FACE)', 'G0 Z5 X0 Y0', 'G1 Z-0.5 F500']
for k in range(80):
    yy = k * 3.7
    prog += ['G1 Y%g' % yy, 'G1 X%g' % (300 if k % 2 == 0 else 0)]
prog += ['G0 Z5', 'M30']
r = DryRun.reduce_lines(prog)
check('facing cut short near 30 s', 25 <= r['seconds'] <= 40, r['seconds'])

# 4. Leaving out a stretch lifts to the clearance before moving across
prog = ['(SETUP stock: x=0..60 y=0..60 z=-10..0)', 'G90 G21', '(PROFILE)', 'G0 Z15', 'G0 X0 Y0']
for z in (-1, -2, -3): prog += square(z)
prog += ['G1 Z-3', 'G1 X25 Y25', 'G0 Z15', 'M30']   # a new place after the repeats
r = DryRun.reduce_lines(prog)
out = r['lines']
check('bridge goes up to the clearance', any(l.startswith('G0 Z15') for i, l in enumerate(out) if prog[i] != l), [l for i, l in enumerate(out) if prog[i] != l and l][:6])

# 5. Pauses are left out, the rest of the line structure is kept
prog = ['G90 G21', '(OP)', 'M0', '(MSG, fit the screws)', 'M0', 'G0 Z5', 'G0 X1 Y1', 'G1 Z-1 F300', 'G1 X10', 'G0 Z5', 'M30']
r = DryRun.reduce_lines(prog)
check('M0 left out', 'M0' not in [l.strip() for l in r['lines']])
check('M30 kept', 'M30' in [l.strip() for l in r['lines']])

# 6. Programs it can't follow are run whole
for bad, why in (('G91', 'incremental'), ('G1 X1 Y1 #1=2', 'variables'), ('G2 X5 Y5 R3', 'R')):
    r = DryRun.reduce_lines(['G90 G21', 'G0 Z5', bad, 'M30'])
    check('whole program for %s' % why, r['lines'] is None and why.split()[0].lower() in r['whole'].lower(), r['whole'])
check('describe whole', 'Whole program' in DryRun.describe({'text': None, 'whole': 'incremental moves (G91)'}))
check('describe quick', 'First pass of each of 3 operations' in DryRun.describe({'text': 'x', 'ops': 3, 'seconds': 95}))

# 7. Stock top from the sheet when Z0 is on the board
check('stock top from plate + Z0 on stock bottom', DryRun.stock_top({'plate': '152.4 X 304.8 X 24.3 MM', 'zero': 'FRONT-LEFT CORNER, Z0 ON STOCK BOTTOM'}) == 24.3)
check('stock top from stock line', DryRun.stock_top({'stock': 'x=0..1 y=0..1 z=0..23.8'}) == 23.8)
check('no stock top', DryRun.stock_top({}) is None)

# 8. Runs on the controller's Python (3.5 on the Pi): no math.dist (1.33.1)
import math as _m
_saved = _m.__dict__.pop('dist', None)
try:
    r = DryRun.reduce_lines(['(SETUP stock: x=0..60 y=0..60 z=-10..0)', 'G90 G21', '(P)', 'G0 Z5', 'G0 X0 Y0'] + square(-1) + square(-2) + ['G0 Z5', 'M30'])
    check('works without math.dist', r['lines'] is not None)
except AttributeError as e:
    check('works without math.dist', False, e)
finally:
    if _saved is not None: _m.dist = _saved

done()
