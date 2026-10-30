#!/usr/bin/env python3
# Runs G-code through the CAMotics planner (camotics.gplan) and writes every
# command it produces, one JSON line each, so two planner builds can be
# compared move for move (scripts/os-image/plan_compare.py).
#
#   plan_dump.py <controller config.json> <out.jsonl> <program.nc> [...]
#
# Written for Python 3.5 too: the reference run uses the 2017 planner, which
# only loads in Raspbian Stretch's Python 3.5.
import sys, json
import camotics.gplan as gplan


def planner_config(c):
    "The planner settings the controller builds (Planner.get_config, no MDI)"
    vm, am, jm = {}, {}, {}
    for m in c.get('motors', []):
        axis = m.get('axis', '').lower()
        if not axis or axis in vm or not m.get('enabled', True): continue
        vm[axis] = m.get('max-velocity', 5) * 1000
        am[axis] = m.get('max-accel', 750) * 1000000
        jm[axis] = m.get('max-jerk', 750) * 1000000
    s = c.get('settings', {})
    dev = s.get('max-deviation', 0.1)
    return {
        'default-units': 'METRIC', 'max-vel': vm, 'max-accel': am,
        'max-jerk': jm, 'rapid-auto-off': False, 'max-blend-error': dev,
        'max-merge-error': dev, 'max-arc-error': dev / 10,
        'junction-accel': s.get('junction-accel', 200000),
        # No soft limits: the programs start wherever, and limits are not
        # what is being compared
    }


def clean(x):
    "JSON-safe, with floats as exact repr strings"
    if isinstance(x, float):
        return repr(x)
    if isinstance(x, dict): return dict((k, clean(v)) for k, v in x.items())
    if isinstance(x, (list, tuple)): return [clean(v) for v in x]
    return x


def dump(cfg, path, out):
    p = gplan.Planner()
    p.set_resolver(lambda name, units: 0)
    p.set_logger(lambda line: None, 1, 'LinePlanner:3')
    p.load(path, cfg)
    n = 0
    while p.has_more():
        cmd = p.next()
        p.set_active(cmd['id'])
        # As plan.py does: there is no machine to wait for, so answer at once
        if p.is_synchronizing(): p.synchronize(0)
        out.write(json.dumps(clean(cmd), sort_keys = True) + '\n')
        n += 1
    return n


def main():
    cfg = planner_config(json.load(open(sys.argv[1])))
    with open(sys.argv[2], 'w') as out:
        out.write(json.dumps({'config': clean(cfg),
                              'python': sys.version.split()[0]}, sort_keys = True) + '\n')
        for path in sys.argv[3:]:
            out.write(json.dumps({'program': path.split('/')[-1]}) + '\n')
            try: n = dump(cfg, path, out)
            except Exception as e:
                out.write(json.dumps({'error': str(e)}) + '\n'); n = -1
            sys.stderr.write('%s: %d commands\n' % (path, n))


if __name__ == '__main__': main()
