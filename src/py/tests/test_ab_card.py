# A/B SD card tool (scripts/ab-card, 1.47.0) on loop devices.
#
#   sudo python3 src/py/tests/test_ab_card.py
#
# Builds a small fake controller card (boot + root), makes an A/B card from it,
# then "starts" from the new card's slot A and copies, tries, keeps and
# switches slots, and writes a slot from an OS file.  What this cannot test is
# the Raspberry Pi boot firmware itself (os_prefix, tryboot.txt and the
# one-shot tryboot flag); the mailbox call is faked here.
import os, sys, json, subprocess, tempfile, shutil, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
TOOL = os.path.join(ROOT, 'scripts', 'ab-card')
FW = os.path.join(ROOT, 'scripts', 'ab-boot-firmware')

ok = True
def check(name, cond, more = ''):
    global ok
    print('%s %s %s' % ('PASS' if cond else 'FAIL', name, more))
    ok = ok and bool(cond)

def sh(*cmd, **kw):
    return subprocess.check_output(cmd, stderr = subprocess.STDOUT, **kw).decode()

def read(p):
    with open(p) as f: return f.read()

def put(p, text):
    os.makedirs(os.path.dirname(p), exist_ok = True)
    with open(p, 'w') as f: f.write(text)

if os.geteuid() != 0:
    print('SKIP: needs root for loop devices'); sys.exit(0)

work = tempfile.mkdtemp(prefix = 'abtest-')

# This test kernel may have no FAT driver: if so, boot partitions are made
# as ext4 by a stand-in mkfs.vfat (the partition type stays FAT32)
SHIM = os.path.join(work, 'shim')
if 'vfat' not in open('/proc/filesystems').read():
    os.makedirs(SHIM)
    with open(os.path.join(SHIM, 'mkfs.vfat'), 'w') as f:
        f.write('#!/bin/bash\nexec mkfs.ext4 -q -F "${@: -1}"\n')
    os.chmod(os.path.join(SHIM, 'mkfs.vfat'), 0o755)
    os.environ['PATH'] = SHIM + ':' + os.environ['PATH']
    print('NOTE: no FAT driver here; boot partitions are ext4 in this run')
loops, mnts = [], []

def loop(path):
    dev = sh('losetup', '-f', '--show', path).strip()
    loops.append(dev); imgs[dev] = path; return dev

imgs = {}
def parts(dev):
    # Partition scanning doesn't work in every container: give each
    # partition its own loop device at its offset, named like the real one
    table = json.loads(sh('sfdisk', '-J', imgs[dev]))['partitiontable']
    for i, p in enumerate(table.get('partitions', []), 1):
        name = '%sp%d' % (dev, i)
        if os.path.exists(name): continue
        part = sh('losetup', '-f', '--show', '-o', str(p['start'] * 512),
                  '--sizelimit', str(p['size'] * 512), imgs[dev]).strip()
        loops.insert(0, part)
        os.symlink(part, name); links.append(name)

links = []
def mount(dev, where):
    os.makedirs(where, exist_ok = True)
    sh('mount', dev, where); mnts.append(where)

def umount_all():
    for m in reversed(mnts):
        subprocess.call(['umount', m], stderr = subprocess.DEVNULL)
    del mnts[:]

def tool(env, *args, **kw):
    e = dict(os.environ, AB_FW_DIR = FW, AB_FAKE_MAILBOX = '1',
             AB_NO_REBOOT = '1', AB_ANY_TARGET = '1', **env)
    p = subprocess.Popen(['python3', TOOL] + list(args), env = e,
                         stdout = subprocess.PIPE, stderr = subprocess.STDOUT)
    out = p.communicate()[0].decode()
    if kw.get('fail'): return p.returncode != 0, out
    if p.returncode: print(out)
    return p.returncode == 0, out

try:
    # --- A fake controller card: old firmware, one root --------------------
    src_img = os.path.join(work, 'src.img')
    sh('truncate', '-s', '600M', src_img)
    sh('sfdisk', '--quiet', src_img, input = b'label: dos\n8192,131072,c,*\n139264,,83\n')
    src = loop(src_img); parts(src)
    sh('mkfs.vfat', '-F', '32', src + 'p1'); sh('mkfs.ext4', '-q', src + 'p2')
    sroot = os.path.join(work, 'sroot'); mount(src + 'p2', sroot)
    sboot = os.path.join(sroot, 'boot'); mount(src + 'p1', sboot)
    for n in ('bootcode.bin', 'start.elf', 'fixup.dat', 'start_db.elf'):
        put(os.path.join(sboot, n), 'OLD ' + n)
    for n in ('kernel.img', 'kernel7.img', 'bcm2710-rpi-3-b.dtb', 'bcm2710-rpi-3-b-plus.dtb',
              'overlays/README', 'overlays/pi3-disable-bt.dtbo', 'ssh', 'issue.txt'):
        put(os.path.join(sboot, n), 'slot1 ' + n)
    put(os.path.join(sboot, 'config.txt'),
        'dtparam=i2c_arm=on\ndtoverlay=pi3-disable-bt\n[pi4]\narm_boost=1\n[all]\n'
        'max_usb_current=1\n')
    put(os.path.join(sboot, 'cmdline.txt'),
        'dwc_otg.lpm_enable=0 console=tty1 root=/dev/mmcblk0p2 rootfstype=ext4 '
        'rootwait quiet splash init=/usr/lib/raspi-config/init_resize.sh\n')
    put(os.path.join(sroot, 'etc/fstab'),
        'proc /proc proc defaults 0 0\nPARTUUID=abc-01 /boot vfat defaults,ro 0 2\n'
        'PARTUUID=abc-02 / ext4 defaults,noatime 0 1\n')
    put(os.path.join(sroot, 'etc/os-release'), 'PRETTY_NAME="Raspbian GNU/Linux 9 (stretch)"\n')
    put(os.path.join(sroot, 'etc/hostname'), 'onefinity\n')
    put(os.path.join(sroot, 'etc/wpa_supplicant/wpa_supplicant.conf'), 'network={ssid="shop"}\n')
    put(os.path.join(sroot, 'etc/ssh/ssh_host_rsa_key'), 'KEY\n')
    put(os.path.join(sroot, 'var/lib/bbctrl/config.json'), '{"probe": "reference"}\n')
    put(os.path.join(sroot, 'var/lib/bbctrl/firmware/update.tar.bz2'), 'x')
    put(os.path.join(sroot, 'tmp/junk'), 'junk')
    put(os.path.join(sroot, 'usr/bin/ping'), 'ping')
    sh('setfattr', '-n', 'user.test', '-v', 'kept', os.path.join(sroot, 'usr/bin/ping'))
    sh('dd', 'if=/dev/zero', 'of=' + os.path.join(sroot, 'var/swap'), 'bs=1M', 'count=20')
    os.chmod(os.path.join(sroot, 'etc/ssh/ssh_host_rsa_key'), 0o600)
    sh('mount', '-o', 'remount,ro', sboot)

    srcenv = dict(AB_ROOT = sroot, AB_BOOT = sboot, AB_ROOT_DEV = src + 'p2',
                  AB_RUN_DIR = os.path.join(work, 'run1'))
    good, out = tool(srcenv, 'status')
    st = json.loads(out)
    check('old card: not an A/B card', st['ab'] is False, out[:200])

    # --- Make the A/B card -------------------------------------------------
    dst_img = os.path.join(work, 'dst.img')
    sh('truncate', '-s', '8G', dst_img)
    dst = loop(dst_img)
    bad, out = tool(srcenv, 'make', dst, fail = True)
    check('make refuses without --yes', bad and 'erased' in out, out)
    small = os.path.join(work, 'small.img'); sh('truncate', '-s', '4G', small)
    sdev = loop(small)
    bad, out = tool(srcenv, 'make', sdev, '--yes', fail = True)
    check('make refuses a 4 GB card', bad and 'at least 8 GB' in out, out)
    bad, out = tool(srcenv, 'make', src, '--yes', fail = True)
    check('make refuses the running card', bad and 'running system' in out, out)

    # partition nodes appear only after sfdisk, so create them in the background
    import threading
    stop = [False]
    def nodes():
        while not stop[0]:
            try: parts(dst)
            except Exception: pass
            time.sleep(0.2)
    t = threading.Thread(target = nodes); t.start()
    good, out = tool(srcenv, 'make', dst, '--yes')
    stop[0] = True; t.join()
    check('make: card made', good and 'ready' in out, out[-600:])
    job = json.load(open(os.path.join(work, 'run1', 'job.json')))
    check('make: job finished', job['state'] == 'done' and job['progress'] == 100, job)

    table = sh('sfdisk', '-d', dst)
    check('three partitions, boot is FAT32 and bootable',
          table.count('type=') == 3 and 'type=c, bootable' in table, table)
    nroot = os.path.join(work, 'nrootA'); mount(dst + 'p2', nroot)
    nboot = os.path.join(nroot, 'boot'); mount(dst + 'p1', nboot)
    conf, tryb = read(os.path.join(nboot, 'config.txt')), read(os.path.join(nboot, 'tryboot.txt'))
    check('config.txt keeps the settings and ends with os_prefix=a/ under [all]',
          'dtoverlay=pi3-disable-bt' in conf and conf.rstrip().endswith('[all]\nos_prefix=a/')
          and '[pi4]\narm_boost=1' in conf, conf)
    check('tryboot.txt is the same with os_prefix=b/',
          tryb.replace('os_prefix=b/', 'os_prefix=a/') == conf, tryb)
    check('new boot firmware with checksums',
          open(os.path.join(nboot, 'start.elf'), 'rb').read() == open(os.path.join(FW, 'start.elf'), 'rb').read()
          and open(os.path.join(nboot, 'bootcode.bin'), 'rb').read() == open(os.path.join(FW, 'bootcode.bin'), 'rb').read())
    check('a variant with no new copy is kept (start_db.elf)',
          read(os.path.join(nboot, 'start_db.elf')) == 'OLD start_db.elf')
    for d in ('a', ''):
        p = os.path.join(nboot, d)
        check('kernel, device trees and overlays in %s' % (d + '/' if d else 'the top level'),
              all(os.path.exists(os.path.join(p, n)) for n in
                  ('kernel7.img', 'bcm2710-rpi-3-b.dtb', 'overlays/README',
                   'overlays/pi3-disable-bt.dtbo')))
    cl = read(os.path.join(nboot, 'a', 'cmdline.txt'))
    check('slot A cmdline: root p2, panic=10, no resize',
          'root=/dev/mmcblk0p2' in cl and 'panic=10' in cl and 'init_resize' not in cl
          and 'quiet splash' in cl, cl)
    check('top-level cmdline matches slot A', read(os.path.join(nboot, 'cmdline.txt')) == cl)
    check('other boot files copied (ssh, issue.txt)',
          os.path.exists(os.path.join(nboot, 'ssh')) and os.path.exists(os.path.join(nboot, 'issue.txt')))
    check('slot B empty', os.listdir(os.path.join(nboot, 'b')) == [])
    fstab = read(os.path.join(nroot, 'etc/fstab'))
    check('slot A fstab: root p2, boot p1',
          '/dev/mmcblk0p2  /  ext4' in fstab and '/dev/mmcblk0p1  /boot  vfat' in fstab
          and 'PARTUUID' not in fstab, fstab)
    check('settings and calibration copied',
          read(os.path.join(nroot, 'var/lib/bbctrl/config.json')) == '{"probe": "reference"}\n')
    check('no swap file, temp files or old updates copied',
          not os.path.exists(os.path.join(nroot, 'var/swap')) and
          not os.path.exists(os.path.join(nroot, 'tmp/junk')) and
          not os.path.exists(os.path.join(nroot, 'var/lib/bbctrl/firmware/update.tar.bz2')))
    check('/tmp kept with its permissions', oct(os.stat(os.path.join(nroot, 'tmp')).st_mode & 0o7777) == '0o1777')
    check('file attributes kept', 'kept' in sh('getfattr', '-n', 'user.test', os.path.join(nroot, 'usr/bin/ping')))
    check('key permissions kept', os.stat(os.path.join(nroot, 'etc/ssh/ssh_host_rsa_key')).st_mode & 0o777 == 0o600)
    check('original card untouched',
          read(os.path.join(sboot, 'start.elf')) == 'OLD start.elf' and
          'init_resize' in read(os.path.join(sboot, 'cmdline.txt')) and
          not os.path.exists(os.path.join(sboot, 'a')))

    # --- Running from the new card, slot A ---------------------------------
    sh('mount', '-o', 'remount,ro', nboot)
    envA = dict(AB_ROOT = nroot, AB_BOOT = nboot, AB_ROOT_DEV = dst + 'p2',
                AB_RUN_DIR = os.path.join(work, 'run2'))
    good, out = tool(envA, 'status'); st = json.loads(out)
    check('status: A/B card, running A, A by default, no trial',
          st['ab'] and st['running'] == 'a' and st['default'] == 'a' and not st['trial'], out[:300])
    check('status: slot B not startable', st['slots']['b']['bootable'] is False and st['slots']['a']['bootable'])
    bad, out = tool(envA, 'try', fail = True)
    check('try refuses an empty slot', bad and 'no system' in out, out)

    good, out = tool(envA, 'copy')
    check('copy: slot B written', good and 'copy of this system' in out, out[-300:])
    check('boot stays read-only afterwards', ' ro,' in [l for l in read('/proc/mounts').splitlines() if nboot in l][0])
    good, out = tool(envA, 'status'); st = json.loads(out)
    check('slot B startable and labelled', st['slots']['b']['bootable'] and
          st['slots']['b']['label'] == 'Copy of slot A', st['slots']['b'])
    cl = read(os.path.join(nboot, 'b', 'cmdline.txt'))
    check('slot B cmdline: root p3', 'root=/dev/mmcblk0p3' in cl and 'root=/dev/mmcblk0p2' not in cl, cl)
    nrootB = os.path.join(work, 'nrootB'); mount(dst + 'p3', nrootB)
    check('slot B fstab: root p3', '/dev/mmcblk0p3  /' in read(os.path.join(nrootB, 'etc/fstab')))
    check('slot B has the settings',
          read(os.path.join(nrootB, 'var/lib/bbctrl/config.json')) == '{"probe": "reference"}\n')
    sh('umount', nrootB); mnts.remove(nrootB)

    good, out = tool(envA, 'try')
    check('try: accepted', good, out)
    check('try: config.txt still starts A (one-shot)', read(os.path.join(nboot, 'config.txt')).rstrip().endswith('os_prefix=a/'))
    check('try: tryboot.txt starts B', read(os.path.join(nboot, 'tryboot.txt')).rstrip().endswith('os_prefix=b/'))

    # Came back up on A (trial didn't start, or a power cycle)
    good, out = tool(envA, 'status'); st = json.loads(out)
    check('back on A after a trial: reported', st.get('trial_ended', {}).get('slot') == 'b', st.get('trial_ended'))
    tool(envA, 'dismiss')
    good, out = tool(envA, 'status'); st = json.loads(out)
    check('dismissed', 'trial_ended' not in st)

    # --- Started on trial in slot B -----------------------------------------
    sh('umount', nboot); sh('umount', nroot); mnts.remove(nboot); mnts.remove(nroot)
    nrootB = os.path.join(work, 'nrootB'); mount(dst + 'p3', nrootB)
    nboot = os.path.join(nrootB, 'boot'); mount(dst + 'p1', nboot)
    sh('mount', '-o', 'remount,ro', nboot)
    envB = dict(envA, AB_ROOT = nrootB, AB_BOOT = nboot, AB_ROOT_DEV = dst + 'p3')
    good, out = tool(envB, 'status'); st = json.loads(out)
    check('on trial: running B, default A', st['running'] == 'b' and st['default'] == 'a' and st['trial'], out[:300])
    bad, out = tool(envB, 'copy', fail = True)
    check('on trial: writing the known-good slot is refused', bad and 'on trial' in out, out)
    bad, out = tool(envB, 'try', fail = True)
    check('on trial: try refused', bad, out)
    good, out = tool(envB, 'keep')
    check('keep', good, out)
    good, out = tool(envB, 'status'); st = json.loads(out)
    check('kept: B by default, tryboot points at A', st['default'] == 'b' and not st['trial'] and
          read(os.path.join(nboot, 'tryboot.txt')).rstrip().endswith('os_prefix=a/'))
    bad, out = tool(envB, 'keep', fail = True)
    check('keep with no trial refused', bad, out)

    # --- OS file into the other slot (A) ------------------------------------
    bundle = os.path.join(work, 'os.tar')
    good, out = tool(envB, 'bundle', bundle, '--label', 'Test OS 2')
    names = sh('tar', '-tf', bundle).split()
    check('bundle: ab-bundle.json first, boot/ and root/',
          names[0] == 'ab-bundle.json' and 'boot/kernel7.img' in names and
          any(n.startswith('root/etc/fstab') for n in names) and
          not any(n.startswith('root/boot/') and n != 'root/boot/' for n in names), names[:6])
    # Change the bundle's settings, to see the machine's own carried over
    sh('mkdir', '-p', os.path.join(work, 'b2'))
    sh('tar', '-xf', bundle, '-C', os.path.join(work, 'b2'))
    put(os.path.join(work, 'b2/root/var/lib/bbctrl/config.json'), '{"probe": "factory"}\n')
    put(os.path.join(work, 'b2/root/etc/hostname'), 'raspberrypi\n')
    put(os.path.join(work, 'b2/root/etc/new-os-file'), 'new\n')
    bundle2 = os.path.join(work, 'os2.tar.xz')
    sh('tar', '-cJf', bundle2, '-C', os.path.join(work, 'b2'), 'ab-bundle.json', 'boot', 'root')
    bad, out = tool(envB, 'write', bundle2, '--sha256', '00' * 32, fail = True)
    check('write: wrong checksum refused before anything is touched',
          bad and 'checksum' in out and os.path.exists(os.path.join(nboot, 'a', 'kernel7.img')), out)
    put(os.path.join(work, 'notbundle.tar'), '')
    sh('tar', '-cf', os.path.join(work, 'notbundle.tar'), '-C', work, 'src.img')
    bad, out = tool(envB, 'write', os.path.join(work, 'notbundle.tar'), fail = True)
    check('write: not an OS file refused', bad and 'not an OS file' in out, out)
    import hashlib
    digest = hashlib.sha256(open(bundle2, 'rb').read()).hexdigest()
    good, out = tool(envB, 'write', bundle2, '--sha256', digest)
    check('write: slot A written from a compressed OS file', good and 'ready to try' in out, out[-400:])
    nrootA2 = os.path.join(work, 'nrootA2'); mount(dst + 'p2', nrootA2)
    check('new system in slot A', read(os.path.join(nrootA2, 'etc/new-os-file')) == 'new\n')
    check('machine settings carried over, not the file\'s',
          read(os.path.join(nrootA2, 'var/lib/bbctrl/config.json')) == '{"probe": "reference"}\n' and
          read(os.path.join(nrootA2, 'etc/hostname')) == 'onefinity\n' and
          read(os.path.join(nrootA2, 'etc/wpa_supplicant/wpa_supplicant.conf')) == 'network={ssid="shop"}\n')
    check('slot A fstab root p2', '/dev/mmcblk0p2  /' in read(os.path.join(nrootA2, 'etc/fstab')))
    good, out = tool(envB, 'status'); st = json.loads(out)
    check('slot A labelled from the OS file', st['slots']['a']['label'] == 'Test OS 2' and
          st['slots']['a'].get('sha256') == digest, st['slots']['a'])
    check('slot A cmdline root p2', 'root=/dev/mmcblk0p2' in read(os.path.join(nboot, 'a', 'cmdline.txt')))
    sh('umount', nrootA2); mnts.remove(nrootA2)

    good, out = tool(envB, 'switch', 'a')
    check('switch back to A by default', good and read(os.path.join(nboot, 'config.txt')).rstrip().endswith('os_prefix=a/'), out)
    check('config.txt has one os_prefix line after all that',
          read(os.path.join(nboot, 'config.txt')).count('os_prefix') == 1 and
          read(os.path.join(nboot, 'config.txt')).count('A/B card') == 1)

finally:
    umount_all()
    for l in links:
        if os.path.islink(l): os.unlink(l)
    for l in loops: subprocess.call(['losetup', '-d', l])
    shutil.rmtree(work, ignore_errors = True)

print('ALL PASS' if ok else 'SOME FAILED')
sys.exit(0 if ok else 1)
