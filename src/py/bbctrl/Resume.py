import os
import re
import time
import hashlib

from bbctrl import GCodeText

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
    # Code part of one line, read the way the planner reads it (GCodeText)
    return GCodeText.code_of(line).strip()


def _lines(lines, upto = None):
    # (1-based number, raw line, code) for each line, following comments left
    # open across lines like the planner does.  A line whose comment the
    # planner would read differently from how it looks is refused: guessing
    # could turn comment text into a move.
    open_comment = False
    for n, raw in enumerate(lines, 1):
        if upto is not None and n > upto: break
        code, _, issues, open_comment = GCodeText.split(raw, open_comment)
        if issues:
            raise ResumeError('Line %d: %s. Resume cannot work out the start '
                              'position safely. Fix the comment in the program '
                              '(brackets inside a comment can be written as '
                              '[ ]), upload it again and start the job from a '
                              'line you choose.'
                              % (n, GCodeText.problem_text(issues)))
        yield n, raw, code.strip()


def fmt(v):
    s = ('%.4f' % v).rstrip('0').rstrip('.')
    return '0' if s in ('', '-0') else s


class Modal(object):
    # The modal state of a program as it is read line by line.  Shared by
    # Resume (state at the restart line) and DoOver (state at the start of
    # each operation, 1.30.0).
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
        self.pos = dict((a, None) for a in AXES)   # program units


    def copy(self):
        m = Modal()
        m.__dict__.update(self.__dict__)
        m.pos = dict(self.pos)
        return m


    def apply(self, text):
        '''Applies one line of code (comments already removed, no
        expressions).  Returns (words, g, mc, vals) for the caller's checks.'''
        words = [(c.upper(), float(v)) for c, v in WORD.findall(text)]
        g = [v for c, v in words if c == 'G']
        mc = [int(v) for c, v in words if c == 'M']
        vals = {}
        for c, v in words: vals[c] = v

        for v in g:
            if v in (20, 21): self.units = 'G%d' % v
            elif v in (90, 91): self.dist = 'G%d' % v
            elif v in (17, 18, 19): self.plane = 'G%d' % v
            elif 54 <= v <= 59 and v == int(v): self.wcs = 'G%d' % v
            elif v in (0, 1, 2, 3): self.motion = int(v)

        if 'F' in vals: self.feed = vals['F']
        if 'S' in vals: self.speed = vals['S']
        if 'T' in vals: self.tool = int(vals['T'])

        for v in mc:
            if v in (3, 4, 5): self.spindle = 'M%d' % v
            elif v == 7: self.mist = True
            elif v == 8: self.flood = True
            elif v == 9: self.mist = self.flood = False

        has_axes = any(a in vals for a in AXES)
        if has_axes and (self.motion is not None or 53 in g):
            if 53 in g:
                # Machine coordinates: work position is unknown afterwards
                for a in AXES:
                    if a in vals: self.pos[a] = None
            else:
                for a in AXES:
                    if a not in vals: continue
                    if self.dist == 'G91':
                        if self.pos[a] is not None: self.pos[a] += vals[a]
                    else: self.pos[a] = vals[a]
        return words, g, mc, vals


def scan(lines, upto):
    # Applies lines[0:upto] and returns the resulting Modal state.
    m = Modal()
    for n1, _, text in _lines(lines, upto):
        n = n1 - 1
        if not text or text.startswith('%'): continue
        if '#' in text or '[' in text:
            raise ResumeError('Line %d uses variables or expressions, so the '
                              'start position cannot be worked out safely.' % (n + 1))

        words = [(c.upper(), float(v)) for c, v in WORD.findall(text)]
        for c, v in words:
            if c == 'G' and (v in (28, 30, 92, 92.1, 92.2, 92.3, 10, 38.2, 38.3,
                                   38.4, 38.5, 81, 82, 83, 84, 85, 86, 87, 88,
                                   89) or 10 <= v < 11):
                raise ResumeError('Line %d uses G%s, which resume cannot '
                                  'handle safely. Start this job again from a '
                                  'line you choose.' % (n + 1, fmt(v)))
            if c == 'G' and v == 93:
                raise ResumeError('Line %d uses inverse-time feed (G93).' % (n + 1))
            if c == 'M' and int(v) in (2, 30):
                raise ResumeError('Line %d ends the program before the resume line.' % (n + 1))
        m.apply(text)
    return m


def start_lines(m, spinup, manual, router, where, pause = False):
    '''Lines that put the tool, spindle and coolant back the way the Modal m
    has them, after the operator prompt.  where: what the prompt asks the
    operator to check, e.g. "the tool is over the restart point".'''
    out = []
    w = out.append
    if manual:
        # The controller can't start this router, so never plunge until the
        # operator has switched it on, whatever the pause setting says
        dial = (' at %s' % GCodeText.safe_comment(router).strip()) if router and router.strip() else ''
        w('(MSG, Check %s. Switch the router ON%s and let it reach speed. '
          'Press Start to continue.)' % (where, dial))
        w('M0')
    elif pause:
        w('(MSG, Check %s. Press Start to continue.)' % where)
        w('M0')

    if m.tool is not None: w('T%d' % m.tool)

    if m.spindle in ('M3', 'M4'):
        speed = m.speed if m.speed is not None else 0
        w('S%s %s' % (fmt(speed), m.spindle))
        if spinup > 0: w('G4 P%s' % fmt(spinup))
    elif m.speed is not None: w('S%s' % fmt(m.speed))
    if m.mist: w('M7')
    if m.flood: w('M8')
    return out


def locate(lines, pos, floor, tol = 0.1):
    # Finds where the tool physically is inside the program.
    # pos: work position in millimetres, {'x':, 'y':, 'z':}.
    # floor: 1-based line to start looking from (the saved line).
    # Returns (line, distance_mm) for the EARLIEST straight move at or after
    # floor that passes through pos, or None.  Earliest is the safe choice: if
    # the same path is cut again and again (finishing laps), restarting at an
    # earlier lap only re-cuts air, while a later one would skip cutting.
    # Only simple absolute G0/G1 programs are searched; anything else (arcs,
    # incremental moves, variables, G53 moves, a change of work coordinate
    # system) gives no match, and the saved line is used instead.
    try: target = [float(pos[a]) for a in 'xyz']
    except (TypeError, ValueError, KeyError): return None

    try: return _locate(lines, target, floor, tol)
    except ResumeError: return None   # a comment the planner reads differently


def _locate(lines, target, floor, tol):
    cur = [None, None, None]
    metric = True
    motion = None
    dist = 90
    wcs = None
    for n, raw, text in _lines(lines):
        if not text or text.startswith('%'): continue
        if '#' in text or '[' in text: return None
        words = [(c.upper(), float(v)) for c, v in WORD.findall(text)]
        g = [v for c, v in words if c == 'G']
        vals = dict(words)
        if 53 in g:
            cur = [None, None, None]
            continue
        for v in g:
            if v == 20: metric = False
            elif v == 21: metric = True
            elif v in (90, 91): dist = int(v)
            elif v == int(v) and 54 <= v <= 59:
                if wcs is not None and wcs != int(v): return None
                wcs = int(v)
            elif v in (0, 1, 2, 3): motion = int(v)
        if dist != 90: return None
        k = 1.0 if metric else MM
        new = [vals[a] * k if a in vals else cur[i] for i, a in enumerate('XYZ')]
        has_axes = any(a in vals for a in 'XYZ')

        if has_axes and motion in (2, 3):
            if 'I' in vals or 'J' in vals or 'K' in vals or 'R' in vals:
                cur = new
                continue
        if has_axes and motion in (0, 1) and n >= floor and None not in cur and None not in new:
            d = _seg_dist(cur, new, target)
            if d <= tol: return n, d
        cur = new
    return None


def _seg_dist(a, b, p):
    ab = [b[i] - a[i] for i in range(3)]
    ap = [p[i] - a[i] for i in range(3)]
    den = sum(v * v for v in ab)
    t = 0.0 if den == 0 else max(0.0, min(1.0, sum(ab[i] * ap[i] for i in range(3)) / den))
    return sum((a[i] + t * ab[i] - p[i]) ** 2 for i in range(3)) ** 0.5


def build(lines, line_no, name, opts, top_mm, source_hint = '',
          manual = False, router = ''):
    # lines: the original program (list of strings, no newlines)
    # line_no: 1-based number of the line that was running
    # top_mm: machine Z used for "top of travel" (millimetres, already
    #         backed off from the limit)
    # manual: the spindle is a router the controller can't switch (no VFD or
    #         PWM spindle), so the operator must switch it on before the plunge
    # router: the setup sheet's router line (for example the dial setting)
    o = clean_opts(opts)
    if not (1 <= line_no <= len(lines)):
        raise ResumeError('The saved line %d is not inside the program (%d lines).'
                          % (line_no, len(lines)))

    # The resume line itself must read the same way to the planner as it looks
    for _ in _lines(lines, line_no): pass
    m = scan(lines, line_no - 1)
    warnings = []

    # Comments later in the program that the planner will stop on
    later = []
    open_comment = False
    for n, raw in enumerate(lines, 1):
        _, _, issues, open_comment = GCodeText.split(raw, open_comment)
        if n > line_no and issues: later.append(n)
    if later:
        warnings.append('Line%s %s later in the program ha%s a comment the '
                        'planner will read differently from how it looks '
                        '(brackets inside a comment, or one left open). The '
                        'job may stop with an error there. Fix the program '
                        'before resuming if you can.'
                        % ('s' if len(later) > 1 else '',
                           ', '.join(str(x) for x in later[:5]) +
                           (' and more' if len(later) > 5 else ''),
                           've' if len(later) > 1 else 's'))
    metric = m.units == 'G21'
    k = 1.0 if metric else 1.0 / MM        # millimetres -> file units
    start = line_no - 1

    # The resume line may be a continuation with no G word; keep its motion
    first = lines[start]
    first_words = [int(float(v)) for c, v in WORD.findall(strip(first)) if c.upper() == 'G']
    if m.motion is not None and not any(g in (0, 1, 2, 3) for g in first_words) \
       and any(c.upper() in AXES for c, v in WORD.findall(strip(first))):
        # Keep a leading line number (N word) first: "N10 G1 X1", not "G1 N10 X1"
        mn = re.match(r'\s*(N\s*\d+\s*)(.*)$', first, re.I)
        if mn: first = '%sG%d %s' % (mn.group(1), m.motion, mn.group(2).strip())
        else: first = 'G%d %s' % (m.motion, first.strip())

    for a in 'XY':
        if m.pos[a] is None:
            raise ResumeError('The program does not set %s before line %d, so '
                              'the start position is unknown.' % (a, line_no))

    out = []
    w = out.append
    safe = GCodeText.safe_comment
    w('(RESUME of %s at line %d)' % (safe(name), line_no))
    shown = safe(strip(lines[start])[:60])
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

    out.extend(start_lines(m, o['spinup'], manual, router,
                           'the tool is over the restart point', o['pause']))

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
        'spinup': o['spinup'], 'plunge': o['plunge'],
        'pause': o['pause'] or bool(manual),
        'manual_spindle': bool(manual),
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


def manual_spindle(config):
    '''True when the controller can't switch the spindle itself: a router
    with its own switch and speed dial (tool type Disabled, or the Router
    tool), so M3 and M5 do nothing.'''
    try:
        tool_type = str(config.get('tool-type', 'Disabled') or 'Disabled')
        selected = str(config.get('selected-tool', '') or '')
    except Exception: return True
    return tool_type.lower() == 'disabled' or selected.lower() in ('router', 'disabled')


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
        changed = bool(rec.get('sha')) and sha_of(path) != rec['sha']

        with open(path, 'r', encoding = 'utf-8', errors = 'replace') as f:
            lines = f.read().splitlines()

        saved = int(rec.get('line') or 0)
        line = saved
        notes = []

        # Where is the tool right now?  The saved line can be behind the
        # machine, and after a controlled stop the tool is still on the path.
        # If it is, restart there.  After a power loss the machine has been
        # homed away from the path, so there is no match and the saved line is used.
        found = None
        try:
            s = self.ctrl.state
            work = dict((a, float(s.get(a + 'p', 0) or 0) - float(s.get('offset_' + a, 0) or 0))
                        for a in 'xyz')
            found = locate(lines, work, saved)
        except Exception as e: self.log.warning('Could not match the tool position: %s' % e)

        if found:
            line = found[0]
            if line != saved:
                notes.append('The tool is on the program path at line %d, ahead of the '
                             'saved line %d, so the program restarts at line %d.'
                             % (line, saved, line))

        if changed:
            if not found:
                raise ResumeError('%s has changed since the job was interrupted, and '
                                  'the tool is not on its path, so the saved line cannot '
                                  'be trusted. Start the job again.' % src)
            notes.append('%s was changed after the job was interrupted. The restart point '
                         'was found from where the tool is, not from the saved line.' % src)

        manual = manual_spindle(self.ctrl.config)
        router = GCodeText.setup_fields(lines[:400]).get('router', '')
        text, info = build(lines, line, src, opts, self._top_mm(),
                           manual = manual, router = router)
        info['saved_line'] = saved
        info['located'] = bool(found)
        info['warnings'] = notes + info['warnings']

        name = output_name(src)
        tmp = self.ctrl.get_upload(name + '.tmp')
        with open(tmp, 'w', encoding = 'utf-8') as f: f.write(text)
        os.replace(tmp, self.ctrl.get_upload(name))
        self.ctrl.state.add_file(name)

        info['file'] = name
        info['source'] = src
        info.update(self._offset_check(rec))
        return info


    # Put the work zero back where it was when the job stopped -------------
    # The checkpoint keeps the work offsets (machine position of work zero) at
    # the moment the job was interrupted.  On a homed machine they are valid
    # again, so the zero can be restored without probing the part, which is
    # often impossible once it is half cut.  Z is only right if the cutter has
    # not been moved in the collet, so the caller chooses the axes.
    def restore_zero(self, axes, rec = None):
        # rec: a saved run record chosen by the caller (Cut deeper, 1.30.0)
        if rec is None:
            cp = self.ctrl.checkpoint
            rec = cp.get() if cp else None
            if not rec or not rec.get('file') or rec.get('status') == 'dismissed':
                raise ResumeError('There is no interrupted job to take the zero from.')
        if self.ctrl.state.get('cycle') != 'idle':
            raise ResumeError('Wait until the machine is idle.')
        self._check_homed()
        saved = rec.get('offset') or {}
        axes = [a for a in (axes or 'xyz') if a in 'xyz' and saved.get(a) is not None]
        if not axes: raise ResumeError('The saved job has no saved zero.')

        s = self.ctrl.state
        scale = 1.0 if s.get('metric', True) else 1 / 25.4   # G92 takes program units
        words = []
        for a in axes:
            pos = float(s.get(a + 'p', 0) or 0)                # machine position, mm
            words.append('%s%s' % (a.upper(), fmt((pos - float(saved[a])) * scale)))
        cmd = 'G92 ' + ' '.join(words)
        self.log.info('Restoring the interrupted job\'s zero: %s' % cmd)
        self.ctrl.mach.mdi(cmd)
        return {'axes': axes, 'cmd': cmd,
                'offset': dict((a, float(saved[a])) for a in axes)}


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
        s.set('park_manual', manual_spindle(ctrl.config))
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
