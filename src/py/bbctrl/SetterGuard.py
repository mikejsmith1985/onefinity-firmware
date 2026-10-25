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
# 100 ms, and the motion board runs its queue 250 ms behind (EXEC_DELAY).
# 1.34.4: 0.45 s was too short on the machine; 0.8 s covers the sum with room.
JOG_LATENCY = 0.8    # s
JOG_MARGIN  = 1.25   # on the braking distance itself
JOG_SLACK   = 2.0    # mm
# 1.34.5: the motion board fence.  A jog toward the setter gets a temporary
# soft limit just outside the square around the keep-out circle; the motion
# board brakes against soft limits itself every 4 ms, so no Pi delay matters.
FENCE_BACK  = 1.0    # mm outside the square's face
FENCE_STALE = 0.6    # s; a moving axis is only fenced this far ahead of its reported position
REF_FORMAT  = 2      # setter.js REF_FORMAT
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
    # f: reference format.  Before 1.34.3 the machine Z of the touch was stored instead of the
    # work Z, which put the setter's top far too low: those records are never used.
    if ref and ref.get('f') == REF_FORMAT and _num(ref.get('ref')) and _num(ref.get('offZ')) and \
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


def jog_fence(pos, frac, cx, cy, r, zlim):
    '''Temporary soft limits for a velocity jog (1.34.5).

    pos: machine x, y, z; frac: jog velocity fractions x, y, z.  The fence is
    the square around the keep-out circle (half side r): a fence on one axis at
    a face of the square keeps the cutter out of the circle whatever the other
    axes do, so the motion board can brake each axis on its own.  Returns
    {axis: ('min' | 'max', value)}.

    - XY, while low (or Z is coming down): the face the jog's line enters
      through gets fenced, on the axis crossing it.
    - Z, coming down over the square: Z stops at the guard height.
    A cutter already inside the square (low) gets no XY fence here; the Pi
    side stops it (filter_jog).'''
    px, py, pz = pos
    fx, fy, fz = frac
    out = {}
    low = pz < zlim + JOG_SLACK
    inside = abs(px - cx) < r and abs(py - cy) < r

    if (fx or fy) and (low or fz < 0) and not inside:
        # Slab test against the square [cx-r, cx+r] x [cy-r, cy+r]
        t_in, t_out, face = -math.inf, math.inf, None
        ok = True
        for a, p, f, c in (('x', px, fx, cx), ('y', py, fy, cy)):
            lo, hi = c - r, c + r
            if not f:
                if not (lo < p < hi): ok = False
                continue
            t1, t2 = (lo - p) / f, (hi - p) / f
            near, far = min(t1, t2), max(t1, t2)
            if near > t_in: t_in, face = near, a
            t_out = min(t_out, far)
        if ok and face and t_in <= t_out and t_in >= 0:
            f = fx if face == 'x' else fy
            c = cx if face == 'x' else cy
            out[face] = ('max', c - r - FENCE_BACK) if f > 0 else \
                ('min', c + r + FENCE_BACK)

    if fz < 0 and abs(px - cx) < r + FENCE_BACK and \
            abs(py - cy) < r + FENCE_BACK:
        out['z'] = ('min', zlim)

    return out


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
        # 1.34.4: km/min^3 -> mm/s^3 is 1e6 / 216000 (the motion board's
        # JERK_MULTIPLIER is 1e6); 1e9 made braking look 1000x quicker than it is.
        j = jm * 1e6 / 216000 if _num(jm) and jm > 0 else 5000.0
        return v, a, j


    @staticmethod
    def stopping(v, a, j):
        '''Distance to stop from v (mm/s), with the latency allowance.'''
        if v <= 0: return 0
        return v * JOG_LATENCY + JOG_MARGIN * SetterGuard.braking(v, a, j) + \
            JOG_SLACK


    @staticmethod
    def braking(v, a, j):
        '''Distance the motion board's jog S-curve takes to stop from v (mm/s)
        with no acceleration (SCurve::stoppingDist, avr/src/SCurve.cpp).  With
        the usual settings the deceleration never reaches the accel limit and
        the jerk sets it.'''
        if v <= 0: return 0
        peak = math.sqrt(v * j)
        if peak <= a: return v * math.sqrt(v / j)   # jerk-limited, triangle
        return v * v / (2 * a) + v * a / (2 * j)    # reaches the accel limit


    def jog_fence(self, axes, position = None):
        '''Temporary soft limits for this jog, see jog_fence().'''
        z = self.zone()
        if z is None: return {}
        cx, cy, r, zlim, how = z
        pos = position or self.ctrl.state.get_position()
        if not all(a in pos for a in 'xyz'): return {}

        def frac(a):
            v = axes.get(a, axes.get(a.upper(), 0)) or 0
            try: return float(v)
            except (TypeError, ValueError): return 0.0

        return jog_fence((pos['x'], pos['y'], pos['z']),
                         (frac('x'), frac('y'), frac('z')), cx, cy, r, zlim)


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

        # XY: moving toward the column while low.  The jog runs in a straight
        # line, so find where that line enters the circle and check the
        # distance to it against the stopping distance at the jog's full speed
        # (1.34.4; before, the distance straight to the edge was compared with
        # only the part of the speed aimed at the center).
        vx, vy = vel['x'], vel['y']
        speed = math.hypot(vx, vy)
        if speed > 0 and pz < zlim + JOG_SLACK:
            ux, uy = vx / speed, vy / speed
            rx, ry = px - cx, py - cy
            b = rx * ux + ry * uy            # < 0: heading toward the center
            c = rx * rx + ry * ry - r * r    # <= 0: already inside the circle
            hit = None
            if c <= 0: hit = 0.0 if b < 0 else None
            elif b < 0 and b * b - c >= 0: hit = -b - math.sqrt(b * b - c)
            if hit is not None:
                lx = lims['x'] or lims['y']; ly = lims['y'] or lims['x']
                acc = min(lx[1], ly[1]) if lx and ly else 500.0
                jrk = min(lx[2], ly[2]) if lx and ly else 5000.0
                if hit <= self.stopping(speed, acc, jrk):
                    zero('x', 'y')
                    reason = 'xy'

        # Z down over (or at the edge of) the column
        vz = vel['z']
        if vz < 0 and d < r + JOG_SLACK and lims['z']:
            if pz - zlim <= self.stopping(-vz, lims['z'][1], lims['z'][2]):
                zero('z')
                reason = reason or 'z'

        return out, reason
