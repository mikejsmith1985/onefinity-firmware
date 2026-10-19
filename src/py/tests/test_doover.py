# Cut deeper (1.30.0): splitting operations, floors, the program it writes,
# what it refuses, and the controller-side checks (last run, zero, travel).
#   python3 src/py/tests/test_doover.py
import sys, os, re, json, types, tempfile, hashlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bbstub import check, done
import bbctrl
from bbctrl import Lint, GCodeText
D = sys.modules['bbctrl.DoOver']
Web = sys.modules['bbctrl.Web']
import doover_progs as P


def ops_of(prog):
    ops, wcs, tool, inch = D.parse(prog)
    D.analyse_ops(ops)
    return D.summary(ops, GCodeText.setup_fields(prog), 'in' if inch else 'mm')


def build(prog, opts=None, **kw):
    kw.setdefault('top_mm', -2); kw.setdefault('tool_now', 1)
    return D.build(prog, kw.pop('name', 'part.nc'), opts or {}, **kw)


def code_lines(text):
    return [GCodeText.code_of(l).strip() for l in text.splitlines() if GCodeText.code_of(l).strip()]


def zs(text, g=None):
    out = []
    for l in code_lines(text):
        m = re.search(r'Z(-?[\d.]+)', l)
        if m and (g is None or l.startswith(g)): out.append(float(m.group(1)))
    return out

# Operations and floors ------------------------------------------------------
std = P.STANDARD()
s = ops_of(std)
names = [o['name'] for o in s['ops']]
check('operations split at the Fusion comments', names == ['2D Pocket1', '2D Contour1', 'Bore1', 'Drill1'], names)
check('floors found', [o['floor'] for o in s['ops']] == [-1.5, -3.2, -3.2, -3.2], [o['floor'] for o in s['ops']])
check('through cuts chosen by default, the shallow pocket not', [o['default'] for o in s['ops']] == [False, True, True, True])
c = s['ops'][1]
check('contour: one closed pass over one tab', c['passes'] == 1 and c['closed'] == 1 and c['tabs'] == 1, c)
check('drill: two holes', s['ops'][3]['holes'] == 2)
check('stock bottom from the sheet', s['stock_bottom'] == -3.0 and s['deepest'] == -3.2)
s2 = ops_of(P.program(P.contour(levels=(-1, -2, -2.8), tabs=False)))
check('suggested extra reaches 0.2 mm past the stock bottom', s2['suggest_extra'] == 0.4, s2['suggest_extra'])

# The program it writes ------------------------------------------------------
t, info = build(std, {'extra': 1.5})
lint = Lint.lint_lines(t.splitlines())
check('generated program passes the G-code check (no errors)', lint['errors'] == 0, Lint.summary(lint))
check('only plunge warnings', set(i['key'] for i in lint['issues'] if i['level'] == 'warn') <= {'plunge'},
      [(i['key'], i['level']) for i in lint['issues']])
check('passes at -4.2 and -4.7 (1 mm steps)', sorted(set(z for z in zs(t, 'G2') + zs(t, 'G1') if z < -3.21)) == [-4.7, -4.2])
cuts = [l for l in code_lines(t) if re.match(r'G[123] X', l)]
bad = [l for l in cuts if float(re.search(r'Z(-?[\d.]+)', l).group(1)) > -3.2 + 1e-6 and 'Y' in l
       and not re.search(r'X45 Y(1[3-9]|2[0-7])', l)]
check('no sideways cut above the old floor except over the tab', not bad, bad[:3])
entry = [l for l in code_lines(t) if l.startswith('G1 Z-2.7')]
check('entry down to 0.5 mm above the old floor is a feed (one per pass and hole)', len(entry) == 4, entry)
check('no rapid moves sideways below the stock top or plunges into it',
      not [i for i in lint['issues'] if i['key'] in ('rapid-low', 'rapid-plunge')])
first_down = [l for l in code_lines(t) if l.startswith('G0 Z') and float(l.split('Z')[1]) < 0]
check('the only rapids below Z0 go up (drill chip clearing)', all(l == 'G0 Z-2.7' for l in first_down), first_down)
check('pocket left alone', '2D Pocket1' not in t)
check('helix dropped, bottom circle kept', all(z in (-4.2, -4.7) for z in zs(t, 'G2')) and len(zs(t, 'G2')) == 2, zs(t, 'G2'))
check('drill holes drilled again with G1, no canned cycle', not re.search(r'\bG8\d', t) and t.count('G0 X70 Y') == 2)
check('starts in mm, absolute, G54', code_lines(t)[0] == 'G21 G90 G94 G17 G40 G54')
check('lifts to the top first and last', code_lines(t)[3] == 'G53 G0 Z-2' and code_lines(t)[-2] == 'G53 G0 Z-2' and code_lines(t)[-1] == 'M30')
check('spindle started from the program (S18000 M3) with spin-up', 'S18000 M3\nG4 P10' in t)
check('pause over the first cut', t.count('M0') == 1 and 'over the old cut' in t)
check('info: passes, holes, time', info['passes'] == 2 and info['holes'] == 2 and info['time'] > 0, info)

t05, _ = build(std, {'extra': 0.5})
check('0.5 mm: one pass at -3.7', sorted(set(z for z in zs(t05) if z < -3.21)) == [-3.7])
t24, _ = build(std, {'extra': 2.0, 'step': 0.6})
check('2 mm in 0.6 mm steps: -3.8 -4.4 -5 -5.2', sorted(set(z for z in zs(t24) if z < -3.21), reverse=True) == [-3.8, -4.4, -5.0, -5.2], sorted(set(zs(t24))))
t07, _ = build(std, {'extra': 0.5, 'start_above': 0.7})
check('start above 0.7 mm: feed starts at -2.5', 'G1 Z-2.5' in t07 and 'G1 Z-2.7' not in t07)

# Tabs
tk, _ = build(std, {'extra': 1.0})
check('tabs kept: path over the tab at its original height', 'G1 X45 Y14 Z-1.2' in tk and 'G1 X45 Y26 Z-1.2' in tk)
tu, iu = build(std, {'extra': 1.0, 'tabs': 'under'})
check('tabs cut through: a step at a time from the top', 'G1 X45 Y14 Z-2.2' in tu and 'G1 X45 Y14 Z-1.2' not in tu, [l for l in code_lines(tu) if 'X45 Y14' in l])
single = P.program(P.contour(levels=(-3.2,)))
ts, isg = build(single, {'extra': 1.0, 'tabs': 'under'})
check('single-pass contour: tab cannot be confirmed, kept and warned',
      'G1 X45 Y14 Z-1.2' in ts and any('could not be confirmed' in w for w in isg['warnings']))

# Units, arcs, canned cycles
ti, _ = build(P.to_inch(std), {'extra': 1.5})
check('inch program: same mm program', [re.sub(r'(\d\.\d{3})\d*', r'\1', l) for l in code_lines(ti)] ==
      [re.sub(r'(\d\.\d{3})\d*', r'\1', l) for l in code_lines(t)] or
      zs(ti) == zs(t), (code_lines(ti)[:20], code_lines(t)[:20]))
check('inch program reported as inches', ops_of(P.to_inch(std))['units'] == 'in')
pa = P.program(P.contour(arcs=True, tabs=False), P.canned(code=83))
ta, ia = build(pa, {'extra': 1.0})
check('arc corner kept with its centre', 'G3 X5 Y30 Z-4.2 I0 J-5' in ta, [l for l in code_lines(ta) if l.startswith('G3')])
check('G83 holes drilled with straight moves', 'G83' not in ta and ta.count('G0 X74 Y') == 2 and Lint.lint_lines(ta.splitlines())['errors'] == 0)

# Several tools, manual router
two = P.program(P.contour(tool=1), P.contour(tool=2, name='2D Contour2', x0=50, w=20, h=20, rpm=12000))
t2, i2 = build(two, {'extra': 0.5}, manual=True, router='dial 4')
check('second tool: router off, M6, router on again', 'Switch the router OFF for the tool change to T2' in t2 and 'T2 M6' in t2
      and t2.count('Switch the router ON at dial 4') == 2, i2['warnings'])
check('second tool spindle speed', 'S12000 M3' in t2)
check('two tools: warns to set Z the same way', any('more than one tool' in w for w in i2['warnings']))
check('after the tool change Z goes to the top before moving over', re.search(r'T2 M6\nG53 G0 Z-2\nG0 X50 Y5\nG0 Z15', t2) is not None)
t3, i3 = build(two, {'extra': 0.5}, tool_now=2)
check('starts with a tool change when T2 is in the spindle', 'T1 M6' in t3 and any('starts with a tool change' in w for w in i3['warnings']))

# Setup sheet and names
tn, _ = build(std, {'extra': 0.5}, name='bracket (2).nc')
sheet = GCodeText.setup_fields(tn.splitlines())
check('setup sheet copied: stock, corner, router, tool', sheet.get('stock') == 'x=0..80 y=0..40 z=-3..0' and sheet.get('probe-corner') == 'front-left'
      and sheet.get('router') == 'dial 4' and sheet.get('tool-geom') == 'flat 6.35', sheet)
check('job line says what it is', sheet.get('job', '').startswith('Cut deeper of bracket [2].nc'), sheet.get('job'))
check('do-over line explains it', 'do-over' in sheet and '_bad' not in sheet)
check('no comment the planner would misread', all(not GCodeText.split(l)[2] for l in tn.splitlines()))
check('Lint reads the copied stock top', Lint.lint_lines(tn.splitlines())['stock_top'] == 0.0)

# Spoilboard
_, isp = build(std, {'extra': 1.5})
check('warns when the new floor is >1 mm into the spoilboard', any('spoilboard' in w for w in isp['warnings']))
_, isp2 = build(std, {'extra': 0.5})
check('no spoilboard warning at 0.5 mm', not any('spoilboard' in w for w in isp2['warnings']))
_, inos = build(P.program(P.contour(), setup=False), {'extra': 0.5})
check('no sheet: says the floor cannot be checked', any('no stock Z range' in w for w in inos['warnings']))

# Refusals ---------------------------------------------------------------------
def refused(prog, opts=None, text=''):
    try: build(prog, opts or {'extra': 0.5, 'ops': [0]}); return False
    except D.DoOverError as e: return text in str(e) or str(e)

base = P.program(P.contour(tabs=False))
def ins(line, at=-5):
    p = list(base); p.insert(len(p) + at, line) if at < 0 else p.insert(at, line); return p
check('expressions refused', refused(ins('G1 X#1'), text='variables') is True)
check('G92 refused', refused(ins('G92 X0'), text='G92') is True)
check('G10 refused', refused(ins('G10 L2 P1 X0'), text='G10') is True)
check('O-word refused', refused(ins('o100 call'), text='O-word') is True)
check('M98 refused', refused(ins('M98 P100'), text='M98') is True)
check('nested comment refused', refused(ins('G1 X1 (a (b) c)'), text='brackets') is True)
g91 = list(base); i = g91.index('G1 Z-3.2 F300'); g91[i:i] = ['G91', 'G1 X1', 'G90']
check('G91 in the operation refused', refused(g91, text='relative') is True, refused(g91))
g41 = list(base); g41.insert(g41.index('G1 Z-3.2 F300'), 'G41')
check('G41 refused', refused(g41, text='compensation') is True)
g93 = list(base); g93.insert(g93.index('G1 Z-3.2 F300'), 'G93')
check('G93 refused', refused(g93, text='G93') is True)
g18 = list(base); g18[g18.index('G1 Z-3.2 F300') + 1:g18.index('G1 Z-3.2 F300') + 1] = ['G18', 'G2 X5 Z-3.2 I1 K0', 'G17']
check('XZ arcs refused', refused(g18, text='G18') is True, refused(g18))
two_wcs = P.program(P.contour(tabs=False), [l.replace('G54', 'G55') for l in P.contour(name='B', x0=50, w=10, h=10)])
check('two work offsets refused', refused(two_wcs, {'extra': 0.5, 'ops': [0, 1]}, text='more than one work offset') is True)
check('extra 0 refused', refused(base, {'extra': 0}, text='between') is True)
check('extra 6 refused', refused(base, {'extra': 6}, text='between') is True)
check('extra text refused', refused(base, {'extra': 'lots'}, text='number') is True)
check('no operation chosen refused', refused(base, {'extra': 0.5, 'ops': []}, text='at least one') is True)
check('operation that does not exist refused', refused(base, {'extra': 0.5, 'ops': [7]}, text='no operation 8') is True)
ramp = P.program(['(Adaptive1)', 'T1 M6', 'S18000 M3', 'G54', 'G0 X0 Y0 Z5', 'G1 Z0 F300', 'G1 X10 Z-1 F900', 'G1 X20 Z-2', 'G0 Z15'])
r = ops_of(ramp)['ops'][0]
check('ramping toolpath: no floor passes, cannot be chosen', r['reason'] and 'no passes' in r['reason'] and not r['default'], r)
check('choosing the pocket explicitly works', 'G1 X30 Y15 Z-2' in build(std, {'extra': 0.5, 'ops': [0]})[0])

# Controller side: last run, zero, travel ----------------------------------
tmp = tempfile.mkdtemp()
os.makedirs(os.path.join(tmp, 'upload')); os.makedirs(os.path.join(tmp, 'next-data'))
with open(os.path.join(tmp, 'upload', 'part.nc'), 'w') as f: f.write('\n'.join(std) + '\n')
sha = hashlib.sha256(open(os.path.join(tmp, 'upload', 'part.nc'), 'rb').read()).hexdigest()

class State:
    def __init__(s, v, homed='xyz'): s.v = dict(v); s.homed = homed; s.files = []
    def get(s, k, d=None): return s.v.get(k, d)
    def is_axis_homed(s, a): return a in s.homed
    def find_motor(s, a): return 2 if a == 'z' else None
    def add_file(s, f): s.files.append(f); s.v['selected'] = f
class CP:
    def __init__(s, r): s.r = r
    def get(s): return s.r
class Log:
    def info(s, *a): pass
    def warning(s, *a): pass
    def exception(s, *a): pass
    def error(s, *a): pass
class Ctrl:
    def __init__(s, rec, state):
        s.state = state; s.checkpoint = CP(rec); s.config = {'tool-type': 'PWM Spindle', 'selected-tool': 'pwm'}
        s.log = types.SimpleNamespace(get=lambda n: Log()); s.sent = []
        s.mach = types.SimpleNamespace(mdi=lambda c: s.sent.append(c))
        s.resume = bbctrl.Resume(s)
    def get_path(s, d=None, f=None): return os.path.join(tmp, d) if d else tmp
    def get_upload(s, f=''): return os.path.join(tmp, 'upload', f)

OFF = {'x': 100.0, 'y': 50.0, 'z': -60.0}
def rec(**kw):
    r = {'file': 'part.nc', 'sha': sha, 'status': 'stopped', 'line': len(std), 'nlines': len(std), 'tool': 1, 't': 1000,
         'offset': dict(OFF)}
    r.update(kw); return r
def state(**kw):
    v = {'cycle': 'idle', 'metric': True, 'offset_x': 100.0, 'offset_y': 50.0, 'offset_z': -60.0, '2tm': 0.0, '2tn': -130.0,
         'tool': 1, 'xp': 10, 'yp': 10, 'zp': -10}
    v.update(kw); return State(v)
def dov(r, st=None): return bbctrl.DoOver(Ctrl(r, st or state()))

a = dov(rec()).analyse('part.nc')
check('analyse: run ok, zero the same', a['run']['status'] == 'ok' and a['output'] == 'doover-part.nc', a['run'])
check('analyse: operations listed', len(a['ops']) == 4 and a['wcs'] == ['G54'])
c = Ctrl(rec(), state()); out = bbctrl.DoOver(c).build('part.nc', {'extra': 1.0})
check('build writes doover-part.nc and loads it', c.state.files == ['doover-part.nc'] and
      os.path.isfile(os.path.join(tmp, 'upload', 'doover-part.nc')) and out['file'] == 'doover-part.nc')
check('build returns lint result with no errors', out['lint']['errors'] == 0)
check('top of travel used for the first lift', 'G53 G0 Z-1' in open(os.path.join(tmp, 'upload', 'doover-part.nc')).read())

def build_err(r, st=None, opts=None):
    try: dov(r, st).build('part.nc', opts or {'extra': 1.0}); return ''
    except D.DoOverError as e: return str(e)
check('interrupted run refused (use Resume)', 'Finish it with Resume' in build_err(rec(line=40)))
check('E-stopped run refused', 'did not finish' in build_err(rec(status='estop')))
check('no saved run: refused without the confirm box', 'Tick the box' in build_err(None))
check('no saved run: allowed with the confirm box', build_err(None, opts={'extra': 1.0, 'ack_unknown': True}) == '')
check('other program ran since: unknown', dov(rec(file='other.nc')).analyse('part.nc')['run']['status'] == 'unknown')
check('program changed since it ran: unknown', dov(rec(sha='0' * 64)).analyse('part.nc')['run']['status'] == 'unknown')
moved = state(offset_z=-59.5)
e = build_err(rec(), moved)
check('zero moved: refused, says by how much', 'Z by 0.5 mm' in e, e)
check('zero moved: no override', 'Put the zero back' in build_err(rec(), moved, {'extra': 1.0, 'ack_zero': True, 'ack_unknown': True}))
check('within 0.05 mm is the same zero', build_err(rec(), state(offset_x=100.04)) == '')
check('not homed refused', 'Home the machine' in build_err(rec(), State(state().v, homed='xy')))
check('running refused', 'idle' in build_err(rec(), state(cycle='running')))
check('below Z travel refused', 'below the bottom of Z travel' in build_err(rec(), state(**{'2tn': -62.0})))
with open(os.path.join(tmp, 'next-data', 'probe.json'), 'w') as f: json.dump({'loc': 'front-left', 'time': 2000 * 1000}, f)
a = dov(rec()).analyse('part.nc')
check('probed again since the run: noted', any('probed again' in n for n in a['run']['notes']), a['run'])
c = Ctrl(rec(), state(offset_z=-59.5, xp=0, yp=0, zp=0)); r = bbctrl.DoOver(c).restore_zero('part.nc', 'xyz')
check('restore zero: G92 back to the run\'s zero', c.sent and c.sent[-1] == 'G92 X-100 Y-50 Z60', c.sent)
try: bbctrl.DoOver(Ctrl(rec(file='other.nc'), state())).restore_zero('part.nc', 'xyz'); check('restore zero needs a run of this file', False)
except D.DoOverError: check('restore zero needs a run of this file', True)
try: dov(rec()).analyse('../etc/passwd'); check('path outside uploads refused', False)
except D.DoOverError: check('path outside uploads refused', True)

# Web handler
def web(body, r=None, st=None):
    c = Ctrl(rec() if r is None else r, st or state())
    bbctrl.DoOver.__init__  # noqa
    h = Web.DoOverHandler.__new__(Web.DoOverHandler); h.get_ctrl = lambda: c; h.json = body
    got = {}
    h.write_json = lambda v: got.setdefault('v', v)
    try: h.put(); return got.get('v'), None
    except Web.HTTPError as e: return None, e
v, e = web({'action': 'analyse', 'file': 'part.nc'})
check('API analyse', v and v['file'] == 'part.nc' and not e)
v, e = web({'action': 'build', 'file': 'part.nc', 'opts': {'extra': 0.5}}, r=rec(line=3))
check('API build refusal is a 400 with the reason', e is not None and e.status_code == 400 and 'Resume' in (e.log_message % e.args if e.args else e.log_message), e)
v, e = web({'action': 'nope', 'file': 'part.nc'})
check('API unknown action 400', e is not None and e.status_code == 400)
done()
