# Touch-plate probe programs (probe.js, 1.29.0) in the small simulator (simlib.py).
#   python3 src/react-ui/test/probe-sim.py
# 1. The 1.29.0 programs measure and set zero exactly like 1.28.1 (probe-old.mjs) for every corner,
#    Z only, rotary and both center modes, with #5061-#5063 read as work coordinates (simlib's model)
#    and as machine coordinates (the CAMotics source). Item 2 of the release notes is not decided here.
# 2. Where 1.28.1 rapided the bit into the block (started too far from an edge), 1.29.0 stops the
#    guarded move, reports why (ofprobe_fail) and lifts, and never sets the done token.
import re, sys
from simlib import Sim, gen, Crash, NotFound

ok = True
def check(name, cond, msg=''):
    global ok; print(('PASS ' if cond else 'FAIL ') + name, msg); ok = ok and bool(cond)

CFG = {'probe': {'probe-xdim': 53.975, 'probe-ydim': 53.975, 'probe-zdim': 15.4, 'probe-slow-seek': 25, 'probe-fast-seek': 75},
       'probe-rotary': {'probe-xdim': 40, 'probe-ydim': 40, 'probe-zdim': 12, 'probe-slow-seek': 25, 'probe-fast-seek': 75}}
D = 6.35; R = D / 2; TOK = 4242
SX0, SY0, W, L, TOP = 100.0, 100.0, 300.0, 200.0, 30.0     # stock (machine coordinates)
H = 15.4

def norm(prog):  # 1.28.1 wrote "G38.2 Z -25"; simlib wants "Z-25"
    return re.sub(r'(?<![A-Za-z])([XYZF]) (?=[-\d.\[])', r'\1', prog)

def program(new, fn, opts):
    if new: return gen(dict(opts, token=TOK), 'probe.js', fn)
    return norm(gen(opts, '../test/probe-old.mjs', {'probeProgram': 'oldProbe', 'centerSecondProgram': 'oldCenterSecond'}[fn]))

def block(cx, cy, sx, sy, dx, dy, h=H, lip=5):
    # On the stock corner (cx, cy), reaching dx/dy into the stock (sx/sy: the direction into the
    # stock) and lip mm out over the edges.
    xs = sorted([cx - sx * lip, cx + sx * dx]); ys = sorted([cy - sy * lip, cy + sy * dy])
    return (xs[0], xs[1], ys[0], ys[1], TOP, TOP + h)

CORNERS = {'front-left': (SX0, SY0, 1, 1), 'front-right': (SX0 + W, SY0, -1, 1),
           'back-left': (SX0, SY0 + L, 1, -1), 'back-right': (SX0 + W, SY0 + L, -1, -1)}

def run(new, fn, opts, start, obs, frame='work'):
    s = Sim(start, R, obs); s.probe_frame = frame
    s.run(program(new, fn, opts))
    return s

def same(a, b): return all(abs(x - y) < 1e-6 for x, y in zip(a, b))

for frame in ('work', 'machine'):
    for loc, (cx, cy, sx, sy) in CORNERS.items():
        obs = [block(cx, cy, sx, sy, 53.975, 53.975)]
        start = [cx + sx * 45, cy + sy * 45, TOP + H + 8]   # over the block, 9 mm in from the probed faces
        opts = dict(config=CFG, type='xyz', loc=loc, dia={'mm': D})
        a = run(False, 'probeProgram', opts, start, obs, frame); b = run(True, 'probeProgram', opts, start, obs, frame)
        check('%s %s: zero identical to 1.28.1' % (frame, loc), same(a.off, b.off) and same(a.P, b.P), (a.off, b.off))
        check('%s %s: zero on the stock corner' % (frame, loc), abs(b.off[0] - cx) < 0.01 and abs(b.off[1] - cy) < 0.01 and abs(b.off[2] - TOP) < 0.01, b.off)
        check('%s %s: done token set, no fail' % (frame, loc), b.vars.get('_ofprobe_done') == TOK and b.vars.get('_ofprobe_fail') == 0)

    obs = [(150, 200, 150, 200, TOP, TOP + H)]
    opts = dict(config=CFG, type='z', dia={'mm': D})
    a = run(False, 'probeProgram', opts, [170, 170, TOP + H + 10], obs, frame); b = run(True, 'probeProgram', opts, [170, 170, TOP + H + 10], obs, frame)
    check('%s Z only: identical' % frame, same(a.off, b.off) and same(a.P, b.P) and b.vars['_ofprobe_done'] == TOK, (a.off, b.off))

    obs = [block(SX0, SY0, 1, 1, 40, 40, h=12)]
    opts = dict(config=CFG, type='xyz', rotary=True, dia={'mm': D})
    a = run(False, 'probeProgram', opts, [SX0 + 32, SY0 + 32, TOP + 20], obs, frame); b = run(True, 'probeProgram', opts, [SX0 + 32, SY0 + 32, TOP + 20], obs, frame)
    check('%s rotary: identical' % frame, same(a.off, b.off) and same(a.P, b.P) and b.vars['_ofprobe_done'] == TOK, (a.off, b.off))

    for loc, second in (('center', 'back-right'), ('center-x', 'front-right')):
        res = []
        for new in (False, True):
            cx, cy, sx, sy = CORNERS['front-left']
            s = Sim([cx + 45, cy + 45, TOP + H + 8], R, [block(cx, cy, sx, sy, 53.975, 53.975)]); s.probe_frame = frame
            if loc == 'center-x': s.off[1] = 123.0       # Y zero from an earlier setup, must be kept
            opts = dict(config=CFG, type='center', loc=loc, dia={'mm': D})
            s.run(program(new, 'probeProgram', opts))
            cx, cy, sx, sy = CORNERS[second]
            s.P = [cx + sx * 45, cy + sy * 45, TOP + H + 8]; s.obs = [block(cx, cy, sx, sy, 53.975, 53.975)]; s.inc = False
            s.run(program(new, 'centerSecondProgram', opts))
            res.append(s)
        a, b = res
        keys = ('_ofprobe_ok', '_ofprobe_dz', '_ofprobe_hx', '_ofprobe_hy', '_ofprobe_zt', '_ofprobe_xa', '_ofprobe_ya')
        va = dict((k, a.vars.get(k)) for k in keys); vb = dict((k, b.vars.get(k)) for k in keys)
        check('%s %s: offsets and results identical to 1.28.1' % (frame, loc), same(a.off, b.off) and same(a.P, b.P) and
              all((va[k] is None and vb[k] is None) or (va[k] is not None and vb[k] is not None and abs(va[k] - vb[k]) < 1e-6) for k in keys), (va, vb))
        check('%s %s: done token set' % (frame, loc), b.vars.get('_ofprobe_done') == TOK and b.vars.get('_ofprobe_fail') == 0)
        print('     %s %s: ofprobe_ok=%s dz=%.3f, X0 at machine %.3f (true center %.3f), Y0 at %.3f (wanted %.3f)'
              % (frame, loc, vb['_ofprobe_ok'], vb['_ofprobe_dz'], b.off[0], SX0 + W / 2, b.off[1], SY0 + L / 2 if loc == 'center' else 123.0))

# Started too far from an edge: 1.28.1 rapided into the block; 1.29.0 stops, says why and lifts
cx, cy, sx, sy = CORNERS['front-left']
obs = [block(cx, cy, sx, sy, 53.975, 53.975)]
opts = dict(config=CFG, type='xyz', loc='front-left', dia={'mm': D})
for name, start, code in (('30 mm in from the right face', [cx + 24, cy + 45, TOP + H + 8], 1),
                          ('30 mm in from the back face', [cx + 45, cy + 24, TOP + H + 8], 3)):
    try: run(False, 'probeProgram', opts, start, obs); old = 'no crash'
    except Crash: old = 'Crash'
    check('1.28.1, %s: rapid into the block' % name, old == 'Crash', old)
    try:
        s = run(True, 'probeProgram', opts, start, obs)
        check('1.29.0, %s: guarded move stops, fail %d, no done token' % (name, code),
              s.vars['_ofprobe_fail'] == code and s.vars['_ofprobe_done'] == 0, s.vars.get('_ofprobe_fail'))
        check('1.29.0, %s: bit lifted clear of the block' % name, s.P[2] - R > TOP + H, s.P)
    except Crash as e: check('1.29.0, %s: no crash' % name, False, str(e))
try: run(True, 'probeProgram', opts, [cx + 45, cy + 45, TOP + H + 30], obs); check('too high: Switch not found', False)
except NotFound: check('too high: Switch not found (no done token can be set)', True)

cxb, cyb, sxb, syb = CORNERS['back-right']
def center_second(new, start):
    s = Sim([cx + 45, cy + 45, TOP + H + 8], R, obs); s.probe_frame = 'machine'
    o = dict(config=CFG, type='center', loc='center', dia={'mm': D}); s.run(program(new, 'probeProgram', o))
    s.P = start; s.obs = [block(cxb, cyb, sxb, syb, 53.975, 53.975)]; s.inc = False
    s.run(program(new, 'centerSecondProgram', o)); return s
try: center_second(False, [cxb - 24, cyb - 45, TOP + H + 8]); old = 'no crash'
except Crash: old = 'Crash'
s = center_second(True, [cxb - 24, cyb - 45, TOP + H + 8])
check('center second, too far in: 1.28.1 crashed, 1.29.0 stops with fail 1', old == 'Crash' and s.vars['_ofprobe_fail'] == 1 and s.vars['_ofprobe_done'] == 0, old)

for fn, o in (('probeProgram', dict(config=CFG, type='z', dia={'mm': D})), ('probeProgram', dict(config=CFG, type='xyz', loc='back-right', dia={'mm': D})),
              ('centerSecondProgram', dict(config=CFG, type='center', loc='center', dia={'mm': D}))):
    p = [l.strip() for l in gen(dict(o, token=TOK), 'probe.js', fn).splitlines() if l.strip()]
    nm = '%s %s' % (fn, o.get('loc', o['type']))
    check(nm + ': M5 first, token last before M2', p[1] == 'M5' and p[-1] == 'M2' and p[-3] == '#<_ofprobe_done> = %d' % TOK, p[:3])
    check(nm + ': no rapid or feed moves down, probe moves relative', all(not re.match(r'(G91 )?G[01] Z-', l) for l in p) and all('G91' in l for l in p if 'G38' in l))
print('ALL PASS' if ok else 'SOME FAILED')
sys.exit(0 if ok else 1)
