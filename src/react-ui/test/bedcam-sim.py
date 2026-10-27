# Bed camera programs (bedcam.js) on the simulated machine: the calibration
# touch, parking, and moving over the stock the camera found.
#   python3 src/react-ui/test/bedcam-sim.py
import os, sys, json, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from simlib import *

def prog(fn, opts):
    return subprocess.run(['node', S + '/gen.mjs', 'bedcam.js', fn, json.dumps(opts)], capture_output=True, text=True, check=True).stdout

BED = -80.0                                   # spoilboard top, machine Z
bed = (-50, 500, -50, 500, BED - 20, BED)     # the spoilboard
stock = (150, 250, 165, 255, BED, BED + 19)   # 100 x 90 x 19 mm
clamp = (300, 320, 100, 120, BED, BED + 45)   # a tall clamp
TOP = -1
allok = True
def check(name, cond, msg=''):
    global allok
    print(('PASS ' if cond else 'FAIL ') + name, msg); allok &= bool(cond)

def sim(at, obs):
    s = Sim(at, 1.0, obs); s.probe_frame = 'machine'; s.off = [10, 20, 30]   # a work offset in force
    return s

# Calibration touch: 15 mm above the bed, comes down, reports the machine Z, waits 0.2 mm up
s = sim((60, 60, BED + 15), [bed]); s.run(prog('bedTouchProgram', dict(fast=200, slow=25)))
check('touch reports bed machine Z', abs(s.vars['_ofc_z'] - BED) < 0.01, '%.3f' % s.vars['_ofc_z'])
check('waits 0.2 mm above the bed', abs(s.P[2] - (BED + 0.2)) < 0.01, '%.3f' % s.P[2])
s.run(prog('liftProgram', 60)) if False else s.run('G21\nG91 G0 Z60\nG90\nM2\n')
check('lift 60 mm', abs(s.P[2] - (BED + 60.2)) < 0.01)

# Park: top first, then across
s = sim((200, 200, BED + 25), [bed, stock, clamp]); s.run(prog('parkProgram', dict(top=TOP, x=0, y=400)))
check('park ends at the park spot at the top', s.P == [0, 400, TOP], s.P)

# Move over stock the camera found (camera centre 3 mm off)
s = sim((0, 400, TOP), [bed, stock, clamp])
s.run(prog('moveOverProgram', dict(top=TOP, x=203, y=208, zStop=BED + 2, travel=1000, fast=200, slow=25)))
check('finds the stock top', s.vars['_ofb_ok'] == 1 and abs(s.vars['_ofb_top'] - (BED + 19)) < 0.01, 'top %.3f (true %.1f)' % (s.vars['_ofb_top'], BED + 19))
check('waits 8 mm above the top', abs(s.P[2] - (BED + 27)) < 0.01, '%.3f' % s.P[2])
check('work zero untouched', s.off == [10, 20, 30])

# Camera was wrong: nothing under the probe -> back to the top, never touches the bed
s = sim((0, 400, TOP), [bed, stock, clamp])
s.run(prog('moveOverProgram', dict(top=TOP, x=100, y=60, zStop=BED + 2, travel=1000, fast=200, slow=25)))
check('nothing there: no hit, back at the top', s.vars['_ofb_hit'] == 0 and s.vars['_ofb_ok'] == 0 and abs(s.P[2] - TOP) < 0.01, s.P)

# A clamp under the target: it is touched as if it were stock (reported, so the screen can say the height is odd)
s = sim((0, 400, TOP), [bed, stock, clamp])
s.run(prog('moveOverProgram', dict(top=TOP, x=310, y=110, zStop=BED + 2, travel=1000, fast=200, slow=25)))
check('clamp top is reported as the height (screen checks it)', abs(s.vars['_ofb_top'] - (BED + 45)) < 0.01)

print('ALL OK' if allok else 'SOMETHING FAILED')
