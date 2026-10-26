#!/usr/bin/env python3

################################################################################
#                                                                              #
#   Power plugs for the router and the shop vac (Onefinity fork, 1.35.0).     #
#                                                                              #
#   Two Shelly Wi-Fi plugs (Gen2 or later RPC: Plug US Gen4 tested) switch    #
#   the Makita router and the shop vac.  The router follows the program's     #
#   spindle commands (M3 on, M5 off) and the vac runs while a program runs.   #
#   Both go off at the end of the program, on Stop, on E-stop and while a     #
#   job is paused.                                                             #
#                                                                              #
#   Fail-safe: a plug is never just switched on.  Every "on" carries the      #
#   plug's own auto-off timer (toggle_after), and the controller re-sends it  #
#   every few seconds while the plug should stay on.  If the controller stops #
#   talking to a plug for any reason (Wi-Fi drop, crash, power loss), the     #
#   plug switches itself off when the timer runs out.  Losing contact with    #
#   the router plug during a job pauses the job.                              #
#                                                                              #
#   The HTTP requests run on one thread per plug so that a plug that does not #
#   answer never holds up the controller or the other plug.  Everything else #
#   runs on the controller's IO loop.                                          #
#                                                                              #
################################################################################

import json
import os
import threading
import time
import urllib.request


HEARTBEAT = 3.0  # s between re-arms (and status reads when idle)
FAILSAFE = 15    # s the plug stays on without hearing from the controller
LOST = 8.0       # s without an answer before an "on" plug counts as lost
CONFIRM = 2.5    # s for the router plug to confirm "on" before the job pauses
TIMEOUT = 2.0    # s per HTTP request

NAMES = ('router', 'vac')
DEFAULTS = {'ip': '', 'auto': False}


def clamp(v, lo, hi, default):
    try: v = float(v)
    except (TypeError, ValueError): return default
    return min(hi, max(lo, v))


class PlugLink(threading.Thread):
    '''Talks to one plug.  want(True/False/None) sets what the plug should be:
    on (re-armed every HEARTBEAT), off (switched off, then just watched), or
    None (only watched).  Every answer, or failure, is handed to report() on
    the IO loop.'''

    def __init__(self, name, post, report, opener = None):
        super().__init__(daemon = True, name = 'plug-' + name)
        self.name = name
        self.post = post          # post(fn, *args): run fn on the IO loop
        self.report = report      # report(name, ok, status, err)
        self.opener = opener or self._http
        self.ip = ''
        self.target = None        # True, False or None
        self.off_sent = True      # The last "off" has been accepted
        self.cv = threading.Condition()
        self.closed = False


    def _http(self, url):
        with urllib.request.urlopen(url, timeout = TIMEOUT) as r:
            return json.loads(r.read().decode('utf-8'))


    def set_ip(self, ip):
        with self.cv:
            self.ip = (ip or '').strip()
            self.cv.notify()


    def want(self, on):
        with self.cv:
            if on is False and self.target is not False: self.off_sent = False
            self.target = on
            self.cv.notify()


    def close(self):
        with self.cv:
            self.closed = True
            self.cv.notify()


    def _rpc(self, ip, q): return self.opener('http://%s/rpc/%s' % (ip, q))


    def run(self):
        while True:
            with self.cv:
                if self.closed: return
                ip, target, off_sent = self.ip, self.target, self.off_sent

            if ip:
                ok, status, err = True, None, None
                try:
                    if target is True:
                        self._rpc(ip, 'Switch.Set?id=0&on=true&toggle_after=%d'
                                  % FAILSAFE)
                    elif target is False and not off_sent:
                        self._rpc(ip, 'Switch.Set?id=0&on=false')
                        with self.cv:
                            if self.target is False: self.off_sent = True
                    status = self._rpc(ip, 'Switch.GetStatus?id=0')
                except Exception as e:
                    ok, err = False, str(e) or e.__class__.__name__

                self.post(self.report, self.name, ok, status, err)

            with self.cv:
                if self.closed: return
                # Wake early for a change, otherwise heartbeat
                if (self.ip, self.target, self.off_sent) == \
                        (ip, target, off_sent) or not self.ip:
                    self.cv.wait(HEARTBEAT)


class Plugs(object):
    def __init__(self, ctrl, links = None, clock = time.monotonic):
        self.ctrl = ctrl
        self.log = ctrl.log.get('Plugs')
        self.clock = clock

        self.prefs = {'router': dict(DEFAULTS), 'vac': dict(DEFAULTS),
                      'spinup': 4.0, 'vacAfter': 5.0}
        self.spindle = False   # The program has the router on (M3 executed)
        self.manual = {'router': False, 'vac': False} # On from the screen
        self.job = False       # A real (not dry) program is running
        self.vac_hang = False  # Vac running on after the job, to clear the hose
        self.vac_token = 0
        self.paused = False    # Job paused: everything off
        self.resuming = None   # (proceed, token) while the router spins up
        self.released = False  # Resumed; the machine has not left the hold yet
        self.res_token = 0
        self.estopped = False

        self.want = {'router': None, 'vac': None}
        self.last_ok = {'router': None, 'vac': None}
        self.on_since = {'router': None, 'vac': None} # want=True since
        self.output = {'router': None, 'vac': None}
        self.lost_said = {'router': False, 'vac': False}
        self.confirm_token = 0

        post = lambda fn, *a: ctrl.ioloop.ioloop.add_callback(fn, *a)
        if links is None:
            links = {}
            for name in NAMES:
                links[name] = PlugLink(name, post, self._report)
                links[name].start()
        self.links = links

        self.reload()
        self._tick()


    # Settings ---------------------------------------------------------------
    def _prefs_path(self):
        return os.path.join(self.ctrl.get_path('next-data'), 'prefs.json')


    def reload(self):
        try:
            with open(self._prefs_path(), 'r', encoding = 'utf-8') as f:
                p = json.load(f).get('plugs') or {}
        except Exception: p = {}

        for name in NAMES:
            q = p.get(name) if isinstance(p.get(name), dict) else {}
            self.prefs[name] = {'ip': str(q.get('ip', '') or '').strip(),
                                'auto': bool(q.get('auto', False))}
            self.links[name].set_ip(self.prefs[name]['ip'])
        self.prefs['spinup'] = clamp(p.get('spinup'), 0, 30, 4.0)
        self.prefs['vacAfter'] = clamp(p.get('vacAfter'), 0, 120, 5.0)
        self._apply()


    def active(self, name):
        '''The controller switches this plug: it has an address and Auto on.'''
        p = self.prefs[name]
        return bool(p['ip']) and p['auto']


    def _tool_is_router(self):
        try: sel = str(self.ctrl.config.get('selected-tool', '') or '').lower()
        except Exception: sel = ''
        return sel not in ('laser', 'pwm') # router, disabled, VFDs: the router plug


    def router_auto(self):
        '''Programs switch the router through its plug.'''
        return self.active('router') and self._tool_is_router()


    def spinup(self): return self.prefs['spinup']


    def online(self, name):
        t = self.last_ok[name]
        return t is not None and self.clock() - t < LOST


    # What each plug should be ----------------------------------------------
    def _compute(self):
        want = {}
        quiet = self.estopped or (self.paused and self.resuming is None)
        for name in NAMES:
            if not self.active(name): want[name] = None; continue
            if quiet: want[name] = False; continue
            if name == 'router':
                on = (self.spindle and self._tool_is_router()) or \
                    self.manual['router']
            else: on = self.job or self.vac_hang or self.manual['vac']
            want[name] = bool(on)
        return want


    def _apply(self):
        want = self._compute()
        now = self.clock()
        for name in NAMES:
            if want[name] != self.want[name]:
                self.log.info('%s plug: %s' % (name.capitalize(),
                    {True: 'on', False: 'off', None: 'not switched'}[want[name]]))
                self.on_since[name] = now if want[name] else None
                self.lost_said[name] = False
            self.want[name] = want[name]
            self.links[name].want(want[name])
        self._publish()


    def _publish(self):
        st = self.ctrl.state
        for name in NAMES:
            if not self.prefs[name]['ip']: s = 'unset'
            elif not self.online(name): s = 'offline'
            else: s = 'on' if self.output[name] else 'off'
            if st.vars.get('plug_' + name) != s: st.set('plug_' + name, s)
            auto = self.active(name)
            if st.vars.get('plug_%s_auto' % name) != auto:
                st.set('plug_%s_auto' % name, auto)


    # Answers from the plugs -------------------------------------------------
    def _report(self, name, ok, status, err):
        if ok:
            self.last_ok[name] = self.clock()
            try:
                self.output[name] = bool(status.get('output'))
                w = round(float(status.get('apower', 0) or 0))
            except Exception: w = 0
            if self.ctrl.state.vars.get('plug_%s_w' % name) != w:
                self.ctrl.state.set('plug_%s_w' % name, w)
            if self.lost_said[name]:
                self.log.info('%s plug answering again' % name.capitalize())
                self.lost_said[name] = False
        elif self.want[name]:
            self.log.debug('%s plug: %s' % (name, err))
        self._publish()


    def _tick(self):
        '''Every second: notice a plug that should be on but went quiet.'''
        try: self._check_lost()
        except Exception: self.log.exception('Plug check')
        self._publish()
        self.ctrl.ioloop.call_later(1.0, self._tick)


    def _check_lost(self):
        now = self.clock()
        for name in NAMES:
            if not self.want[name] or self.lost_said[name]: continue
            since = max(self.on_since[name] or now, self.last_ok[name] or 0)
            if now - since < LOST: continue
            self.lost_said[name] = True
            if name == 'router' and self._running():
                self.log.error('Lost contact with the Router plug, so the job '
                               'was paused. The plug switches itself off '
                               'within %d s.' % FAILSAFE)
                self._pause_job()
            else:
                self.log.warning('Lost contact with the %s plug. It switches '
                                 'itself off within %d s.' %
                                 (name.capitalize(), FAILSAFE))


    def _running(self):
        return self.ctrl.state.get('cycle', 'idle') == 'running'


    def _pause_job(self):
        try: self.ctrl.mach.pause()
        except Exception: self.log.exception('Could not pause the job')


    # Events from the controller ---------------------------------------------
    def spindle_cmd(self, on):
        '''A spindle command (M3/M4 with S > 0, or M5/S0) reached the machine.'''
        on = bool(on)
        if on == self.spindle: return
        self.spindle = on
        self._apply()
        if on and self.want['router']:
            self.confirm_token += 1
            self.ctrl.ioloop.call_later(CONFIRM, self._confirm_router,
                                        self.confirm_token, self.clock())


    def _confirm_router(self, token, since):
        if token != self.confirm_token or not self.want['router']: return
        t = self.last_ok['router']
        if t is not None and t >= since and self.output['router']: return
        self.lost_said['router'] = True
        self.log.error('The Router plug did not confirm it switched on, so '
                       'the job was paused before cutting. Check the plug '
                       '(%s) and press Continue.' % self.prefs['router']['ip'])
        self._pause_job()


    def job_start(self, dry):
        self.job = not dry
        self.manual['router'] = False
        self.vac_token += 1
        self.vac_hang = False
        self._apply()


    def job_end(self):
        '''The program ended or was stopped: router off, vac runs on a little.'''
        was = self.job
        self.job = False
        self.spindle = False
        self.paused = False
        self.resuming = None
        self.released = False
        if was and self.prefs['vacAfter'] > 0 and not self.estopped:
            self.vac_hang = True
            self.vac_token += 1
            self.ctrl.ioloop.call_later(self.prefs['vacAfter'],
                                        self._vac_done, self.vac_token)
        self._apply()


    def _vac_done(self, token):
        if token != self.vac_token: return
        self.vac_hang = False
        self._apply()


    def stop(self):
        self.spindle = False
        self.manual['router'] = False
        self.resuming = None
        self._apply()


    def estop(self, on = True):
        if on == self.estopped: return
        self.estopped = on
        if on:
            self.spindle = False
            self.manual = {'router': False, 'vac': False}
            self.job = self.vac_hang = False
            self.paused = False
            self.resuming = None
            self.released = False
            self.vac_token += 1
            self.log.info('E-stop: router and vac plugs off')
        self._apply()


    def on_update(self, paused):
        '''Every state update: paused is a pause the operator resumes from.'''
        if self.resuming is not None: return # Spinning back up
        if self.released:
            # Continue was pressed and the plugs are back on.  The hold ends
            # a moment later (after the mist delay), so ignore it until then.
            if paused: return
            self.released = False
        if paused != self.paused:
            self.paused = paused
            if paused and (self.want['router'] or self.want['vac']):
                self.log.info('Pause: router and vac plugs off')
            self._apply()


    def resume(self, proceed):
        '''The operator pressed Continue.  Bring the router back up to speed
        before the machine moves.  proceed() runs once it is safe.'''
        if self.resuming is not None: return # Repeated clicks
        if not self.paused:
            proceed()
            return

        router = self.active('router') and self._tool_is_router() and \
            (self.spindle or self.manual['router'])
        self.res_token += 1
        self.resuming = (proceed, self.res_token)
        self._apply()
        if not router:
            self._resumed(self.res_token)
            return

        self.log.info('Resume: router plug on, waiting %.1f s' % self.spinup())
        start = self.clock()
        self.ctrl.ioloop.call_later(CONFIRM, self._resume_check,
                                    self.res_token, start)


    def _resume_check(self, token, start):
        if self.resuming is None or self.resuming[1] != token: return
        t = self.last_ok['router']
        if t is None or t < start or not self.output['router']:
            self.resuming = None
            self.log.error('Not resumed: the Router plug (%s) did not confirm '
                           'it switched on. Check it and press Continue again.'
                           % self.prefs['router']['ip'])
            self._apply()
            return
        rest = max(0, self.spinup() - (self.clock() - start))
        self.ctrl.ioloop.call_later(rest, self._resumed, token)


    def _resumed(self, token):
        if self.resuming is None or self.resuming[1] != token: return
        proceed = self.resuming[0]
        self.resuming = None
        self.paused = False
        self.released = True
        self._apply()
        proceed()


    def set_manual(self, name, on):
        if name not in NAMES: raise ValueError('Unknown plug')
        if not self.active(name):
            raise ValueError('Turn on Auto for the %s plug in Settings first'
                             % name)
        if on and self.estopped:
            raise ValueError('Clear the E-stop first')
        if not on and name == 'router' and self.spindle:
            # Off from the screen also cancels the program's M3.  Never let
            # the machine go on cutting with the router stopped.
            self.spindle = False
            if self._running():
                self.log.warning('Router switched off from the screen: job '
                                 'paused')
                self._pause_job()
        self.manual[name] = bool(on)
        self._apply()


    def close(self):
        for link in self.links.values(): link.close()
