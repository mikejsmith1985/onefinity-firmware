#!/usr/bin/env python3

################################################################################
#                                                                              #
#   M62-M66 user I/O (Onefinity fork, 1.45.0), after the remappable I/O of    #
#   the Buildbotics firmware (bbctrl 1.0.2).                                   #
#                                                                              #
################################################################################

# The Onefinity board has fixed pin functions, so only pins that are often
# free can be used:
#   outputs: tool enable (15), tool direction (16), Load 1 (2), Load 2 (1)
#   inputs:  the eight motor limit pins (3, 4, 5, 8, 9, 10, 11, 12), free
#            when homing is by stall detection (the Onefinity default)
#
# plan() works out what goes to the motion board from the settings and
# refuses combinations that would fight another function.

OUTPUTS = 4
INPUTS = 4

# Settings value -> motion board output label (vars.def OUTS_LABEL "ed12ft")
OUTPUT_CHOICES = [
    ('none', None, None),
    ('tool-enable (pin 15)', 'e', 15),
    ('tool-direction (pin 16)', 'd', 16),
    ('load-1 (pin 2)', '1', 2),
    ('load-2 (pin 1)', '2', 1),
]

# Settings value -> (pin number 1-8 on the motion board, motor, end, DB25)
INPUT_CHOICES = [
    ('none', 0, None, None, None),
    ('pin 3 (motor 0 min)',  1, 0, 'min', 3),
    ('pin 4 (motor 0 max)',  2, 0, 'max', 4),
    ('pin 5 (motor 1 min)',  3, 1, 'min', 5),
    ('pin 8 (motor 1 max)',  4, 1, 'max', 8),
    ('pin 9 (motor 2 min)',  5, 2, 'min', 9),
    ('pin 10 (motor 2 max)', 6, 2, 'max', 10),
    ('pin 11 (motor 3 min)', 7, 3, 'min', 11),
    ('pin 12 (motor 3 max)', 8, 3, 'max', 12),
]
INPUT_MODES = ['normally-open', 'normally-closed']


def _idx(v, i): # values['min-switch'] is {'0': ..., '1': ...}
    if isinstance(v, dict): return v.get(str(i))
    if isinstance(v, list) and i < len(v): return v[i]
    return None


def plan(values):
    '''values: Config.values.  Returns a dict:
      outputs:  {port: label} usable M62-M65 outputs (port 0-3)
      inputs:   {port: (pin 1-8, mode 1 NO / 2 NC)} usable M66 inputs
      notes:    [str] warnings for the I/O page (refused or shared pins)
      off_at_end: bool
    '''
    notes, outputs, inputs = [], {}, {}
    get = values.get
    pwm = str(get('tool-type', '') or '') == 'PWM Spindle'
    used_out = {}

    for port in range(OUTPUTS):
        v = get('user-output-%d' % port, 'none') or 'none'
        c = next((c for c in OUTPUT_CHOICES if c[0] == v), None)
        if c is None or c[1] is None: continue
        label, pin = c[1], c[2]
        if label in used_out:
            notes.append('Output P%d: pin %d is already output P%d, so P%d is '
                         'not used.' % (port, pin, used_out[label], port))
            continue
        if label == 'e' and pwm:
            notes.append('Output P%d: tool enable (pin 15) switches the router, '
                         'laser or PWM spindle (Tool tab), so P%d is not used. '
                         'Pick another pin.' % (port, port))
            continue
        if label == '1':
            notes.append('Output P%d is Load 1 (pin 2): M7 and M9 (mist) '
                         'switch it too.' % port)
        if label == '2':
            notes.append('Output P%d is Load 2 (pin 1): M8 and M9 (flood) '
                         'switch it too.' % port)
        if label == 'd' and pwm:
            notes.append('Output P%d is tool direction (pin 16): M4 (reverse) '
                         'no longer sets it.' % port)
        used_out[label] = port
        outputs[port] = label

    used_in = {}
    for port in range(INPUTS):
        v = get('user-input-%d-pin' % port, 'none') or 'none'
        c = next((c for c in INPUT_CHOICES if c[0] == v), None)
        if c is None or not c[1]: continue
        pin, motor, end, db25 = c[1], c[2], c[3], c[4]
        if pin in used_in:
            notes.append('Input P%d: pin %d is already input P%d, so P%d is '
                         'not used.' % (port, db25, used_in[pin], port))
            continue
        sw = _idx(get('%s-switch' % end, {}), motor) or 'disabled'
        homing = str(_idx(get('homing-mode', {}), motor) or '')
        if sw != 'disabled' or homing == 'switch-' + end:
            notes.append('Input P%d: pin %d is motor %d\'s %s limit switch '
                         '(Motors tab), so P%d is not used.'
                         % (port, db25, motor, end, port))
            continue
        mode = get('user-input-%d-mode' % port, 'normally-open')
        mode = 2 if mode == 'normally-closed' else 1
        used_in[pin] = port
        inputs[port] = (pin, mode)

    off = get('user-outputs-off-at-end', True)
    return {'outputs': outputs, 'inputs': inputs, 'notes': notes,
            'off_at_end': off is not False}


def apply(ctrl, values):
    '''Send the plan to the motion board and keep it in the state.'''
    p = plan(values)
    state = ctrl.state
    for label in 'ed12':
        state.config(label + 'ou', 1 if label in p['outputs'].values() else 0)
    for port in range(INPUTS):
        pin, mode = p['inputs'].get(port, (0, 0))
        state.config('%dip' % port, pin)
        state.config('%dim' % port, mode)
    state.set('user_io', {
        'outputs': dict((str(k), v) for k, v in p['outputs'].items()),
        'inputs': dict((str(k), v[0]) for k, v in p['inputs'].items()),
        'notes': p['notes']})
    return p
