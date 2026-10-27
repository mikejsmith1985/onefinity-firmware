# Whole bed camera flow in a browser against the mock controller and its fake
# overhead camera (mock/bedscene.py): park, calibrate with the probe, empty
# bed, find stock, Measure stock from the camera, program fit.
#   (cd src/react-ui && PORT=8097 node mock/server.mjs &) ; python3 src/react-ui/test/bedcam-ui.py [port] [shots dir]
import asyncio, json, subprocess, sys, os, re
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else '8097'
SHOTS = sys.argv[2] if len(sys.argv) > 2 else None
HERE = os.path.dirname(os.path.abspath(__file__))
SCENE = os.path.join(HERE, '..', 'mock', 'bedscene.py')
BED = -100.0
ok = True

def check(name, cond, msg=''):
    global ok
    print(('PASS ' if cond else 'FAIL ') + name, msg); ok = ok and bool(cond)

def project(x, y, z):
    return json.loads(subprocess.run(['python3', SCENE, '--project', str(x), str(y), str(z)], capture_output=True, text=True, check=True).stdout)

async def ws(page, t):
    await page.evaluate("t => new Promise(r => { const s = new WebSocket('ws://'+location.host+'/websocket'); s.onopen = () => { s.send(t); setTimeout(() => { s.close(); r(); }, 150); }; })", t)

async def tap_image(page, px):
    await page.evaluate("document.querySelector('.bedpic svg').scrollIntoView({block: 'center'})"); await page.wait_for_timeout(150)
    box = await page.locator('.bedpic svg').bounding_box()
    await page.mouse.click(box['x'] + px[0] / 1280 * box['width'], box['y'] + px[1] / 720 * box['height'])

async def click(page, sel):
    try: await page.click(sel, timeout=15000)
    except Exception:
        print('FAIL could not press', sel)
        try: print('  screen:', (await page.locator('.bedcam-side, .modal').last.inner_text()).replace('\n', ' | ')[:500])
        except Exception: pass
        await shot(page, 'fail.png'); raise

async def wait(page, sel, timeout=20000):
    try: await page.wait_for_selector(sel, timeout=timeout)
    except Exception:
        print('FAIL never saw', sel)
        try: print('  screen:', (await page.locator('.modal, .bedcam-side').last.inner_text()).replace('\n', ' | ')[:600])
        except Exception: pass
        await shot(page, 'fail.png'); raise

async def side(page):
    return (await page.locator('.bedcam-side').inner_text()).replace('\n', ' | ')

async def shot(page, name):
    if SHOTS: await page.screenshot(path=os.path.join(SHOTS, name))

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); page = await b.new_page(viewport={'width': 1440, 'height': 1000})
        errs = []; page.on('pageerror', lambda e: errs.append(str(e))); PAGE['p'] = page
        await page.goto(f'http://localhost:{PORT}/'); await page.wait_for_timeout(1500)
        for t in ('Cancel', 'Not now', 'Later'):
            loc = page.locator(f'.modal button:has-text("{t}")')
            if await loc.count(): await loc.first.click()
        await click(page, 'button[role=tab]:has-text("Camera")'); await page.wait_for_timeout(500)
        await page.select_option('.cam-mount select', 'bed'); await page.wait_for_timeout(800)

        await ws(page, 'mock:stock off')
        # Park position
        await ws(page, 'mock:pos 790 790 -1'); await page.wait_for_timeout(300)
        await click(page, 'button:has-text("Save park position here")'); await page.wait_for_timeout(400)
        check('park saved', 'X 790' in await side(page), (await side(page))[:160])

        # Calibrate: 6 spots, the first two lifted
        await click(page, '.bedcam-side button:has-text("Calibrate")'); await page.wait_for_timeout(300)
        spots = [(60, 60), (560, 60), (560, 400), (60, 400), (310, 230), (200, 330)]
        for i, (x, y) in enumerate(spots):
            await ws(page, f'mock:pos {x} {y} {BED + 10}'); await page.wait_for_timeout(250)
            await click(page, 'button:has-text("Touch the bed here")')
            await wait(page, 'text=Tap the bottom of the stylus ball', 15000)
            await page.wait_for_timeout(300)
            await tap_image(page, project(x, y, BED))
            if i == 0:   # use the close-up once: tap its centre
                await page.locator('.bedzoom canvas').scroll_into_view_if_needed()
                z = await page.locator('.bedzoom canvas').bounding_box()
                await page.mouse.click(z['x'] + z['width'] / 2, z['y'] + z['height'] / 2)
                await shot(page, 'bed1-tap.png')
            await click(page, 'button:has-text("Use this tap")'); await page.wait_for_timeout(300)
            if i < 2:
                await click(page, 'button:has-text("Lift 60 mm")')
                await wait(page, 'text=now 60 mm up', 15000); await page.wait_for_timeout(300)
                await tap_image(page, project(x, y, BED + 60.2))
                await click(page, 'button:has-text("Use this tap")'); await page.wait_for_timeout(300)
            else:
                await wait(page, 'button:has-text("Touch the bed here")', 15000)
        await click(page, 'button:has-text("Finish (6 spots)")'); await page.wait_for_timeout(500)
        t = await side(page)
        m = re.search(r'typical error ([\d.]+) mm, worst ([\d.]+) mm.*about (\d+) mm above', t)
        check('calibrated', m is not None, t[:220])
        if m: check('calibration accuracy', float(m.group(2)) < 2, f'typical {m.group(1)} mm, worst {m.group(2)} mm, camera {m.group(3)} mm up (true 900)')

        # Empty bed
        await click(page, 'button:has-text("Take empty-bed picture")'); await wait(page, 'text=Empty-bed picture saved', 20000)
        check('empty-bed picture saved', True)

        # Find stock
        await ws(page, 'mock:stock on')
        await click(page, 'button:has-text("Park and find stock")')
        await wait(page, 'text=Found about', 20000); await page.wait_for_timeout(300)
        t = await side(page)
        mm = re.search(r'Found about \| ?([\d.]+) mm × ([\d.]+) mm.*?turned ([-\d.]+)°.*?X ([\d.]+) mm, Y ([\d.]+) mm', t) or re.search(r'Found about ([\d.]+) mm × ([\d.]+) mm.*?turned ([-\d.]+)°.*?X ([\d.]+) mm, Y ([\d.]+) mm', t)
        check('stock found', mm is not None, t[:240])
        if mm:
            w, l, a, cx, cy = map(float, mm.groups())
            check('found size close to 150 x 90', abs(w - 150) <= 4 and abs(l - 90) <= 4, f'{w} x {l}')
            check('found angle close to 4', abs(a - 4) < 0.6, f'{a}')
            check('found middle close to (300, 250)', abs(cx - 300) < 3 and abs(cy - 250) < 3, f'({cx}, {cy})')
        await shot(page, 'bed2-found.png')

        # Measure it
        await click(page, 'button:has-text("Measure it with the probe")'); await wait(page, '.modal >> text=Measure stock', 10000)
        await page.wait_for_timeout(800)
        mt = (await page.locator('.modal').inner_text()).replace('\n', ' | ')
        check('Measure stock prefilled from the camera', 'from the bed camera' in mt, mt[:200])
        await click(page, '.modal button.primary:has-text("Next")'); await page.wait_for_timeout(400)
        await ws(page, 'mock:touch'); await page.wait_for_timeout(800)
        await click(page, '.modal button:has-text("Move over the stock")')
        await wait(page, '.modal >> text=Ready: the stylus is over the middle', 20000)
        mt = (await page.locator('.modal').inner_text()).replace('\n', ' | ')
        th = re.search(r'about ([\d.]+) mm thick', mt)
        check('height found by the probe', th and abs(float(th.group(1)) - 19) < 0.5, th.group(0) if th else mt[:300])
        await shot(page, 'bed3-ready.png')
        start = page.locator('.modal button.primary:has-text("Start measuring")')
        check('Start measuring enabled', await start.is_enabled())
        await start.click(); await wait(page, '.modal >> text=Measured', 30000)
        await shot(page, 'bed4-measured.png')
        await click(page, '.modal button:has-text("Done")'); await page.wait_for_timeout(500)

        # Program fit
        await click(page, 'button[role=tab]:has-text("Camera")'); await page.wait_for_timeout(800)
        await click(page, 'button:has-text("Check program fits")')
        await wait(page, '.bedcam-side .why >> text=/It fits|goes off the stock|no moves below/', 20000)
        t = await side(page)
        check('program fit reported', 'It fits' in t or 'goes off the stock' in t, t[t.find('WILL THE PROGRAM'):][:400])
        await shot(page, 'bed5-fit.png')
        check('no page errors', not errs, errs)
        await b.close()

PAGE = {}
async def guarded():
    try: await main()
    except Exception as e:
        global ok
        ok = False
        print('FAIL stopped:', str(e).splitlines()[0])
        pg = PAGE.get('p')
        if pg:
            try: print('  screen:', (await pg.locator('.bedcam-side, .modal').last.inner_text()).replace('\n', ' | ')[:400])
            except Exception: pass
            await shot(pg, 'fail.png')
asyncio.run(guarded())
print('ALL OK' if ok else 'SOMETHING FAILED')
sys.exit(0 if ok else 1)
