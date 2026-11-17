#!/usr/bin/env python3
"""Screenshot the app shell in demo mode (no keys needed). Usage: python3 tools/shots.py [outdir]
Requires playwright + a Chrome/Chromium binary. Use it to eyeball every tab after changing the shell."""
import asyncio, os, subprocess, sys, time
from playwright.async_api import async_playwright
APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(APP, "..", "shots")
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")

async def main():
    os.makedirs(OUT, exist_ok=True)
    srv = subprocess.Popen([sys.executable, "-m", "http.server", "8766", "--bind", "127.0.0.1"], cwd=APP,
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
                pg.on("console", lambda m: problems.append(m.text) if m.type == "error" else None)
                pg.on("pageerror", lambda e: problems.append(str(e)))
                await pg.goto("http://127.0.0.1:8766/")
                await pg.click("text=先看示範資料")
                await pg.wait_for_selector(".hero-num")
                await pg.wait_for_timeout(900)
                for tab in ("總覽", "匯報", "明細", "趨勢"):
                    await pg.click(f'.tabbar button:has-text("{tab}")')
                    await pg.wait_for_timeout(300)
                    await pg.screenshot(path=os.path.join(OUT, f"{scheme}-{tab}.png"), full_page=True)
                await c.close()
            await b.close()
    finally:
        srv.terminate()
    print("screenshots in", os.path.abspath(OUT), "| console problems:", problems or "none")

asyncio.run(main())
