#!/usr/bin/env python3
"""Screenshot the v2 app (root) in demo mode at iPhone size, light and dark: every tab plus the main sheets.
Usage: python3 tools/shots2.py [outdir]   (needs playwright + Chrome; set CHROME to override the binary)"""
import asyncio, os, subprocess, sys, time
from playwright.async_api import async_playwright
APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(APP, "..", "shots2")
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")
PORT = 8767


async def main():
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
                await pg.goto(f"http://127.0.0.1:{PORT}/")
                await pg.click("text=先看示範資料")
                await pg.wait_for_selector(".tabbar")
                await pg.wait_for_timeout(700)
                for tab in ("總覽", "明細", "股票", "計畫", "設定"):
                    await pg.click(f'.tabbar button:has-text("{tab}")')
                    await pg.wait_for_timeout(600)
                    await pg.screenshot(path=os.path.join(OUT, f"{scheme}-{tab}.png"), full_page=True)
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
