#!/usr/bin/env python3
"""Screenshot the v2 app (root) in demo mode at iPhone size, light and dark: every tab plus the main sheets.
When the app has the 顧問 (advisor) tab, its page and its main panels (假設, 資金需求試算, 顧問設定) are shot too.
Usage: python3 tools/shots2.py [outdir] [--base /next/] [--port 8767]
  outdir  default ../shots2 (outside the repo)
  --base  URL path of the app to shoot; default "/" (root). Use "/next/" for the advisor preview.
  --port  local server port; default 8767.
(needs playwright + Chrome; set CHROME to override the binary)"""
import argparse, asyncio, os, subprocess, sys, time
from playwright.async_api import async_playwright
APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")


def parse_args():
    ap = argparse.ArgumentParser(description="Screenshot the app in demo mode at iPhone size (light and dark).")
    ap.add_argument("outdir", nargs="?", default=os.path.join(APP, "..", "shots2"))
    ap.add_argument("--base", default="/", help='URL path of the app, e.g. "/" (root) or "/next/" (advisor preview)')
    ap.add_argument("--port", type=int, default=8767, help="local http.server port")
    a = ap.parse_args()
    base = "/" + a.base.strip("/") + "/" if a.base.strip("/") else "/"
    return a.outdir, base, a.port


async def main():
    OUT, BASE, PORT = parse_args()
    os.makedirs(OUT, exist_ok=True)
    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"], cwd=APP,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    problems = []
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
            for scheme in ("light", "dark"):
                c = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, color_scheme=scheme,
                                        locale="zh-TW", is_mobile=True, has_touch=True)
                pg = await c.new_page()
                pg.on("console", lambda m: problems.append(f"{scheme}: {m.text}") if m.type == "error" else None)
                pg.on("pageerror", lambda e: problems.append(f"{scheme}: {e}"))
                await pg.goto(f"http://127.0.0.1:{PORT}{BASE}")
                await pg.click("text=先看示範資料")
                await pg.wait_for_selector(".tabbar")
                await pg.wait_for_timeout(700)
                tabs = ["總覽", "明細", "股票", "計畫", "設定"]
                has_adv = await pg.locator('.tabbar button:has-text("顧問")').count() > 0
                if has_adv:
                    tabs = ["總覽", "明細", "股票", "計畫", "顧問", "設定"]
                for tab in tabs:
                    await pg.click(f'.tabbar button:has-text("{tab}")')
                    await pg.wait_for_timeout(600)
                    await pg.screenshot(path=os.path.join(OUT, f"{scheme}-{tab}.png"), full_page=True)
                if has_adv:
                    # advisor page panels: 假設, 資金需求試算, 顧問設定
                    await pg.click('.tabbar button:has-text("顧問")')
                    await pg.wait_for_timeout(800)
                    for sel, name in ((".adv-assume button.row", "假設"),
                                      (".adv-funds button.row", "資金需求試算"),
                                      ('.page:not([hidden]) button.row:has-text("顧問設定")', "顧問設定")):
                        loc = pg.locator(sel).first
                        if await loc.count() == 0:
                            problems.append(f"{scheme}: panel not found: {name}")
                            continue
                        await loc.click()
                        await pg.wait_for_timeout(700)
                        await pg.screenshot(path=os.path.join(OUT, f"{scheme}-sheet-{name}.png"))
                        await pg.click(".sheet header button.l")
                        await pg.wait_for_timeout(400)
                # sheets
                await pg.click('.tabbar button:has-text("總覽")')
                await pg.wait_for_timeout(300)
                await pg.click(".hero")
                await pg.wait_for_timeout(500)
                await pg.screenshot(path=os.path.join(OUT, f"{scheme}-sheet-結餘.png"))
                await pg.click(".sheet header button.l")
                await pg.wait_for_timeout(400)
                await pg.click('.tabbar button:has-text("股票")')
                await pg.wait_for_timeout(500)
                await pg.click(".stock-row")
                await pg.wait_for_timeout(900)
                await pg.screenshot(path=os.path.join(OUT, f"{scheme}-sheet-個股.png"))
                await pg.click(".sheet header button.l")
                await pg.wait_for_timeout(400)
                await pg.click('.tabbar button:has-text("明細")')
                await pg.wait_for_timeout(400)
                await pg.click(".page:not([hidden]) .list .row")
                await pg.wait_for_timeout(500)
                await pg.screenshot(path=os.path.join(OUT, f"{scheme}-sheet-交易.png"))
                await c.close()
            await b.close()
    finally:
        srv.terminate()
    print("screenshots in", os.path.abspath(OUT), "| console problems:", problems or "none")

asyncio.run(main())
