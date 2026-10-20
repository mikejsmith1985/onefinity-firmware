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
import concurrent.futures
from concurrent.futures.process import BrokenProcessPool

from tornado import gen


NICE = 10
MAX_RESTARTS = 3

_lock = threading.Lock()
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

    try: os.nice(NICE)
    except OSError: pass

    # Leave with the server
    def watch():
        while True:
            time.sleep(2)
            if os.getppid() != _parent: os._exit(0)
    threading.Thread(target = watch, daemon = True).start()


def _call(fn, args):
    # Runs in the worker
    global _ready
    if not _ready and os.getpid() != _parent:
        _ready = True
        _init_worker()
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


def run(fn, *args):
    '''fn(*args) in the worker.  Returns a concurrent.futures.Future.'''
    global _pool, _restarts
    with _lock:
        while _restarts <= MAX_RESTARTS:
            try: return _process_pool().submit(_call, fn, args)
            except (BrokenProcessPool, OSError, RuntimeError) as e:
                # The worker died (out of memory?) or can't be started
                old, _pool = _pool, None
                _restarts += 1
                _stop(old)
                _note('Worker process unavailable (%s), %s' % (
                    e, 'restarting it' if _restarts <= MAX_RESTARTS
                    else 'using a background thread from now on'))
        return _thread_pool().submit(_call, fn, args)


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
    global _pool, _threads
    with _lock:
        _stop(_pool)
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
