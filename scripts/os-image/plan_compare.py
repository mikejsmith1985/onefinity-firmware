#!/usr/bin/env python3
# Compares two plan_dump.py outputs: same commands in the same order, and
# every number equal (or within --tol, relative).  Exit 0 when they match.
#
#   plan_compare.py old.jsonl new.jsonl [--tol 1e-9] [--show 10]
import sys, json, math


def num(s):
    try: return float(s)
    except (TypeError, ValueError): return None


def rel(u, v):
    if u == v: return 0.0
    if math.isinf(u) or math.isinf(v) or math.isnan(u) or math.isnan(v):
        return math.inf
    return abs(u - v) / max(abs(u), abs(v), 1e-12)


def diff(p, q, where, out):
    "Fills out with (relative difference or None for a structural one, where, p, q)"
    if isinstance(p, dict) and isinstance(q, dict):
        if set(p) != set(q):
            out.append((None, where, sorted(p), sorted(q))); return
        for k in sorted(p): diff(p[k], q[k], where + '.' + k, out)
    elif isinstance(p, list) and isinstance(q, list):
        if len(p) != len(q): out.append((None, where, len(p), len(q))); return
        for k, (u, v) in enumerate(zip(p, q)): diff(u, v, '%s[%d]' % (where, k), out)
    elif isinstance(p, str) and isinstance(q, str) and \
            num(p) is not None and num(q) is not None:
        r = rel(num(p), num(q))
        if r: out.append((r, where, p, q))
    elif p != q: out.append((None, where, p, q))


def main():
    a, b = sys.argv[1], sys.argv[2]
    opt = lambda n, d: type(d)(sys.argv[sys.argv.index(n) + 1]) if n in sys.argv else d
    tol, show = opt('--tol', 0.0), opt('--show', 10)
    A, B = open(a).read().splitlines(), open(b).read().splitlines()
    if len(A) != len(B): print('DIFFERENT number of lines: %d vs %d' % (len(A), len(B)))
    exact = within = beyond = structural = 0
    worst, program, shown = 0.0, None, 0
    for i, (x, y) in enumerate(zip(A, B)):
        if i == 0: continue                      # header (Python version)
        if x.startswith('{"program": '): program = json.loads(x)['program']
        if x == y: exact += 1; continue
        out = []
        diff(json.loads(x), json.loads(y), '', out)
        st = [d for d in out if d[0] is None]
        r = max([d[0] for d in out if d[0] is not None] or [0.0])
        worst = max(worst, r)
        if st: structural += 1
        elif r <= tol: within += 1
        else: beyond += 1
        if (st or r > tol) and shown < show:
            shown += 1
            d = st[0] if st else max((d for d in out if d[0] is not None), key = lambda d: d[0])
            print('line %d (%s) %s: %s vs %s%s' % (i + 1, program, d[1], d[2], d[3],
                  '' if st else '  (relative %.3g)' % d[0]))
    print('%d lines identical; %d differ only in numbers within %g; %d beyond; '
          '%d differ in structure; largest relative number difference %.3g'
          % (exact, within, tol, beyond, structural, worst))
    sys.exit(0 if beyond == 0 and structural == 0 and len(A) == len(B) else 1)


if __name__ == '__main__': main()
