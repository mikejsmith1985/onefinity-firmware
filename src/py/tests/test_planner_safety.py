# Planner: no probing with the spindle on, optional mist-follows-cutting (1.29.0).
#   python3 src/py/tests/test_planner_safety.py
import sys, os, json, tempfile, types
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bbstub import check, done
import bbctrl
P = sys.modules['bbctrl.Planner']

tmp = tempfile.mkdtemp(); os.makedirs(os.path.join(tmp, 'next-data'))
def prefs(v):
    with open(os.path.join(tmp, 'next-data', 'prefs.json'), 'w') as f: json.dump(v, f)
class State(dict):
    def get(s, k, d=None): return dict.get(s, k, d)
    def set(s, k, v): s[k] = v
    def get_switch_id(s, sw): return 0
class Log:
    def info(s, *a): pass
    def error(s, *a): pass
class Q:
    def enqueue(s, *a): pass
def planner(state):
    p = P.Planner.__new__(P.Planner)
    p.ctrl = types.SimpleNamespace(state=State(state), get_path=lambda d=None, f=None: os.path.join(tmp, d))
    p.log = Log(); p.cmdq = Q(); p.dry_lift = 0.0; p.dry_zmax = None; p.plan_time = 0
    p.spindle = 0.0; p.mist_follow = False; p.mist_wanted = False; p.mist_out = False
    return p
enc = lambda p, b: p._Planner__encode(dict(b, id=1))
line = lambda rapid=False, seeking=False: dict(type='line', target={'z': 1}, **{'exit-vel': 0, 'max-accel': 1, 'max-jerk': 1, 'times': [1] * 7},
                                               **({'rapid': True} if rapid else {}), **({'seeking': True} if seeking else {}))
seek = dict(type='seek', switch='probe', active=True, error=True)

# 1. Spindle interlock
p = planner({'speed': 0}); p._begin_spindle()
check('probe with spindle off goes', enc(p, seek) is not None)
p = planner({'speed': 18000}); p._begin_spindle()
try: enc(p, seek); check('probe with spindle on (from state) refused', False)
except RuntimeError as e: check('probe with spindle on (from state) refused', 'M5' in str(e), str(e))
p = planner({'speed': 18000}); p._begin_spindle()
check('homing seeks are not affected', enc(p, dict(seek, switch='x-min')) is not None)
enc(p, dict(type='set', name='speed', value=0))
check('M5 earlier in the same program counts', enc(p, seek) is not None)
p = planner({'speed': 0}); p._begin_spindle(); enc(p, dict(type='set', name='speed', value=12000))
try: enc(p, seek); check('M3 earlier in the program refuses the probe', False)
except RuntimeError: check('M3 earlier in the program refuses the probe', True)
p = planner({'speed': 0}); p._begin_spindle(); enc(p, dict(line(), speeds=[[0, 9000]]))
try: enc(p, seek); check('synchronised speed change counts', False)
except RuntimeError: check('synchronised speed change counts', True)

# 2. Mist follows cutting: off by default
prefs({})
p = planner({}); p._begin_mist(True)
out = enc(p, dict(type='output', port='mist', value=1))
check('default: M7 switches mist at once', out == '#1oa=1' and not p.mist_follow)
prefs({'mistCutting': True})
p = planner({}); p._begin_mist(False)
check('never for MDI', not p.mist_follow)
p = planner({'1oa': 0}); p._begin_mist(True)
out = [enc(p, dict(type='output', port='mist', value=1)), enc(p, line(rapid=True)), enc(p, line()), enc(p, line()),
       enc(p, line(rapid=True)), enc(p, line(seeking=True)), enc(p, line()), enc(p, dict(type='output', port='mist', value=0)), enc(p, line())]
mist = [None if o is None else ('on' if o.startswith('#1oa=1') else 'off' if o.startswith('#1oa=0') else '-') for o in out]
check('M7 waits, on for cuts, off for rapids and probes, M9 off', mist == [None, '-', 'on', '-', 'off', '-', 'on', 'off', '-'], mist)
check('the switch comes before the move', out[2].startswith('#1oa=1\n') and out[2].split('\n')[1].startswith(P.Cmd.LINE))
p = planner({}); p._begin_mist(True); p.dry_lift = 30
enc(p, dict(type='output', port='mist', value=1))
check('dry run: never', enc(p, line()).startswith(P.Cmd.LINE))
done()
