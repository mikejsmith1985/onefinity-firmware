# Bed markers and Move-to (1.39.0) in a browser, against the mock controller:
#  - tapping an axis position moves the machine there (work or machine position), Set is the smaller choice
#  - Camera tab -> Carve bed markers: save 3 board corners, the controller picks the spots, the probe
#    measures the board and the setter, the V-bit is measured on the setter, then it carves.
#   (cd src/react-ui && npx vite build && PORT=8097 node mock/server.mjs &) ; python3 src/react-ui/test/bedcam-markers.py [port] [shots dir]
import asyncio, json, sys, os, re, urllib.request
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else '8097'
SHOTS = sys.argv[2] if len(sys.argv) > 2 else None
BASE = f'http://localhost:{PORT}'
CHROME = os.environ.get('CHROME')
ok = True

def check(name, cond, msg=''):
    global ok
    print(('PASS ' if cond else 'FAIL ') + name, msg); ok = ok and bool(cond)

def http(path, body=None):
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(), method='GET' if body is None else 'PUT', headers={'Content-Type': 'application/json'})
    return json.loads(urllib.request.urlopen(req).read() or 'null')

async def ws(page, t):
    await page.evaluate("t => new Promise(r => { const s = new WebSocket('ws://'+location.host+'/websocket'); s.onopen = () => { s.send(t); setTimeout(() => { s.close(); r(); }, 150); }; })", t)

async def shot(page, name):
    if SHOTS: await page.screenshot(path=os.path.join(SHOTS, name), full_page=True)

async def text(page, sel):
    try: return (await page.locator(sel).last.inner_text()).replace('\n', ' | ')
    except Exception: return ''

async def wait_text(page, sel, pattern, timeout):
    t0 = asyncio.get_event_loop().time()
    while asyncio.get_event_loop().time() - t0 < timeout:
        t = await text(page, sel)
        if re.search(pattern, t): return t
        await page.wait_for_timeout(300)
    print('  screen:', (await text(page, sel))[:700]); await shot(page, 'fail.png')
    return None

async def main():
    prefs = http('/api/next-store/prefs') or {}
    prefs['setter'] = {'x': 760, 'y': 760, 'z': -60, 'keep': 30, 'installed': True, 'corr': {'c': 0.19, 'f': 2}}
    http('/api/next-store/prefs', prefs)
    http('/api/next-store/bedcam', {})
    async with async_playwright() as p:
        b = await p.chromium.launch(**({'executable_path': CHROME, 'args': ['--no-sandbox']} if CHROME else {}))
        page = await b.new_page(viewport={'width': 1440, 'height': 1000})
        errs = []; page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(BASE + '/'); await page.wait_for_timeout(1500)
        for t in ('Cancel', 'Not now', 'Later'):
            loc = page.locator(f'.modal button:has-text("{t}")')
            if await loc.count(): await loc.first.click()

        # ---- Move to ----
        await ws(page, 'mock:pos 100 120 -5'); await page.wait_for_timeout(400)
        n0 = len(http('/api/mdis'))
        await page.locator('.axis-val').first.click(); await page.wait_for_timeout(400)
        t = await text(page, '.modal')
        check('tapping X opens Move X', 'Move X' in t and 'Set X to this instead' in t, t[:200])
        await page.fill('.modal input[type=text]', '50'); await page.wait_for_timeout(200)
        await shot(page, 'mk0-move.png')
        await page.click('.modal button.primary:has-text("Move")'); await page.wait_for_timeout(500)
        sent = http('/api/mdis')[n0:]
        check('Move sends a lift then a move to work X50', sent and re.search(r'G53 G0 Z-?[\d.]+\nG0 X50$', sent[-1]), sent)
        await page.locator('.axis-val').first.click(); await page.wait_for_timeout(300)
        await page.fill('.modal input[type=text]', '30')
        await page.locator('.modal label.check:has-text("Machine position") input').check()
        await page.click('.modal button.primary:has-text("Move")'); await page.wait_for_timeout(500)
        sent = http('/api/mdis')[n0:]
        check('Machine position: G53 move to X30', sent and sent[-1].endswith('G53 G0 X30'), sent[-1:])
        await page.locator('.axis-val').first.click(); await page.wait_for_timeout(300)
        await page.fill('.modal input[type=text]', '5000'); await page.wait_for_timeout(200)
        check('outside the travel: Move disabled, says why', await page.locator('.modal button.primary:has-text("Move")').is_disabled() and 'outside' in await text(page, '.modal'))
        await page.click('.modal button:has-text("Cancel")'); await page.wait_for_timeout(300)

        # ---- Bed markers ----
        await page.click('button[role=tab]:has-text("Camera")'); await page.wait_for_timeout(500)
        await page.select_option('.cam-mount select', 'bed'); await page.wait_for_timeout(800)
        side = '.bedcam-side'
        await page.click(f'{side} button:has-text("Carve bed markers")'); await page.wait_for_timeout(400)
        nxt = page.locator(f'{side} button.primary:has-text("Next")')
        check('Next waits for the corners', await nxt.is_disabled())
        for (x, y, name) in ((4, 6, 'front-left'), (806, 3, 'front-right'), (2, 805, 'back-left')):
            await ws(page, f'mock:pos {x} {y} -5'); await page.wait_for_timeout(300)
            await page.click(f'{side} button:has-text("Save {name}")'); await page.wait_for_timeout(500)
        t = await text(page, side)
        check('spots picked 25 mm in from the corners', all(s in t for s in ('front-left: machine X 28.9 mm, Y 30.9', 'front-right: machine X 780.9 mm, Y 28.1', 'back-left: machine X 27.1 mm, Y 779.9')), t[:600])
        await shot(page, 'mk1-corners.png')
        await page.click(f'{side} button:has-text("Go there") >> nth=1'); await page.wait_for_timeout(800)
        sent = http('/api/mdis')
        check('Go there moves over the spot, router off', '(Bed markers: show)' in sent[-1] and 'M3' not in sent[-1], sent[-1][:200])
        await nxt.click(); await page.wait_for_timeout(300)
        check('asks for the probe and a push', 'Push the stylus' in await text(page, side))
        await ws(page, 'mock:touch'); await page.wait_for_timeout(900)
        await page.click(f'{side} button.primary:has-text("Start")')
        t = await wait_text(page, side, r'put the V-bit in|Stopped', 30)
        check('probe measured the board and touched the setter', t and 'put the V-bit in' in t, (t or '')[:300])
        check('setter centre found and saved (1.40.0)', t and 'centre found and saved' in t, (t or '')[:300])
        st = http('/api/next-store/prefs')['setter']
        check('  saved at the centre the probe found, reference kept', abs(st['x'] - 763.2) < 0.01 and abs(st['y'] - 757.9) < 0.01 and st.get('corr'), st)
        await shot(page, 'mk2-swap.png')
        await ws(page, 'mock:tool 12')
        await page.click(f'{side} button.primary:has-text("measure it")')
        t = await wait_text(page, side, r'Ready to carve|Stopped', 30)
        check('V-bit measured', t and 'Ready to carve' in t and 'router turns on' in t.lower(), (t or '')[:300])
        await page.click(f'{side} button.primary:has-text("Carve")')
        t = await wait_text(page, side, r'Markers carved|Stopped', 30)
        await shot(page, 'mk3-done.png')
        check('carved', t and 'Markers carved' in t, (t or '')[:300])
        carve = [m for m in http('/api/mdis') if '(Bed markers: carve)' in m]
        c = carve[-1] if carve else ''
        # bed -100 (probe), V-bit 12 longer, corr 0.19: surface -87.81, start 3 above, 1.2 deep
        check('carve program: router on, 6 strokes', c.count('M3 S') == 1 and c.count('G1 X20') == 3 and c.count('G1 Y20') == 3 and c.rstrip().endswith('M2'), c[:300])
        check('cuts 1.2 mm into the board, from the measured heights', 'G53 G0 Z-84.81\nG91 G1 Z-4.2 F300' in c, c[:400])
        check('first cross: horizontal arm centred on the front-left spot', 'G53 G0 X19' in c or re.search(r'G53 G0 X1\d\.\d+ Y3\d', c), c[:200])
        bc = http('/api/next-store/bedcam')
        check('marker positions saved', len((bc.get('markers') or {}).get('spots') or []) == 3, bc.get('markers'))
        await page.click(f'{side} button.primary:has-text("Done")'); await page.wait_for_timeout(300)
        check('Camera tab says when they were carved', 'Carved' in await text(page, side))

        # wrong corners
        http('/api/next-store/bedcam', {'markCorners': {'fl': {'x': 800, 'y': 5}, 'fr': {'x': 5, 'y': 5}, 'bl': {'x': 800, 'y': 800}}})
        await page.reload(); await page.wait_for_timeout(1500)
        for t in ('Cancel', 'Not now', 'Later'):
            loc = page.locator(f'.modal button:has-text("{t}")')
            if await loc.count(): await loc.first.click()
        await page.click('button[role=tab]:has-text("Camera")'); await page.wait_for_timeout(800)
        await page.click(f'{side} button:has-text("Carve bed markers")'); await page.wait_for_timeout(400)
        check('swapped corners are caught', 'swapped' in await text(page, side) and await nxt.is_disabled())
        # Tool setter screen: Find the centre with the probe (1.40.0)
        pr = http('/api/next-store/prefs'); pr['setter'] = {**pr['setter'], 'x': 760, 'y': 760}; http('/api/next-store/prefs', pr)
        await page.reload(); await page.wait_for_timeout(1500)
        for t in ('Cancel', 'Not now', 'Later'):
            loc = page.locator(f'.modal button:has-text("{t}")')
            if await loc.count(): await loc.first.click()
        await page.click('button:has-text("Tool setter")'); await page.wait_for_timeout(1200)
        await page.click('.modal button:has-text("Find the centre with the probe")'); await page.wait_for_timeout(300)
        check('Tool setter: asks to push the stylus first', 'Push the stylus sideways' in await text(page, '.modal'))
        await ws(page, 'mock:touch'); await page.wait_for_timeout(900)
        await page.click('.modal button:has-text("Start: find the centre")')
        t = await wait_text(page, '.modal', r'Centre found|Stopped', 20)
        await shot(page, 'mk4-setter-centre.png')
        check('Tool setter: centre found and saved', t and 'Centre found and saved' in t and 'it was' in t, (t or '')[:300])
        st = http('/api/next-store/prefs')['setter']
        check('Tool setter: saved at the centre, calibration kept', abs(st['x'] - 763.2) < 0.01 and st.get('corr'), st)
        await page.click('.modal button:has-text("Close")'); await page.wait_for_timeout(300)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('ALL PASS' if ok else 'SOME FAILED'); sys.exit(0 if ok else 1)

asyncio.run(main())
