# Material simulation for Cut deeper (1.30.0): a height map of the stock cut by
# a flat end mill.  Runs the original program, then the do-over, and checks
# what the do-over removes.
#   python3 src/py/tests/sim_doover.py
import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from bbstub import check, done
import bbctrl
from bbctrl import GCodeText
D = sys.modules['bbctrl.DoOver']
import doover_progs as P

CELL = 0.2
TOOL_D = 6.35


class Sim(object):
    def __init__(s, x=(-10, 90), y=(-10, 50), top=0.0, bottom=-3.0):
        s.x0, s.y0 = x[0], y[0]
        s.nx, s.ny = int((x[1] - x[0]) / CELL), int((y[1] - y[0]) / CELL)
        s.h = np.full((s.nx, s.ny), top)
        s.bottom = bottom
        r = TOOL_D / 2 / CELL
        k = int(math.ceil(r))
        gx, gy = np.mgrid[-k:k + 1, -k:k + 1]
        s.disk = (gx ** 2 + gy ** 2) <= r * r
        s.k = k
        s.log = []   # (line, kind, removed_above_floor, max_depth_of_cut)

    def stamp(s, x, y, z, floor):
        i, j = int(round((x - s.x0) / CELL)), int(round((y - s.y0) / CELL))
        k = s.k
        a0, a1, b0, b1 = max(0, i - k), min(s.nx, i + k + 1), max(0, j - k), min(s.ny, j + k + 1)
        if a0 >= a1 or b0 >= b1: return 0.0, 0.0
        m = s.disk[a0 - i + k:a1 - i + k, b0 - j + k:b1 - j + k]
        h = s.h[a0:a1, b0:b1]
        cut = np.where(m, np.maximum(0.0, h - z), 0.0)
        above = 0.0 if floor is None else float(np.where(m, np.maximum(0.0, h - max(z, floor)), 0.0).sum())
        doc = float(cut.max())
        h[:] = np.where(m, np.minimum(h, z), h)
        return above, doc

    def run(s, lines, floor_of=None):
        pos = [0.0, 0.0, 50.0]
        units, motion, absolute = 1.0, 0, True
        canned = None; cz = cr = None
        oc = False
        for n, raw in enumerate(lines, 1):
            code, _, _, oc = GCodeText.split(raw, oc)
            words = [(c.upper(), float(v)) for c, v in GCodeText.WORD.findall(code)]
            if not words: continue
            v = dict(words); gs = [x for c, x in words if c == 'G']
            for g in gs:
                if g == 20: units = 25.4
                elif g == 21: units = 1.0
                elif g == 90: absolute = True
                elif g == 91: absolute = False
                elif g in (0, 1, 2, 3): motion = int(g); canned = None
                elif g == 80: canned = None
                elif g in (81, 82, 83, 73): canned = g
            if 53 in gs or 28 in gs:
                if 'Z' in v: pos[2] = 50.0
                continue
            if not any(a in v for a in 'XYZ'): continue
            if not absolute: continue
            if canned:
                if 'Z' in v: cz = v['Z'] * units
                if 'R' in v: cr = v['R'] * units
                x = v.get('X', pos[0] / units) * units; y = v.get('Y', pos[1] / units) * units
                s.seg(n, 'rapid', pos, [x, y, pos[2]]); s.seg(n, 'rapid', [x, y, pos[2]], [x, y, cr])
                s.seg(n, 'feed', [x, y, cr], [x, y, cz]); s.seg(n, 'rapid', [x, y, cz], [x, y, pos[2]])
                pos = [x, y, pos[2]]
                continue
            new = [v.get(a, pos[i] / units) * units if a in v else pos[i] for i, a in enumerate('XYZ')]
            if motion in (2, 3):
                c = (pos[0] + v.get('I', 0) * units, pos[1] + v.get('J', 0) * units)
                r = math.hypot(pos[0] - c[0], pos[1] - c[1])
                a0 = math.atan2(pos[1] - c[1], pos[0] - c[0]); a1 = math.atan2(new[1] - c[1], new[0] - c[0])
                sw = (a0 - a1) if motion == 2 else (a1 - a0)
                while sw <= 1e-9: sw += 2 * math.pi
                steps = max(4, int(r * sw / 0.2))
                sg = -1 if motion == 2 else 1
                prev = list(pos)
                for i in range(1, steps + 1):
                    t = i / steps
                    p = [c[0] + r * math.cos(a0 + sg * sw * t), c[1] + r * math.sin(a0 + sg * sw * t),
                         pos[2] + (new[2] - pos[2]) * t]
                    s.seg(n, 'feed', prev, p); prev = p
            else:
                s.seg(n, 'rapid' if motion == 0 else 'feed', pos, new)
            pos = new

    def seg(s, n, kind, a, b):
        L = math.dist(a, b)
        steps = max(1, int(L / 0.1))
        above_t, doc_m = 0.0, 0.0
        for i in range(1, steps + 1):
            t = i / steps
            p = [a[j] + (b[j] - a[j]) * t for j in range(3)]
            ab, doc = s.stamp(p[0], p[1], p[2], s.floor)
            above_t += ab; doc_m = max(doc_m, doc)
        s.log.append((n, kind, above_t * CELL * CELL, doc_m, a, b))

    floor = None


def go(name, prog, opts, expect_tabs=True):
    base = Sim()
    base.run(prog)
    after = base.h.copy()
    t, info = D.build(prog, 'part.nc', opts, top_mm=-2, tool_now=1)
    s = Sim(); s.h = after.copy()
    ops = info['ops']
    s.floor = max(o['floor'] for o in ops) + 0.02
    s.run(t.splitlines())
    rapid_cut = [l for l in s.log if l[1] == 'rapid' and l[3] > 0.02]
    above = sum(l[2] for l in s.log)
    step = opts.get('step', 1.0)
    deep = [l for l in s.log if l[1] == 'feed' and l[3] > step + 0.05]
    check(name + ': no rapid touches material', not rapid_cut, rapid_cut[:2])
    if expect_tabs:
        check(name + ': nothing above the old floor is cut (%.3f mm3)' % above, above < 0.5)
    check(name + ': no feed cuts deeper than one step', not deep, [(l[0], round(l[3], 3)) for l in deep[:3]])
    new_floor = info['deepest']
    check(name + ': the do-over cut down to the new floor', abs(s.h.min() - new_floor) < 0.01, (s.h.min(), new_floor))
    return s, after, info, t


prog = P.STANDARD()
s, after, info, t = go('standard 1.5 mm', prog, {'extra': 1.5})
# Under each tab the material above the old floor is still there
tab = (int(round((45 - s.x0) / CELL)), int(round((20 - s.y0) / CELL)))
check('tab kept: tab top still at Z-1.2', abs(s.h[tab] - (-1.2)) < 0.05, s.h[tab])
s2, _, _, _ = go('standard 0.5 mm', prog, {'extra': 0.5})
s3, _, _, _ = go('standard 2.4 mm in 0.8 mm steps', prog, {'extra': 2.4, 'step': 0.8})
s4, _, i4, _ = go('tabs cut through', prog, {'extra': 1.0, 'tabs': 'under'}, expect_tabs=False)
check('tabs cut through: tab gone', s4.h[tab] <= -4.19, s4.h[tab])
check('tab kept in the original run', abs(after[tab] - (-1.2)) < 0.05, after[tab])
progA = P.program(P.contour(arcs=True), P.canned(code=83), P.canned(code=81, pts=((10, 38),), name='Drill3'))
go('arcs and canned drills', progA, {'extra': 1.2})
go('inch program', P.to_inch(P.STANDARD()), {'extra': 1.0})
progB = P.program(P.contour(levels=(-3.2,), tabs=True))
s5, _, i5, _ = go('single pass contour, tabs through refused', progB, {'extra': 1.0, 'tabs': 'under'})
check('single pass: tab kept and warned', abs(s5.h[tab] - (-1.2)) < 0.05 and any('could not be confirmed' in w for w in i5['warnings']), (s5.h[tab], i5['warnings']))
done()
