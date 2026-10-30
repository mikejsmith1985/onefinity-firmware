# ab-card trial-check (1.51.0): a slot on trial that isn't working restarts,
# which starts the normal slot again.
#
#   python3 src/py/tests/test_ab_trial.py
#
# No card, no root: the boot partition, the running partition, /proc and the
# web server are stand-ins.  The restart itself is not done (AB_NO_REBOOT).
import os, sys, json, tempfile, threading, importlib.machinery, types
import http.server

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, '..', '..', '..', 'scripts', 'ab-card')

ok = True
def check(name, cond, more = ''):
    global ok
    print('%s %s %s' % ('PASS' if cond else 'FAIL', name, more))
    ok = ok and bool(cond)

work = tempfile.mkdtemp(prefix = 'abtrial-')
boot = os.path.join(work, 'boot')
for d in ('a', 'b'): os.makedirs(os.path.join(boot, d))
open(os.path.join(work, 'disk3'), 'w').close()     # "partition 3 exists"
proc = os.path.join(work, 'proc')

def set_procs(*names):
    import shutil
    if os.path.isdir(proc): shutil.rmtree(proc)
    for i, n in enumerate(names):
        os.makedirs(os.path.join(proc, str(100 + i)))
        with open(os.path.join(proc, str(100 + i), 'comm'), 'w') as f:
            f.write(n + '\n')
    os.makedirs(os.path.join(proc, 'self'), exist_ok = True)

def set_default(slot):
    with open(os.path.join(boot, 'config.txt'), 'w') as f:
        f.write('display_rotate=2\n# --- A/B card ---\n[all]\nos_prefix=%s/\n' % slot)

class Ok(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
    def log_message(self, *a): pass

srv = http.server.HTTPServer(('127.0.0.1', 0), Ok)
threading.Thread(target = srv.serve_forever, daemon = True).start()
UP = 'http://127.0.0.1:%d/api/config/load' % srv.server_port
DOWN = 'http://127.0.0.1:9/api/config/load'

os.environ.update(AB_BOOT = boot, AB_ROOT_DEV = os.path.join(work, 'disk3'),
                  AB_NO_REMOUNT = '1', AB_NO_REBOOT = '1', AB_PROC = proc,
                  AB_TRIAL_WAIT = '3', AB_TRIAL_STEADY = '1',
                  AB_TRIAL_POLL = '0.2', AB_RUN_DIR = os.path.join(work, 'run'))

loader = importlib.machinery.SourceFileLoader('abcard', TOOL)
ab = types.ModuleType(loader.name); loader.exec_module(ab)

def trial():
    p = os.path.join(boot, 'ab-trial.json')
    return json.load(open(p)) if os.path.exists(p) else None

# Running slot B (partition 3) while A starts normally: B is on trial
set_default('a')
st = ab.card_state()
check('slot B on trial', st['ab'] and st['running'] == 'b' and st['trial'], st)

# Everything up
set_procs('systemd', 'Xorg', 'chromium', 'python3')
os.environ['AB_HEALTH_URL'] = UP
check('working: stays', ab.cmd_trial_check() is True)
t = trial()
check('working: recorded', t and t['check']['result'] == 'working' and
      t['slot'] == 'b', t)

# The browser never starts
os.unlink(os.path.join(boot, 'ab-trial.json'))
set_procs('systemd', 'Xorg', 'python3')
check('no browser: goes back', ab.cmd_trial_check() is False)
t = trial()
check('no browser: recorded', t and t['check']['result'] == 'not working' and
      t['check']['not_working'] == ['browser'], t)

# No X and no web server (the 1.50.0 card on the machine had no X)
set_procs('systemd', 'python3')
os.environ['AB_HEALTH_URL'] = DOWN
check('no screen, no web: goes back', ab.cmd_trial_check() is False)
t = trial()
check('no screen, no web: recorded',
      t['check']['not_working'] == ['browser', 'screen', 'web'], t)

# The trial file made by "try" keeps its fields
with open(os.path.join(boot, 'ab-trial.json'), 'w') as f:
    json.dump({'slot': 'b', 'time': '2026-10-30 18:00'}, f)
set_procs('Xorg', 'chromium')
os.environ['AB_HEALTH_URL'] = UP
ab.cmd_trial_check()
t = trial()
check('try record kept', t['time'] == '2026-10-30 18:00' and
      t['check']['result'] == 'working', t)

# Kept (B is the normal slot now): nothing is checked, nothing written
os.unlink(os.path.join(boot, 'ab-trial.json'))
set_default('b')
set_procs('systemd')
check('not on trial: nothing to do', ab.cmd_trial_check() is True and
      trial() is None)

# Not an A/B card
set_default('b')
os.rename(os.path.join(boot, 'a'), os.path.join(boot, 'a-gone'))
check('single card: nothing to do', ab.cmd_trial_check() is True and
      trial() is None)

srv.shutdown()
print('ALL PASS' if ok else 'SOME FAILED')
sys.exit(0 if ok else 1)
