# M62-M66 user I/O, controller side (1.45.0).
#   python3 src/py/tests/test_user_io.py
#
# UserIO.plan(): which pins the settings give to M62-M66 and which it refuses.
# Then programs through the real Planner, Mach and Comm code (seekharness.py:
# a CAMotics-like interpreter that waits for the M66 result, and an AVR-like
# executor that answers it).  The motion board side is test_avr_user_io.py.
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                '..', '..', 'react-ui', 'test'))
from bbstub import check, done
import seekharness as SH
from simlib import Sim
from bbctrl import UserIO

# --- plan() -----------------------------------------------------------------
base = {'tool-type': 'Disabled', 'min-switch': {'0': 'disabled', '1': 'disabled',
        '2': 'disabled', '3': 'disabled'}, 'max-switch': {'0': 'disabled',
        '1': 'disabled', '2': 'disabled', '3': 'disabled'},
        'homing-mode': {'0': 'stall-min', '1': 'stall-min', '2': 'stall-max',
                        '3': 'manual'}}
def plan(**kw):
    v = dict(base)
    v.update(dict((k.replace('_', '-'), x) for k, x in kw.items()))
    return UserIO.plan(v)

p = plan()
check('nothing set: no outputs or inputs', p['outputs'] == {} and p['inputs'] == {})
check('outputs off at program end by default', p['off_at_end'])

p = plan(user_output_0 = 'tool-enable (pin 15)', user_output_1 = 'tool-direction (pin 16)',
         user_output_2 = 'load-2 (pin 1)')
check('outputs map to motion board labels', p['outputs'] == {0: 'e', 1: 'd', 2: '2'}, p['outputs'])
check('Load 2 notes that M8/M9 switch it too', any('M8' in n for n in p['notes']), p['notes'])

p = plan(user_output_0 = 'tool-direction (pin 16)', user_output_1 = 'tool-direction (pin 16)')
check('the same pin twice: second refused', p['outputs'] == {0: 'd'} and
      any('already output P0' in n for n in p['notes']), p)

v = dict(base, **{'tool-type': 'PWM Spindle', 'user-output-0': 'tool-enable (pin 15)'})
p = UserIO.plan(v)
check('tool enable refused with the router/laser/PWM spindle', p['outputs'] == {} and
      any('switches the router' in n for n in p['notes']), p)

p = plan(user_input_0_pin = 'pin 3 (motor 0 min)', user_input_1_pin = 'pin 12 (motor 3 max)',
         user_input_1_mode = 'normally-closed')
check('inputs map to limit pins and modes', p['inputs'] == {0: (1, 1), 1: (8, 2)}, p['inputs'])

v = dict(base); v['min-switch'] = dict(base['min-switch'], **{'1': 'normally-open'})
v['user-input-0-pin'] = 'pin 5 (motor 1 min)'
p = UserIO.plan(v)
check('a pin used as a limit switch is refused', p['inputs'] == {} and
      any("motor 1's min limit" in n for n in p['notes']), p)

v = dict(base); v['homing-mode'] = dict(base['homing-mode'], **{'2': 'switch-max'})
v['user-input-0-pin'] = 'pin 10 (motor 2 max)'
p = UserIO.plan(v)
check('a pin used for switch homing is refused', p['inputs'] == {}, p)

p = plan(user_input_0_pin = 'pin 4 (motor 0 max)', user_input_1_pin = 'pin 4 (motor 0 max)')
check('the same input pin twice: second refused', p['inputs'] == {0: (2, 1)}, p)

check('the off-at-end setting is read', not plan(user_outputs_off_at_end = False)['off_at_end'])

# --- Programs through the controller code ----------------------------------
def harness(outputs = None, inputs = None):
    phys = Sim([0, 0, 0], 1, [])
    h = SH.Harness(phys)
    h.ctrl.state.set('user_io', {'outputs': outputs or {}, 'inputs': inputs or {},
                                 'notes': []})
    return h, phys

h, phys = harness({'1': 'd'}, {'0': 1})
h.input_levels[0] = 1
h.run_program('G21\nM64 P1\nG0 X5\nM66 P0 L3 Q2\n#<_r> = #5399\nG0 X10\nM65 P1\nM2')
check('M64 P1 switched the tool direction output on, M65 P1 off',
      [e for e in h.events if e[0] == 'out'] == [('out', 'd', 1), ('out', 'd', 0)]
      and any(e == ('input', 'd03') for e in h.events), h.events)
check('M66 waited for the board and #5399 holds its answer', phys.vars.get('5399') == 1.0, phys.vars)
check('the program carried on after M66 to X10', abs(phys.P[0] - 10) < 1e-6, phys.P)
check('no controller errors', not h.errors(), h.errors())

h, phys = harness({}, {'0': 1})
h.input_levels[0] = -1   # the board timed out
h.run_program('G21\nM66 P0 L4 Q1\n#<_r> = #5399\nG0 X3\nM2')
check('a timed out M66 gives -1 and the program carries on',
      phys.vars.get('5399') == -1.0 and abs(phys.P[0] - 3) < 1e-6, (phys.vars, phys.P))

h, phys = harness({}, {})
try:
    h.run_program('G21\nG0 X2\nM64 P3\nG0 X4\nM2')
    stopped = False
except Exception as e:
    stopped = 'output P3 is not set to a pin' in str(e)
check('M64 to an output with no pin stops with a clear error', stopped)
check('it stopped before the move after it', abs(phys.P[0] - 2) < 1e-6, phys.P)

# Dry run: no outputs, M66 doesn't wait
h, phys = harness({'1': 'd'}, {'0': 1})
h.planner.dry_lift = 30 if hasattr(h.planner, 'dry_lift') else None
dry = getattr(h.planner, 'is_dry', None)
h.planner.is_dry = lambda: True
h.run_program('G21\nM64 P1\nM66 P0 L3 Q5\n#<_r> = #5399\nM2')
check('dry run: no output switched and no M66 sent to the board',
      'd' not in h.outputs and not any(e[0] == 'input' for e in h.events), (h.outputs, h.events[-5:]))
check('dry run: M66 reads 0', phys.vars.get('5399') == 0.0, phys.vars)

done()
