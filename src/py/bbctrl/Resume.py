import os
import re
import time
import hashlib

# Builds a G-code program that continues an interrupted job, and parks the
# machine so the job can be continued after the power is switched off.
#
# The resume program is an ordinary file in the upload folder.  It is started
# from the Job tab like any other program, so every normal check still applies.
#
# How it works: the program is read up to the line that was running when
# progress was last saved.  Everything the machine needs to "be in the same
# state" at that line is worked out: units, distance mode, plane, work
# coordinate system, feed rate, tool, spindle and coolant, plus where the
# previous line ended.  The new program then
#   1. lifts Z to the top of its travel,
#   2. moves over the start point,
#   3. (optionally) pauses so the operator can check the position,
#   4. starts the spindle and waits for it to reach speed,
#   5. lowers Z to the start point at a slow feed,
#   6. runs the rest of the original program from that line.
# The line that was running is cut again from its start, never skipped.


class ResumeError(Exception): pass


WORD = re.compile(r'([A-Za-z])\s*([-+]?(?:\d+\.?\d*|\.\d+))')
AXES = 'XYZABC'
MM = 25.4

# Defaults, also used to clamp values that arrive from the browser
DEFAULTS = {
    'spinup': 10,       # seconds to wait after the spindle starts
    'plunge': 300,      # mm/min for the first move down
    'approach': 3,      # mm above the start point (or above Z0) to switch to the plunge feed
    'pause': True,      # stop for the operator to check position before cutting
}


def clean_opts(opts):
    o = dict(DEFAULTS)
    for k, lo, hi in (('spinup', 0, 120), ('plunge', 10, 5000), ('approach', 0.5, 50)):
        try: o[k] = min(hi, max(lo, float((opts or {}).get(k, o[k]))))
        except (TypeError, ValueError): pass
    if opts and 'pause' in opts: o['pause'] = bool(opts['pause'])
    return o


def strip(line):
    line = re.sub(r'\([^)]*\)', ' ', line)
    return line.split(';', 1)[0].strip()


def fmt(v):
    s = ('%.4f' % v).rstrip('0').rstrip('.')
    return '0' if s in ('', '-0') else s


class Modal(object):
    def __init__(self):
        self.units = 'G21'
        self.dist = 'G90'
        self.plane = 'G17'
        self.wcs = 'G54'
        self.motion = None
        self.feed = None
        self.speed = None
        self.spindle = 'M5'
        self.tool = None
        self.mist = False       # M7
        self.flood = False      # M8
        self.pos = dict((a, None) for a in AXES)


def scan(lines, upto):
    # Applies lines[0:upto] and returns the resulting Modal state.
    m = Modal()
    for n in range(upto):
        text = strip(lines[n])
        if not text or text.startswith('%'): continue
        if '#' in text or '[' in text:
            raise ResumeError('Line %d uses variables or expressions, so the '
                              'start position cannot be worked out safely.' % (n + 1))

        words = [(c.upper(), float(v)) for c, v in WORD.findall(text)]
        g = [v for c, v in words if c == 'G']
        mc = [int(v) for c, v in words if c == 'M']
        vals = {}
        for c, v in words: vals[c] = v

        for v in g:
            if v in (28, 30, 92, 92.1, 92.2, 92.3, 10, 38.2, 38.3, 38.4, 38.5,
                     81, 82, 83, 84, 85, 86, 87, 88, 89) or 10 <= v < 11:
                raise ResumeError('Line %d uses G%s, which resume cannot '
                                  'handle safely. Start this job again from a '
                                  'line you choose.' % (n + 1, fmt(v)))
            if v == 93: raise ResumeError('Line %d uses inverse-time feed (G93).' % (n + 1))
            if v in (20, 21): m.units = 'G%d' % v
            elif v in (90, 91): m.dist = 'G%d' % v
            elif v in (17, 18, 19): m.plane = 'G%d' % v
            elif 54 <= v <= 59 and v == int(v): m.wcs = 'G%d' % v
            elif v in (0, 1, 2, 3): m.motion = int(v)

        if 'F' in vals: m.feed = vals['F']
        if 'S' in vals: m.speed = vals['S']
        if 'T' in vals: m.tool = int(vals['T'])

        for v in mc:
            if v in (3, 4, 5): m.spindle = 'M%d' % v
            elif v == 7: m.mist = True
            elif v == 8: m.flood = True
            elif v == 9: m.mist = m.flood = False
            elif v == 2 or v == 30:
                raise ResumeError('Line %d ends the program before the resume line.' % (n + 1))

        has_axes = any(a in vals for a in AXES)
        if has_axes and (m.motion is not None or 53 in g):
            if 53 in g:
                # Machine coordinates: work position is unknown afterwards
                for a in AXES:
                    if a in vals: m.pos[a] = None
            else:
                for a in AXES:
                    if a not in vals: continue
                    if m.dist == 'G91':
                        if m.pos[a] is not None: m.pos[a] += vals[a]
                    else: m.pos[a] = vals[a]
    return m


def build(lines, line_no, name, opts, top_mm, source_hint = ''):
    # lines: the original program (list of strings, no newlines)
    # line_no: 1-based number of the line that was running
    # top_mm: machine Z used for "top of travel" (millimetres, already
    #         backed off from the limit)
    o = clean_opts(opts)
    if not (1 <= line_no <= len(lines)):
        raise ResumeError('The saved line %d is not inside the program (%d lines).'
                          % (line_no, len(lines)))

    m = scan(lines, line_no - 1)
    warnings = []
    metric = m.units == 'G21'
    k = 1.0 if metric else 1.0 / MM        # millimetres -> file units
    start = line_no - 1

    # The resume line may be a continuation with no G word; keep its motion
    first = lines[start]
    first_words = [int(float(v)) for c, v in WORD.findall(strip(first)) if c.upper() == 'G']
    if m.motion is not None and not any(g in (0, 1, 2, 3) for g in first_words) \
       and any(c.upper() in AXES for c, v in WORD.findall(strip(first))):
        first = 'G%d %s' % (m.motion, first.strip())

    for a in 'XY':
        if m.pos[a] is None:
            raise ResumeError('The program does not set %s before line %d, so '
                              'the start position is unknown.' % (a, line_no))

    out = []
    w = out.append
    w('(RESUME of %s at line %d)' % (name.replace('(', '[').replace(')', ']'), line_no))
    shown = strip(lines[start])[:60].replace('(', '[').replace(')', ']')
    w('(Line %d: %s)' % (line_no, shown))
    if m.tool is not None: w('(Tool in spindle must be T%d)' % m.tool)
    w('(Check that Z0 is the top of the stock)')
    w('M5')
    w('M9')
    # Everything up to here is in millimetres so it does not depend on the
    # units the program uses.
    w('G21 G90')
    w('G53 G0 Z%s' % fmt(top_mm))
    w('%s G90 %s %s G94' % (m.units, m.plane, m.wcs))

    xy = 'G0 X%s Y%s' % (fmt(m.pos['X']), fmt(m.pos['Y']))
    for a in 'ABC':
        if m.pos[a] is not None: xy += ' %s%s' % (a, fmt(m.pos[a]))
    w(xy)

    if o['pause']:
        w('(MSG, Check the tool is over the restart point. Press Start to continue.)')
        w('M0')

    if m.tool is not None: w('T%d' % m.tool)

    if m.spindle in ('M3', 'M4'):
        speed = m.speed if m.speed is not None else 0
        w('S%s %s' % (fmt(speed), m.spindle))
        if o['spinup'] > 0: w('G4 P%s' % fmt(o['spinup']))
    elif m.speed is not None: w('S%s' % fmt(m.speed))
    if m.mist: w('M7')
    if m.flood: w('M8')

    z = m.pos['Z']
    app = o['approach'] * k
    plunge = o['plunge'] * k
    if z is None:
        warnings.append('The program does not set Z before this line, so the '
                        'tool stays at the top. The program will lower it.')
    else:
        # Lower quickly only through air: stop above both the start point and Z0
        above = max(z, 0.0) + app
        w('G0 Z%s' % fmt(above))
        w('G1 Z%s F%s' % (fmt(z), fmt(plunge)))

    if m.feed is not None: w('F%s' % fmt(m.feed))
    if m.dist == 'G91':
        warnings.append('The program uses relative moves (G91); check the result before cutting.')
    w(m.dist)
    w('(END OF RESUME HEADER - original program continues)')

    header = len(out)
    out.append(first)
    out.extend(lines[start + 1:])

    info = {
        'line': line_no,
        'line_text': strip(lines[start])[:80],
        'header_lines': header,
        'tool': m.tool,
        'spindle': m.spindle if m.spindle in ('M3', 'M4') else 'off',
        'speed': m.speed,
        'units': 'mm' if metric else 'in',
        'wcs': m.wcs,
        'pos': dict((a.lower(), m.pos[a]) for a in AXES if m.pos[a] is not None),
        'spinup': o['spinup'], 'plunge': o['plunge'], 'pause': o['pause'],
        'warnings': warnings,
    }
    return '\n'.join(out) + '\n', info


def sha_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''): h.update(chunk)
    return h.hexdigest()


def output_name(source):
    root, ext = os.path.splitext(source)
    if root.startswith('resume-'): root = root[len('resume-'):]
    if root.endswith('-b'): root = root[:-2]
    name = 'resume-' + root + ext
    # Never overwrite the file being resumed from: alternate between two names
    if name == source: name = 'resume-' + root + '-b' + ext
    return name


class Resume(object):
    def __init__(self, ctrl):
        self.ctrl = ctrl
        self.log = ctrl.log.get('Resume')
        self.parking = False


    # Preconditions ------------------------------------------------------
    def _top_mm(self):
        s = self.ctrl.state
        motor = s.find_motor('z')
        if motor is None: raise ResumeError('The Z axis is not set up.')
        tm = s.get('%dtm' % motor, None)
        if tm is None: raise ResumeError('The Z travel limit is not known.')
        return float(tm) - 1.0     # 1 mm below the limit, still "the top"


    def _check_homed(self):
        s = self.ctrl.state
        for a in 'xyz':
            if not s.is_axis_homed(a):
                raise ResumeError('Home the machine first. Resume works from '
                                  'the saved position of the program, which '
                                  'is only valid after homing.')


    # Build --------------------------------------------------------------
    def build(self, opts):
        cp = self.ctrl.checkpoint
        rec = cp.get() if cp else None
        if not rec or not rec.get('file') or rec.get('status') == 'dismissed':
            raise ResumeError('There is no interrupted job to resume.')
        if self.ctrl.state.get('cycle') != 'idle':
            raise ResumeError('Wait until the machine is idle.')
        self._check_homed()

        src = rec['file']
        path = self.ctrl.get_upload(src)
        if not os.path.isfile(path):
            raise ResumeError('The program %s is no longer on the controller.' % src)
        if rec.get('sha') and sha_of(path) != rec['sha']:
            raise ResumeError('%s has changed since the job was interrupted, '
                              'so the saved line no longer points at the same '
                              'place. Start the job again.' % src)

        with open(path, 'r', encoding = 'utf-8', errors = 'replace') as f:
            lines = f.read().splitlines()

        line = int(rec.get('line') or 0)
        text, info = build(lines, line, src, opts, self._top_mm())

        name = output_name(src)
        tmp = self.ctrl.get_upload(name + '.tmp')
        with open(tmp, 'w', encoding = 'utf-8') as f: f.write(text)
        os.replace(tmp, self.ctrl.get_upload(name))
        self.ctrl.state.add_file(name)

        info['file'] = name
        info['source'] = src
        info.update(self._offset_check(rec))
        return info


    def _offset_check(self, rec):
        s = self.ctrl.state
        tol = 0.05 if s.get('metric') else 0.002
        saved = rec.get('offset') or {}
        delta = {}
        for a in 'xyz':
            if saved.get(a) is None: continue
            d = float(s.get('offset_' + a, 0) or 0) - float(saved[a])
            if abs(d) > tol: delta[a] = round(d, 4)
        return {'offset_ok': not delta, 'offset_delta': delta}


    # Park ---------------------------------------------------------------
    def park(self):
        ctrl = self.ctrl
        s = ctrl.state
        if self.parking: raise ResumeError('Already parking.')
        if s.get('cycle') != 'running':
            raise ResumeError('There is no job running to park.')
        if not (ctrl.checkpoint and ctrl.checkpoint.enabled):
            raise ResumeError('Turn on "Save job progress" in Admin first.')
        top = self._top_mm()

        self.parking = True
        s.set('park', 'parking')
        ctrl.mach.stop()
        self._wait(lambda: s.get('cycle') == 'idle' and s.get('xx') == 'READY',
                   lambda: self._retract(top), 'stop')


    def _wait(self, test, then, what, tries = 0):
        s = self.ctrl.state
        if test():
            try: then()
            except Exception as e: self._fail(str(e))
        elif tries > 120:
            self._fail('The machine did not finish %s.' % what)
        else:
            self.ctrl.ioloop.call_later(0.25, self._wait, test, then, what, tries + 1)


    def _retract(self, top):
        s = self.ctrl.state
        # The saved record already holds the line the job stopped at
        self.ctrl.mach.mdi('M5 M9')
        self._wait(lambda: s.get('cycle') == 'idle' and s.get('xx') == 'READY',
                   lambda: self._lift(top), 'turning the spindle off')


    def _lift(self, top):
        s = self.ctrl.state
        units = 'G21' if s.get('metric') else 'G20'
        # Machine-coordinate move in millimetres, then restore the units
        self.ctrl.mach.mdi('G21 G53 G0 Z%s' % fmt(top))
        self._wait(lambda: s.get('cycle') == 'idle' and s.get('xx') == 'READY',
                   lambda: self._done(units), 'lifting Z')


    def _done(self, units):
        s = self.ctrl.state
        try: self.ctrl.mach.mdi(units)
        except Exception: pass
        self.ctrl.checkpoint.mark('parked')
        self.parking = False
        s.set('park', 'parked')
        self.log.info('Parked at line %s' % s.get('line'))


    def _fail(self, msg):
        self.parking = False
        self.ctrl.state.set('park', 'failed')
        self.log.error('Park failed: %s' % msg)
        try: self.ctrl.state.add_message('Park failed: %s' % msg)
        except Exception: pass


    def clear_park(self):
        self.ctrl.state.set('park', '')
