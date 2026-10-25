# Tool setter guard (1.34.0).   python3 src/py/tests/test_setter_guard.py
import sys, os, json, math, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bbstub import check, done
import bbctrl
SG = sys.modules['bbctrl.SetterGuard']  # the module (bbctrl.SetterGuard is the class)
from bbctrl.Planner import Planner


# ---------------------------------------------------------------- fakes
class Log:
    def __init__(self): self.lines = []
    def get(self, name): return self
    def info(self, m, *a): self.lines.append(('info', m % a if a else m))
    def warning(self, m, *a): self.lines.append(('warning', m % a if a else m))
    def error(self, m, *a): self.lines.append(('error', m % a if a else m))
    def exception(self, m, *a): self.lines.append(('exception', m))


class State:
    def __init__(self, pos=(0, 0, 0), homed=True, offset_z=-50.0):
        self.pos = dict(zip('xyz', pos)); self.homed = homed
        self.vars = {'offset_z': offset_z, 'cycle': 'idle',
                     # motors 0..2 = x, y, z, set as on the Onefinity (1.34.4):
                     # 10 / 10 / 3 m/min, 750 km/min^2, 1000 km/min^3
                     '0vm': 10, '0am': 750, '0jm': 1000, '1vm': 10, '1am': 750, '1jm': 1000,
                     '2vm': 3, '2am': 750, '2jm': 1000}
    def is_axis_homed(self, a): return self.homed
    def get_position(self): return dict(self.pos)
    def get(self, k, d=None): return self.vars.get(k, d)
    def set(self, k, v): self.vars[k] = v
    def find_motor(self, a): return 'xyz'.index(a) if a in 'xyz' else None
    def get_soft_limit_vector(self, var, default):
        v = {'tm': {'x': 410, 'y': 410, 'z': 0}, 'tn': {'x': 0, 'y': 0, 'z': -133}}[var]
        return v if self.homed else dict((a, default) for a in v)


class Ctrl:
    def __init__(self, prefs, **kw):
        self.dir = tempfile.mkdtemp()
        self.state = State(**kw); self.log = Log()
        self.write(prefs)
    def write(self, prefs):
        with open(os.path.join(self.dir, 'prefs.json'), 'w') as f: json.dump(prefs, f)
    def get_path(self, name, filename=None): return os.path.join(self.dir, filename) if filename else self.dir


# Setter at machine X 374.7, Y 374.7; reference: setter top at work Z +8 with Z offset -50
SETTER = {'x': 374.7, 'y': 374.7, 'z': -40, 'keep': 30,
          'ref': {'ref': 8.0, 'offZ': -50.0, 'time': 1, 'by': 'tool', 'f': 2}}
def prefs(**kw): s = dict(SETTER); s.update(kw); return {'setter': s}


# ---------------------------------------------------------------- 1. geometry
c = (0.0, 0.0); R = 10.0
check('line through the column below the top hits', SG.segment_hits((-30, 0, -5), (30, 0, -5), *c, R, 0) == -5)
check('line beside the column misses', SG.segment_hits((-30, 11, -5), (30, 11, -5), *c, R, 0) is None)
check('line over the column above the top misses', SG.segment_hits((-30, 0, 5), (30, 0, 5), *c, R, 0) is None)
check('line ending short of the column misses', SG.segment_hits((-30, 0, -5), (-11, 0, -5), *c, R, 0) is None)
check('ramp that is above the top over the column misses', SG.segment_hits((-30, 0, 10), (30, 0, 9), *c, R, 0) is None)
check('ramp that dips into the column hits', SG.segment_hits((-30, 0, 5), (30, 0, -5), *c, R, 0) is not None)
check('plunge inside the column hits', SG.segment_hits((2, 2, 5), (2, 2, -5), *c, R, 0) == -5)
check('plunge outside the column misses', SG.segment_hits((20, 0, 5), (20, 0, -50), *c, R, 0) is None)
check('leaving: straight up is allowed', SG.leaving_ok((1, 1, -5), (1, 1, 5), *c, 0))
check('leaving: up and away is allowed', SG.leaving_ok((1, 1, -5), (20, 20, 0), *c, 0))
check('leaving: down is not allowed', not SG.leaving_ok((1, 1, -5), (20, 20, -6), *c, 0))
check('leaving: across the center is not allowed', not SG.leaving_ok((5, 0, -5), (-20, 0, -5), *c, 0))


# ---------------------------------------------------------------- 2. settings
check('no setter saved -> off', SG.settings_from_prefs({}) is None and SG.settings_from_prefs(None) is None)
s = SG.settings_from_prefs(prefs())
check('defaults filled in', s['allow'] == 3.2 and s['safe_drop'] == 5 and s['z_margin'] == 2 and s['installed'], s)
s = SG.settings_from_prefs(prefs(installed=False, keep=40, allow=6.35, safeDrop=12, zMargin=3))
check('every setting is configurable', (s['installed'], s['keep'], s['allow'], s['safe_drop'], s['z_margin']) == (False, 40, 6.35, 12, 3), s)
s = SG.settings_from_prefs(prefs(keep=-1, allow='x'))
check('bad values fall back to defaults', s['keep'] == 30 and s['allow'] == 3.2, s)

z, how = SG.limit_z(SG.settings_from_prefs(prefs()), -50.0, 0)
check('with a valid reference the top follows the tool', how == 'ref' and abs(z - (8 - 50 + 2)) < 1e-9, (z, how))
z, how = SG.limit_z(SG.settings_from_prefs(prefs()), -45.0, 0)
check('Z zero changed: falls back to the top of Z travel', how == 'top' and z == -5, (z, how))
z, how = SG.limit_z(SG.settings_from_prefs(prefs(ref=None)), -50.0, 0)
check('no reference: top of Z travel', how == 'top' and z == -5)
# 1.34.3: a reference saved before 1.34.3 holds the machine Z of the touch: never used
old = dict(SETTER['ref']); old.pop('f')
z, how = SG.limit_z(SG.settings_from_prefs(prefs(ref=old)), -50.0, 0)
check('old-format reference is ignored (top of Z travel)', how == 'top' and z == -5, (z, how))
# The machine's real numbers: touch at machine -61.792 with Z offset -111.782 -> work 49.99,
# so nothing may pass lower than machine -59.792 (2 mm over the setter's top).
real = {'ref': -61.792 - -111.782, 'offZ': -111.782, 'time': 1, 'by': 'tool', 'f': 2}
z, how = SG.limit_z(SG.settings_from_prefs(prefs(ref=real)), -111.782, 0)
check('real machine: limit 2 mm above the setter top', how == 'ref' and abs(z - -59.792) < 1e-9, (z, how))


# ---------------------------------------------------------------- 3. guard on planned moves
def raises(g, a, b):
    try: g.check_line(a, b); return None
    except RuntimeError as e: return str(e)

ctrl = Ctrl(prefs())
g = SG.SetterGuard(ctrl)
low, high = -60.0, -30.0   # machine Z: tip at work -10 and +20 (limit is -40)
msg = raises(g, {'x': 300, 'y': 374.7, 'z': low}, {'x': 410, 'y': 374.7, 'z': low})
check('low move across the setter is refused', msg and 'Tool setter guard' in msg, msg)
check('the refusal says how to fix it', msg and 'Raise Z' in msg and 'removed' in msg)
check('high move across the setter is fine', raises(g, {'x': 300, 'y': 374.7, 'z': high}, {'x': 410, 'y': 374.7, 'z': high}) is None)
check('low move elsewhere is fine', raises(g, {'x': 0, 'y': 0, 'z': low}, {'x': 300, 'y': 300, 'z': low}) is None)
check('cutter allowance counts: 31 mm off center is too close', raises(g, {'x': 300, 'y': 374.7 - 31, 'z': low}, {'x': 410, 'y': 374.7 - 31, 'z': low}) is not None)
check('34 mm off center clears 30 + 3.2', raises(g, {'x': 300, 'y': 374.7 - 34, 'z': low}, {'x': 410, 'y': 374.7 - 34, 'z': low}) is None)
check('plunging onto the setter is refused', raises(g, {'x': 374.7, 'y': 374.7, 'z': high}, {'x': 374.7, 'y': 374.7, 'z': low}) is not None)
check('missing axes in the target keep the start value', raises(g, {'x': 300, 'y': 374.7, 'z': low}, {'x': 410}) is not None)
check('starting low over the setter, going straight up is allowed', raises(g, {'x': 374.7, 'y': 374.7, 'z': low}, {'x': 374.7, 'y': 374.7, 'z': 0}) is None)

ctrl.write(prefs(installed=False)); g.reload()
check('marked removed: the same move is allowed', raises(g, {'x': 300, 'y': 374.7, 'z': low}, {'x': 410, 'y': 374.7, 'z': low}) is None)
ctrl.write(prefs(x=50, y=50)); g.reload()
check('a different location is honoured', raises(g, {'x': 0, 'y': 50, 'z': low}, {'x': 100, 'y': 50, 'z': low}) is not None
      and raises(g, {'x': 300, 'y': 374.7, 'z': low}, {'x': 410, 'y': 374.7, 'z': low}) is None)
ctrl.write(prefs(ref=None)); g.reload()
check('no reference: -30 is too low', raises(g, {'x': 300, 'y': 374.7, 'z': -30}, {'x': 410, 'y': 374.7, 'z': -30}) is not None)
check('no reference: -4 (within 5 of the top) is fine', raises(g, {'x': 300, 'y': 374.7, 'z': -4}, {'x': 410, 'y': 374.7, 'z': -4}) is None)
ctrl2 = Ctrl(prefs(), homed=False)
check('not homed: off (positions unknown)', SG.SetterGuard(ctrl2).zone() is None)


# ---------------------------------------------------------------- 4. planner
class FakeGplan:
    def __init__(self, blocks=()): self.blocks = list(blocks)
    def load_string(self, *a): pass
    def load(self, *a): pass
    def set_position(self, p): pass
    def stop(self): self.blocks = []
    def has_more(self): return bool(self.blocks)
    def next(self): return self.blocks.pop(0)
class CmdQ:
    def enqueue(self, *a): pass
    def clear(self): pass

def planner(ctrl):
    p = Planner.__new__(Planner)
    p.ctrl = ctrl; p.log = ctrl.log; p.cmdq = CmdQ(); p.planner = FakeGplan()
    p._position_dirty = False; p.where = ''; p.dry_lift = 0.0; p.dry_zmax = None
    p.spindle = 0.0; p.mist_follow = False; p.mist_wanted = False; p.mist_out = False
    p.guard_pos = None; p.guard_exempt = False; p.seek_line = None
    p.plan_time = 0; p.move_time = 0; p.move_start = 0; p.current_plan_time = 0
    p.get_config = lambda *a: {}
    p._begin_spindle = lambda: None; p._begin_mist = lambda *a: None
    p._enqueue_line_time = lambda b: None
    return p

def line(id, x, y, z):
    return {'type': 'line', 'id': id, 'target': {'x': x, 'y': y, 'z': z}, 'exit-vel': 0,
            'max-accel': 1, 'max-jerk': 1, 'times': [0] * 7, 'speeds': []}

ctrl = Ctrl(prefs(), pos=(300, 374.7, high))
ctrl.setter_guard = SG.SetterGuard(ctrl)
p = planner(ctrl)
p.mdi('G0 Z-60\nG0 X410')
p.planner.blocks = [line(1, 300, 374.7, low), line(2, 410, 374.7, low), line(3, 0, 0, low)]
sent = []
while True:
    c = p.next()
    if c is None: break
    sent.append(c)
check('MDI: the move before the setter is sent', len(sent) == 1, sent)
check('MDI: the clashing move and everything after it are dropped', not p.planner.blocks)
check('MDI: the refusal is logged as an error', any(l[0] == 'error' and 'Tool setter guard' in l[1] for l in ctrl.log.lines))

ctrl.log.lines = []
p = planner(ctrl)
p.mdi('(Tool setter: measure tool)\nG21\nG53 G0 X374.7 Y374.7')
p.planner.blocks = [line(1, 374.7, 374.7, high), line(2, 374.7, 374.7, low)]
n = 0
while p.next() is not None: n += 1
check('the setter routine itself is exempt', n == 2 and not any(l[0] == 'error' for l in ctrl.log.lines), ctrl.log.lines)

p = planner(ctrl)
p.mdi('G28.2 X0', with_limits=False)
check('homing is exempt', p.guard_exempt)
p.mdi('G0 X1')
check('the next MDI is checked again', not p.guard_exempt)

ctrl.log.lines = []
p = planner(ctrl)
p.load('job.nc')
p.planner.blocks = [line(1, 300, 374.7, high), line(2, 410, 374.7, high)]
n = 0
while p.next() is not None: n += 1
check('program staying high over the setter runs', n == 2 and not any(l[0] == 'error' for l in ctrl.log.lines))

ctrl.log.lines = []
p = planner(ctrl)
p.load('job.nc')
p.dry_lift = 25.0; p.dry_zmax = 0
p.planner.blocks = [line(1, 300, 374.7, low), line(2, 410, 374.7, low)]
n = 0
while p.next() is not None: n += 1
check('dry run: checked where the machine really goes (lifted clear)', n == 2 and not any(l[0] == 'error' for l in ctrl.log.lines), ctrl.log.lines)

ctrl.log.lines = []
p = planner(ctrl)
p.load('job.nc')
p.dry_lift = 10.0; p.dry_zmax = 0
p.planner.blocks = [line(1, 300, 374.7, low), line(2, 410, 374.7, low)]
n = 0
while p.next() is not None: n += 1
check('dry run lifted too little is still refused', n == 1 and any(l[0] == 'error' for l in ctrl.log.lines))


# ---------------------------------------------------------------- 5. velocity jog
ctrl = Ctrl(prefs())
g = SG.SetterGuard(ctrl)
def jog(pos, axes): return g.filter_jog(axes, dict(zip('xyz', pos)))

out, why = jog((100, 374.7, low), {'x': 1.0})
check('far away: full-speed jog untouched', out == {'x': 1.0} and why is None, (out, why))
out, why = jog((310, 374.7, low), {'x': 1.0})
check('close and low, full speed toward the setter: stopped', out['x'] == 0 and why == 'xy', (out, why))
out, why = jog((310, 374.7, low), {'x': 0.05})
check('same spot at 5% speed: still allowed (stops in time)', out['x'] == 0.05 and why is None, (out, why))
out, why = jog((338, 374.7, low), {'x': 0.05})
check('5% speed right at the edge: stopped', out['x'] == 0 and why == 'xy', (out, why))
out, why = jog((310, 374.7, low), {'x': -1.0})
check('moving away: allowed', out['x'] == -1.0 and why is None)
out, why = jog((310, 374.7, high), {'x': 1.0})
check('high enough: allowed over it', out['x'] == 1.0 and why is None)
out, why = jog((374.7, 374.7, -38), {'z': -0.5})
check('Z down onto the setter: stopped', out['z'] == 0 and why == 'z', (out, why))
out, why = jog((374.7, 374.7, -38), {'z': 0.5})
check('Z up over the setter: allowed', out['z'] == 0.5)
out, why = jog((100, 374.7 + 60, low), {'x': 1.0})
check('full speed past it, 60 mm to the side: allowed (the line misses it)', out['x'] == 1.0 and why is None, (out, why))
out, why = jog((250, 374.7 + 25, low), {'x': 1.0})
check('full speed with the line clipping its edge: stopped', out['x'] == 0 and why == 'xy', (out, why))
out, why = jog((250, 250, low), {'x': 1.0, 'y': 1.0})
check('full speed diagonally at it: stopped', out['x'] == 0 and out['y'] == 0, (out, why))
out, why = jog((310, 374.7, low), {'x': 1.0, 'z': 0.3})
check('only the offending axes are zeroed', out['x'] == 0 and out['z'] == 0.3, out)
ctrl.write(prefs(installed=False)); g.reload()
out, why = jog((310, 374.7, low), {'x': 1.0})
check('marked removed: jog untouched', out['x'] == 1.0 and why is None)

lim = g._axis_limits('x')
check('jerk read as mm/s^3: 1000 km/min^3 is 4630 mm/s^3', abs(lim[2] - 1e9 / 216000) < 1e-6, lim)
stop = SG.SetterGuard.stopping(*lim)
check('stopping distance at full speed covers latency and braking (165-185 mm)', 165 < stop < 185, stop)


# ---------------------------------------------------------------- 6. jog watcher in Mach
from bbctrl.Mach import Mach
from bbctrl import Cmd

class Loop:
    def __init__(self): self.pending = []
    def call_later(self, t, cb): self.pending.append(cb); return cb
    def remove_timeout(self, h):
        if h in self.pending: self.pending.remove(h)
    def run_one(self):
        cb = self.pending.pop(0); cb()

sentq = []
Mach.__mro__[1].queue_command = lambda self, cmd: sentq.append(cmd)  # Comm
ctrl = Ctrl(prefs(), pos=(100, 374.7, low))
ctrl.ioloop = Loop(); ctrl.setter_guard = SG.SetterGuard(ctrl)
m = Mach.__new__(Mach)
m.ctrl = ctrl; m.mlog = ctrl.log
m._begin_cycle = lambda c: ctrl.state.set('cycle', c)
m.planner = type('P', (), {'position_change': lambda self: None})()
m.jog({'x': 1.0, 'ts': 1})
check('jog far from the setter is sent as asked', sentq[-1] == Cmd.jog({'x': 1.0}), sentq)
check('a watcher is scheduled while jogging', len(ctrl.ioloop.pending) == 1)
ctrl.state.pos['x'] = 300           # the machine has moved closer
ctrl.ioloop.run_one()
check('watcher zeroes X when the jog gets close', sentq[-1] == Cmd.jog({'x': 0}), sentq[-1])
check('the screens are told why', any(l[0] == 'warning' and 'Tool setter guard' in l[1] for l in ctrl.log.lines))
check('watcher keeps running', len(ctrl.ioloop.pending) == 1)
n = len(sentq); ctrl.ioloop.run_one()
check('no repeat command while nothing changes', len(sentq) == n)
m.jog({'x': 0, 'ts': 2})
check('releasing the jog stops the watcher', not ctrl.ioloop.pending)

done()
