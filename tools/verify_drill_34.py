import asyncio, json
from playwright.async_api import async_playwright
URL = "http://127.0.0.1:8899/index.html"
CHROME = "/Users/recover/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell"

PROVS = [(c,n) for c,n in [
 ("110000","北京"),("120000","天津"),("130000","河北"),("140000","山西"),("150000","内蒙古"),
 ("210000","辽宁"),("220000","吉林"),("230000","黑龙江"),("310000","上海"),("320000","江苏"),
 ("330000","浙江"),("340000","安徽"),("350000","福建"),("360000","江西"),("370000","山东"),
 ("410000","河南"),("420000","湖北"),("430000","湖南"),("440000","广东"),("450000","广西"),
 ("460000","海南"),("500000","重庆"),("510000","四川"),("520000","贵州"),("530000","云南"),
 ("540000","西藏"),("610000","陕西"),("620000","甘肃"),("630000","青海"),("640000","宁夏"),
 ("650000","新疆"),("710000","台湾"),("810000","香港"),("820000","澳门")]]

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"], executable_path=CHROME)
        pg = await b.new_page(viewport={"width":1600,"height":950})
        await pg.add_init_script("try{sessionStorage.setItem('sf3s_gate_ok_v1','1')}catch(e){}")
        await pg.goto(URL, wait_until="load", timeout=60000)
        await pg.click('.tab[data-tab="national"]'); await pg.wait_for_timeout(3000)

        for code, label in PROVS:
            await pg.evaluate("(c)=>{window.__NAT_VIEW__.renderProvince(c)}", code)
            await pg.wait_for_timeout(2500)
            cities = await pg.evaluate("()=>[...document.querySelectorAll('#nat-map path[data-kind=city]')].map(p=>p.dataset.id)")
            sc = await pg.evaluate("document.getElementById('nat-scope').textContent")
            if not cities:
                print(f"✗ {label}: {sc}  市面=0  ← 省级下钻就断了")
                continue
            await pg.evaluate("(c)=>{window.__NAT_VIEW__.pickCity(c)}", cities[0])
            await pg.wait_for_timeout(2600)
            cs = await pg.evaluate("()=>[...document.querySelectorAll('#nat-map path[data-kind=county]')].map(p=>p.dataset.id)")
            t2 = await pg.evaluate("document.getElementById('nat-title').textContent")
            if not cs:
                print(f"✗ {label}: 市面{len(cities)} → 县面=0 | {t2}")
                continue
            await pg.evaluate("(c)=>{window.__NAT_VIEW__.pickCounty(c)}", cs[0])
            await pg.wait_for_timeout(2600)
            ts = await pg.evaluate("()=>[...document.querySelectorAll('#nat-map path[data-kind=town]')].map(p=>p.dataset.id)")
            t3 = await pg.evaluate("document.getElementById('nat-title').textContent")
            mark = "✓" if ts else "✗"
            print(f"{mark} {label}: 市{len(cities)} 县{len(cs)} 乡镇{len(ts)} | {t3[:40]}")
        await b.close()

asyncio.run(main())
