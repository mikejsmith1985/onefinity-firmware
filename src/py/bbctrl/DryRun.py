# Quick dry run (1.33.0): the first pass of every operation, in the air.
#
# Up to 1.32.x a dry run sent the whole program lifted, so checking a
# three-hour program meant watching it for three hours.  Nobody does that.
# The dry run now sends a shortened copy of the program:
#
#   - Every operation runs once.  Cutting moves that go back over ground the
#     tool already covered in the same operation (the next depth level of a
#     pocket or profile, the next turn of a helix, the next stepover of a
#     channel) are left out.  The first pass of each hole, pocket, slot and
#     profile is kept, so every feature is visited in order.
#   - An operation is cut short after OP_SECONDS of cutting (a facing pass
#     over the whole plate): enough to see it covers the right surface.
#   - Every feed is DRY_FEED (rapids stay rapids), and the tool stops for
#     PAUSE_S at the start of each operation so you can see where it begins.
#   - Program pauses (M0, M1: manual tool changes) are left out.
#   - The planner then lifts it as before (begin_dry), with the router, mist
#     and probing blocked.
#
# The copy has exactly the same number of lines as the program, so the
# G-code view and the line numbers in messages match the program.  Lines
# that are left out become blank lines; the moves that carry the tool past a
# left-out stretch (up to the operation's clearance height, across, and down
# to where the next kept move starts) are written into those blank lines.
# Arcs keep their I/J centres because each kept move starts exactly where it
# did in the program.
#
# Programs this can't follow safely (incremental G91, inverse-time feed,
# arcs with R, subprograms, variables, rotation) are sent whole, as before,
# and the result says why.

import math
import re

from bbctrl import GCodeText

DRY_FEED = 3000.0      # mm/min
OP_SECONDS = 30.0      # longest an operation may cut in a dry run
PAUSE_S = 0.7          # stop at the start of each operation
COVER = 0.45           # a point is covered when within COVER x tool diameter
SAMPLE = 0.5           # mm between the points a move is checked at
DZ_LEVEL = 0.2         # mm deeper than an earlier pass: the next level
DEFAULT_TOOL = 6.35    # mm, when neither the sheet nor the program says

WORD = GCodeText.WORD
_MOTION_ONLY = set('GXYZIJKFN')


def _num(s):
    try: return float(s)
    except (TypeError, ValueError): return None


def stock_top(fields):
    '''Z of the stock top in work coordinates from the setup sheet fields,
    or None.  The same rules as the Depth view (1.32.1).'''
    st = fields.get('stock', '') or ''
    m = re.search(r'z\s*=\s*(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)', st, re.I)
    if m:
        a, b = _num(m.group(1)), _num(m.group(2))
        if a is not None and b is not None: return max(a, b)
    zero = fields.get('zero', '') or fields.get('z0', '') or ''
    if re.search(r'Z0\s+(ON|AT)\s+(THE\s+)?(STOCK|PLATE|PART|MATERIAL)\s+TOP|'
                 r'TOP OF (THE\s+)?(STOCK|PLATE|PART|MATERIAL)', zero, re.I):
        return 0.0
    if re.search(r'Z0\s+(ON|AT)\s+(THE\s+)?((STOCK|PLATE|PART|MATERIAL)\s+BOTTOM|'
                 r'(SPOIL|WASTE)?\s*BOARD|MDF|TABLE|BED)|BOTTOM OF (THE\s+)?'
                 r'(STOCK|PLATE)', zero, re.I):
        m = re.search(r'[\d.]+\s*[X×]\s*[\d.]+\s*[X×]\s*([\d.]+)',
                      fields.get('plate', '') or '', re.I)
        t = _num(m.group(1)) if m else None
        if t and t > 0: return t
    return None


def _tool_d(fields):
    d = _num(fields.get('tool-d'))
    if d and d > 0: return d
    m = re.match(r'\s*(flat|v)\s+([\d.]+)', fields.get('tool-geom', '') or '', re.I)
    if m and _num(m.group(2)): return _num(m.group(2))
    return None


class _Cover(object):
    '''Points the tool has cut through in the current operation, each with
    its Z and how far along the operation's path it was.  A point is covered
    (ground the dry run has already shown) when an earlier point within r
    was higher (a deeper pass over the same place: the next level, the next
    turn of a helix), or was passed more than `window` mm of path ago (the
    next stepover of a channel, a pocket or a facing pass).  Points just
    behind the tool on the same pass don't count, so a helix keeps its first
    turn and a small circle isn't cut short by itself.'''

    def __init__(self, r, window):
        self.r = r
        self.window = window
        self.cell = max(r, 0.05)
        self.grid = {}

    def _key(self, x, y): return (int(math.floor(x / self.cell)),
                                  int(math.floor(y / self.cell)))

    def covered(self, x, y, z, s):
        kx, ky = self._key(x, y)
        r2 = self.r * self.r
        for i in (kx - 1, kx, kx + 1):
            for j in (ky - 1, ky, ky + 1):
                for (px, py, pz, ps) in self.grid.get((i, j), ()):
                    if (px - x) ** 2 + (py - y) ** 2 <= r2 and \
                            (pz - z >= DZ_LEVEL or s - ps >= self.window):
                        return True
        return False

    def add(self, x, y, z, s):
        self.grid.setdefault(self._key(x, y), []).append((x, y, z, s))


def _arc_points(x0, y0, x1, y1, cx, cy, cw):
    r = math.hypot(x0 - cx, y0 - cy)
    a0 = math.atan2(y0 - cy, x0 - cx)
    a1 = math.atan2(y1 - cy, x1 - cx)
    if cw:
        d = a0 - a1
        while d <= 1e-9: d += 2 * math.pi
        d = -d
    else:
        d = a1 - a0
        while d <= 1e-9: d += 2 * math.pi
    n = max(2, int(abs(d) * r / SAMPLE) + 1)
    return [(cx + r * math.cos(a0 + d * k / n), cy + r * math.sin(a0 + d * k / n))
            for k in range(1, n + 1)], abs(d) * r


def _fmt(v):
    return ('%.4f' % v).rstrip('0').rstrip('.')


def reduce_lines(lines):
    '''Returns {'lines': [...] (same count as lines), 'whole': reason or None,
    'ops': n, 'seconds': estimated cutting time, 'kept': moves kept,
    'dropped': moves left out}.'''
    fields = GCodeText.setup_fields(lines[:400])
    top = stock_top(fields)
    cut_z = (top if top is not None else 0.0) + 0.5   # at or below: cutting
    tool = _tool_d(fields) or DEFAULT_TOOL

    # Things this can't follow: send the whole program
    in_c = False
    for raw in lines:
        code, _, _, in_c = GCodeText.split(raw, in_c)
        up = code.upper().replace(' ', '')
        for g, why in ((91, 'incremental moves (G91)'), (93, 'inverse-time feed (G93)'),
                       (68, 'coordinate rotation (G68)')):
            if re.search(r'G0*%d(?![\d.])' % g, up): return _whole(lines, why)
        if re.search(r'[#\[]|O\d|M98|M99', up):
            return _whole(lines, 'subprograms or variables')
        if re.search(r'G0*[23](?![\d.])', up) and re.search(r'R[-+.\d]', up):
            return _whole(lines, 'arcs given by R')

    # Where each operation starts: the last line of a block of comment lines
    comment_only = []
    in_c = False
    for raw in lines:
        code, comments, _, in_c = GCodeText.split(raw, in_c)
        comment_only.append(bool(comments) and not code.strip() and
                            not GCodeText.SETUP_LINE.match(raw))
    op_start = [False] * len(lines)
    for i in range(len(lines)):
        if not comment_only[i]: continue
        j = i + 1
        while j < len(lines) and not lines[j].strip(): j += 1
        op_start[i] = not (j < len(lines) and comment_only[j])

    out = list(lines)
    metric = True
    mode = 0
    x = y = z = None
    ops = 0
    cover = _Cover(COVER * tool, max(3 * tool, 15.0))
    op_time = 0.0
    op_clear = None      # highest Z seen in the operation (where to cross at)
    total = 0.0
    kept = dropped = 0
    gap = []             # indices of lines left out since the last kept move
    gap_start = None     # where the tool really is (end of the last kept move)
    path_s = 0.0
    in_c = False
    tool_up = True
    pending = []         # positioning moves since the last cutting move: kept
    pending_start = None # with the next kept cut, left out with a dropped one
    pending_len = 0.0
    pending_arcs = False # an arc among them needs its exact start

    def bridge(tx, ty, tz, descend = True):
        # carry the tool from gap_start to (tx, ty, tz) in the blank lines.
        # descend False: the next kept move only goes on above the stock (a
        # retract), so stay at the clearance height over (tx, ty)
        nonlocal gap, gap_start
        if not gap: return
        f = 'F%s' % _fmt(DRY_FEED if metric else DRY_FEED / 25.4)
        if None not in (tx, ty, tz):
            clear = max(op_clear if op_clear is not None else tz, tz,
                        gap_start[2] if gap_start and gap_start[2] is not None else tz)
            X, Y, Z, C = _fmt(tx), _fmt(ty), _fmt(tz), _fmt(clear)
            if descend and len(gap) >= 3:
                out[gap[0]] = 'G0 Z%s' % C
                out[gap[1]] = 'G0 X%s Y%s' % (X, Y)
                out[gap[2]] = 'G1 Z%s %s' % (Z, f)
            elif descend and len(gap) == 2:
                out[gap[0]] = 'G0 Z%s' % C
                out[gap[1]] = 'G1 X%s Y%s Z%s %s' % (X, Y, Z, f)
            elif descend:
                out[gap[0]] = 'G1 X%s Y%s Z%s %s' % (X, Y, Z, f)
            elif len(gap) >= 2:
                out[gap[0]] = 'G0 Z%s' % C
                out[gap[1]] = 'G0 X%s Y%s' % (X, Y)
            else:
                out[gap[0]] = 'G0 X%s Y%s Z%s' % (X, Y, C)
        gap = []
        gap_start = None

    def keep_pending():
        nonlocal pending, pending_start, pending_len, kept, total
        if not pending: return
        if gap: bridge(*pending_start, descend = pending_arcs)
        kept += len(pending)
        total += pending_len / DRY_FEED * 60.0
        pending, pending_start, pending_len = [], None, 0.0

    for i, raw in enumerate(lines):
        code, comments, _, in_c = GCodeText.split(raw, in_c)
        words = [(l.upper(), v) for l, v in WORD.findall(code)]
        letters = set(l for l, _ in words)
        gs = [float(v) for l, v in words if l == 'G']
        for g in gs:
            if g == 20: metric = False
            if g == 21: metric = True

        # A new operation: a comment line while the tool is up, a tool
        # change, or a pause
        if (op_start[i] and tool_up) or 'T' in letters or \
                any(l == 'M' and float(v) in (0, 1, 6) for l, v in words):
            keep_pending()
            if gap: bridge(x, y, z)
            cover = _Cover(COVER * tool, max(3 * tool, 15.0))
            op_time = 0.0
            op_clear = None
            path_s = 0.0
            if op_start[i]:
                # stop briefly where the operation starts
                out[i] = 'G4 P%s %s' % (_fmt(PAUSE_S), raw.strip())
                ops += 1

        # Program pauses (manual tool change, "fit the screws") are left out:
        # there is nothing to change or fit in a dry run
        if words and letters <= {'M', 'N'} and \
                all(float(v) in (0, 1) for l, v in words if l == 'M'):
            out[i] = ''
            continue

        motion = [g for g in gs if g in (0, 1, 2, 3)]
        if motion: mode = int(motion[-1])
        if any(g == 53 for g in gs):
            # machine-coordinate move (parking): keep it; position unknown
            keep_pending()
            if gap: bridge(x, y, z)
            if 'Z' in letters: z = None
            if 'X' in letters or 'Y' in letters: x = y = None
            tool_up = True
            continue
        has_xyz = any(l in 'XYZ' for l in letters)
        if not has_xyz:
            if 'F' in letters and words and all(l in 'FN' for l in letters):
                pass
            continue

        w = dict(words)
        nx = _num(w['X']) if 'X' in w else x
        ny = _num(w['Y']) if 'Y' in w else y
        nz = _num(w['Z']) if 'Z' in w else z
        only_motion = letters <= _MOTION_ONLY and not (set(gs) - {0, 1, 2, 3, 17, 90})
        if nz is not None:
            op_clear = nz if op_clear is None else max(op_clear, nz)

        cutting = mode in (1, 2, 3) and nz is not None and nz <= cut_z and \
            None not in (x, y, z, nx, ny)
        if not only_motion or None in (x, y, z, nx, ny, nz):
            if mode in (1, 2, 3): out[i] = _set_feed(out[i], metric)
            # a line with more than a move on it: always kept
            keep_pending()
            if gap: bridge(x, y, z)
            x, y, z = nx, ny, nz
            tool_up = nz is None or nz > cut_z
            continue
        if not cutting:
            # positioning above the stock: kept if it leads to a kept cut
            if mode in (1, 2, 3): out[i] = _set_feed(out[i], metric)
            if not pending: pending_start, pending_arcs = (x, y, z), False
            pending_arcs = pending_arcs or mode in (2, 3)
            pending.append(i)
            pending_len += math.sqrt((nx - x) ** 2 + (ny - y) ** 2 + (nz - z) ** 2)
            x, y, z = nx, ny, nz
            tool_up = nz > cut_z
            continue

        # Points along the move
        if mode in (2, 3) and ('I' in w or 'J' in w):
            cx = x + (_num(w.get('I', 0)) or 0); cy = y + (_num(w.get('J', 0)) or 0)
            pts, length = _arc_points(x, y, nx, ny, cx, cy, mode == 2)
        else:
            length = math.hypot(nx - x, ny - y)
            n = max(1, int(length / SAMPLE))
            pts = [(x + (nx - x) * k / n, y + (ny - y) * k / n) for k in range(1, n + 1)]
        length = math.hypot(length, nz - z)
        npts = len(pts)
        zs = [z + (nz - z) * (k + 1) / npts for k in range(npts)]
        ss = [path_s + length * (k + 1) / npts for k in range(npts)]
        need = max(1, 0.3 * npts)
        nnew = 0
        for k in range(npts):
            if not cover.covered(pts[k][0], pts[k][1], zs[k], ss[k]):
                nnew += 1
                if nnew >= need: break
            elif k + 1 - nnew > npts - need: break   # can't reach `need` any more
        plunge = math.hypot(nx - x, ny - y) < 1e-6
        fresh = nnew >= need or (plunge and not cover.covered(nx, ny, nz, path_s + length))
        over = op_time >= OP_SECONDS

        if fresh and not over:
            keep_pending()
            if gap: bridge(x, y, z)
            out[i] = _set_feed(out[i], metric)
            for k in range(npts): cover.add(pts[k][0], pts[k][1], zs[k], ss[k])
            t = length / DRY_FEED * 60.0
            op_time += t
            total += t
            kept += 1
        else:
            if not gap: gap_start = pending_start if pending else (x, y, z)
            for k in pending: out[k] = ''
            gap.extend(pending)
            dropped += len(pending)
            pending, pending_start, pending_len = [], None, 0.0
            out[i] = ''
            gap.append(i)
            dropped += 1
        path_s += length
        x, y, z = nx, ny, nz
        tool_up = False

    keep_pending()
    if gap: bridge(x, y, z)
    return {'lines': out, 'whole': None, 'ops': ops, 'seconds': round(total, 1),
            'kept': kept, 'dropped': dropped}


def _set_feed(line, metric):
    f = _fmt(DRY_FEED if metric else DRY_FEED / 25.4)
    code, comments, _, _ = GCodeText.split(line)
    if re.search(r'F\s*[-+.\d]', code, re.I):
        # replace the feed outside comments only
        parts = re.split(r'(\([^)]*\))', line)
        for k in range(0, len(parts), 2):
            parts[k] = re.sub(r'[Ff]\s*[-+]?(\d+\.?\d*|\.\d+)', 'F' + f, parts[k])
        return ''.join(parts)
    stripped = line.rstrip()
    m = re.match(r'^(.*?)(\s*\(.*)?$', stripped)
    return (m.group(1) + ' F' + f + (m.group(2) or '')) if m else stripped + ' F' + f


def _whole(lines, why):
    return {'lines': None, 'whole': why, 'ops': 0, 'seconds': None,
            'kept': 0, 'dropped': 0}


def reduce_file(path):
    '''For Work.FileCache: the shortened text (or None) and the summary.'''
    with open(path, 'r', encoding = 'utf-8', errors = 'replace') as f:
        lines = f.read().splitlines()
    r = reduce_lines(lines)
    text = None if r['lines'] is None else '\n'.join(r['lines']) + '\n'
    return {'text': text, 'whole': r['whole'], 'ops': r['ops'],
            'seconds': r['seconds'], 'kept': r['kept'], 'dropped': r['dropped']}


_results = None

def _cache():
    global _results
    if _results is None:
        from bbctrl import Work
        _results = Work.FileCache(reduce_file, 8, 'dryrun-1')
    return _results


def prepare_async(path, background = False):
    '''A Future for reduce_file(path), worked out in the worker and kept
    until the program changes.  background: ahead of time, after an upload,
    so pressing Dry run doesn't wait.'''
    return _cache().get_async(path, background)


def describe(r):
    '''One line for the screens.'''
    if r.get('text') is None:
        return 'Whole program (it uses %s, which the quick dry run does not follow).' % r.get('whole')
    m, sec = divmod(int(round(r.get('seconds') or 0)), 60)
    t = ('%d min %02d s' % (m, sec)) if m else ('%d s' % sec)
    ops = r.get('ops', 0)
    what = ('First pass of each of %d operations' % ops) if ops > 1 else \
        'First pass only (repeated depth passes left out)'
    return '%s at %d mm/min, about %s.' % (what, DRY_FEED, t)
