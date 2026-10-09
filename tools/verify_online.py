"""对线上真实站点跑完整验证 —— 这是唯一可信的依据。"""
import asyncio, json, time, sys
from playwright.async_api import async_playwright
ONLINE = "https://recover2026.github.io/agrisense-3s/index.html"
CHROME = "/Users/recover/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell"

R=[]
def rec(n, ok, note=""):
    R.append((n,ok,note)); print(f"{'✓' if ok else '✗'} {n}{('  — '+note) if note else ''}", flush=True)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"], executable_path=CHROME)
        pg = await b.new_page(viewport={"width":1600,"height":950}, device_scale_factor=2)
        await pg.add_init_script("try{sessionStorage.setItem('sf3s_gate_ok_v1','1')}catch(e){}")
        errs=[]
        pg.on("pageerror", lambda e: errs.append(str(e)[:150]))
        pg.on("console", lambda m: errs.append("console:"+m.text[:120]) if m.type=="error" else None)
        t0=time.time()
        await pg.goto(ONLINE, wait_until="load", timeout=90000)
        rec("线上首屏加载", time.time()-t0 < 8, f"{round(time.time()-t0,2)}s")

        v = await pg.evaluate("""()=>({
          fold: !!document.getElementById('dt-fold'),
          dis: !!document.querySelector('#nat-disasters .row.row-click'),
          rc: !!document.querySelector('#uw-counties .row.row-click'),
          prec: !!document.querySelector('#as-precision .row.row-click')})""")
        rec("线上版本已更新", v['fold'] and v['dis'] and v['rc'] and v['prec'],
            f"收起按钮={v['fold']} 灾情行={v['dis']} 承保行={v['rc']} 精度行={v['prec']}")

        await pg.click('.tab[data-tab="national"]')
        for i in range(300):
            n=await pg.evaluate("()=>document.querySelectorAll('#nat-map .esri-imagery img').length")
            if n>0: break
            await pg.wait_for_timeout(100)
        e=await pg.evaluate("document.getElementById('nat-engine').textContent")
        rec("线上：卫星影像 + 状态真实", n>0 and 'Esri' in e, f"{n} 张瓦片 · {e}")

        d = await pg.evaluate("""()=>{document.querySelector('#nat-disasters .row').click();
          const b=[...document.querySelectorAll('#detail [data-dis-code]')];
          return {n:b.length, names:b.map(x=>x.textContent.trim().replace(' ›',''))};}""")
        rec("线上：灾情→多省定位", d['n']>0, f"{d['n']} 个：{d.get('names')}")
        if d['n']>0:
            await pg.evaluate("document.querySelector('#detail [data-dis-code]').click()")
            for i in range(300):
                c=await pg.evaluate("()=>document.querySelectorAll('#nat-map path[data-kind=city]').length")
                if c>0: break
                await pg.wait_for_timeout(100)
            sc=await pg.evaluate("document.getElementById('nat-scope').textContent")
            rec("线上：点省真能下钻", c>0, f"{sc} · {c} 市面")
        await pg.evaluate("()=>window.__APP__&&window.__APP__.closeDetail()")

        await pg.click('.tab[data-tab="warn"]'); await pg.wait_for_timeout(3200)
        await pg.evaluate("document.querySelector('#wn-list .row').click()"); await pg.wait_for_timeout(1000)
        w0=await pg.evaluate("()=>Math.round(document.getElementById('detail').getBoundingClientRect().width)")
        await pg.click('#dt-fold'); await pg.wait_for_timeout(800)
        r=await pg.evaluate("""()=>{const d=document.getElementById('detail');
          const rc=d.getBoundingClientRect();
          const m=document.querySelector('#map-wn').getBoundingClientRect();
          const pts=[[0.5,0.5],[0.2,0.2],[0.8,0.2],[0.2,0.8],[0.8,0.8],[0.5,0.15]];
          let b=0; pts.forEach(([fx,fy])=>{const x=m.left+m.width*fx,y=m.top+m.height*fy;
            if(x>=rc.left&&x<=rc.right&&y>=rc.top&&y<=rc.bottom)b++;});
          return {mini:d.classList.contains('mini'), w:Math.round(rc.width), blocked:b};}""")
        rec("线上：详情可收起且不挡地图", r['mini'] and r['blocked']==0,
            f"宽 {w0}→{r['w']}px 遮挡 {r['blocked']}/6")
        await pg.evaluate("()=>window.__APP__.closeDetail()")

        print("\n--- 各视图卫星影像 ---", flush=True)
        for tab,label,mc in [("qual","资质资格","#qual-map"),("overview","总览","#map-overview"),
                             ("underwrite","承保风险","#map-uw"),("claims","理赔定损","#map-cl"),
                             ("warn","预警调度","#map-wn")]:
            await pg.click(f'.tab[data-tab="{tab}"]')
            for i in range(300):
                t=await pg.evaluate(f"()=>document.querySelectorAll('{mc} .esri-imagery img').length")
                if t>0: break
                await pg.wait_for_timeout(100)
            rec(f"线上：{label} 影像", t>0, f"{t} 张瓦片")

        print("\n--- 核心功能抽查 ---", flush=True)
        await pg.click('.tab[data-tab="claims"]'); await pg.wait_for_timeout(3400)
        await pg.evaluate("document.querySelector('#cl-counties .row').click()"); await pg.wait_for_timeout(1700)
        r=await pg.evaluate("()=>({on:document.getElementById('detail').classList.contains('on'),len:(document.getElementById('dt-body')||{}).innerHTML.length})")
        rec("线上：理赔案件详情", r['on'] and r['len']>200, f"{r['len']}字")
        await pg.evaluate("()=>window.__APP__.closeDetail()")
        await pg.click('.tab[data-tab="underwrite"]'); await pg.wait_for_timeout(3200)
        await pg.evaluate("document.querySelectorAll('#uw-counties .row')[1].click()"); await pg.wait_for_timeout(1700)
        r=await pg.evaluate("()=>({on:document.getElementById('detail').classList.contains('on'),len:(document.getElementById('dt-body')||{}).innerHTML.length})")
        rec("线上：承保风险画像", r['on'] and r['len']>200, f"{r['len']}字")
        await pg.evaluate("()=>window.__APP__.closeDetail()")
        await pg.click('.tab[data-tab="assess"]'); await pg.wait_for_timeout(2800)
        await pg.evaluate("document.querySelector('#as-table tbody tr').click()"); await pg.wait_for_timeout(1300)
        r=await pg.evaluate("()=>({on:document.getElementById('detail').classList.contains('on'),len:(document.getElementById('dt-body')||{}).innerHTML.length})")
        rec("线上：灾损评估详情", r['on'] and r['len']>200, f"{r['len']}字")
        await pg.evaluate("()=>window.__APP__.closeDetail()")

        ok=sum(1 for _,o,_ in R if o)
        print(f"\n{'='*54}\n★ 线上验证 {ok}/{len(R)} 通过 ({ok*100//len(R)}%)   JS错误 {len(errs)}")
        for x in errs[:6]: print("   ", x)
        await b.close()

asyncio.run(main())
