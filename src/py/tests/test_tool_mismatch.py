# Router program while the Laser is selected (1.35.1).   python3 src/py/tests/test_tool_mismatch.py
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bbstub import check, done
import bbctrl
L = sys.modules['bbctrl.Lint']

ROUTER = ['(SETUP router: Makita dial 3)', 'G21 G90', 'G0 Z5', 'M3 S17000', 'G1 X10 F500', 'M5', 'M30']
LASER = ['G21 G90', 'G0 Z5', 'M3 S800', 'G1 X10 F500', 'M5', 'M30']
NOSHEET = ['G21 G90', 'G0 Z5', 'M3 S17000', 'G1 X10 F500', 'M5', 'M30']

def res(lines):
    r = L.lint_lines(lines)
    import bbctrl.GCodeText as T
    r['setup'] = dict(T.setup_fields(lines))
    return r

laser = {'selected-tool': 'laser', 'max-spin': 1000}
router = {'selected-tool': 'router', 'max-spin': 30000}
check('max S recorded', res(ROUTER)['max_speed'] == 17000)
m = L.tool_mismatch(laser, res(NOSHEET))
check('laser + S17000: stop', m and 'WRONG TOOL' in m and 'S17000' in m, m)
m = L.tool_mismatch(laser, res(ROUTER))
check('laser + router sheet: stop', m is not None)
check('laser + laser program (S800): no stop', L.tool_mismatch(laser, res(LASER)) is None)
check('router selected: no stop', L.tool_mismatch(router, res(ROUTER)) is None)
check('disabled tool: no stop', L.tool_mismatch({'selected-tool': 'disabled'}, res(ROUTER)) is None)
check('old cached result without max_speed: router sheet still caught', L.tool_mismatch(laser, {'setup': {'router': 'x'}}) is not None)

class Cfg:
    def __init__(self, d): self.d = d
    def get(self, k, default=None): return self.d.get(k, default)
class Ctrl:
    def __init__(self, d): self.config = Cfg(d)
    def get_path(self, *a): return '/nonexistent'
stops = L._stops(Ctrl(laser), dict(res(NOSHEET), errors=0))
check('start refused with key tool', [s['key'] for s in stops] == ['tool'])
check('start allowed with the router', L._stops(Ctrl(router), dict(res(NOSHEET), errors=0)) == [])
done()
