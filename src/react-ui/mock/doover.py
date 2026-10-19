# Cut deeper for the mock controller: runs the real DoOver.py on the mock's
# program.  stdin: {"action", "file", "text", "opts", "run"}; stdout: JSON.
import sys, os, json
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, '..', '..', 'py', 'tests'))
import bbstub  # noqa: stubs the controller-only modules
import bbctrl
from bbctrl import GCodeText, Lint
D = sys.modules['bbctrl.DoOver']

q = json.load(sys.stdin)
lines = q['text'].splitlines()
run = q.get('run') or {'status': 'unknown', 'msg': '', 'notes': [], 'delta': {}, 'homed': True}
try:
    if q['action'] == 'analyse':
        ops, wcs, _, inch = D.parse(lines)
        D.analyse_ops(ops)
        r = D.summary(ops, GCodeText.setup_fields(lines[:400]), 'in' if inch else 'mm')
        r.update(file=q['file'], output=D.output_name(q['file']), run=run, defaults=D.DEFAULTS, wcs=sorted(wcs))
        print(json.dumps({'ok': r}))
    else:
        opts = q.get('opts') or {}
        if run['status'] in ('interrupted', 'moved'): raise D.DoOverError(run['msg'])
        if run['status'] == 'unknown' and not opts.get('ack_unknown'):
            raise D.DoOverError(run['msg'] + ' Tick the box to confirm it is the same stock, zero and tool, and that the last run finished.')
        text, info = D.build(lines, q['file'], opts, top_mm = -1, tool_now = 1)
        lint = Lint.lint_lines(text.splitlines())
        info['lint'] = {'errors': lint['errors'], 'warnings': lint['warnings'], 'issues': lint['issues']}
        info.update(file=D.output_name(q['file']), source=q['file'], run=run)
        print(json.dumps({'ok': info, 'text': text}))
except D.DoOverError as e:
    print(json.dumps({'err': str(e)}))
