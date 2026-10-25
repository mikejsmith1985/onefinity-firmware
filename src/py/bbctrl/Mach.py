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

import bbctrl
from bbctrl.Comm import Comm
from bbctrl.CoolantHold import CoolantHold
import bbctrl.Cmd as Cmd


# Axis homing procedure:
#
#   Mark axis unhomed
#   Set feed rate to search_vel
#   Seek closed by search_dist
#   Set feed rate to latch_vel
#   Seek open latch_backoff
#   Seek closed latch_backoff * -1.5
#   Rapid to zero_backoff
#   Mark axis homed and set absolute position

axis_homing_procedure = '''
  G28.2 %(axis)s0 F[#<_%(axis)s_search_velocity>]
  G38.6 %(axis)s[#<_%(axis)s_home_travel>]
  G38.8 %(axis)s[#<_%(axis)s_latch_backoff>] F[#<_%(axis)s_latch_velocity>]
  G38.6 %(axis)s[#<_%(axis)s_latch_backoff> * -8]
  G91 G0 G53 %(axis)s[#<_%(axis)s_zero_backoff>]
  G90 G28.3 %(axis)s[#<_%(axis)s_home_position>]
'''

# The stepper drivers have a stall flag that is reset
# by moving the motors without a stall condition.
# The "wiggle" in the stall procedure is to clear the flag.
# This was to correct the issue where the stepper motors
# may already be in a stall condition when homing is started.
# For example, if a user tried to home twice in a row
# the second homing attempt would immediately think it
# was stalled if we didn't first back it up a bit
stall_homing_procedure = '''
  G91 G1 %(axis)s [#<_%(axis)s_zero_backoff>] F[#<_%(axis)s_search_velocity>]
  G4 P0.25
  G28.2 %(axis)s0 F[#<_%(axis)s_search_velocity>]
  G38.6 %(axis)s[#<_%(axis)s_home_travel>]
  G91 G1 G53 %(axis)s[#<_%(axis)s_zero_backoff>] F100
  G90 G28.3 %(axis)s[#<_%(axis)s_home_position>]
'''

motor_fault_error = '''\
Motor %d driver fault.  A potentially damaging electrical condition was \
detected and the motor driver was shutdown.  Please power down the controller \
and check your motor cabling. See the "Motor Faults" table on the "Indicators" \
for more information.\
'''

def overrides(interface_class):
    def overrider(method):
        if not method.__name__ in dir(interface_class):
            raise Exception('%s does not override %s' % (
                method.__name__, interface_class.__name__))

        return method

    return overrider


class Mach(Comm):
    def __init__(self, ctrl, avr):
        super().__init__(ctrl, avr)

        self.ctrl = ctrl
        self.mlog = self.ctrl.log.get('Mach')

        self.planner = bbctrl.Planner(ctrl)
        self.unpausing = False
        self.stopping = False

        # Mist (Load 1) is switched off while a job is paused and restored,
        # after a short delay, when the operator resumes.
        self.coolant_hold = CoolantHold(
            self._set_mist, lambda *a, **kw: self.ctrl.ioloop.call_later(*a, **kw),
            self.mlog)

        ctrl.state.set('cycle', 'idle')

        ctrl.state.add_listener(self._update)

        super().reboot()


    def _get_state(self): return self.ctrl.state.get('xx', '')
    def _is_estopped(self): return self._get_state() == 'ESTOPPED'
    def _is_holding(self): return self._get_state() == 'HOLDING'
    def _is_ready(self): return self._get_state() == 'READY'
    def _get_pause_reason(self): return self.ctrl.state.get('pr', '')
    def _get_cycle(self): return self.ctrl.state.get('cycle', 'idle')


    def _is_paused(self):
        if not self._is_holding() or self.unpausing: return False
        return self._get_pause_reason() in (
            'User pause', 'Program pause', 'Optional pause')


    def _is_resumable_pause(self):
        # A pause the operator must resume by hand.  An optional pause with
        # optional stops disabled is resumed immediately and does not count.
        if not self._is_paused(): return False
        if (self._get_pause_reason() == 'Optional pause' and
            not self.ctrl.state.get('optional_pause', False)): return False
        return True


    def _set_mist(self, on): self._i2c_set('1oa', 1 if on else 0)


    def _set_cycle(self, cycle):
        # A dry run never outlives its cycle
        if cycle == 'idle': self.planner.end_dry()
        self.ctrl.state.set('cycle', cycle)


    def _begin_cycle(self, cycle):
        current = self._get_cycle()
        if current == cycle: return # No change

        if current != 'idle':
            raise Exception('Cannot enter %s cycle while in %s cycle' %
                            (cycle, current))

        # TODO handle jogging during pause
        # if current == 'idle' or (cycle == 'jogging' and self._is_paused()):
        self.coolant_hold.cancel()
        self._set_cycle(cycle)

    
    def process_log(self, log):
        # When a probe has failed, we have to e-stop or things
        # end up in a bad state, where positions and offsets are incorrect
        if log['msg'] == 'Switch not found':
            self.estop()

    def _end_cycle(self):
        if (self._get_cycle() != 'idle' and self._is_ready()
                and not self.planner.is_busy() and not super().is_active()):
            self.planner.position_change()
            self._set_cycle('idle')
            # Offsets arrive a moment after the cycle ends
            self.ctrl.ioloop.call_later(1.5, self._remember_offsets)


    # After a restart the controller puts the work zero back when the machine
    # is homed, from axes.offset_* in the config.  The stock firmware only
    # wrote those when a Zero button was used, so a zero set by probing (or a
    # program) was lost and an older one came back.  Keep them in step with
    # the live zero whenever the machine settles idle with that axis homed.
    def _remember_offsets(self):
        try:
            state = self.ctrl.state
            if self._get_cycle() != 'idle': return
            vals = {}
            seen = getattr(self, '_zero_seen', None)
            if seen is None: seen = self._zero_seen = set()
            for axis in 'xyz':
                if not state.is_axis_homed(axis):
                    seen.discard(axis)
                    continue
                off = state.get('offset_' + axis)
                if off is None: continue
                # 0 is what every axis reads just after a restart, before the
                # restore after homing has run, so a 0 is only stored once
                # this axis has had a real zero since it was homed: then a 0
                # is a zero deliberately set exactly on machine 0 (1.29.0).
                if abs(float(off)) < 1e-9:
                    if axis not in seen: continue
                    off = 0.0
                else: seen.add(axis)
                cur = self.ctrl.config.get('offset_' + axis)
                if cur is None or abs(float(cur) - float(off)) > 0.0005:
                    vals['offset_' + axis] = float(off)
            if vals:
                self.ctrl.config.set('axes', vals)
                self.log.info('Remembered work zero for restart: %s' % vals)
        except Exception: self.log.exception('Could not remember the work zero')


    def _update(self, update):
        # Detect motor faults
        for motor in range(4):
            key = '%ddf' % motor
            if key in update and update[key] & 0x1f:
                self.mlog.error(motor_fault_error % motor)

        # Get state
        state_changed = 'xc' in update
        state = self._get_state()

        # Handle EStop
        if state_changed and state == 'ESTOPPED':
            self.planner.reset(stop = False)

        # Exit cycle if state changed to READY
        if (state_changed and self._get_cycle() != 'idle' and
            self._is_ready() and not self.planner.is_busy() and
            not super().is_active()):
            self.planner.position_change()
            self._set_cycle('idle')
            self.ctrl.ioloop.call_later(1.5, self._remember_offsets)

        # Planner stop
        if state == 'READY' and self.stopping:
            self.planner.stop()
            self.ctrl.state.set('line', 0)
            self.stopping = False

        # Unpause sync
        if state_changed and state != 'HOLDING':
            self.unpausing = False

        # Entering HOLDING state
        if state_changed and state == 'HOLDING':
            # Always flush queue after pause
            super().i2c_command(Cmd.FLUSH)
            super().resume()

        # Turn mist off while paused.  Must never interfere with pausing.
        try:
            self.coolant_hold.on_update(
                self._is_resumable_pause(),
                bool(self.ctrl.state.get('1oa', False)))
        except BaseException as e:
            self.mlog.error('Coolant hold: %s' % e)

        # Automatically unpause after seek or stop hold
        # Must be after holding commands above
        op = self.ctrl.state.get('optional_pause', False)
        pr = self._get_pause_reason()
        if ((state_changed or 'pr' in update) and self._is_holding() and
            (pr in ('Switch found', 'Switch no error', 'User stop') or
             (pr == 'Optional pause' and not op))):
            self._unpause()


    def _unpause(self):
        pause_reason = self._get_pause_reason()
        self.mlog.info('Unpause: ' + pause_reason)

        if pause_reason == 'User stop':
            self.planner.stop()
            self.ctrl.state.set('line', 0)

        else:
            # A probing move that ended without contact, from an AVR that
            # holds for it (upstream Buildbotics firmware): #5070 = 0.  The
            # firmware here doesn't, see Planner._check_seek_end() (1.31.1)
            if pause_reason == 'Switch no error': self.planner.seek_result(0)
            self.planner.restart()

        super().i2c_command(Cmd.UNPAUSE)
        self.unpausing = True


    def _i2c_block(self, block):
        super().i2c_command(block[0], block = block[1:])


    def _i2c_set(self, name, value): self._i2c_block(Cmd.set(name, value))


    @overrides(Comm)
    def comm_next(self):
        if self.planner.is_running() and not self._is_holding():
            return self.planner.next()


    @overrides(Comm)
    def comm_error(self):
        self.planner.reset()


    @overrides(Comm)
    def connect(self):
        self.planner.reset()
        super().connect()


    def _query_var(self, cmd):
        equal = cmd.find('=')
        if equal == -1:
            self.mlog.info('%s=%s' % (cmd, self.ctrl.state.get(cmd[1:])))

        else:
            name, value = cmd[1:equal], cmd[equal + 1:]

            if value.lower() == 'true': value = True
            elif value.lower() == 'false': value = False
            else:
                try:
                    value = float(value)
                except: pass

            self.ctrl.state.config(name, value)


    def mdi(self, cmd, with_limits = True):
        try:
            if not len(cmd): return
            if   cmd[0] == '$':  self._query_var(cmd)
            elif cmd[0] == '\\': super().queue_command(cmd[1:])
            else:
                self._begin_cycle('mdi')
                self.planner.mdi(cmd, with_limits)
                super().resume()
        except BaseException as err:
            # Every screen shows it (1.29.0).  Before, a refused command was
            # only logged, so a probe sent while the machine was busy looked
            # as if it had been accepted.
            self.mlog.error('Command refused: %s' % err)

    def set(self, code, value):
        super().queue_command('${}={}'.format(code, value))


    def jog(self, axes):
        self._begin_cycle('jogging')
        self.planner.position_change()

        # Tool setter guard (1.34.0): a velocity jog has no end point to
        # check, so the parts of it heading into the setter are zeroed early
        # enough to stop short, and re-checked while the jog runs.
        self._jog_want = dict(axes)
        send = self._guard_jog(axes)
        self._jog_sent = send
        super().queue_command(Cmd.jog(send))
        self._jog_watch()


    def _guard_jog(self, axes):
        guard = getattr(self.ctrl, 'setter_guard', None)
        if guard is None: return axes
        try: send, reason = guard.filter_jog(axes)
        except Exception:
            self.mlog.exception('Tool setter guard: jog check failed')
            return axes
        if reason and not getattr(self, '_jog_warned', False):
            self._jog_warned = True
            self.mlog.warning(
                'Tool setter guard: jog stopped short of the tool setter. '
                + ('Raise Z to move over it.' if reason == 'xy' else
                   'Lowering Z here would hit it.'))
        return send


    def _jog_watch(self):
        timer = getattr(self, '_jog_timer', None)
        if timer is not None:
            self.ctrl.ioloop.remove_timeout(timer)
            self._jog_timer = None

        want = getattr(self, '_jog_want', {}) or {}
        if not any(want.get(a, 0) or want.get(a.upper(), 0) for a in 'xyzabc'):
            self._jog_warned = False
            return

        def tick():
            self._jog_timer = None
            if self._get_cycle() != 'jogging': return
            send = self._guard_jog(self._jog_want)
            if send != self._jog_sent:
                self._jog_sent = send
                super(Mach, self).queue_command(Cmd.jog(send))
            self._jog_watch()

        self._jog_timer = self.ctrl.ioloop.call_later(0.1, tick)


    def home(self, axis, position = None):
        state = self.ctrl.state

        if axis is None:
            is_rotary_active = state.get('2an', None) == 3 
            axes = 'zxybc' if is_rotary_active else 'zxyabc' # TODO This should be configurable
        else: axes = '%c' % axis

        for axis in axes:
            enabled = state.is_axis_enabled(axis)
            mode = state.axis_homing_mode(axis)

            # If this is not a request to home a specific axis and the
            # axis is disabled or in manual homing mode, don't show any
            # warnings
            if 1 < len(axes) and (not enabled or mode == 'manual'):
                continue

            # Error when axes cannot be homed
            reason = state.axis_home_fail_reason(axis)
            if reason is not None:
                self.mlog.error('Cannot home %s axis: %s' % (
                    axis.upper(), reason))
                continue

            if mode == 'manual':
                if position is None: raise Exception('Position not set')
                self.mdi('G28.3 %c%f' % (axis, position))
                continue

            # Home axis
            self.mlog.info('Homing %s axis' % axis)
            self._begin_cycle('homing')

            if mode.startswith('stall-'): procedure = stall_homing_procedure
            else: procedure = axis_homing_procedure

            gcode = procedure % {'axis': axis}

            self.planner.mdi(gcode, False)
            super().resume()


    def unhome(self, axis): self.mdi('G28.2 %c0' % axis)
    def estop(self):
        self.coolant_hold.cancel()
        super().estop()


    def clear(self):
        if self._is_estopped():
            self.planner.reset()
            super().clear()


    def _check_dry_lift(self, lift):
        try: lift = float(lift)
        except (TypeError, ValueError): raise Exception('Bad dry run lift')
        if not 5 <= lift <= 100:
            raise Exception('Dry run lift must be between 5 and 100 mm')
        if not self.ctrl.state.is_axis_homed('z'):
            raise Exception('Home the machine before a dry run so the Z '
                            'limit is known')
        return lift


    def start(self, dry_lift = 0, dry_path = None, dry_note = ''):
        filename = self.ctrl.state.get('selected', '')
        if not filename: return
        if dry_lift: dry_lift = self._check_dry_lift(dry_lift)
        self._begin_cycle('running')
        self.planner.load(filename, dry_lift, dry_path if dry_lift else None)
        if dry_lift and dry_note: self.ctrl.state.set('dry_note', dry_note)
        super().resume()


    def step(self):
        raise Exception('NYI') # TODO
        if self._get_cycle() != 'running': self.start()
        else: super().i2c_command(Cmd.UNPAUSE)


    def stop(self):
        self.coolant_hold.cancel()
        if self._get_state() != 'jogging': self.stopping = True
        super().i2c_command(Cmd.STOP)
        
    def pause(self): super().pause()


    def unpause(self):
        if self._is_paused():
            self.ctrl.state.set('optional_pause', False)
            self.coolant_hold.resume(self._unpause)


    def optional_pause(self, enable = True):
        self.ctrl.state.set('optional_pause', enable)


    def set_position(self, axis, position, set_config = None):
        axis = axis.lower()
        state = self.ctrl.state

        if state.is_axis_homed(axis):
            # If homed, change the offset rather than the absolute position
            self.mdi('G92%s%f' % (axis, position))

            #storing the offset to config
            if set_config is not None:
                self.ctrl.config.set('axes', {'offset_' + axis : state.get(axis + 'p')})
                self.log.info('set_position: {} = {} '.format(axis, state.get(axis + 'p')))

        elif state.is_axis_enabled(axis):
            if self._get_cycle() != 'idle' and not self._is_paused():
                raise Exception('Cannot set position during ' +
                                self._get_cycle())

            # Set the absolute position both locally and via the AVR
            target = position + state.get('offset_' + axis)
            state.set(axis + 'p', target)
            super().queue_command(Cmd.set_axis(axis, target))


    def override_feed(self, override):
        self._i2c_set('fo', int(1000 * override))


    def override_speed(self, override):
        self._i2c_set('so', int(1000 * override))


    def modbus_read(self, addr): self._i2c_block(Cmd.modbus_read(addr))


    def modbus_write(self, addr, value):
        self._i2c_block(Cmd.modbus_write(addr, value))
