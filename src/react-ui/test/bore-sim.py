# Bore centre (bore.js) and flip alignment (Flip.py) against a simulated machine (1.31.0).
#   python3 src/react-ui/test/bore-sim.py
# Side B stock sits turned and shifted on the table; the program's reference bores go through it.
# The Measure stock zero is only rough. The wizard's sequence is followed: bore 1 from a cross of
# spots round its rough position, bore 2 from spots across the line from bore 1, then Flip.solve.
# Run with #5061-#5063 as work and as machine coordinates, and with noise on every reading.
import os, sys, math, json, random, subprocess
H = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, H)
sys.path.insert(0, os.path.join(H, '..', '..', 'py', 'tests'))
sys.path.insert(0, os.path.join(H, '..', '..', 'py'))
from simlib import Sim, Crash, NotFound, box_dist
import bbstub  # noqa
import bbctrl
from bbctrl import GCodeText, Lint
F = sys.modules['bbctrl.Flip']

def node(fn, opts):
    return subprocess.run(['node', H + '/gen.mjs', 'bore.js', fn, json.dumps(opts)], capture_output=True, text=True, check=True).stdout

def js(expr):
    out = subprocess.run(['node', '--input-type=module', '-e', "import * as m from '%s/../src/bore.js'; process.stdout.write(JSON.stringify(%s))" % (H, expr)], capture_output=True, text=True, check=True).stdout
    return json.loads(out)

class Plate:
    # Stock with through bores: holes [(cx, cy, R)] machine mm
    def __init__(s, box, holes): s.b = box; s.holes = holes
    def dist(s, c):
        x0, x1, y0, y1, z0, z1 = s.b
        for hx, hy, R in s.holes:
            rad = math.hypot(c[0] - hx, c[1] - hy)
            if rad < R:
                if c[2] > z1: return math.hypot(R - rad, c[2] - z1)
                if c[2] < z0: return math.hypot(R - rad, z0 - c[2])
                return R - rad
        return box_dist(c, s.b)

allok = True
def chk(name, cond, msg=''):
    global allok
    print(('PASS' if cond else 'FAIL'), name, msg); allok &= bool(cond)

TOP = 19.0
SHEET = ['(SETUP stock: x=0..300 y=0..200 z=-19..0)', '(SETUP probe-corner: front-left)',
         '(SETUP ref1: bore x=12 y=12 d=8)', '(SETUP ref2: bore x=285 y=150 d=8)', '(SETUP flip: y)']
fields = GCodeText.setup_fields(SHEET)
sheet = F.read_sheet(fields)
NOM = [(r['x'], r['y']) for r in sheet['refs']]
BALL = 2.0
base = dict(d=8, ball=BALL, depth=3, clear=5, travel=1000, fast=200, slow=25)

def world(theta_deg, O, d_true=8.0):
    a = math.radians(theta_deg); c, s_ = math.cos(a), math.sin(a)
    holes = [(O[0] + x * c - y * s_, O[1] + x * s_ + y * c, d_true / 2) for x, y in NOM]
    return Plate((O[0] - 40, O[0] + 340, O[1] - 40, O[1] + 240, 0, TOP), holes), holes

def measure_bore(sim, targets, name):
    w = sim.work()
    prog = node('boreProgram', dict(base, fromX=w[0], fromY=w[1], fromZ=w[2], targets=targets, token=77, name=name))
    sim.run(prog)
    return prog

def run_job(theta, O, frame, noise, zero_err=(0.8, -0.6), seed=1, d_true=8.0):
    plate, holes = world(theta, O, d_true)
    # Rough zero from Measure stock on the front-left corner, off by zero_err
    sim = Sim([O[0] + 50, O[1] + 50, TOP + 12], BALL / 2, [plate])
    sim.probe_frame = frame; sim.noise = noise; sim.rng = random.Random(seed)
    sim.off = [O[0] + zero_err[0], O[1] + zero_err[1], TOP]
    got = [None, None]
    order = js('m.boreOrder(%s)' % json.dumps([{'x': x, 'y': y} for x, y in NOM]))
    a, b = order
    # First bore: turn about the zero corner, plus the rough zero's shift
    na = NOM[a]; La = math.hypot(*na)
    spots = js('m.boreSpots(%s, 8, %s, %s)' % (json.dumps({'x': na[0], 'y': na[1]}), BALL, json.dumps({'along': {'x': na[0] / La, 'y': na[1] / La}, 'dist': La})))
    prog = measure_bore(sim, spots, 'first')
    v = dict(sim.vars)
    if v.get('_ofb_done') != 77: return None, v, sim, holes, prog
    got[a] = {'x': sim.P[0], 'y': sim.P[1]}; r1 = v
    # Second bore: predicted from the first (shift known, turn not), spots across the line
    m1w = (got[a]['x'] - sim.off[0], got[a]['y'] - sim.off[1])
    dx, dy = NOM[b][0] - NOM[a][0], NOM[b][1] - NOM[a][1]; L = math.hypot(dx, dy)
    pred = {'x': m1w[0] + dx, 'y': m1w[1] + dy}
    spots = js('m.boreSpots(%s, 8, %s, %s)' % (json.dumps(pred), BALL, json.dumps({'along': {'x': dx / L, 'y': dy / L}, 'dist': L, 'slack': 0})))
    prog = measure_bore(sim, spots, 'second')
    v = dict(sim.vars)
    if v.get('_ofb_done') != 77: return None, v, sim, holes, prog
    got[b] = {'x': sim.P[0], 'y': sim.P[1]}
    return got, (r1, v), sim, holes, prog

# 1. Turned 1.2 deg, shifted, both frames, no noise: centres exact, solve recovers the turn and X0 Y0
for frame in ('work', 'machine'):
    O = (137.25, 61.5); th = 1.2
    got, rs, sim, holes, _ = run_job(th, O, frame, 0)
    chk('%s frame: both bores found' % frame, got is not None)
    if not got: continue
    err = max(math.hypot(g['x'] - h[0], g['y'] - h[1]) for g, h in zip(got, holes))
    chk('%s frame: centres within 0.002 mm' % frame, err < 0.002, '%.5f' % err)
    sol = F.solve(sheet, got, fields=fields)
    chk('%s frame: solve ok' % frame, sol['ok'], sol['problems'])
    chk('%s frame: angle within 0.001 deg' % frame, abs(sol['angle'] - th) < 0.001, sol['angle'])
    chk('%s frame: X0 Y0 within 0.005 mm' % frame, math.hypot(sol['origin']['x'] - O[0], sol['origin']['y'] - O[1]) < 0.005, sol['origin'])
    for r in rs:
        chk('%s frame: diameter %.4f / %.4f (sim steps 0.002 mm)' % (frame, r['_ofb_dx'], r['_ofb_dy']), abs(r['_ofb_dx'] - 8) < 0.005 and abs(r['_ofb_dy'] - 8) < 0.005)
    if frame == 'work': ref_got = got
    else: chk('work and machine frames give the same centres', max(abs(a['x'] - b['x']) + abs(a['y'] - b['y']) for a, b in zip(got, ref_got)) < 1e-6)

# 2. Noise 3 um on every reading, several seeds and turns
worst_c, worst_a = 0, 0
for seed in range(8):
    th = random.Random(seed).uniform(-1.8, 1.8)
    O = (100 + seed * 7.3, 40 + seed * 3.1)
    got, rs, sim, holes, _ = run_job(th, O, 'work', 0.003, zero_err=(random.Random(seed).uniform(-1.5, 1.5), random.Random(seed + 9).uniform(-1.5, 1.5)), seed=seed)
    if not got: chk('noise seed %d: found' % seed, False, sim.vars.get('_ofb_fail')); continue
    sol = F.solve(sheet, got, fields=fields)
    worst_c = max(worst_c, math.hypot(sol['origin']['x'] - O[0], sol['origin']['y'] - O[1]))
    worst_a = max(worst_a, abs(sol['angle'] - th))
    if not sol['ok']: chk('noise seed %d: solve ok' % seed, False, sol['problems'])
chk('noise: X0 Y0 within 0.01 mm over 8 runs', worst_c < 0.01, '%.4f' % worst_c)
chk('noise: angle within 0.002 deg over 8 runs', worst_a < 0.002, '%.5f' % worst_a)

# 3. Turned 1.9 deg: bore 2 is ~9 mm from where the shift alone puts it; the spots across the line find it
got, rs, sim, holes, _ = run_job(1.9, (120, 50), 'work', 0)
chk('1.9 deg: both bores found by the spots across the line', got is not None and max(rs[0]['_ofb_in'], rs[1]['_ofb_in']) > 1, (rs[0].get('_ofb_in'), rs[1].get('_ofb_in')) if got else sim.vars.get('_ofb_fail'))
got, rs, sim, holes, _ = run_job(6, (120, 50), 'work', 0)
chk('6 deg (past the 2 deg search): not found, fail 2, nothing moved sideways into stock', got is None and sim.vars.get('_ofb_fail') == 2, sim.vars.get('_ofb_fail'))

# 4. Turned over the wrong way: the bores aren't where the sheet says -> no spot goes down, fail 2, Z back up
plate, holes = world(0.3, (120, 50))
wrong = [(300 - x, y) for x, y in [(h[0] - 120, h[1] - 50) for h in holes]]
plate.holes = [(120 + x, 50 + y, 4) for x, y in wrong]
sim = Sim([170, 100, TOP + 12], 1, [plate]); sim.off = [120, 50, TOP]
spots = js('m.boreSpots({"x": %s, "y": %s}, 8, 2)' % NOM[0])
try:
    measure_bore(sim, spots, 'wrong'); res = sim.vars.get('_ofb_fail')
except (Crash, NotFound) as e: res = type(e).__name__
chk('flipped the wrong way: fail 2 (never found)', res == 2, res)
chk('flipped the wrong way: stylus back at travel height', abs(sim.work()[2] - 5) < 1e-6, sim.work())
chk('flipped the wrong way: no done token', sim.vars.get('_ofb_done') == 0)

# 5. A clamp across the travel path: fail 1, stops, no crash
plate, holes = world(0, (120, 50))
clamp = (295, 315, 75, 105, 0, TOP + 15)
sim = Sim([200, 120, TOP + 12], 1, [plate, clamp]); sim.off = [120, 50, TOP]
try: measure_bore(sim, [{'x': NOM[0][0], 'y': NOM[0][1]}], 'clamp'); res = sim.vars.get('_ofb_fail')
except (Crash, NotFound) as e: res = type(e).__name__
chk('clamp on the way: fail 1 (guarded move stopped)', res == 1, res)

# 6. Start here (no spots): operator jogged roughly over the bore
plate, holes = world(0.5, (90, 30))
sim = Sim([holes[0][0] + 1.4, holes[0][1] - 1.1, TOP + 9], 1, [plate]); sim.off = [90, 30, TOP]
measure_bore(sim, None, 'here')
chk('start here: found', sim.vars.get('_ofb_done') == 77)
chk('start here: centre within 0.002 mm', math.hypot(sim.P[0] - holes[0][0], sim.P[1] - holes[0][1]) < 0.002)

# 7. Oversize / out of round verdicts (JS)
v = js('m.boreVerdict({dx: 8.4, dy: 8.38, sx: 0, sy: 0}, 8)'); chk('verdict: 0.4 mm oversize refused', not v['ok'])
v = js('m.boreVerdict({dx: 8.01, dy: 8.12, sx: 0, sy: 0}, 8)'); chk('verdict: 0.11 mm out of round refused', not v['ok'])
v = js('m.boreVerdict({dx: 8.01, dy: 8.0, sx: 0.004, sy: 0.002}, 8)'); chk('verdict: good bore accepted', v['ok'])

# 8. Program rules: M5 before any move, no rapid down, every o-word closed
prog = node('boreProgram', dict(base, fromZ=12, targets=[{'x': 1, 'y': 2}, {'x': 3, 'y': 4}], token=5))
lines = prog.splitlines()
chk('M5 before the first move', lines.index('M5') < min(i for i, l in enumerate(lines) if l.startswith('G0') or l.startswith('G38') or l.startswith('G91')))
z = 12.0; bad = []
for l in lines:
    if l.startswith('G90 G0 Z') or l.startswith('G0 Z'):
        nz = float(l.split('Z')[1]);
        if nz < z - 1e-9 and nz < 5 - 1e-9: bad.append(l)
chk('no rapid below travel height', not bad, bad)
ids = {}
for l in lines:
    if l.startswith('o') and (' if ' in l or l.endswith(' endif') or l.endswith(' else')):
        k, kind = l.split()[0], l.split()[1]; ids.setdefault(k, []).append(kind)
chk('every o-word opened once and closed once', all(v.count('if') == 1 and v.count('endif') == 1 for v in ids.values()))
chk('done token only at the end, only when ok', prog.count('#<_ofb_done> = 5') == 1 and prog.index('#<_ofb_done> = 5') > prog.index('#<_ofb_ok> = 1'))
res = Lint.lint_lines(lines)
chk('G-code check: no errors', not res['errors'], res['issues'][:2])

print('ALL PASS' if allok else 'SOMETHING FAILED')
