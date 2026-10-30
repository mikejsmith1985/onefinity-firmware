# Why the controller E-stopped (1.48.0).   python3 src/py/tests/test_estop_why.py
# After a probe touch that finds nothing, the controller E-stops itself and the motion board
# reports it as "User triggered EStop", so the screens said "You pressed E-stop". The controller
# now sets estop_why, and Clear E-stop clears it.
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
class C: pass
m = Mach.__new__(Mach); m.ctrl = C(); m.ctrl.state = St()
calls = []
m.estop = lambda: calls.append('estop')
m.process_log({'msg': 'Switch not found', 'level': 'warning'})
check('switch not found: E-stop, and why', calls == ['estop'] and m.ctrl.state.get('estop_why') == 'Switch not found')
m.process_log({'msg': 'something else', 'level': 'info'})
check('other messages: no E-stop', calls == ['estop'])
m._is_estopped = lambda: False
m.clear()
check('Clear E-stop clears why', m.ctrl.state.get('estop_why') == '')
done()
