#!/usr/bin/env python3
# Saves a running controller's settings and programs as onefinity-data.tar.gz
# (what was in /var/lib/bbctrl), for the new OS card to import on first boot:
# copy the file to the card's boot partition before the first start.
#
#   python pull-controller-data.py <controller address> [out.tar.gz]
#
# Uses only the controller's web API (no login).  Gets config.json, the
# screens' saved data (probe calibration, squareness, setter reference,
# homing log, plugs, bed camera, notes, run history) and every program and
# macro listed in the settings.
import io, json, sys, tarfile, time, urllib.parse, urllib.request

HOST = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else 'onefinity-data.tar.gz'
BASE = 'http://%s' % HOST
NO_SELECT = 'EgZjaHJvbWUqCggBEAAYsQMYgAQyBggAEEUYOTIKCAE'   # read without selecting
STORES = ('runs', 'notes', 'prefs', 'checkpoint', 'probe', 'uiprefs', 'bedcam')


def get(path):
    with urllib.request.urlopen(BASE + path, timeout = 60) as r: return r.read()


def add(tar, name, data):
    info = tarfile.TarInfo(name)
    info.size, info.mtime, info.mode = len(data), time.time(), 0o644
    tar.addfile(info, io.BytesIO(data))
    print('  %-50s %8d bytes' % (name, len(data)))


def file_names(config):
    names = []
    def walk(items):
        for i in items or []:
            if isinstance(i, dict):
                if i.get('file_name'): names.append(i['file_name'])
                walk(i.get('files'))
    for k in ('gcode_list', 'non_macros_list', 'macros_list'):
        walk(config.get(k))
    for m in config.get('macros', []) or []:
        if isinstance(m, dict) and m.get('file_name') not in (None, '', 'default'):
            names.append(m['file_name'])
    seen = []
    for n in names:
        if n not in seen: seen.append(n)
    return seen


def main():
    config = json.loads(get('/api/config/load'))
    print('Controller %s, firmware %s' % (HOST, config.get('full_version')))
    missing = []
    with tarfile.open(OUT, 'w:gz') as tar:
        add(tar, 'config.json', json.dumps(config, indent = 2).encode())
        for s in STORES:
            data = get('/api/next-store/' + s)
            if data.strip() not in (b'', b'null'):
                add(tar, 'next-data/%s.json' % s, data)
        for name in file_names(config):
            try:
                data = get('/api/file/' + urllib.parse.quote(NO_SELECT + name))
                add(tar, 'upload/' + name, data)
            except Exception as e:
                missing.append('%s (%s)' % (name, e))
    if missing:
        print('Not saved (listed in the settings but not on the controller):')
        for m in missing: print('  ' + m)
    print('Saved %s' % OUT)


if __name__ == '__main__': main()
