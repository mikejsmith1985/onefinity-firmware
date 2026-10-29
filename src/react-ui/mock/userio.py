# Mock helper (1.45.0): the controller's UserIO.plan() for the mock's config.
# Reads the nested config on stdin, prints state.user_io as JSON.
import sys, os, json, importlib.util
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    'UserIO', os.path.join(here, '..', '..', 'py', 'bbctrl', 'UserIO.py'))
U = importlib.util.module_from_spec(spec); spec.loader.exec_module(U)
c = json.load(sys.stdin)
values = {}
for name, sect in c.items():
    if isinstance(sect, dict): values.update(sect)
for i, m in enumerate(c.get('motors', []) or []):
    for k in ('min-switch', 'max-switch', 'homing-mode'):
        if k in m: values.setdefault(k, {})[str(i)] = m[k]
p = U.plan(values)
print(json.dumps({'outputs': dict((str(k), v) for k, v in p['outputs'].items()),
                  'inputs': dict((str(k), v[0]) for k, v in p['inputs'].items()),
                  'notes': p['notes']}))
