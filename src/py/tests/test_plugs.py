# Router and vac power plugs (1.35.0).   python3 src/py/tests/test_plugs.py
import sys, os, json, tempfile, time, threading
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bbstub import check, done
import bbctrl
PL = sys.modules['bbctrl.Plugs']
import bbctrl.Cmd as Cmd
from bbctrl.Planner import Planner


# ---------------------------------------------------------------- fakes
class Clock:
    def __init__(self): self.t = 1000.0
    def __call__(self): return self.t


class Loop:
    '''Fake IO loop with a manual clock.'''
    def __init__(self, clock):
        self.clock = clock; self.q = []
        self.ioloop = self
    def call_later(self, d, fn, *a):
        self.q.append((self.clock.t + d, fn, a))
    def add_callback(self, fn, *a): fn(*a)
    def advance(self, secs, step = 0.1, each = None):
        end = self.clock.t + secs
        while self.clock.t < end - 1e-9:
            self.clock.t = min(end, self.clock.t + step)
            due = [e for e in self.q if e[0] <= self.clock.t + 1e-9]
            self.q = [e for e in self.q if e[0] > self.clock.t + 1e-9]
            for _, fn, a in sorted(due, key = lambda e: e[0]): fn(*a)
            if each: each()


class Log:
    def __init__(self): self.lines = []
    def get(self, name): return self
    def _add(self, lvl, m, a): self.lines.append((lvl, m % a if a else m))
    def info(self, m, *a): self._add('info', m, a)
    def debug(self, m, *a): self._add('debug', m, a)
    def warning(self, m, *a): self._add('warning', m, a)
    def error(self, m, *a): self._add('error', m, a)
    def exception(self, m, *a): self._add('exception', m, a)
    def has(self, lvl, text): return any(l == lvl and text in m for l, m in self.lines)


class State:
    def __init__(self): self.vars = {'cycle': 'idle'}
    def get(self, k, d = None): return self.vars.get(k, d)
    def set(self, k, v): self.vars[k] = v


class Config:
    def __init__(self): self.v = {'selected-tool': 'router'}
    def get(self, k, d = None): return self.v.get(k, d)


class Mach:
    def __init__(self): self.pauses = 0
    def pause(self): self.pauses += 1


class Link:
    '''Stands in for PlugLink: remembers the wanted state; answer() plays
    the plug answering (or not).'''
    def __init__(self, name): self.name = name; self.ip = ''; self.target = None; self.output = False; self.alive = True; self.report = None
    def set_ip(self, ip): self.ip = ip
    def want(self, on):
        changed = on != self.target
        self.target = on
        if self.alive:
            if on is True: self.output = True
            elif on is False: self.output = False
            # The real link wakes at once on a change and reports the answer
            if changed and self.report and self.ip:
                self.report(self.name, True, {'output': self.output, 'apower': 400 if self.output else 0}, None)
    def close(self): pass


class Ctrl:
    def __init__(self, prefs):
        self.dir = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.dir, 'next-data'))
        with open(os.path.join(self.dir, 'next-data', 'prefs.json'), 'w') as f:
            json.dump(prefs, f)
        self.clock = Clock()
        self.ioloop = Loop(self.clock)
        self.log = Log(); self.state = State(); self.config = Config(); self.mach = Mach()
    def get_path(self, d = None, f = None):
        p = self.dir if d is None else os.path.join(self.dir, d)
        return p if f is None else os.path.join(p, f)


PREFS = {'plugs': {'router': {'ip': '192.168.4.173', 'auto': True},
                   'vac': {'ip': '192.168.4.22', 'auto': True},
                   'spinup': 4, 'vacAfter': 5}}

def make(prefs = PREFS):
    ctrl = Ctrl(prefs)
    links = {'router': Link('router'), 'vac': Link('vac')}
    p = PL.Plugs(ctrl, links = links, clock = ctrl.clock)
    ctrl.plugs = p
    for l in links.values(): l.report = p._report
    def beat():
        # Every plug that is alive answers its heartbeat
        for n, l in links.items():
            if l.alive and l.ip and int(ctrl.clock.t * 10) % 30 == 0:
                p._report(n, True, {'output': l.output, 'apower': 400 if l.output else 0}, None)
    return ctrl, p, links, beat


# ------------------------------------------------------------ settings
ctrl, p, links, beat = make({})
check('no settings: nothing switched', p.want == {'router': None, 'vac': None} and links['router'].ip == '')
check('no settings: shown as unset', ctrl.state.get('plug_router') == 'unset')
p.job_start(False); p.spindle_cmd(True)
check('no settings: a job touches no plug', p.want == {'router': None, 'vac': None})

ctrl, p, links, beat = make({'plugs': {'router': {'ip': '1.2.3.4', 'auto': False}}})
p.job_start(False); p.spindle_cmd(True)
check('Auto off: the router plug is left alone', p.want['router'] is None and not p.router_auto())


# ------------------------------------------------------------ a normal job
ctrl, p, links, beat = make()
check('addresses passed to the plugs', links['router'].ip == '192.168.4.173' and links['vac'].ip == '192.168.4.22')
check('idle: both off', p.want == {'router': False, 'vac': False})
ctrl.state.set('cycle', 'running')
p.job_start(False)
check('job start: vac on, router waits for M3', p.want == {'router': False, 'vac': True})
p.spindle_cmd(True)
check('M3: router on', p.want['router'] is True)
ctrl.ioloop.advance(5, each = beat)
check('router confirmed: the job is not paused', ctrl.mach.pauses == 0)
check('status shows on and watts', ctrl.state.get('plug_router') == 'on' and ctrl.state.get('plug_router_w') == 400)
p.spindle_cmd(False)
check('M5: router off, vac still on', p.want == {'router': False, 'vac': True})
p.spindle_cmd(True)
ctrl.state.set('cycle', 'idle'); p.job_end()
check('end of program: router off', p.want['router'] is False)
check('end of program: vac runs on', p.want['vac'] is True)
ctrl.ioloop.advance(4.9, each = beat)
check('vac still on at 4.9 s', p.want['vac'] is True)
ctrl.ioloop.advance(0.3, each = beat)
check('vac off after 5 s', p.want['vac'] is False)
check('no errors in a normal job', not any(l in ('error', 'warning') for l, _ in ctrl.log.lines), ctrl.log.lines)


# ------------------------------------------------------------ router plug does not answer at M3
ctrl, p, links, beat = make()
ctrl.ioloop.advance(3.1, each = beat)
links['router'].alive = False
ctrl.state.set('cycle', 'running'); p.job_start(False); p.spindle_cmd(True)
ctrl.ioloop.advance(PL.CONFIRM + 0.2, each = beat)
check('no confirmation: job paused before the spin-up wait ends', ctrl.mach.pauses == 1 and PL.CONFIRM < 4)
check('no confirmation: says so', ctrl.log.has('error', 'did not confirm'))
check('no confirmation: shown offline later', (ctrl.ioloop.advance(PL.LOST, each = beat), ctrl.state.get('plug_router'))[1] == 'offline')


# ------------------------------------------------------------ contact lost mid-job
ctrl, p, links, beat = make()
ctrl.state.set('cycle', 'running'); p.job_start(False); p.spindle_cmd(True)
ctrl.ioloop.advance(10, each = beat)
check('cutting: no pause while the plug answers', ctrl.mach.pauses == 0)
links['router'].alive = False
ctrl.ioloop.advance(PL.LOST - 3.5, each = beat)
check('lost: not paused before the limit', ctrl.mach.pauses == 0)
ctrl.ioloop.advance(4, each = beat)
check('lost: job paused', ctrl.mach.pauses == 1)
check('lost: pause is well before the plug times out', PL.LOST + 3 < PL.FAILSAFE)
ctrl.ioloop.advance(10, each = beat)
check('lost: paused only once', ctrl.mach.pauses == 1)

ctrl, p, links, beat = make()
ctrl.state.set('cycle', 'running'); p.job_start(False)
links['vac'].alive = False
ctrl.ioloop.advance(12, each = beat)
check('vac lost: warning, job keeps going', ctrl.mach.pauses == 0 and ctrl.log.has('warning', 'Vac plug'))


# ------------------------------------------------------------ pause and resume
ctrl, p, links, beat = make()
ctrl.state.set('cycle', 'running'); p.job_start(False); p.spindle_cmd(True)
ctrl.ioloop.advance(3, each = beat)
p.on_update(True)
check('pause (M0): router and vac off', p.want == {'router': False, 'vac': False})
ctrl.ioloop.advance(20, each = beat)
check('paused: they stay off', p.want == {'router': False, 'vac': False})
went = []
p.resume(lambda: went.append(ctrl.clock.t))
t0 = ctrl.clock.t
check('Continue: router and vac on at once', p.want == {'router': True, 'vac': True})
p.on_update(True) # The machine is still holding
check('Continue: a hold update does not switch them off', p.want['router'] is True)
ctrl.ioloop.advance(3.8, each = beat)
check('Continue: the machine waits for spin-up', not went)
ctrl.ioloop.advance(0.5, each = beat)
check('Continue: proceeds after the spin-up time', len(went) == 1 and 3.9 <= went[0] - t0 <= 4.3, went and went[0] - t0)
p.on_update(True) # The mist delay: still holding for a moment
check('after Continue: still holding during the mist delay keeps them on', p.want == {'router': True, 'vac': True})
p.on_update(False)
p.on_update(True)
check('a later pause switches them off again', p.want == {'router': False, 'vac': False})

ctrl, p, links, beat = make()
ctrl.state.set('cycle', 'running'); p.job_start(False); p.spindle_cmd(True)
ctrl.ioloop.advance(3, each = beat)
p.on_update(True)
links['router'].alive = False
went = []
p.resume(lambda: went.append(1))
ctrl.ioloop.advance(8, each = beat)
check('Continue with the router plug gone: not resumed', not went and ctrl.log.has('error', 'Not resumed'))
check('Continue refused: everything back off', p.want == {'router': False, 'vac': False})

ctrl, p, links, beat = make()
ctrl.state.set('cycle', 'running'); p.job_start(False)
p.on_update(True)
went = []
p.resume(lambda: went.append(1))
check('Continue with the router off (no M3 yet): no wait', went == [1] and p.want == {'router': False, 'vac': True})


# ------------------------------------------------------------ E-stop and Stop
ctrl, p, links, beat = make()
ctrl.state.set('cycle', 'running'); p.job_start(False); p.spindle_cmd(True)
p.set_manual('vac', True)
p.estop(True)
check('E-stop: both off at once', p.want == {'router': False, 'vac': False} and links['router'].target is False and links['vac'].target is False)
ctrl.state.set('cycle', 'idle'); p.job_end()
ctrl.ioloop.advance(10, each = beat)
check('E-stop: no vac run-on afterwards', p.want['vac'] is False)
try: p.set_manual('router', True); ok = False
except ValueError: ok = True
check('E-stop: the screen cannot switch the router on', ok)
p.estop(False)
check('E-stop cleared: still off', p.want == {'router': False, 'vac': False})

ctrl, p, links, beat = make()
ctrl.state.set('cycle', 'running'); p.job_start(False); p.spindle_cmd(True)
p.stop()
check('Stop: router off at once', p.want['router'] is False)
ctrl.state.set('cycle', 'idle'); p.job_end()
check('Stop: vac runs on to clear the hose', p.want['vac'] is True)


# ------------------------------------------------------------ dry run, laser, manual
ctrl, p, links, beat = make()
ctrl.state.set('cycle', 'running'); p.job_start(True)
check('dry run: vac stays off', p.want['vac'] is False)
p.job_end(); ctrl.ioloop.advance(6)
check('dry run: no run-on', p.want['vac'] is False)

ctrl, p, links, beat = make()
ctrl.config.v['selected-tool'] = 'laser'
ctrl.state.set('cycle', 'running'); p.job_start(False); p.spindle_cmd(True)
check('laser: router plug never on', p.want['router'] is False and not p.router_auto())
check('laser: vac still runs', p.want['vac'] is True)

ctrl, p, links, beat = make()
p.set_manual('vac', True)
check('screen: vac on by hand', p.want['vac'] is True)
p.set_manual('vac', False)
check('screen: vac off by hand', p.want['vac'] is False)
ctrl.state.set('cycle', 'running'); p.job_start(False); p.spindle_cmd(True)
p.set_manual('router', False)
check('screen: router off mid-job pauses the job', p.want['router'] is False and ctrl.mach.pauses == 1)


# ------------------------------------------------------------ planner: M3 waits, M5 switches off
class CmdQ:
    def __init__(self): self.q = []
    def enqueue(self, id, cb, *a): self.q.append((id, cb, a))

def planner(plugs, dry = 0):
    pl = Planner.__new__(Planner)
    pl.ctrl = type('C', (), {'plugs': plugs})()
    pl.cmdq = CmdQ(); pl.spindle = 0.0; pl.dry_lift = dry
    pl.log = Log(); pl.plan_time = 0
    pl._enqueue_set_cmd = lambda *a: None
    return pl

ctrl, p, links, beat = make()
pl = planner(p)
enc = lambda b: pl._Planner__encode(b)
out = enc({'type': 'set', 'id': 5, 'name': 'speed', 'value': 17000})
check('M3: speed then a 4 s dwell', out == Cmd.speed(17000) + '\n' + Cmd.dwell(4.0), out)
check('M3: plug switched when the command reaches the machine', [(i, a) for i, cb, a in pl.cmdq.q] == [(5, (True,))])
out = enc({'type': 'set', 'id': 6, 'name': 'speed', 'value': 18000})
check('speed change while on: no extra dwell', out == Cmd.speed(18000) and len(pl.cmdq.q) == 1)
out = enc({'type': 'set', 'id': 7, 'name': 'speed', 'value': 0})
check('M5: plug off, no dwell', out == Cmd.speed(0) and pl.cmdq.q[-1][0] == 7 and pl.cmdq.q[-1][2] == (False,))

pl = planner(p, dry = 30)
out = pl._Planner__encode({'type': 'set', 'id': 5, 'name': 'speed', 'value': 17000})
check('dry run: no plug, no dwell', out == Cmd.speed(0) and not pl.cmdq.q)

ctrl2, p2, _, _ = make({'plugs': {'router': {'ip': '1.2.3.4', 'auto': False}}})
pl = planner(p2)
out = pl._Planner__encode({'type': 'set', 'id': 5, 'name': 'speed', 'value': 17000})
check('router Auto off: no dwell added', out == Cmd.speed(17000))

pl = planner(None)
out = pl._Planner__encode({'type': 'set', 'id': 5, 'name': 'speed', 'value': 17000})
check('no plugs at all: unchanged', out == Cmd.speed(17000) and not pl.cmdq.q)


# ------------------------------------------------------------ the HTTP side
calls = []
state = {'output': False}
def opener(url):
    calls.append(url.split('/rpc/')[1])
    if 'on=true' in url: state['output'] = True
    if 'on=false' in url: state['output'] = False
    return {'output': state['output'], 'apower': 0}
reports = []
link = PL.PlugLink('vac', lambda fn, *a: fn(*a), lambda *a: reports.append(a), opener)
PL.HEARTBEAT = 0.2
link.start(); link.set_ip('10.0.0.9')
link.want(True); time.sleep(0.7)
on = [c for c in calls if c.startswith('Switch.Set')]
check('link: every "on" carries the plug\'s own auto-off timer', on and all('toggle_after=%d' % PL.FAILSAFE in c for c in on), on)
check('link: "on" is re-sent (re-armed) on the heartbeat', len(on) >= 3, len(on))
calls[:] = []
link.want(False); time.sleep(0.7)
offs = [c for c in calls if 'on=false' in c]
check('link: "off" sent once, then only watched', len(offs) == 1 and any(c.startswith('Switch.GetStatus') for c in calls), calls)
check('link: answers reported', reports and reports[-1][1] is True and reports[-1][2]['output'] is False)
def broken(url): raise OSError('timed out')
link.opener = broken; reports[:] = []
time.sleep(0.5)
check('link: a dead plug is reported as failing', reports and reports[-1][1] is False)
link.close()

done()
