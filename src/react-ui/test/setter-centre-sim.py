# Finding the tool setter's centre with the 3D probe (1.40.0), run through the controller's
# planner code (simlib -> seekharness) against a round setter: body and cap as cylinders.
# Checks the centre found, that no move hits anything unguarded, and the failure stops.
#   python3 src/react-ui/test/setter-centre-sim.py
import os, sys, json, math, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from simlib import *

class Cyl:
    def __init__(s, cx, cy, r, z0, z1): s.cx, s.cy, s.r, s.z0, s.z1 = cx, cy, r, z0, z1
    def dist(s, c):
        dr = max(0.0, math.hypot(c[0] - s.cx, c[1] - s.cy) - s.r)
        dz = max(0.0, s.z0 - c[2], c[2] - s.z1)
        return math.hypot(dr, dz)

CX, CY = 374.55, 374.79           # the setter's real centre
BED = (0, 410, 0, 410, -100, -60) # the spoilboard, top at machine Z -60
def setter(cx=CX, cy=CY): return [Cyl(cx, cy, 12.5, -60, -25), Cyl(cx, cy, 5, -25, -22)]  # body, then the cap 3 mm higher
TOP = -1
allok = True
def check(name, cond, msg=''):
    global allok
    print(('PASS ' if cond else 'FAIL ') + name, msg); allok &= bool(cond)
def js(fn, *args):
    code = "const m=await import(process.argv[1]);process.stdout.write(JSON.stringify(m[%r](...JSON.parse(process.argv[2]))))" % fn
    out = subprocess.run(['node', '--input-type=module', '-e', code, 'file://' + S + '/../src/setter.js', json.dumps(args)], capture_output=True, text=True, check=True).stdout
    return json.loads(out)

def run(saved, obstacles=None, ball=1.71):
    prog = gen(dict(setter=saved, top=TOP, clear=30, travel=1000, fast=200, slow=25), 'setter.js', 'setterCentreProgram')
    sim = Sim((saved['x'], saved['y'], TOP), ball / 2, obstacles if obstacles is not None else [BED] + setter())
    sim.probe_frame = 'machine'   # #5061-#5063 are machine coordinates on the controller
    sim.run(prog)
    r = dict(('ofx_' + k[5:], v) for k, v in sim.vars.items() if k.startswith('_ofx_'))
    return sim, r, prog

# 1. Saved 5 mm off (like on the machine): finds the real centre
for off in ((5, -3), (-7, 4), (0, 0), (9, 9)):
    saved = dict(x=CX + off[0], y=CY + off[1], z=-15)
    sim, r, prog = run(saved)
    c = js('setterCentre', r, saved)
    check('saved %+d,%+d mm off: centre found within 0.01 mm' % off, 'error' not in c and math.hypot(c['x'] - CX, c['y'] - CY) < 0.01,
          c if 'error' in c else '%.3f, %.3f (moved %.1f mm), body %.2f mm across' % (c['x'], c['y'], c['moved'], c['d']))
    check('  ends at the top of Z', abs(sim.P[2] - TOP) < 1e-6, sim.P)
check('the cap height (touched again over the centre) is the probe\'s touch on the setter', abs(r['ofx_cap'] - (-22)) < 0.01, r.get('ofx_cap'))
check('exempt from the setter guard like the other setter routines', prog.startswith('(Tool setter'))

# 2. Saved far off: stops with a reason, never hits anything
sim, r, _ = run(dict(x=CX + 40, y=CY, z=-15))
check('saved 40 mm off: nothing under the probe -> stops (1)', r.get('ofx_ok') == 0 and r.get('ofx_fail') == 1, r)
sim, r, _ = run(dict(x=CX + 15, y=CY + 15, z=-15))
c = js('setterCentre', r, dict(x=CX + 15, y=CY + 15))
check('saved 15 mm off (landed on the body edge): stops or finds it, no crash', 'error' in c or math.hypot(c['x'] - CX, c['y'] - CY) < 0.01, c)
# 3. Something beside the setter: stops
sim, r, _ = run(dict(x=CX, y=CY, z=-15), [BED] + setter() + [Cyl(CX + 25, CY, 3, -60, -20)])
check('a post beside it: stops (2)', r.get('ofx_ok') == 0 and r.get('ofx_fail') == 2, r)
check('  and nothing is saved from it', 'error' in js('setterCentre', r, None))
print('ALL PASS' if allok else 'SOME FAILED'); sys.exit(0 if allok else 1)
