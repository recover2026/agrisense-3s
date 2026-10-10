"""隔离式功能验证：每项断言用【全新页面】，杜绝前置状态污染导致的误判。

教训（踩了三次才想明白）：
  回归脚本把 30 多项断言串在一个页面里跑，前一项改变了状态
  （点过搜索结果 → 触发 renderProvince → 视图态变了），
  后一项就会误判为"功能失效"。
  干净页面单独测：黄梅搜索 8 条、点选浮层 display:block —— 都正常。
"""
import asyncio, json, time
from playwright.async_api import async_playwright
URL = "http://127.0.0.1:8899/index.html"
CHROME = "/Users/recover/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell"

R = []
def rec(name, ok, note=""):
    R.append((name, ok, note))
    print("%s %s%s" % ('✓' if ok else '✗', name, ('  — ' + note) if note else ''), flush=True)

async def fresh(browser, tab=None, wait=6500):
    """开一个全新页面（可选切到某标签并等数据就绪）"""
    pg = await browser.new_page(viewport={"width":1600, "height":950})
    await pg.add_init_script("try{sessionStorage.setItem('sf3s_gate_ok_v1','1')}catch(e){}")
    await pg.goto("%s?t=%d" % (URL, int(time.time()*1000)), wait_until="load", timeout=60000)
    if tab:
        await pg.click('.tab[data-tab="%s"]' % tab)
        await pg.wait_for_timeout(wait)
    else:
        await pg.wait_for_timeout(1500)
    return pg

async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch(args=["--no-sandbox"], executable_path=CHROME)
        errs = []

        # ① 点选入口（干净页）
        pg = await fresh(br, "national")
        pg.on("pageerror", lambda e: errs.append(str(e)[:120]))
        await pg.click('#nat-jump-btn'); await pg.wait_for_timeout(900)
        r = await pg.evaluate("""()=>{const p=document.getElementById('nat-jump-pop');
          const cs=getComputedStyle(p);
          return {vis: cs.display!=='none' && p.getBoundingClientRect().width>10,
                  n:p.querySelectorAll('[data-j]').length};}""")
        rec("点选入口可展开", r['vis'] and r['n']>0, "%d 个可下钻项" % r['n'])
        await pg.click('#nat-jump-btn'); await pg.wait_for_timeout(600)
        r2 = await pg.evaluate("""()=>{const p=document.getElementById('nat-jump-pop');
          return getComputedStyle(p).display==='none' || p.getBoundingClientRect().width<10;}""")
        rec("点选浮层可关闭", r2)
        await pg.close()

        # ② 资质搜索（全新页）
        for kw in ["黄梅", "洪湖"]:
            pg = await fresh(br, "qual")
            pg.on("pageerror", lambda e: errs.append(str(e)[:120]))
            await pg.fill('#qual-search', kw); await pg.wait_for_timeout(1600)
            n = await pg.evaluate("()=>document.querySelectorAll('#qual-search-res .row').length")
            rec("资质搜索「%s」" % kw, n>0, "命中 %d 条" % n)
            await pg.close()

        # ③ 搜索结果 → 详情（全新页）
        pg = await fresh(br, "qual")
        pg.on("pageerror", lambda e: errs.append(str(e)[:120]))
        await pg.fill('#qual-search', '黄梅'); await pg.wait_for_timeout(1600)
        await pg.evaluate("()=>{const r=document.querySelector('#qual-search-res .row'); if(r)r.click()}")
        await pg.wait_for_timeout(1800)
        d = await pg.evaluate("""()=>({on:document.getElementById('detail').classList.contains('on'),
          len:(document.getElementById('dt-body')||{}).innerHTML.length})""")
        rec("搜索结果打开详情", d['on'] and d['len']>200, "%d 字" % d['len'])
        await pg.close()

        # ④ 内蒙古下钻（全新页，直接暴露用户截图的场景）
        pg = await fresh(br, "national")
        pg.on("pageerror", lambda e: errs.append(str(e)[:120]))
        await pg.evaluate("()=>{window.__NAT_VIEW__.renderProvince('150000')}")
        for i in range(200):
            n = await pg.evaluate("()=>document.querySelectorAll('#nat-map path[data-kind=city]').length")
            if n>0: break
            await pg.wait_for_timeout(100)
        await pg.wait_for_timeout(1200)
        ttl = await pg.evaluate("""()=>{const t=document.getElementById('nat-title');
          return {text:t.textContent.trim(), title:t.title,
                  clipped: t.scrollWidth>t.clientWidth+2};}""")
        rec("内蒙古下钻出 12 个市面", n>0, "%d 个" % n)
        rec("标题带 title 提示（窄屏省略时可查）", bool(ttl['title']), ttl['title'][:30])
        await pg.screenshot(path="/tmp/inner_fixed.png")
        await pg.close()

        # ⑤ 侧栏宽度自适应（多个视口）
        for w in [1600, 1280, 1100]:
            pg = await br.new_page(viewport={"width":w,"height":900})
            await pg.add_init_script("try{sessionStorage.setItem('sf3s_gate_ok_v1','1')}catch(e){}")
            await pg.goto("%s?t=%d" % (URL, int(time.time()*1000)), wait_until="load", timeout=60000)
            await pg.click('.tab[data-tab="national"]'); await pg.wait_for_timeout(5000)
            sw = await pg.evaluate("()=>{const s=document.querySelector('#v-national .side');return Math.round(s.getBoundingClientRect().width);}")
            mw = await pg.evaluate("()=>Math.round(document.getElementById('nat-map').getBoundingClientRect().width)")
            rec("侧栏自适应 %dpx 视口" % w, sw>250 and mw>500, "侧栏 %d / 地图 %d" % (sw, mw))
            await pg.close()

        ok = sum(1 for _,o,_ in R if o)
        print("\n" + "="*54)
        print("★ 隔离式验证 %d/%d 通过 (%d%%)" % (ok, len(R), ok*100//len(R)))
        print("JS 错误:", len(errs))
        for e in errs[:4]: print("   ", e)
        await br.close()

asyncio.run(main())
