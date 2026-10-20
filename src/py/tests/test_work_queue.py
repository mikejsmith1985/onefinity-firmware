# A screen's work goes ahead of background work in the worker (1.31.4).
# Up to 1.31.3 the worker took jobs in the order they were asked for, so the
# Start job wizard's first page waited for the G-code check of every program
# uploaded before it (on the controller: tens of seconds after uploading the
# four programs of a job).
#   python3 src/py/tests/test_work_queue.py
import sys, os, time, json, types, tempfile, shutil, glob
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bbstub import check, done, run_sync
import bbctrl
from bbctrl import Lint, Work
JobPlanMod = sys.modules['bbctrl.JobPlan']
Web = sys.modules['bbctrl.Web']
FileHandlerMod = sys.modules['bbctrl.FileHandler']
from tornado import gen
import tornado.web, tornado.httpclient, tornado.ioloop

def slow(tag, s):
    time.sleep(s)
    return tag, time.time()

def nice_now(): return os.getpriority(os.PRIO_PROCESS, 0)

def nice_later(s):
    time.sleep(s)
    return os.getpriority(os.PRIO_PROCESS, 0)

Work.run(os.getpid).result(30)  # worker up

# 1. A screen's job overtakes queued background jobs
bg = [Work.run_background(slow, 'bg%d' % i, 0.4) for i in range(4)]
time.sleep(0.1)  # bg0 is in the worker
fg = Work.run(slow, 'fg', 0.01)
tag, t_fg = fg.result(30)
ends = sorted((f.result(30)[1], f.result(30)[0]) for f in bg)
check('the screen\'s job runs right after the job already in the worker',
      t_fg < ends[1][0] and ends[0][1] == 'bg0', [e[1] for e in ends])
check('background jobs still all run, in order', [e[1] for e in ends] == ['bg0', 'bg1', 'bg2', 'bg3'])
check('nothing left waiting', Work.waiting() == (0, 0), Work.waiting())

# 2. promote(): a background job a screen now waits for goes next
bg = [Work.run_background(slow, 'bg%d' % i, 0.3) for i in range(4)]
time.sleep(0.05)
check('a queued background job can be moved ahead', Work.promote(bg[3]))
check('a job already in the worker is found too', Work.promote(bg[0]))
order = [t for _, t in sorted((f.result(30)[1], f.result(30)[0]) for f in bg)]
check('promoted job runs next', order == ['bg0', 'bg3', 'bg1', 'bg2'], order)

# 3. Screen jobs and background jobs at their own priority
base = os.getpriority(os.PRIO_PROCESS, 0)
check('screen job at NICE_FG', Work.run(nice_now).result(30) == base + Work.NICE_FG)
want = base + (Work.NICE if os.geteuid() == 0 else Work.NICE_FG)  # going back down needs root
check('background job at NICE (as root; NICE_FG without root)', Work.run_background(nice_now).result(30) == want)
check('screen job back at NICE_FG after a background one', Work.run(nice_now).result(30) == base + Work.NICE_FG)

# A background job a screen waits for while it runs gets a screen job's
# priority (the server can only raise it as root, as on the controller)
f = Work.run_background(nice_later, 0.5)
time.sleep(0.2)
Work.promote(f)
check('promoted while running: the rest of it at NICE_FG (as root)', os.geteuid() != 0 or f.result(30) == base + Work.NICE_FG, f.result(30))
check('next background job back at its own priority', Work.run_background(nice_now).result(30) == want)

# 4. The G-code check of an upload is background work; a screen asking for
# it moves it ahead, and shares it
tmp = tempfile.mkdtemp()
def put(name, lines):
    p = os.path.join(tmp, name)
    with open(p, 'w') as f:
        f.write('(SETUP stock: x=0..300 y=0..150 z=-20..0)\nG21\nG90\nG54\nT1 M6\nS18000 M3\nG0 Z15\n')
        for i in range(lines): f.write('G1 X%.3f Y%.3f Z-1 F1500\n' % (i % 300 * 0.5, i % 150 * 0.5))
        f.write('G0 Z15\nM5\nM30\n')
    return p
progs = [put('p%d.nc' % i, 60000) for i in range(4)]
Lint.clear_cache()
blocker = Work.run_background(slow, 'blocker', 0.5)
bgs = [Lint.lint_file_async(p, background = True) for p in progs]
f = Lint.lint_file_async(progs[3])
check('a screen asking for a queued check gets the same job', f is bgs[3])
f.result(60)
check('...and it ran before the checks uploaded before it', not bgs[1].done() or not bgs[2].done(),
      [b.done() for b in bgs])
for b in bgs: b.result(60)
check('every check done and cached', all(Lint.cached(p) is not None for p in progs))

# 5. The wizard's plan is cached per file version
calls = []
real_run = Work.run
def counting_run(fn, *a):
    calls.append(fn.__name__); return real_run(fn, *a)
Work.run = counting_run
ctrl = types.SimpleNamespace(log = types.SimpleNamespace(get = lambda n: None),
                             state = types.SimpleNamespace(get = lambda k, d = None: 'idle'),
                             get_upload = lambda n = None: os.path.join(tmp, n) if n else tmp)
jp = bbctrl.JobPlan(ctrl)
a = run_sync(jp.plan_async, 'p0.nc')
b = run_sync(jp.plan_async, 'p0.nc')
check('plan worked out once per file version', calls.count('_plan_job') == 1, calls)
check('plan answer names the file and matches the direct plan', a == b and a['file'] == 'p0.nc' and
      a == dict(JobPlanMod.summary(open(progs[0]).read().splitlines()), file = 'p0.nc'))
os.utime(progs[0], (time.time() + 5, time.time() + 5))
run_sync(jp.plan_async, 'p0.nc')
check('a changed file is planned again', calls.count('_plan_job') == 2, calls)
Work.run = real_run

# 6. The real server: upload four programs, then open the wizard on the
# first.  Its plan request must not wait for the checks of all four.
up = tempfile.mkdtemp()
state = types.SimpleNamespace(vars = {'cycle': 'idle'})
state.get = lambda k, d = None: state.vars.get(k, d)
state.add_file = lambda n: None
state.select_file = lambda n: state.vars.__setitem__('selected', n)
class Log:
    def get(self, n): return self
    def info(self, *a, **k): pass
    warning = error = exception = debug = info
ctrl = types.SimpleNamespace(log = Log(), state = state, preplanner = types.SimpleNamespace(invalidate = lambda n: None))
ctrl.get_upload = lambda n = None: os.path.join(up, n) if n else up
class App(tornado.web.Application):
    def get_ctrl(self, id = None): return ctrl

big = [put('big%d.nc' % i, 150000) for i in range(4)]
Lint.clear_cache(); JobPlanMod._plans.clear()

@gen.coroutine
def scenario():
    app = App([(r'/api/file(/.+)?', FileHandlerMod.FileHandler),
               (r'/api/lint/([^/]+)', Web.LintHandler),
               (r'/api/next-wizard', Web.WizardHandler)])
    srv = app.listen(0, address = '127.0.0.1')
    port = list(srv._sockets.values())[0].getsockname()[1]
    cl = tornado.httpclient.AsyncHTTPClient()
    u = lambda p: 'http://127.0.0.1:%d%s' % (port, p)
    t0 = time.time()
    for p in big:
        with open(p, 'rb') as f: body = f.read()
        r = yield cl.fetch(u('/api/file/' + os.path.basename(p)), method = 'PUT', body = body)
    uploaded = time.time()
    # Work queued behind the first check: three more checks and three plans
    queued = Work.waiting()
    t = time.time()
    r = yield cl.fetch(u('/api/next-wizard'), method = 'PUT',
                       body = json.dumps({'action': 'plan', 'file': 'big0.nc'}), request_timeout = 300)
    wizard = time.time() - t
    srv.stop()
    return queued, wizard, json.loads(r.body)

one = time.time(); Lint._lint_path(big[0]); one = time.time() - one
queued, wizard, res = run_sync(scenario)
for p in big: Lint.lint_file_async(p).result(120)
check('uploads queue their checks and plans in the background', queued[1] >= 5, queued)
check('wizard plan answered (%.2f s; one check takes %.2f s, all queued work about %.1f s)'
      % (wizard, one, one * 8), res.get('file') == 'big0.nc' and wizard < one * 3, round(wizard, 2))
check('...and the uploaded programs\' checks all finished afterwards', all(Lint.cached(p) is not None for p in big))

Work.shutdown()
shutil.rmtree(tmp, ignore_errors = True); shutil.rmtree(up, ignore_errors = True)
done()
