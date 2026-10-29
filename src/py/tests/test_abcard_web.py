# The controller's A/B card API (1.47.0): /api/abcard and the streamed OS file
# upload, against a stand-in ab-card that records how it was called.
#   python3 src/py/tests/test_abcard_web.py
import os, sys, json, tempfile, time, stat
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bbstub import check, done, run_sync
import tornado.web, tornado.httpserver, tornado.httpclient, tornado.gen
from tornado.testing import bind_unused_port
import bbctrl.Web; Web = sys.modules['bbctrl.Web']

tmp = tempfile.mkdtemp()
calls = os.path.join(tmp, 'calls')
fake = os.path.join(tmp, 'ab-card')
open(fake, 'w').write('''#!/bin/bash
echo "$@" >> %s
case "$1" in
  status) echo '{"ab": true, "running": "a"}' ;;
  try) if [ -e %s/refuse ]; then echo "ab-card: Slot B has no system to try" >&2; exit 1; fi ;;
esac
''' % (calls, tmp))
os.chmod(fake, 0o755)
os.environ['PATH'] = tmp + ':' + os.environ['PATH']
Web.AB_DOWNLOADS = os.path.join(tmp, 'os-update')

class Ctrl:
    class args: demo = False
    def __init__(self): self.state = {'cycle': 'idle'}; self.said = []
    @property
    def lcd(self):
        c = self
        class L:
            def goodbye(self, msg): c.said.append(msg)
        return L()
ctrl = Ctrl()
class State(dict):
    def get(self, k, d = None): return dict.get(self, k, d)
ctrl.state = State(cycle = 'idle')

class App(tornado.web.Application):
    def get_ctrl(self, cid = None): return ctrl
app = App([(r'/api/abcard', Web.ABCardHandler),
           (r'/api/abcard/upload', Web.ABCardUploadHandler)])
sock, port = bind_unused_port()
base = 'http://127.0.0.1:%d' % port
@tornado.gen.coroutine
def start():   # on the loop run_sync uses
    global server, client
    server = tornado.httpserver.HTTPServer(app, max_body_size = 16 << 30)
    server.add_sockets([sock])
    client = tornado.httpclient.AsyncHTTPClient()
run_sync(start)

def last_calls():
    try: return open(calls).read().splitlines()
    finally: open(calls, 'w').close()

@tornado.gen.coroutine
def req(path, method = 'GET', body = None, **kw):
    r = yield client.fetch(base + path, method = method, body = body,
                           raise_error = False, request_timeout = 120, **kw)
    return r

def go(*a, **k): return run_sync(lambda: req(*a, **k))

r = go('/api/abcard')
check('status passes ab-card\'s answer through', r.code == 200 and json.loads(r.body)['running'] == 'a', r.body)
last_calls()

r = go('/api/abcard', 'PUT', json.dumps({'action': 'copy'})); time.sleep(0.3)
check('copy starts the job', r.code == 200 and last_calls() == ['copy'], r.body)

r = go('/api/abcard', 'PUT', json.dumps({'action': 'copy'}))
check('a second job right after is refused', r.code == 409, r.body)
Web.ab_spawned[0] = 0
r = go('/api/abcard', 'PUT', json.dumps({'action': 'make', 'device': '/dev/sda', 'size': 31900000000, 'mounted_ok': True})); time.sleep(0.3)
check('make passes the device, the size shown and the mounted ok', r.code == 200 and last_calls() == ['make /dev/sda --yes --size 31900000000 --mounted-ok'])
Web.ab_spawned[0] = 0

r = go('/api/abcard', 'PUT', json.dumps({'action': 'make', 'device': '--help', 'size': 1})); time.sleep(0.3)
check('an option as the device is refused', r.code == 400 and last_calls() == [], r.body)

r = go('/api/abcard', 'PUT', json.dumps({'action': 'fetch', 'url': 'https://x/os.tar', 'sha256': 'ab' * 32})); time.sleep(0.3)
check('fetch passes the URL and checksum', r.code == 200 and last_calls() == ['fetch https://x/os.tar --sha256 ' + 'ab' * 32])
Web.ab_spawned[0] = 0

r = go('/api/abcard', 'PUT', json.dumps({'action': 'try'}))
check('try: restarting shown on the screen', r.code == 200 and ctrl.said == ['Restarting...'] and last_calls() == ['try'])
open(os.path.join(tmp, 'refuse'), 'w').close(); ctrl.said[:] = []
r = go('/api/abcard', 'PUT', json.dumps({'action': 'try'}))
check('try refused: the reason comes back, nothing said on screen',
      r.code == 400 and json.loads(r.body)['message'] == 'Slot B has no system to try' and ctrl.said == [], r.body)
last_calls()

r = go('/api/abcard', 'PUT', json.dumps({'action': 'switch', 'slot': 'c'}))
check('switch to an unknown slot refused', r.code == 400)
r = go('/api/abcard', 'PUT', json.dumps({'action': 'rm'}))
check('unknown action refused', r.code == 400)

ctrl.state['cycle'] = 'running'
r = go('/api/abcard', 'PUT', json.dumps({'action': 'copy'})); time.sleep(0.3)
check('refused while a program runs', r.code == 409 and last_calls() == [], r.body)
r = go('/api/abcard/upload', 'PUT', b'x' * 1000)
check('upload refused while a program runs', r.code == 409)
ctrl.state['cycle'] = 'idle'

# A 300 MB upload, sent in pieces
size = 300 << 20
@tornado.gen.coroutine
def producer(write):
    chunk = b'0123456789abcdef' * 65536
    for i in range(size // len(chunk)): yield write(chunk)
r = run_sync(lambda: req('/api/abcard/upload?sha256=' + 'cd' * 32, 'PUT',
                         body_producer = producer, headers = {'Content-Length': str(size)}))
time.sleep(0.3)
path = os.path.join(Web.AB_DOWNLOADS, 'bundle.tar')
check('upload stored whole', r.code == 200 and os.path.getsize(path) == size, r.body)
check('and handed to ab-card write with the checksum',
      last_calls() == ['write %s --sha256 %s' % (path, 'cd' * 32)])
check('no program can start right after (card being written)', Web.ab_busy())
Web.ab_spawned[0] = 0
check('not busy once the job is over', not Web.ab_busy())
r = go('/api/abcard/upload?sha256=nothex', 'PUT', b'x' * 10)
check('a malformed checksum is refused before the file is taken, with a JSON reason',
      r.code == 400 and json.loads(r.body)['message'].startswith('The checksum') and not os.path.exists(os.path.join(Web.AB_DOWNLOADS, 'bundle.tar.part')))
done()
