# Shared screen session (1.28.0): every browser sees the same dialogs and errors.
#   python3 src/py/tests/test_session.py
import os, sys, importlib.util
spec = importlib.util.spec_from_file_location('Session', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'bbctrl', 'Session.py'))
Session = importlib.util.module_from_spec(spec); spec.loader.exec_module(Session)

ok = True
def check(name, cond, msg=''):
    global ok; print(('PASS ' if cond else 'FAIL ') + name, msg); ok &= bool(cond)

class State:
    def __init__(s): s.vars = {}; s.sets = []
    def set(s, k, v):
        if s.vars.get(k, object()) != v: s.vars[k] = v; s.sets.append(k)
class Log:
    def __init__(s): s.listeners = []
    def add_listener(s, f): s.listeners.append(f)
    def broadcast(s, m): [f(m) for f in s.listeners]
class Ctrl:
    def __init__(s): s.state = State(); s.log = Log()

c = Ctrl(); ss = Session.Session(c)
check('starts empty', c.state.vars['ui'] == {} and c.state.vars['last_error'] is None)

# 1. A plain write is published to every screen
okw, cur = ss.put('probe', {'step': 'CheckProbe'})
check('write ok', okw and cur['rev'] == 1 and c.state.vars['ui'] == {'probe': {'v': {'step': 'CheckProbe'}, 'rev': 1}})

# 2. Two screens press Next on the same revision: only the first wins
a = ss.put('probe', {'step': 'Probe', 'by': 'pc'}, rev=1)
b = ss.put('probe', {'step': 'Probe', 'by': 'phone'}, rev=1)
check('first compare-and-set wins', a[0] and not b[0] and b[1]['v']['by'] == 'pc' and b[1]['rev'] == 2, (a, b))

# 3. Closing a dialog clears it everywhere, and a stale write can't bring it back
okc, cur = ss.put('probe', None, rev=2)
check('clear removes it from the state', okc and 'probe' not in c.state.vars['ui'] and cur['rev'] == 3)
stale = ss.put('probe', {'step': 'Done'}, rev=2)
check('stale write after clear refused', not stale[0] and stale[1]['v'] is None and stale[1]['rev'] == 3)
reopen = ss.put('probe', {'step': 'CheckProbe'}, rev=3)
check('reopen from the cleared revision', reopen[0] and reopen[1]['rev'] == 4)

# 4. The published value is a new dict each time (the state only sends changes)
before = c.state.vars['ui']; ss.put('jog', {'step': 1}); check('new dict on change', c.state.vars['ui'] is not before and 'jog' in c.state.vars['ui'])

# 5. Limits and names
try: ss.put('Bad Name!', 1); check('bad name refused', False)
except ValueError: check('bad name refused', True)
try: ss.put('big', 'x' * (Session.MAX_VALUE_BYTES + 10)); check('oversize refused', False)
except ValueError: check('oversize refused', True)

# 6. A next-store document changed: screens get a new store_rev
ss.store_changed('notes'); ss.store_changed('notes'); ss.store_changed('uiprefs')
check('store revisions count per document', c.state.vars['store_rev'] == {'notes': 2, 'uiprefs': 1})

# 7. Errors are published with an id; info and warnings are not
c.log.broadcast({'log': {'level': 'warning', 'msg': 'meh'}})
check('warning not an error popup', c.state.vars['last_error'] is None)
c.log.broadcast({'log': {'level': 'error', 'msg': "Invalid character: ','"}})
e1 = c.state.vars['last_error']
c.log.broadcast({'log': {'level': 'error', 'msg': "Invalid character: ','"}})
e2 = c.state.vars['last_error']
check('errors get rising ids even when the text repeats', e1['id'] == 1 and e2['id'] == 2 and e2['msg'] == "Invalid character: ','")

print('ALL PASS' if ok else 'SOME FAILED'); sys.exit(0 if ok else 1)
