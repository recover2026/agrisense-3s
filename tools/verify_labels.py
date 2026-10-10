import asyncio, json, time, sys
from playwright.async_api import async_playwright
CHROME="/Users/recover/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell"
PROV=sys.argv[1]; NAME=sys.argv[2]
URL="http://127.0.0.1:8899/index.html?v=%d" % int(time.time()*1000)
JS = r"""() => {
  const labs = Array.prototype.slice.call(
    document.querySelectorAll('#nat-map .gs-layer-lab text')).filter(t=>t.textContent.trim());
  const boxes = labs.map(t => { const b=t.getBoundingClientRect();
    return {s:t.textContent.trim(), l:b.left,r:b.right,t:b.top,bo:b.bottom}; });
  const hits=[];
  for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){
    const a=boxes[i],b=boxes[j];
    const ox=Math.min(a.r,b.r)-Math.max(a.l,b.l), oy=Math.min(a.bo,b.bo)-Math.max(a.t,b.t);
    if(ox>2&&oy>2) hits.push(a.s+'×'+b.s+' '+Math.round(ox)+'x'+Math.round(oy));}
  return { scope:(document.getElementById('nat-scope')||{}).textContent,
    面:document.querySelectorAll('#nat-map path[data-kind=city]').length,
    标签:boxes.length, 重叠:hits.slice(0,3), 重叠数:hits.length };}"""
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(args=["--no-sandbox"],executable_path=CHROME)
        ctx=await b.new_context(viewport={"width":1440,"height":950},
            device_scale_factor=2, bypass_csp=True)
        pg=await ctx.new_page()
        await pg.add_init_script("try{sessionStorage.setItem('sf3s_gate_ok_v1','1')}catch(e){}")
        errs=[]; pg.on("pageerror",lambda e:errs.append(str(e)[:130]))
        await pg.goto(URL,wait_until="load",timeout=60000)
        await pg.click('.tab[data-tab="national"]'); await pg.wait_for_timeout(6000)
        await pg.evaluate("(c)=>{window.__NAT_VIEW__.renderProvince(c)}", PROV)
        for i in range(200):
            n=await pg.evaluate("()=>document.querySelectorAll('#nat-map path[data-kind=city]').length")
            if n>0: break
            await pg.wait_for_timeout(120)
        await pg.wait_for_timeout(8000)
        r=await pg.evaluate(JS)
        mark='✓' if r['重叠数']==0 and r['标签']>0 else ('✗' if r['重叠数'] else '?')
        print(f"{mark} {NAME}: {r['scope']}  面{r['面']} 标签{r['标签']} 重叠{r['重叠数']} {r['重叠']}")
        print("   错误:", errs[:1] if errs else "无")
        await b.close()
asyncio.run(main())
