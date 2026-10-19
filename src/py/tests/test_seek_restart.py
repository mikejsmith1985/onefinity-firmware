# A probing move that ends without contact must not stop the program (1.31.1).
#   python3 src/py/tests/test_seek_restart.py
#
# Found on a machine with 1.31.0: Probe XYZ front-left hung at "Probing in
# progress" right after the guarded move beside the block
# (G91 G38.3 Z-13.7 F300): the AVR reached the target and went READY, and
# nothing more was ever planned.  These runs go through the real Planner,
# Mach and Comm code (seekharness.py: CAMotics-like interpreter that waits
# for the probe result, AVR-like executor that only holds on contact).
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                '..', '..', 'react-ui', 'test'))
from bbstub import check, done
import seekharness as SH
from simlib import Sim, Crash, NotFound
P = sys.modules['bbctrl.Planner'].Planner

# The program from the hardware log (probe.js 1.31.0, front-left XYZ, plate
# 53.975 x 53.975 x 15.07, 1/4" bit), token 77
PROBE_XYZ_FL = '''G21
M5
#<_ofprobe_done> = 0
#<_ofprobe_fail> = 0
G92 X0 Y0 Z0
G91 G38.2 Z-25 F75
G91 G1 Z1
G91 G38.2 Z-2 F25
G92 Z15.07
G91 G0 Z1
G91 G0 X20
G91 G38.3 Z-13.7 F300
o100 if [#5070 EQ 1]
#<_ofprobe_fail> = 1
G91 G1 Z1 F75
o100 endif
o101 if [#<_ofprobe_fail> EQ 0]
G91 G38.2 X-20 F75
G91 G1 X1
G91 G38.2 X-2 F25
G92 X57.15
G91 G0 X1
o101 endif
o103 if [#<_ofprobe_fail> EQ 0]
G91 G38.3 Y20 F300
o102 if [#5070 EQ 1]
#<_ofprobe_fail> = 2
G91 G1 Y-1 F75
o102 endif
o103 endif
o105 if [#<_ofprobe_fail> EQ 0]
G91 G38.3 X-20 F300
o104 if [#5070 EQ 1]
#<_ofprobe_fail> = 3
G91 G1 X1 F75
o104 endif
o105 endif
o106 if [#<_ofprobe_fail> EQ 0]
G91 G38.2 Y-20 F75
G91 G1 Y1
G91 G38.2 Y-2 F25
G92 Y57.15
G91 G0 Y3
o106 endif
G91 G0 Z25
G90
o990 if [#<_ofprobe_fail> EQ 0]
#<_ofprobe_done> = 77
o990 endif
M2
'''

R = 6.35 / 2
TOP = -31.97          # plate top, machine Z: the guarded move ends at -44.67
CX, CY = 100.0, 100.0 # stock corner under the plate's corner (machine)
PLATE = (CX - 5, CX + 53.975, CY - 5, CY + 53.975, TOP - 15.07, TOP)
START = [CX + 45, CY + 45, TOP + 8]

def machine(**kw):
    s = Sim(START, R, [PLATE]); s.probe_frame = 'machine'; return s

def msgs(h, name = None):
    return [m for l, n, m in h.logs.lines if name is None or n == name]


# 1. The exact sequence from the log, now running to the end
s = machine(); h = SH.Harness(s)
h.run_program(PROBE_XYZ_FL)
st = h.ctrl.state
check('Probe XYZ front-left runs to M2', not h.planner.is_running())
check('done token reaches the UI (state ofprobe_done = 77)',
      st.get('ofprobe_done') == 77 and st.get('ofprobe_fail') == 0,
      (st.get('ofprobe_done'), st.get('ofprobe_fail')))
check('zero on the stock corner', all(abs(a - b) < 0.01 for a, b in
      zip(s.off, (CX, CY, TOP - 15.07))), s.off)

ev = h.events
seeks = [e for e in ev if e[0] == 'seek']
ends = [e[1] for e in ev if e[0] == 'seek-end']
check('seeks as in the log: G38.2 Z, G38.2 Z, then G38.3 Z (no error)',
      [x[1]['error'] for x in seeks[:3]] == [True, True, False])
check('both Z touches hold "Switch found" and restart',
      ends[:2] == [True, True] and
      msgs(h, 'Mach').count('Unpause: Switch found') == 6 and
      sum(1 for m in msgs(h, 'Planner') if m.startswith('Planner restart:')) ==
      6 + ends.count(False),
      (ends, msgs(h, 'Mach')))
lines = [m for m in msgs(h, 'Planner') if m.startswith('Cmd:') and '"seeking": true' in m]
check('the guarded move goes to machine Z -44.67 like on the machine',
      '-44.67' in lines[2], lines[2])
check('it ends without contact and the program goes on (#5070 = 0)',
      ends[2] is False and any('ended without contact' in m for m in msgs(h, 'Planner'))
      and ('synchronize', 0) in ev)
check('no errors logged', not h.errors(), h.errors())


# 2. Without the fix the same run hangs where the machine did
orig = P._check_seek_end
P._check_seek_end = lambda self: None
try:
    try:
        SH.Harness(machine()).run_program(PROBE_XYZ_FL)
        check('regression check: the old code hangs in the harness', False)
    except SH.Hang as e:
        check('regression check: the old code hangs in the harness after the G38.3',
              "'z': -44.67" in str(e).replace('"', "'") and 'synchronizing True' in str(e), str(e)[:200])
finally: P._check_seek_end = orig


# 3. #5070 and #5061-#5063 after each kind of end
prog = '''G21
G91 G38.3 Z-5 F300
#<_r1> = #5070
#<_z1> = #5063
#<_x1> = #5061
G91 G38.3 Z-20 F300
#<_r2> = #5070
#<_z2> = #5063
G91 G0 Z5
M2
'''
s = Sim([CX + 20, CY + 20, TOP + 10], R, [PLATE]); s.probe_frame = 'machine'
s.run(prog)
v = s.vars
check('no contact: #5070 = 0, #5063 = the target', v['_r1'] == 0 and abs(v['_z1'] - (TOP + 5)) < 1e-6
      and abs(v['_x1'] - (CX + 20)) < 1e-6, (v['_r1'], v['_z1'], v['_x1']))
check('contact: #5070 = 1, #5063 = where it touched', v['_r2'] == 1 and abs(v['_z2'] - TOP) < 0.005,
      (v['_r2'], v['_z2']))
check('then it moved on from the real position', abs(s.P[2] - (TOP + 5)) < 0.005, s.P)


# 4. G38.2 without contact keeps the E-stop (an error move is never continued)
s = Sim([CX + 20, CY + 20, TOP + 30], R, [PLATE])
try: s.run('G21\nG91 G38.2 Z-5 F75\nG91 G0 X50\nM2\n'); check('G38.2 without contact E-stops', False)
except NotFound: check('G38.2 without contact E-stops, nothing after it runs', abs(s.P[0] - (CX + 20)) < 1e-9)


# 5. Several guarded moves without contact in a row, and one ending at the start of a program
s = Sim([CX + 200, CY, TOP], R, [PLATE])
s.run('G21\nG91 G38.3 X5 F300\nG91 G38.3 Y5\nG91 G38.3 X-5\nG91 G38.3 Y-5\n#<_n> = 4\nM2\n')
check('four guarded moves without contact in a row', s.vars['_n'] == 4 and abs(s.P[0] - (CX + 200)) < 1e-9)


# 6. A firmware that holds with "Switch no error" (upstream Buildbotics) also works
s = machine(); h = SH.Harness(s, no_error_hold = True)
h.run_program(PROBE_XYZ_FL)
check('"Switch no error" hold: synchronize(0), restart, done',
      h.ctrl.state.get('ofprobe_done') == 77 and 'Unpause: Switch no error' in msgs(h, 'Mach')
      and ('synchronize', 0) in h.events and not h.errors(), h.errors())


# 7. The guards: no restart before the AVR has finished the probing move
s = Sim([CX + 200, CY, TOP], R, [PLATE]); h = SH.Harness(s)
h.planner.seek_line = {'id': 10, 'error': False, 'target': {'x': CX + 205, 'y': CY, 'z': TOP}}
g = h.planner.planner; g.syncing = ('probe',)
st = h.ctrl.state
for name, upd in (('an earlier id', dict(id = 9, xp = CX + 205)),
                  ('id wrapped round below', dict(id = 65530, xp = CX + 205)),
                  ('not at the target (stopped part way)', dict(id = 10, xp = CX + 202)),
                  ('still running', dict(id = 10, xp = CX + 205, xx = 'RUNNING')),
                  ('error seek (G38.2)', None)):
    if upd is None:
        h.planner.seek_line['error'] = True; upd = dict(id = 10, xp = CX + 205, xx = 'READY')
    st.vars.update(xx = 'READY'); st.update(upd)
    check('no restart with ' + name, g.syncing is not None and h.planner.seek_line is not None)
h.planner.seek_line['error'] = False
st.update(dict(id = 10, xp = CX + 205, xx = 'READY'))
check('restart once READY at the id and target', g.syncing is None and h.planner.seek_line is None)
h.planner.seek_line = {'id': 3, 'error': False, 'target': {'x': CX + 205}}
g.syncing = ('probe',); st.update(dict(id = 4))
check('...or past it (id after the move)', h.planner.seek_line is None)


# 8. Dry run: probing moves are sent as plain moves and must go on too
s = Sim([CX + 200, CY, TOP], R, [PLATE]); h = SH.Harness(s)
def start_dry(prog):
    pl = h.planner
    h.mach._begin_cycle('running')
    pl.end_dry(); pl._sync_position(True); pl.begin_dry(5)
    pl._begin_spindle(); pl.planner.load_string(prog, {}); h.mach.resume()
h.run_program('G21\nG91 G38.3 Z-5 F300\nG91 G38.2 X5 F75\n#<_n> = 2\nM2\n', start_dry)
# (the planner works dry_lift lower, so relative moves keep their length)
check('dry run with probing moves runs to the end', s.vars.get('_n') == 2 and
      abs(s.P[2] - (TOP - 5)) < 1e-4 and abs(s.P[0] - (CX + 205)) < 1e-4, s.P)

done()
