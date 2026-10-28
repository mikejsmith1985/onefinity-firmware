# Hands-off bed camera (1.38.0) in a browser, against the mock controller and its fake overhead
# camera (mock/bedscene.py, which now draws the probe's LED ring: green, red while touched):
# park over the tool setter, automatic calibration (the probe check first), the empty-bed picture
# it takes, then Measure stock -> Find it and measure, hands-off to the end; then Probe setup.
#   (cd src/react-ui && npx vite build && PORT=8096 node mock/server.mjs &) ; python3 src/react-ui/test/bedcam-auto.py [port] [shots dir]
import asyncio, json, sys, os, re, urllib.request
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else '8096'
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
    # A tool setter at the back right, nothing saved for the camera yet
    prefs = http('/api/next-store/prefs') or {}
    prefs['setter'] = {'x': 760, 'y': 760, 'z': -60, 'keep': 30, 'installed': True}
    prefs['measure'] = {**(prefs.get('measure') or {}), 'ball': 1.71}
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
        await page.click('button[role=tab]:has-text("Camera")'); await page.wait_for_timeout(500)
        await page.select_option('.cam-mount select', 'bed'); await page.wait_for_timeout(800)
        await ws(page, 'mock:stock off'); await ws(page, 'mock:pos 400 400 -1'); await page.wait_for_timeout(300)

        side = '.bedcam-side'
        t = await text(page, side)
        check('park defaults to the tool setter', 'Over the tool setter (machine X 760' in t, t[t.find('PARK'):][:160] if 'PARK' in t else t[:200])

        # Calibrate: the probe check, then hands-off
        await page.click(f'{side} button.primary:has-text("Calibrate")'); await page.wait_for_timeout(400)
        check('asks to push the stylus first', 'Push the stylus sideways' in await text(page, side))
        start = page.locator(f'{side} button:has-text("Start")')
        check('no Start before the probe check', await start.count() == 0)
        await ws(page, 'mock:touch'); await page.wait_for_timeout(900)
        check('Start after the stylus was pushed', await start.count() == 1 and await start.is_enabled())
        await start.click()
        t = await wait_text(page, side, r'Calibrated from|Calibration stopped', 240)
        await shot(page, 'auto1-calibrated.png')
        check('calibrated by itself', t and 'Calibrated from' in t, (t or '')[:400])
        if t:
            m = re.search(r'Calibrated from (\d+) spots.*?Typical error ([\d.]+) mm, worst ([\d.]+) mm.*?camera about (\d+) mm above', t)
            check('all 6 spots used', m and m.group(1) == '6', t[:300])
            if m: check('accurate (worst under 1.5 mm)', float(m.group(3)) < 1.5, f'typical {m.group(2)}, worst {m.group(3)} mm, camera {m.group(4)} mm up (true 900)')
            if m: check('camera height close to 900 mm', abs(int(m.group(4)) - 900) < 40, m.group(4))
            check('nothing skipped', 'skipped' not in t and 'lost the probe' not in t, t[:500])
        bc = http('/api/next-store/bedcam')
        check('calibration saved, from the LED', bool(bc.get('cal', {}).get('led')))
        check('empty-bed picture taken at the end', bool(bc.get('base')))
        await page.click(f'{side} button.primary:has-text("Done")'); await page.wait_for_timeout(400)

        # Find it and measure, from Measure stock
        await ws(page, 'mock:stock on'); await ws(page, 'mock:pos 400 400 -1'); await page.wait_for_timeout(300)
        await page.click('button:has-text("Measure stock")'); await page.wait_for_timeout(1200)
        fm = page.locator('.modal button:has-text("Find it and measure")')
        check('Measure stock offers Find it and measure', await fm.count() == 1)
        await fm.click()
        t = await wait_text(page, '.modal', r'Push the stylus sideways|seen nothing|sees nothing', 30)
        check('found the stock and went to the probe check', t and 'Push the stylus' in t, (t or '')[:300])
        await shot(page, 'auto2-check.png')
        await ws(page, 'mock:touch'); await page.wait_for_timeout(500)
        t = await wait_text(page, '.modal', r'Measured \d|Measuring stopped|didn.t work', 90)
        await shot(page, 'auto3-measured.png')
        check('moved over, measured and touched the setter by itself', t and re.search(r'Measured \d', t) and 'take the probe out' in t.lower(), (t or '')[:500])
        mdi = http('/api/mock/mdi') if False else None
        await page.click('.modal button:has-text("Done")'); await page.wait_for_timeout(500)

        # Probe setup checklist
        await page.click('button:has-text("Probe setup")'); await page.wait_for_timeout(1200)
        t = await text(page, '.modal')
        check('Probe setup lists the steps', all(s in t for s in ('Calibrate the stylus', 'tool setter', 'Probe vs cutter', 'bed camera')), t[:300])
        check('stylus and camera ticked, probe vs cutter next', page and await page.locator('.setup-steps li.next >> text=Probe vs cutter').count() == 1, t[:600])
        await shot(page, 'auto4-setup.png')
        await page.click('.setup-steps li.next button.primary'); await page.wait_for_timeout(1200)
        check('the next step opens its screen (Tool setter)', 'Collision guard' in await text(page, '.modal'))
        await page.click('.modal button:has-text("Close")'); await page.wait_for_timeout(1200)
        check('Probe setup comes back when that closes', await page.locator('.modal >> text=Probe setup').count() >= 1)
        await page.click('.modal button:has-text("Close")'); await page.wait_for_timeout(400)

        check('no page errors', not errs, errs[:3])
        await b.close()
    print('ALL PASS' if ok else 'SOME FAILED'); sys.exit(0 if ok else 1)

asyncio.run(main())
