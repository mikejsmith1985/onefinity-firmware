# Homing id (1.42.0).   python3 src/py/tests/test_home_id.py
# Each time X or Y is homed the controller sets a new state value home_at. The screens compare it
# with the homing their last homing check was made on, so they know when a check is due.
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bbstub import check, done
import bbctrl
from bbctrl.Mach import Mach
Comm = Mach.__mro__[1]

class St:
    def __init__(s): s.vars = {}
    def get(s, k, d=None): return s.vars.get(k, d)
    def set(s, k, v): s.vars[k] = v
    def is_axis_enabled(s, a): return True
    def axis_homing_mode(s, a): return 'manual' if a == 'b' else 'stall-min'
    def axis_home_fail_reason(s, a): return None if a in 'xyz' else 'disabled'
class Log:
    def info(s, *a): pass
    def error(s, *a): pass
class P:
    def __init__(s): s.sent = []
    def mdi(s, g, w): s.sent.append(g)
class C: pass

def mach():
    m = Mach.__new__(Mach)
    m.ctrl = C(); m.ctrl.state = St(); m.mlog = Log(); m.planner = P()
    m._begin_cycle = lambda c: None
    return m
Comm.resume = lambda self: None

m = mach(); m.home(None)
a = m.ctrl.state.get('home_at')
check('homing all sets home_at', isinstance(a, int) and a > 0, a)
check('  and homes X, Y and Z', len(m.planner.sent) == 3, len(m.planner.sent))
import time; time.sleep(0.01)
m.home(None)
check('homing again gives a new id', m.ctrl.state.get('home_at') != a, (a, m.ctrl.state.get('home_at')))
m2 = mach(); m2.home(ord('z'))
check('homing only Z leaves it alone (X/Y positions unchanged)', m2.ctrl.state.get('home_at') is None)
m3 = mach(); m3.home(ord('y'))
check('homing only Y sets it', m3.ctrl.state.get('home_at') is not None)
done()
