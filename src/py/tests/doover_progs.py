# Fusion-style test programs for Cut deeper (1.30.0).  Shapes, not real parts.
def contour(levels=(-1, -2, -3, -3.2), tabs=True, name='2D Contour1', tool=1, rpm=18000,
            x0=5, y0=5, w=40, h=30, feed=900, arcs=False):
    L = ['(%s)' % name, 'T%d M6' % tool, 'S%d M3' % rpm, 'G54', 'G0 X%g Y%g' % (x0 - 3, y0), 'G0 Z15', 'G0 Z5']
    for z in levels:
        last = z < levels[-1] + 2 - 1e-9   # tabs on every pass below the tab top
        L += ['G1 Z%g F300' % z, 'G1 X%g F%d' % (x0, feed), 'G1 X%g' % (x0 + w)]
        if tabs and last:
            # One tab, 12 mm long and 2 mm high, on the right side
            L += ['G1 Y%g' % (y0 + 8), 'G1 Y%g Z%g' % (y0 + 9, levels[-1] + 2), 'G1 Y%g' % (y0 + 21),
                  'G1 Y%g Z%g' % (y0 + 22, z), 'G1 Y%g' % (y0 + h)]
        else: L += ['G1 Y%g' % (y0 + h)]
        if arcs:
            L += ['G1 X%g' % (x0 + 5), 'G3 X%g Y%g I0 J-5' % (x0, y0 + h - 5), 'G1 Y%g' % y0]
        else: L += ['G1 X%g' % x0, 'G1 Y%g' % y0]
    return L + ['G0 Z15']

def bore(z=-3.2, cx=60, cy=20, r=4, name='Bore1'):
    L = ['(%s)' % name, 'G0 X%g Y%g' % (cx + r, cy), 'G0 Z5', 'G1 Z0.5 F300']
    zz = 0.5
    while zz > z:
        zz = max(z, zz - 1)
        L.append('G2 X%g Y%g Z%g I%g J0 F600' % (cx + r, cy, zz, -r))
    return L + ['G2 X%g Y%g I%g J0' % (cx + r, cy, -r), 'G0 Z15']

def drill(z=-3.2, pts=((70, 5), (70, 10)), name='Drill1'):
    L = ['(%s)' % name, 'G0 Z15']
    for x, y in pts: L += ['G0 X%g Y%g' % (x, y), 'G0 Z5', 'G1 Z%g F200' % z, 'G0 Z5']
    return L + ['G0 Z15']

def canned(z=-3.2, pts=((74, 30), (74, 35)), code=81, name='Drill2'):
    L = ['(%s)' % name, 'G0 Z15', 'G0 X%g Y%g' % pts[0], 'G98 G%d X%g Y%g Z%g R2 %sF200' % ((code,) + pts[0] + (z, 'Q1 ' if code == 83 else ''))]
    for p in pts[1:]: L.append('X%g Y%g' % p)
    return L + ['G80', 'G0 Z15']

def pocket(z=-1.5, name='2D Pocket1'):
    return ['(%s)' % name, 'G0 X20 Y15', 'G0 Z5', 'G1 Z%g F300' % z, 'G1 X30 F900', 'G1 Y20', 'G1 X20', 'G1 Y15', 'G0 Z15']

def program(*parts, setup=True, stock='x=0..80 y=0..40 z=-3..0'):
    L = ['%', '(1001)', '(T1 D=6.35 CR=0 - ZMIN=-3.2 - flat end mill)']
    if setup:
        L += ['(SETUP job: Bracket [rev B])', '(SETUP stock: %s)' % stock,
              '(SETUP probe-corner: front-left)', '(SETUP router: dial 4)', '(SETUP tool-geom: flat 6.35)']
    L += ['G90 G94', 'G17', 'G21']
    for p in parts: L += p
    return L + ['M5', 'G28 G91 Z0', 'G90', 'M30', '%']

def to_inch(lines):
    # The same program in inches (G20), every coordinate and feed divided by 25.4
    import re
    out = []
    for l in lines:
        if l.startswith('(') or l.startswith('%'): out.append(l); continue
        if l.strip() == 'G21': out.append('G20'); continue
        out.append(re.sub(r'([XYZIJRF])(-?[\d.]+)', lambda m: '%s%.6f' % (m.group(1), float(m.group(2)) / 25.4), l))
    return out

STANDARD = lambda: program(pocket(), contour(), bore(), drill())
