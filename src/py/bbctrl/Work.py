# Whole-file work off the web server's IO loop (1.31.2).
#
# The web server, the websocket heartbeats every screen depends on, and the
# machine state updates all run on one Tornado IO loop.  Checking or
# rewriting a large program in Python on the Raspberry Pi takes seconds (a
# 50,000 line program about 8 s, 170,000 lines about 30 s).  Done on the IO
# loop, that silenced the heartbeats and every screen showed "Lost connection
# to the controller".
#
# run(fn, *args) runs fn(*args) in one separate worker process and returns a
# concurrent.futures.Future that a Tornado coroutine can yield.  A separate
# process, not a thread: the work is pure Python, so a thread would share the
# interpreter lock with the IO loop, while a process runs on another of the
# Pi's four cores and is niced so it never competes with the planner.  fn
# must be a module level function and its arguments and result must pickle
# (paths, numbers, dicts and lists).  The worker never touches the
# controller: callers read what they need from it before, and change it
# after, on the IO loop.
#
# Jobs are sent to the worker one at a time, a screen's jobs first (1.31.4).
# Up to 1.31.3 they went in the order they were asked for, so the Run check
# waited behind the G-code check of every program uploaded just before it.  run() is for work a screen is waiting for,
# run_background() for work done ahead of time (the check of a new upload),
# and promote() moves a background job ahead when a screen asks for it.  The
# worker runs a screen's job at NICE_FG and background jobs at NICE, both
# below the server (bbctrl.service runs it at -10, so NICE_FG is still ahead
# of the touchscreen browser and the preview planner, which run at 0).
#
# If a worker process can't be started, or keeps dying, the work runs in a
# background thread instead (slower to answer, but still off the IO loop).
#
# Code that must also run without an IO loop (tests, the simulators) is
# written once as a generator that yields (fn, args) for each heavy step:
#   drive(gen)       runs it from a Tornado coroutine, each step in the worker
#   drive_sync(gen)  runs it directly, each step in the calling thread

import os
import stat
import atexit
import time
import threading
import collections
import json
import hashlib
import concurrent.futures
from concurrent.futures.process import BrokenProcessPool

from tornado import gen


NICE = 10           # background jobs, relative to the server
NICE_FG = 5         # jobs a screen waits for (1.31.4; 10 in 1.31.2-1.31.3)
MAX_RESTARTS = 3

_lock = threading.RLock()
_fg = collections.deque()   # jobs waiting for the worker, a screen's first
_bg = collections.deque()
_busy = None                # the job in the worker
_loop = None                # the server's IO loop, to start the next job on
_base = None                # the server's nice value (in the worker)
_pool = None
_threads = None
_restarts = 0
_parent = os.getpid()
_ready = False
log = None          # set by the web server to a bbctrl logger


def _note(msg):
    try:
        if log is not None: log.warning(msg)
    except Exception: pass


def _init_worker():
    # Runs once in a new worker process, as its first job.  The worker is
    # forked from the server, so it starts with copies of the server's open
    # sockets: the web port and every screen's connection.  Holding those
    # would keep port 80 busy after the server stops (bbctrl.service has
    # KillMode=process, so systemd only stops the server) and would stop a
    # connection the server closes from really closing.  Each socket is
    # replaced with /dev/null (not closed, so its number is not reused).
    try:
        null = os.open(os.devnull, os.O_RDWR)
        for name in os.listdir('/proc/self/fd'):
            fd = int(name)
            if fd <= 2 or fd == null: continue
            try:
                if stat.S_ISSOCK(os.fstat(fd).st_mode): os.dup2(null, fd)
            except OSError: pass
    except OSError: pass

    global _base
    _base = os.getpriority(os.PRIO_PROCESS, 0)
    _renice(NICE_FG)

    # Leave with the server
    def watch():
        while True:
            time.sleep(2)
            if os.getppid() != _parent: os._exit(0)
    threading.Thread(target = watch, daemon = True).start()


def _renice(n):
    # n relative to the server.  Going back down (background job, then a
    # screen's) needs root, as on the controller; without it every job runs
    # at NICE_FG.
    if _base is None: return
    if n > NICE_FG and os.geteuid() != 0: n = NICE_FG
    try:
        if os.getpriority(os.PRIO_PROCESS, 0) != _base + n:
            os.setpriority(os.PRIO_PROCESS, 0, _base + n)
    except OSError: pass


def _call(fn, args, nice = None):
    # Runs in the worker
    global _ready
    if os.getpid() != _parent:
        if not _ready:
            _ready = True
            _init_worker()
        if nice is not None: _renice(nice)
    return fn(*args)


def _thread_pool():
    global _threads
    if _threads is None:
        _threads = concurrent.futures.ThreadPoolExecutor(max_workers = 1)
    return _threads


def _process_pool():
    global _pool
    if _pool is None:
        _pool = concurrent.futures.ProcessPoolExecutor(max_workers = 1)
        _pool.submit(_call, _noop, ())  # the worker's first job: _init_worker()
    return _pool


def mode():
    '''"process", "thread" or "idle" (no work run yet).'''
    if _restarts > MAX_RESTARTS: return 'thread'
    return 'process' if _pool is not None else 'idle'


SLOW = 3            # s: a job that took longer is logged (1.31.4)


class _Job(object):
    __slots__ = ('fn', 'args', 'bg', 'future', 'queued', 'started')
    def __init__(self, fn, args, bg):
        self.fn, self.args, self.bg = fn, args, bg
        self.future = concurrent.futures.Future()
        self.queued = time.time()
        self.started = None


def _log_slow(job, ended):
    if log is None or ended - job.queued < SLOW: return
    name = getattr(job.fn, '__name__', 'job')
    arg = os.path.basename(job.args[0]) if job.args and isinstance(job.args[0], str) else ''
    try:
        log.info('%s %s: waited %.1f s for the worker, ran %.1f s (%s)' % (
            name, arg, job.started - job.queued, ended - job.started,
            'background' if job.bg else 'screen'))
    except Exception: pass


def _submit(fn, args, nice):
    # Hands one job to the worker (or the thread).  Starting a worker forks
    # the server, so it is done from the thread that asked (the IO loop),
    # never from the pool's own thread; see _finished().
    global _pool, _restarts
    with _lock:
        while _restarts <= MAX_RESTARTS:
            try: return _process_pool().submit(_call, fn, args, nice)
            except (BrokenProcessPool, OSError, RuntimeError) as e:
                # The worker died (out of memory?) or can't be started
                old, _pool = _pool, None
                _restarts += 1
                _stop(old)
                _note('Worker process unavailable (%s), %s' % (
                    e, 'restarting it' if _restarts <= MAX_RESTARTS
                    else 'using a background thread from now on'))
        return _thread_pool().submit(_call, fn, args)


def _pump():
    # Starts the next job if the worker is free: a screen's first
    global _busy
    while True:
        failed = None
        with _lock:
            if _busy is not None: return
            if _fg: job = _fg.popleft()
            elif _bg: job = _bg.popleft()
            else: return
            if not job.future.set_running_or_notify_cancel(): continue
            _busy = job
            job.started = time.time()
            try: inner = _submit(job.fn, job.args, NICE if job.bg else NICE_FG)
            except BaseException as e:
                _busy = None
                failed = e
        if failed is not None:
            job.future.set_exception(failed)
            continue
        inner.add_done_callback(lambda f, job = job: _finished(job, f))
        return


def _loop_running(loop):
    a = getattr(loop, 'asyncio_loop', None)
    if a is not None:
        try: return a.is_running() and not a.is_closed()
        except Exception: return False
    return True


def _finished(job, inner):
    # Runs in the pool's thread (or at once, in the thread that sent it)
    global _busy
    with _lock:
        if _busy is job: _busy = None
    ended = time.time()
    try: res = inner.result()
    except BaseException as e: job.future.set_exception(e)
    else: job.future.set_result(res)
    # The next job is started on the IO loop when there is one running: a
    # worker that died is restarted there, and the pool's own thread is not
    # used to send it work.
    loop = _loop
    if loop is not None and _loop_running(loop):
        try:
            loop.add_callback(_log_slow, job, ended)  # the log is the IO loop's
            loop.add_callback(_pump)
            return
        except Exception: pass
    _pump()


def _enqueue(fn, args, bg):
    global _loop
    try:
        from tornado.ioloop import IOLoop
        loop = IOLoop.current(instance = False)
        if loop is not None: _loop = loop
    except Exception: pass
    job = _Job(fn, args, bg)
    with _lock: (_bg if bg else _fg).append(job)
    _pump()
    return job.future


def run(fn, *args):
    '''fn(*args) in the worker, for a screen that waits for it: ahead of
    background work.  Returns a concurrent.futures.Future.'''
    return _enqueue(fn, args, False)


def run_background(fn, *args):
    '''fn(*args) in the worker when no screen is waiting for it (1.31.4).'''
    return _enqueue(fn, args, True)


def promote(future):
    '''A screen now waits for this background job: it goes next, or, if
    the worker already has it, the worker is given a screen job's priority
    for the rest of it.  True if the job was found.'''
    with _lock:
        for job in _bg:
            if job.future is future:
                _bg.remove(job)
                job.bg = False
                _fg.append(job)
                return True
        job = _busy
        if job is None or job.future is not future: return False
        if job.bg:
            job.bg = False
            _renice_worker(NICE_FG)
        return True


def _renice_worker(n):
    # From the server, which may raise the worker's priority (it is root on
    # the controller); the worker's next job sets its own again
    pool = _pool
    try:
        base = os.getpriority(os.PRIO_PROCESS, 0)
        for pid in list((getattr(pool, '_processes', None) or {}).keys()):
            os.setpriority(os.PRIO_PROCESS, pid, base + n)
    except Exception: pass


def waiting():
    '''(screen jobs, background jobs) waiting for the worker.'''
    with _lock: return len(_fg), len(_bg)


def done(value):
    '''A Future that already has value, for answers that need no work.'''
    f = concurrent.futures.Future()
    f.set_result(value)
    return f


def _noop(): return os.getpid()


def warm():
    '''Start the worker early, while the server is quiet.'''
    try: run(_noop)
    except Exception: pass


def _stop(pool):
    # Stop a pool without waiting for it.  A worker process is ended too: a
    # pool whose worker died can leave the other one waiting forever for work,
    # and Python waits for every worker before it exits, which would hold up
    # the server's restart.
    if pool is None: return
    procs = list((getattr(pool, '_processes', None) or {}).values())
    try: pool.shutdown(wait = False)  # forgets its processes on some Pythons
    except Exception: pass
    for p in procs:
        try: p.terminate()
        except Exception: pass


def shutdown():
    '''Stop the worker now.  The server calls this as it exits.'''
    global _pool, _threads, _busy
    with _lock:
        _stop(_pool)
        _busy = None  # a job the stopped worker had is not waited for
        if _threads is not None:
            try: _threads.shutdown(wait = False)
            except Exception: pass
        _pool = _threads = None


# Registered after concurrent.futures, so it runs before Python waits for the
# workers
atexit.register(shutdown)


@gen.coroutine
def drive(g):
    '''Run a step generator from a Tornado coroutine.'''
    try: req = next(g)
    except StopIteration as e: return e.value
    while True:
        fn, args = req
        try: value = yield run(fn, *args)
        except Exception as e:
            try: req = g.throw(e)
            except StopIteration as s: return s.value
            continue
        try: req = g.send(value)
        except StopIteration as s: return s.value


def drive_sync(g):
    '''Run a step generator directly.'''
    try: req = next(g)
    except StopIteration as e: return e.value
    while True:
        fn, args = req
        try: value = fn(*args)
        except Exception as e:
            try: req = g.throw(e)
            except StopIteration as s: return s.value
            continue
        try: req = g.send(value)
        except StopIteration as s: return s.value


class FileCache(object):
    '''Results of fn(path) for whole files, worked out in the worker and kept
    until the file changes (its modification time or size), the most
    recently used `size` files (1.31.4, from Lint's cache of 1.31.2).  One
    job per file version however many ask; a screen asking for a file whose
    job is still queued in the background moves it ahead.'''

    def __init__(self, fn, size = 32, disk = None):
        self.fn = fn
        self.size = size
        self.lock = threading.Lock()
        self.results = collections.OrderedDict()  # path -> (key, result)
        self.inflight = {}                        # (path, key) -> Future
        # disk: a name to also keep results in cache/<name>/ beside the
        # upload folder, so a restart doesn't mean checking every program
        # again (1.31.5: a 50,000 line program took 15 s after each restart
        # before Run showed its checklist).  Results must be JSON.
        self.disk = disk
        self._dirs = set()                        # cache folders written to


    def _disk_path(self, path):
        if not self.disk: return None
        base = os.path.dirname(os.path.dirname(os.path.abspath(path)))
        name = hashlib.sha1(os.path.basename(path).encode('utf-8')).hexdigest()
        folder = os.path.join(base, 'cache', self.disk)
        self._dirs.add(folder)
        return os.path.join(folder, name + '.json')


    def _disk_load(self, path, key):
        p = self._disk_path(path)
        if not p: return None
        try:
            with open(p, 'r', encoding = 'utf-8') as f: d = json.load(f)
            if d.get('path') == os.path.basename(path) and \
                    list(d.get('key') or []) == list(key):
                return d.get('result')
        except (OSError, ValueError, TypeError, AttributeError): pass
        return None


    def _disk_save(self, path, key, res):
        p = self._disk_path(path)
        if not p: return
        try:
            os.makedirs(os.path.dirname(p), exist_ok = True)
            tmp = p + '.tmp'
            with open(tmp, 'w', encoding = 'utf-8') as f:
                json.dump({'path': os.path.basename(path), 'key': list(key),
                           'result': res}, f)
            os.replace(tmp, p)
            self._disk_prune(os.path.dirname(p))
        except (OSError, TypeError, ValueError): pass


    def _disk_prune(self, folder, keep = 200):
        try:
            names = [os.path.join(folder, n) for n in os.listdir(folder)
                     if n.endswith('.json')]
            if len(names) <= keep: return
            names.sort(key = lambda n: os.stat(n).st_mtime)
            for n in names[:len(names) - keep]: os.unlink(n)
        except OSError: pass


    @staticmethod
    def key(path):
        st = os.stat(path)
        return (st.st_mtime, st.st_size)


    def store(self, path, key, res, save = True):
        with self.lock:
            self.results[path] = (key, res)
            self.results.move_to_end(path)
            while len(self.results) > self.size: self.results.popitem(last = False)
        if save: self._disk_save(path, key, res)


    def cached(self, path):
        '''The result for the file as it is now, or None.  Raises OSError if
        it can't be read.'''
        key = self.key(path)
        with self.lock:
            hit = self.results.get(path)
            if hit and hit[0] == key:
                self.results.move_to_end(path)
                return hit[1]
        res = self._disk_load(path, key)
        if res is not None:
            self.store(path, key, res, save = False)
            return res


    def remember(self, path, res):
        try: self.store(path, self.key(path), res)
        except OSError: pass


    def get(self, path):
        '''In the calling thread.'''
        key = self.key(path)
        hit = self.cached(path)
        if hit is not None: return hit
        res = self.fn(path)
        self.store(path, key, res)
        return res


    def get_async(self, path, background = False):
        '''A concurrent.futures.Future: done at once for a cached file, failing
        with OSError if the file can't be read.'''
        try:
            key = self.key(path)
            hit = self.cached(path)
        except OSError as e:
            f = concurrent.futures.Future()
            f.set_exception(e)
            return f
        if hit is not None: return done(hit)

        with self.lock:
            hit = self.results.get(path)  # finished since cached() looked
            if hit and hit[0] == key: return done(hit[1])
            f = self.inflight.get((path, key))
            if f is not None:
                if not background: promote(f)
                return f
            f = (run_background if background else run)(self.fn, path)
            self.inflight[(path, key)] = f

        def finished(f):
            with self.lock: self.inflight.pop((path, key), None)
            try:
                if not f.cancelled() and f.exception() is None:
                    self.store(path, key, f.result())
            except Exception: pass

        f.add_done_callback(finished)
        return f


    def in_flight(self):
        with self.lock: return len(self.inflight)


    def clear(self):
        '''Forget every result, the ones kept on disk too.'''
        with self.lock:
            self.results.clear()
            dirs, self._dirs = self._dirs, set()
        for d in dirs:
            try:
                for n in os.listdir(d):
                    if n.endswith('.json'): os.unlink(os.path.join(d, n))
            except OSError: pass
