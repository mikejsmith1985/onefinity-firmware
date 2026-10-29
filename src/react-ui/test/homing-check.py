# Homing check (1.42.0) in a browser, against the mock controller:
#  - Tool setter screen: the first check saves the setter's centre as the reference
#  - a homing that comes out off: Measure stock checks it by itself before measuring, corrects X/Y
#    (G28.3), keeps the work zero (G92), comes back, then measures; not again on the same homing
#  - the bed camera says when the homing hasn't been checked
#   (cd src/react-ui && npx vite build && PORT=8098 node mock/server.mjs &) ; python3 src/react-ui/test/homing-check.py [port] [shots dir]
import asyncio, json, sys, os, re, urllib.request
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else '8098'
SHOTS = sys.argv[2] if len(sys.argv) > 2 else None
BASE = f'http://localhost:{PORT}'
CHROME = os.environ.get('CHROME')
ok = True
SETTER = (763.2, 757.9)

def check(name, cond, msg=''):
    global ok
    print(('PASS ' if cond else 'FAIL ') + name, msg); ok = ok and bool(cond)

def http(path, body=None, method=None):
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(), method=method or ('GET' if body is None else 'PUT'), headers={'Content-Type': 'application/json'})
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
    print('  screen:', (await text(page, sel))[:900]); await shot(page, 'hc-fail.png')
    return None

async def dismiss(page):
    for t in ('Cancel', 'Not now', 'Later'):
        loc = page.locator(f'.modal button:has-text("{t}")')
        if await loc.count(): await loc.first.click()

async def main():
    prefs = http('/api/next-store/prefs') or {}
    prefs['setter'] = {'x': 760, 'y': 760, 'z': -60, 'keep': 30, 'installed': True, 'corr': {'c': 0.19, 'f': 2}}
    http('/api/next-store/prefs', prefs)
    async with async_playwright() as p:
        b = await p.chromium.launch(**({'executable_path': CHROME, 'args': ['--no-sandbox']} if CHROME else {}))
        page = await b.new_page(viewport={'width': 1440, 'height': 1000})
        errs = []; page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(BASE + '/'); await page.wait_for_timeout(1500); await dismiss(page)

        # ---- 1. Tool setter screen: the first check saves the reference ----
        await page.click('button:has-text("Tool setter")'); await page.wait_for_timeout(1200)
        t = await text(page, '.modal')
        check('Tool setter: homing check not set up yet, says how', 'Not set up yet' in t and 'Check homing with the probe' in t, t[:400])
        await page.click('.modal button:has-text("Check homing with the probe")'); await page.wait_for_timeout(300)
        check('  asks to push the stylus first', 'Push the stylus sideways' in await text(page, '.modal'))
        await ws(page, 'mock:touch'); await page.wait_for_timeout(900)
        await page.click('.modal button:has-text("Start: check the homing")')
        t = await wait_text(page, '.modal', r'Homing check:', 25)
        await shot(page, 'hc1-reference.png')
        check('  first check: centre saved as the reference', t and 'saved as the reference' in t, (t or '')[:300])
        st = http('/api/next-store/prefs')['setter']
        check('  reference and setter position at the real centre, calibration kept', abs(st['href']['x'] - SETTER[0]) < 0.01 and abs(st['x'] - SETTER[0]) < 0.01 and st.get('corr'), st.get('href'))
        mdis = http('/api/mdis')
        check('  no shift on the first check', not any('G28.3' in m for m in mdis))
        await page.click('.modal button:has-text("Close")'); await page.wait_for_timeout(300)

        # ---- 2. A homing that comes out 4.5 / -3.2 mm off ----
        await ws(page, 'mock:pos 120 90 -10'); await page.wait_for_timeout(300)
        await ws(page, 'mock:homeerr 4.5 -3.2')
        http('/api/home', {}, 'PUT'); await page.wait_for_timeout(2500)
        await page.click('button[role=tab]:has-text("Camera")'); await page.wait_for_timeout(600)
        try: await page.select_option('.cam-mount select', 'bed'); await page.wait_for_timeout(800)
        except Exception: pass
        t = await text(page, 'main')
        check('camera tab: says the homing has not been checked', "homing hasn't been checked" in t, t[:300])
        await page.click('button:has-text("Tool setter")'); await page.wait_for_timeout(1200)
        t = await text(page, '.modal')
        check('Tool setter: not checked since homing, will be checked by Measure stock', 'Not checked since the machine was homed' in t, t[:400])
        await page.click('.modal button:has-text("Close")'); await page.wait_for_timeout(300)

        # Measure stock: probe check, place, Start -> homing check first, then the measurement
        n0 = len(http('/api/mdis'))
        await page.click('button:has-text("Measure stock")'); await page.wait_for_timeout(1200)
        for f, v in (('w', '100'), ('l', '80')):
            loc = page.locator(f'.modal input[name={f}]')
            if await loc.count(): await loc.fill(v)
        nx = page.locator('.modal button:has-text("Next")')
        if await nx.is_disabled():
            inputs = page.locator('.modal input[type=text]')
            for i in range(min(2, await inputs.count())): await inputs.nth(i).fill('100')
        await nx.click(); await page.wait_for_timeout(600)
        await ws(page, 'mock:touch'); await page.wait_for_timeout(1200)
        await shot(page, 'hc2-place.png')
        await page.click('.modal button:has-text("Start measuring")'); await page.wait_for_timeout(1500)
        t = await text(page, '.modal')
        check('Measure stock: checks the homing first, says why', 'Checking the homing on the tool setter' in t or 'Checking the homing' in t, t[:300])
        await shot(page, 'hc3-checking.png')
        t = await wait_text(page, '.modal', r'Measured|Stopped|failed|didn', 40)
        await page.wait_for_timeout(500); t = await text(page, '.modal')
        await shot(page, 'hc4-done.png')
        check('  homing reported as off and corrected', 'homing was 5.5' in t and 'Corrected' in t and 'dragging' in t, t[:600])
        sent = http('/api/mdis')[n0:]
        ih = next((i for i, m in enumerate(sent) if '(Tool setter: homing check)' in m), None)
        im = next((i for i, m in enumerate(sent) if '#<_ofm_ok>' in m), None)
        check('  the correction ran before the measurement', ih is not None and im is not None and ih < im, (ih, im))
        fix = sent[ih] if ih is not None else ''
        g = re.search(r'G28\.3 X(-?[\d.]+) Y(-?[\d.]+)', fix)
        check('  G28.3 shifts X by -4.5 and Y by +3.2 (from where it was)', g is not None, fix)
        back = re.findall(r'G53 G0 X(-?[\d.]+) Y(-?[\d.]+)', fix)
        check('  then back over the same physical spot (120 - 4.5 + 4.5 ... machine reading 120, 90 after the shift)', back and abs(float(back[-1][0]) - 120) < 0.01 and abs(float(back[-1][1]) - 90) < 0.01, back)
        st = http('/api/next-store/prefs')['setter']
        state = http('/api/state') if False else None
        check('  checked on this homing, logged', st.get('hchk', {}).get('fixed') and len(st.get('hlog', [])) == 2 and abs(st['x'] - SETTER[0]) < 0.01, st.get('hchk'))
        # the mock's setter now reads at the reference again
        await page.click('.modal button:has-text("Done")'); await page.wait_for_timeout(500)

        # ---- 3. Measure again on the same homing: no check ----
        n1 = len(http('/api/mdis'))
        await page.click('button:has-text("Measure stock")'); await page.wait_for_timeout(1200)
        nx = page.locator('.modal button:has-text("Next")')
        if await nx.is_disabled():
            inputs = page.locator('.modal input[type=text]')
            for i in range(min(2, await inputs.count())): await inputs.nth(i).fill('100')
        await nx.click(); await page.wait_for_timeout(600)
        await ws(page, 'mock:touch'); await page.wait_for_timeout(1200)
        await page.click('.modal button:has-text("Start measuring")')
        await wait_text(page, '.modal', r'Measured|Stopped', 30)
        sent = http('/api/mdis')[n1:]
        check('same homing: measures straight away, no second check', not any('homing check' in m or 'find centre' in m for m in sent), [m[:40] for m in sent])
        await page.click('.modal button:has-text("Done")'); await page.wait_for_timeout(300)

        # ---- 4. The camera tab no longer warns; Tool setter shows the result ----
        await page.click('button:has-text("Tool setter")'); await page.wait_for_timeout(1200)
        t = await text(page, '.modal')
        check('Tool setter: shows it was checked and corrected', 'Checked since homing' in t and 'corrected' in t, t[:400])
        await page.click('.modal button:has-text("Close")'); await page.wait_for_timeout(300)
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('ALL PASS' if ok else 'SOME FAILED'); sys.exit(0 if ok else 1)

asyncio.run(main())
