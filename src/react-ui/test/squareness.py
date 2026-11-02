# X/Y squareness check (1.43.0) in a browser, against the mock controller (MOCK_SKEW: how far its
# X and Y are out of square, default 0.03 degrees): Probe setup -> Check squareness, block size,
# probe check, position, 3 runs, the average, save; Probe setup shows it.
#   (cd src/react-ui && npx vite build && PORT=8098 node mock/server.mjs &) ; python3 src/react-ui/test/squareness.py [port] [shots dir]
import asyncio, json, sys, os, re, math, urllib.request
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else '8098'
SHOTS = sys.argv[2] if len(sys.argv) > 2 else None
BASE = f'http://localhost:{PORT}'
CHROME = os.environ.get('CHROME')
SKEW = float(os.environ.get('MOCK_SKEW', 0.03))
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
    print('  screen:', (await text(page, sel))[:900]); await shot(page, 'sq-fail.png')
    return None

async def main():
    prefs = http('/api/next-store/prefs') or {}
    prefs['measure'] = {**(prefs.get('measure') or {}), 'ball': 1.95, 'ballTime': 1}
    prefs.pop('square', None)
    http('/api/next-store/prefs', prefs)
    async with async_playwright() as p:
        b = await p.chromium.launch(**({'executable_path': CHROME, 'args': ['--no-sandbox']} if CHROME else {}))
        page = await b.new_page(viewport={'width': 1278, 'height': 718})   # the controller's own screen (client log, Nov 2)
        errs = []; page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(BASE + '/'); await page.wait_for_timeout(1500)
        for t in ('Cancel', 'Not now', 'Later'):
            loc = page.locator(f'.modal button:has-text("{t}")')
            if await loc.count(): await loc.first.click()
        await ws(page, 'mock:pos 200 150 -30'); await page.wait_for_timeout(300)

        await page.click('button:has-text("Probe setup")'); await page.wait_for_timeout(1200)
        t = await text(page, '.modal')
        check('Probe setup lists the squareness check', 'Check X/Y squareness' in t and '1-2-3 block' in t, t[:500])
        await page.click('.setup-steps li:has-text("Check X/Y squareness") button'); await page.wait_for_timeout(1200)
        t = await text(page, '.modal')
        check('opens the squareness check, block choice', 'Check X/Y squareness' in t and 'the 3 in side along X' in t, t[:300])
        await shot(page, 'sq1-block.png')
        await page.click('.modal button:has-text("Next")'); await page.wait_for_timeout(500)
        check('asks for the stylus push', 'Push the stylus sideways' in await text(page, '.modal'))
        await ws(page, 'mock:touch'); await page.wait_for_timeout(1000)
        check('then the position step', 'over the middle' in await text(page, '.modal'))
        await shot(page, 'sq2-place.png')
        n0 = len(http('/api/mdis'))
        want = 400 * math.tan(math.radians(SKEW))
        for i in range(3):
            # 1.54.2: only the first run is positioned by hand; Measure again goes back over the block
            if i == 0:
                await page.click('.modal button:has-text("Start measuring")'); await page.wait_for_timeout(300)
                await shot(page, 'sq-run.png')
                bb = await page.locator('.modal button:has-text("Stop")').bounding_box()
                check('while measuring, Stop is on the screen (1.54.2: the move list pushed it off)', bb is not None and bb['y'] + bb['height'] <= 718, bb)
            t = await wait_text(page, '.modal', r'over 400 mm' + (r'.*average of %d' % (i + 1) if i else '') + r'|Stopped', 20)
            if i == 1:
                prog2 = http('/api/mdis')[-1]
                check('Measure again: runs at once, starting back over the block the first run measured', 'Back over the block' in prog2 and 'G38.3 Z' in prog2 and 'X%s' % '' in prog2, prog2[:400])
            if i == 0:
                prog = http('/api/mdis')[n0]
                check('sends the squareness program: block size and ball in it, no else', 'block 76.2 x 50.8, ball 1.95' in prog and not re.search(r'^o\d+ else', prog, re.M), prog[:120])
                m = re.search(r'([\d.]+) mm over 400 mm', t or '')
                check('one run: the skew put into the mock, in mm over 400 mm', m and abs(float(m.group(1)) - want) < 0.01, (t or '')[:400])
                check('  asks for 2 more runs', 'twice more' in (t or ''))
                check('  reports the block size measured', '76.20 mm × 50.80 mm' in (t or ''), (t or '')[:600])
            if i < 2:
                await page.click('.modal button:has-text("Measure again")'); await page.wait_for_timeout(500)
        await shot(page, 'sq3-result.png')
        check('3 runs: the average, a verdict and which corners', 'average of 3' in t and ('Close' in t or 'Square' in t or 'Out of square' in t) and 'front-left and back-right' in t, t[:700])
        await page.click('.modal button:has-text("Save the result")'); await page.wait_for_timeout(600)
        sq = http('/api/next-store/prefs').get('square') or {}
        check('saved', sq.get('runs') == 3 and abs(sq.get('drift400', 0) - want) < 0.01, sq)
        await page.click('.modal button:has-text("Close")'); await page.wait_for_timeout(1200)
        t = await text(page, '.modal')
        check('Probe setup shows it done, with the result', 'mm over 400 mm' in t, t[:700])
        check('no page errors', not errs, errs[:3])
        await b.close()
    print('ALL PASS' if ok else 'SOME FAILED'); sys.exit(0 if ok else 1)

asyncio.run(main())
