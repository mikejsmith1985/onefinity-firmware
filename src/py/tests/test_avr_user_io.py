# M62-M66 user I/O on the motion board (1.45.0), run on the real AVR source
# built for the PC (src/avr/emu, bbemu).  Input pin levels are driven through
# the emulator's BBEMU_PINS test hook.
#
#   python3 src/py/tests/test_avr_user_io.py      (builds bbemu if needed)
import os, sys, time, select, subprocess, tempfile, importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
EMU = os.path.join(ROOT, 'src', 'avr', 'emu')
spec = importlib.util.spec_from_file_location(
    'Cmd', os.path.join(ROOT, 'src', 'py', 'bbctrl', 'Cmd.py'))
Cmd = importlib.util.module_from_spec(spec); spec.loader.exec_module(Cmd)

ok = True
def check(name, cond, more = ''):
    global ok
    print('%s %s %s' % ('PASS' if cond else 'FAIL', name, more))
    ok = ok and bool(cond)


def build():
    mk = open(os.path.join(EMU, 'Makefile')).read().replace(
        '-Wno-class-memaccess -pthread',
        '-Wno-class-memaccess -Wno-format-security -pthread')
    path = os.path.join(tempfile.gettempdir(), 'bbemu-test.mk')
    open(path, 'w').write(mk)
    subprocess.run(['make', '-f', path, '-j4'], cwd = EMU, check = True,
                   stdout = subprocess.DEVNULL)


class Emu:
    def __init__(self):
        self.pins = tempfile.NamedTemporaryFile('w', delete = False).name
        self.set_pins({})
        env = dict(os.environ, BBEMU_PINS = self.pins)
        self.p = subprocess.Popen([os.path.join(EMU, 'bbemu')],
                                  stdin = subprocess.PIPE,
                                  stdout = subprocess.PIPE, bufsize = 0,
                                  env = env)
        self.buf = ''
        self.read(0.3)
        self.send('r1'); self.send('c')   # Reports on, queue running
        self.read(0.3)

    def set_pins(self, levels):
        # Limit pins are pulled up: 1 = open switch.  Port B bits 0-7.
        lines = ['B %d %d' % (b, levels.get(b, 1)) for b in range(8)]
        open(self.pins, 'w').write('\n'.join(lines) + '\n')

    def send(self, s): self.p.stdin.write((s + '\n').encode())

    def read(self, t):
        out = b''; end = time.time() + t
        while time.time() < end:
            r, _, _ = select.select([self.p.stdout], [], [], 0.02)
            if r: out += os.read(self.p.stdout.fileno(), 65536)
        s = out.decode(errors = 'replace'); self.buf += s
        return s

    def get(self, var):
        self.read(0.05); self.buf = ''
        self.send('$' + var)
        end = time.time() + 2
        import json
        while time.time() < end:
            self.read(0.05)
            for line in self.buf.splitlines():
                try: msg = json.loads(line)
                except Exception: continue
                if var in msg: return msg[var]
        return None

    def results(self, t):
        import json
        self.buf = ''; self.read(t)
        out = []
        for line in self.buf.splitlines():
            try: msg = json.loads(line)
            except Exception: continue
            if 'result' in msg: out.append(msg['result'])
        return out

    def close(self):
        self.p.kill(); os.unlink(self.pins)


if not os.path.exists(os.path.join(EMU, 'bbemu')) or '--build' in sys.argv:
    build()

e = Emu()
try:
    # --- Inputs ---------------------------------------------------------
    e.send('$0ip=1'); e.send('$0im=1')   # input 0 = motor 0 min pin, NO
    e.read(0.3)
    check('input 0 assigned to the motor 0 min pin', e.get('0ip') == 1)
    check('open switch reads 0', e.get('0is') == 0)
    check('the pin no longer reports as a limit switch', e.get('0ls') == 0)

    e.set_pins({0: 0}); e.read(0.4)
    check('closed switch reads 1', e.get('0is') == 1)

    e.send(Cmd.input('digital-in-0', 'immediate', 0))
    r = e.results(0.5)
    check('M66 L0 (immediate) gives the level', r == [1], str(r))

    e.set_pins({}); e.read(0.4)
    e.send(Cmd.input('digital-in-0', 'rise', 3))
    r = e.results(0.5); check('M66 L1 (rise) waits', r == [], str(r))
    e.set_pins({0: 0})
    r = e.results(1)
    check('M66 L1 ends on the rising edge with 1', r == [1], str(r))

    e.send(Cmd.input('digital-in-0', 'fall', 3))
    e.read(0.3); e.set_pins({})
    r = e.results(1)
    check('M66 L2 ends on the falling edge with 0', r == [0], str(r))

    e.send(Cmd.input('digital-in-0', 'high', 0.5))
    t0 = time.time(); r = e.results(1.5)
    check('M66 L3 times out with -1', r == [-1], str(r))

    e.send(Cmd.input('digital-in-0', 'low', 2))
    r = e.results(0.4)
    check('M66 L4 ends at once when already low', r == [0], str(r))

    e.send(Cmd.input('digital-in-2', 'high', 5))
    r = e.results(0.5)
    check('an unassigned input answers -1 at once', r == [-1], str(r))

    # Mode NC inverts
    e.send('$0im=2'); e.read(0.4)
    check('normally closed: open switch reads 1', e.get('0is') == 1)
    e.send('$0im=1'); e.read(0.3)

    # A limit switch pin can't be taken
    e.send('$1ls=1'); e.read(0.2)              # motor 1 min limit, NO
    e.send('$1ip=3'); e.send('$1im=1'); e.read(0.3)
    check('a pin in use as a limit switch is refused', e.get('1ip') == 0)
    check('the limit switch keeps its mode', e.get('1ls') == 1)
    e.send('$1ls=0')

    # The motor limit setting can't take an input's pin
    e.send('$0ls=2'); e.read(0.2)
    check('motor limit mode ignored on an input pin', e.get('0ls') == 0)
    check('input still assigned', e.get('0ip') == 1 and e.get('0is') in (0, 1))

    # Stop during a wait (review of 1.45.0): it must stop now, not at the timeout
    e.send('$dom=1'); e.send('$dou=1'); e.send('#doa=1'); e.read(0.2)
    e.set_pins({})
    e.send(Cmd.input('digital-in-0', 'low', 6)); e.read(0.4)
    e.send('S'); r = e.results(1.0)
    st = e.get('xx')
    check('Stop during M66 holds at once, output off, no stale result',
          st in ('HOLDING', 'READY') and e.get('doa') == False and r == [], '%s %s' % (st, r))
    e.send('c'); e.send('U'); e.read(0.3); e.send('$dou=0'); e.read(0.1)

    # A limit switch turned on while its pin is an input (review of 1.45.0):
    # kept, and in force once the input lets go of the pin
    e.send('$0ls=1'); e.read(0.2)
    check('limit set on an input pin: input keeps it for now', e.get('0ip') == 1)
    e.send('$0ip=0'); e.read(0.3)
    check('released: the limit switch is in force', e.get('0ls') == 1, str(e.get('0ls')))
    e.send('$0ip=1'); e.send('$0im=1'); e.read(0.3)
    check('and an input can no longer take the pin', e.get('0ip') == 0)
    e.send('$0ls=0'); e.read(0.2)
    e.send('$0ip=1'); e.send('$0im=1'); e.read(0.3)
    check('limit off again: the input can have it', e.get('0ip') == 1)

    # A pin with mode 0 (disabled) answers -1 at once
    e.send('$2ip=6'); e.send('$2im=0'); e.read(0.2)
    e.send(Cmd.input('digital-in-2', 'high', 5)); r = e.results(0.5)
    check('assigned but disabled input answers -1 at once', r == [-1], str(r))
    e.send('$2ip=0'); e.read(0.1)

    # An unknown port answers -1 instead of reading P0
    e.set_pins({0: 0}); e.read(0.4)
    e.send(Cmd.input('digital-in-7', 'immediate', 0)); r = e.results(0.5)
    check('unknown port answers -1, not P0', r == [-1], str(r))
    e.set_pins({})

    # E-stop drops a wait without a result
    e.set_pins({})
    e.send(Cmd.input('digital-in-0', 'low', 5)); e.read(0.3)
    e.send('E'); r = e.results(0.8)
    check('E-stop drops an M66 wait (no result)', r == [], str(r))
    # Clearing an E-stop reboots the motion board (estop_clear), and the
    # controller then sends the whole config again.  Start a fresh board.
    e.close(); e = Emu()
    e.send('$0ip=1'); e.send('$0im=1'); e.read(0.3)

    # Releasing
    e.send('$0ip=0'); e.read(0.3)
    check('unassigned input reads disabled', e.get('0is') == 2)

    # --- Outputs --------------------------------------------------------
    e.send('$dom=1'); e.send('$dou=1'); e.read(0.1)   # lo-hi, as configured
    check('tool direction output can be a user output', e.get('dou') == True)
    e.send('#doa=1'); e.read(0.3)
    a, st = e.get('doa'), e.get('dos')
    check('M64 output on (pin driven high)', a == True and st == 1, '%s %s' % (a, st))
    e.send('S'); e.read(0.3)
    check('stop turns user outputs off', e.get('doa') == False)
    e.send('c'); e.read(0.1)
    e.send('#doa=1'); e.read(0.2); e.send('E'); e.read(0.3)
    check('E-stop turns user outputs off', e.get('doa') == False)
    e.close(); e = Emu()

    e.send('$fou=1'); e.read(0.1)
    check('the fault output cannot be a user output', e.get('fou') == False)

    e.send('$1oa=1'); e.read(0.1); e.send('$1ou=0'); e.read(0.1)
    e.send('S'); e.read(0.2)
    check('Load 1 (mist) still goes off on stop', e.get('1oa') == False)

    # --- Motion --------------------------------------------------------
    # A limit pin trips E-stop when it closes while moving; the same pin as
    # an M66 input must not.
    def jog_with_pin_closing(user):
        m = Emu()
        for c in ('$0an=0', '$0me=1', '$0vm=5000', '$0am=10', '$0jm=50',
                  '$0mi=32', '$0sa=1.8', '$0tr=5', '$0dc=1', '$0ic=0'):
            m.send(c)
        if user: m.send('$0ip=1'); m.send('$0im=1')
        else: m.send('$0ls=1')
        m.read(0.5)
        for i in range(10):
            m.send(Cmd.jog({'x': 0.5})); m.read(0.1)
            if i == 5: m.set_pins({0: 0})
        res = (m.get('xx'), m.get('er'))
        m.close()
        return res
    xx, er = jog_with_pin_closing(False)
    check('control: as a limit switch the pin E-stops while jogging',
          xx == 'ESTOPPED', '%s %s' % (xx, er))
    xx, er = jog_with_pin_closing(True)
    check('as an M66 input the same pin does not', xx == 'JOGGING',
          '%s %s' % (xx, er))

finally:
    e.close()

print('ALL PASS' if ok else 'SOME FAILED')
sys.exit(0 if ok else 1)
