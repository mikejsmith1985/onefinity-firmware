import os
import re
import json
import math

from bbctrl import GCodeText
from bbctrl.Resume import (Modal, start_lines, fmt, sha_of, manual_spindle,
                           MM, WORD)

# Cut deeper (1.30.0).
#
# A program that did not quite cut through (a profile or a hole that left a
# thin skin at the bottom) can be finished without running the whole job
# again.  This writes a new program, doover-<name>.nc, from the original:
#
#   - The program is split into operations, at each comment line that comes
#     after some moves (Fusion writes the operation name there, for example
#     "(2D Contour1)") and at each tool change.
#   - The "floor" of an operation is the deepest Z it reaches.
#   - Only the cutting moves that start and end on the floor are kept: the
#     last pass, its lead-in and lead-out, finishing passes and the bottom
#     circle of a bore.  Upper passes, ramps, helix entries and rapids are
#     dropped.  Drilled holes that reach the floor are drilled again.
#   - The kept moves are run again lower, in steps (1 mm by default) down to
#     the extra depth chosen.  The tool goes down to a little above the old
#     floor (0.5 mm by default) at a feed, never a rapid, through the cut the
#     original run already made, and then feeds into the skin.
#   - Tabs: where the last pass rose over a tab, the new program follows the
#     original path over the tab at its original height (that path was cut
#     by the original run, so it is clear), so tabs stay.  With tabs "under",
#     it cuts under the tab instead, so the tab ends up the thickness it was
#     drawn.
#
# This only makes sense on the same stock, with the same zero and the same
# tool as the run that left the skin, and after that run finished: the moves
# down to the old floor assume everything above it has been cut.  The
# controller checks the zero against the last run's saved zero and refuses a
# program whose last run did not finish.

class DoOverError(Exception): pass


TOL = 0.01          # mm: a move is "on the floor" within this
HOP_LEN = 30.0      # mm: longest path over a tab that is followed, not lifted out of
HOP_RISE = 10.0     # mm: highest a tab can be above the floor
DEFAULTS = {
    'extra': 0.5,       # mm deeper than the old floor
    'step': 1.0,        # mm deepest step per pass
    'start_above': 0.5, # mm above the old floor where the feed into the skin starts
    'plunge': 300,      # mm/min into the skin
    'spinup': 10,       # seconds
    'tabs': 'keep',     # keep | under
    'pause': True,      # stop over the first cut so the operator can check it
}
LIMITS = {'extra': (0.05, 5.0), 'step': (0.1, 5.0), 'start_above': (0.2, 3.0),
          'plunge': (10, 2000), 'spinup': (0, 120)}
DRILLS = (73, 81, 82, 83, 85, 86, 89)
CANNED_BAD = (76, 84, 87, 88)


def clean_opts(opts):
    o = dict(DEFAULTS)
    opts = opts or {}
    for k, (lo, hi) in LIMITS.items():
        if k not in opts: continue
        try: v = float(opts[k])
        except (TypeError, ValueError):
            raise DoOverError('%s must be a number.' % k.replace('_', ' ').capitalize())
        if not (lo <= v <= hi) or math.isnan(v):
            raise DoOverError('%s must be between %s and %s.'
                              % (k.replace('_', ' ').capitalize(), fmt(lo), fmt(hi)))
        o[k] = v
    if opts.get('tabs') in ('keep', 'under'): o['tabs'] = opts['tabs']
    if 'pause' in opts: o['pause'] = bool(opts['pause'])
    o['ops'] = opts.get('ops')
    return o


def _dist(a, b): return math.hypot(b[0] - a[0], b[1] - a[1])


def _arc_len(mv):
    s, e = mv['s'], mv['e']
    if mv.get('arc') is None: return _dist(s, e)
    a = mv['arc']
    if 'R' in a: return max(_dist(s, e), abs(a['R']) * math.pi / 2)
    c = (s[0] + a.get('I', 0.0), s[1] + a.get('J', 0.0))
    r = _dist(c, s)
    a0 = math.atan2(s[1] - c[1], s[0] - c[0])
    a1 = math.atan2(e[1] - c[1], e[0] - c[0])
    sweep = (a0 - a1) if mv['g'] == 2 else (a1 - a0)
    while sweep <= 1e-9: sweep += 2 * math.pi
    return r * sweep


class Op(object):
    def __init__(self, index, first):
        self.index = index
        self.name = None
        self.first = first      # first line
        self.last = first
        self.moves = []         # motion moves, in order
        self.holes = []         # drilled holes {n, x, y, z, r, f}
        self.reasons = []       # why it can't be deepened
        self.state = None       # Modal at the first move
        self.tool = None
        self.wcs = set()
        self.other = False

    def reason(self, text):
        if text not in self.reasons: self.reasons.append(text)


def _setup_lines(lines):
    out = []
    for n, line in enumerate(lines[:400], 1):
        m = GCodeText.SETUP_LINE.match(line)
        if m:
            out.append((m.group(1).lower(), m.group(2)))
            continue
        if GCodeText.FIRST_CODE.match(line) and not line.lstrip().startswith('('): break
    return out


def _range(text, axis):
    m = re.search(axis + r'\s*=\s*(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)', text or '', re.I)
    if not m: return None
    try:
        a, b = float(m.group(1)), float(m.group(2))
        return min(a, b), max(a, b)
    except ValueError: return None


def parse(lines):
    '''Reads a program into operations.  Raises DoOverError for anything
    that makes positions unknowable (expressions, subroutines, G92, G10, or a
    comment the planner reads differently from how it looks).'''
    ops = []
    m = Modal()
    cur = {'X': None, 'Y': None, 'Z': None}     # work position, mm
    op = None
    pending_name = None
    open_comment = False
    canned = None        # active drill cycle G number
    canned_z = canned_r = None
    comp = False
    last_tool = None
    wcs_all = set()
    inch = False

    def new_op(n):
        o = Op(len(ops), n)
        ops.append(o)
        return o

    for n, raw in enumerate(lines, 1):
        code, comments, issues, open_comment = GCodeText.split(raw, open_comment)
        if issues:
            raise DoOverError('Line %d: %s. Fix the comment in the program '
                              '(brackets inside a comment can be written as [ ]) '
                              'and upload it again.' % (n, GCodeText.problem_text(issues)))
        text = code.strip()

        if not text:
            # A comment on its own line names the operation that follows it
            c = ' '.join(x.strip() for x in comments).strip()
            if c and not GCodeText.SETUP_LINE.match(raw) and not c.upper().startswith('MSG'):
                if op is not None and op.moves: op = None
                pending_name = c
            continue
        if text.startswith('%'): continue

        if '#' in text or '[' in text:
            raise DoOverError('Line %d uses variables or expressions, so where the '
                              'tool goes cannot be worked out safely.' % n)
        words = [(c.upper(), float(v)) for c, v in WORD.findall(text)]
        letters = set(c for c, _ in words)
        if 'O' in letters:
            raise DoOverError('Line %d uses an O-word (subroutine or loop), so where '
                              'the tool goes cannot be worked out safely.' % n)
        gs = [v for c, v in words if c == 'G']
        ms = [v for c, v in words if c == 'M']
        vals = {}
        for c, v in words: vals[c] = v
        for g in gs:
            if g in (92, 92.1, 92.2, 92.3) or 10 <= g < 11:
                raise DoOverError('Line %d uses G%s, which moves the work zero '
                                  'inside the program. Cut deeper cannot follow that.'
                                  % (n, fmt(g)))
        for v in ms:
            if v in (98, 99):
                raise DoOverError('Line %d calls a subroutine (M%d).' % (n, v))

        # Tool change: a new operation
        if 'T' in vals and int(vals['T']) != last_tool:
            if op is not None and op.moves: op = None
        if 6 in ms and op is not None and op.moves: op = None
        if 'T' in vals: last_tool = int(vals['T'])

        m.apply(text)
        if m.units == 'G20': inch = True
        k = 1.0 if m.units == 'G21' else MM
        for g in gs:
            if g in (41, 42, 41.1, 42.1): comp = True
            elif g == 40: comp = False
            elif g == 80: canned = None
            elif g in (0, 1, 2, 3): canned = None
            elif g in DRILLS or g in CANNED_BAD:
                canned = g
        if canned is not None and any(g in DRILLS or g in CANNED_BAD for g in gs):
            if 'Z' in vals: canned_z = vals['Z'] * k
            if 'R' in vals: canned_r = vals['R'] * k

        moving = any(a in vals for a in 'XYZ')
        if not moving and not ms and 'T' not in vals: continue

        if op is None:
            op = new_op(n)
            op.name = pending_name
            pending_name = None
        op.last = n
        if 'T' in vals or op.tool is None: op.tool = m.tool
        if not moving: continue

        # Machine-coordinate and home moves: position unknown afterwards
        if 53 in gs or any(g in (28, 30, 28.1, 30.1) for g in gs) or \
           any(38 <= g < 39 for g in gs):
            for a in 'XYZ':
                if a in vals or any(g in (28, 30) for g in gs): cur[a] = None
            continue

        if m.dist == 'G91':
            op.reason('uses relative moves (G91)')
            for a in 'XYZ':
                if a in vals: cur[a] = None
            continue

        if canned is not None:
            if canned in CANNED_BAD:
                op.reason('uses G%s, which this controller does not run as written' % fmt(canned))
            new = dict(cur)
            for a in 'XY':
                if a in vals: new[a] = vals[a] * k
            if None in (new['X'], new['Y'], canned_z):
                op.reason('has a drill cycle whose position is not known')
            else:
                op.holes.append({'n': n, 'x': new['X'], 'y': new['Y'], 'z': canned_z,
                                 'r': canned_r, 'f': (m.feed or 0) * k or None,
                                 'state': m.copy()})
                if op.state is None: op.state = m.copy()
                wcs_all.add(m.wcs); op.wcs.add(m.wcs)
            cur = {'X': new['X'], 'Y': new['Y'], 'Z': None}
            continue

        if m.motion not in (0, 1, 2, 3): continue
        new = dict(cur)
        for a in 'XYZ':
            if a in vals: new[a] = vals[a] * k

        mv = {'n': n, 'g': m.motion, 's': (cur['X'], cur['Y'], cur['Z']),
              'e': (new['X'], new['Y'], new['Z']),
              'f': (m.feed * k) if m.feed else None, 'arc': None}
        if m.motion in (2, 3):
            if m.plane != 'G17': op.reason('has arcs in the XZ or YZ plane (G18/G19)')
            if 'P' in vals and vals['P'] != 1: op.reason('has arcs with several turns (P word)')
            arc = {}
            for a in 'IJR':
                if a in vals: arc[a] = vals[a] * k
            if not arc: op.reason('has an arc without I, J or R')
            mv['arc'] = arc
        if comp: op.reason('uses cutter compensation (G41/G42), which this controller ignores')
        if op.state is None: op.state = m.copy()
        mv['state'] = (m.tool, m.spindle, m.speed, m.mist, m.flood)
        wcs_all.add(m.wcs); op.wcs.add(m.wcs)
        op.moves.append(mv)
        cur = new

    # G93 (inverse time) changes what F means for every move after it
    open_comment = False
    for n, raw in enumerate(lines, 1):
        code, _, _, open_comment = GCodeText.split(raw, open_comment)
        for c, v in WORD.findall(code):
            if c.upper() == 'G' and float(v) in (93, 90.1, 95):
                for o in ops:
                    if o.first <= n <= o.last:
                        o.reason('uses G%s, which Cut deeper does not handle' % fmt(float(v)))
    ops = [o for o in ops if o.moves or o.holes]
    for i, o in enumerate(ops): o.index = i
    return ops, wcs_all, last_tool, inch


def analyse_ops(ops):
    '''Works out each operation's floor and what would be cut again.'''
    for o in ops:
        zs = [mv['e'][2] for mv in o.moves if mv['e'][2] is not None]
        zs += [h['z'] for h in o.holes]
        o.floor = min(zs) if zs else None
        o.top = max(zs) if zs else None
        tops = [mv['s'][2] for mv in o.moves if mv['s'][2] is not None]
        if tops: o.top = max(o.top, max(tops))
        o.runs = []
        o.chains = []
        o.drill = []
        if o.floor is None: continue
        f = o.floor

        def on_floor(mv):
            s, e = mv['s'], mv['e']
            return (mv['g'] in (1, 2, 3) and None not in s and None not in e and
                    abs(s[2] - f) < TOL and abs(e[2] - f) < TOL)

        flags = [on_floor(mv) for mv in o.moves]
        run = []
        for i, mv in enumerate(o.moves):
            if flags[i]: run.append(i)
            elif run: o.runs.append(run); run = []
        if run: o.runs.append(run)

        # Plunged holes: straight down to the floor, then not along it
        for i, mv in enumerate(o.moves):
            s, e = mv['s'], mv['e']
            if mv['g'] != 1 or None in s or None in e: continue
            if abs(e[2] - f) >= TOL or s[2] <= e[2] + TOL: continue
            if _dist(s, e) > TOL: continue
            if i + 1 < len(o.moves) and flags[i + 1]: continue
            o.drill.append({'n': mv['n'], 'x': e[0], 'y': e[1], 'z': f,
                            'f': mv['f'], 'state': None})
        for h in o.holes:
            if abs(h['z'] - f) < TOL: o.drill.append(h)

        # Join runs separated only by a short path over a tab
        chains = []
        for r in o.runs:
            if chains:
                prev = chains[-1]['runs'][-1]
                gap = o.moves[prev[-1] + 1:r[0]]
                if _is_hop(gap, f): 
                    chains[-1]['runs'].append(r)
                    chains[-1]['hops'].append(gap)
                    continue
            chains.append({'runs': [r], 'hops': []})
        for c in chains:
            a = o.moves[c['runs'][0][0]]['s']
            b = o.moves[c['runs'][-1][-1]]['e']
            c['closed'] = _dist(a, b) < TOL
            c['len'] = sum(_arc_len(o.moves[i]) for r in c['runs'] for i in r)
            c['hop_len'] = sum(_arc_len(mv) for h in c['hops'] for mv in h)
        o.chains = chains
        o.tabs = sum(len(c['hops']) for c in chains)
        # Moves at other depths below the top that are not part of the floor
        o.other = any(mv['g'] in (1, 2, 3) and mv['e'][2] is not None and
                      f + TOL < mv['e'][2] < f + 0.5 and not flags[i]
                      for i, mv in enumerate(o.moves))
        if not o.chains and not o.drill:
            o.reason('has no passes along its deepest Z (a 3D or ramping toolpath)')
        if len(o.wcs) > 1: o.reason('uses more than one work offset')
    return ops


def _near_seg(p, a, b, tol):
    ab = (b[0] - a[0], b[1] - a[1])
    den = ab[0] * ab[0] + ab[1] * ab[1]
    t = 0.0 if den == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / den))
    return math.hypot(a[0] + t * ab[0] - p[0], a[1] + t * ab[1] - p[1]) <= tol


def _arc_points(mv, n = 16):
    # Points along a move, arcs included, for _on_old_path
    s, e = mv['s'], mv['e']
    a = mv.get('arc')
    if not a or 'R' in a: return [s[:2], ((s[0] + e[0]) / 2, (s[1] + e[1]) / 2), e[:2]]
    c = (s[0] + a.get('I', 0.0), s[1] + a.get('J', 0.0))
    r = _dist(c, s)
    a0 = math.atan2(s[1] - c[1], s[0] - c[0])
    a1 = math.atan2(e[1] - c[1], e[0] - c[0])
    sweep = (a0 - a1) if mv['g'] == 2 else (a1 - a0)
    while sweep <= 1e-9: sweep += 2 * math.pi
    sgn = -1 if mv['g'] == 2 else 1
    return [(c[0] + r * math.cos(a0 + sgn * sweep * i / n),
             c[1] + r * math.sin(a0 + sgn * sweep * i / n)) for i in range(n + 1)]


def _on_old_path(op, gap, before):
    '''True when every point of the path over a tab lies on a path that an
    earlier, higher pass of the same operation cut (the same contour one
    stepdown up).  Only then is it the contour itself and not a link across
    the part, so it is safe to cut through.'''
    hp = [p for mv in gap for p in _arc_points(mv, 8)]
    tol = 0.06
    x0, x1 = min(p[0] for p in hp) - tol, max(p[0] for p in hp) + tol
    y0, y1 = min(p[1] for p in hp) - tol, max(p[1] for p in hp) + tol
    segs = []
    for mv in op.moves[:before]:
        if mv['g'] not in (1, 2, 3) or None in mv['s'] or None in mv['e']: continue
        if mv.get('arc') is None:
            # Only segments near the tab can matter (programs can be long)
            s, e = mv['s'], mv['e']
            if max(s[0], e[0]) < x0 or min(s[0], e[0]) > x1 or \
               max(s[1], e[1]) < y0 or min(s[1], e[1]) > y1: continue
        pts = _arc_points(mv)
        for i in range(len(pts) - 1): segs.append((pts[i], pts[i + 1]))
    if not segs: return False
    for mv in gap:
        for p in _arc_points(mv, 8):
            if not any(_near_seg(p, a, b, tol) for a, b in segs): return False
    return True


def _reverse(gap):
    '''The same path the other way round (arcs keep their centre).'''
    out = []
    for mv in reversed(gap):
        r = dict(mv)
        r['s'], r['e'] = mv['e'], mv['s']
        if mv.get('arc'):
            a = mv['arc']
            r['g'] = 5 - mv['g']
            if 'R' in a: r['arc'] = {'R': a['R']}
            else:
                c = (mv['s'][0] + a.get('I', 0.0), mv['s'][1] + a.get('J', 0.0))
                r['arc'] = {'I': c[0] - mv['e'][0], 'J': c[1] - mv['e'][1]}
        out.append(r)
    return out


def _is_hop(gap, floor):
    if not gap: return False
    length = 0.0
    for mv in gap:
        if mv['g'] not in (1, 2, 3): return False
        if None in mv['s'] or None in mv['e']: return False
        for z in (mv['s'][2], mv['e'][2]):
            if z < floor - TOL or z > floor + HOP_RISE: return False
        length += _arc_len(mv)
    return length <= HOP_LEN


def summary(ops, setup, units):
    stock = setup.get('stock', '')
    zr = _range(stock, 'z')
    supported = [o for o in ops if not o.reasons]
    deepest = min([o.floor for o in supported], default = None)
    out = []
    for o in ops:
        default = (not o.reasons and o.floor is not None and
                   (abs(o.floor - deepest) < 0.05 or
                    (zr is not None and o.floor <= zr[0] + 0.5)))
        out.append({
            'index': o.index,
            'name': GCodeText.safe_comment(o.name or ('Tool T%d' % o.tool if o.tool is not None
                                                      else 'Operation %d' % (o.index + 1))),
            'lines': [o.first, o.last], 'tool': o.tool,
            'floor': None if o.floor is None else round(o.floor, 4),
            'passes': len(o.chains), 'holes': len(o.drill),
            'tabs': getattr(o, 'tabs', 0),
            'closed': sum(1 for c in o.chains if c['closed']),
            'length': round(sum(c['len'] for c in o.chains), 1),
            'default': bool(default),
            'reason': '; '.join(o.reasons) if o.reasons else None,
            'other_depths': bool(o.other),
        })
    suggest = 0.5
    if zr is not None and deepest is not None and deepest > zr[0] - 0.2:
        suggest = max(0.2, math.ceil((deepest - zr[0] + 0.2) * 10 - 1e-6) / 10)
    return {
        'ops': out, 'units': units,
        'deepest': None if deepest is None else round(deepest, 4),
        'stock_bottom': None if zr is None else zr[0],
        'stock_top': None if zr is None else zr[1],
        'suggest_extra': min(LIMITS['extra'][1], suggest),
    }


def depths(floor, extra, step):
    out = []
    d = 0.0
    while d < extra - 1e-9:
        d = min(extra, d + step)
        out.append(floor - d)
    return out


def build(lines, name, opts, top_mm = None, manual = False, router = '',
          tool_now = None):
    '''Returns (text, info) for the do-over program.  Positions in mm.'''
    o = clean_opts(opts)
    ops, wcs_all, last_tool, inch = parse(lines)
    analyse_ops(ops)
    if not ops: raise DoOverError('The program has no moves.')
    setup = GCodeText.setup_fields(lines[:400])
    units = 'in' if inch else 'mm'
    summ = summary(ops, setup, units)
    want = o['ops']
    if want is None: want = [x['index'] for x in summ['ops'] if x['default']]
    try: want = sorted(set(int(i) for i in want))
    except (TypeError, ValueError): raise DoOverError('Bad operation list.')
    if not want: raise DoOverError('Choose at least one operation to cut deeper.')
    chosen = []
    for i in want:
        if not (0 <= i < len(ops)): raise DoOverError('There is no operation %d.' % (i + 1))
        if ops[i].reasons:
            raise DoOverError('%s cannot be cut deeper: it %s.'
                              % (summ['ops'][i]['name'], '; '.join(ops[i].reasons)))
        chosen.append(ops[i])
    if len(wcs_all) > 1:
        raise DoOverError('The program uses more than one work offset (%s). Cut deeper '
                          'only works with one.' % ', '.join(sorted(wcs_all)))
    wcs = (list(wcs_all) or ['G54'])[0]

    zr = _range(setup.get('stock', ''), 'z')
    stock_top = zr[1] if zr else 0.0
    warnings = []
    safe_c = GCodeText.safe_comment
    extra, step, above = o['extra'], o['step'], o['start_above']
    plunge = o['plunge']

    out = []
    w = out.append
    w('(DO-OVER of %s: %s mm deeper)' % (safe_c(name), fmt(extra)))
    # Setup sheet: copied, with the job line replaced
    names = ', '.join(summ['ops'][x.index]['name'] for x in chosen)
    sheet = _setup_lines(lines)
    job = dict(sheet).get('job')
    w('(SETUP job: Cut deeper of %s%s)' % (safe_c(name), (' - ' + safe_c(job)) if job else ''))
    for key, text in sheet:
        if key in ('job', 'time', 'do-over'): continue
        w('(SETUP %s: %s)' % (key, safe_c(text)))
    w('(SETUP do-over: %s cut again from %s mm above the old floor down to %s mm '
      'below it, at most %s mm per pass. Needs the same stock, work zero and tool '
      'as the run that left the skin.)'
      % (safe_c(names), fmt(above), fmt(extra), fmt(step)))
    w('(Written by Cut deeper on the controller. All moves are in mm.)')
    w('G21 G90 G94 G17 G40 %s' % wcs)
    w('M5')
    w('M9')
    if top_mm is not None: w('G53 G0 Z%s' % fmt(top_mm))

    tool = tool_now
    if tool is None:
        t0 = next((x.tool for x in chosen if x.tool is not None), None)
        if t0 is not None: w('(Tool in spindle must be T%d)' % t0)

    # Everything below goes through these, which know where the tool is, so
    # nothing is sent twice and no move is made that goes nowhere
    pos = [None, None, None]
    spin = [None]
    feed = [None]
    est = [0.0]

    def F(f):
        f = float(f)
        if feed[0] is None or abs(feed[0] - f) > 1e-6:
            feed[0] = f
            return ' F%s' % fmt(f)
        return ''

    def same(a, b): return a is not None and b is not None and abs(a - b) < 1e-6

    def g0z(z):
        if same(pos[2], z): return
        w('G0 Z%s' % fmt(z))
        pos[2] = z

    def g0xy(x, y):
        if same(pos[0], x) and same(pos[1], y): return
        w('G0 X%s Y%s' % (fmt(x), fmt(y)))
        pos[0], pos[1] = x, y

    def lin(z, f):
        if same(pos[2], z): return
        w('G1 Z%s%s' % (fmt(z), F(f)))
        if pos[2] is not None: est[0] += abs(pos[2] - z) / max(f, 1) * 60
        pos[2] = z

    def move(mv, z):
        e = mv['e']
        f = mv['f'] or plunge
        if mv['arc'] is None and same(pos[0], e[0]) and same(pos[1], e[1]) and same(pos[2], z):
            return
        words = 'G%d X%s Y%s Z%s' % (mv['g'], fmt(e[0]), fmt(e[1]), fmt(z))
        if mv['arc']:
            for a in 'IJR':
                if a in mv['arc']: words += ' %s%s' % (a, fmt(mv['arc'][a]))
        w(words + F(f))
        est[0] += _arc_len(mv) / max(f, 1) * 60
        pos[0], pos[1], pos[2] = e[0], e[1], z

    first = True
    passes = 0
    holes = 0
    deepest = None
    unverified = 0
    for op in chosen:
        info_op = summ['ops'][op.index]
        f0 = op.floor
        ds = depths(f0, extra, step)
        deepest = min(ds[-1], deepest) if deepest is not None else ds[-1]
        safe = max(op.top if op.top is not None else 0.0, stock_top + 2.0)
        w('(Operation: %s, lines %d to %d, old floor Z%s, new floor Z%s)'
          % (info_op['name'], op.first, op.last, fmt(f0), fmt(ds[-1])))

        # First kept item, for the tool, spindle and where to go first
        if op.chains:
            first_mv = op.moves[op.chains[0]['runs'][0][0]]
            start_xy = first_mv['s'][:2]
            st = first_mv['state']
        else:
            h = op.drill[0]
            start_xy = (h['x'], h['y'])
            st = None
        m = op.state.copy() if op.state else Modal()
        if st: m.tool, m.spindle, m.speed, m.mist, m.flood = st
        if m.tool is None: m.tool = op.tool

        change = tool is not None and m.tool is not None and m.tool != tool
        if change:
            g0z(safe)
            if manual:
                w('(MSG, Switch the router OFF for the tool change to T%d. Press Start to continue.)' % m.tool)
                w('M0')
            w('M5')
            w('T%d M6' % m.tool)
            spin[0] = None
            pos[0] = pos[1] = pos[2] = None     # the tool change may move the machine
            if top_mm is not None: w('G53 G0 Z%s' % fmt(top_mm))
            if first: warnings.append('The program starts with a tool change to T%d '
                                      '(T%d is in the spindle).' % (m.tool, tool))
        if pos[2] is None and top_mm is not None:
            # Z is at the top of its travel: over the first cut up there, then down
            g0xy(start_xy[0], start_xy[1])
            g0z(safe)
        else:
            g0z(safe)
            g0xy(start_xy[0], start_xy[1])
        if first or change:
            spin[0] = (m.spindle, m.speed)
            out.extend(start_lines(m, o['spinup'], manual, router,
                                   'the cutter is T%s and is over the old cut' %
                                   (m.tool if m.tool is not None else '?'),
                                   pause = o['pause'] and first))
        elif m.spindle in ('M3', 'M4') and spin[0] != (m.spindle, m.speed):
            spin[0] = (m.spindle, m.speed)
            w('S%s %s' % (fmt(m.speed or 0), m.spindle))
        if m.tool is not None: tool = m.tool
        first = False
        feed[0] = None

        for c in op.chains:
            passes += 1
            runs, hops = c['runs'], c['hops']
            sxy = op.moves[runs[0][0]]['s']
            cut_f = op.moves[runs[0][0]]['f'] or plunge
            descend = min(max(cut_f, plunge), 3000)
            through = [o['tabs'] == 'under' and _on_old_path(op, gap, runs[0][0])
                       for gap in hops]
            unverified += sum(1 for i, t in enumerate(through)
                              if o['tabs'] == 'under' and not t)
            cleared = [False] * len(hops)
            at_start = False
            for d in ds:
                if not (at_start and c['closed']):
                    # Over the start, then down through the old cut at a feed:
                    # the tool reached the old floor here, so the space above
                    # it is clear
                    g0z(safe)
                    g0xy(sxy[0], sxy[1])
                    lin(f0 + above, descend)
                lin(d, plunge)
                for ri, r in enumerate(runs):
                    if ri:
                        gap = hops[ri - 1]
                        if through[ri - 1] and not cleared[ri - 1]:
                            # Cut the tab away a step at a time from its top,
                            # back and forth along its own path, then on down
                            lin(f0, gap[0]['f'] or cut_f)
                            ztop = max(max(mv['s'][2], mv['e'][2]) for mv in gap)
                            levels = []
                            z = ztop - step
                            while z > f0 + 1e-6:
                                levels.append(z)
                                z -= step
                            levels += [f0, d]
                            fwd = True
                            for z in levels:
                                path = gap if fwd else _reverse(gap)
                                for mv in path: move(mv, min(z, mv['e'][2]) if z > d else d)
                                fwd = not fwd
                            if not (len(levels) % 2):
                                # Ended back at the start of the tab: across again
                                for mv in gap: move(mv, d)
                            cleared[ri - 1] = True
                        elif through[ri - 1]:
                            for mv in gap: move(mv, d)
                        else:
                            # Over the tab on the original path, which is clear
                            lin(f0, gap[0]['f'] or cut_f)
                            for mv in gap: move(mv, mv['e'][2])
                            lin(d, plunge)
                    for i in r: move(op.moves[i], d)
                at_start = True
            g0z(safe)

        for h in op.drill:
            holes += 1
            hf = min(h['f'] or plunge, plunge * 2)
            g0z(safe)
            g0xy(h['x'], h['y'])
            lin(f0 + above, min(max(hf, plunge), 3000))
            prev = None
            for d in ds:
                if prev is not None:
                    g0z(f0 + above)     # clear the chips
                    lin(prev, min(max(hf, plunge), 3000))
                lin(d, hf)
                prev = d
            g0z(safe)

    if unverified:
        warnings.append('%d tab%s could not be confirmed to lie on the path the '
                        'earlier passes cut, so %s kept rather than cut through.'
                        % (unverified, 's' if unverified > 1 else '',
                           'they were' if unverified > 1 else 'it was'))

    w('M5')
    w('M9')
    if top_mm is not None: w('G53 G0 Z%s' % fmt(top_mm))
    w('M30')

    if zr is not None and deepest < zr[0] - 1.0:
        warnings.append('The new floor (Z%s) is %s mm below the bottom of the stock '
                        'in the setup sheet (Z%s): that cuts into the spoilboard.'
                        % (fmt(deepest), fmt(zr[0] - deepest), fmt(zr[0])))
    if zr is None:
        warnings.append('The setup sheet has no stock Z range, so the new floor '
                        'cannot be checked against the bottom of the stock.')
    if len(set(x.tool for x in chosen if x.tool is not None)) > 1:
        warnings.append('The chosen operations use more than one tool. Set Z for each tool '
                        'the same way you did for the original run: the zero check only '
                        'covers the zero in use when that run ended.')
    if any(x.drill for x in chosen):
        warnings.append('Holes are drilled again with straight moves in %s mm steps, '
                        'lifting %s mm above the old bottom between steps.'
                        % (fmt(step), fmt(above)))

    info = {
        'ops': [summ['ops'][x.index] for x in chosen],
        'extra': extra, 'step': step, 'start_above': above, 'plunge': plunge,
        'tabs': o['tabs'], 'passes': passes, 'holes': holes,
        'deepest': round(deepest, 4), 'stock_bottom': None if zr is None else zr[0],
        'time': round(est[0]), 'lines': len(out),
        'manual_spindle': bool(manual), 'warnings': warnings,
    }
    return '\n'.join(out) + '\n', info


def output_name(source):
    name = 'doover-' + source
    if len(name) > 200: name = 'doover-' + source[-190:]
    return name


class DoOver(object):
    def __init__(self, ctrl):
        self.ctrl = ctrl
        self.log = ctrl.log.get('DoOver')


    def _read(self, filename):
        if not filename or '/' in filename or filename.startswith('.'):
            raise DoOverError('Bad file name.')
        path = self.ctrl.get_upload(filename)
        if not os.path.isfile(path):
            raise DoOverError('The program %s is not on the controller.' % filename)
        with open(path, 'r', encoding = 'utf-8', errors = 'replace') as f:
            return path, f.read().splitlines()


    def _top_mm(self):
        s = self.ctrl.state
        try:
            motor = s.find_motor('z')
            tm = s.get('%dtm' % motor, None) if motor is not None else None
            return None if tm is None else float(tm) - 1.0
        except Exception: return None


    def _probe_time(self):
        try:
            path = os.path.join(self.ctrl.get_path('next-data'), 'probe.json')
            with open(path, 'r', encoding = 'utf-8') as f: rec = json.load(f)
            return float(rec.get('time')) / 1000.0
        except Exception: return None


    def run_check(self, filename, path):
        '''How the last run of filename went, and whether the zero is the
        same.  status: ok | moved | unknown | interrupted.'''
        s = self.ctrl.state
        cp = getattr(self.ctrl, 'checkpoint', None)
        rec = cp.get() if cp else None
        res = {'status': 'unknown', 'delta': {}, 'notes': [], 'msg': ''}
        homed = all(s.is_axis_homed(a) for a in 'xyz')
        res['homed'] = homed
        if not rec or rec.get('file') != filename:
            res['msg'] = ('The controller has no saved run of %s (Save job progress '
                          'is off, or another program has run since), so it cannot '
                          'check that the zero and the cut are the same as before.'
                          % filename)
            return res
        res['tool'] = rec.get('tool')
        res['t'] = rec.get('t')
        line, nlines = rec.get('line'), rec.get('nlines')
        finished = rec.get('status') in ('stopped', 'dismissed') and bool(nlines) and \
            line is not None and int(line) >= int(nlines) - 5
        if rec.get('sha'):
            try:
                if sha_of(path) != rec['sha']:
                    res['msg'] = ('%s has changed since it last ran, so the cut on the '
                                  'stock may not match it.' % filename)
                    return res
            except OSError: pass
        if not finished:
            res['status'] = 'interrupted'
            res['msg'] = ('The last run of %s did not finish (it stopped at line %s%s). '
                          'Finish it with Resume first: Cut deeper goes down through '
                          'the old cut quickly and assumes every pass above the old '
                          'floor was cut.' % (filename, line,
                                              (' of %s' % nlines) if nlines else ''))
            return res
        saved = rec.get('offset') or {}
        delta = {}
        for a in 'xyz':
            if saved.get(a) is None: continue
            d = float(s.get('offset_' + a, 0) or 0) - float(saved[a])
            if abs(d) > 0.05: delta[a] = round(d, 4)
        res['delta'] = delta
        if delta:
            res['status'] = 'moved'
            res['msg'] = ('The work zero has changed since %s ran (%s). The deeper cut '
                          'would be in the wrong place. Put the zero back first.'
                          % (filename, ', '.join('%s by %s mm' % (a.upper(), fmt(v))
                                                 for a, v in sorted(delta.items()))))
        else:
            res['status'] = 'ok'
            res['msg'] = 'The work zero is the same as when %s ran.' % filename
        pt = self._probe_time()
        if pt is not None and rec.get('t') and pt > float(rec['t']):
            res['notes'].append('The zero was probed again after the run. It matches '
                                'within 0.05 mm, but check Z: a new Z probe on a different '
                                'spot shifts every depth.' if not delta else
                                'The zero was probed again after the run.')
        if not homed:
            res['notes'].append('Home the machine first: the zero is only comparable '
                                'with the saved one after homing.')
        return res


    def analyse(self, filename):
        path, lines = self._read(filename)
        ops, wcs_all, _, inch = parse(lines)
        analyse_ops(ops)
        setup = GCodeText.setup_fields(lines[:400])
        units = 'in' if inch else 'mm'
        res = summary(ops, setup, units)
        res['file'] = filename
        res['output'] = output_name(filename)
        res['run'] = self.run_check(filename, path)
        res['defaults'] = dict((k, v) for k, v in DEFAULTS.items())
        res['wcs'] = sorted(wcs_all)
        return res


    def build(self, filename, opts):
        s = self.ctrl.state
        if s.get('cycle') != 'idle': raise DoOverError('Wait until the machine is idle.')
        path, lines = self._read(filename)
        opts = opts or {}
        run = self.run_check(filename, path)
        if not run.get('homed'):
            raise DoOverError('Home the machine first (X, Y and Z).')
        if run['status'] == 'interrupted': raise DoOverError(run['msg'])
        if run['status'] == 'moved':
            # No override: a deeper cut in the wrong place cannot be undone
            raise DoOverError(run['msg'])
        if run['status'] == 'unknown' and not opts.get('ack_unknown'):
            raise DoOverError(run['msg'] + ' Tick the box to confirm it is the same '
                              'stock, zero and tool, and that the last run finished.')

        tool_now = s.get('tool', None)
        try: tool_now = int(tool_now) if tool_now not in (None, '') else run.get('tool')
        except (TypeError, ValueError): tool_now = run.get('tool')
        manual = manual_spindle(self.ctrl.config)
        router = GCodeText.setup_fields(lines[:400]).get('router', '')
        text, info = build(lines, filename, opts, self._top_mm(), manual, router,
                           tool_now = tool_now)

        # Below the Z travel?
        try:
            motor = s.find_motor('z')
            tn = s.get('%dtn' % motor, None) if motor is not None else None
            if tn is not None:
                low = float(s.get('offset_z', 0) or 0) + info['deepest']
                if low < float(tn):
                    raise DoOverError('The new floor (Z%s) is below the bottom of Z '
                                      'travel by %s mm.' % (fmt(info['deepest']),
                                                            fmt(float(tn) - low)))
        except DoOverError: raise
        except Exception: pass

        # The same check every program gets before it runs: a generated
        # program with an error is never written
        from bbctrl import Lint
        lint = Lint.lint_lines(text.splitlines())
        if lint['errors']:
            raise DoOverError('The new program failed the G-code check, so it was not '
                              'written: ' + Lint.summary(lint))
        info['lint'] = {'errors': lint['errors'], 'warnings': lint['warnings'],
                        'issues': lint['issues']}

        name = output_name(filename)
        tmp = self.ctrl.get_upload(name + '.tmp')
        with open(tmp, 'w', encoding = 'utf-8') as f: f.write(text)
        os.replace(tmp, self.ctrl.get_upload(name))
        s.add_file(name)
        self.log.info('Wrote %s: %s mm deeper, %d passes, %d holes'
                      % (name, fmt(info['extra']), info['passes'], info['holes']))
        info['file'] = name
        info['source'] = filename
        info['run'] = run
        return info


    def restore_zero(self, filename, axes):
        cp = getattr(self.ctrl, 'checkpoint', None)
        rec = cp.get() if cp else None
        if not rec or rec.get('file') != filename:
            raise DoOverError('There is no saved run of %s to take the zero from.' % filename)
        res = getattr(self.ctrl, 'resume', None)
        if res is None: raise DoOverError('Restoring the zero is not available.')
        return res.restore_zero(axes, rec)
