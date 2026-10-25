# Hold-to-jog into the tool setter, simulated with the motion board's own jog S-curve (1.34.4).
#   python3 src/py/tests/test_setter_guard_jogsim.py
#
# On the machine (1.34.1) a fast hold-jog got through and hit the setter: the guard
# read the jerk limit 1000x too high, so it thought the axis could stop far sooner than
# it can. This runs jogs at every speed of the jog screen from many directions, with the
# axes braking exactly as avr/src/SCurve.cpp does and the guard seeing the machine late:
#   - position reports up to 250 ms old,
#   - the watcher only every 100 ms,
#   - a command reaching the motion board up to 270 ms after it was sent,
# and checks the cutter never gets inside the keep-out circle.
import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bbstub import check, done
import bbctrl
SG = sys.modules['bbctrl.SetterGuard']

# The Onefinity's settings (from the controller): m/min, km/min^2, km/min^3
VM = {'x': 10, 'y': 10, 'z': 3}; AM = 750; JM = 1000
SEG = 0.004                       # s, SEGMENT_MS
STALE, WATCH, SEND = 0.25, 0.1, 0.27

class SCurve:
    '''avr/src/SCurve.cpp next(), in mm and s.'''
    def __init__(s, vmax, amax, jmax): s.maxA, s.maxJ, s.v, s.a = amax, jmax, 0.0, 0.0
    def next(s, t, target):
        v, a, maxA, maxJ = s.v, s.a, s.maxA, s.maxJ
        inc = v < target
        dA = maxJ * t
        if inc and a < -dA: na = a + dA
        elif not inc and dA < a: na = a - dA
        else:
            tA = min(math.sqrt(2 * abs(target - v) * maxJ), maxA)
            na = (tA if tA < a + dA else a + dA) if inc else (-tA if a - dA < -tA else a - dA)
        dv = na * t
        if (dv < 0 and target < v and v + dv < target) or (0 < dv and v < target and target < v + dv):
            na = (target - v) / t; s.v = target
        else: s.v = v + dv
        s.a = na
        return s.v

class State:
    def __init__(s, pos): s.pos = dict(pos); s.vars = {'offset_z': -111.782, 'cycle': 'jogging'}
    def is_axis_homed(s, a): return True
    def get_position(s): return dict(s.pos)
    def get(s, k, d=None):
        i = k[:1]
        if k[1:] in ('vm', 'am', 'jm') and i in '012':
            ax = 'xyz'[int(i)]
            return {'vm': VM[ax], 'am': AM, 'jm': JM}[k[1:]]
        return s.vars.get(k, d)
    def find_motor(s, a): return 'xyz'.index(a) if a in 'xyz' else None
    def get_soft_limit_vector(s, var, default):
        return {'tm': {'x': 410, 'y': 410, 'z': 0}, 'tn': {'x': 0, 'y': 0, 'z': -133}}[var]

class Ctrl:
    def __init__(s, pos):
        import tempfile, json
        s.dir = tempfile.mkdtemp(); s.state = State(pos)
        class L:
            def get(self, name): return self
            def info(self, *a): pass
            warning = error = debug = exception = info
        s.log = L()
        ref = {'ref': 49.99, 'offZ': -111.782, 'time': 1, 'by': 'tool', 'f': 2}
        json.dump({'setter': {'x': 374.547, 'y': 374.791, 'z': -61.114, 'keep': 30, 'ref': ref}},
                  open(os.path.join(s.dir, 'prefs.json'), 'w'))
    def get_path(s, name, filename=None): return os.path.join(s.dir, filename) if filename else s.dir

CX, CY = 374.547, 374.791
TOP = 49.99 - 111.782              # the setter's top, machine Z
R = 30 + 3.2

def run(start, frac, z):
    '''Hold-jog from start (x, y) with velocity fractions frac {'x':..,'y':..} at machine Z z.
    Returns the closest the cutter got to the center.'''
    ctrl = Ctrl({'x': start[0], 'y': start[1], 'z': z})
    g = SG.SetterGuard(ctrl)
    curves = dict((a, SCurve(VM[a] * 1000 / 60, AM * 1e6 / 3600, JM * 1e6 / 216000)) for a in 'xy')
    pos = {'x': start[0], 'y': start[1], 'z': z}
    hist = []                     # (t, pos) for stale reports
    pending = []                  # (t_effective, command)
    cmd = dict(frac)              # what the motion board is doing
    first, _ = g.filter_jog(dict(frac), dict(pos))
    cmd = first
    t, nextw, closest = 0.0, WATCH, math.hypot(pos['x'] - CX, pos['y'] - CY)
    while t < 12:
        while pending and pending[0][0] <= t: cmd = pending.pop(0)[1]
        for a in 'xy':
            v = curves[a].next(SEG, (cmd.get(a) or 0) * VM[a] * 1000 / 60)
            pos[a] += v * SEG
        t += SEG
        hist.append((t, dict(pos)))
        closest = min(closest, math.hypot(pos['x'] - CX, pos['y'] - CY))
        if t >= nextw:            # the watcher, with an old position report
            nextw += WATCH
            seen = next((p for (tt, p) in reversed(hist) if tt <= t - STALE), hist[0][1])
            out, why = g.filter_jog(dict(frac), seen)
            if why: pending.append((t + SEND, out))
        if all(abs(c.v) < 1e-3 for c in curves.values()) and t > 1 and not any(cmd.get(a) for a in 'xy'): break
    return closest

low = TOP - 5                     # 5 mm below the setter's top
bad = []
n = 0
for pct in (1, 5, 10, 25, 50, 100):
    f = pct / 100
    for ang in range(0, 360, 15):
        ux, uy = math.cos(math.radians(ang)), math.sin(math.radians(ang))
        for back in (60, 120, 250):
            sx, sy = CX - ux * (R + back), CY - uy * (R + back)
            if not (0 <= sx <= 410 and 0 <= sy <= 410): continue
            n += 1
            c = run((sx, sy), {'x': f * ux, 'y': f * uy}, low)
            if c < R: bad.append((pct, ang, back, round(c, 2)))
check('%d hold-jogs straight at the setter (1-100%% speed, every 15 deg) all stop outside the keep-out' % n,
      not bad, bad[:5])

# Glancing: a jog along X that passes the edge
bad = []
for pct in (10, 50, 100):
    for off in (0, 15, 30, 33):
        c = run((CX - 250, CY + off), {'x': pct / 100}, low)
        if c < R: bad.append((pct, off, round(c, 2)))
check('jogs that clip the edge stop outside it too', not bad, bad)

# And it doesn't stop jogs that pass well clear
ctrl = Ctrl({'x': CX - 250, 'y': CY + 60, 'z': low}); g = SG.SetterGuard(ctrl)
out, why = g.filter_jog({'x': 1.0}, {'x': CX - 250, 'y': CY + 60, 'z': low})
check('a full-speed jog passing 60 mm from the center is left alone', why is None and out['x'] == 1.0, (out, why))
done()
