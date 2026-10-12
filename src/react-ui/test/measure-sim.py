# Runs the Measure stock program from measure.js against a simulated machine
# (stock, vise jaws, clamps) and checks the size, the zero and every stop.
#   python3 src/react-ui/test/measure-sim.py
import re, sys, json, math, subprocess
S = sys.argv[0].rsplit('/',1)[0]
def gen(opts): return subprocess.run(['node', S+'/measure-gen.mjs', json.dumps(opts)], capture_output=True, text=True, check=True).stdout

class Crash(Exception): pass
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
        s.P = list(start)          # machine: ball centre X,Y and tip bottom Z
        s.r = r; s.obs = obstacles
        s.off = [0,0,0]; s.vars = {}; s.inc = False; s.log = []
    def touching(s, P):
        c = (P[0], P[1], P[2] + s.r)
        return any(box_dist(c, b) <= s.r + 1e-9 for b in s.obs)
    def work(s): return [s.P[i]-s.off[i] for i in range(3)]
    def ev(s, e):
        def var(m):
            k = m.group(1) or m.group(2)
            if k not in s.vars: raise Exception('unset var '+k)
            return '(%r)' % s.vars[k]
        e = re.sub(r'#<([^>]+)>|#(\d+)', var, e)
        e = e.replace('ABS','abs').replace('[','(').replace(']',')').replace(' EQ ','==').replace(' GT ','>')
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
        lines = [l.split('(')[0].strip() for l in prog.splitlines()]
        stack=[]; skip=0
        for line in lines:
            if not line: continue
            m = re.match(r'o\d+\s+(if|endif|else)\s*(.*)', line)
            if m:
                if m.group(1)=='if':
                    if skip: skip+=1
                    elif not s.ev(m.group(2)): skip=1
                elif m.group(1)=='endif' and skip: skip-=1
                continue
            if skip: continue
            m = re.match(r'#<([^>]+)>\s*=\s*(.*)', line)
            if m: s.vars[m.group(1)] = s.ev(m.group(2)); continue
            ws = s.words(line); g=[v for k,v in ws if k=='G']; ax={k:v for k,v in ws if k in 'XYZ'}
            for v in g:
                if v==91: s.inc=True
                if v==90: s.inc=False
            if 92 in g:
                for k,v in ax.items(): i='XYZ'.index(k); s.off[i] = s.P[i]-v
                continue
            mv = [v for v in g if v in (0,1,38.2,38.3)]
            if not mv or not ax: continue
            cur = s.work(); tgt = s.P[:]
            for k,v in ax.items():
                i='XYZ'.index(k); tgt[i] = (s.P[i]+v) if s.inc else (v+s.off[i])
            kind = mv[-1]
            if kind in (38.2,38.3):
                hit = s.move(tgt, 'G38.2' if kind==38.2 else 'G38.3')
                w = s.work(); s.vars['5061'],s.vars['5062'],s.vars['5063'] = w; s.vars['5070'] = 1.0 if hit else 0.0
            else: s.move(tgt)
        return s

def run(name, opts, start, r, obs, expect):
    try:
        sim = Sim(start, r, obs).run(gen(opts)); res = 'ok' if sim.vars.get('_ofm_ok')==1 else 'fail %d' % sim.vars.get('_ofm_fail',-1)
    except (Crash, NotFound) as e: sim=None; res = type(e).__name__+': '+str(e)
    ok = res.startswith(expect)
    print(('PASS' if ok else 'FAIL'), name, '->', res)
    return sim, ok

stock = (0,100, 0,60, 0,20)     # x 0..100, y 0..60, top Z 20
jawF  = (-30,130, -20,0, 0,25)  # vise jaws taller than stock, along front/back faces
jawB  = (-30,130, 60,80, 0,25)
allok = True
def chk(name, cond, msg):
    global allok
    print(('  ok ' if cond else '  BAD'), name, msg); allok &= cond

# 1. X only, ball r=1 configured correctly, centre origin; start off-centre by a few mm
sim, ok = run('X only, centre', dict(w=96, probeY=False, origin='center-x', ball=2), (55,30,27), 1.0, [stock], 'ok'); allok&=ok
w = sim.work(); edge_x_work = 50 - sim.off[0] + 0  # machine x of centre is 50
chk('width', abs(sim.vars['_ofm_w']-100)<0.01, sim.vars['_ofm_w'])
chk('X0 on centre', abs((50 - sim.off[0]))<0.01, 50 - sim.off[0])
chk('Z0 on top', abs((20 - sim.off[2]))<0.01, 20 - sim.off[2])
chk('parked over X0', abs(w[0])<0.01, w)
# 2. XY, front-left corner, typed size off by 6 mm
sim, ok = run('XY, front-left', dict(w=106, l=55, probeY=True, origin='front-left', ball=2), (48,33,30), 1.0, [stock], 'ok'); allok&=ok
chk('size', abs(sim.vars['_ofm_w']-100)<0.01 and abs(sim.vars['_ofm_l']-60)<0.01, (sim.vars['_ofm_w'], sim.vars['_ofm_l']))
chk('X0Y0 on front-left', abs(0-sim.off[0])<0.01 and abs(0-sim.off[1])<0.01 and abs(20-sim.off[2])<0.01, sim.off)
# 3. back-right and centre
for org, ex in (('back-right',(100,60)),('center',(50,30)),('back-left',(0,60)),('front-right',(100,0))):
    sim, ok = run('XY '+org, dict(w=100, l=60, probeY=True, origin=org, ball=2), (52,28,25), 1.0, [stock], 'ok'); allok&=ok
    chk(org, abs(ex[0]-sim.off[0])<0.01 and abs(ex[1]-sim.off[1])<0.01, sim.off)
# 4. stock much bigger than typed -> drop lands on top
run('typed 20 mm too small', dict(w=80, probeY=False, origin='center-x', ball=2), (50,30,27), 1.0, [stock], 'fail 2')
# 5. vise jaws taller than stock with Y faces -> fail 7, X only works
run('jaws above travel height, Y faces', dict(w=100, l=60, probeY=True, origin='center', ball=2), (50,30,28), 1.0, [stock,jawF,jawB], 'fail 6')
jF2=(-30,130,-20,0,0,22); jB2=(-30,130,60,80,0,22)
run('jaws between top and travel height', dict(w=100, l=60, probeY=True, origin='center', ball=2), (50,30,28), 1.0, [stock,jF2,jB2], 'fail 7')
clamp = (-25,-5, 20,40, 0,40)
run('clamp in the way', dict(w=100, probeY=False, origin='center-x', ball=2), (50,30,27), 1.0, [stock,clamp], 'fail 1')
# 7. stock narrower than typed by more than margin -> edge not found (controller E-stops)
run('typed 25 mm too big', dict(w=125, probeY=False, origin='center-x', ball=2), (50,30,27), 1.0, [stock], 'NotFound')
# 8. calibration: true ball 2 mm, configured 0, no zero change
sim, ok = run('calibrate', dict(w=100, probeY=False, origin='center-x', ball=0, calibrate=True), (50,30,27), 1.0, [stock], 'ok'); allok&=ok
ball = abs(sim.vars['_ofm_rxb']-sim.vars['_ofm_rxa']) - 100
chk('ball from calibration', abs(ball-2)<0.01, ball); chk('zero untouched', sim.off==[0,0,0], sim.off)
# 9. start too high (>25 mm above top)
run('start too high', dict(w=100, probeY=False, origin='center-x', ball=2), (50,30,50), 1.0, [stock], 'NotFound')
run('start 20 above top, offset', dict(w=100, probeY=False, origin='center-x', ball=2), (50,30,40), 1.0, [stock], 'ok')
print('ALL OK' if allok else 'SOMETHING FAILED')
