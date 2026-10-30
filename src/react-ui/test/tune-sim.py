# Hands-off probe tuning (1.48.0): the whole program (stylus calibration x3, squareness x3) run
# through the controller's planner code (simlib -> seekharness) on a 1-2-3 block that a slightly
# skewed machine sees as a parallelogram. Then the results worked out as the screen does.
#   python3 src/react-ui/test/tune-sim.py
import os, sys, json, math, re, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from simlib import *

ok = True
def check(name, cond, msg=''):
    global ok
    print(('PASS ' if cond else 'FAIL ') + name, msg); ok = ok and bool(cond)
def js(fn, *args):
    code = "const m=await import(process.argv[1]);process.stdout.write(JSON.stringify(m[%r](...JSON.parse(process.argv[2]))))" % fn
    return json.loads(subprocess.run(['node', '--input-type=module', '-e', code, 'file://' + S + '/../src/tune.js', json.dumps(args)], capture_output=True, text=True, check=True).stdout)

class Prism:
    def __init__(s, pts, z0, z1): s.pts, s.z0, s.z1 = pts, z0, z1
    def dist(s, c):
        x, y = c[0], c[1]; n = len(s.pts); inside = True; best = 1e9
        for i in range(n):
            (ax, ay), (bx, by) = s.pts[i], s.pts[(i + 1) % n]
            if (bx - ax) * (y - ay) - (by - ay) * (x - ax) < 0: inside = False
            dx, dy = bx - ax, by - ay; t = max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
            best = min(best, math.hypot(x - ax - t * dx, y - ay - t * dy))
        return math.hypot(0 if inside else best, max(0.0, s.z0 - c[2], c[2] - s.z1))
BED_Z = -60
BED = (0, 410, 0, 410, -100, BED_Z)
def block(cx, cy, a, b, turn, eps, h=25.4):
    t = math.radians(turn); u = (math.cos(t), math.sin(t)); tv = t + math.pi / 2 + math.radians(eps); v = (math.cos(tv), math.sin(tv))
    P = lambda i, j: (cx + i * a / 2 * u[0] + j * b / 2 * v[0], cy + i * a / 2 * u[1] + j * b / 2 * v[1])
    return Prism([P(-1, -1), P(1, -1), P(1, 1), P(-1, 1)], BED_Z, BED_Z + h)

A, B, CX, CY, TOP, TOKEN = 76.2, 50.8, 200, 150, -1, 4242
def run(obs, start, ball_true=1.95, ball_saved=2.0):
    o = dict(a=A, b=B, ball=ball_saved, start=dict(x=start[0], y=start[1], z=start[2]), top=TOP, fast=200, slow=25, token=TOKEN)
    prog = js('tuneProgram', o)
    sim = Sim(start, ball_true / 2, obs); sim.probe_frame = 'machine'
    err = None
    try: sim.run(prog)
    except NotFound as e: err = 'NotFound'
    except Exception as e: err = '%s: %s' % (type(e).__name__, str(e)[:200])
    st = {k[1:]: v for k, v in sim.vars.items() if k.startswith('_')}
    return sim, st, prog, err

# 1. A block on a machine 0.03 deg out of square, turned 1.5 deg, started 3/-2 mm off its middle
sim, st, prog, err = run([BED, block(CX, CY, A, B, 1.5, 0.03)], (CX + 3, CY - 2, BED_Z + 25.4 + 6))
check('the whole program runs to the end', err is None and st.get('oft_done') == TOKEN, err or st.get('oft_done'))
check('no if/else, no repeated block numbers', not re.search(r'^o\d+ else', prog, re.M) and
      len(re.findall(r'^o(\d+) if', prog, re.M)) == len(set(re.findall(r'^o(\d+) if', prog, re.M))))
check('6 runs', st.get('oft_run') == 6, st.get('oft_run'))
check('ends at the top of Z over the start', abs(sim.P[2] - TOP) < 1e-6 and abs(sim.P[0] - CX - 3) < 1e-6 and abs(sim.P[1] - CY + 2) < 1e-6, sim.P)
r = js('tuneResults', st, dict(a=A, b=B, token=TOKEN, ball=2.0))
check('stylus: 3 runs, the true ball (1.95) within 0.005 mm, runs agree', r['calOk'] and abs(r['ball'] - 1.95) < 0.005, '%s ball %.4f spread %.4f' % (r.get('balls'), r.get('ball', 0), r.get('calSpread', 0)))
check('squareness: 3 runs, 0.03 deg found within 0.004', r['sqOk'] and abs(r['avg']['deg'] - 0.03) < 0.004, '%.4f deg, %.3f mm over 400' % (r['avg']['deg'], r['avg']['drift400']) if r.get('avg') else r)
check('  block size from the calibrated ball within 0.02 mm', all(abs(s['w'] - A) < 0.02 and abs(s['l'] - B) < 0.02 for s in r['square']), [(round(s['w'], 3), round(s['l'], 3)) for s in r['square']])
check('  no problems reported', not r['problems'], r['problems'])

# 2. A clamp beside the block stops the first squareness run; the rest is skipped
clamp = (CX + 49, CX + 55, CY - 20, CY - 10, BED_Z, BED_Z + 30)
sim, st, prog, err = run([BED, block(CX, CY, A, B, 0, 0), clamp], (CX, CY, BED_Z + 31.4))
check('a clamp beside the block: the program ends without "done"', err is None and st.get('oft_done') == 0 and st.get('oft_abort') == 1, (err, st.get('oft_done'), st.get('oft_abort')))
check('  stopped at run 4 (the first squareness run), the rest skipped', st.get('oft_run') == 4, st.get('oft_run'))
check('  and back up at the top of Z', abs(sim.P[2] - TOP) < 1e-6, sim.P)
r = js('tuneResults', st, dict(a=A, b=B, token=TOKEN, ball=2.0))
check('  squareness reports why it stopped', not r['sqOk'] and any('Squareness run 1' in p for p in r['problems']), r['problems'])
check('  the 3 stylus runs are there, but not saved: without squareness the block\'s turn is unknown', len(r['balls']) == 3 and not r['calOk'] and any("couldn't be corrected" in p for p in r['problems']))

# 3. The block isn't under the start: the first touch finds nothing (the controller E-stops)
sim, st, prog, err = run([BED, block(CX + 100, CY, A, B, 0, 0)], (CX, CY, BED_Z + 31.4))
check('no block under the stylus: stops on the first touch (Switch not found)', err == 'NotFound' and st.get('oft_run') == 1, (err, st.get('oft_run')))
print('ALL PASS' if ok else 'SOME FAILED'); sys.exit(0 if ok else 1)
