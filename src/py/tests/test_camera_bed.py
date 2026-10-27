# Bed camera backend (1.36.0): still pictures, picture size, storage.
#   python3 src/py/tests/test_camera_bed.py
import os, sys, time, json, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bbstub import check, done, run_sync
import bbctrl
from bbctrl.Camera import Camera
import bbctrl.Web
Web = sys.modules['bbctrl.Web']

class L:
    def __init__(s): s.w = []
    def warning(s, *a): s.w.append(a)
    def info(s, *a): pass

def cam(sizes=((640, 480), (1280, 720))):
    c = Camera.__new__(Camera)
    c.dev = object(); c.last_frame = None; c.last_frame_time = 0; c.want_frames_until = 0
    c.sizes = list(sizes); c.width, c.height = 640, 480; c.focus = None; c.log = L(); c.path = None; c.have_camera = False
    return c

# A still is only one taken after the request
c = cam()
c.last_frame, c.last_frame_time = b'old', time.time() - 5
import tornado.ioloop
from tornado import gen
@gen.coroutine
def fresh():
    feed = lambda: (setattr(c, 'last_frame', b'new'), setattr(c, 'last_frame_time', time.time()))
    tornado.ioloop.IOLoop.current().call_later(0.2, feed)
    r = yield c.get_frame(timeout=2)
    return r
check('waits for a fresh frame', run_sync(fresh) == b'new')
check('asks the camera handler to keep frames', c.want_frames_until > time.time())
check('stale frame only -> None', run_sync(lambda: cam().get_frame(timeout=0.3)) is None)
c2 = cam(); c2.dev = None
check('no camera -> None at once', run_sync(lambda: c2.get_frame(timeout=2)) is None)

# Picture size: only sizes the camera offers, saved for the next start
d = tempfile.mkdtemp()
c = cam(); c.dev = None; c.settings_path = os.path.join(d, 'next-data', 'camera.json')
c.set_resolution(1280, 720)
check('size changed', (c.width, c.height) == (1280, 720))
check('size saved', json.load(open(c.settings_path)) == {'width': 1280, 'height': 720})
try: c.set_resolution(1920, 1080); check('unoffered size refused', False)
except ValueError: check('unoffered size refused', True)
check('status lists sizes', c.get_status()['sizes'] == [[640, 480], [1280, 720]] and c.get_status()['width'] == 1280)

# Web: the store accepts the bed camera document, and the routes are there
check('bedcam is a store name', 'bedcam' in Web.NextStoreHandler.NAMES)
src = open(Web.__file__).read()
check('frame route', "(r'/api/camera/frame', CameraFrameHandler)" in src)
check('store route accepts bedcam', 'uiprefs|bedcam)' in src)
done()
