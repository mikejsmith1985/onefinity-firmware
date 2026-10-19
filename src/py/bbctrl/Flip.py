import os
import re
import math

from bbctrl import GCodeText, Lint
from bbctrl.Align import transform, AlignError, PREFIX as ALIGN_PREFIX

# Two-sided jobs: line side B up with side A using reference bores (1.31.0).
#
# Side A cuts two or more small bores through the stock, in the waste.  The
# side B program lists them in its setup sheet, in side A's coordinates, and
# says how the stock was turned over:
#
#   (SETUP ref1: bore x=10 y=10 d=8)
#   (SETUP ref2: bore x=290 y=180 d=8)
#   (SETUP flip: y)             turned over about the Y axis (left and right
#                               swap: X is mirrored).  x: about the X axis
#                               (front and back swap: Y is mirrored).  none:
#                               the refs are already in this program's
#                               coordinates.
#   (SETUP ref-stock: x=0..300 y=0..200)   side A's stock range, when it is
#                               not the same as this program's stock line.
#
# After the flip the 3D probe finds the centre of each bore (bore.js).  The
# centres are machine positions read from the controller after the probe has
# moved itself to each centre, so they don't depend on which frame #5061 to
# #5063 are reported in (see the 1.29.0 release notes).
#
# solve() fits the side B program onto the measured centres: a rotation about
# the program's X0 Y0 and the machine position of X0 Y0.  build() writes a
# copy rotated with the camera alignment code (Align.transform); the work
# offset does the shift, exactly like camera alignment.

class FlipError(Exception): pass


PREFIX = 'flip-'
TOL = 0.05          # mm: distance between refs, measured vs expected
MAX_ROT = 5.0       # degrees
MIN_SPAN = 20.0     # mm: refs closer than this give a poor angle
REF_KEY = re.compile(r'^ref(\d)$')
VALUE = re.compile(r'\b([a-z]+)\s*=\s*([-+]?(?:\d+\.?\d*|\.\d+))', re.I)
FLIPS = ('x', 'y', 'none')


def fmt(v, places = 4):
    s = ('%.*f' % (places, v)).rstrip('0').rstrip('.')
    return '0' if s in ('', '-0') else s


def _range(text, axis):
    m = re.search(r'%s\s*=\s*(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)' % axis, text or '', re.I)
    if not m: return None
    try: a, b = float(m.group(1)), float(m.group(2))
    except ValueError: return None
    return (min(a, b), max(a, b))


def parse_ref(key, text):
    '''"bore x=10 y=10 d=8 depth=12 units=mm" -> dict in mm.'''
    t = (text or '').strip()
    kind = t.split()[0].lower() if t else ''
    if kind != 'bore':
        raise FlipError('Setup sheet %s: "%s". Only bores are supported, '
                        'written like "bore x=10 y=10 d=8".' % (key, text))
    vals = dict((k.lower(), float(v)) for k, v in VALUE.findall(t))
    k = 1.0
    um = re.search(r'\bunits\s*=\s*(mm|in)\b', t, re.I)
    if um and um.group(1).lower() == 'in': k = 25.4
    for need in ('x', 'y', 'd'):
        if need not in vals:
            raise FlipError('Setup sheet %s: "%s" has no %s=.' % (key, text, need))
    ref = {'name': key, 'x': vals['x'] * k, 'y': vals['y'] * k,
           'd': vals['d'] * k}
    if 'depth' in vals: ref['depth'] = vals['depth'] * k
    if not 2 <= ref['d'] <= 60:
        raise FlipError('Setup sheet %s: a %s mm bore is outside 2 to 60 mm.'
                        % (key, fmt(ref['d'], 3)))
    return ref


def read_sheet(fields):
    '''Refs from the setup sheet, mapped into this program's coordinates.
    Returns None when the sheet has no refs.'''
    keys = sorted((int(REF_KEY.match(k).group(1)), k) for k in fields
                  if REF_KEY.match(k))
    if not keys: return None
    refs = [parse_ref(k, fields[k]) for _, k in keys]
    if len(refs) < 2:
        raise FlipError('The setup sheet lists one reference bore. Two or more '
                        'are needed to find the angle.')

    flip = (fields.get('flip') or '').strip().lower()
    if flip not in FLIPS:
        raise FlipError('The setup sheet lists reference bores but no '
                        '"(SETUP flip: x)", "y" or "none" line, so the '
                        'controller can\'t tell how side A\'s positions map '
                        'onto this side. Add it in the post processor.'
                        if not flip else
                        'Setup sheet flip: "%s". Use x (turned over about '
                        'the X axis, front and back swap), y (about the Y '
                        'axis, left and right swap) or none.' % flip)

    stock = fields.get('stock') or ''
    b = {'x': _range(stock, 'x'), 'y': _range(stock, 'y')}
    a_text = fields.get('ref-stock') or stock
    a = {'x': _range(a_text, 'x'), 'y': _range(a_text, 'y')}
    if flip != 'none':
        for ax in 'xy':
            if not b[ax] or not a[ax]:
                raise FlipError('Mapping side A\'s bores onto this side needs '
                                'the stock range on the setup sheet (stock: '
                                'x=..  y=..).')

    out = []
    for r in refs:
        x, y = r['x'], r['y']
        if flip == 'y':       # left and right swap
            x = b['x'][1] - (r['x'] - a['x'][0])
            y = b['y'][0] + (r['y'] - a['y'][0])
        elif flip == 'x':     # front and back swap
            x = b['x'][0] + (r['x'] - a['x'][0])
            y = b['y'][1] - (r['y'] - a['y'][0])
        n = dict(r)
        n.update(ax = r['x'], ay = r['y'], x = x, y = y)
        out.append(n)

    warnings = []
    span = max(math.hypot(p['x'] - q['x'], p['y'] - q['y'])
               for p in out for q in out)
    if span < MIN_SPAN:
        warnings.append('The reference bores are only %s mm apart, so the '
                        'angle will be rough. Put them further apart.'
                        % fmt(span, 1))
    return {'refs': out, 'flip': flip, 'warnings': warnings,
            'stock': b if b['x'] and b['y'] else None}


def mirrored(fields, flip):
    '''The refs as they would be if the stock had been turned over another
    way (to warn about patterns that can't tell the two apart).'''
    f = dict(fields)
    f['flip'] = flip
    try: return read_sheet(f)['refs']
    except FlipError: return None


def fit(nominal, measured):
    '''Rigid fit (rotation + shift, no scale) of nominal [(x, y)] onto
    measured [(x, y)].  Returns (angle_deg, (ox, oy), residuals).'''
    n = len(nominal)
    cn = (sum(p[0] for p in nominal) / n, sum(p[1] for p in nominal) / n)
    cm = (sum(p[0] for p in measured) / n, sum(p[1] for p in measured) / n)
    sxx = sxy = 0.0
    for p, q in zip(nominal, measured):
        ax, ay = p[0] - cn[0], p[1] - cn[1]
        bx, by = q[0] - cm[0], q[1] - cm[1]
        sxx += ax * bx + ay * by      # dot
        sxy += ax * by - ay * bx      # cross
    a = math.atan2(sxy, sxx)
    c, s = math.cos(a), math.sin(a)
    ox = cm[0] - (cn[0] * c - cn[1] * s)
    oy = cm[1] - (cn[0] * s + cn[1] * c)
    res = []
    for p, q in zip(nominal, measured):
        rx, ry = p[0] * c - p[1] * s + ox, p[0] * s + p[1] * c + oy
        res.append(math.hypot(rx - q[0], ry - q[1]))
    return math.degrees(a), (ox, oy), res


def solve(sheet, measured, tol = TOL, max_rot = MAX_ROT, fields = None):
    '''sheet: read_sheet() result.  measured: [{'x', 'y'}] machine mm, one per
    ref in order (None for one not measured yet).  Returns a dict with ok,
    angle, origin (machine position of the program's X0 Y0), residuals,
    pairs [{a, b, expected, measured, err}] and problems.'''
    refs = sheet['refs']
    if len(measured) != len(refs) or any(m is None for m in measured):
        raise FlipError('Measure every reference bore first.')
    try:
        meas = [(float(m['x']), float(m['y'])) for m in measured]
    except (TypeError, ValueError, KeyError):
        raise FlipError('A measured position is not a number.')
    if not all(math.isfinite(v) for p in meas for v in p):
        raise FlipError('A measured position is not a number.')
    nom = [(r['x'], r['y']) for r in refs]

    problems = []
    pairs = []
    for i in range(len(refs)):
        for j in range(i + 1, len(refs)):
            e = math.hypot(nom[j][0] - nom[i][0], nom[j][1] - nom[i][1])
            m = math.hypot(meas[j][0] - meas[i][0], meas[j][1] - meas[i][1])
            pairs.append({'a': refs[i]['name'], 'b': refs[j]['name'],
                          'expected': e, 'measured': m, 'err': m - e})
            if abs(m - e) > tol:
                problems.append(
                    '%s to %s measures %s mm, but the program expects %s mm '
                    '(%s mm off, more than %s mm). A bore may hold a chip, the '
                    'stock may have moved or bent, or the setup sheet\'s '
                    'positions don\'t match the bores side A cut.'
                    % (refs[i]['name'], refs[j]['name'], fmt(m, 3), fmt(e, 3),
                       fmt(m - e, 3), fmt(tol, 3)))

    angle, origin, res = fit(nom, meas)
    if abs(angle) > max_rot:
        problems.append(
            'The stock sits turned %s degrees, more than the %s degree limit. '
            'It was probably turned over the other way, or the bores were '
            'measured in a different order.' % (fmt(angle, 2), fmt(max_rot, 1)))

    warnings = list(sheet.get('warnings') or [])
    # A pattern that fits just as well turned over the other way can't show a
    # wrong flip.  The bore probe will usually catch it (it lands on solid
    # stock), but say so.
    if fields is not None:
        for other in FLIPS:
            if other == sheet['flip']: continue
            alt = mirrored(fields, other)
            if not alt: continue
            a2, _, r2 = fit([(r['x'], r['y']) for r in alt], meas)
            if abs(a2) <= max_rot and max(r2) <= tol:
                warnings.append(
                    'These bores fit just as well if the stock had been turned '
                    'over %s. Check by eye that it was turned over as the setup '
                    'sheet says, and next time place the bores so the pattern '
                    'is not symmetrical.'
                    % {'x': 'about X', 'y': 'about Y', 'none': 'not at all'}[other])

    return {'ok': not problems, 'angle': angle,
            'origin': {'x': origin[0], 'y': origin[1]},
            'residuals': res, 'pairs': pairs, 'problems': problems,
            'warnings': warnings, 'tol': tol, 'max_rot': max_rot}


def _rot_box(stock, angle):
    a = math.radians(angle)
    c, s = math.cos(a), math.sin(a)
    pts = [(x * c - y * s, x * s + y * c) for x in stock['x'] for y in stock['y']]
    return (min(p[0] for p in pts), max(p[0] for p in pts),
            min(p[1] for p in pts), max(p[1] for p in pts))


def build(lines, name, sol, units_mm = True):
    '''The rotated copy.  sol: solve() result (ok).  Returns (text, info).'''
    angle = sol['angle']
    fields = GCodeText.setup_fields(lines[:400])
    head = ['(Flip-aligned copy of %s: side B lined up on %d reference bores)'
            % (GCodeText.safe_comment(name), len(sol['residuals'])),
            '(Rotated %s degrees about X0 Y0. X/Y zero must be the one the '
            'flip alignment set)' % fmt(angle, 4),
            '(SETUP flip-aligned: %s deg, refs fit within %s mm)'
            % (fmt(angle, 4), '%.3f' % max(sol['residuals']))]
    try:
        text, info = transform(lines, angle, name, max_angle = sol.get('max_rot', MAX_ROT),
                               header = head)
    except AlignError as e: raise FlipError(str(e))

    out = []
    stock = {'x': _range(fields.get('stock'), 'x'),
             'y': _range(fields.get('stock'), 'y')}
    zr = _range(fields.get('stock'), 'z')
    for line in text.splitlines():
        m = GCodeText.SETUP_LINE.match(line)
        if m and m.group(1).lower() == 'stock' and stock['x'] and stock['y']:
            # The stock sits turned too: the plate area the program may use is
            # the box around the turned stock
            x0, x1, y0, y1 = _rot_box(stock, angle)
            line = '(SETUP stock: x=%s..%s y=%s..%s%s)' % (
                fmt(x0, 3), fmt(x1, 3), fmt(y0, 3), fmt(y1, 3),
                (' z=%s..%s' % (fmt(zr[0], 3), fmt(zr[1], 3))) if zr else '')
        elif m and m.group(1).lower() == 'probe-corner':
            line = '(SETUP probe-corner: flip)'
        out.append(line)
    if 'probe-corner' not in fields:
        out.insert(3, '(SETUP probe-corner: flip)')
    info.update(angle = angle, origin = sol['origin'])
    return '\n'.join(out) + '\n', info


def output_name(source):
    return PREFIX + source


class Flip(object):
    def __init__(self, ctrl):
        self.ctrl = ctrl
        self.log = ctrl.log.get('Flip')


    def _read(self, filename):
        if not filename or '/' in filename or filename.startswith('.'):
            raise FlipError('Bad file name.')
        path = self.ctrl.get_upload(filename)
        if not os.path.isfile(path):
            raise FlipError('The program %s is not on the controller.' % filename)
        with open(path, 'r', encoding = 'utf-8', errors = 'replace') as f:
            return f.read().splitlines()


    def _sheet(self, filename):
        lines = self._read(filename)
        fields = GCodeText.setup_fields(lines[:400])
        sheet = read_sheet(fields)
        if sheet is None:
            raise FlipError('%s has no reference bores on its setup sheet.'
                            % filename)
        return lines, fields, sheet


    def refs(self, filename):
        _, _, sheet = self._sheet(filename)
        sheet['file'] = filename
        sheet['output'] = output_name(filename)
        return sheet


    def solve(self, filename, measured, opts = None):
        _, fields, sheet = self._sheet(filename)
        o = opts or {}
        tol = min(1.0, max(0.01, float(o.get('tol', TOL))))
        rot = min(10.0, max(0.5, float(o.get('max_rot', MAX_ROT))))
        return solve(sheet, measured, tol, rot, fields)


    def build(self, filename, measured, opts = None):
        ctrl = self.ctrl
        if ctrl.state.get('cycle') != 'idle':
            raise FlipError('Wait until the machine is idle.')
        if filename.startswith(PREFIX) or filename.startswith(ALIGN_PREFIX):
            raise FlipError('%s is already a turned copy. Select the original '
                            'side B program.' % filename)
        lines = self._read(filename)
        sol = self.solve(filename, measured, opts)
        if not sol['ok']:
            raise FlipError(' '.join(sol['problems']))
        text, info = build(lines, filename, sol)
        lint = Lint.lint_lines(text.splitlines())
        if lint['errors']:
            raise FlipError('The turned copy fails the G-code check, so it was '
                            'not written: ' + Lint.summary(lint))
        name = output_name(filename)
        tmp = ctrl.get_upload(name + '.tmp')
        with open(tmp, 'w', encoding = 'utf-8') as f: f.write(text)
        os.replace(tmp, ctrl.get_upload(name))
        ctrl.state.add_file(name)
        self.log.info('Wrote %s turned %.4f degrees' % (name, sol['angle']))
        sol.update(file = name, source = filename, lines = info['lines'],
                   lint = {'errors': lint['errors'],
                           'warnings': lint['warnings']})
        return sol
