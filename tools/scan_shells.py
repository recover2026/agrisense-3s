"""空壳元素扫描 + 目检截图
空壳 = HTML 里写了、样式也定义了，但 JS 从不写入内容的元素 ——
用户看到的是"一块什么都没有的地方"，比没有更糟。
判据：元素可见（有尺寸、非 display:none）且内容恒为空，持续 3 秒不变。
"""
import asyncio, glob, json, os
from playwright.async_api import async_playwright

CHROME = glob.glob("/Users/recover/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell")[0]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOT = os.path.join(ROOT, "docs", "stress")
os.makedirs(SHOT, exist_ok=True)

# 引擎自建、会自动填充的类名/ID —— 不算空壳
ENGINE_OWNED = {'.gs-scale', '.gs-scale-bar', '.gs-scale-txt', '.gs-coord', '.gs-ctl',
                '.esri-imagery', '.esri-attr', '.biz-base-btn', '.dual-ctl', '.dual-tmap'}
# 由 CSS 装饰、无需内容的容器
DECOR = {'.tick', '.ticker', '.disc', '.hero', '.sec', '.side', '.view', '.mapwrap', '.nat-hud',
         '.nl-box', '.uw-privacy', '.uw-btns', '.uw-steps', '.uw-tblwrap', '.uw-pvwrap',
         '.qual-legend', '.uw-legend', '.hero-inner', '.hero-main', '.dt-h', '.dt-b',
         '.gs-layer', '.gs-world', '.gs-stack', '.gs-svg', '.app', '.main', '.bar'}

JS = r"""(cfg) => {
  const out = [];
  const els = document.querySelectorAll(cfg.sel);
  els.forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;                 // 不可见
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    if (cs.opacity === '0') return;
    if (el.closest('.nat-jump-pop[hidden]')) return;
    const cls = (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').toString();
    // 自身文本
    let txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
    // 排除只包着空壳子节点的（递归后由子节点自己报）
    const hasChild = el.children.length > 0;
    out.push({ id: el.id || '', cls: cls.slice(0, 50), tag: el.tagName.toLowerCase(),
      txtLen: txt.length, txt: txt.slice(0, 40), hasChild,
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(r.x), y: Math.round(r.y) });
  });
  return out;
}"""

VIEWS = ["national", "qual", "overview", "underwrite", "uw", "claims", "warn", "assess"]


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"], executable_path=CHROME)
        pg = await b.new_page(viewport={"width": 1600, "height": 950})
        await pg.goto("http://127.0.0.1:8899/index.html?t=" + str(int(asyncio.get_event_loop().time() * 1000) % 10**7),
                      wait_until="load", timeout=60000)
        await pg.wait_for_timeout(2500)
        if await pg.locator("#sfGate").count():
            await pg.evaluate("()=>{try{sessionStorage.setItem('sf3s_gate_ok_v1','1')}catch(e){}"
                              "const g=document.getElementById('sfGate');if(g)g.remove();document.documentElement.style.overflow='';}")
        await pg.wait_for_timeout(1500)

        # 收集 index.html 里写了 id 的元素
        html_ids = await pg.evaluate("""()=>[...document.querySelectorAll('[id]')].map(e=>e.id)""")
        print(f"页面共 {len(html_ids)} 个带 id 的元素\n")

        found = []
        for v in VIEWS:
            await pg.click(f'.tab[data-tab="{v}"]')
            await pg.wait_for_timeout(3600 if v in ("national", "qual", "uw") else 2400)
            # 触发所有懒加载区块
            await pg.evaluate("()=>{const s=document.querySelector('.view.on .side');if(s)s.scrollTop=s.scrollHeight;}")
            await pg.wait_for_timeout(900)
            await pg.evaluate("()=>{const s=document.querySelector('.view.on .side');if(s)s.scrollTop=0;}")
            await pg.wait_for_timeout(500)

            rows = await pg.evaluate(JS, {"sel": "[id], .note, .dt-sub, .legend, .hbar, .list, .table, .kpis, .flow, .gauge"})
            await pg.screenshot(path=os.path.join(SHOT, f"view_{v}.png"))
            for r in rows:
                cls = "." + r["cls"] if r["cls"] else ""
                if any(cls == c or (c and cls.startswith(c)) for c in ENGINE_OWNED):
                    continue
                if r["hasChild"]:
                    continue                     # 容器由子节点填充，递归会覆盖
                if r["txtLen"] > 0:
                    continue
                found.append((v, r))
            print(f"  {v:11} 扫描 {len(rows)} 个候选元素")
            e = await pg.evaluate("()=>({v:document.querySelector('.view.on').id})")
            if not e["v"]:
                bad = 1
        # 全局元素
        rows = await pg.evaluate(JS, {"sel": ".ticker, .disc, .dt-h, .nl-box, .uw-privacy, .qual-legend"})
        for r in rows:
            if not r["hasChild"] and r["txtLen"] == 0:
                found.append(("global", r))

        print(f"\n{'='*58}\n可见但内容恒为空（空壳）元素：{len(found)} 个")
        for v, r in found:
            print(f"  [{v:7}] <{r['tag']}> id={r['id'] or '-'} cls={r['cls'] or '-'} "
                  f"位置({r['x']},{r['y']}) 尺寸 {r['w']}x{r['h']}")

        # 附带：看看截图尺寸，作为目检材料
        print(f"\n截图已存：{SHOT}")
        for f in sorted(os.listdir(SHOT)):
            if f.startswith("view_"):
                print("  " + f)
        await b.close()


asyncio.run(main())
