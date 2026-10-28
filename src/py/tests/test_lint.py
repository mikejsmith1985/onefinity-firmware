# Pre-run G-code check and the controller's run check (1.29.0).
#   python3 src/py/tests/test_lint.py
import sys, os, json, tempfile, types
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bbstub import check, done, run_sync
import bbctrl
from bbctrl import Lint
Web = sys.modules['bbctrl.Web']

def keys(prog, setup=None):
    r = Lint.lint_lines(prog.strip().splitlines(), setup)
    return dict((i['key'], i) for i in r['issues']), r

GOOD = """
(SETUP stock: x=0..100 y=0..50 z=-12..0)
G90 G94 G17
G21
G54
S18000 M3
G0 X10 Y10
G0 Z5
G1 Z-3 F300 X12
G1 X50 F1000
G0 Z5
M5
M30
"""
k, r = keys(GOOD)
check('clean Fusion-style program: no errors or warnings', r['errors'] == 0 and r['warnings'] == 0, list(k))

k, _ = keys('G21 G54\nG0 X0 Y0 Z5\nG1 X1 (Pass 2 (finish) at x 120 y 3)\nM30')
check('nested comment is an error', k.get('comment-nested', {}).get('level') == 'error' and k['comment-nested']['lines'] == [3])
k, _ = keys('G21 G54\nG0 X0 Y0 Z5\n(note\nG1 Z-1 F100\nG1 X10\n)\nM30')
check('comment left open over moves is an error naming the lines',
      k.get('comment-open', {}).get('level') == 'error' and 'lines 4 to 6' in k['comment-open']['msg'], k.get('comment-open'))
k, _ = keys('G21 G54\nG0 X0 Y0 Z5\n(never closed\nG1 X1\nM30')
check('comment never closed', 'never closed' in k.get('comment-open', {}).get('msg', ''))

k, _ = keys('G54\nG0 X0 Y0 Z5\nM30')
check('missing G20/G21 warns', k.get('units', {}).get('level') == 'warn')
k, _ = keys('G21\nG0 X0 Y0 Z5\nM30')
check('missing work offset noted', 'wcs' in k)

k, _ = keys('G21 G54\nG0 X0 Y0 Z5\nG1 Z-2 F100\nG0 X20\nM30')
check('rapid sideways below the stock top is an error', k.get('rapid-low', {}).get('lines') == [4])
k, _ = keys('G21 G54\nG0 X0 Y0 Z5\nG0 Z-2\nM30')
check('rapid plunge into the stock is an error', k.get('rapid-plunge', {}).get('lines') == [3])
k, _ = keys('G21 G54\nG0 X0 Y0 Z5\nG1 Z-2 F100\nG1 X10\nM30')
check('straight feed plunge warns', k.get('plunge', {}).get('level') == 'warn')
k, _ = keys('(SETUP stock: x=0..100 y=0..50 z=0..19)\nG21 G54\nG0 X0 Y0 Z25\nG0 Z10\nM30')
check('stock top from the sheet (zero on the spoilboard)', k.get('rapid-plunge', {}).get('lines') == [4], list(k))
k, _ = keys('G20 G54\nG0 X0 Y0 Z0.2\nG1 Z-0.1 F10\nG0 X1\nM30')
check('inch program tracked in mm', 'rapid-low' in k and '-2.54' in k['rapid-low']['msg'], k.get('rapid-low'))
k, _ = keys('G21 G54\nG0 X0 Y0 Z5\nG91\nG0 Z-10\nG90\nM30')
check('G91 not guessed at', 'rapid-plunge' not in k and 'untracked' in k)

k, _ = keys('G21 G54\nM7\nG0 X0 Y0 Z5\nM30')
check('M7 without M9 warns', k.get('mist', {}).get('level') == 'warn')
k, _ = keys('G21 G54\nM7\nG0 X0 Y0 Z5\nM9\nM30')
check('M7 with M9 fine', 'mist' not in k)

codes = {'G83 X0 Y0 Z-5 R2 Q1': 'g83', 'G73 X0 Y0 Z-5 R2 Q1': 'g73', 'G84 X0 Y0 Z-5 R2': 'g84',
         'G87 X0 Y0 Z-5 R2': 'g87', 'G88 X0 Y0 Z-5 R2': 'g88', 'G41 D1': 'g41', 'G42 D1': 'g42',
         'M62 P1': 'm62', 'M63 P1': 'm63', 'M64 P1': 'm64', 'M65 P1': 'm65',
         'G5 X1 Y1 I1 J1 P1 Q1': 'g5', 'G5.1 X1 Y1 I1 J1': 'g5.1', 'G33 Z-1 K1': 'g33', 'G76 P1 Z-1': 'g76'}
for line, key in codes.items():
    k, _ = keys('G21 G54\nG0 X0 Y0 Z5\n' + line + '\nM30')
    check('%s is an error' % line.split()[0], k.get(key, {}).get('level') == 'error', list(k))
for line, key in {'M66 P0 L3 Q5': 'm66', 'M19': 'm19', 'M48': 'm48', 'M53 P1': 'm53', 'M61 Q2': 'm61'}.items():
    k, _ = keys('G21 G54\nG0 X0 Y0 Z5\n' + line + '\nM30')
    check('%s warns' % line.split()[0], k.get(key, {}).get('level') == 'warn', list(k))
k, _ = keys('G21 G54\n(G83 in a comment)\nG0 X0 Y0 Z5\nM30')
check('codes inside comments are not codes', 'g83' not in k)

k, _ = keys('G21 G54\nS12000 M3\nG38.2 Z-10 F50\nM30')
check('probing with the spindle on is an error', k.get('probe-spindle', {}).get('level') == 'error')
k, _ = keys('G21 G54\nS12000 M3\nM5\nG38.2 Z-10 F50\nM30')
check('M5 before the probe is fine', 'probe-spindle' not in k)
k, _ = keys('G21 G54\nM3\nS0\nG38.2 Z-10 F50\nM30')
check('S0 counts as off', 'probe-spindle' not in k)

# Controller-side run check -------------------------------------------------
tmp = tempfile.mkdtemp()
os.makedirs(os.path.join(tmp, 'upload')); os.makedirs(os.path.join(tmp, 'next-data'))
def put(name, text):
    with open(os.path.join(tmp, 'upload', name), 'w') as f: f.write(text)
put('good.nc', '(SETUP probe-corner: Front Left)\n' + GOOD)
put('bad.nc', 'G21 G54\nG0 X0 Y0 Z5\nG83 X1 Y1 Z-5 R2 Q1\nM30\n')
put('fr.nc', '(SETUP probe-corner: front-right)\n' + GOOD)
class Ctrl:
    def __init__(s): s.state = types.SimpleNamespace(get=lambda k, d=None: s.sel if k == 'selected' else d); s.sel = ''; s.started = []
    def get_path(s, d=None, f=None): return os.path.join(tmp, d) if d else tmp
    def get_upload(s, f=''): return os.path.join(tmp, 'upload', f)
c = Ctrl()
check('clean program, no probe record: go', Lint.start_stops(c, 'good.nc') == [])
with open(os.path.join(tmp, 'next-data', 'probe.json'), 'w') as f: json.dump({'loc': 'front-left'}, f)
check('probed corner matches (sheet written "Front Left")', Lint.start_stops(c, 'good.nc') == [])
st = Lint.start_stops(c, 'fr.nc')
check('wrong corner stops', [s['key'] for s in st] == ['zero'] and 'WRONG ZERO' in st[0]['msg'], st)
st = Lint.start_stops(c, 'bad.nc')
check('lint error stops', [s['key'] for s in st] == ['lint'] and 'G83' in st[0]['msg'], st)
st = Lint.start_stops(c, 'missing.nc')
check('unreadable program stops (fails closed)', [s['key'] for s in st] == ['read'], st)
put('bad.nc', 'G21 G54\nG0 X0 Y0 Z5\nG81 X1 Y1 Z-5 R2\nG80\nM30\n')
check('cache follows the file', Lint.start_stops(c, 'bad.nc') == [])

# /api/start
class Log:
    def info(s, *a): pass
c.log = types.SimpleNamespace(get=lambda n: Log())
c.mach = types.SimpleNamespace(start=lambda lift=0, *a: c.started.append(lift))
def start(sel, body):
    c.sel = sel
    h = Web.StartHandler.__new__(Web.StartHandler); h.get_ctrl = lambda: c; h.json = body
    h.write_json = lambda v: None
    try: run_sync(h.put); return 'started'
    except Web.HTTPError as e: return (e.status_code, e.log_message % e.args)
put('bad.nc', 'G21 G54\nG0 X0 Y0 Z5\nG83 X1 Y1 Z-5 R2 Q1\nM30\n')
r = start('bad.nc', {})
check('start refused with the reason', r[0] == 409 and 'G83' in r[1] and c.started == [], r)
check('Run anyway (ack) starts', start('bad.nc', {'ack': True}) == 'started' and c.started == [0])
check('clean program starts, dry lift passed', start('good.nc', {'dry_lift': 30}) == 'started' and c.started[-1] == 30)
# 1.33.0: the dry run gets the quick copy, with the same lines, and a note for the screens
c.mach = types.SimpleNamespace(start=lambda lift=0, *a: c.started.append((lift,) + a))
check('dry run gets the quick copy', start('good.nc', {'dry_lift': 30}) == 'started' and
      c.started[-1][1] and os.path.exists(c.started[-1][1]) and
      len(open(c.started[-1][1]).read().splitlines()) == len(open(c.get_upload('good.nc')).read().splitlines()) and
      'First pass' in c.started[-1][2], c.started[-1])
check('a normal run gets no copy', start('good.nc', {}) == 'started' and c.started[-1][1:] == (None, None), c.started[-1])
c.mach = types.SimpleNamespace(start=lambda lift=0, *a: c.started.append(lift))
r = start('fr.nc', None)
check('no body: still checked', r != 'started' and 'WRONG ZERO' in r[1])

# 1.31.5: a peck going back down inside its own hole is not a plunge into the material
PECK = """
(SETUP stock: x=0..100 y=0..50 z=0..20)
G21 G90
G0 X10 Y10
G0 Z25
G1 Z15 F70
G0 Z25
G1 Z15.5 F1000
G1 Z12 F70
G0 Z25
M30
"""
k, r = keys(PECK)
check('peck re-entry above the last depth is not flagged', k.get('plunge', {}).get('lines') == [5, 8], k.get('plunge'))

# 1.31.5: where the program moves, for the screens' plate check (same as setup.js programExtent)
EXT = """
G21 G90
G0 X10 Y10
G1 X20 F500
G2 X30 Y10 I5 J0
G0 Z5
G53 G0 X300 Y300
M30
"""
k, r = keys(EXT)
e = r['extent']
check('extent covers the moves and the arc top', e and abs(e['minx'] - 10) < 1e-6 and abs(e['maxx'] - 30) < 1e-6 and abs(e['maxy'] - 15) < 1e-6 and abs(e['miny'] - 10) < 1e-6, e)
k, r = keys("G21 G91\nG1 X10 Y10 F100\nM30")
check('no extent for incremental moves (the screen measures it itself)', r['extent'] is None, r['extent'])
k, r = keys("G20 G90\nG0 X1 Y2\nM30")
check('extent in mm for an inch program', abs(r['extent']['maxx'] - 25.4) < 1e-6 and abs(r['extent']['maxy'] - 50.8) < 1e-6, r['extent'])

# 1.39.0: a plunge right after a machine-coordinate (G53) move used to crash the check
r = Lint.lint_lines(['G21 G90', 'G53 G0 Z-1', 'G53 G0 X20 Y30', 'G0 Z3', 'G1 Z-1.2 F300', 'G1 X40 F1000', 'M2'])
check('plunge after a G53 move checks without crashing', r['errors'] == 0, r)
done()
