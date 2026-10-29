# Small G-code simulator for the probing programs (see measure-sim.py, setter-sim.py).
import re, sys, json, math, subprocess
import os
S = os.path.dirname(os.path.abspath(__file__))
def gen(opts, mod='measure.js', fn='measureProgram'):
    base = dict(ball=2, clear=5, depth=3, margin=10, travel=1000, fast=200, slow=25)
    return subprocess.run(['node', S+'/gen.mjs', mod, fn, json.dumps({**base, **opts})], capture_output=True, text=True, check=True).stdout

class Crash(Exception): pass
_H = []
def _harness():
    if not _H:
        sys.path.insert(0, os.path.join(S, '..', '..', 'py', 'tests'))
        import seekharness; _H.append(seekharness)
    return _H[0]
class NotFound(Exception): pass

def box_dist(c, b):  # distance from point c to axis-aligned box b=(x0,x1,y0,y1,z0,z1)
    d = 0
    for i,(lo,hi) in enumerate(((b[0],b[1]),(b[2],b[3]),(b[4],b[5]))):
        v = c[i]
        if v < lo: d += (lo-v)**2
        elif v > hi: d += (v-hi)**2
    return math.sqrt(d)

class Sim:
    def __init__(s, start, r, obstacles):
        s.P = list(start)          # machine position (spindle); the tool tip is L below it
        s.L = 0.0                  # tool length beyond the reference tool
        s.r = r; s.obs = obstacles
        s.off = [0,0,0]; s.vars = {}; s.inc = False; s.log = []
    def touching(s, P):
        c = (P[0], P[1], P[2] - s.L + s.r)
        # Boxes are (x0,x1,y0,y1,z0,z1); anything else has a dist(point) method (1.31.0: plates with bores)
        return any((b.dist(c) if hasattr(b, 'dist') else box_dist(c, b)) <= s.r + 1e-9 for b in s.obs)
    def work(s): return [s.P[i]-s.off[i] for i in range(3)]
    def ev(s, e):
        def var(m):
            k = m.group(1) or m.group(2)
            if k not in s.vars: raise Exception('unset var '+k)
            return '(%r)' % s.vars[k]
        e = re.sub(r'#<([^>]+)>|#(\d+)', var, e)
        e = e.replace('ABS','abs').replace('[','(').replace(']',')').replace(' EQ ','==').replace(' GT ','>').replace(' NE ','!=').replace(' LT ','<')
        return float(eval(e))
    def words(s, line):
        out=[]; i=0
        while i < len(line):
            ch=line[i]
            if ch.isalpha():
                j=i+1
                if j<len(line) and line[j]=='[':
                    depth=0; k=j
                    while True:
                        if line[k]=='[': depth+=1
                        elif line[k]==']':
                            depth-=1
                            if depth==0: break
                        k+=1
                    out.append((ch.upper(), s.ev(line[j:k+1]))); i=k+1
                else:
                    m=re.match(r'-?[\d.]+', line[j:]); out.append((ch.upper(), float(m.group(0)))); i=j+len(m.group(0))
            else: i+=1
        return out
    def move(s, tgt, probe=None):
        start = s.P[:]; d = math.dist(start, tgt); steps = max(1, int(d/0.002))
        if probe and s.touching(start): raise Exception('probe already triggered at start')
        for k in range(1, steps+1):
            p = [start[i] + (tgt[i]-start[i])*k/steps for i in range(3)]
            if s.touching(p):
                if probe: s.P = p; return True
                raise Crash('unguarded move hit something at %s' % [round(v,3) for v in p])
        s.P = list(tgt)
        if probe == 'G38.2': raise NotFound('Switch not found')
        return False
    def run(s, prog):
        # 1.31.1: by default every program runs through the controller's real
        # Planner/Mach/Comm code with a CAMotics-like interpreter and an
        # AVR-like executor (src/py/tests/seekharness.py), so a probing move
        # must end, contact or not, through the same restart path as on the
        # machine.  A regression there hangs the run (seekharness.Hang).
        # SIM_DIRECT=1 interprets the G-code directly (the old behaviour).
        if not os.environ.get('SIM_DIRECT') and not getattr(s, 'direct', False):
            return _harness().run(s, prog)
        return s.run_direct(prog)
    def run_direct(s, prog):
        g = s.steps(prog); r = None
        while True:
            try: ev = g.send(r)
            except StopIteration: return s
            r = None
            if ev[0] == 'line': s.move(ev[1])
            elif ev[0] == 'probe': r = s.move(ev[1], 'G38.2' if ev[2] == 38.2 else 'G38.3')
    def steps(s, prog):
        # The interpreter.  Yields ('line', target), ('probe', target, 38.2|38.3)
        # (sent back: True on contact; s.P is where the machine stopped) and
        # ('set', name, value) for #<_name> globals.  Targets are machine coordinates.
        lines = [l.split('(')[0].strip() for l in prog.splitlines()]
        stack=[]; active=True   # o-word if / else / endif (else added in 1.29.0)
        for line in lines:
            if not line: continue
            m = re.match(r'o\d+\s+(if|endif|else)\s*(.*)', line)
            if m:
                if m.group(1)=='if':
                    cond = bool(s.ev(m.group(2))) if active else False
                    stack.append((active, cond)); active = active and cond
                elif m.group(1)=='else':
                    parent, taken = stack[-1]; active = parent and not taken
                else: active = stack.pop()[0]
                continue
            if not active: continue
            m = re.match(r'#<([^>]+)>\s*=\s*(.*)', line)
            if m:
                s.vars[m.group(1)] = s.ev(m.group(2))
                if m.group(1).startswith('_'): yield ('set', m.group(1), s.vars[m.group(1)])
                continue
            ws = s.words(line); g=[v for k,v in ws if k=='G']; ax={k:v for k,v in ws if k in 'XYZ'}
            # M62-M66 (1.45.0): ('output', port, value) and ('input', port, mode, timeout),
            # sent back: the M66 result, kept in #5399
            ms=[v for k,v in ws if k=='M']; wd={k:v for k,v in ws}
            for v in ms:
                if v in (62,63,64,65): yield ('output', int(wd.get('P',0)), 1 if v in (62,64) else 0)
                if v == 66:
                    res = yield ('input', int(wd.get('P',0)), int(wd.get('L',0)), float(wd.get('Q',0)))
                    s.vars['5399'] = float(res)
            for v in g:
                if v==91: s.inc=True
                if v==90: s.inc=False
            if 92 in g:
                for k,v in ax.items(): i='XYZ'.index(k); s.off[i] = s.P[i]-v
                continue
            mv = [v for v in g if v in (0,1,38.2,38.3)]
            if 53 in g and not mv: mv=[0]
            if not mv or not ax: continue
            cur = s.work(); tgt = s.P[:]
            for k,v in ax.items():
                i='XYZ'.index(k)
                if 53 in g: tgt[i] = v
                else: tgt[i] = (s.P[i]+v) if s.inc else (v+s.off[i])
            kind = mv[-1]
            if kind in (38.2,38.3):
                hit = yield ('probe', tgt, kind)
                # #5061-#5063: work coordinates by default.  probe_frame = 'machine' models the reading
                # of the CAMotics source (machine coordinates); see the 1.29.0 release notes, item 2.
                w = s.P[:] if getattr(s, 'probe_frame', 'work') == 'machine' else s.work()
                # 1.31.0: optional reading noise on the reported touch (s.noise: std dev, mm)
                if getattr(s, 'noise', 0): w = [v + s.rng.gauss(0, s.noise) for v in w]
                s.vars['5061'],s.vars['5062'],s.vars['5063'] = w; s.vars['5070'] = 1.0 if hit else 0.0
            else: yield ('line', tgt)

