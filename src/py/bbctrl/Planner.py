################################################################################
#                                                                              #
#                This file is part of the Buildbotics firmware.                #
#                                                                              #
#                  Copyright (c) 2015 - 2018, Buildbotics LLC                  #
#                             All rights reserved.                             #
#                                                                              #
#     This file ("the software") is free software: you can redistribute it     #
#     and/or modify it under the terms of the GNU General Public License,      #
#      version 2 as published by the Free Software Foundation. You should      #
#      have received a copy of the GNU General Public License, version 2       #
#     along with the software. If not, see <http://www.gnu.org/licenses/>.     #
#                                                                              #
#     The software is distributed in the hope that it will be useful, but      #
#          WITHOUT ANY WARRANTY; without even the implied warranty of          #
#      MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU       #
#               Lesser General Public License for more details.                #
#                                                                              #
#       You should have received a copy of the GNU Lesser General Public       #
#                License along with the software.  If not, see                 #
#                       <http://www.gnu.org/licenses/>.                        #
#                                                                              #
#                For information regarding this software email:                #
#                  "Joseph Coffland" <joseph@buildbotics.com>                  #
#                                                                              #
################################################################################

import json
import math
import re
import time
import os
from collections import deque
import camotics.gplan as gplan # pylint: disable=no-name-in-module,import-error
import bbctrl.Cmd as Cmd
from bbctrl.CommandQueue import CommandQueue, id_less


reLogLine = re.compile(
    r'^(?P<level>[A-Z])[0-9 ]:'
    r'((?P<file>[^:]+):)?'
    r'((?P<line>\d+):)?'
    r'((?P<column>\d+):)?'
    r'(?P<msg>.*)$')


def log_floats(o):
    if isinstance(o, float): return round(o, 2)
    if isinstance(o, dict): return {k: log_floats(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)): return [log_floats(x) for x in o]
    return o


def log_json(o): return json.dumps(log_floats(o))


class Planner():
    seek_line = None     # the last probing move sent (1.31.1)
    seek_error = True    # error flag of the last seek command

    def __init__(self, ctrl):
        self.ctrl = ctrl
        self.log = ctrl.log.get('Planner')
        self.cmdq = CommandQueue(ctrl)
        self.planner = None
        self._position_dirty = False
        self.where = ''
        self.dry_lift = 0.0   # mm. Non zero only while a dry run is planned
        self.dry_zmax = None  # highest machine Z the dry run may reach
        self.spindle = 0.0    # spindle speed as planned so far (1.29.0)
        self.mist_follow = False  # mist only during cutting moves (option)
        self.mist_wanted = False  # the program has asked for mist (M7)
        self.mist_out = False     # what this planner last set Load 1 to

        ctrl.state.add_listener(self._update)

        self.reset(stop = False)
        self._report_time()


    def is_busy(self): return self.is_running() or self.cmdq.is_active()
    def is_running(self): return self.planner.is_running()
    def position_change(self): self._position_dirty = True


    def _sync_position(self, force = False):
        if not force and not self._position_dirty: return
        self._position_dirty = False
        self.planner.set_position(self.ctrl.state.get_position())



    # Dry run ------------------------------------------------------------
    # A dry run plans the program exactly as written but sends every move to
    # the machine dry_lift mm higher, with the spindle and outputs (mist,
    # relays) blocked.  Nothing is stored on the controller, so there is no
    # offset to forget to remove: the lift exists only in the commands of
    # this one run and is dropped when the run ends.
    def begin_dry(self, lift):
        state = self.ctrl.state
        self.dry_lift = float(lift)

        zmax = state.get_soft_limit_vector('tm', math.inf).get('z', math.inf)
        zmin = state.get_soft_limit_vector('tn', -math.inf).get('z', -math.inf)
        self.dry_zmax = zmax if zmin < zmax and zmax != math.inf else None

        # The planner works one lift lower than the machine really is, so
        # that every move keeps the length the planner timed it for
        position = state.get_position()
        if 'z' in position: position['z'] -= self.dry_lift
        self.planner.set_position(position)
        self._position_dirty = True # Re-sync to the real position next time
        state.set('dry_lift', self.dry_lift)
        state.set('dry_run', True)
        self.log.info('Dry run: Z lifted %.1f mm' % self.dry_lift)


    def end_dry(self):
        if self.dry_lift: self.log.info('Dry run ended')
        self.dry_lift = 0.0
        self.dry_zmax = None
        state = self.ctrl.state
        if state.get('dry_run', False): state.set('dry_run', False)
        if state.get('dry_lift', 0): state.set('dry_lift', 0)


    def is_dry(self): return 0 < self.dry_lift


    def _dry_target(self, target):
        target = dict(target)
        for key in ('z', 'Z'):
            if key in target:
                z = target[key] + self.dry_lift
                if self.dry_zmax is not None: z = min(z, self.dry_zmax)
                target[key] = z
        return target


    # Spindle interlock (1.29.0) -------------------------------------------
    # A probing move with the spindle commanded on would spin a cutter into a
    # touch plate or a 3D probe.  The planned spindle speed is followed
    # command by command, so an M5 just before the probe in the same program
    # counts.  The probing screens send M5 first.
    def _begin_spindle(self):
        try: self.spindle = float(self.ctrl.state.get('speed', 0) or 0)
        except (TypeError, ValueError): self.spindle = 0.0


    # Mist follows cutting (1.29.0, optional, off by default) ----------------
    # With "mist only while cutting" on in Settings, M7 no longer switches the
    # mist on at once.  It is switched on at the start of each cutting move
    # (G1, G2, G3) and off at the start of each rapid (G0), and M9 or the end
    # of the program switches it off as usual.  The switch rides in the
    # command stream, so it happens exactly where the move starts.
    def _read_mist_pref(self):
        try:
            path = os.path.join(self.ctrl.get_path('next-data'), 'prefs.json')
            with open(path, 'r', encoding = 'utf-8') as f:
                return bool(json.load(f).get('mistCutting', False))
        except Exception: return False


    def _begin_mist(self, program):
        self.mist_follow = program and self._read_mist_pref()
        self.mist_wanted = False
        try: self.mist_out = bool(int(self.ctrl.state.get('1oa', 0) or 0))
        except (TypeError, ValueError): self.mist_out = False


    def _mist_for_line(self, block):
        if not self.mist_follow or self.is_dry(): return None
        want = self.mist_wanted and not block.get('rapid', False) \
            and not block.get('seeking', False)
        if want == self.mist_out: return None
        self.mist_out = want
        return Cmd.output('mist', 1 if want else 0)


    def get_config(self, mdi, with_limits):
        state = self.ctrl.state
        config = self.ctrl.config
        is_pwm = config.get('tool-type') == 'PWM Spindle'
        deviation = config.get('max-deviation')

        cfg = {
            # NOTE Must get current units not configured default units
            'default-units': 'METRIC' if state.get('metric') else 'IMPERIAL',
            'max-vel':   state.get_axis_vector('vm', 1000),
            'max-accel': state.get_axis_vector('am', 1000000),
            'max-jerk':  state.get_axis_vector('jm', 1000000),
            'rapid-auto-off':  config.get('rapid-auto-off') and is_pwm,
            'max-blend-error': deviation,
            'max-merge-error': deviation,
            'max-arc-error':   deviation / 10,
            'junction-accel':  config.get('junction-accel'),
        }

        # We place an upper limit of 1000 km/min^3 on jerk for MDI movements
        if mdi:
            for axis in 'xyzabc':
                if axis in cfg['max-jerk']:
                    cfg['max-jerk'][axis] = min(1000 * 1000000, cfg['max-jerk'][axis])

        if with_limits:
            minLimit = state.get_soft_limit_vector('tn', -math.inf)
            maxLimit = state.get_soft_limit_vector('tm', math.inf)

            # If max <= min then no limit
            for axis in 'xyzabc':
                if maxLimit[axis] <= minLimit[axis]:
                    minLimit[axis], maxLimit[axis] = -math.inf, math.inf

            cfg['min-soft-limit'] = minLimit
            cfg['max-soft-limit'] = maxLimit

        if not mdi:
            program_start = config.get('program-start')
            if program_start: cfg['program-start'] = program_start

        overrides = {}

        tool_change = config.get('tool-change')
        if tool_change: overrides['M6'] = tool_change

        program_end = config.get('program-end')
        if program_end: overrides['M2'] = program_end

        if overrides: cfg['overrides'] = overrides

        self.log.info('Config:' + log_json(cfg))

        return cfg


    def _update(self, update):
        if 'id' in update:
            id = update['id']
            self.planner.set_active(id) # Release planner commands
            self.cmdq.release(id)       # Synchronize planner variables

        self._check_seek_end()


    # Probing move that ends without contact (1.31.1) -----------------------
    # After a probing move (G38.2 to G38.5) the G-code interpreter waits: it
    # can't go on until it knows whether the switch was found and where the
    # machine stopped (#5070, #5061 to #5063).  The planner is told by
    # restart(), which Mach calls when the AVR holds with "Switch found".
    # When the move reaches its end without contact the AVR doesn't hold: it
    # ends the seek (seek_end() in src/avr/src/exec.c, at the end of the
    # line) and, with nothing more queued, goes READY.  For G38.2/G38.4 it
    # also reports "Switch not found", and Mach E-stops.  For G38.3/G38.5
    # (no error) nothing at all told the planner, so it waited for ever and
    # the program stopped after the move (found on a machine with 1.31.0:
    # Probe XYZ hung after the guarded move beside the block).
    #
    # Upstream Buildbotics fixed this in the AVR (a "Switch no error" hold,
    # then planner.synchronize(0) and a restart).  This does the same from
    # here, without new AVR firmware: once the AVR has executed the probing
    # move (its id), is READY and stands at the move's target, the probe
    # result is 0 (synchronize) and planning restarts from the real position,
    # exactly as after "Switch found".
    def _check_seek_end(self):
        seek = self.seek_line
        if seek is None or seek['error']: return
        state = self.ctrl.state
        if state.get('xx', '') != 'READY': return
        id = state.get('id', 0)
        if id is None or id_less(id, seek['id']): return
        if not self.planner.is_synchronizing(): return
        for axis, v in seek['target'].items():
            p = state.get(axis + 'p', None)
            if p is None or 0.05 < abs(p - v): return

        self.log.info('Probe move %d ended without contact' % seek['id'])
        if self.seek_result(0): self.restart()


    def seek_result(self, result):
        # Give the waiting interpreter the probe result: #5070 = result and
        # #5061 to #5063 = where the planner is (the target, without contact)
        self.seek_line = None
        try:
            if self.planner.is_synchronizing(): self.planner.synchronize(result)
            return True
        except Exception:
            self.log.exception('Internal error: Planner synchronize')
            self.stop()
            return False


    def _get_var_cb(self, name, units):
        value = 0

        if len(name) and name[0] == '_':
            value = self.ctrl.state.get(name[1:], 0)
            try:
                float(value)
                if units == 'IMPERIAL': value /= 25.4 # Assume metric
            except ValueError: value = 0

        self.log.info('Get: %s=%s (units=%s)' % (name, value, units))

        return value


    def _log_cb(self, line):
        line = line.strip()
        m = reLogLine.match(line)
        if not m: return

        level    = m.group('level')
        msg      = m.group('msg')
        filename = m.group('file')
        line     = m.group('line')
        column   = m.group('column')

        where = ':'.join(filter(None.__ne__, [filename, line, column]))

        if line is not None: line = int(line)
        if column is not None: column = int(column)

        if   level == 'I': self.log.info    (msg, where = where)
        elif level == 'D': self.log.debug   (msg, where = where)
        elif level == 'W': self.log.warning (msg, where = where)
        elif level == 'E': self.log.error   (msg, where = where)
        else: self.log.error('Could not parse planner log line: ' + line)


    def _add_message(self, text):
        self.ctrl.state.add_message(text)

        line = self.ctrl.state.get('line', 0)
        if 0 <= line: where = '%s:%d' % (self.where, line)
        else: where = self.where

        self.log.message(text, where = where)


    def _enqueue_set_cmd(self, id, name, value):
        self.log.info('set(#%d, %s, %s)', id, name, value)
        self.cmdq.enqueue(id, self.ctrl.state.set, name, value)


    def _report_time(self):
        # Also catches a probing move whose last update came before it ended
        try: self._check_seek_end()
        except Exception: self.log.exception('Internal error: seek check')
        state = self.ctrl.state.get('xx', '')

        if state in ('STOPPING', 'RUNNING') and self.move_start:
            delta = time.time() - self.move_start
            if self.move_time < delta: delta = self.move_time
            plan_time = self.current_plan_time + delta

            self.ctrl.state.set('plan_time', round(plan_time))

        elif state != 'HOLDING': self.ctrl.state.set('plan_time', 0)

        self.ctrl.ioloop.call_later(1, self._report_time)


    def _plan_time_restart(self):
        self.plan_time = self.ctrl.state.get('plan_time', 0)


    def _update_time(self, plan_time, move_time):
        self.current_plan_time = plan_time
        self.move_time = move_time
        self.move_start = time.time()


    def _enqueue_line_time(self, block):
        if block.get('first', False) or block.get('seeking', False): return

        # Sum move times
        move_time = sum(block['times']) / 1000 # To seconds

        self.cmdq.enqueue(block['id'], self._update_time, self.plan_time,
                          move_time)

        self.plan_time += move_time


    def _enqueue_dwell_time(self, block):
        self.cmdq.enqueue(block['id'], self._update_time, self.plan_time,
                          block['seconds'])
        self.plan_time += block['seconds']


    def __encode(self, block):
        type, id = block['type'], block['id']

        if type != 'set': self.log.info('Cmd:' + log_json(block))

        if type == 'line':
            self._enqueue_line_time(block)
            for _, sp in block.get('speeds', []) or []:
                try: self.spindle = float(sp)
                except (TypeError, ValueError): pass
            if block.get('seeking', False): self._note_seek(block)
            if self.is_dry():
                return Cmd.line(self._dry_target(block['target']),
                                block['exit-vel'], block['max-accel'],
                                block['max-jerk'], block['times'], [])

            line = Cmd.line(block['target'], block['exit-vel'],
                            block['max-accel'], block['max-jerk'],
                            block['times'], block.get('speeds', []))
            mist = self._mist_for_line(block)
            return line if mist is None else mist + '\n' + line

        if type == 'set':
            name, value = block['name'], block['value']

            if name == 'message':
                self.cmdq.enqueue(id, self._add_message, value)

            if name in ['line', 'tool']: self._enqueue_set_cmd(id, name, value)

            if name == 'speed':
                try: self.spindle = float(value)
                except (TypeError, ValueError): pass
                if self.is_dry(): value = 0 # Spindle stays off
                self._enqueue_set_cmd(id, name, value)
                return Cmd.speed(value)

            if len(name) and name[0] == '_':
                # Don't queue axis positions, can be triggered by new position
                if len(name) != 2 or name[1] not in 'xyzabc':
                    self._enqueue_set_cmd(id, name[1:], value)

            if name == '_feed': # Must come after _enqueue_set_cmd() above
                return Cmd.set_sync('if', 1 / value if value else 0)

            if name[0:1] == '_' and name[1:2] in 'xyzabc':
                if name[2:] == '_home': return Cmd.set_axis(name[1], value)

                if name[2:] == '_homed':
                    motor = self.ctrl.state.find_motor(name[1])
                    if motor is not None:
                        return Cmd.set_sync('%dh' % motor, value)

            return

        if type == 'input':
            # TODO handle timeout
            self.planner.synchronize(0) # TODO Fix this
            return Cmd.input(block['port'], block['mode'], block['timeout'])

        if type == 'output':
            if self.is_dry(): return # Mist, relays etc. stay off
            value = int(float(block['value']))
            if block['port'] == 'mist' and self.mist_follow:
                # M7 waits for the next cutting move; M9 switches off now
                self.mist_wanted = bool(value)
                if value or not self.mist_out: return
                self.mist_out = False
            return Cmd.output(block['port'], value)

        if type == 'dwell':
            self._enqueue_dwell_time(block)
            return Cmd.dwell(block['seconds'])

        if type == 'pause': return Cmd.pause(block['pause-type'])

        if type == 'seek':
            # Probe input only: homing seeks a limit switch
            if self.spindle and str(block.get('switch', '')).lower() == 'probe':
                raise RuntimeError(
                    'Probing refused: the spindle is on (S%g). A probe move '
                    'with the spindle running would spin the cutter into the '
                    'touch plate or the probe. Turn it off with M5 first.'
                    % self.spindle)
            if self.is_dry(): return # No probing in the air
            self.seek_error = bool(block['error'])
            sw = self.ctrl.state.get_switch_id(block['switch'])
            return Cmd.seek(sw, block['active'], block['error'])

        if type == 'end': return '' # Sends id

        raise Exception('Unknown planner command "%s"' % type)


    def _note_seek(self, block):
        target = block['target']
        if self.is_dry(): target = self._dry_target(target)
        # In a dry run there is no seek command: the move just ends, so it
        # is always handled as a move without contact
        self.seek_line = {
            'id': block['id'], 'error': self.seek_error and not self.is_dry(),
            'target': dict((k.lower(), float(v)) for k, v in target.items())}
        self.seek_error = True


    def _encode(self, block):
        cmd = self.__encode(block)

        if cmd is not None:
            self.cmdq.enqueue(block['id'], None)
            return Cmd.set_sync('id', block['id']) + '\n' + cmd


    def reset_times(self):
        self.move_start = 0
        self.move_time = 0
        self.plan_time = 0
        self.current_plan_time = 0


    def close(self):
        # Release planner callbacks
        if self.planner is not None:
            self.planner.set_resolver(None)
            self.planner.set_logger(None)


    def reset(self, *args, **kwargs):
        stop = kwargs.get('stop', True)
        if stop:
            self.ctrl.mach.stop()

        self.end_dry()
        self.planner = gplan.Planner()
        self.planner.set_resolver(self._get_var_cb)
        # TODO logger is global and will not work correctly in demo mode
        self.planner.set_logger(self._log_cb, 1, 'LinePlanner:3')
        self._position_dirty = True
        self.seek_line = None
        self.cmdq.clear()
        self.reset_times()

        resetState = kwargs.get('resetState', True)
        if resetState:
            self.ctrl.state.reset()


    def mdi(self, cmd, with_limits = True):
        self.where = '<mdi>'
        self.log.info('MDI:' + cmd)
        self._sync_position()
        self._begin_spindle()
        self._begin_mist(False)
        self.planner.load_string(cmd, self.get_config(True, with_limits))
        self.reset_times()


    def load(self, path, dry_lift = 0):
        self.where = path
        path = self.ctrl.get_path('upload', path)
        self.log.info('GCode:' + path)
        self.end_dry()
        self._sync_position()
        if dry_lift: self.begin_dry(dry_lift)
        self._begin_spindle()
        self._begin_mist(True)
        self.planner.load(path, self.get_config(False, True))
        self.reset_times()


    def stop(self):
        try:
            self.end_dry()
            self.seek_line = None
            self.planner.stop()
            self.cmdq.clear()

        except:
            self.log.exception('Internal error: Planner stop')
            self.reset()


    def restart(self):
        try:
            id = self.ctrl.state.get('id')
            position = self.ctrl.state.get_position()
            if self.is_dry() and 'z' in position:
                position['z'] -= self.dry_lift # Planner frame, see begin_dry()

            self.log.info('Planner restart: %d %s' % (id, log_json(position)))
            self.seek_line = None

            self.cmdq.clear()
            self.cmdq.release(id)
            self._plan_time_restart()
            self.planner.restart(id, position)

        except:
            self.log.exception('Internal error: Planner restart')
            self.stop()


    def next(self):
        try:
            while self.planner.has_more():
                cmd = self.planner.next()
                cmd = self._encode(cmd)
                if cmd is not None: return cmd

        except RuntimeError as e:
            # Pass on the planner message
            self.log.error(str(e))
            self.stop()

        except:
            self.log.exception('Internal error: Planner next')
            self.stop()
