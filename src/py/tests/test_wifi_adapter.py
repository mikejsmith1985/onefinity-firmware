# Built-in Wi-Fi or a USB adapter (1.46.0): scripts/config-wifi -x / -X, run
# against a scratch copy of /etc (paths rewritten, reboot replaced by a print).
#   python3 src/py/tests/test_wifi_adapter.py
import os, sys, json, subprocess, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bbstub import check, done

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
src = open(os.path.join(ROOT, 'scripts', 'config-wifi')).read()
tmp = tempfile.mkdtemp()
for d in ('etc/modprobe.d', 'etc/network/interfaces.d'): os.makedirs(os.path.join(tmp, d))
script = os.path.join(tmp, 'config-wifi')
open(script, 'w').write(src.replace('/etc/', tmp + '/etc/')
                        .replace('nohup reboot &', 'echo REBOOT;'))
os.chmod(script, 0o755)
blk = os.path.join(tmp, 'etc/modprobe.d/blacklist-internal-wifi.conf')

def run(*a): return subprocess.run([script] + list(a), capture_output = True, text = True)
def query(): return json.loads(run('-j').stdout)

check('built-in by default', query().get('internal') is True, query())
r = run('-r', '-x')
check('-x turns the built-in wifi off and reboots', r.returncode == 0 and 'REBOOT' in r.stdout
      and 'blacklist brcmfmac' in open(blk).read(), r.stdout + r.stderr)
check('query says USB adapter', query().get('internal') is False)
r = run('-x')
check('-x again changes nothing (no reboot)', r.returncode == 0 and 'REBOOT' not in r.stdout)
r = run('-r', '-X')
check('-X turns it back on and reboots', r.returncode == 0 and 'REBOOT' in r.stdout and not os.path.exists(blk))
r = run('-r')
check('a plain call (no SSID) still refuses as before', r.returncode != 0 and 'SSID' in r.stdout, r.stdout)
done()
