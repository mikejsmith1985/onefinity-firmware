# Fake overhead camera for the mock controller (bed camera, 1.36.0).
# Draws the spoilboard, optional stock and the probe at the machine position,
# as a tilted pinhole camera about 900 mm above the bed would see them.
#   echo '{"x":..,"y":..,"z":..,"stock":true}' | python3 bedscene.py > frame.jpg
#   python3 bedscene.py --project x y z      prints the pixel of a machine point
import sys, json, io, math
import numpy as np

W, H, F = 1280, 720, 800
BED = -100.0                                   # spoilboard top, machine Z
LED_H = 31.0                                   # probe LED ring above the stylus tip (1.38.0)
CAM = np.array([405.0, 440.0, BED + 900.0])    # camera position (machine): sees the whole reach (1.38.0)
STOCK = dict(cx=300.0, cy=250.0, w=150.0, l=90.0, t=19.0, ang=math.radians(4))

def rot():
    def Rx(a): return np.array([[1, 0, 0], [0, math.cos(a), -math.sin(a)], [0, math.sin(a), math.cos(a)]])
    def Ry(a): return np.array([[math.cos(a), 0, math.sin(a)], [0, 1, 0], [-math.sin(a), 0, math.cos(a)]])
    def Rz(a): return np.array([[math.cos(a), -math.sin(a), 0], [math.sin(a), math.cos(a), 0], [0, 0, 1]])
    base = np.array([[1, 0, 0], [0, -1, 0], [0, 0, -1]])
    return Rz(0.06) @ Rx(0.1) @ Ry(-0.04) @ base
R = rot()

def project(p):
    c = R @ (np.array(p, float) - CAM)
    return (W / 2 + F * c[0] / c[2], H / 2 + F * c[1] / c[2])

def unproject(t):
    # machine X/Y where each pixel's ray meets the plane z = BED + t
    u, v = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
    d = np.stack([(u - W / 2) / F, (v - H / 2) / F, np.ones_like(u)], -1) @ R  # R^T c
    k = (BED + t - CAM[2]) / d[..., 2]
    return CAM[0] + k * d[..., 0], CAM[1] + k * d[..., 1]

def in_stock(x, y):
    s = STOCK; dx, dy = x - s['cx'], y - s['cy']
    u = dx * math.cos(s['ang']) + dy * math.sin(s['ang']); v = -dx * math.sin(s['ang']) + dy * math.cos(s['ang'])
    return (np.abs(u) <= s['w'] / 2) & (np.abs(v) <= s['l'] / 2)

def render(q):
    from PIL import Image, ImageDraw
    x, y = unproject(0)
    base = 150 + 10 * np.sin(x * 0.05) + 8 * np.cos(y * 0.07)
    img = np.stack([base, base - 18, base - 45], -1)
    track = np.abs(np.mod(y, 100) - 50) < 9
    img[track] = 110
    img[(x < -5) | (x > 820) | (y < -5) | (y > 820)] = 40   # off the table
    if q.get('stock'):
        sx, sy = unproject(STOCK['t'])
        img[in_stock(sx, sy)] = [120, 85, 60]
    rng = np.random.default_rng(int(q.get('seed', 1)))
    img = np.clip(img * q.get('gain', 1.0) + rng.normal(0, 3, img.shape), 0, 255).astype(np.uint8)
    im = Image.fromarray(img); d = ImageDraw.Draw(im)
    # The probe: a red 3 mm ball, its bottom at the machine position, a grey shaft going up
    tip = (q['x'], q['y'], q['z']); ctr = (q['x'], q['y'], q['z'] + 1.5)
    top = project((q['x'], q['y'], q['z'] + 45)); c = project(ctr); b = project(tip)
    d.line([c, top], fill=(70, 70, 75), width=5)
    r = max(2.0, math.hypot(c[0] - b[0], c[1] - b[1]) * 1.1)
    d.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill=(200, 30, 30))
    # 1.38.0: the probe's LED ring, 16 mm radius, LED_H above the tip: green, red while touched
    if q.get('led'):
        rgb = (240, 50, 40) if q['led'] == 'red' else (50, 235, 90)
        for k in range(180):
            a = 2 * math.pi * k / 180
            p = project((q['x'] + 16 * math.cos(a), q['y'] + 16 * math.sin(a), q['z'] + LED_H))
            d.ellipse([p[0] - 2, p[1] - 2, p[0] + 2, p[1] + 2], fill=rgb)
    out = io.BytesIO(); im.save(out, 'JPEG', quality=90); return out.getvalue()

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--project':
        print(json.dumps(project([float(v) for v in sys.argv[2:5]])))
    else:
        sys.stdout.buffer.write(render(json.load(sys.stdin)))
