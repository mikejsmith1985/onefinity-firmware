# Start job wizard programs against a simulated machine (1.31.0).
#   python3 src/react-ui/test/wizard-sim.py
# - setterTouchProgram: the trip height worked out from the machine Z the controller reports
#   (no #5063), the same in work and machine frames, and the same as the old reference for the
#   tool that set Z zero; then a longer cutter gets the right Z zero.
# - overStockProgram: guarded descent over the last stock; stops on a thicker stock.
# - measureProgram / setterProgram with a token: done only on success.
import os, sys, json, subprocess
H = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, H)
from simlib import Sim, Crash, NotFound

def gen(mod, fn, o):
    return subprocess.run(['node', H + '/gen.mjs', mod, fn, json.dumps(o)], capture_output=True, text=True, check=True).stdout

allok = True
def chk(name, cond, msg=''):
    global allok
    print(('PASS' if cond else 'FAIL'), name, msg); allok &= bool(cond)

STOCK_TOP = 20.0
setter = (395, 405, 195, 205, 0, 30.0)     # setter top at machine Z 30
stock = (0, 100, 0, 60, 0, STOCK_TOP)
SET = {'x': 400, 'y': 200, 'z': 40}          # saved over the setter, machine
base = dict(setter=SET, top=120, clear=30, travel=1000, fast=200, slow=25, token=11)

for frame in ('work', 'machine'):
    # Probe (L=0) with Z zero on the stock top: work Z = machine Z - 20
    s = Sim([50, 30, 60], 0.0, [stock, setter]); s.probe_frame = frame; s.off = [10, 5, STOCK_TOP]
    s.run(gen('setter.js', 'setterTouchProgram', base))
    chk('%s: touch done token' % frame, s.vars.get('_ofs_done') == 11 and s.vars.get('_ofs_ok') == 1)
    zp = s.P[2]
    trip = zp - 1 - s.off[2]         # touchTrip(zp, offset_z)
    chk('%s: trip is the setter top in work Z (10)' % frame, abs(trip - 10) < 0.003, trip)
    ref = trip
    # A cutter 12.7 mm longer: tip lower by 12.7 for the same spindle Z
    s2 = Sim([50, 30, 80], 0.0, [stock, setter]); s2.L = 12.7; s2.probe_frame = frame; s2.off = [10, 5, 999]
    s2.run(gen('setter.js', 'setterTouchProgram', base))
    # The wizard sets work Z = ref + 1 where it stopped
    s2.off[2] = s2.P[2] - (ref + 1)
    tip_on_stock = STOCK_TOP + s2.L        # spindle Z when the cutter tip is on the stock top
    chk('%s: longer cutter zero on the stock top' % frame, abs((tip_on_stock - s2.off[2])) < 0.005, tip_on_stock - s2.off[2])

# Ends 1 mm above the trip, not touching
s = Sim([50, 30, 60], 0.0, [stock, setter]); s.off = [0, 0, STOCK_TOP]
s.run(gen('setter.js', 'setterTouchProgram', base))
chk('ends 1 mm above the setter, not touching', abs(s.P[2] - 31) < 0.003 and not s.touching(s.P), s.P)

# Tool much longer than the clearance: the guarded descent stops (fail 1), no crash
s = Sim([50, 30, 100], 0.0, [stock, setter]); s.L = 45; s.off = [0, 0, STOCK_TOP]
try: s.run(gen('setter.js', 'setterTouchProgram', dict(base, top=118))); r = s.vars.get('_ofs_fail')
except (Crash, NotFound) as e: r = type(e).__name__
chk('tool too long: guarded stop, fail 1, no token', r == 1 and s.vars.get('_ofs_done') == 0, r)

# overStockProgram: last stock top (probe tip) at machine 20, centre (50, 30)
last = {'x': 50, 'y': 30, 'ztop': STOCK_TOP}
s = Sim([300, 300, 100], 1.0, [stock]); s.off = [0, 0, 0]
s.run(gen('wizard.js', 'overStockProgram', dict(last=last, top=110, above=10, token=5)))
chk('over the stock: done, 10 mm above the top', s.vars.get('_ofw_done') == 5 and abs(s.P[2] - 30) < 1e-6, s.P)
thick = (0, 100, 0, 60, 0, STOCK_TOP + 15)
s = Sim([300, 300, 100], 1.0, [thick]); s.off = [0, 0, 0]
try: s.run(gen('wizard.js', 'overStockProgram', dict(last=last, top=110, above=10, token=5))); r = s.vars.get('_ofw_fail')
except (Crash, NotFound) as e: r = type(e).__name__
chk('thicker stock: guarded stop (fail 1), no token', r == 1 and s.vars.get('_ofw_done') == 0, r)

# measureProgram with a token: done only when ok
m = dict(w=100, l=60, probeY=True, origin='front-left', ball=2, clear=5, depth=3, margin=10, travel=1000, fast=200, slow=25, token=33)
s = Sim([52, 28, 25], 1.0, [stock]); s.run(gen('measure.js', 'measureProgram', m))
chk('measure: token on success', s.vars.get('_ofm_done') == 33 and s.vars.get('_ofm_ok') == 1)
s = Sim([52, 28, 25], 1.0, [stock]); s.run(gen('measure.js', 'measureProgram', dict(m, w=80, l=60)))
chk('measure: no token when it stops', s.vars.get('_ofm_done') == 0 and s.vars.get('_ofm_fail', 0) > 0, s.vars.get('_ofm_fail'))
print('ALL PASS' if allok else 'SOMETHING FAILED')
