# Screen check vs controller guard (1.34.0).
#   node src/react-ui/test/keepout.mjs && python3 src/py/tests/test_setter_guard_parity.py
# The Run checklist blocks a program the controller would refuse part way through, so the two must
# agree on every move: a move the screen passes but the controller refuses would stop a job mid-cut.
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bbstub import check, done
import bbctrl
SG = sys.modules['bbctrl.SetterGuard']

path = os.path.join(os.path.dirname(__file__), '..', '..', 'react-ui', 'test', 'keepout-parity.json')
d = json.load(open(path))
cfg = SG.settings_from_prefs({'setter': d['setter']})
zlim, how = SG.limit_z(cfg, d['offset_z'], d['z_max'])
r = cfg['keep'] + cfg['allow']
check('same keep-out radius', abs(r - d['zone']['r']) < 1e-9, (r, d['zone']['r']))
check('same height limit', abs(zlim - d['zone']['zLimit']) < 1e-9 and how == d['zone']['how'], (zlim, how))

bad = []
for k in d['cases']:
    hit = SG.segment_hits(tuple(k['a']), tuple(k['b']), cfg['x'], cfg['y'], r, zlim) is not None
    if hit != k['hit']: bad.append(k)
check('controller and screen agree on %d random moves' % len(d['cases']), not bad, bad[:3])
done()
