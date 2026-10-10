import asyncio, time, sys
from playwright.async_api import async_playwright
CHROME="/Users/recover/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell"
PROV=sys.argv[1]; NAME=sys.argv[2]
URL="http://127.0.0.1:8899/index.html?t=%d" % int(time.time()*1000)
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(args=["--no-sandbox"],executable_path=CHROME)
        pg=await b.new_page(viewport={"width":1440,"height":900},device_scale_factor=2)
        await pg.add_init_script("try{sessionStorage.setItem('sf3s_gate_ok_v1','1')}catch(e){}")
        errs=[]; pg.on("pageerror",lambda e:errs.append(str(e)[:120]))
        await pg.goto(URL,wait_until="load",timeout=60000)
        await pg.click('.tab[data-tab="national"]'); await pg.wait_for_timeout(5500)
        await pg.evaluate("(c)=>{window.__NAT_VIEW__.renderProvince(c)}", PROV)
        for i in range(250):
            n=await pg.evaluate("()=>document.querySelectorAll('#nat-map path[data-kind=city]').length")
            if n>0: break
            await pg.wait_for_timeout(100)
        await pg.wait_for_timeout(7000)
        info=await pg.evaluate("""()=>{
          const ov=document.querySelector('#nat-map .gs-overlay');
          const ts=[...ov.querySelectorAll('text')].filter(t=>t.getAttribute('fill')==='#fff');
          const bs=ts.map(t=>t.getBoundingClientRect());
          let hits=0;
          for(let i=0;i<bs.length;i++) for(let j=i+1;j<bs.length;j++){
            const a=bs[i],b=bs[j];
            if(a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top) hits++;}
          const t0=ts[0]; const r=t0?t0.getBoundingClientRect():null;
          return {n:ts.length, hits:hits, x:r?Math.round(r.left):0, y:r?Math.round(r.top):0};}""")
        print(f"{NAME}: 标签{info['n']} 重叠{info['hits']}  错误:{len(errs)}")
        if info['n']:
            x,y=max(0,info['x']-150), max(0,info['y']-100)
            await pg.screenshot(path=f"/tmp/z_{NAME}.png",
                clip={"x":x,"y":y,"width":560,"height":320})
        await b.close()
asyncio.run(main())
