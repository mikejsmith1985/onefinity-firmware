# Work zero kept across restarts, and restored from an interrupted job (1.27.2).
#   python3 src/py/tests/test_zero_memory.py
import sys, os, types, importlib.abc, importlib.machinery
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

class _Stub(types.ModuleType):
    def __getattr__(self, name):
        if name.startswith('__'): raise AttributeError(name)
        return type(name, (object,), {'__init__': lambda s, *a, **k: None})
class _Finder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    MISSING = ('pyudev', 'evdev', 'iw_parse', 'smbus', 'sockjs', 'camotics', 'gplan', 'smbus', 'smbus2', 'RPi', 'pwd')
    def find_spec(self, name, path, target=None):
        if name.split('.')[0] in self.MISSING:
            return importlib.machinery.ModuleSpec(name, self, is_package=True)
    def create_module(self, spec): return _Stub(spec.name)
    def exec_module(self, m): pass
sys.meta_path.insert(0, _Finder())
import tornado.websocket, tornado.web, tornado.ioloop
tornado.web.asynchronous = getattr(tornado.web, "asynchronous", lambda f: f)  # old tornado API used by Camera.py
import warnings; warnings.filterwarnings('ignore')
import bbctrl
MachMod = sys.modules['bbctrl.Mach']; ResumeMod = sys.modules['bbctrl.Resume']

ok = True
def check(name, cond, msg=''):
    global ok; print(('PASS ' if cond else 'FAIL ') + name, msg); ok &= bool(cond)

class State:
    def __init__(s, v, homed='xyz'): s.v = dict(v); s.homed = homed
    def get(s, k, d=None): return s.v.get(k, d)
    def is_axis_homed(s, a): return a in s.homed
class Config:
    def __init__(s, v): s.values = dict(v); s.saved = []
    def get(s, k, d=None): return s.values.get(k, d)
    def set(s, name, vals): s.saved.append(vals); s.values.update(vals)
class Log:
    def info(s, *a): pass
    def exception(s, *a): raise
class Ctrl: pass

def mach(state, config, cycle='idle'):
    m = MachMod.Mach.__new__(MachMod.Mach)
    c = Ctrl(); c.state = state; c.config = config; m.ctrl = c; m.log = Log()
    m._get_cycle = lambda: cycle
    return m

# 1. A probe set a new zero: it is written to the config so homing after a restart restores it
cfg = Config({'offset_x': 188.322, 'offset_y': 146.319, 'offset_z': -55.036})
m = mach(State({'offset_x': 163.142, 'offset_y': 217.435, 'offset_z': -58.989}), cfg)
m._remember_offsets()
check('probed zero remembered', cfg.values == {'offset_x': 163.142, 'offset_y': 217.435, 'offset_z': -58.989}, cfg.saved)
# 2. Nothing changed: no config write
m._remember_offsets(); check('unchanged zero: no extra save', len(cfg.saved) == 1)
# 3. Just after a restart every offset reads 0: never store that over the real zero
m = mach(State({'offset_x': 0, 'offset_y': 0, 'offset_z': 0}), cfg); m._remember_offsets()
check('zeros after restart are not stored', len(cfg.saved) == 1 and cfg.values['offset_x'] == 163.142)
# 4. Unhomed axes are left alone
m = mach(State({'offset_x': 10, 'offset_y': 20, 'offset_z': -5}, homed='xy'), cfg); m._remember_offsets()
check('unhomed Z left alone', cfg.values['offset_z'] == -58.989 and cfg.values['offset_x'] == 10)
# 5. Not idle: nothing
cfg2 = Config({}); m = mach(State({'offset_x': 1, 'offset_y': 2, 'offset_z': -3}), cfg2, cycle='running'); m._remember_offsets()
check('not idle: nothing stored', cfg2.saved == [])

# 5b. (1.29.0) A zero set exactly on machine 0 after a real one is remembered;
#     a 0 read straight after a restart (no real zero seen yet) still is not
cfg3 = Config({'offset_x': 12.5, 'offset_y': 7.0, 'offset_z': -40.0})
st3 = State({'offset_x': 12.5, 'offset_y': 7.0, 'offset_z': -40.0}); m = mach(st3, cfg3); m._remember_offsets()
st3.v['offset_x'] = 0.0; m._remember_offsets()
check('exact 0 after a real zero is stored', cfg3.values['offset_x'] == 0.0, cfg3.saved)
st3.homed = 'yz'; m._remember_offsets(); st3.homed = 'xyz'; st3.v['offset_x'] = 0.0
cfg3.values['offset_x'] = 12.5; m._remember_offsets()
check('after the axis was unhomed, 0 is not stored again', cfg3.values['offset_x'] == 12.5)

# 6. Restore the interrupted job's zero: G92 so that the offsets equal the saved ones
class CP:
    def __init__(s, r): s.r = r
    def get(s): return s.r
sent = []
rec = {'file': 'FPR2_1.nc', 'status': 'running', 'offset': {'x': 163.142, 'y': 217.435, 'z': -58.989}}
def resume(state):
    r = ResumeMod.Resume.__new__(ResumeMod.Resume)
    c = Ctrl(); c.state = state; c.checkpoint = CP(rec)
    c.mach = types.SimpleNamespace(mdi=lambda cmd: sent.append(cmd)); r.ctrl = c; r.log = Log()
    return r
st = State({'cycle': 'idle', 'metric': True, 'xp': 0.0, 'yp': 0.0, 'zp': 0.0, 'offset_x': 188.322, 'offset_y': 146.319, 'offset_z': -55.036})
out = resume(st).restore_zero('xyz')
# G92 Xv sets offset = xp - v
words = dict((w[0].lower(), float(w[1:])) for w in sent[-1].split()[1:])
got = dict((a, st.v[a + 'p'] - words[a]) for a in 'xyz')
check('G92 puts every axis back on the saved zero', all(abs(got[a] - rec['offset'][a]) < 1e-4 for a in 'xyz'), sent[-1])
st.v.update(xp=224.455, yp=194.044, zp=-20.0); resume(st).restore_zero('xy')
words = dict((w[0].lower(), float(w[1:])) for w in sent[-1].split()[1:])
check('X/Y only leaves Z alone (cutter moved in the collet)', set(words) == {'x', 'y'} and abs(st.v['xp'] - words['x'] - 163.142) < 1e-4, sent[-1])
st.v['metric'] = False; resume(st).restore_zero('x')
words = dict((w[0].lower(), float(w[1:])) for w in sent[-1].split()[1:])
check('inch mode: G92 in inches', abs(st.v['xp'] - words['x'] * 25.4 - 163.142) < 1e-2, sent[-1])
try:
    resume(State({'cycle': 'idle', 'metric': True}, homed='xy')).restore_zero('xyz'); check('refuses when not homed', False)
except ResumeMod.ResumeError: check('refuses when not homed', True)
try:
    resume(State({'cycle': 'running', 'metric': True})).restore_zero('xyz'); check('refuses while running', False)
except ResumeMod.ResumeError: check('refuses while running', True)
print('ALL PASS' if ok else 'SOME FAILED'); sys.exit(0 if ok else 1)
