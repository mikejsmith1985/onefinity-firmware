# Squareness check (1.43.0), run through the controller's planner code (simlib -> seekharness)
# against a 1-2-3 block on the bed. A machine whose X and Y aren't square sees the square block as
# a parallelogram: its corner reads 90° + eps. The block is also turned a little on the bed and the
# probe isn't started exactly over its middle.
#   python3 src/react-ui/test/square-sim.py
import os, sys, json, math, subprocess, re, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from simlib import *

ok = True
def check(name, cond, msg=''):
    global ok
    print(('PASS ' if cond else 'FAIL ') + name, msg); ok = ok and bool(cond)
def js(fn, *args):
    code = "const m=await import(process.argv[1]);process.stdout.write(JSON.stringify(m[%r](...JSON.parse(process.argv[2]))))" % fn
    return json.loads(subprocess.run(['node', '--input-type=module', '-e', code, 'file://' + S + '/../src/square.js', json.dumps(args)], capture_output=True, text=True, check=True).stdout)

class Prism:
    '''A convex polygon (machine X/Y) from z0 to z1.'''
    def __init__(s, pts, z0, z1): s.pts, s.z0, s.z1 = pts, z0, z1
    def dist(s, c):
        x, y = c[0], c[1]; n = len(s.pts); inside = True; best = 1e9
        for i in range(n):
            (ax, ay), (bx, by) = s.pts[i], s.pts[(i + 1) % n]
            if (bx - ax) * (y - ay) - (by - ay) * (x - ax) < 0: inside = False
            dx, dy = bx - ax, by - ay; t = max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
            best = min(best, math.hypot(x - ax - t * dx, y - ay - t * dy))
        dr = 0 if inside else best
        dz = max(0.0, s.z0 - c[2], c[2] - s.z1)
        return math.hypot(dr, dz)

BED_Z = -60
BED = (0, 410, 0, 410, -100, BED_Z)
TOP = -1
def block(cx, cy, a, b, turn_deg, eps_deg, h=25.4):
    t = math.radians(turn_deg); u = (math.cos(t), math.sin(t))
    tv = t + math.pi / 2 + math.radians(eps_deg); v = (math.cos(tv), math.sin(tv))
    P = lambda i, j: (cx + i * a / 2 * u[0] + j * b / 2 * v[0], cy + i * a / 2 * u[1] + j * b / 2 * v[1])
    return Prism([P(-1, -1), P(1, -1), P(1, 1), P(-1, 1)], BED_Z, BED_Z + h)

def run(a, b, obs, start, ball=2.0, noise=0, seed=1):
    prog = gen(dict(a=a, b=b, ball=ball, top=TOP, fast=200, slow=25, travel=1000), 'square.js', 'squareProgram')
    sim = Sim(start, ball / 2, obs); sim.probe_frame = 'machine'
    if noise: sim.noise = noise; sim.rng = random.Random(seed)
    sim.run(prog)
    r = dict(('ofq_' + k[5:], v) for k, v in sim.vars.items() if k.startswith('_ofq_'))
    return sim, r, prog

A, B = 76.2, 50.8
CX, CY = 200, 150
# 1. Exact: the result is the skew put in, whatever the block's turn and the start position
for eps in (0, 0.03, -0.1, 0.25):
    for turn, start in ((0, (CX, CY)), (2.5, (CX + 3, CY - 2)), (-3, (CX - 5, CY + 4))):
        sim, r, prog = run(A, B, [BED, block(CX, CY, A, B, turn, eps)], (start[0], start[1], BED_Z + 25.4 + 6))
        res = js('squareResult', r, dict(a=A, b=B, ball=2.0))
        good = 'error' not in res and abs(res['deg'] - eps) < 0.004 and abs(res['w'] - A) < 0.02 and abs(res['l'] - B) < 0.02
        check('skew %+.2f deg, block turned %+.1f deg, started %+g,%+g off: skew within 0.004 deg (the simulator finds contact in 2 micron steps), size within 0.02 mm' % (eps, turn, start[0] - CX, start[1] - CY), good,
              res.get('error') or 'reads %+.4f deg (%+.3f mm over 400), %.3f x %.3f mm' % (res['deg'], res['drift400'], res['w'], res['l']))
        check('  ends at the top of Z, over the block', abs(sim.P[2] - TOP) < 1e-6 and math.hypot(sim.P[0] - start[0], sim.P[1] - start[1]) < 1e-6, sim.P)
check('no if/else in the program', not re.search(r'^o\d+ else', prog, re.M))
# 2. The 3 in side along Y
sim, r, _ = run(B, A, [BED, block(CX, CY, B, A, 1, 0.05)], (CX, CY, BED_Z + 31.4))
res = js('squareResult', r, dict(a=B, b=A, ball=2.0))
check('3 in side along Y: right skew and size', 'error' not in res and abs(res['deg'] - 0.05) < 0.004 and abs(res['w'] - B) < 0.01, res)
# 3. With the probe's real scatter (3 microns per touch): how well one run does
errs = []
for seed in range(12):
    _, r, _ = run(A, B, [BED, block(CX, CY, A, B, 1.5, 0.03)], (CX, CY, BED_Z + 31.4), noise=0.003, seed=seed)
    res = js('squareResult', r, dict(a=A, b=B, ball=2.0)); errs.append(res['drift400'] - 400 * math.tan(math.radians(0.03)))
check('touches scattered by 3 microns: one run within 0.15 mm over 400 mm (so the screen averages 3)', max(map(abs, errs)) < 0.15, 'worst %.3f mm' % max(map(abs, errs)))
target = 400 * math.tan(math.radians(0.03))
avgs = [sum(errs[i:i + 3]) / 3 for i in range(0, 12, 3)]
check('  the average of 3 runs: within 0.08 mm over 400 mm', max(map(abs, avgs)) < 0.08, 'worst %.3f mm' % max(map(abs, avgs)))
avg = js('squareAverage', [{'eps': math.atan((e + target) / 400), 'drift400': e + target} for e in errs[:3]])
check('  squareAverage agrees', abs(avg['drift400'] - (target + avgs[0])) < 1e-6, avg)
# 4. A clamp right beside the block: stops going down (2), touches nothing unguarded
sim, r, _ = run(A, B, [BED, block(CX, CY, A, B, 0, 0), (CX + 49, CX + 55, CY - 20, CY - 10, BED_Z, BED_Z + 30)], (CX, CY, BED_Z + 31.4))
check('a clamp beside the block: stops going down (2)', r.get('ofq_ok') == 0 and r.get('ofq_fail') == 2, r.get('ofq_fail'))
check('  and goes up to the top of Z', abs(sim.P[2] - TOP) < 1e-6)
check('  the result says why', 'error' in js('squareResult', r, dict(a=A, b=B, ball=2.0)))
# 5. Something tall in the way of the travel: stops (1)
sim, r, _ = run(A, B, [BED, block(CX, CY, A, B, 0, 0), (CX - 30, CX - 20, CY - 45, CY - 35, BED_Z, BED_Z + 60)], (CX, CY, BED_Z + 31.4))
check('something tall on the way: stops (1)', r.get('ofq_ok') == 0 and r.get('ofq_fail') == 1, r.get('ofq_fail'))
# 6. The block moved between touches (a parallelogram whose opposite sides aren't parallel): caught
class Moved(Prism): pass
pts = block(CX, CY, A, B, 0, 0).pts; pts[2] = (pts[2][0], pts[2][1] + 0.3)   # back-right corner 0.3 mm off
sim, r, _ = run(A, B, [BED, Prism(pts, BED_Z, BED_Z + 25.4)], (CX, CY, BED_Z + 31.4))
res = js('squareResult', r, dict(a=A, b=B, ball=2.0))
check('opposite sides not parallel (the block moved, or dirt): refused', 'error' in res and 'parallel' in res['error'], res.get('error'))
print('ALL PASS' if ok else 'SOME FAILED'); sys.exit(0 if ok else 1)
