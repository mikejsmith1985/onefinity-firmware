# Runs G-code through the controller's real Planner, Mach and Comm code with
# a CAMotics-like interpreter (FakeGPlan) and an AVR-like executor (FakeAVR).
#
# What it models, from the CAMotics and AVR sources:
#  - After a probing move (G38.2 to G38.5) the interpreter stops producing
#    moves until the planner is told the result: synchronize(result), or
#    restart(id, position), which synchronizes with 1 (contact).  CAMotics
#    Planner::restart, ControllerImpl::synchronize.
#  - The AVR holds with "Switch found" when the probe touches (exec.c,
#    state_seek_hold).  When the move ends without contact it only ends the
#    seek (seek.c seek_end): "Switch not found" for G38.2/G38.4, nothing at
#    all for G38.3/G38.5, then READY once nothing more is queued.
#  - Comm feeds the AVR one command at a time from Mach.comm_next() and polls
#    again (Comm._poll_cb) when the planner had nothing.
#
# So a program that waits for a probe result nobody gives stalls here exactly
# as on the machine, and run() raises Hang instead of finishing.
#
# Used by src/py/tests/test_seek_restart.py and by the G-code simulators in
# src/react-ui/test (simlib.Sim.run).
import os, sys, json, copy
from collections import deque
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bbstub  # noqa: F401  (stubs the controller-only modules)
import bbctrl
import bbctrl.Cmd as Cmd
PlannerMod = sys.modules['bbctrl.Planner']


class Hang(Exception): pass
class EStop(Exception): pass


class Log:
    def __init__(self, sink, name):
        self.sink, self.name = sink, name
    def _add(self, level, msg, *args, **kw):
        if args:
            try: msg = msg % args
            except Exception: msg = '%s %s' % (msg, args)
        self.sink.append((level, self.name, str(msg)))
    def info(self, msg, *a, **k): self._add('info', msg, *a)
    def debug(self, msg, *a, **k): self._add('debug', msg, *a)
    def warning(self, msg, *a, **k): self._add('warning', msg, *a)
    def error(self, msg, *a, **k): self._add('error', msg, *a)
    def exception(self, msg, *a, **k):
        import traceback
        self._add('error', msg + '\n' + traceback.format_exc(), *a)
    def message(self, msg, *a, **k): self._add('message', msg)
    def set_level(self, *a): pass


class Logs:
    def __init__(self): self.lines = []
    def get(self, name): return Log(self.lines, name)


class State:
    # The parts of bbctrl.State the planner and Mach use.  Listeners get the
    # change dict right away (the real State batches them on the IOLoop).
    def __init__(self):
        self.vars = {'xx': 'READY', 'xc': 0, 'id': 0, 'cycle': 'idle',
                     'metric': True, 'xp': 0.0, 'yp': 0.0, 'zp': 0.0}
        self.listeners = []
        self.messages = []
        self.history = []   # every set(), in order
    def add_listener(self, cb): self.listeners.append(cb)
    def reset(self): pass
    def get(self, name, default = None): return self.vars.get(name, default)
    def has(self, name): return name in self.vars
    def set(self, name, value):
        self.vars[name] = value
        self.history.append((name, value))
    def update(self, update):
        self.history.append(('update', dict(update)))
        for k, v in update.items(): self.vars[k] = v
        for cb in list(self.listeners): cb(update)
    def get_position(self):
        return dict((a, self.vars[a + 'p']) for a in 'xyz')
    def get_axis_vector(self, name, scale = 1):
        return dict((a, 10000.0 * scale) for a in 'xyz')
    def get_soft_limit_vector(self, name, default):
        return dict((a, default) for a in 'xyzabc')
    def find_motor(self, axis): return None
    def get_switch_id(self, switch): return 1
    def is_axis_homed(self, axis): return True
    def add_message(self, text): self.messages.append(text)


class Config:
    def get(self, name, default = None):
        return {'max-deviation': 0.05, 'junction-accel': 200000}.get(name, default)
    def set(self, *a): pass


class IOLoop:
    def call_later(self, *a, **k): pass


class FakeGPlan:
    # CAMotics gplan.Planner, as far as bbctrl's Planner uses it
    def __init__(self, harness):
        self.h = harness
        self.gen = None
        self.blocks = deque()
        self.syncing = None   # the probe event waiting for a result
        self.done = True
        self.next_id = 1
        self.interp = None
        self.position = None
        self.send = None
        harness.gplans.append(self)

    def set_resolver(self, cb): pass
    def set_logger(self, *a): pass
    def set_position(self, p):
        self.position = dict(p)
        if self.interp is not None: self._move_interp(p)

    def _move_interp(self, p):
        for i, a in enumerate('xyz'):
            if a in p: self.interp.P[i] = float(p[a])

    def _load(self, text):
        self.interp = self.h.make_interp()
        if self.position is not None: self._move_interp(self.position)
        self.gen = self.interp.steps(text)
        self.done = False
        self.send = None
        self.syncing = None

    def load_string(self, text, cfg): self._load(text)
    def load(self, path, cfg):
        with open(path) as f: self._load(f.read())

    def _block(self, **kw):
        kw['id'] = self.next_id
        self.next_id += 1
        self.blocks.append(kw)
        self.h.sent[kw['id']] = kw

    def _line(self, tgt, **extra):
        p = self.interp.P
        if max(abs(tgt[i] - p[i]) for i in range(3)) < 1e-9: return
        self._block(type = 'line', target = dict(zip('xyz', tgt)),
                    **dict({'exit-vel': 0, 'max-accel': 1000, 'max-jerk': 1e6,
                            'times': [0, 100, 0, 0, 0, 0, 0]}, **extra))
        self.interp.P = list(tgt)

    def _advance(self):
        while not self.blocks and self.syncing is None and not self.done:
            try:
                ev = self.gen.send(self.send)
            except StopIteration:
                self.done = True
                self._block(type = 'end')
                break
            self.send = None
            if ev[0] == 'line': self._line(ev[1])
            elif ev[0] == 'set':
                self._block(type = 'set', name = '_' + ev[1].lstrip('_'),
                            value = ev[2])
            elif ev[0] == 'probe':
                self._block(type = 'seek', switch = 'probe', active = True,
                            error = ev[2] == 38.2)
                self._line(ev[1], seeking = True)
                self.syncing = ev
                self.h.events.append(('sync-wait', self.next_id - 1))

    def has_more(self):
        self._advance()
        return bool(self.blocks)

    def next(self): return self.blocks.popleft()
    def is_running(self): return not self.done or bool(self.blocks)
    def is_synchronizing(self): return self.syncing is not None
    def set_active(self, id): pass

    def synchronize(self, result):
        if self.syncing is None: raise RuntimeError('Not synchronizing')
        self.syncing = None
        self.send = bool(result)
        self.h.events.append(('synchronize', int(result)))

    def restart(self, id, position):
        self._move_interp(position)   # setPosition()
        if self.syncing is not None: self.synchronize(1)

    def stop(self):
        if self.syncing is not None: self.synchronize(0)
        self.blocks.clear()
        self.done = True
        self.gen = None


class FakeAVR:
    def __init__(self, harness, phys):
        self.h = harness
        self.phys = phys
        self.state = 'READY'
        self.count = 0
        self.seek = None
        self.writing = False
        self.rx = ''
        self.out = deque()
        self.read_cb = self.write_cb = None

    def set_handlers(self, read_cb, write_cb):
        self.read_cb, self.write_cb = read_cb, write_cb

    def enable_write(self, on): self.writing = on

    def report(self, **kw): self.out.append(kw)
    def log(self, level, msg): self.out.append({'level': level, 'msg': msg})

    def set_state(self, state, **kw):
        self.state = state
        self.count += 1
        kw.update(xx = state, xc = self.count)
        self.report(**kw)

    def position(self):
        return dict(zip(('xp', 'yp', 'zp'), (float(v) for v in self.phys.P)))

    def i2c_command(self, cmd, byte = None, word = None, block = None):
        self.h.events.append(('i2c', cmd))
        if cmd == Cmd.UNPAUSE and self.state == 'HOLDING':
            self.set_state('READY', pr = '')
        elif cmd == Cmd.ESTOP: self.set_state('ESTOPPED')
        elif cmd == Cmd.STOP and self.state in ('RUNNING', 'STOPPING'):
            self.set_state('HOLDING', pr = 'User stop')

    def deliver(self):
        while self.out:
            msg = self.out.popleft()
            self.read_cb(bytes(json.dumps(msg) + '\n', 'utf-8'))

    def write(self, data):
        self.rx += data.decode('utf-8')
        while '\n' in self.rx:
            line, self.rx = self.rx.split('\n', 1)
            self.execute(line.strip())
        return len(data)

    def execute(self, line):
        if not line or self.state in ('ESTOPPED', 'HOLDING'): return
        self.h.executed += 1
        c = line[0]
        if c == Cmd.SET_SYNC and line.startswith('#id='):
            self.id = int(line[4:])
            self.report(id = self.id)
        elif c == Cmd.SEEK:
            flags = ord(line[2]) - ord('0')
            self.seek = {'active': bool(flags & Cmd.SEEK_ACTIVE),
                         'error': bool(flags & Cmd.SEEK_ERROR)}
            self.h.events.append(('seek', dict(self.seek)))
        elif c == Cmd.LINE: self.line(line)

    def line(self, line):
        target = list(self.phys.P)
        rest = line[19:]
        while rest:
            name, value, rest = rest[0], Cmd.decode_float(rest[1:7]), rest[7:]
            if name in 'xyz': target['xyz'.index(name)] = value
        # The AVR gets float32 targets.  Where that is only the rounding of
        # the planned target, use the planned value so a run gives the same
        # numbers as the direct simulation (SIM_DIRECT=1)
        planned = self.h.sent.get(getattr(self, 'id', None), {}).get('target', {})
        for i, a in enumerate('xyz'):
            if a in planned and abs(planned[a] - target[i]) < 1e-3:
                target[i] = float(planned[a])
        if self.state == 'READY': self.set_state('RUNNING')
        seek, self.seek = self.seek, None
        if seek is None:
            self.phys.move(target)   # raises simlib.Crash
            self.report(**self.position())
            return
        hit = self.phys.move(target, 'G38.3')
        self.report(**self.position())
        self.h.events.append(('seek-end', hit))
        if hit:   # exec.c: STOPPING then HOLDING, "Switch found"
            self.set_state('STOPPING')
            self.set_state('HOLDING', pr = 'Switch found')
        elif seek['error']:
            self.log('warning', 'Switch not found')   # seek.c seek_end
        elif self.h.no_error_hold:
            # Upstream Buildbotics firmware holds here too
            self.set_state('STOPPING')
            self.set_state('HOLDING', pr = 'Switch no error')
        # Otherwise (this firmware) a G38.3/G38.5 without contact ends the
        # seek silently (seek.c) and the AVR goes READY when its queue is empty


class Harness:
    def __init__(self, phys, poll_limit = 25, no_error_hold = False):
        self.phys = phys
        self.no_error_hold = no_error_hold
        self.poll_limit = poll_limit
        self.gplans = []
        self.events = []
        self.executed = 0
        self.sent = {}
        self.logs = Logs()
        self.ctrl = ctrl = type('Ctrl', (), {})()
        ctrl.log = self.logs
        ctrl.state = State()
        ctrl.config = Config()
        ctrl.ioloop = IOLoop()
        ctrl.ready = lambda: None
        ctrl.get_path = lambda *a: '/nonexistent'
        ctrl.configure = lambda: None
        self.avr = FakeAVR(self, phys)
        PlannerMod.gplan = type('gplan', (), {'Planner': lambda: FakeGPlan(self)})
        ctrl.state.update(self.avr.position())
        self.mach = bbctrl.Mach(ctrl, self.avr)
        ctrl.mach = self.mach
        self.planner = self.mach.planner

    def make_interp(self):
        it = copy.copy(self.phys)   # shares vars, off, obstacles, noise
        it.P = list(self.phys.P)
        return it

    def errors(self):
        return [m for l, n, m in self.logs.lines if l == 'error']

    def run_program(self, prog, start = None):
        mach, avr = self.mach, self.avr
        if start is None: mach.mdi(prog)
        else: start(prog)
        idle = 0
        while True:
            avr.deliver()
            if avr.state == 'ESTOPPED':
                raise EStop('; '.join(self.errors()) or 'E-stopped')
            errs = self.errors()
            if errs: raise Exception('Controller error: ' + errs[0])
            if avr.writing:
                before = self.executed
                mach._write(avr.write)
                if self.executed != before or mach.command is not None:
                    idle = 0
                continue
            if avr.state in ('RUNNING', 'STOPPING'):   # queue ran dry
                avr.set_state('READY')
                continue
            if avr.state == 'READY' and not self.planner.is_running():
                return
            # Comm._poll_cb: ask the planner again a moment later
            idle += 1
            if self.poll_limit < idle:
                ln = [m for l, n, m in self.logs.lines if n in ('Planner', 'Mach')]
                raise Hang('planner stalled: AVR %s id %s at %s, interpreter '
                           'synchronizing %s.  Last log: %s' % (
                               avr.state, self.ctrl.state.get('id'),
                               [round(v, 3) for v in self.phys.P],
                               self.planner.planner.is_synchronizing(),
                               ln[-3:]))
            self.planner._report_time()   # the planner's 1 s timer
            mach.flush()

def run(phys, prog, harness = None):
    # simlib.Sim.run(): run prog on the simulated machine phys through the
    # controller code.  Raises simlib.NotFound for a G38.2/G38.4 without
    # contact (the controller E-stops), Crash and Hang as they happen.
    h = harness or Harness(phys)
    try:
        h.run_program(prog)
    except EStop as e:
        if 'Switch not found' in str(e) or any(
                m == 'Switch not found' for l, n, m in h.logs.lines):
            raise sys.modules[type(phys).__module__].NotFound('Switch not found')
        raise
    g = h.gplans[-1]
    if g.interp is not None: phys.inc = g.interp.inc
    return phys
