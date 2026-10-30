# Hands-off probe tuning (1.48.0) in a browser, against the mock controller (its block is turned
# 1 degree, its stylus ball is really 1.95 mm, and its X/Y are 0.03 degrees out of square):
#  - Probe setup -> Tune the probe automatically: block, stylus push, position, one Start
#  - the homing is checked first when due, then one program with all 6 runs
#  - the screen goes away mid-run; the results are saved when Probe setup is opened again
#  - a probe E-stop says the probe found nothing, not "You pressed E-stop"
#   (cd src/react-ui && npx vite build && PORT=8098 node mock/server.mjs &) ; python3 src/react-ui/test/tuning.py [port] [shots]
import asyncio, json, sys, os, re, math, urllib.request
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else '8098'
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
    print('  screen:', (await text(page, sel))[:900]); await shot(page, 'tu-fail.png')
    return None
async def dismiss(page):
    for t in ('Cancel', 'Not now', 'Later'):
        loc = page.locator(f'.modal button:has-text("{t}")')
        if await loc.count(): await loc.first.click()
async def open_tuning(page):
    await page.click('button:has-text("Probe setup")'); await page.wait_for_timeout(1200)
    await page.click('.modal button:has-text("Tune the probe automatically")'); await page.wait_for_timeout(1000)
    await page.click('.modal button:has-text("Next")'); await page.wait_for_timeout(400)
    await ws(page, 'mock:touch'); await page.wait_for_timeout(1000)

async def main():
    prefs = http('/api/next-store/prefs') or {}
    # the setter is set up and a reference homing saved, but this homing (mock home_at 1) isn't checked
    prefs['setter'] = {'x': 763.2, 'y': 757.9, 'z': -60, 'keep': 30, 'installed': True, 'href': {'x': 763.2, 'y': 757.9, 'time': 1}, 'hchk': {'at': 0, 'time': 1}}
    prefs['measure'] = {**(prefs.get('measure') or {}), 'ball': 2.0}
    for k in ('square', 'tune'): prefs.pop(k, None)
    http('/api/next-store/prefs', prefs)
    async with async_playwright() as p:
        b = await p.chromium.launch(**({'executable_path': CHROME, 'args': ['--no-sandbox']} if CHROME else {}))
        page = await b.new_page(viewport={'width': 1440, 'height': 1000})
        errs = []; page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(BASE + '/'); await page.wait_for_timeout(1500); await dismiss(page)
        await ws(page, 'mock:pos 200 150 -30'); await page.wait_for_timeout(300)

        # ---- 1. One start, all the way through, screen open ----
        n0 = len(http('/api/mdis'))
        await open_tuning(page)
        t = await text(page, '.modal')
        check('position step: one Start runs all 6', 'Start: run all 6' in t and 'walk away' in t, t[:300])
        await shot(page, 'tu1-place.png')
        await page.click('.modal button:has-text("Start: run all 6")')
        t = await wait_text(page, '.modal', r'Stylus calibration, run|Squareness, run', 30)
        check('the homing is checked first (it was due), then the runs start', t and 'Homing check' in t, (t or '')[:300])
        await shot(page, 'tu2-running.png')
        t = await wait_text(page, '.modal', r'\(saved\)|not saved|Stopped', 40)
        await page.wait_for_timeout(800); t = await text(page, '.modal')
        await shot(page, 'tu3-results.png')
        sent = http('/api/mdis')[n0:]
        tune = [m for m in sent if m.startswith('(Probe tuning:')]
        ih = next((i for i, m in enumerate(sent) if '(Tool setter: find centre)' in m), None)
        it = next((i for i, m in enumerate(sent) if m.startswith('(Probe tuning:')), None)
        check('one program for all 6 runs, sent after the homing check', len(tune) == 1 and ih is not None and ih < it, (len(tune), ih, it))
        check('  3 stylus runs and 3 squareness runs in it, no else', tune and tune[0].count('(Measure stock, calibration)') == 3 and tune[0].count('(Squareness check') == 3 and not re.search(r'^o\d+ else', tune[0], re.M))
        pr = http('/api/next-store/prefs')
        ball = (pr.get('measure') or {}).get('ball')
        check('stylus saved: the mock\'s real 1.95 mm (the block\'s turn taken out)', ball is not None and abs(ball - 1.95) < 0.003, ball)
        want = 400 * math.tan(math.radians(0.03))
        sq = pr.get('square') or {}
        check('squareness saved: 0.21 mm over 400 mm, from 3 runs', sq.get('runs') == 3 and abs(sq.get('drift400', 0) - want) < 0.01, sq)
        check('results shown: both saved, the correction for the block\'s turn said', 'Stylus ball 1.950 mm (saved)' in t and 'Squareness 0.21 mm over 400 mm (saved)' in t and 'turned 1.03' in t, t[:900])
        await page.click('.modal button:has-text("Close")'); await page.wait_for_timeout(1200)
        check('Probe setup comes back after, with squareness done', 'mm over 400 mm' in await text(page, '.modal'))
        await page.click('.modal button:has-text("Close")'); await page.wait_for_timeout(600)
        await dismiss(page)

        # ---- 2. The screen goes away during the run ----
        pr['measure']['ball'] = 2.0; pr.pop('square', None); http('/api/next-store/prefs', pr)
        await open_tuning(page)
        await page.click('.modal button:has-text("Start: run all 6")')
        await wait_text(page, '.modal', r'Stylus calibration, run', 20)
        await page.goto('about:blank'); await asyncio.sleep(6)      # phone asleep, run finishes meanwhile
        pr = http('/api/next-store/prefs')
        check('while no screen is open nothing is saved yet', pr['measure']['ball'] == 2.0 and not pr['tune'].get('saved'))
        await page.goto(BASE + '/'); await page.wait_for_timeout(2500)
        # The tuning screen is shared, so it opens again by itself and saves what finished
        t = await text(page, '.modal')
        pr = http('/api/next-store/prefs')
        check('coming back: the tuning screen opens again and saves the finished run', abs(pr['measure']['ball'] - 1.95) < 0.003 and pr['tune'].get('saved') and pr.get('square', {}).get('runs') == 3 and '(saved)' in t,
              (pr['measure'].get('ball'), pr['tune'].get('saved'), t[:200]))
        await shot(page, 'tu3b-after-sleep.png')
        for _ in range(3):
            if await page.locator('.modal button:has-text("Close")').count(): await page.click('.modal button:has-text("Close")'); await page.wait_for_timeout(800)
        # and Probe setup alone saves one that finished with no screen open at all
        pr['measure']['ball'] = 2.0; pr['tune']['saved'] = False; http('/api/next-store/prefs', pr)
        await page.click('button:has-text("Probe setup")'); await page.wait_for_timeout(2000)
        pr = http('/api/next-store/prefs')
        check('opening Probe setup saves a finished run that nobody saved', abs(pr['measure']['ball'] - 1.95) < 0.003 and pr['tune'].get('saved'), pr['measure'].get('ball'))
        await page.click('.modal button:has-text("Close")'); await page.wait_for_timeout(500)

        # ---- 3. A probe E-stop says what happened ----
        await ws(page, 'mock:probe-estop'); await page.wait_for_timeout(1200)
        t = await text(page, '.banner')
        await shot(page, 'tu4-estop.png')
        check('a probe E-stop: "found nothing where it expected", not "You pressed E-stop"', 'found nothing' in t and 'You pressed' not in t, t[:300])
        await page.click('button:has-text("Clear")') if await page.locator('button:has-text("Clear E-stop")').count() else None
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('ALL PASS' if ok else 'SOME FAILED'); sys.exit(0 if ok else 1)

asyncio.run(main())
