import asyncio, json, time
from playwright.async_api import async_playwright
CHROME="/Users/recover/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell"
URL="http://127.0.0.1:8899/index.html?t=%d" % int(time.time()*1000)
SNAP = """() => {
  const N = window.__NAT__;
  const cs = Array.prototype.slice.call(document.querySelectorAll('.dual-raster-wrap canvas'));
  const vis = cs.filter(c => c.width > 2 && getComputedStyle(c).display !== 'none');
  const ov = document.querySelector('#nat-map .gs-overlay');
  const ovT = ov ? Array.prototype.slice.call(ov.querySelectorAll('text'))
                        .filter(t => t.getAttribute('fill') === '#fff') : [];
  const esri = document.querySelector('#nat-map .esri-imagery');
  return {
    遥感: Object.keys(N.rasterSet).filter(k=>N.rasterSet[k]).join(',') || '无',
    业务: Object.keys(N.bizSet).filter(k=>N.bizSet[k]).join(',') || '无',
    底图: N.showBase, 边界: N.showEdge, 标注: N.showLabel,
    栅格可见: vis.length, 标签: ovT.length,
    影像: esri ? getComputedStyle(esri).display : '无',
    计数: (document.getElementById('lay-cnt')||{}).textContent
  };
}"""
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(args=["--no-sandbox"],executable_path=CHROME)
        pg=await b.new_page(viewport={"width":1600,"height":950},device_scale_factor=2)
        await pg.add_init_script("try{sessionStorage.setItem('sf3s_gate_ok_v1','1')}catch(e){}")
        errs=[]; pg.on("pageerror",lambda e:errs.append(str(e)[:150]))
        await pg.goto(URL,wait_until="load",timeout=60000)
        await pg.click('.tab[data-tab="national"]'); await pg.wait_for_timeout(6000)
        await pg.evaluate("()=>{window.__NAT_VIEW__.renderProvince('650000')}")
        for i in range(250):
            n=await pg.evaluate("()=>document.querySelectorAll('#nat-map path[data-kind=city]').length")
            if n>0: break
            await pg.wait_for_timeout(100)
        await pg.wait_for_timeout(7000)
        async def show(tag):
            r = await pg.evaluate(SNAP)
            print(tag, json.dumps(r, ensure_ascii=False))
        await show("①默认NDVI  ")
        await pg.evaluate("()=>document.querySelector('[data-lay=drought]').click()"); await pg.wait_for_timeout(5000)
        await show("②叠干旱    ")
        await pg.evaluate("()=>document.querySelector('[data-lay=flood]').click()"); await pg.wait_for_timeout(5000)
        await show("③叠洪涝    ")
        await pg.evaluate("()=>document.querySelector('[data-lay=cover]').click()"); await pg.wait_for_timeout(4000)
        await show("④加承保    ")
        await pg.evaluate("()=>document.querySelector('[data-lay=label]').click()"); await pg.wait_for_timeout(4000)
        await show("⑤关标注    ")
        await pg.evaluate("()=>document.querySelector('[data-lay=base]').click()"); await pg.wait_for_timeout(4000)
        await show("⑥关影像    ")
        await pg.evaluate("()=>document.querySelector('.laybtn[data-act=all]').click()"); await pg.wait_for_timeout(8000)
        await show("⑦全选8层  ")
        await pg.evaluate("()=>document.querySelector('.laybtn[data-act=none]').click()"); await pg.wait_for_timeout(5000)
        await show("⑧清空专题  ")
        # 再恢复，确认可逆
        await pg.evaluate("()=>document.querySelector('[data-lay=ndvi]').click()"); await pg.wait_for_timeout(5000)
        await show("⑨恢复单层  ")
        print("错误:", errs[:3] if errs else "无")
        await b.close()
asyncio.run(main())
