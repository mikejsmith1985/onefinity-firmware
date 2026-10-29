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

def find(saved, obstacles=None):
    '''findSetterCentre: a second pass from the new centre when the first moved it more than 2 mm.'''
    sim, r, prog = run(saved, obstacles)
    c = js('setterCentre', r, saved); c['passes'] = 1
    if 'error' in c or c['moved'] <= 2: return sim, c, prog
    s2 = dict(saved, x=c['x'], y=c['y'])
    sim, r, prog = run(s2, obstacles)
    c2 = js('setterCentre', r, s2); c2['passes'] = 2
    return sim, c2, prog

def run(saved, obstacles=None, ball=1.71):
    prog = gen(dict(setter=saved, top=TOP, clear=30, travel=1000, fast=200, slow=25), 'setter.js', 'setterCentreProgram')
    sim = Sim((saved['x'], saved['y'], TOP), ball / 2, obstacles if obstacles is not None else [BED] + setter())
    sim.probe_frame = 'machine'   # #5061-#5063 are machine coordinates on the controller
    sim.run(prog)
    r = dict(('ofx_' + k[5:], v) for k, v in sim.vars.items() if k.startswith('_ofx_'))
    return sim, r, prog

POST = Cyl(CX, CY + 22, 4, -60, -19)   # the setter's air-nozzle post behind it, 3 mm above the cap (on the machine)
# 1. Saved a few mm off (on the machine: about 1 mm in X), with and without the post
for post in (False, True):
    for off in ((1.05, 0), (5, -3), (-7, 4), (0, 0), (9, 9)):
        saved = dict(x=CX + off[0], y=CY + off[1], z=-15)
        sim, c, prog = find(saved, [BED] + setter() + ([POST] if post else []))
        far = math.hypot(*off) > 10   # past what it promises (roughly right: within about 10 mm)
        check('%s saved %+g,%+g mm off: %s' % ('post behind,' if post else 'no post,', off[0], off[1], 'right centre, or stops with nothing saved' if far else 'centre within 0.01 mm'),
              ('error' not in c and math.hypot(c['x'] - CX, c['y'] - CY) < 0.01) or (far and 'error' in c),
              c if 'error' in c else '%.3f, %.3f, %d touches (%d skipped), %d pass(es)' % (c['x'], c['y'], c['used'], c['skipped'], c['passes']))
        check('  ends at the top of Z', abs(sim.P[2] - TOP) < 1e-6, sim.P)
check('exempt from the setter guard like the other setter routines', prog.startswith('(Tool setter'))
# 2. Things in the way of several directions: skipped while 3 or more are left
blocks = [Cyl(CX + 24, CY, 3, -60, -10), Cyl(CX - 24, CY + 4, 3, -60, -10), POST]
sim, c, _ = find(dict(x=CX + 2, y=CY - 1, z=-15), [BED] + setter() + blocks)
check('three things around it: their directions skipped, centre still right', 'error' not in c and math.hypot(c['x'] - CX, c['y'] - CY) < 0.01, c)
# 3. A block right against the body on one side: that touch is off the circle and dropped
sim, r, _ = run(dict(x=CX, y=CY, z=-15), [BED] + setter() + [(CX - 15, CX - 13.2, CY - 20, CY - 6, -60, -30)])
c = js('setterCentre', r, dict(x=CX, y=CY))
check('a block against the body: its touch dropped, centre still right (or nothing saved)', ('error' in c) or math.hypot(c['x'] - CX, c['y'] - CY) < 0.01, c)
# 4. Saved far off: stops with a reason, never hits anything
sim, r, _ = run(dict(x=CX + 40, y=CY, z=-15))
check('saved 40 mm off: nothing under the probe -> stops (1)', r.get('ofx_ok') == 0 and r.get('ofx_fail') == 1, r)
# 4b. Something sitting on top of the setter (on the machine the probe touched 40 mm above the cap): stops (4)
# (saved height 23 mm below the cap, as on the machine with the cutter it was saved with: so only
# a touch more than 7 mm above the cap counts as something else here)
sim, r, _ = run(dict(x=CX, y=CY, z=-45), [BED] + setter() + [Cyl(CX, CY, 6, -22, -5)])
check('(the setter alone, saved like that, still works)', run(dict(x=CX, y=CY, z=-45))[1].get('ofx_ok') == 1)
check('something on top of the setter: stops (4), nothing saved', r.get('ofx_fail') == 4 and 'error' in js('setterCentre', r, None), r)
check('  and ends at the top of Z (1.40.0 lifted 10 mm from the touch and went past the limit)', abs(sim.P[2] - TOP) < 1e-6, sim.P)
# 5. Everything blocked: nothing saved
ring = [Cyl(CX + 25 * math.cos(a * math.pi / 4), CY + 25 * math.sin(a * math.pi / 4), 3, -60, -10) for a in range(8)]
sim, r, _ = run(dict(x=CX, y=CY, z=-15), [BED] + setter() + ring)
check('every direction blocked: nothing saved', 'error' in js('setterCentre', r, None))
print('ALL PASS' if allok else 'SOME FAILED'); sys.exit(0 if allok else 1)
