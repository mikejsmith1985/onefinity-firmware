# Start job wizard for the mock controller: runs the real JobPlan.py and
# Flip.py.  stdin: {"action", "file", "text", "index", "measured", "opts"};
# stdout: {"ok": result, "text": written file or absent} or {"err": msg}.
import sys, os, json, tempfile, logging
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, '..', '..', 'py', 'tests'))
import bbstub  # noqa: stubs the controller-only modules
import bbctrl

tmp = tempfile.mkdtemp(prefix='mockwiz-')


class State(object):
    def __init__(self): self.added = []
    def get(self, k, d = None): return {'cycle': 'idle', '2tm': 133}.get(k, d)
    def find_motor(self, axis): return 2 if axis == 'z' else None
    def add_file(self, name): self.added.append(name)


class Log(object):
    def get(self, name): return logging.getLogger(name)


class Ctrl(object):
    def __init__(self):
        self.state = State()
        self.log = Log()
    def get_upload(self, name = ''): return os.path.join(tmp, name)


q = json.load(sys.stdin)
with open(os.path.join(tmp, q['file']), 'w') as f: f.write(q['text'])
ctrl = Ctrl()
try:
    a = q['action']
    if a == 'plan': r = bbctrl.JobPlan(ctrl).plan(q['file'])
    elif a == 'part': r = bbctrl.JobPlan(ctrl).part(q['file'], q.get('index'))
    elif a == 'flip_refs': r = bbctrl.Flip(ctrl).refs(q['file'])
    elif a == 'flip_solve': r = bbctrl.Flip(ctrl).solve(q['file'], q.get('measured') or [], q.get('opts'))
    elif a == 'flip_build': r = bbctrl.Flip(ctrl).build(q['file'], q.get('measured') or [], q.get('opts'))
    else: raise bbctrl.FlipError('Unknown action')
    out = {'ok': r}
    if ctrl.state.added and ctrl.state.added[-1] != q['file']:
        with open(ctrl.get_upload(ctrl.state.added[-1])) as f: out['text'] = f.read()
    print(json.dumps(out))
except (bbctrl.JobPlanError, bbctrl.FlipError) as e:
    print(json.dumps({'err': str(e)}))
