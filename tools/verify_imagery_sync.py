"""验证 7 个地图的影像跟随：拖动同步 + 单次缩放即时生效。"""
import asyncio, json, time
from playwright.async_api import async_playwright
CHROME = "/Users/recover/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell"

VIEWS = [("national","#nat-map","全国遥感"), ("qual","#qual-map","资质资格"),
         ("overview","#map-overview","总览驾驶舱"), ("underwrite","#map-uw","承保风险"),
         ("claims","#map-cl","理赔定损"), ("warn","#map-wn","预警调度"), ("uw","#uw-map","承保上传")]

SNAP = """(mc)=>{
  const s=document.querySelector(mc+' .gs-stack');
  const es=document.querySelector(mc+' .esri-imagery'); const i=es&&es.querySelector('img');
  return {tx:s?s.getAttribute('transform').match(/translate\\(([-\\d.]+)/)?.[1]:'-',
          left:i?i.style.left:'-', w:i?i.style.width:'-'};
}"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"], executable_path=CHROME)
        pg = await b.new_page(viewport={"width":1600,"height":950})
        await pg.add_init_script("try{sessionStorage.setItem('sf3s_gate_ok_v1','1')}catch(e){}")
        errs=[]
        pg.on("pageerror", lambda e: errs.append(str(e)[:120]))
        await pg.goto("http://127.0.0.1:8899/index.html?t=%d" % int(time.time()*1000),
                      wait_until="load", timeout=60000)
        allok = True
        print("=== 拖动：业务面与影像是否同步 ===")
        for tab, mc, label in VIEWS:
            await pg.click('.tab[data-tab="%s"]' % tab)
            await pg.wait_for_timeout(5500)
            # ⚠️ 必须等瓦片真的就绪再开始测。循环里第一个视图刚显示就测时，
            #    瓦片还在请求中，pointerdown 会落在尚未铺满的影像区，
            #    导致"看起来拖不动"的假失败（实测同代码单独跑 national 正常）。
            for i in range(40):
                ok_tiles = await pg.evaluate("""(mc)=>{
                  const es=document.querySelector(mc+' .esri-imagery');
                  if(!es) return false;
                  const im=es.querySelectorAll('img');
                  if(im.length < 4) return false;
                  let n=0; im.forEach(i=>{if(i.complete&&i.naturalWidth>0)n++;});
                  return n >= Math.min(4, im.length);
                }""", mc)
                if ok_tiles: break
                await pg.wait_for_timeout(150)
            await pg.wait_for_timeout(600)
            before = await pg.evaluate(SNAP, mc)
            pt = await pg.evaluate("""(mc)=>{const r=document.querySelector(mc).getBoundingClientRect();
              return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height*0.35)};}""", mc)
            await pg.mouse.move(pt['x'], pt['y'])
            await pg.mouse.down()
            for k in range(1, 7):
                await pg.mouse.move(pt['x']+k*26, pt['y']+k*9)
                await pg.wait_for_timeout(60)
            await pg.mouse.up()
            await pg.wait_for_timeout(2500)
            mid = await pg.evaluate(SNAP, mc)
            svg_moved = before['tx'] != mid['tx']
            img_moved = before['left'] != mid['left']
            ok = svg_moved and img_moved
            if not ok: allok = False
            print("%s %-6s 业务面=%s 影像=%s" % ('✓' if ok else '✗', label,
                  '✓' if svg_moved else '✗', '✓' if img_moved else '✗'))
            print("      tx %s→%s   瓦片left %s→%s" % (before['tx'], mid['tx'], before['left'], mid['left']))
        print("\n=== 单次滚轮缩放是否即时生效 ===")
        for tab, mc, label in VIEWS:
            await pg.click('.tab[data-tab="%s"]' % tab)
            await pg.wait_for_timeout(5500)
            before = await pg.evaluate(SNAP, mc)
            pt = await pg.evaluate("""(mc)=>{const r=document.querySelector(mc).getBoundingClientRect();
              return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height*0.35)};}""", mc)
            await pg.mouse.move(pt['x'], pt['y'])
            await pg.mouse.wheel(0, -400)
            await pg.wait_for_timeout(2500)
            z = await pg.evaluate(SNAP, mc)
            ok = z['w'] != before['w']
            if not ok: allok = False
            print("%s %-6s 瓦片宽 %s → %s" % ('✓' if ok else '✗', label, before['w'], z['w']))
        print("\n%s" % ("✅ 7 个地图：拖动同步 + 单次缩放 全部正常" if allok else "❌ 仍有失败"))
        print("JS 错误:", errs[:3] if errs else "无")
        await b.close()

asyncio.run(main())
