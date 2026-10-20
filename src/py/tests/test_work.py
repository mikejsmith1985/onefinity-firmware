# Whole-file work off the IO loop (1.31.2): the worker process, the async
# G-code check (cache, shared in-flight checks, LRU), fail-closed run check.
#   python3 src/py/tests/test_work.py
import sys, os, time, types, tempfile, concurrent.futures
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bbstub import check, done, run_sync
import bbctrl
from bbctrl import Lint, Work
Web = sys.modules['bbctrl.Web']
from tornado import gen

tmp = tempfile.mkdtemp()
def put(name, text):
    p = os.path.join(tmp, name)
    with open(p, 'w') as f: f.write(text)
    return p

BIG = ['G21', 'G90', 'G54', 'S18000 M3', 'G0 Z5', 'G0 X0 Y0']
BIG += ['G1 X%.3f Y%.3f Z-1.000 F1500' % (i % 300 * 0.5, i % 150 * 0.5) for i in range(120000)]
BIG = '\n'.join(BIG + ['M5', 'M30']) + '\n'
GOOD = 'G21 G54\nG0 X0 Y0 Z5\nS1000 M3\nG1 Z-1 F100\nG1 X10\nG0 Z5\nM5\nM30\n'
BAD = 'G21 G54\nG0 X0 Y0 Z5\nG83 X1 Y1 Z-5 R2 Q1\nM30\n'

# 1. The worker is a separate process
f = Work.run(os.getpid)
check('work runs in another process', f.result(30) != os.getpid())
check('mode is process', Work.mode() == 'process', Work.mode())

# 2. Same results as the direct check; cache hit is immediate
big = put('big.nc', BIG)
Lint.clear_cache()
direct = Lint._lint_path(big)
t = time.time(); f = Lint.lint_file_async(big)
check('a new check returns at once (not done yet)', time.time() - t < 0.1 and not f.done())
res = f.result(60)
check('async result equals the direct check', res == direct)
f2 = Lint.lint_file_async(big)
check('cache hit: already done', f2.done() and f2.result() == res)
check('nothing left in flight', Lint.in_flight() == 0)

# 3. Everyone asking during a check shares it
calls = []
real_run = Work.run
def counting_run(fn, *a):
    calls.append(fn.__name__); return real_run(fn, *a)
Work.run = counting_run
os.utime(big, None)  # new version
a = Lint.lint_file_async(big); b = Lint.lint_file_async(big); c = Lint.lint_file_async(big)
check('three requests during one check share one job', a is b is c and calls.count('_lint_path') == 1, calls)
a.result(60)
check('in-flight entry removed when done', Lint.in_flight() == 0)

# 4. A changed file is checked again, the old version's result is not reused
p = put('change.nc', GOOD)
r1 = Lint.lint_file_async(p).result(30)
time.sleep(0.02); put('change.nc', BAD)
r2 = Lint.lint_file_async(p).result(30)
check('changed file checked again', r1['errors'] == 0 and r2['errors'] > 0, (r1['errors'], r2['errors']))
check('lint_file (sync) agrees with the cache', Lint.lint_file(p)['errors'] == r2['errors'])
Work.run = real_run

# 5. LRU of CACHE_MAX files, not wiped at 8
Lint.clear_cache()
paths = [put('f%02d.nc' % i, GOOD) for i in range(Lint.CACHE_MAX + 1)]
for q in paths[:Lint.CACHE_MAX]: Lint.lint_file_async(q).result(30)
check('32 files all kept (1.31.1 wiped the cache at 8)', all(Lint.cached(q) is not None for q in paths[:Lint.CACHE_MAX]))
Lint.cached(paths[0])                      # used: now the newest
Lint.lint_file_async(paths[-1]).result(30) # one more: the oldest unused goes
check('least recently used file evicted', Lint.cached(paths[1]) is None and Lint.cached(paths[0]) is not None and Lint.cached(paths[-1]) is not None)

# 6. Failures
f = Lint.lint_file_async(os.path.join(tmp, 'missing.nc'))
check('missing file: the Future fails with OSError', f.done() and isinstance(f.exception(), OSError))

class Log:
    def info(s, *a): pass
    def warning(s, *a): pass
    def exception(s, *a): pass
c = types.SimpleNamespace(sel='', started=[])
c.get_upload = lambda n=None: os.path.join(tmp, n) if n else tmp
c.get_path = lambda d=None, f=None: os.path.join(tmp, d) if d else tmp
c.state = types.SimpleNamespace(get=lambda k, d=None: c.sel if k == 'selected' else d)
c.log = types.SimpleNamespace(get=lambda n: Log())
c.mach = types.SimpleNamespace(start=lambda lift=0: c.started.append(lift))

put('good.nc', GOOD); put('bad.nc', BAD)
st = run_sync(Lint.start_stops_async, c, 'bad.nc')
check('async run check: lint error stops', [s['key'] for s in st] == ['lint'], st)
check('async run check: clean program goes', run_sync(Lint.start_stops_async, c, 'good.nc') == [])
check('async run check: unreadable program stops', [s['key'] for s in run_sync(Lint.start_stops_async, c, 'nope.nc')] == ['read'])

def broken(fn, *a):
    f = concurrent.futures.Future(); f.set_exception(RuntimeError('worker died')); return f
Work.run = broken; os.utime(os.path.join(tmp, 'good.nc'), None)
st = run_sync(Lint.start_stops_async, c, 'good.nc')
check('a check that could not run stops the start (fails closed)', [s['key'] for s in st] == ['check'] and 'worker died' in st[0]['msg'], st)
Work.run = real_run

def changing(fn, *a):
    put('good.nc', GOOD + '(edited)\n'); os.utime(os.path.join(tmp, 'good.nc'), (1, 1))
    return real_run(fn, *a)
Work.run = changing; os.utime(os.path.join(tmp, 'good.nc'), None)
st = run_sync(Lint.start_stops_async, c, 'good.nc')
check('program changed during the check: not started', [s['key'] for s in st] == ['changed'], st)
Work.run = real_run

# /api/start through the handler
def start(sel, body, swap=None):
    c.sel = sel
    h = Web.StartHandler.__new__(Web.StartHandler); h.get_ctrl = lambda: c; h.json = body
    h.write_json = lambda v: None
    if swap:
        real = Lint.start_stops_async
        @gen.coroutine
        def swapping(ctrl, fn):
            r = yield real(ctrl, fn); c.sel = swap; return r
        Lint.start_stops_async = swapping
    try: run_sync(h.put); return 'started'
    except Web.HTTPError as e: return (e.status_code, e.log_message % e.args)
    finally:
        if swap: Lint.start_stops_async = real
c.started.clear()
r = start('bad.nc', {})
check('/api/start refuses a lint error with 409', r[0] == 409 and 'G83' in r[1] and c.started == [], r)
check('/api/start Run anyway still starts', start('bad.nc', {'ack': True}) == 'started' and c.started == [0])
r = start('good.nc', {}, swap='bad.nc')
check('/api/start refuses when another program was selected during the check', r != 'started' and 'Another program' in r[1], r)
check('/api/start clean program starts', start('good.nc', {'dry_lift': 5}) == 'started' and c.started[-1] == 5)

# LintHandler
def lint_get(name):
    h = Web.LintHandler.__new__(Web.LintHandler); got = {}
    h.get_upload = lambda n=None: os.path.join(tmp, n) if n else tmp
    h.write_json = lambda v: got.setdefault('v', v)
    try: run_sync(h.get, name); return got.get('v')
    except Web.HTTPError as e: return e.status_code
check('GET /api/lint answers from the worker', lint_get('bad.nc')['errors'] > 0)
check('GET /api/lint missing file 404', lint_get('zz.nc') == 404)
check('GET /api/lint bad name 400', lint_get('.hidden') == 400)

# 7. The worker dies: it is restarted
pool = Work._pool
for pr in list(pool._processes.values()): pr.kill()
time.sleep(0.5)
try: Work.run(os.getpid).result(30); died = False
except Exception: died = True   # the job sent as it died may fail
pid = Work.run(os.getpid).result(30)
check('a dead worker is replaced', pid != os.getpid() and Work.mode() == 'process' and Work._pool is not pool, (died, Work.mode()))

# 8. No processes: a background thread
saved = Work._restarts; Work._restarts = Work.MAX_RESTARTS + 1
check('thread fallback runs off the calling thread', Work.run(lambda: __import__('threading').get_ident()).result(10) != __import__('threading').get_ident() and Work.mode() == 'thread')
Work._restarts = saved

# 9. The worker lets go of the server's sockets and leaves with it
import socket, stat as _stat
def worker_sockets():
    n = 0
    for name in os.listdir('/proc/self/fd'):
        if int(name) <= 2: continue  # stdin/out/err: not the server's
        try:
            if _stat.S_ISSOCK(os.fstat(int(name)).st_mode): n += 1
        except OSError: pass
    return n, os.getppid(), os.nice(0)
srv = socket.socket(); srv.bind(('127.0.0.1', 0)); srv.listen(1)
Work.shutdown()   # the next job forks a new worker, after the socket opened
n, ppid, nice = Work.run(worker_sockets).result(30)
check('the worker holds none of the server\'s sockets', n == 0, n)
check('the worker is niced below the server', nice >= os.nice(0) + Work.NICE_FG, nice)
port = srv.getsockname()[1]; srv.close()
s2 = socket.socket(); s2.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try: s2.bind(('127.0.0.1', port)); s2.listen(1); freed = True
except OSError: freed = False
s2.close()
check('the port is free once the server closes it, with the worker running', freed)

# 10. drive / drive_sync run the same steps
class E(Exception): pass
def steps(x):
    a = yield (pow, (x, 2))
    try: yield (int, ('nope',))
    except ValueError: a += 1
    if x < 0: raise E('negative')
    return a
check('drive_sync', Work.drive_sync(steps(3)) == 10)
check('drive (worker)', run_sync(Work.drive, steps(3)) == 10)
try: run_sync(Work.drive, steps(-3)); check('drive raises', False)
except E: check('drive raises the step generator\'s error', True)

# 11. The server still exits promptly after a worker died (it is restarted
# by systemd after an upgrade; Python waits for pool workers as it exits)
import subprocess
prog = '''
import os, sys, time
sys.path.insert(0, %r)
import bbstub
from bbctrl import Work
pool = Work.run(os.getpid).result(30) and Work._pool
for pr in list(pool._processes.values()): pr.kill()
time.sleep(0.5)
try: Work.run(os.getpid).result(30)
except Exception: pass
Work.run(os.getpid).result(30)
Work.shutdown()                  # and the worker is started again
Work.run(os.getpid).result(30)
sys.exit(0)
''' % os.path.dirname(os.path.abspath(__file__))
t0 = time.time()
try: rc = subprocess.run([sys.executable, '-c', prog], timeout = 30, stdout = subprocess.DEVNULL, stderr = subprocess.DEVNULL).returncode
except subprocess.TimeoutExpired: rc = 'hung'
check('exits promptly after a worker died', rc == 0 and time.time() - t0 < 15, (rc, round(time.time() - t0, 1)))

Work.shutdown()
done()
