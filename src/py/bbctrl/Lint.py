# Pre-run G-code check (1.29.0).
#
# Reads a program the way the CAMotics planner will (GCodeText) and reports
# what is likely to go wrong before the job starts, instead of in the middle
# of a cut.  Levels:
#   error  the job will stop part way, skip moves, or cut something other
#          than what the program says.  The run is blocked unless the
#          operator overrides it.
#   warn   worth a look before running.
#   info   for the record.
#
# What the planner supports was taken from its source (CAMotics
# src/gcode/ControllerImpl.cpp, execute()), not from the G-code cheat sheet,
# which differs in places (G73 is listed as supported but runs as G81).

import os
import re
import json
import threading
import collections
import concurrent.futures

from tornado import gen

from bbctrl import GCodeText

MM = 25.4
EPS = 0.01

# Codes the planner accepts but runs as something else, or ignores, in ways
# that change what is cut
DEGRADED_G = {
    73: 'G73 (chip-breaking drill) runs as a plain G81 drill: no chip breaking',
    83: 'G83 (peck drill) runs as a plain G81 drill: one plunge to full depth, '
        'no pecking, which can snap a small bit',
    84: 'G84 (tapping) runs as a plain G81 drill',
    87: 'G87 (back boring) runs as a plain G81 drill',
    88: 'G88 (boring, manual out) runs as a plain G81 drill',
    41: 'G41 (cutter compensation) is ignored, so the cut is off by the tool radius',
    42: 'G42 (cutter compensation) is ignored, so the cut is off by the tool radius',
    41.1: 'G41.1 (cutter compensation) is ignored, so the cut is off by the tool radius',
    42.1: 'G42.1 (cutter compensation) is ignored, so the cut is off by the tool radius',
    76: 'G76 (threading cycle) is not supported',
    5: 'G5 (spline) is not supported: those moves are not made',
    5.1: 'G5.1 (spline) is not supported: those moves are not made',
    5.2: 'G5.2 (NURBS) is not supported: those moves are not made',
    5.3: 'G5.3 (NURBS) is not supported: those moves are not made',
    33: 'G33 (spindle-synchronized move) runs as a plain move',
    33.1: 'G33.1 (rigid tapping) runs as a plain move',
}
DEGRADED_M = {
    62: 'M62 (digital output) is not supported on this controller; the job '
        'stops with an error when it gets there. Use M7/M9 (Load 1) or M8/M9 (Load 2)',
    63: 'M63 (digital output) is not supported on this controller; the job '
        'stops with an error when it gets there. Use M7/M9 (Load 1) or M8/M9 (Load 2)',
    64: 'M64 (digital output) is not supported on this controller; the job '
        'stops with an error when it gets there. Use M7/M9 (Load 1) or M8/M9 (Load 2)',
    65: 'M65 (digital output) is not supported on this controller; the job '
        'stops with an error when it gets there. Use M7/M9 (Load 1) or M8/M9 (Load 2)',
}
IGNORED_M = {
    66: 'M66 (wait for input) is only partly supported (its timeout is not handled)',
    19: 'M19 (spindle orient) is ignored',
    48: 'M48 (overrides on) is ignored', 49: 'M49 (overrides off) is ignored',
    50: 'M50 (feed override control) is ignored',
    51: 'M51 (spindle override control) is ignored',
    52: 'M52 (adaptive feed) is ignored', 53: 'M53 (feed stop) is ignored',
    61: 'M61 (set current tool) is ignored',
}
DOUBTFUL_G = {
    93: 'G93 (inverse-time feed) may not run as intended on this controller, and Resume refuses it',
    95: 'G95 (feed per revolution) is not supported',
    96: 'G96 (constant surface speed) is not supported',
}
KNOWN_G = set([0, 1, 2, 3, 4, 7, 8, 10, 17, 17.1, 18, 18.1, 19, 19.1, 20, 21,
               28, 28.1, 28.2, 28.3, 30, 30.1, 38.2, 38.3, 38.4, 38.5, 38.6,
               38.7, 38.8, 38.9, 40, 43, 43.1, 43.2, 49, 52, 53, 54, 55, 56,
               57, 58, 59, 59.1, 59.2, 59.3, 61, 61.1, 64, 70, 71, 80, 81, 82,
               85, 86, 89, 90, 90.1, 91, 91.1, 92, 92.1, 92.2, 92.3, 94, 97,
               98, 99])
KNOWN_M = set([0, 1, 2, 3, 4, 5, 6, 7, 7.1, 8, 8.1, 9, 30, 60, 70, 71, 72, 73])
WCS = set([54, 55, 56, 57, 58, 59, 59.1, 59.2, 59.3])
MOTION = (0, 1, 2, 3)
MAX_LINES_LISTED = 10


def _num(v):
    v = round(float(v), 4)
    return int(v) if v == int(v) else v


def _code_name(letter, v):
    return '%s%s' % (letter, ('%g' % v))


def _stock_top(setup):
    m = re.search(r'z\s*=\s*(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)',
                  setup.get('stock', '') or '', re.I)
    if not m: return None
    try: return max(float(m.group(1)), float(m.group(2)))
    except ValueError: return None


class _Report(object):
    def __init__(self):
        self.items = {}
        self.order = []

    def add(self, key, level, line, msg):
        it = self.items.get(key)
        if it is None:
            it = self.items[key] = {'key': key, 'level': level, 'msg': msg,
                                    'lines': [], 'count': 0}
            self.order.append(key)
        it['count'] += 1
        if line is not None and len(it['lines']) < MAX_LINES_LISTED:
            it['lines'].append(line)

    def result(self):
        rank = {'error': 0, 'warn': 1, 'info': 2}
        out = [self.items[k] for k in self.order]
        out.sort(key = lambda i: rank[i['level']])
        return out


def lint_lines(lines, setup = None):
    '''Checks a program.  lines: list of strings.  setup: the setup sheet
    fields (GCodeText.setup_fields), read from lines when None.'''
    if setup is None: setup = GCodeText.setup_fields(lines[:400])
    rep = _Report()

    open_comment = False
    open_from = None
    units = None          # 'G20' / 'G21' once seen
    wcs_seen = False
    first_move = None
    metric = True
    absolute = True
    motion = None
    pos = {'X': None, 'Y': None, 'Z': None}
    tracking = True       # position known (no expressions, G91 or G53)
    untracked_from = None
    mist_on_line = None
    ended = False
    plunges = []          # (line, from_z, to_z) feed moves straight down
    rapids = []           # (line, from_z, to_z, xy_moved) rapid moves
    min_z = None
    spin_dir, spin_speed = None, 0.0
    n = 0

    for n, raw in enumerate(lines, 1):
        was_open = open_comment
        code, _, issues, open_comment = GCodeText.split(raw, open_comment)

        # Comments ------------------------------------------------------
        kinds = set(i.kind for i in issues)
        if was_open and not open_comment and open_from is not None:
            rep.add('comment-open', 'error', open_from,
                    'A comment opened on line %d is not closed until line %d. '
                    'The planner reads every line in between as comment, so '
                    'the moves on lines %d to %d are skipped.'
                    % (open_from, n, open_from + 1, n))
            open_from = None
        if 'unclosed' in kinds and open_from is None: open_from = n
        if 'nested' in kinds or 'stray' in kinds:
            rep.add('comment-nested', 'error', n,
                    'A comment has brackets inside it, like "(a (b) c)". The '
                    'planner ends a comment at the first ")" and reads the '
                    'rest as code, so the job stops with an error on this line. '
                    'Write the inner brackets as [ ] (fix it in the post '
                    'processor or the operation name).')
        if 'quote' in kinds:
            rep.add('comment-quote', 'warn', n,
                    'An apostrophe outside a comment. The planner treats it '
                    'as the start of a comment and may stop with an error.')

        text = code.strip()
        if not text or text.startswith('%'): continue
        if ended: continue

        if '#' in text or '[' in text:
            if tracking: untracked_from = n
            tracking = False
            # Expressions can still be checked for their codes below

        words = [(c.upper(), v) for c, v in GCodeText.WORD.findall(text)]
        gs = [_num(v) for c, v in words if c == 'G']
        ms = [_num(v) for c, v in words if c == 'M']
        vals = {}
        for c, v in words:
            try: vals[c] = float(v)
            except ValueError: pass

        # Codes -----------------------------------------------------------
        for g in gs:
            if g in DEGRADED_G:
                rep.add('g%s' % g, 'error', n, DEGRADED_G[g] + '.')
            elif g in DOUBTFUL_G:
                rep.add('g%s' % g, 'warn', n, DOUBTFUL_G[g] + '.')
            elif g not in KNOWN_G:
                rep.add('g%s' % g, 'warn', n,
                        '%s is not a code this controller knows. The planner '
                        'may stop with an error or ignore it.' % _code_name('G', g))
        for mc in ms:
            if mc in DEGRADED_M:
                rep.add('m%s' % mc, 'error', n, DEGRADED_M[mc] + '.')
            elif mc in IGNORED_M:
                rep.add('m%s' % mc, 'warn', n, IGNORED_M[mc] + '.')
            elif mc not in KNOWN_M:
                rep.add('m%s' % mc, 'warn', n,
                        '%s is not a code this controller knows. The planner '
                        'may stop with an error or ignore it.' % _code_name('M', mc))

        # Modal state -----------------------------------------------------
        for g in gs:
            if g in (20, 70): units, metric = 'G20', False
            elif g in (21, 71): units, metric = 'G21', True
            elif g in WCS: wcs_seen = True
            elif g == 90: absolute = True
            elif g == 91:
                absolute = False
                if tracking: untracked_from = n
                tracking = False
            elif g in MOTION: motion = g
            elif g == 80: motion = None
            elif 73 <= g <= 89: motion = g     # canned cycle: not tracked

        if 'S' in vals: spin_speed = vals['S']
        for mc in ms:
            if mc == 7: mist_on_line = mist_on_line or n
            elif mc == 9: mist_on_line = None
            elif mc in (3, 4): spin_dir = mc
            elif mc == 5: spin_dir = None
            elif mc in (2, 30): ended = True; spin_dir = None
        if any(38.15 < g < 38.55 for g in gs) and spin_dir and spin_speed:
            rep.add('probe-spindle', 'error', n,
                    'A probe move (G38) while the spindle is on (M%d S%s). '
                    'The controller refuses it and stops the job there. '
                    'Put M5 before the probe.' % (spin_dir, _fmt(spin_speed)))

        has_axes = any(a in vals for a in 'XYZ')
        if not has_axes: continue
        if first_move is None and not any(g in (28.2, 28.3, 92, 92.1, 92.2, 92.3, 10, 4)
                                          or 38 <= g < 39 for g in gs):
            first_move = n
            if units is None:
                rep.add('units', 'warn', n,
                        'No G20 or G21 before the first move, so the program '
                        'runs in the controller\'s default units (Settings > '
                        'Units). Fusion normally writes G21 or G20 at the top.')
            if not wcs_seen:
                rep.add('wcs', 'info', n,
                        'No work offset (G54 to G59) is selected before the '
                        'first move. The program runs in the active one, '
                        'normally G54, with the zero you probed.')

        # Moves -----------------------------------------------------------
        if 53 in gs or any(g in (28, 30) for g in gs):
            # Machine coordinates or a home move: work position unknown after
            for a in 'XYZ':
                if a in vals or 28 in gs or 30 in gs: pos[a] = None
            continue
        if any(38 <= g < 39 for g in gs) or any(g in (10, 92, 92.1, 92.2, 92.3, 28.2, 28.3) for g in gs):
            for a in 'XYZ':
                if a in vals: pos[a] = None
            continue
        if not tracking or motion not in MOTION: continue

        k = 1.0 if metric else MM
        new = dict(pos)
        for a in 'XYZ':
            if a in vals: new[a] = vals[a] * k
        if new['Z'] is not None: min_z = new['Z'] if min_z is None else min(min_z, new['Z'])

        if motion == 0 and None not in (pos['Z'], new['Z']):
            xy = any(a in vals and pos[a] is not None and abs(new[a] - pos[a]) > EPS
                     for a in 'XY') or any(a in vals and pos[a] is None for a in 'XY')
            rapids.append((n, pos['Z'], new['Z'], xy))
        elif motion == 1 and 'Z' in vals and pos['Z'] is not None and \
                not any(a in vals for a in 'XY') and new['Z'] < pos['Z'] - EPS:
            plunges.append((n, pos['Z'], new['Z']))
        pos = new

    if open_from is not None:
        rep.add('comment-open', 'error', open_from,
                'A comment opened on line %d is never closed. The planner reads '
                'the rest of the program as comment, so nothing after it runs.'
                % open_from)

    # Rapids and plunges, against the stock top.  The top is the sheet's
    # stock z range, or Z0 when the program cuts below Z0 (zero on the stock
    # top).  A program that never goes below Z0 without a sheet (zero on the
    # spoilboard) can't be checked this way.
    top = _stock_top(setup)
    if top is None and min_z is not None and min_z < -EPS: top = 0.0
    if top is not None:
        for line, z0, z1, xy in rapids:
            if xy and min(z0, z1) < top - EPS:
                rep.add('rapid-low', 'error', line,
                        'A rapid (G0) moves sideways at Z %s, below the stock top '
                        '(Z %s): straight through the material at full speed.'
                        % (_fmt(min(z0, z1)), _fmt(top)))
            elif not xy and z1 < top - EPS and z1 < z0 - EPS:
                rep.add('rapid-plunge', 'error', line,
                        'A rapid (G0) goes down to Z %s, below the stock top '
                        '(Z %s): a full-speed plunge into the material.'
                        % (_fmt(z1), _fmt(top)))
        for line, z0, z1 in plunges:
            if z1 < top - EPS:
                rep.add('plunge', 'warn', line,
                        'A straight plunge (G1 Z only, no ramp) into the '
                        'material, down to Z %s. Fine for a center-cutting '
                        'bit at a plunge feed; check the feed and bit if not '
                        'intended.' % _fmt(z1))
    elif rapids or plunges:
        rep.add('z-unchecked', 'info', None,
                'Rapids and plunges were not checked against the stock: the '
                'program never goes below Z0 and has no setup sheet stock '
                'line, so the stock top is not known.')

    if mist_on_line is not None:
        rep.add('mist', 'warn', mist_on_line,
                'Mist (M7) is turned on and never turned off with M9. %s'
                % ('M2/M30 at the end switches it off.' if ended else
                   'The program has no M2/M30 either, so it stays on after the job.'))
    if not ended and n:
        rep.add('no-end', 'info', None,
                'The program has no M2 or M30 at the end, so the spindle and '
                'outputs are left as the last line set them.')
    if untracked_from is not None:
        rep.add('untracked', 'info', untracked_from,
                'Moves after line %d use relative moves (G91) or expressions, '
                'so they were not checked for rapids or plunges.' % untracked_from)

    items = rep.result()
    return {
        'lines': n,
        'errors': sum(1 for i in items if i['level'] == 'error'),
        'warnings': sum(1 for i in items if i['level'] == 'warn'),
        'issues': items,
        'stock_top': top,
    }


def _fmt(v):
    s = ('%.3f' % v).rstrip('0').rstrip('.')
    return '0' if s in ('', '-0') else s


def summary(result):
    '''One sentence for the errors in a result, for an API refusal.'''
    errs = [i for i in result['issues'] if i['level'] == 'error']
    if not errs: return ''
    parts = []
    for i in errs[:3]:
        where = (' (line %s)' % ', '.join(str(x) for x in i['lines'][:3])) if i['lines'] else ''
        parts.append(i['msg'] + where)
    more = ' And %d more.' % (len(errs) - 3) if len(errs) > 3 else ''
    return ' '.join(parts) + more


# Results are kept per file until the file changes (its modification time
# or size), the most recently used CACHE_MAX files.  Up to 1.31.1 the whole
# cache was wiped when it reached 8 files, so a folder of programs was
# checked again and again.
CACHE_MAX = 32
_cache = collections.OrderedDict()  # path -> (key, result)
_inflight = {}                      # (path, key) -> Future
_lock = threading.Lock()


def _key(path):
    st = os.stat(path)
    return (st.st_mtime, st.st_size)


def _lint_path(path):
    '''The check itself (in the worker process).'''
    with open(path, 'r', encoding = 'utf-8', errors = 'replace') as f:
        lines = f.read().splitlines()
    res = lint_lines(lines)
    res['setup'] = dict((k, v) for k, v in GCodeText.setup_fields(lines[:400]).items())
    return res


def _store(path, key, res):
    with _lock:
        _cache[path] = (key, res)
        _cache.move_to_end(path)
        while len(_cache) > CACHE_MAX: _cache.popitem(last = False)


def cached(path):
    '''The result for the file as it is now, or None if it has not been
    checked since it last changed.  Raises OSError if it can't be read.'''
    key = _key(path)
    with _lock:
        hit = _cache.get(path)
        if hit and hit[0] == key:
            _cache.move_to_end(path)
            return hit[1]


def remember(path, res):
    '''Keep res (with its 'setup') as the check of the file as it is now,
    for a program the controller has just written and checked.'''
    try: _store(path, _key(path), res)
    except OSError: pass


def lint_file(path):
    '''lint_lines() for a file, cached until the file changes.  Runs in the
    calling thread: the web server uses lint_file_async().'''
    key = _key(path)
    hit = cached(path)
    if hit is not None: return hit
    res = _lint_path(path)
    _store(path, key, res)
    return res


def lint_file_async(path):
    '''lint_file() in the worker (1.31.2).  Returns a
    concurrent.futures.Future: done at once if the file was already checked,
    and shared by everyone asking for the same version of the file while it
    is being checked.  The Future fails with OSError if the file can't be
    read.'''
    from bbctrl import Work
    try:
        key = _key(path)
        hit = cached(path)
    except OSError as e:
        f = concurrent.futures.Future()
        f.set_exception(e)
        return f
    if hit is not None: return Work.done(hit)

    with _lock:
        hit = _cache.get(path)  # finished since cached() looked
        if hit and hit[0] == key: return Work.done(hit[1])
        f = _inflight.get((path, key))
        if f is not None: return f
        f = Work.run(_lint_path, path)
        _inflight[(path, key)] = f

    def finished(f):
        with _lock: _inflight.pop((path, key), None)
        try:
            if not f.cancelled() and f.exception() is None:
                _store(path, key, f.result())
        except Exception: pass

    f.add_done_callback(finished)
    return f


def in_flight():
    with _lock: return len(_inflight)


def clear_cache():
    with _lock: _cache.clear()


# Controller-side run check ----------------------------------------------
# The UI shows the full checklist.  This is the part the controller enforces
# itself, so a screen that couldn't read the program (dropped Wi-Fi) or an
# older screen can't start a job that should be stopped.

def probe_record(ctrl):
    try:
        path = os.path.join(ctrl.get_path('next-data'), 'probe.json')
        with open(path, 'r', encoding = 'utf-8') as f: return json.load(f)
    except (OSError, ValueError, TypeError): return None


def _read_stop(filename, e):
    return [{'key': 'read', 'msg': 'The controller could not read %s: %s'
             % (filename, e)}]


def start_stops(ctrl, filename):
    '''Reasons not to start filename, each {key, msg}.  Empty to go.'''
    path = ctrl.get_upload(filename)
    try: res = lint_file(path)
    except OSError as e: return _read_stop(filename, e)
    return _stops(ctrl, res)


@gen.coroutine
def start_stops_async(ctrl, filename):
    '''start_stops() with the check in the worker (1.31.2).  Fails closed:
    a check that could not run is a reason not to start, and so is a
    program that changed while it was being checked.'''
    path = ctrl.get_upload(filename)
    try:
        before = _key(path)
        res = yield lint_file_async(path)
        after = _key(path)
    except OSError as e: return _read_stop(filename, e)
    except Exception as e:
        return [{'key': 'check', 'msg': 'The controller could not check %s (%s), '
                 'so it was not started. Press Run again.' % (filename, e)}]
    if before != after:
        return [{'key': 'changed', 'msg': '%s changed while it was being '
                 'checked. Press Run again.' % filename}]
    return _stops(ctrl, res)


def _stops(ctrl, res):
    stops = []
    if res['errors']:
        stops.append({'key': 'lint', 'msg': 'G-code check: ' + summary(res)})

    want = GCodeText.norm_corner(res.get('setup', {}).get('probe-corner'))
    if want == 'flip':
        # A flip-aligned copy (1.31.0): X/Y zero must come from the flip
        # alignment, not from a corner probe
        rec = probe_record(ctrl)
        loc = rec.get('loc') if isinstance(rec, dict) else None
        if loc != 'flip':
            stops.append({'key': 'zero', 'msg':
                          'WRONG ZERO: this is a flip-aligned copy, so X/Y zero '
                          'must be the one the flip alignment set, but the last '
                          'probe was %s. Line side B up again in the Start job '
                          'wizard, then run.' % ('on the %s' % loc if loc else
                                                 'not recorded')})
    elif want in GCodeText.CORNERS:
        rec = probe_record(ctrl)
        loc = rec.get('loc') if isinstance(rec, dict) else None
        if loc and loc != want:
            stops.append({'key': 'zero', 'msg':
                          'WRONG ZERO: this program was written for zero on the '
                          '%s, but the last probe was on the %s. Probe the %s, '
                          'then run again.' % (want, loc, want)})
    return stops
