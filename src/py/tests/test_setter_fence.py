# Tool setter fence on the motion board (1.34.5).   python3 src/py/tests/test_setter_fence.py
#
# On the machine (1.34.4) a full-speed gamepad jog (Y button, 100%) still went through the
# setter: the Pi-side check depends on how quickly the Pi sees the position and gets a stop
# to the motion board, and on a busy Pi that can be well over a second. 1.34.5 sets a
# temporary soft limit in front of the setter; the motion board brakes against soft limits
# itself (avr/src/jog.c, every 4 ms).
#
# This runs the real Mach jog code against a model of the motion board's jog (jog.c with
# SCurve.cpp) and a slow Pi: every command reaches the board SEND seconds late, the Pi sees
# positions STALE seconds old and its timers run late. It checks that the cutter never
# enters the setter's keep-out circle, at every jog speed, from every direction, for
# gamepad-style jogs (sent once) and screen-style jogs (re-sent every 200 ms), and that the
# configured soft limits come back after the jog.
import sys, os, math, json, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bbstub import check, done
import bbctrl
SG = sys.modules['bbctrl.SetterGuard']
from bbctrl.Mach import Mach
MachMod = sys.modules['bbctrl.Mach']

# The Onefinity: motors 0 X, 1 Y, 2 Y, 3 Z; m/min, km/min^2, km/min^3; soft limits mm
VM = {'x': 10, 'y': 10, 'z': 3}; AM = 750; JM = 1000
AXIS_OF = {0: 'x', 1: 'y', 2: 'y', 3: 'z'}
CONF_TN = {'0': 0, '1': 0, '2': 0, '3': -133}
CONF_TM = {'0': 410, '1': 410, '2': 410, '3': 0}
SEG = 0.004
MIN_V = 10 / 60.0                        # MIN_VELOCITY, mm/s
CX, CY = 374.547, 374.791
OFFZ, REF = -111.782, 49.99
TOP = REF + OFFZ                          # setter top, machine Z
R = 30 + 3.2

def vmax(a): return VM[a] * 1000 / 60
A = AM * 1e6 / 3600; J = JM * 1e6 / 216000

class SCurve:
    '''avr/src/SCurve.cpp, in mm and s.'''
    def __init__(s): s.v = s.a = 0.0
    @staticmethod
    def _dist(t, v, a, j): return t * (v + t * (0.5 * a + j * t / 6))
    @staticmethod
    def _vel(t, a, j): return t * (a + 0.5 * j * t)
    def stopping(s):
        v, a = s.v, s.a
        if not v: return 0.0
        if v < 0: v, a = -v, -a
        d = 0.0
        if a > 0:
            t = a / J; d += s._dist(t, v, a, -J); v += s._vel(t, a, -J); a = 0.0
        md = -math.sqrt(v * J + 0.5 * a * a)
        if md < -A: md = -A
        if md < a:
            t = (a - md) / J; d += s._dist(t, v, a, -J); v += s._vel(t, a, -J); a = md
        dv = 0.5 * a * a / J
        if dv < v:
            t = (v - dv) / -a; d += s._dist(t, v, a, 0); v += s._vel(t, a, 0)
        d += s._dist(-a / J, v, a, J)
        return d
    def next(s, t, target):
        v, a = s.v, s.a
        inc = v < target
        dA = J * t
        if inc and a < -dA: na = a + dA
        elif not inc and dA < a: na = a - dA
        else:
            tA = min(math.sqrt(2 * abs(target - v) * J), A)
            na = (tA if tA < a + dA else a + dA) if inc else (-tA if a - dA < -tA else a - dA)
        dv = na * t
        if (dv < 0 and target < v and v + dv < target) or (0 < dv and v < target and target < v + dv):
            na = (target - v) / t; s.v = target
        else: s.v = v + dv
        s.a = na
        return s.v

class Board:
    '''avr/src/jog.c jog_exec() for X, Y, Z with the soft-limit vars.'''
    def __init__(s, pos):
        s.p = dict(pos); s.c = dict((a, SCurve()) for a in 'xyz'); s.next = {}
        s.vars = {}
        for m in range(4): s.vars['%dtn' % m] = CONF_TN[str(m)]; s.vars['%dtm' % m] = CONF_TM[str(m)]
        s.jumps = []
    def limit(s, a, lo):
        m = {'x': 0, 'y': 1, 'z': 3}[a]          # axis_get_soft_limit: the axis' motor
        return s.vars['%d%s' % (m, 'tn' if lo else 'tm')]
    def command(s, cmd):
        if isinstance(cmd, tuple): s.next = dict((k.lower(), v) for k, v in cmd[1].items())
        elif cmd.startswith('$'):
            k, v = cmd[1:].split('='); s.vars[k] = float(v)
    def step(s):
        moving = False
        for a in 'xyz':
            sc, p = s.c[a], s.p[a]
            vel, tv = sc.v, (s.next.get(a) or 0) * vmax(a)
            lo, hi = s.limit(a, True), s.limit(a, False)
            if lo != hi and MIN_V < abs(tv):
                dist = sc.stopping() * 1.01
                if vel < 0 and p - dist <= lo: tv = -MIN_V
                if 0 < vel and hi <= p + dist: tv = MIN_V
            v = sc.next(SEG, tv)
            dp = v * SEG
            if lo != hi and 0 < dp and hi < p + dp:
                if p > hi + 1e-6: s.jumps.append((a, p, hi))
                p = hi
            elif lo != hi and dp < 0 and p + dp < lo:
                if p < lo - 1e-6: s.jumps.append((a, p, lo))
                p = lo
            else: p += dp
            s.p[a] = p
            if abs(v) > MIN_V or abs(tv) > MIN_V: moving = True
        return moving

class Loop:
    def __init__(s): s.t = 0.0; s.q = []; s.lag = 0.0
    def call_later(s, d, cb): h = [s.t + d + s.lag, cb]; s.q.append(h); return h
    def remove_timeout(s, h):
        if h in s.q: s.q.remove(h)
    def run(s):
        due = [h for h in s.q if h[0] <= s.t]
        for h in due:
            if h in s.q: s.q.remove(h); h[1]()

class Log:
    def __init__(s): s.lines = []
    def get(s, n): return s
    def info(s, m, *a): s.lines.append(('info', m))
    def warning(s, m, *a): s.lines.append(('warning', m))
    def error(s, m, *a): s.lines.append(('error', m))
    def exception(s, m, *a): s.lines.append(('exception', m)); raise
    debug = info

class State:
    def __init__(s, sim): s.sim = sim; s.vars = {'offset_z': OFFZ, 'cycle': 'idle'}
    def is_axis_homed(s, a): return True
    def get_position(s): return s.sim.seen()
    def get(s, k, d=None):
        if len(k) == 3 and k[0] in '0123' and k[1:] in ('vm', 'am', 'jm'):
            return {'vm': VM[AXIS_OF[int(k[0])]], 'am': AM, 'jm': JM}[k[1:]]
        if len(k) == 3 and k[0] in '0123' and k[1:] == 'an': return 'xyz'.index(AXIS_OF[int(k[0])])
        if len(k) == 3 and k[0] in '0123' and k[1:] == 'me': return 1
        return s.vars.get(k, d)
    def set(s, k, v): s.vars[k] = v
    def find_motor(s, a): return {'x': 0, 'y': 1, 'z': 3}.get(a)
    def get_soft_limit_vector(s, var, default):
        # What the Pi has in its state: the configured limits (the guard reads only Z)
        return {'tm': {'x': 410, 'y': 410, 'z': 0}, 'tn': {'x': 0, 'y': 0, 'z': -133}}[var]

class Config:
    def get(s, name, d=None):
        return {'min-soft-limit': CONF_TN, 'max-soft-limit': CONF_TM}.get(name, d)

class Sim:
    def __init__(s, pos, STALE=0.5, SEND=1.0, LAG=0.3):
        s.STALE, s.SEND = STALE, SEND
        s.board = Board(pos); s.hist = [(0.0, dict(pos))]; s.inbox = []
        s.loop = Loop(); s.loop.lag = LAG
        s.dir = tempfile.mkdtemp()
        ref = {'ref': REF, 'offZ': OFFZ, 'time': 1, 'by': 'tool', 'f': 2}
        json.dump({'setter': {'x': CX, 'y': CY, 'z': -61.1, 'keep': 30, 'ref': ref}},
                  open(os.path.join(s.dir, 'prefs.json'), 'w'))
        ctrl = type('Ctrl', (), {})()
        ctrl.state = State(s); ctrl.log = Log(); ctrl.ioloop = s.loop; ctrl.config = Config()
        ctrl.get_path = lambda name, filename=None: os.path.join(s.dir, filename) if filename else s.dir
        ctrl.setter_guard = SG.SetterGuard(ctrl)
        s.ctrl = ctrl
        m = Mach.__new__(Mach); m.ctrl = ctrl; m.mlog = ctrl.log
        m._begin_cycle = lambda c: ctrl.state.set('cycle', c)
        m.planner = type('P', (), {'position_change': lambda self: None})()
        s.m = m
    def seen(s):
        t = s.loop.t - s.STALE
        p = s.hist[0][1]
        for tt, pp in s.hist:
            if tt <= t: p = pp
            else: break
        return dict(p)
    def run(s, axes, hold, resend=False, total=8.0):
        '''Jog with axes for hold seconds, then release; run on to total.'''
        cmds = []
        orig = Mach.__mro__[1].queue_command
        Mach.__mro__[1].queue_command = lambda self, c: cmds.append(c)
        MachMod.Cmd.jog = lambda a: ('jog', dict(a))
        closest = math.hypot(s.board.p['x'] - CX, s.board.p['y'] - CY)
        low_closest = closest
        try:
            s.m.jog(dict(axes)); last = 0.0; released = False
            while s.loop.t < total:
                while cmds: s.inbox.append((s.loop.t + s.SEND, cmds.pop(0)))
                while s.inbox and s.inbox[0][0] <= s.loop.t: s.board.command(s.inbox.pop(0)[1])
                moving = s.board.step()
                s.loop.t += SEG
                s.hist.append((s.loop.t, dict(s.board.p)))
                d = math.hypot(s.board.p['x'] - CX, s.board.p['y'] - CY)
                if s.board.p['z'] < TOP: low_closest = min(low_closest, d)
                s.loop.run()
                if not released and resend and s.loop.t - last >= 0.2:
                    last = s.loop.t; s.m.jog(dict(axes))
                if not released and s.loop.t >= hold:
                    released = True; s.m.jog(dict((k, 0) for k in axes))
                if released and not moving and not s.inbox and not cmds and s.loop.t > hold + s.SEND + 0.5:
                    s.ctrl.state.set('cycle', 'idle')
        finally:
            Mach.__mro__[1].queue_command = orig
        return low_closest

low = TOP - 5
# 1. Straight at the setter from every direction, every jog speed, held until it would be well past
bad, n, jumps = [], 0, []
for style in ('gamepad', 'screen'):
    for pct in (0.8, 3.1, 10, 25, 50, 100):
        for ang in range(0, 360, 30):
            ux, uy = math.cos(math.radians(ang)), math.sin(math.radians(ang))
            for back in (40, 150):
                sx, sy = CX - ux * (R + back), CY - uy * (R + back)
                if not (0 <= sx <= 410 and 0 <= sy <= 410): continue
                hold = (R + back + 60) / (vmax('x') * pct / 100) if pct >= 10 else 6.0
                s = Sim({'x': sx, 'y': sy, 'z': low})
                c = s.run({'x': pct / 100 * ux, 'y': pct / 100 * uy, 'z': 0}, min(hold, 30), resend=(style == 'screen'), total=min(hold, 30) + 4)
                n += 1; jumps += s.board.jumps
                if c < R: bad.append((style, pct, ang, back, round(c, 2)))
check('%d jogs straight at the setter with a slow Pi (commands 1 s late, positions 0.5 s old): '
      'none gets inside the keep-out' % n, not bad, bad[:6])
check('the board never had to jump back to a limit', not jumps, jumps[:3])

# 1a. From across the table at full speed: stops right at the fence, not far short
s = Sim({'x': 5, 'y': CY, 'z': low})
c = s.run({'x': 1.0, 'y': 0, 'z': 0}, 12, total=15)
check('full speed from across the table stops at the fence (%.1f mm from center, keep-out %.1f)' % (c, R),
      R <= c <= R + SG.FENCE_BACK + 0.5, c)

# 1b. The same slow Pi without the board fence (the 1.34.4 Pi-side check only) lets fast jogs in
keep = SG.SetterGuard.jog_fence
SG.SetterGuard.jog_fence = lambda self, axes, position=None: {}
try:
    worst = []
    for pct in (50, 100):
        s = Sim({'x': 5, 'y': CY, 'z': low})
        worst.append(round(s.run({'x': pct / 100, 'y': 0, 'z': 0}, 12, total=15), 1))
finally: SG.SetterGuard.jog_fence = keep
check('without the fence the same slow Pi lets 50%% / 100%% jogs into the keep-out (%s mm from center)' % worst,
      all(w < R for w in worst), worst)

# 2. Glancing and diagonal past it at full speed
bad = []
for off in (-40, -33, -20, 0, 20, 33, 40):
    s = Sim({'x': CX - 250, 'y': CY + off, 'z': low})
    c = s.run({'x': 1.0, 'y': 0, 'z': 0}, 4, total=8)
    if c < R: bad.append(('x', off, round(c, 2)))
for ang in (20, 45, 70):
    ux, uy = math.cos(math.radians(ang)), math.sin(math.radians(ang))
    s = Sim({'x': CX - 200 * ux + 30 * uy, 'y': CY - 200 * uy - 30 * ux, 'z': low})
    c = s.run({'x': ux, 'y': uy, 'z': 0}, 4, total=8)
    if c < R: bad.append(('diag', ang, round(c, 2)))
check('full-speed jogs that clip or graze it stay outside the keep-out', not bad, bad)

# 3. Z down onto it at full speed stops at the guard height
s = Sim({'x': CX + 5, 'y': CY, 'z': TOP + 40})
s.run({'x': 0, 'y': 0, 'z': -1.0}, 3, total=6)
zlim = TOP + 2
check('Z jog down onto the setter stops at its top + 2 mm', s.board.p['z'] >= zlim - 0.01, (s.board.p['z'], zlim))

# 4. High above it: not fenced, passes over
s = Sim({'x': CX - 200, 'y': CY, 'z': TOP + 10})
s.run({'x': 1.0, 'y': 0, 'z': 0}, 2.2, total=5)
check('jog over it with Z above the top is not stopped', s.board.p['x'] > CX + R, s.board.p)

# 5. Limits come back after the jog
s = Sim({'x': CX - 150, 'y': CY, 'z': low})
s.run({'x': 1.0, 'y': 0, 'z': 0}, 2, total=6)
v = s.board.vars
check('soft limits are back to the configured ones after the jog',
      all(v['%dtm' % m] == CONF_TM[str(m)] and v['%dtn' % m] == CONF_TN[str(m)] for m in range(4)),
      dict((k, v[k]) for k in sorted(v)))
check('the screens are told the jog stops at the keep-out',
      any('stops at the tool setter' in l[1] for l in s.ctrl.log.lines if l[0] == 'warning'))

# 6. Far from it and not heading at it: no fence at all
s = Sim({'x': 100, 'y': 100, 'z': low}); sent = []
orig = Mach.__mro__[1].queue_command
Mach.__mro__[1].queue_command = lambda self, c: sent.append(c)
MachMod.Cmd.jog = lambda a: ('jog', dict(a))
s.m.jog({'x': 0, 'y': 1.0, 'z': 0})
Mach.__mro__[1].queue_command = orig
check('a jog that is not heading at the setter sets no limits', not [c for c in sent if isinstance(c, str)], sent)

# 7. The fence itself
f = SG.jog_fence((CX - 100, CY + 10, low), (1, 0, 0), CX, CY, R, TOP + 2)
check('fence: +X at the setter -> X max at the square\'s face', f == {'x': ('max', CX - R - SG.FENCE_BACK)}, f)
f = SG.jog_fence((CX + 10, CY + 100, low), (0, -1, 0), CX, CY, R, TOP + 2)
check('fence: -Y at it -> Y min at the far face', f == {'y': ('min', CY + R + SG.FENCE_BACK)}, f)
f = SG.jog_fence((CX - 100, CY + 50, low), (1, 0, 0), CX, CY, R, TOP + 2)
check('fence: line passing beside the square -> none', f == {}, f)
f = SG.jog_fence((CX - 100, CY, TOP + 10), (1, 0, 0), CX, CY, R, TOP + 2)
check('fence: above the top -> none', f == {}, f)
f = SG.jog_fence((CX - 100, CY, TOP + 10), (1, 0, -0.3), CX, CY, R, TOP + 2)
check('fence: above but coming down while heading at it -> fenced', 'x' in f, f)
done()
