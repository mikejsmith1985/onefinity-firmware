# Two-sided flip alignment (1.31.0): mapping side A's reference bores onto side
# B, the fit, its checks, the turned copy it writes, and what it refuses.
#   python3 src/py/tests/test_flip.py
import sys, os, re, math, json, types, tempfile, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bbstub import check, done, run_sync
import bbctrl
from bbctrl import Lint, GCodeText
F = sys.modules['bbctrl.Flip']
Web = sys.modules['bbctrl.Web']

SHEET = ['(SETUP job: side B)', '(SETUP stock: x=0..200 y=0..120 z=-18..0)',
         '(SETUP probe-corner: front-left)', '(SETUP flip: y)',
         '(SETUP ref1: bore x=20 y=20 d=10)', '(SETUP ref2: bore x=170 y=95 d=10)']
BODY = ['G90 G94 G17', 'G21', 'G54', 'T1 M6', 'S18000 M3', 'G0 X60 Y40', 'G0 Z5',
        'G1 Z-3 F300', 'G1 X100 F1200', 'G1 Y70', 'G2 X60 Y70 I-20 J0', 'G1 Y40', 'G0 Z5', 'M5', 'M30']
PROG = SHEET + BODY
fields = lambda lines: GCodeText.setup_fields(lines)

def turn(p, a, o):
    r = math.radians(a)
    return (o[0] + p[0] * math.cos(r) - p[1] * math.sin(r), o[1] + p[0] * math.sin(r) + p[1] * math.cos(r))
D = lambda pts: [{'x': x, 'y': y} for x, y in pts]   # measured centres as the API sends them

# Mapping -----------------------------------------------------------------
s = F.read_sheet(fields(PROG))
check('two refs, flip y', len(s['refs']) == 2 and s['flip'] == 'y')
check('flip y: X mirrored across the stock, Y kept', [(r['x'], r['y']) for r in s['refs']] == [(180, 20), (30, 95)], s['refs'])
check('side A positions kept', [(r['ax'], r['ay']) for r in s['refs']] == [(20, 20), (170, 95)])
sx = F.read_sheet(fields([l.replace('flip: y', 'flip: x') for l in PROG]))
check('flip x: Y mirrored, X kept', [(r['x'], r['y']) for r in sx['refs']] == [(20, 100), (170, 25)], sx['refs'])
sn = F.read_sheet(fields([l.replace('flip: y', 'flip: none') for l in PROG]))
check('flip none: as written', [(r['x'], r['y']) for r in sn['refs']] == [(20, 20), (170, 95)])
sr = F.read_sheet(fields(SHEET + ['(SETUP ref-stock: x=-100..100 y=0..120)'] + BODY))
check('ref-stock: side A range used for the mirror', [r['x'] for r in sr['refs']] == [80, -70], [r['x'] for r in sr['refs']])
si = F.read_sheet(fields(SHEET[:4] + ['(SETUP ref1: bore x=1 y=1 d=0.375 units=in)', '(SETUP ref2: bore x=6 y=4 d=0.375 units=in)']))
check('units=in converted to mm', abs(si['refs'][0]['d'] - 9.525) < 1e-9 and abs(si['refs'][0]['ax'] - 25.4) < 1e-9)
check('no refs: None', F.read_sheet(fields(SHEET[:4])) is None)
def err(lines):
    try: F.read_sheet(fields(lines)); return ''
    except F.FlipError as e: return str(e)
check('one ref refused', 'Two or more' in err(SHEET[:5]))
check('no flip line refused', 'no "(SETUP flip' in err([l for l in PROG if 'flip' not in l]))
check('bad flip value refused', 'Use x' in err([l.replace('flip: y', 'flip: z') for l in PROG]))
check('no stock range refused (needed to mirror)', 'stock range' in err([l for l in PROG if 'stock' not in l]))
check('not a bore refused', 'Only bores' in err(SHEET[:4] + ['(SETUP ref1: pin x=1 y=1 d=8)', '(SETUP ref2: bore x=50 y=50 d=8)']))
check('missing d= refused', 'has no d=' in err(SHEET[:4] + ['(SETUP ref1: bore x=1 y=1)', '(SETUP ref2: bore x=50 y=50 d=8)']))
check('bore size limits', '2 to 60' in err(SHEET[:4] + ['(SETUP ref1: bore x=1 y=1 d=1)', '(SETUP ref2: bore x=50 y=50 d=8)']))
close = F.read_sheet(fields(SHEET[:4] + ['(SETUP ref1: bore x=10 y=10 d=8)', '(SETUP ref2: bore x=20 y=15 d=8)']))
check('refs close together: warned', any('apart' in w for w in close['warnings']))

# Fit -------------------------------------------------------------------
nom = [(r['x'], r['y']) for r in s['refs']]
for a, o in ((0, (160, 88)), (1.7, (210.5, 30.25)), (-3.2, (5, 400))):
    meas = [turn(p, a, o) for p in nom]
    ang, org, res = F.fit(nom, meas)
    check('fit recovers %.1f deg' % a, abs(ang - a) < 1e-9 and abs(org[0] - o[0]) < 1e-9 and abs(org[1] - o[1]) < 1e-9 and max(res) < 1e-9)
three = nom + [(100, 60)]
rng = random.Random(4)
meas = [turn(p, 0.6, (150, 90)) for p in three]
noisy = [(x + rng.uniform(-.01, .01), y + rng.uniform(-.01, .01)) for x, y in meas]
ang, org, res = F.fit(three, noisy)
check('three refs with 10 um noise: angle within 0.01 deg, X0Y0 within 0.02 mm', abs(ang - 0.6) < 0.01 and math.hypot(org[0] - 150, org[1] - 90) < 0.02, (ang, org))

# Solve: checks ---------------------------------------------------------
good = D(turn(p, 0.8, (160.5, 87.9)) for p in nom)
sol = F.solve(s, good, fields = fields(PROG))
check('solve ok, angle and origin', sol['ok'] and abs(sol['angle'] - 0.8) < 1e-9 and abs(sol['origin']['x'] - 160.5) < 1e-9, sol)
check('pair distance reported', len(sol['pairs']) == 1 and abs(sol['pairs'][0]['err']) < 1e-9)
check('asymmetric pattern: no ambiguity warning', not sol['warnings'], sol['warnings'])
bad = [good[0], {'x': good[1]['x'] + 0.08, 'y': good[1]['y']}]
sb = F.solve(s, bad, fields = fields(PROG))
check('distance off by more than 0.05 mm: refused with the numbers', not sb['ok'] and any('more than 0.05 mm' in p for p in sb['problems']), sb['problems'])
check('looser tolerance accepts it', F.solve(s, bad, tol = 0.1)['ok'])
far = D(turn(p, 7, (160, 88)) for p in nom)
sf = F.solve(s, far)
check('turned 7 deg: refused (5 deg limit)', not sf['ok'] and any('degree limit' in p for p in sf['problems']))
sym = SHEET[:4] + ['(SETUP ref1: bore x=20 y=20 d=10)', '(SETUP ref2: bore x=20 y=100 d=10)']
ss = F.read_sheet(fields(sym))
m2 = D(turn((r['x'], r['y']), 0.2, (100, 100)) for r in ss['refs'])
check('refs on one line across the flip axis: ambiguity warned', any('just as well' in w for w in F.solve(ss, m2, fields = fields(sym))['warnings']))
def solve_err(meas):
    try: F.solve(s, meas); return ''
    except F.FlipError as e: return str(e)
check('wrong number of centres refused', solve_err(good[:1]) != '')

# Build -----------------------------------------------------------------
text, info = F.build(PROG, 'sideb.nc', sol)
L = text.splitlines()
check('header says what it is', L[0].startswith('(Flip-aligned copy of sideb.nc') and 'Rotated 0.8 degrees' in L[1])
check('probe-corner set to flip', '(SETUP probe-corner: flip)' in L and '(SETUP probe-corner: front-left)' not in L)
st = [l for l in L if l.startswith('(SETUP stock:')][0]
x0, x1, y0, y1 = F._rot_box({'x': (0, 200), 'y': (0, 120)}, 0.8)
check('stock line is the box around the turned stock, z kept', st == '(SETUP stock: x=%s..%s y=%s..%s z=-18..0)' % tuple(F.fmt(v, 3) for v in (x0, x1, y0, y1)), st)
moves = [l for l in L if re.match(r'G[0123] X', GCodeText.code_of(l).strip())]
m = re.search(r'X(-?[\d.]+) Y(-?[\d.]+)', [l for l in moves if 'X' in l][0])
exp = turn((60, 40), 0.8, (0, 0))
check('moves rotated about X0 Y0', abs(float(m.group(1)) - exp[0]) < 1e-3 and abs(float(m.group(2)) - exp[1]) < 1e-3, m.group(0))
lint = Lint.lint_lines(L)
check('copy passes the G-code check', lint['errors'] == 0, Lint.summary(lint))
no_corner = [l for l in PROG if 'probe-corner' not in l]
t2, _ = F.build(no_corner, 'x.nc', F.solve(F.read_sheet(fields(no_corner)), good))
check('probe-corner added when the sheet had none', '(SETUP probe-corner: flip)' in t2.splitlines())
check('output name', F.output_name('sideb.nc') == 'flip-sideb.nc')

# Controller class --------------------------------------------------------
tmp = tempfile.mkdtemp(); os.makedirs(os.path.join(tmp, 'upload'))
def put(name, lines):
    with open(os.path.join(tmp, 'upload', name), 'w') as f: f.write('\n'.join(lines) + '\n')
put('sideb.nc', PROG); put('flip-sideb.nc', PROG); put('plain.nc', BODY)
class Log:
    def info(s, *a): pass
    def exception(s, *a): pass
class State:
    def __init__(s, cycle='idle'): s.cycle = cycle; s.files = []
    def get(s, k, d=None): return s.cycle if k == 'cycle' else d
    def add_file(s, f): s.files.append(f)
class Ctrl:
    def __init__(s, cycle='idle'): s.state = State(cycle); s.log = types.SimpleNamespace(get=lambda n: Log())
    def get_upload(s, f=''): return os.path.join(tmp, 'upload', f)
c = Ctrl()
r = bbctrl.Flip(c).refs('sideb.nc')
check('refs API', r['output'] == 'flip-sideb.nc' and len(r['refs']) == 2)
out = bbctrl.Flip(c).build('sideb.nc', good)
check('build writes flip-sideb.nc and loads it', c.state.files == ['flip-sideb.nc'] and os.path.isfile(c.get_upload('flip-sideb.nc')) and out['file'] == 'flip-sideb.nc' and out['lint']['errors'] == 0)
check('no .tmp left behind', not os.path.exists(c.get_upload('flip-sideb.nc.tmp')))
def build_err(name, meas, cycle='idle', opts=None):
    try: bbctrl.Flip(Ctrl(cycle)).build(name, meas, opts); return ''
    except F.FlipError as e: return str(e)
check('build refused while running', 'idle' in build_err('sideb.nc', good, 'running'))
check('build of a turned copy refused', 'already a turned copy' in build_err('flip-sideb.nc', good))
check('build refused when the fit fails', 'more than 0.05 mm' in build_err('sideb.nc', bad))
check('program without refs refused', 'no reference bores' in build_err('plain.nc', good))
check('path outside uploads refused', 'Bad file name' in build_err('../x.nc', good))
check('tolerance option clamped (1 mm max)', bbctrl.Flip(c).solve('sideb.nc', bad, {'tol': 50})['tol'] == 1.0)

# Web handler -------------------------------------------------------------
def web(body):
    h = Web.WizardHandler.__new__(Web.WizardHandler); h.get_ctrl = lambda: Ctrl(); h.json = body
    got = {}
    h.write_json = lambda v: got.setdefault('v', v)
    try: run_sync(h.put); return got.get('v'), None
    except Web.HTTPError as e: return None, e
v, e = web({'action': 'flip_refs', 'file': 'sideb.nc'})
check('API flip_refs', v and v['flip'] == 'y' and not e)
v, e = web({'action': 'flip_solve', 'file': 'sideb.nc', 'measured': good})
check('API flip_solve', v and v['ok'] and not e)
v, e = web({'action': 'flip_build', 'file': 'sideb.nc', 'measured': bad})
check('API refusal is a 400 with the reason', e is not None and e.status_code == 400 and '0.05' in (e.log_message % e.args if e.args else e.log_message))
v, e = web({'action': 'nope', 'file': 'sideb.nc'})
check('API unknown action 400', e is not None and e.status_code == 400)

# Lint: a flip copy needs the flip probe record -----------------------------
os.makedirs(os.path.join(tmp, 'next-data'), exist_ok=True)
c.get_path = lambda d=None, f=None: os.path.join(tmp, d) if d else tmp
c.state.get = lambda k, d=None: d
def stops(): return Lint.start_stops(c, 'flip-sideb.nc')
put('flip-sideb.nc', text.splitlines())
with open(os.path.join(tmp, 'next-data', 'probe.json'), 'w') as f: json.dump({'loc': 'front-left'}, f)
st = stops()
check('flip copy, last probe on a corner: WRONG ZERO', [x['key'] for x in st] == ['zero'] and 'WRONG ZERO' in st[0]['msg'] and 'Start job' in st[0]['msg'], st)
with open(os.path.join(tmp, 'next-data', 'probe.json'), 'w') as f: json.dump({'loc': 'flip'}, f)
check('flip copy, flip record: go', stops() == [], stops())
done()
