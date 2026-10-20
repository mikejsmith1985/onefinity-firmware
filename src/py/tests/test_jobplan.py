# Start job wizard tool changes (1.31.0): finding the tools and the parts a
# program splits into, the part programs it writes, and what it refuses.
#   python3 src/py/tests/test_jobplan.py
import sys, os, re, types, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bbstub import check, done, run_sync
import bbctrl
from bbctrl import Lint, GCodeText
J = sys.modules['bbctrl.JobPlan']
Web = sys.modules['bbctrl.Web']

HEAD = ['(SETUP job: two tools)', '(SETUP stock: x=0..200 y=0..120 z=-18..0)', '(SETUP probe-corner: front-left)',
        '(SETUP tool: T1 6.35MM 2FL UPCUT)', '(T1 D=6.35 CR=0 - flat end mill)', '(T2 D=3.175 CR=0 - flat end mill)']
P1 = ['G90 G94 G17', 'G21', 'G54', 'T1 M6', 'S18000 M3', 'G0 X60 Y40', 'G0 Z5', 'G1 Z-3 F300', 'G1 X100 F1200', 'G1 Y70', 'G0 Z5']
P2 = ['T2 M6', 'S16000 M3', 'G0 X120 Y30', 'G0 Z5', 'G1 Z-2 F250', 'G1 X140 F900', 'G0 Z5']
P3 = ['T3', 'M6', 'G0 X10 Y10', 'G0 Z5', 'G1 Z-1 F200', 'G1 X20', 'G0 Z5', 'M5', 'M30']
PROG = HEAD + P1 + P2 + P3

p = J.plan(PROG)
check('three parts', [x['tool'] for x in p['parts']] == [1, 2, 3], p)
check('first M6 (before any cut) is the first tool, not a change', p['first_tool'] == 1 and p['parts'][0]['change'] is None)
n1 = len(HEAD + P1)
check('part 2 starts at the T2 M6 line', p['parts'][1]['start'] == n1 + 1 and p['parts'][0]['end'] == n1)
check('T on its own line, M6 on the next: the change is at the M6', p['parts'][2]['start'] == len(HEAD + P1 + P2) + 2, p['parts'][2])
check('one tool: one part', len(J.plan(HEAD + P1 + ['M30'])['parts']) == 1)
check('no M6 at all: one part, tool from the last T', J.plan(['T4', 'G0 X0 Y0', 'G1 Z-1 F100', 'M30'])['parts'][0]['tool'] == 4)
check('M6 in a comment is not a change', len(J.plan(HEAD + P1 + ['(T2 M6 later)', 'M30'])['parts']) == 1)
check('M60 / M61 are not M6', len(J.plan(HEAD + P1 + ['M61', 'M30'])['parts']) == 1)
s = J.summary(PROG)
check('tool names from the sheet and the tool list', s['parts'][0]['tool_name'] == 'T1 6.35MM 2FL UPCUT' and s['parts'][1]['tool_name'].startswith('T2 D=3.175'), [x['tool_name'] for x in s['parts']])
def plan_err(lines):
    try: J.plan(lines); return ''
    except J.JobPlanError as e: return str(e)
check('M6 without a T refused', 'without a T' in plan_err(['G0 X0 Y0', 'G1 Z-1 F100', 'M6', 'M30']))
check('nested comment refused', 'Line 1' in plan_err(['(SETUP tool: T1 (6mm))', 'M30']))

# Parts ---------------------------------------------------------------------
TOP = 132
def part(k, lines=PROG):
    t, info = J.part(lines, k, 'job.nc', TOP)
    return t, t.splitlines(), info
t0, L0, i0 = part(0)
check('part 1 header', L0[0] == '(Part 1 of 3 of job.nc: T1, lines 1 to %d)' % n1)
check('part 1: M6 taken out, T kept', 'T1' in L0 and not any(re.search(r'\bM0*6\b', GCodeText.code_of(l)) for l in L0))
check('part 1 ends: spindle off, lift, M30, says the next tool', L0[-6:] == ['M5', 'M9', 'G21 G90', 'G53 G0 Z132', '(End of part 1 of 3. Next: T2)', 'M30'], L0[-6:])
t1, L1, i1 = part(1)
check('part 2 carries the setup sheet', '(SETUP probe-corner: front-left)' in L1 and '(SETUP stock: x=0..200 y=0..120 z=-18..0)' in L1)
hdr = L1[L1.index('M5'):L1.index('M5') + 6]
check('part 2 starts safe: M5, M9, modes, lift to the top, units', hdr == ['M5', 'M9', 'G21 G90 G17 G54 G94', 'G53 G0 Z132', 'G21 G90', 'F1200'], hdr)
check('part 2: T2 from its own line, not repeated', sum(1 for l in L1 if re.search(r'\bT2\b', GCodeText.code_of(l))) == 1)
check('part 2: spindle not added (the part starts it)', 'S18000 M3' not in L1 and 'S16000 M3' in L1)
check('motion mode put back after the lift (it was G0: nothing added)', 'G1' not in L1[:L1.index('S16000 M3')])
lint = Lint.lint_lines(L1)
check('part 2 passes the G-code check', lint['errors'] == 0, Lint.summary(lint))
t2, L2, i2 = part(2)
check('last part ends as the program does (no extra lift)', L2[-2:] == ['M5', 'M30'], L2[-3:])
check('part 3: T3 added (its first line is M6 alone)', 'T3' in L2)
for k in range(3):
    lt = Lint.lint_lines(part(k)[1])
    check('part %d lint: no errors, only plunge warnings' % (k + 1), lt['errors'] == 0 and set(x['key'] for x in lt['issues'] if x['level'] != 'info') <= {'plunge'}, [(x['key'], x['level']) for x in lt['issues']])

# The spindle was on at the change and the part cuts without starting it
SPIN = HEAD + P1 + ['T2 M6', 'G0 X120 Y30', 'G0 Z5', 'G1 Z-2 F250', 'G1 X140', 'G0 Z5', 'M5', 'M30']
_, Ls, _ = part(1, SPIN)
i = Ls.index('S18000 M3')
check('spindle restarted with a spin-up pause before the first cut', Ls[i + 1] == 'G4 P10' and i < Ls.index('G1 Z-2 F250'))
# Z first, in G1 mode at the change
ZF = HEAD + P1[:-1] + ['T2 M6', 'Z-1', 'X150 Y50', 'G0 Z5', 'M5', 'M30']
tz, iz = J.part(ZF, 1, 'job.nc', TOP)
Lz = tz.splitlines()
check('a part that moves Z first: over its first point at the top, then G1 back', 'G0 X150 Y50' in Lz and Lz.index('G0 X150 Y50') < Lz.index('G1') < Lz.index('Z-1'), Lz[-12:])
check('... with a warning', iz['warnings'] and 'lowers Z' in iz['warnings'][0])
def part_err(lines, k=1, top=TOP):
    try: J.part(lines, k, 'job.nc', top); return ''
    except J.JobPlanError as e: return str(e)
check('relative mode at the change refused', 'G91' in part_err(HEAD + P1 + ['G91'] + P2 + ['M30']))
check('arc mode at the change refused', 'arc mode' in part_err(HEAD + P1[:-1] + ['G2 X110 Y80 I5 J0'] + P2 + ['M30']))
check('G92 inside refused', 'G92' in part_err(HEAD + ['G92 X0 Y0'] + P1 + P2 + ['M30']))
check('G10 inside refused', 'G10' in part_err(HEAD + ['G10 L2 P1 X0'] + P1 + P2 + ['M30']))
check('variables refused', 'variables' in part_err(HEAD + ['#1 = 5'] + P1 + P2 + ['M30']))
check('G93 refused', 'G93' in part_err(HEAD + ['G93'] + P1 + P2 + ['M30']))
check('canned cycle active at the change refused', 'canned cycle' in part_err(HEAD + P1 + ['G81 X1 Y1 Z-3 R2 F100'] + P2 + ['M30']))
check('G80 ends the cycle', part_err(HEAD + P1 + ['G81 X1 Y1 Z-3 R2 F100', 'G80'] + P2 + ['M30']) == '')
check('unknown top of Z refused', 'Home the machine' in part_err(PROG, 1, None))
check('bad part number refused', 'has 3 part' in part_err(PROG, 5))
INCH = [l.replace('G21', 'G20') for l in HEAD + P1 + P2 + P3]
ti = J.part(INCH, 1, 'j.nc', TOP)[0].splitlines()
check('inch program: lift in mm (G21 before G53), then back to G20', ti.index('G21 G90 G17 G54 G94') < ti.index('G53 G0 Z132') < ti.index('G20 G90'), ti[:14])
check('output name', J.output_name('job.nc', 1, 3) == 'part2of3-job.nc')

# Controller class ------------------------------------------------------------
tmp = tempfile.mkdtemp(); os.makedirs(os.path.join(tmp, 'upload'))
def put(name, lines):
    with open(os.path.join(tmp, 'upload', name), 'w') as f: f.write('\n'.join(lines) + '\n')
put('job.nc', PROG); put('one.nc', HEAD + P1 + ['M30'])
class Log:
    def info(s, *a): pass
    def exception(s, *a): pass
class State:
    def __init__(s, cycle='idle', tm=133.0): s.cycle = cycle; s.files = []; s.tm = tm
    def get(s, k, d=None): return {'cycle': s.cycle, '2tm': s.tm}.get(k, d)
    def find_motor(s, a): return 2 if a == 'z' else None
    def add_file(s, f): s.files.append(f)
class Ctrl:
    def __init__(s, **kw): s.state = State(**kw); s.log = types.SimpleNamespace(get=lambda n: Log())
    def get_upload(s, f=''): return os.path.join(tmp, 'upload', f)
c = Ctrl()
r = bbctrl.JobPlan(c).plan('job.nc')
check('plan API', r['file'] == 'job.nc' and len(r['parts']) == 3)
out = bbctrl.JobPlan(c).part('job.nc', 1)
check('part writes part2of3-job.nc and loads it', out['file'] == 'part2of3-job.nc' and c.state.files == ['part2of3-job.nc'] and out['lint']['errors'] == 0)
check('lift to 1 mm below the top of Z travel', 'G53 G0 Z132' in open(c.get_upload('part2of3-job.nc')).read())
check('one tool: the program itself, nothing written', bbctrl.JobPlan(c).part('one.nc', 0)['file'] == 'one.nc' and c.state.files == ['part2of3-job.nc'])
try: bbctrl.JobPlan(Ctrl(cycle='running')).part('job.nc', 1); check('part refused while running', False)
except J.JobPlanError as e: check('part refused while running', 'idle' in str(e))
try: bbctrl.JobPlan(c).plan('../x'); check('path outside uploads refused', False)
except J.JobPlanError: check('path outside uploads refused', True)

def web(body):
    h = Web.WizardHandler.__new__(Web.WizardHandler); h.get_ctrl = lambda: Ctrl(); h.json = body
    got = {}
    h.write_json = lambda v: got.setdefault('v', v)
    try: run_sync(h.put); return got.get('v'), None
    except Web.HTTPError as e: return None, e
v, e = web({'action': 'plan', 'file': 'job.nc'})
check('API plan', v and len(v['parts']) == 3 and not e)
v, e = web({'action': 'part', 'file': 'job.nc', 'index': 2})
check('API part', v and v['file'] == 'part3of3-job.nc')
v, e = web({'action': 'part', 'file': 'job.nc', 'index': 'x'})
check('API bad index is a 400', e is not None and e.status_code == 400)
done()
