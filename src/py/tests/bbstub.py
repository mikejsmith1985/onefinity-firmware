# Import the controller's bbctrl package on a PC: the hardware and planner
# modules that only exist on the controller are replaced with stubs.
#   import bbstub; import bbctrl
import sys, os, types, importlib.abc, importlib.machinery
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

class _Stub(types.ModuleType):
    def __getattr__(self, name):
        if name.startswith('__'): raise AttributeError(name)
        return type(name, (object,), {'__init__': lambda s, *a, **k: None})
class _Finder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    MISSING = ('pyudev', 'evdev', 'iw_parse', 'smbus', 'sockjs', 'camotics', 'gplan', 'smbus', 'smbus2', 'RPi', 'pwd')
    def find_spec(self, name, path, target=None):
        if name.split('.')[0] in self.MISSING:
            return importlib.machinery.ModuleSpec(name, self, is_package=True)
    def create_module(self, spec): return _Stub(spec.name)
    def exec_module(self, m): pass
sys.meta_path.insert(0, _Finder())
import tornado.websocket, tornado.web, tornado.ioloop
tornado.web.asynchronous = getattr(tornado.web, "asynchronous", lambda f: f)  # old tornado API used by Camera.py
import warnings; warnings.filterwarnings('ignore')

ok = True
def check(name, cond, msg=''):
    global ok
    print(('PASS ' if cond else 'FAIL ') + name, msg)
    ok = ok and bool(cond)
    return cond

def done():
    print('ALL PASS' if ok else 'SOME FAILED'); sys.exit(0 if ok else 1)
