# A garbled status line from the motion board (1.43.1), run through the controller's own code
# (seekharness): on the machine, the line saying the probe had touched ("xx":"HOLDING") lost a
# quote on the serial link, the controller couldn't read it and waited for ever. Now it repairs
# the line, and asks the board for every variable again ('D'), so it carries on.
#   python3 src/react-ui/test/garble-sim.py
import os, sys, json, math, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from simlib import *
import simlib
H = simlib._harness()

ok = True
def check(name, cond, msg=''):
    global ok
    print(('PASS ' if cond else 'FAIL ') + name, msg); ok = ok and bool(cond)

BED_Z = -60
A, B, CX, CY = 76.2, 50.8, 200, 150
OBS = [(0, 410, 0, 410, -100, BED_Z), (CX - A / 2, CX + A / 2, CY - B / 2, CY + B / 2, BED_Z, BED_Z + 25.4)]
PROG = gen(dict(a=A, b=B, ball=2.0, top=-1, fast=200, slow=25, travel=1000), 'square.js', 'squareProgram')

def run(garble=None):
    sim = Sim((CX, CY, BED_Z + 31.4), 1.0, OBS); sim.probe_frame = 'machine'
    h = H.Harness(sim); h.avr.garble = garble
    try:
        h.run_program(PROG)
        err = None
    except H.Hang as e: err = 'hang: ' + str(e)[:200]
    except Exception as e: err = '%s: %s' % (type(e).__name__, str(e)[:200])
    r = {k[5:]: v for k, v in sim.vars.items() if k.startswith('_ofq_')}
    return h, r, err

h0, r0, e0 = run()
check('clean run finishes', e0 is None and r0.get('ok') == 1, e0)
for mode, what in (('quote', 'a quote lost before "xc" (as on the machine)'), ('cut', 'half the line lost')):
    h, r, err = run(mode)
    check('%s: the line was garbled' % what, len(h.avr.garbled) == 1, h.avr.garbled)
    check('  the program still finishes (before 1.43.1 it waited for ever)', err is None and r.get('ok') == 1, err)
    same = all(abs(r.get(k, 1e9) - v) < 1e-6 for k, v in r0.items() if isinstance(v, float))
    check('  with the same touches as a clean run', same)
    check('  it asked the board for everything again', h.avr.dumps >= 1, h.avr.dumps)
    warn = [m for l, n, m in h.logs.lines if l == 'warning' and 'data:' in m]
    check('  and says so in the log (%s)' % ('repaired' if mode == 'quote' else 'skipped'), warn and warn[-1].endswith('(repaired)' if mode == 'quote' else '(skipped)'), warn[-1:])

# The repair itself
C = sys.modules['bbctrl.Comm']
check('repair: the machine\'s line reads back right', C.repair_line('{"pw":0,"zp":-70.635,"v":0,"xx":"HOLDING",xc":455}') == {'pw': 0, 'zp': -70.635, 'v': 0, 'xx': 'HOLDING', 'xc': 455})
check('repair: a cut line is left alone', C.repair_line('{"pw":0,"zp":-70.6') is None)
check('repair: free text (log lines) is never touched', C.repair_line('{"level":"info","msg":"a, b: c",x":1}') is None)
print('ALL PASS' if ok else 'SOME FAILED'); sys.exit(0 if ok else 1)
