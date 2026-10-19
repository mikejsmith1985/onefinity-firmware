import os
import re

from bbctrl import GCodeText, Lint
from bbctrl.Resume import Modal, fmt, WORD

# Tool changes for the Start job wizard (1.31.0).
#
# A program with tool changes (M6) is run as one part per tool.  Between two
# parts the wizard has the operator swap the cutter and measures the new one
# on the tool setter, with the same tested programs as the Tool setter screen.
# A tool change can't do that by itself: while a program is paused at M6 the
# controller can't run another program (the setter touch).
#
# Part 1 is the program from the top to the line before the second tool's
# M6.  Each later part starts with the modal state the program has at its M6
# (units, plane, work offset, feed, tool, spindle when the part doesn't start
# it itself), lifted to the top of Z travel, and runs to the line before the
# next M6.  Every part ends with the spindle and coolant off and Z at the top.
# The M6 words are taken out (the operator already has the right cutter in);
# the T words stay.
#
# Anything that would make the state at a tool change uncertain is refused:
# variables or expressions, G92/G10/G52 offsets inside the program, inverse
# time feed, a canned cycle still active, or relative moves (G91) at the
# change.

class JobPlanError(Exception): pass


M6 = re.compile(r'(?<![A-Za-z])M0*6(?![\d.])', re.I)
T_WORD = re.compile(r'(?<![A-Za-z])T\s*(\d+)', re.I)
TOOL_COMMENT = re.compile(r'^\s*\(\s*T(\d+)\s+(.*?)\s*\)\s*$', re.I)
SETUP_TOOL = re.compile(r'^\s*T(\d+)\b', re.I)


def _code(lines):
    '''(index, raw, code) for each line, comments read like the planner.'''
    open_comment = False
    for i, raw in enumerate(lines):
        code, _, issues, open_comment = GCodeText.split(raw, open_comment)
        if issues:
            raise JobPlanError(
                'Line %d: %s. Fix the comment (brackets inside a comment can '
                'be written as [ ]) and upload the program again.'
                % (i + 1, GCodeText.problem_text(issues)))
        yield i, raw, code.strip()


def tool_names(lines):
    '''{tool number: description} from the setup sheet and the tool list
    comments CAM posts write near the top, e.g. "(T2 D=3.175 CR=0 - flat)".'''
    names = {}
    fields = GCodeText.setup_fields(lines[:400])
    for k, v in fields.items():
        if k == 'tool' or k.startswith('tool') and k[4:].isdigit():
            m = SETUP_TOOL.match(v or '')
            if m: names[int(m.group(1))] = v.strip()
    for raw in lines[:400]:
        m = TOOL_COMMENT.match(raw)
        if m and int(m.group(1)) not in names:
            names[int(m.group(1))] = ('T%s %s' % (m.group(1), m.group(2))).strip()
    return names


def plan(lines):
    '''Tool changes and the parts they split the program into.
    Returns {'parts': [{index, tool, start, end, change}], 'first_tool'}.
    start/end are 1-based line numbers (end inclusive); change is the M6 line
    that starts the part (None for part 1).'''
    pending = None
    cut = False
    motion = None
    first_tool = None
    starts = []          # (0-based index of the M6 line, tool)
    for i, _, code in _code(lines):
        if not code: continue
        words = [(c.upper(), float(v)) for c, v in WORD.findall(code)]
        t = T_WORD.search(code)
        if t: pending = int(t.group(1))
        if M6.search(code):
            if pending is None:
                raise JobPlanError('Line %d: M6 without a T word before it, so '
                                   'the controller can\'t tell which tool it '
                                   'is.' % (i + 1))
            if not cut: first_tool = pending
            else: starts.append((i, pending))
        gs = [v for c, v in words if c == 'G']
        if 53 in gs: continue
        for g in gs:
            if g in (0, 1, 2, 3) or 73 <= g <= 89: motion = g
            elif g == 80: motion = None
        if motion is not None and motion != 0 and \
           any(c in 'XYZ' for c, _ in words):
            cut = True
    if first_tool is None and not starts: first_tool = pending

    parts = []
    bounds = [0] + [i for i, _ in starts] + [len(lines)]
    tools = [first_tool] + [t for _, t in starts]
    for k in range(len(bounds) - 1):
        parts.append({'index': k, 'tool': tools[k],
                      'start': bounds[k] + 1, 'end': bounds[k + 1],
                      'change': bounds[k] + 1 if k else None})
    return {'parts': parts, 'first_tool': first_tool}


def _scan(lines, upto):
    '''Modal state after lines[0:upto], refusing what can't be carried.'''
    m = Modal()
    canned = False
    for i, _, code in _code(lines[:upto]):
        if not code or code.startswith('%'): continue
        if '#' in code or '[' in code:
            raise JobPlanError('Line %d uses variables or expressions, so the '
                               'state at the tool change can\'t be worked out. '
                               'Run this program without the wizard.' % (i + 1))
        for c, v in WORD.findall(code):
            if c.upper() != 'G': continue
            g = float(v)
            if g in (10, 52, 92, 92.1, 92.2, 92.3):
                raise JobPlanError('Line %d sets offsets inside the program '
                                   '(G%s), which can\'t be carried across a '
                                   'tool change.' % (i + 1, fmt(g)))
            if g == 93:
                raise JobPlanError('Line %d uses inverse time feed (G93).'
                                   % (i + 1))
            if g == 80 or g in (0, 1, 2, 3): canned = False
            elif 73 <= g <= 89: canned = True
        m.apply(code)
    if canned:
        raise JobPlanError('A canned cycle (G81 to G89) is still active at the '
                           'tool change on line %d (no G80).' % (upto + 1))
    return m


def _strip_m6(raw):
    code, comments, _, _ = GCodeText.split(raw)
    if not M6.search(code): return raw
    new = re.sub(r'\s+', ' ', M6.sub(' ', code)).strip()
    rest = ' '.join('(%s)' % GCodeText.safe_comment(c) for c in comments)
    out = (new + ' ' + rest).strip()
    return out or '(M6 taken out by the Start job wizard)'


def part(lines, k, name, top_mm, spinup = 10):
    '''Text of part k (0-based) and its info.'''
    p = plan(lines)
    parts = p['parts']
    if not 0 <= k < len(parts):
        raise JobPlanError('This program has %d part(s).' % len(parts))
    if top_mm is None:
        raise JobPlanError('The top of Z travel is not known. Home the machine.')
    pt = parts[k]
    a, b = pt['start'] - 1, pt['end']          # 0-based slice [a, b)
    safe = GCodeText.safe_comment
    names = tool_names(lines)
    n = len(parts)

    out = []
    w = out.append
    w('(Part %d of %d of %s: T%s, lines %d to %d)'
      % (k + 1, n, safe(name), pt['tool'] if pt['tool'] is not None else '?',
         pt['start'], pt['end']))
    w('(Written by the Start job wizard. Z zero must be set for this tool)')
    body = []
    warnings = []

    if k == 0:
        for raw in lines[a:b]: body.append(_strip_m6(raw))
    else:
        # The setup sheet comes along, so the Run checks apply to every part
        for raw in lines[:400]:
            if GCodeText.SETUP_LINE.match(raw): w(raw.strip())
            elif GCodeText.FIRST_CODE.match(raw) and not raw.lstrip().startswith('('): break
        m = _scan(lines, a)
        if m.motion in (2, 3):
            raise JobPlanError('The program is in arc mode (G%d) at the tool '
                               'change on line %d.' % (m.motion, pt['start']))
        if m.dist == 'G91':
            raise JobPlanError('The program is in relative mode (G91) at the '
                               'tool change on line %d.' % pt['start'])
        w('M5')
        w('M9')
        w('G21 G90 %s %s G94' % (m.plane, m.wcs))
        w('G53 G0 Z%s' % fmt(top_mm))
        w('%s G90' % m.units)
        if pt['tool'] is not None and not T_WORD.search(GCodeText.code_of(lines[a])):
            w('T%d' % pt['tool'])
        if m.feed is not None: w('F%s' % fmt(m.feed))
        seg = lines[a:b]
        codes = [GCodeText.code_of(r) for r in seg]
        # Start the spindle if the part cuts before it starts it itself
        starts_spindle = False
        first_xy = {}
        z_first = False
        for c in codes:
            ws = [(x.upper(), float(v)) for x, v in WORD.findall(c)]
            ms = [int(v) for x, v in ws if x == 'M']
            gs = [v for x, v in ws if x == 'G']
            if 3 in ms or 4 in ms: starts_spindle = True
            if 53 in gs: continue
            vals = dict(ws)
            if 'Z' in vals and not first_xy: z_first = True
            for ax in 'XY':
                if ax in vals and ax not in first_xy: first_xy[ax] = vals[ax]
            if any(g in (1, 2, 3) for g in gs) and not starts_spindle and \
               m.spindle in ('M3', 'M4'):
                break
            if len(first_xy) == 2: break
        if m.spindle in ('M3', 'M4') and not starts_spindle:
            w('S%s %s' % (fmt(m.speed or 0), m.spindle))
            if spinup > 0: w('G4 P%s' % fmt(spinup))
        if z_first and len(first_xy) == 2:
            # The part lowers Z before it moves in X/Y: go over its first
            # point at the top first
            w('G0 X%s Y%s' % (fmt(first_xy['X']), fmt(first_xy['Y'])))
            warnings.append('Part %d lowers Z before it moves in X and Y. The '
                            'wizard moves over its first point at the top of Z '
                            'first.' % (k + 1))
        # The lift above switched to rapid mode (G0 is modal): put back the
        # motion mode the program had at the change, so a part whose first
        # move relies on it doesn't rapid
        if m.motion == 1: w('G1')
        for raw in seg: body.append(_strip_m6(raw))

    out.extend(body)
    if k < n - 1:
        w('M5')
        w('M9')
        w('G21 G90')
        w('G53 G0 Z%s' % fmt(top_mm))
        w('(End of part %d of %d. Next: T%s)' % (k + 1, n, parts[k + 1]['tool']))
        w('M30')
    info = {'index': k, 'count': n, 'tool': pt['tool'],
            'tool_name': names.get(pt['tool']) if pt['tool'] is not None else None,
            'start': pt['start'], 'end': pt['end'], 'warnings': warnings}
    return '\n'.join(out) + '\n', info


def output_name(source, k, n):
    return 'part%dof%d-%s' % (k + 1, n, source)


def summary(lines):
    p = plan(lines)
    names = tool_names(lines)
    for pt in p['parts']:
        pt['tool_name'] = names.get(pt['tool']) if pt['tool'] is not None else None
    return p


class JobPlan(object):
    def __init__(self, ctrl):
        self.ctrl = ctrl
        self.log = ctrl.log.get('JobPlan')


    def _read(self, filename):
        if not filename or '/' in filename or filename.startswith('.'):
            raise JobPlanError('Bad file name.')
        path = self.ctrl.get_upload(filename)
        if not os.path.isfile(path):
            raise JobPlanError('The program %s is not on the controller.' % filename)
        with open(path, 'r', encoding = 'utf-8', errors = 'replace') as f:
            return f.read().splitlines()


    def _top_mm(self):
        s = self.ctrl.state
        try:
            motor = s.find_motor('z')
            tm = s.get('%dtm' % motor, None) if motor is not None else None
            return None if tm is None else float(tm) - 1.0
        except Exception: return None


    def plan(self, filename):
        r = summary(self._read(filename))
        r['file'] = filename
        return r


    def part(self, filename, k):
        ctrl = self.ctrl
        if ctrl.state.get('cycle') != 'idle':
            raise JobPlanError('Wait until the machine is idle.')
        lines = self._read(filename)
        p = plan(lines)
        n = len(p['parts'])
        try: k = int(k)
        except (TypeError, ValueError): raise JobPlanError('Bad part number.')
        if n == 1:
            # One tool: the program itself is the job
            return {'file': filename, 'index': 0, 'count': 1,
                    'tool': p['parts'][0]['tool'], 'warnings': []}
        text, info = part(lines, k, filename, self._top_mm())
        lint = Lint.lint_lines(text.splitlines())
        if lint['errors']:
            raise JobPlanError('Part %d fails the G-code check, so it was not '
                               'written: %s' % (k + 1, Lint.summary(lint)))
        name = output_name(filename, k, n)
        tmp = ctrl.get_upload(name + '.tmp')
        with open(tmp, 'w', encoding = 'utf-8') as f: f.write(text)
        os.replace(tmp, ctrl.get_upload(name))
        ctrl.state.add_file(name)
        info.update(file = name, source = filename,
                    lint = {'errors': lint['errors'], 'warnings': lint['warnings']})
        return info
