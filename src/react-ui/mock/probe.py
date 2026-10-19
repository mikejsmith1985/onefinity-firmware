# Runs a Probe XYZ/Z program for the mock controller through the controller's real Planner, Mach and
# Comm code (src/py/tests/seekharness.py), on a simulated touch plate placed under the bit.  Prints the
# state updates the screens would see, in order.  A program that stalls (a probing move nobody
# restarted) prints {"hang": ...}: the mock then stays RUNNING, as the machine did with 1.31.0.
#   echo '{"program": "...", "xp": 0, "yp": 0, "zp": 0}' | python3 mock/probe.py
import sys, os, json, re
H = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(H, '..', 'test'))
sys.path.insert(0, os.path.join(H, '..', '..', 'py', 'tests'))
from simlib import Sim, NotFound, Crash
import seekharness as SH

req = json.load(sys.stdin)
prog = req['program']
P = [float(req.get('xp', 0)), float(req.get('yp', 0)), float(req.get('zp', 0))]
R = float(req.get('r', 3.175))
dim = float(req.get('dim', 53.975)); h = float(req.get('h', 15.4))
# Which corner: the program moves out past the X face (G0 X+-20) and along the X face (G38.3 Y+-20)
mx = re.search(r'^G91 G0 X(-?)[\d.]+$', prog, re.M)
my = re.search(r'^G91 G38\.3 Y(-?)[\d.]+', prog, re.M)
top = P[2] - 10
if mx is None:   # Z only: block face down under the bit
    plate = (P[0] - 30, P[0] + 30, P[1] - 30, P[1] + 30, top - h, top)
else:
    sx = -1 if mx.group(1) else 1     # +X out: the X face is on the + side
    sy = -1 if (my and my.group(1)) else 1
    fx, fy = P[0] + sx * 10, P[1] + sy * 10   # faces 10 mm from the bit
    xs = sorted([fx, fx - sx * dim]); ys = sorted([fy, fy - sy * dim])
    plate = (xs[0], xs[1], ys[0], ys[1], top - h, top)
s = Sim(P, R, [plate]); s.probe_frame = 'machine'
hz = SH.Harness(s)
out = []
def frames():
    cur = {}
    for k, v in hz.ctrl.state.history:
        if k == 'update':
            for a in ('xp', 'yp', 'zp'):
                if a in v: cur[a] = round(v[a], 4)
        elif k == 'of_step' or k.startswith('ofprobe_'):
            f = dict(cur); f[k] = v; out.append(f)
    return out
try:
    hz.run_program(prog)
    frames()
    end = {'xp': round(s.P[0], 4), 'yp': round(s.P[1], 4), 'zp': round(s.P[2], 4), 'end': True}
    for i, a in enumerate('XYZ'):   # only the zeros the program set
        if re.search(r'G92 [^\n]*' + a, prog.replace('G92 X0 Y0 Z0', '').replace('G92 X0 Z0', '')):
            end['offset_' + a.lower()] = round(s.off[i], 4)
    out.append(end)
except SH.Hang as e:
    frames(); out.append({'hang': str(e)[:300]})
except (SH.EStop, NotFound) as e:
    frames(); out.append({'estop': 'Switch not found'})
except Crash as e:
    frames(); out.append({'estop': 'crash: %s' % e})
print(json.dumps(out))
