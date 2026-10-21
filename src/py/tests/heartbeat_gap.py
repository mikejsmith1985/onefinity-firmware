# Heartbeat-gap harness (1.31.2).
#
# Runs the controller's real websocket handler (heartbeat every 3 s) and the
# real G-code check, and Cut deeper handlers in a Tornado server
# process, connects a websocket client like a screen does, asks for the
# whole-file work on a large program from two "screens" at once, and reports
# the longest gap between messages the client saw.  The screens give up
# after 20 s of silence (8 s up to 1.31.1).
#
#   python3 src/py/tests/heartbeat_gap.py            # async handlers (1.31.2)
#   python3 src/py/tests/heartbeat_gap.py --sync     # the 1.31.1 handlers
#   options: --lines N (default 170000), --check (exit 1 if the gap > 3.6 s)
import sys, os, time, json, types, argparse, subprocess, tempfile, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def make_program(path, n):
    random.seed(1)
    with open(path, 'w') as f:
        f.write('(SETUP stock: x=0..300 y=0..150 z=-20..0)\nG21\nG90\nG54\nT1 M6\nS18000 M3\nG0 Z15\nG0 X0 Y0\n')
        for i in range(n):
            if i % 10 == 0:
                f.write('G2 X%.3f Y%.3f I%.3f J%.3f F1500\n' % (random.uniform(0, 300), random.uniform(0, 150),
                                                               random.uniform(-5, 5), random.uniform(-5, 5)))
            else:
                f.write('G1 X%.3f Y%.3f Z%.3f\n' % (random.uniform(0, 300), random.uniform(0, 150), random.uniform(-3, 0)))
        f.write('G0 Z15\nM5\nM30\n')


def server(mode, port, upload):
    import bbstub, bbctrl
    from bbctrl import Lint
    Web = sys.modules['bbctrl.Web']
    import tornado.web, tornado.ioloop
    from tornado.escape import url_unescape

    class Log:
        def get(self, name): return self
        def info(self, *a): pass
        warning = error = exception = debug = info
        def add_listener(self, l): pass
        def remove_listener(self, l): pass

    state = types.SimpleNamespace(vars={'cycle': 'idle'})
    state.get = lambda k, d=None: state.vars.get(k, d)
    state.add_listener = lambda l: None
    state.remove_listener = lambda l: None
    state.is_axis_homed = lambda a: True
    state.find_motor = lambda a: None
    state.add_file = lambda n: None
    ctrl = types.SimpleNamespace(log=Log(), state=state, checkpoint=None, config={})
    ctrl.get_upload = lambda n=None: os.path.join(upload, n) if n else upload
    ctrl.get_path = lambda d=None, f=None: os.path.join(upload, d) if d else upload

    class App(tornado.web.Application):
        def get_ctrl(self, id=None): return ctrl
        def opened(self, c): pass
        def closed(self, c): pass

    # The 1.31.1 handlers: the work on the IO loop, the check from scratch
    class SyncLint(Web.LintHandler):
        def get(self, filename):
            path = self.get_upload(url_unescape(filename))
            Lint.clear_cache()
            self.write_json(Lint.lint_file(path))
    class SyncDoOver(bbctrl.APIHandler):
        def put(self):
            self.write_json(bbctrl.DoOver(ctrl).analyse(self.json['file']))
    class FreshLint(Web.LintHandler):
        def get(self, filename):
            Lint.clear_cache()  # every request a new check, like a new upload
            return super().get(filename)

    sync = mode == 'sync'
    app = App([
        (r'/websocket', Web.WSConnection),
        (r'/api/lint/([^/]+)', SyncLint if sync else FreshLint),
        (r'/api/next-doover', SyncDoOver if sync else Web.DoOverHandler),
    ])
    app.ioloop = tornado.ioloop.IOLoop.current()
    app.listen(port, address='127.0.0.1')
    bbctrl.Work.warm()
    print('ready', flush=True)
    tornado.ioloop.IOLoop.current().start()


def client(port, name, quiet_before=7, quiet_after=7):
    import tornado.ioloop, tornado.websocket, tornado.httpclient
    from tornado import gen
    times, reqs = [], []

    @gen.coroutine
    def listen(ws):
        while True:
            m = yield ws.read_message()
            if m is None: break
            times.append(time.time())

    @gen.coroutine
    def req(method, path, body=None):
        t0 = time.time()
        cl = tornado.httpclient.AsyncHTTPClient()
        r = yield cl.fetch('http://127.0.0.1:%d%s' % (port, path), method=method, body=body,
                           request_timeout=600, raise_error=False)
        reqs.append((path if method == 'GET' else json.loads(body)['action'], r.code, time.time() - t0, t0))

    @gen.coroutine
    def main():
        ws = yield tornado.websocket.websocket_connect('ws://127.0.0.1:%d/websocket' % port)
        listen(ws)
        yield gen.sleep(quiet_before)
        start = time.time()
        # Two screens check the program at once, then Cut deeper
        yield [req('GET', '/api/lint/' + name), req('GET', '/api/lint/' + name)]
        yield req('PUT', '/api/next-doover', json.dumps({'action': 'analyse', 'file': name}))
        busy = time.time() - start
        yield gen.sleep(quiet_after)
        ws.close()
        return start, busy

    start, busy = tornado.ioloop.IOLoop.current().run_sync(main, timeout=1800)
    gaps = [b - a for a, b in zip(times, times[1:])]
    return {'messages': len(times), 'max_gap': max(gaps) if gaps else None,
            'busy': busy, 'requests': reqs}


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--sync', action='store_true')
    ap.add_argument('--lines', type=int, default=170000)
    ap.add_argument('--port', type=int, default=8931)
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--server', nargs=2)
    a = ap.parse_args()
    if a.server: server(a.server[0], a.port, a.server[1]); sys.exit(0)

    up = tempfile.mkdtemp()
    name = 'big-%d.nc' % a.lines
    make_program(os.path.join(up, name), a.lines)
    size = os.path.getsize(os.path.join(up, name))
    mode = 'sync' if a.sync else 'async'
    p = subprocess.Popen([sys.executable, os.path.abspath(__file__), '--server', mode, up, '--port', str(a.port)],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True)
    try:
        line = p.stdout.readline()
        if 'ready' not in line: print(line + p.stdout.read()); sys.exit(2)
        r = client(a.port, name)
    finally:
        p.terminate(); p.wait()
    # The worker process must not outlive the server or keep its port
    import socket
    t0, freed = time.time(), False
    while time.time() - t0 < 5 and not freed:
        s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try: s.bind(('127.0.0.1', a.port)); s.listen(1); freed = True
        except OSError: time.sleep(0.2)
        finally: s.close()
    time.sleep(2.5)
    left = subprocess.run(['pgrep', '-f', 'heartbeat_gap.py --server %s %s' % (mode, up)],
                          stdout=subprocess.PIPE, universal_newlines=True).stdout.split()
    print('port free after the server stopped: %s (%.1f s); worker processes left after 2.5 s: %d'
          % (freed, time.time() - t0 - 2.5, len(left)))
    print('%s handlers, %d-line program (%.1f MB): %d messages, longest gap %.2f s, '
          'work took %.1f s' % (mode, a.lines, size / 1e6, r['messages'], r['max_gap'], r['busy']))
    for what, code, dt, _ in r['requests']: print('  %-28s HTTP %d in %.2f s' % (what, code, dt))
    if a.check:
        ok = r['max_gap'] is not None and r['max_gap'] <= 3.6 and all(c == 200 for _, c, _, _ in r['requests']) and freed and not left
        print('PASS' if ok else 'FAIL', 'longest heartbeat gap <= 3.6 s, every request answered, worker gone with the server')
        sys.exit(0 if ok else 1)
