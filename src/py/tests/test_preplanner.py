# False "Failed to load file - doesn't appear to be GCode." after an upload (1.31.3).
# The Files tab saves its folder lists right after each upload; that settings save
# dropped (and killed) the new program's half-done plan, and the killed plan was
# logged as a G-code error. Runs the real Preplanner with a stand-in plan.py.
#   python3 src/py/tests/test_preplanner.py
import sys, os, types, tempfile, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bbstub import check, done
import bbctrl
PP = sys.modules['bbctrl.Preplanner']
Config = sys.modules['bbctrl.Config']
from tornado import gen, ioloop

root = tempfile.mkdtemp()
for d in ('upload', 'plans'): os.mkdir(os.path.join(root, d))

# Stand-in for plan.py: a few progress lines (slowly for "SLOW"), fails for "BAD"
fake = os.path.join(root, 'fakeplan.py')
with open(fake, 'w') as f: f.write('''
import sys, time, json, gzip
text = open(sys.argv[1]).read()
if 'BAD' in text: sys.stderr.write('Invalid character'); sys.exit(1)
for i in range(10):
    print(i / 10, flush = True)
    if 'SLOW' in text: time.sleep(0.1)
json.dump({'bounds': {}, 'lines': 1}, open('meta.json', 'w'))
for n in ('positions.gz', 'speeds.gz'): gzip.open(n, 'wb').write(b'x')
''')
bbctrl.get_resource = lambda path: fake if path == 'plan.py' else path

errors = []
class Log:
    def info(s, *a): pass
    def exception(s, msg, *a): errors.append(msg)

loop = ioloop.IOLoop()
ctrl = types.SimpleNamespace(ioloop = loop)
ctrl.log = types.SimpleNamespace(get = lambda name: Log())
ctrl.get_path = lambda n = None: os.path.join(root, n) if n else root
ctrl.get_plan = lambda n = None: os.path.join(root, 'plans', n) if n else os.path.join(root, 'plans')
ctrl.state = types.SimpleNamespace(snapshot = lambda: {'ui': 1})
ctrl.mach = types.SimpleNamespace(planner = types.SimpleNamespace(
    get_config = lambda *a: {'default-units': 'mm', 'max-vel': 1}))
pp = PP.Preplanner(ctrl)
pp.start()

def upload(name, text):
    with open(os.path.join(root, 'upload', name), 'w') as f: f.write(text)

def run(coro): return loop.run_sync(coro, timeout = 30)

# 1. A good program plans, no error
upload('good.nc', 'G0 X1\n')
r = run(lambda: pp.get_plan('good.nc'))
check('good program plans', r is not None and r[0]['lines'] == 1)
check('no error logged', errors == [], errors)

# 2. Upload, the screen asks for the preview, then the folder-list save drops
#    the plans part way (1.31.2 and older: invalidate_all from Config.save)
upload('slow.nc', 'SLOW\n')
@gen.coroutine
def upload_then_save():
    waiting = pp.get_plan('slow.nc')
    yield gen.sleep(0.3)               # planning is under way
    check('plan is running', 0 < pp.get_plan_progress('slow.nc') < 1, pp.get_plan_progress('slow.nc'))
    pp.invalidate_all()                # what a settings save does
    try: data = yield gen.with_timeout(loop.time() + 5, waiting)
    except gen.TimeoutError: data = None # 1.31.2: the waiter was left hanging
    return data
r = run(upload_then_save)
check('the waiting screen still gets the preview', r is not None and r[0]['lines'] == 1)
check('a dropped plan is not reported as a G-code error', errors == [], errors)

# 3. Dropped before the plan even started
upload('slow2.nc', 'SLOW\n')
@gen.coroutine
def drop_at_once():
    waiting = pp.get_plan('slow2.nc')
    yield gen.moment
    pp.invalidate('slow2.nc')
    data = yield waiting
    return data
r = run(drop_at_once)
check('dropped before start: still planned, no error', r is not None and errors == [], errors)

# 4. A file that really is not G-code still shows the error
upload('bad.nc', 'BAD\n')
@gen.coroutine
def bad():
    try: yield gen.with_timeout(loop.time() + 3, pp.get_plan('bad.nc'))
    except gen.TimeoutError: pass
run(bad)
check('real planner failure is still reported', len(errors) == 1 and "doesn't appear to be GCode" in errors[0], errors)

# 5. Saving only the folder lists keeps the plans; any other change drops them
base = {'version': '1.31.3', 'settings': {'units': 'METRIC'}, 'gcode_list': [], 'non_macros_list': []}
lists = dict(base, gcode_list = [{'name': 'default', 'type': 'folder', 'files': [{'file_name': 'a.nc'}]}],
             non_macros_list = [{'file_name': 'a.nc'}])
check('folder lists only: plans kept', Config.plans_same(json.loads(json.dumps(base)), lists))
check('a setting changed: plans dropped', not Config.plans_same(base, dict(lists, settings = {'units': 'IMPERIAL'})))
check('no saved config yet: plans dropped', not Config.plans_same(None, base))

done()
