# Probe-vs-cutter calibration for the tool setter (1.27.0).
# The 3D probe trips after its stylus gives by PROBE_PT; the setter trips after
# its plunger is pressed by SETTER_PT; on the setter, whichever trips first ends
# the touch. Checks that, after the one-time calibration, a cutter measured on
# the setter after a probe reference lands Z zero on the stock top, and that
# without it the cutter would be off.
#   python3 src/react-ui/test/calib-sim.py
import os, sys, json, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from simlib import *

def js(fn, *args):
    code = "const m=await import(process.argv[1]);process.stdout.write(JSON.stringify(m[%r](...JSON.parse(process.argv[2]))))" % fn
    out = subprocess.run(['node', '--input-type=module', '-e', code, 'file://' + S + '/../src/setter.js', json.dumps(args)], capture_output=True, text=True, check=True).stdout
    return json.loads(out)

TOP = 120
SET = dict(x=150, y=25, z=10)
setter = (147, 153, 22, 28, 0, 5)
allok = True
def check(name, cond, msg=''):
    global allok
    print(('PASS ' if cond else 'FAIL ') + name, msg); allok &= bool(cond)

class TripSim(Sim):
    probe_pt = 0.0; setter_pt = 0.0; is_probe = True
    def touching(s, P):
        c = (P[0], P[1], P[2] - s.L + s.r)
        for b in s.obs:
            on_setter = b == setter
            t = min(s.probe_pt if s.is_probe else 1e9, s.setter_pt) if on_setter else (s.probe_pt if s.is_probe else 0.0)
            bb = (b[0], b[1], b[2], b[3], b[4], b[5] - t)   # trips t below the surface
            if box_dist(c, bb) <= s.r + 1e-9: return True
        return False

def setter_prog(mode, ref=None):
    o = dict(mode=mode, setter=SET, top=TOP, clear=30, travel=1000, back=dict(x=50, y=30))
    if ref is not None: o['ref'] = ref
    return gen(o, 'setter.js', 'setterProgram')

def probe_job(sim, stock_top):
    """Measure stock with the probe on stock whose top is at stock_top, then reference the setter. Returns the raw reference."""
    sim.obs = [(0, 100, 0, 60, 0, stock_top), setter]
    sim.L = 0.0; sim.r = 1.0; sim.is_probe = True
    sim.P = [52, 28, stock_top + 6]
    sim.run(gen(dict(w=100, probeY=True, l=60, origin='front-left')))
    assert sim.vars['_ofm_ok'] == 1
    sim.P[2] = TOP
    sim.run(setter_prog('ref'))
    assert sim.vars['_ofs_ok'] == 1
    return sim.vars['_ofs_ref']

def cutter(sim, L):
    sim.L = L; sim.r = 0.01; sim.is_probe = False

for PROBE_PT, SETTER_PT in ((0.4, 1.2), (1.5, 0.6), (0.0, 0.0)):
    tag = 'probe %.1f / setter %.1f mm' % (PROBE_PT, SETTER_PT)
    sim = TripSim((52, 28, 26), 1.0, [])
    sim.probe_pt, sim.setter_pt = PROBE_PT, SETTER_PT

    # One-time calibration: probe reference, then a cutter Probe Z'd on the same top, then its reference
    raw = probe_job(sim, 20)
    cutter(sim, 12.7)
    sim.off[2] = 20 + sim.L          # Probe Z with the touch plate: cutter tip on the top reads 0
    sim.P[2] = TOP
    sim.run(setter_prog('ref'))
    corr = js('probeCorrection', raw, sim.vars['_ofs_ref'])
    expect = SETTER_PT + PROBE_PT - min(PROBE_PT, SETTER_PT)
    check(tag + ': correction measured', corr['ok'] and abs(corr['c'] - expect) < 0.01, 'c=%.3f expected %.3f' % (corr.get('c', float('nan')), expect))

    # A later job: new stock (top at 31), probe reference stored corrected, a different cutter measured on the setter
    raw2 = probe_job(sim, 31)
    ref = js('probeRefValue', raw2, {'corr': {'c': corr['c']}})
    cutter(sim, -8.0)
    sim.P[2] = TOP
    sim.run(setter_prog('tool', ref=ref))
    err = (31 + sim.L) - sim.off[2]   # how far the cutter's Z zero is from the stock top (+ = cuts too deep)
    check(tag + ': cutter Z0 on the stock top after calibration', abs(err) < 0.01, 'error %.3f mm' % err)

    # Same without calibration, to show what it fixes
    raw3 = probe_job(sim, 31); cutter(sim, -8.0); sim.P[2] = TOP
    sim.run(setter_prog('tool', ref=raw3))
    err0 = (31 + sim.L) - sim.off[2]
    check(tag + ': uncalibrated error equals the correction', abs(abs(err0) - expect) < 0.01, 'uncalibrated error %.3f mm' % err0)

big = js('probeCorrection', 3.0, -4.0)
check('a 7 mm difference is refused', not big['ok'] and big['why'] == 'big')
print('ALL PASS' if allok else 'SOME FAILED'); sys.exit(0 if allok else 1)
