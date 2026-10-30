#!/usr/bin/env python3
# Compares two plan_dump.py outputs: same commands in the same order, and
# every number equal (or within --tol, relative).  Exit 0 when they match.
#
#   plan_compare.py old.jsonl new.jsonl [--tol 1e-9]
import sys, json, math

def num(s):
    try: return float(s)
    except (TypeError, ValueError): return None

def main():
    a, b = sys.argv[1], sys.argv[2]
    tol = float(sys.argv[sys.argv.index('--tol') + 1]) if '--tol' in sys.argv else 0
    A, B = open(a).read().splitlines(), open(b).read().splitlines()
    worst, diffs, program = 0.0, 0, None
    exact = 0
    if len(A) != len(B):
        print('DIFFERENT number of lines: %d vs %d' % (len(A), len(B)))
    for i, (x, y) in enumerate(zip(A, B)):
        if i == 0: continue                      # header (python version)
        if x == y:
            exact += 1
            if '"program"' in x: program = json.loads(x)['program']
            continue
        X, Y = json.loads(x), json.loads(y)
        def walk(p, q, where):
            if isinstance(p, dict) and isinstance(q, dict):
                if set(p) != set(q): return False, 'keys %s vs %s' % (sorted(p), sorted(q))
                for k in p:
                    ok, why = walk(p[k], q[k], where + '.' + k)
                    if not ok: return ok, why
                return True, ''
            if isinstance(p, list) and isinstance(q, list):
                if len(p) != len(q): return False, 'length'
                for k, (u, v) in enumerate(zip(p, q)):
                    ok, why = walk(u, v, where + '[%d]' % k)
                    if not ok: return ok, why
                return True, ''
            u, v = num(p), num(q)
            if u is not None and v is not None and isinstance(p, str):
                nonlocal_worst[0] = max(nonlocal_worst[0], rel(u, v))
                if rel(u, v) <= tol: return True, ''
                return False, '%s: %s vs %s' % (where, p, q)
            return (p == q), ('%s: %r vs %r' % (where, p, q))
        nonlocal_worst = [worst]
        ok, why = walk(X, Y, '')
        worst = nonlocal_worst[0]
        if not ok:
            diffs += 1
            if diffs <= 10: print('line %d (%s): %s' % (i + 1, program, why))
    print('%d lines identical, %d differ beyond %g; largest relative number '
          'difference %.3g' % (exact, diffs, tol, worst))
    sys.exit(0 if diffs == 0 and len(A) == len(B) else 1)

def rel(u, v):
    if u == v: return 0.0
    if math.isinf(u) or math.isinf(v) or math.isnan(u) or math.isnan(v): return math.inf
    return abs(u - v) / max(abs(u), abs(v), 1e-12)

if __name__ == '__main__': main()
