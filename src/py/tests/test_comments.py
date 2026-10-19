# Comments read the way the planner reads them (1.29.0): GCodeText, Resume, Align.
#   python3 src/py/tests/test_comments.py
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bbstub import check, done
import bbctrl
from bbctrl import GCodeText as T
R = sys.modules['bbctrl.Resume']; A = sys.modules['bbctrl.Align']

kinds = lambda line, o=False: sorted(set(i.kind for i in T.split(line, o)[2]))

# 1. GCodeText.split follows CAMotics: the first ')' ends a comment
code, comments, issues, still = T.split('G1 X1 (feed) Y2')
check('plain comment', code.split() == ['G1', 'X1', 'Y2'] and comments == ['feed'] and not issues and not still)
code = T.split('G1 X1 (a (b) c)')[0]
check('nested: the planner reads " c)" as code', code.split() == ['G1', 'X1', 'c)'], repr(code))
check('nested + stray reported', kinds('G1 X1 (a (b) c)') == ['nested', 'stray'])
check('unclosed comment carries to the next line', T.split('G0 X1 (open')[3] is True and kinds('G0 X1 (open') == ['unclosed'])
code, _, _, still = T.split('G1 X5) G0 Z1', True)
check('continued comment ends at the first )', code.split() == ['G0', 'Z1'] and not still, repr(code))
check('semicolon ends the line', T.code_of('G0 X1 ; (x (y) z').split() == ['G0', 'X1'])
check('apostrophe flagged', kinds("G0 X1 ' note") == ['quote'])
check('safe_comment', T.safe_comment('T1 FLAT 1/4in (6.35mm)\n') == 'T1 FLAT 1/4in [6.35mm] ')
check('norm_corner', T.norm_corner(' Front_Left ') == 'front-left' and T.norm_corner('BACK RIGHT') == 'back-right')
f = T.setup_fields(['(SETUP stock: x=0..10 y=0..5 z=-3..0)', '(SETUP tool: T1 (6.35mm))', '(SETUP probe-corner: front-left)'])
check('setup fields + nested SETUP line flagged', f.get('probe-corner') == 'front-left' and f.get('_bad') == [2], f)

# 2. Resume: the nested-bracket repro.  Old strip() removed "(Pass 2 (finish)"
#    and read "at x 120 y 3)" as X120 Y3, so the resume header rapided to
#    X120 Y3, a point the program never visits.
prog = ['G21 G90 G54', 'S18000 M3', 'G0 X10 Y10', 'G0 Z5', 'G1 Z-1 F300',
        '(Pass 2 (finish) at x 120 y 3)', 'G1 X20 F900', 'G1 Y20', 'M30']
old_strip = lambda line: __import__('re').sub(r'\([^)]*\)', ' ', line).split(';', 1)[0].strip()
check('repro: old strip read the comment as X120 Y3', old_strip(prog[5]) == 'at x 120 y 3)')
try:
    R.build(prog, 8, 'job.nc', {}, -5); check('resume past a nested comment refused', False)
except R.ResumeError as e:
    check('resume past a nested comment refused', 'Line 6' in str(e) and '[ ]' in str(e), str(e)[:80])
text, info = R.build(prog, 5, 'job (v2).nc', {}, -5)
check('resume before it builds, warns about line 6', any('6' in w and 'later' in w for w in info['warnings']), info['warnings'])
check('no X120 anywhere in the header', 'X120' not in text.split('(END OF RESUME HEADER')[0])
check('file name comment sanitised', '(RESUME of job [v2].nc at line 5)' in text, text.splitlines()[0])
hdr = text.split('(END OF RESUME HEADER')[0].splitlines()
check('every header line reads cleanly', all(not T.split(l)[2] for l in hdr), hdr)
check('locate() gives up rather than guessing', R.locate(prog, {'x': 120, 'y': 3, 'z': -1}, 1) is None)

# 3. Manual router: always a pause with "switch the router ON" before the plunge
text, info = R.build(prog, 5, 'job.nc', {'pause': False}, -5, manual=True, router='DIAL 4 (18k)')
lines = text.splitlines()
msg = [i for i, l in enumerate(lines) if 'Switch the router ON' in l]
plunge = [i for i, l in enumerate(lines) if l.startswith('G1 Z')]
check('router prompt before the plunge', msg and plunge and msg[0] < plunge[0] and lines[msg[0] + 1] == 'M0', lines[:16])
check('router prompt has no nested brackets', not T.split(lines[msg[0]])[2] and 'DIAL 4 [18k]' in lines[msg[0]], lines[msg[0]])
check('info says manual', info['manual_spindle'] and info['pause'])
text, info = R.build(prog, 5, 'job.nc', {'pause': False}, -5)
check('VFD spindle, pause off: no M0', 'M0' not in text.split('(END OF RESUME')[0] and not info['manual_spindle'])
class Cfg:
    def __init__(s, v): s.v = v
    def get(s, k, d=None): return s.v.get(k, d)
check('manual_spindle from config', R.manual_spindle(Cfg({'tool-type': 'Disabled'})) and not R.manual_spindle(Cfg({'tool-type': 'Huanyang VFD'})))

# 4. Align: refuses nested comments, sanitises the source name
try:
    A.transform(['G0 X1 Y1 (a (b) c)'], 1.0, 'x.nc'); check('align refuses nested comment', False)
except A.AlignError as e: check('align refuses nested comment', 'Line 1' in str(e) or 'line 1' in str(e), str(e)[:80])
out = A.transform(['G21 G90', 'G0 X10 Y0', 'G1 X20 F500'], 2.0, 'part (copy).nc')
out = out[0] if isinstance(out, tuple) else out
first = (out if isinstance(out, str) else '\n'.join(out)).splitlines()
check('align header sanitised', all(not T.split(l)[2] for l in first), first[:3])
done()
