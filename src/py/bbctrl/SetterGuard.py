################################################################################
#                                                                              #
#                 Tool setter guard (1.34.0)                                   #
#                                                                              #
################################################################################
#
# Keeps every move clear of a tool setter fixed to the table.  The setter is a
# vertical column: a circle on the table (center and keep-out radius, saved on
# the Tool setter screen) up to the setter's top.  A move is refused if the
# cutter would pass through that column below the top.
#
# Where it applies:
#   - Planner: every planned line (programs, MDI, step jogs, macros, probing)
#     is checked before it is sent to the motion board.  The routines that
#     touch the setter on purpose (Measure tool, reference, calibration) and
#     homing are exempt.
#   - Velocity jogs (hold-to-jog, gamepad): the jog is stopped early enough to
#     stop short of the column, allowing for the 250 ms position reports and
#     the machine's own deceleration.
#
# Nothing here is specific to one machine: the position, radius, cutter
# allowance, clearance and the installed/removed switch are all settings,
# stored with the rest of the tool setter settings in the prefs document.
#
# Height of the top, in machine Z:
#   - With a valid reference (taken with a tool whose Z zero was right, and Z
#     zero unchanged since), the top is the reference's work Z plus the
#     current Z offset.  This follows the tool in the spindle.
#   - Without one, the guard can't know how long the tool is, so it only
#     counts the move as safe when the spindle is within "safe_drop" mm of the
#     top of Z travel.
################################################################################

import json
import math
import os
import time


DEFAULTS = {
    'keep':      30.0,   # keep-out radius from the saved center, mm
    'allow':     3.2,    # extra for the cutter's radius, mm
    'safe_drop': 5.0,    # without a reference: safe within this of Z max, mm
    'z_margin':  2.0,    # clearance kept above the setter's top, mm
}

# Velocity jog: position reports are up to 250 ms old, the watcher runs every
# 100 ms and the command needs a moment to reach the motion board.
JOG_LATENCY = 0.45   # s
JOG_SLACK   = 2.0    # mm
REF_TOL     = 0.01   # mm, Z offset change that invalidates the reference


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and \
        math.isfinite(v)


def settings_from_prefs(prefs):
    '''The guard's settings from the prefs document (or None).'''
    s = (prefs or {}).get('setter') if isinstance(prefs, dict) else None
    if not isinstance(s, dict) or not _num(s.get('x')) or not _num(s.get('y')):
        return None

    out = {'x': float(s['x']), 'y': float(s['y']),
           'installed': s.get('installed', True) is not False,
           'ref': s.get('ref') if isinstance(s.get('ref'), dict) else None}

    for key, dflt in DEFAULTS.items():
        v = s.get({'safe_drop': 'safeDrop', 'z_margin': 'zMargin'}.get(key, key))
        out[key] = float(v) if _num(v) and v >= 0 else dflt

    if out['keep'] <= 0: out['keep'] = DEFAULTS['keep']
    return out


def limit_z(cfg, offset_z, z_max):
    '''Machine Z below which the spindle is low enough to hit the setter.

    Returns (z, how): how is "ref" or "top".  z is None when Z travel isn't
    known (not homed), then the guard can't judge height.'''
    ref = cfg.get('ref')
    if ref and _num(ref.get('ref')) and _num(ref.get('offZ')) and \
            _num(offset_z) and abs(offset_z - ref['offZ']) <= REF_TOL:
        return ref['ref'] + offset_z + cfg['z_margin'], 'ref'

    if not _num(z_max): return None, 'top'
    return z_max - cfg['safe_drop'], 'top'


def segment_hits(p, q, cx, cy, r, zlim):
    '''Does the straight move p -> q pass within r of (cx, cy) while below
    zlim?  p and q are (x, y, z).  Returns the lowest Z inside the column, or
    None when the move is clear.'''
    px, py, pz = p
    dx, dy, dz = q[0] - px, q[1] - py, q[2] - pz
    ox, oy = px - cx, py - cy

    # Interval of t in [0, 1] where the XY distance is under r
    a = dx * dx + dy * dy
    b = 2 * (ox * dx + oy * dy)
    c = ox * ox + oy * oy - r * r

    if a < 1e-12:
        if c >= 0: return None
        t0, t1 = 0.0, 1.0
    else:
        disc = b * b - 4 * a * c
        if disc <= 0: return None
        s = math.sqrt(disc)
        t0, t1 = (-b - s) / (2 * a), (-b + s) / (2 * a)
        t0, t1 = max(t0, 0.0), min(t1, 1.0)
        if t1 <= t0: return None

    # Lowest Z over that interval (Z changes linearly)
    z0, z1 = pz + dz * t0, pz + dz * t1
    low = min(z0, z1)
    return low if low < zlim else None


def leaving_ok(p, q, cx, cy, zlim):
    '''Starting inside the column (from before the guard was on, or the end of
    a setter routine): allow a move that only goes up and away.'''
    dx, dy, dz = q[0] - p[0], q[1] - p[1], q[2] - p[2]
    if dz < -1e-9: return False
    if abs(dx) < 1e-9 and abs(dy) < 1e-9: return True
    # XY distance never shrinks along the move (it is convex in t)
    return (p[0] - cx) * dx + (p[1] - cy) * dy >= 0


class SetterGuard(object):
    def __init__(self, ctrl):
        self.ctrl = ctrl
        self.log = ctrl.log.get('SetterGuard')
        self._cfg = None
        self._mtime = None
        self._checked = 0
        self.reload()


    # Settings ------------------------------------------------------------
    def _path(self):
        try: return os.path.join(self.ctrl.get_path('next-data'), 'prefs.json')
        except Exception: return None


    def reload(self):
        self._checked = 0
        self._mtime = None
        self.settings()


    def settings(self):
        '''Current settings, re-read when the prefs file changes (at most
        once a second).'''
        now = time.time()
        if now - self._checked < 1: return self._cfg
        self._checked = now

        path = self._path()
        try: mtime = os.path.getmtime(path) if path else None
        except OSError: mtime = None
        if mtime == self._mtime: return self._cfg
        self._mtime = mtime

        prefs = None
        if mtime is not None:
            try:
                with open(path, 'r', encoding = 'utf-8') as f: prefs = json.load(f)
            except (ValueError, OSError) as e:
                self.log.warning('Could not read the tool setter settings: %s' % e)

        self._cfg = settings_from_prefs(prefs)
        return self._cfg


    # Machine state -------------------------------------------------------
    def _homed(self):
        state = self.ctrl.state
        return all(state.is_axis_homed(a) for a in 'xyz')


    def zone(self):
        '''(cx, cy, r, zlim, how) in machine mm, or None when the guard is
        off: no setter saved, marked removed, or the machine not homed.'''
        cfg = self.settings()
        if cfg is None or not cfg['installed'] or not self._homed():
            return None

        state = self.ctrl.state
        zmax = state.get_soft_limit_vector('tm', math.inf).get('z', math.inf)
        zmin = state.get_soft_limit_vector('tn', -math.inf).get('z', -math.inf)
        if not (zmin < zmax and math.isfinite(zmax)): zmax = None

        zlim, how = limit_z(cfg, state.get('offset_z', None), zmax)
        if zlim is None: return None
        return cfg['x'], cfg['y'], cfg['keep'] + cfg['allow'], zlim, how


    # Planned moves -------------------------------------------------------
    def check_line(self, start, target):
        '''Raise RuntimeError if the planned move start -> target (machine
        mm, dicts of axes) would hit the setter.'''
        z = self.zone()
        if z is None: return
        cx, cy, r, zlim, how = z

        def pt(d, base):
            return tuple(float(d.get(a, d.get(a.upper(), base.get(a, 0)))) for a in 'xyz')

        p = pt(start, {})
        q = pt(target, dict(zip('xyz', p)))

        inside = math.hypot(p[0] - cx, p[1] - cy) < r and p[2] < zlim
        if inside and leaving_ok(p, q, cx, cy, zlim): return

        low = segment_hits(p, q, cx, cy, r, zlim)
        if low is None and not inside: return

        raise RuntimeError(self.message(q, low if low is not None else p[2],
                                        zlim, how))


    def message(self, q, low, zlim, how):
        if how == 'ref':
            why = ('the setter\'s top (from the current reference) plus '
                   'clearance is at machine Z %.1f' % zlim)
        else:
            why = ('there is no current setter reference, so a move there '
                   'is only safe with the spindle within %.0f mm of the top '
                   'of Z (machine Z %.1f or higher)'
                   % (self.settings()['safe_drop'], zlim))
        return ('Tool setter guard: move refused.  It would take the cutter '
                'into the tool setter\'s keep-out area as low as machine Z '
                '%.1f, and %s.  Nothing past this point was sent.  Raise Z '
                'first, move the stock or the program, or mark the setter '
                'removed on the Tool setter screen.' % (low, why))


    # Velocity jog --------------------------------------------------------
    def _axis_limits(self, axis):
        state = self.ctrl.state
        motor = state.find_motor(axis)
        if motor is None: return None
        vm = state.get('%dvm' % motor, None)   # m/min
        am = state.get('%dam' % motor, None)   # km/min^2
        jm = state.get('%djm' % motor, None)   # km/min^3
        if not _num(vm) or vm <= 0: return None
        v = vm * 1000 / 60
        a = am * 1e6 / 3600 if _num(am) and am > 0 else 500.0
        j = jm * 1e9 / 216000 if _num(jm) and jm > 0 else 5000.0
        return v, a, j


    @staticmethod
    def stopping(v, a, j):
        '''Distance to stop from v (mm/s), with the latency allowance.'''
        if v <= 0: return 0
        return v * JOG_LATENCY + v * v / (2 * a) + v * a / (2 * j) + JOG_SLACK


    def filter_jog(self, axes, position = None):
        '''Velocity jog request (fractions of each axis' max velocity) ->
        (axes to send, reason or None).  Components that would carry the
        cutter into the column are zeroed.'''
        z = self.zone()
        if z is None: return axes, None
        cx, cy, r, zlim, how = z

        pos = position or self.ctrl.state.get_position()
        if not all(a in pos for a in 'xyz'): return axes, None
        px, py, pz = pos['x'], pos['y'], pos['z']

        def frac(a):
            v = axes.get(a, axes.get(a.upper(), 0)) or 0
            try: return float(v)
            except (TypeError, ValueError): return 0.0

        lims = dict((a, self._axis_limits(a)) for a in 'xyz')
        vel = {}
        for a in 'xyz':
            vel[a] = frac(a) * (lims[a][0] if lims[a] else 0)

        out = dict(axes)
        reason = None
        d = math.hypot(px - cx, py - cy)

        def zero(*names):
            for n in names:
                if n in out: out[n] = 0
                if n.upper() in out: out[n.upper()] = 0

        # XY: moving toward the column while low
        vx, vy = vel['x'], vel['y']
        if (vx or vy) and pz < zlim + JOG_SLACK:
            if d > 1e-9:
                closing = -((px - cx) * vx + (py - cy) * vy) / d   # mm/s toward center
            else: closing = math.hypot(vx, vy)
            if closing > 0:
                lx = lims['x'] or lims['y']; ly = lims['y'] or lims['x']
                acc = min(lx[1], ly[1]) if lx and ly else 500.0
                jrk = min(lx[2], ly[2]) if lx and ly else 5000.0
                if d - r <= self.stopping(closing, acc, jrk):
                    zero('x', 'y')
                    reason = 'xy'

        # Z down over (or at the edge of) the column
        vz = vel['z']
        if vz < 0 and d < r + JOG_SLACK and lims['z']:
            if pz - zlim <= self.stopping(-vz, lims['z'][1], lims['z'][2]):
                zero('z')
                reason = reason or 'z'

        return out, reason
