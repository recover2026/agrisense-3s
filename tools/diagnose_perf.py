"""量化用户实测反馈的四类问题，全部用可测指标，不靠肉眼猜。

用户 2026-10-11 截图反馈：
  ① 地图刷新点开时间很长、反映慢
  ② 各级地图边界（锯齿、粗细不一、面间接缝）
  ③ 名字（标签裁切、tooltip 出框）
  ④ 移动（拖动跟手度）

⚠️ 计时必须打点在页面内（performance.now），且用【真实鼠标】触发：
   前一版探针把 Playwright 的 IPC 往返也算进去、又用轮询下限当结果，
   七个视图全报 184ms —— 那是探针自己的地板，不是渲染耗时。
   现在由页面在点击后立刻开表、要素连续两次稳定即停表。
"""
import asyncio
import glob
import os
import sys
import time

from playwright.async_api import async_playwright

CHROME = glob.glob(
    "/Users/recover/Library/Caches/ms-playwright/chromium_headless_shell-*/"
    "chrome-headless-shell-mac-arm64/chrome-headless-shell"
)[0]
HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = ("https://recover2026.github.io/agrisense-3s/index.html"
          if len(sys.argv) > 1 and sys.argv[1] == "online"
          else "file://" + os.path.abspath(os.path.join(HERE, "..", "index.html")))

# 在页面里开表
ARM = "()=>{window.__T0=performance.now();window.__N0=(document.querySelectorAll('%s')).length;}"

# 页面内等"要素连续两次稳定且 loading 收起"，返回距 __T0 的毫秒
STOP = """(sel) => new Promise(res => {
  const t0 = window.__T0, n0 = window.__N0;
  let last = -1, stable = 0, firstChange = -1;
  (function tick(){
    const n = document.querySelectorAll(sel).length;
    if (firstChange < 0 && n !== n0) firstChange = performance.now();
    const ld = document.getElementById('nat-loading');
    const busy = ld && /(^| )(on|show|slow)( |$)/.test(ld.className);
    if (n === last && !busy) stable++; else stable = 0;
    last = n;
    // 要么要素变了并稳定，要么超时
    if (stable >= 2 && firstChange >= 0) {
      return res({ms: Math.round(performance.now()-t0), n, waited: Math.round(firstChange-t0)});
    }
    if (performance.now()-t0 > 20000) return res({ms: Math.round(performance.now()-t0), n, timeout:true});
    requestAnimationFrame(tick);
  })();
})"""

# 影像瓦片铺满：覆盖率达标即停（这是走网络的真实耗时）
TILES = """(hostSel) => new Promise(res => {
  const t0 = performance.now();
  (function tick(){
    const h = document.querySelector(hostSel);
    if(!h) return res({ms:0, pct:0, timeout:true});
    const im = [...h.querySelectorAll('.esri-imagery img')];
    const hr = h.getBoundingClientRect();
    let c = 0;
    im.forEach(i=>{ const r=i.getBoundingClientRect(); if(r.width<=0) return;
      const x1=Math.max(r.left,hr.left), y1=Math.max(r.top,hr.top);
      const x2=Math.min(r.right,hr.right), y2=Math.min(r.bottom,hr.bottom);
      if(x2>x1 && y2>y1) c += (x2-x1)*(y2-y1); });
    const pct = hr.width*hr.height ? Math.round(c/(hr.width*hr.height)*100) : 0;
    if (pct >= 90) return res({ms: Math.round(performance.now()-t0), pct});
    if (performance.now()-t0 > 15000) return res({ms: Math.round(performance.now()-t0), pct, timeout:true});
    setTimeout(tick, 80);
  })();
})"""

ONLY = """(args) => {
  const [id, kind] = args;
  const list = id ? [document.querySelector('#nat-map [data-pick][data-id="'+id+'"]')]
                  : [...document.querySelectorAll('#nat-map [data-pick][data-kind="'+kind+'"]')];
  for(const p of list){
    if(!p) continue;
    if(!p.getTotalLength) continue;
    const L=p.getTotalLength();
    for(let f=0.08; f<0.94; f+=0.03){
      const t=p.getPointAtLength(L*f), m=p.getScreenCTM(); if(!m) continue;
      const s=new DOMPoint(t.x,t.y).matrixTransform(m);
      if(s.x<2||s.y<2) continue;
      const h=[...new Set(document.elementsFromPoint(s.x,s.y)
        .map(e=>e.closest('[data-pick]')).filter(Boolean).map(e=>e.dataset.id))];
      if(h.length===1) return {x:s.x, y:s.y, n:p.textContent.trim().slice(0,8)};
    }
  }
  return null;
}"""


async def arm(pg, sel):
    await pg.evaluate(ARM % sel)


async def drill(pg):
    print("\n===== A 逐级下钻：真实点击 → 该级要素画完（页面内计时）=====")
    await pg.click('.tab[data-tab="national"]')
    # ⚠️ 这里必须先 arm 再 STOP：__T0 未定义时 STOP 的完成条件永不成立，
    #    会白等满 20 秒超时（前一版就是这么把下钻段全耗掉的）
    await arm(pg, "#nat-map [data-kind=prov]")
    await pg.evaluate(STOP, "#nat-map [data-kind=prov]")
    steps = [("省→市", "370000", None, "#nat-map [data-kind=city]"),
             ("市→县", None, "city", "#nat-map [data-kind=county]"),
             ("县→乡镇", None, "county", "#nat-map [data-kind=town]"),
             ("乡镇→村", None, "town", "#nat-map [data-kind=vill]")]
    tot = 0
    print(f"  {'层级':8} {'总耗时ms':>8} {'首现ms':>7}  要素数  说明")
    for name, pid, kind, sel in steps:
        pt = await pg.evaluate(ONLY, [pid, kind])
        if not pt:
            print(f"  {name:8} {'—':>8} {'—':>7}   —     找不到独占命中点")
            continue
        await arm(pg, sel)
        await pg.mouse.click(pt["x"], pt["y"])
        r = await pg.evaluate(STOP, sel)
        tot += r["ms"]
        print(f"  {name:8} {r['ms']:>8} {r.get('waited',0):>7}  {r['n']:>4}   {pt['n']}" +
              ("  ⚠超时" if r.get("timeout") else ""))
    print(f"  四级合计 {tot} ms")


async def views(pg):
    print("\n===== A2 切视图：矢量画完 + 影像瓦片铺满（两段分别计时）=====")
    VIEWS = [("overview", ".view.on .mapwrap svg path"),
             ("assess", ".view.on .mapwrap svg path"),
             ("underwrite", ".view.on .mapwrap svg path"),
             ("claims", ".view.on .mapwrap svg path"),
             ("warn", ".view.on .mapwrap svg path"),
             ("qual", ".view.on .mapwrap svg path"),
             ("national", "#nat-map [data-kind=prov]")]
    print(f"  {'视图':11} {'总耗时ms':>9} {'首现ms':>7}  要素数")
    for tab, sel in VIEWS:
        # 先切到一个"一定不同"的视图，再切回目标 —— 否则要素数不变、
        # firstChange 永远为负，会误判成 20 秒超时
        await pg.click('.tab[data-tab="claims"]')
        await pg.wait_for_timeout(200)
        await arm(pg, sel)
        await pg.click(f'.tab[data-tab="{tab}"]')
        try:
            r = await pg.evaluate(STOP, sel)
            tv = await pg.evaluate(TILES, sel.split()[-1] if False else '.view.on .mapwrap')
            print(f"  {tab:11} 矢量 {r['ms']:>5}ms  首现 {r.get('waited',0):>4}ms  "
                  f"要素 {r['n']:>4}  │  影像铺满 {tv['ms']:>5}ms  覆盖 {tv['pct']:>3}%" +
                  ("  ⚠矢量超时" if r.get("timeout") else "") + ("  ⚠影像超时" if tv.get("timeout") else ""))
        except Exception as e:
            print(f"  {tab:11} {'—':>9} {'—':>7}   —     {str(e)[:60]}")


async def strokes(pg):
    print("\n===== B 边界：各层级描边粗细 / 顶点数（锯齿程度）=====")
    await pg.click('.tab[data-tab="national"]')
    await pg.evaluate(STOP, "#nat-map [data-kind=prov]")
    # 逐级下钻到最细，每级都量
    cur = "#nat-map [data-kind=prov]"
    for lvl, (pid, kind) in enumerate([("410000", None), (None, "city"),
                                       (None, "county"), (None, "town")]):
        if lvl:
            pt = await pg.evaluate(ONLY, [pid, kind])
            if not pt:
                break
            nxt = ["city", "county", "town", "vill"][lvl]
            await arm(pg, f"#nat-map [data-kind={nxt}]")
            await pg.mouse.click(pt["x"], pt["y"])
            await pg.evaluate(STOP, f"#nat-map [data-kind={nxt}]")
            cur = f"#nat-map [data-kind={nxt}]"
        d = await pg.evaluate("""(sel)=>{
          const els=[...document.querySelectorAll(sel)].filter(e=>{
            const r=e.getBoundingClientRect(); return r.width>1;});
          if(!els.length) return null;
          const sws=els.map(e=>{
            const a=parseFloat(e.getAttribute('stroke-width'));
            if(a) return a;
            const cs=getComputedStyle(e); return parseFloat(cs.strokeWidth)||0;});
          const pts=els.map(e=>(e.getAttribute('d')||'').split(/[MLCZ]/).filter(Boolean).length);
          const fills=els.map(e=>parseFloat(getComputedStyle(e).fillOpacity));
          return {n:els.length,
            sw:[...new Set(sws.map(v=>Math.round(v*100)/100))].sort((a,b)=>a-b),
            ptsMin:Math.min(...pts), ptsMax:Math.max(...pts),
            ptsAvg:Math.round(pts.reduce((a,b)=>a+b,0)/pts.length),
            swAvg:Math.round(sws.reduce((a,b)=>a+b,0)/sws.length*100)/100};
        }""", cur)
        if d:
            kindname = cur.split("=")[1].rstrip("]").strip("'")
            print(f"  {kindname:6} {d['n']:>4} 面 · 描边 {d['sw']}（均 {d['swAvg']}）"
                  f" · 顶点 {d['ptsMin']}~{d['ptsMax']}（均 {d['ptsAvg']}）")


async def seams(pg):
    print("\n===== B2 相邻面接缝：A 的边界点有多少落在 B 内（越低=缝越大）=====")
    d = await pg.evaluate("""()=>{
      for (const sel of ['#nat-map [data-kind=county]','#nat-map [data-kind=prov]']) {
        const E=[...document.querySelectorAll(sel)];
        if(E.length<2) continue;
        let pairs=0, hits=0;
        for(let i=0;i<E.length&&pairs<30;i++) for(let j=i+1;j<E.length;j++){
          const a=E[i], b=E[j];
          if(!a.getTotalLength||!b.getTotalLength) continue;
          const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
          if(Math.abs(ra.x-rb.x)>100||Math.abs(ra.y-rb.y)>100) continue;
          pairs++;
          const L=a.getTotalLength(); let on=0,n=0;
          const bm=b.getScreenCTM().inverse();
          for(let f=0.02;f<0.98;f+=0.02){
            const t=a.getPointAtLength(L*f), m=a.getScreenCTM(); if(!m) continue;
            const s=new DOMPoint(t.x,t.y).matrixTransform(m);
            n++; try{ if(b.isPointInFill(new DOMPoint(s.x,s.y).matrixTransform(bm))) on++; }catch(e){}
          }
          if(n) hits+=on/n;
        }
        if(pairs) return {sel, pairs, avg:(hits/pairs).toFixed(3)};
      }
      return null;
    }""")
    print("  ", d or "（未取到相邻面样本）")


async def gap_px(pg):
    print("\n===== B3 像素级接缝：同级相邻面之间实际空隙 =====")
    for sel, name in [("#nat-map [data-kind=prov]", "省"),
                      ("#nat-map [data-kind=county]", "县")]:
        d = await pg.evaluate("""(sel)=>{
          const E=[...document.querySelectorAll(sel)].filter(e=>{
            const r=e.getBoundingClientRect(); return r.width>4;});
          if(E.length<2) return null;
          // 采样每个面边界点的"外法线"方向，看多少像素是空的（不是任何面）
          let gaps=0, tot=0, widths=[];
          for(const a of E){
            const L=a.getTotalLength(); if(!L) continue;
            const host=a.ownerSVGElement.getBoundingClientRect();
            for(let f=0.02; f<0.98; f+=0.01){
              const t=a.getPointAtLength(L*f), m=a.getScreenCTM(); if(!m) continue;
              const s=new DOMPoint(t.x,t.y).matrixTransform(m);
              if(s.x<host.left+2||s.x>host.right-2||s.y<host.top+2||s.y>host.bottom-2) continue;
              // 找该点是否在别的面内（用 elementsFromPoint 命中 data-pick 面）
              const hits=[...document.elementsFromPoint(s.x,s.y)]
                .map(e=>e.closest('[data-kind]')).filter(Boolean)
                .filter(e=>e.dataset.id!==a.dataset.id);
              tot++;
              if(!hits.length) gaps++;
            }
          }
          return {faces:E.length, samples:tot, gapPct: tot? Math.round(gaps/tot*100):0};
        }""", sel)
        if d:
            print(f"  {name:3}级 {d['faces']:>3} 面 · 边界采样 {d['samples']} 点 · "
                  f"落在【任何同级面之外】的比例 {d['gapPct']}%")


async def labels(pg):
    print("\n===== C 标签是否被裁切 =====")
    d = await pg.evaluate("""()=>{
      const out=[];
      for (const sel of ['#nat-map','#qual-map','.view.on .mapwrap']){
        const host=document.querySelector(sel); if(!host) continue;
        const hb=host.getBoundingClientRect();
        let n=0, list=[];
        host.querySelectorAll('svg text').forEach(t=>{
          const r=t.getBoundingClientRect(); if(!(r.width>1)) return;
          const o=[];
          if(r.left<hb.left-1)o.push('左'+Math.round(hb.left-r.left));
          if(r.right>hb.right+1)o.push('右'+Math.round(r.right-hb.right));
          if(r.top<hb.top-1)o.push('上'+Math.round(hb.top-r.top));
          if(r.bottom>hb.bottom+1)o.push('下'+Math.round(r.bottom-hb.bottom));
          if(o.length){n++; list.push(t.textContent.trim().slice(0,8)+':'+o.join(','));}
        });
        out.push({sel, n, sample:list.slice(0,5)});
      }
      return out;
    }""")
    for x in d:
        print(f"  {x['sel']:22} 裁切 {x['n']} 个", x['sample'][:3] if x['sample'] else "")


async def drag(pg):
    print("\n===== D 拖动跟手度：真实鼠标拖动，量 transform 变化与影像瓦片重建 =====")
    await pg.click('.tab[data-tab="national"]')
    await pg.evaluate(STOP, "#nat-map [data-kind=prov]")
    hb = await (await pg.query_selector("#nat-map")).bounding_box()
    cx, cy = hb["x"] + hb["width"] / 2, hb["y"] + hb["height"] / 2
    before = await pg.evaluate(
        "()=>{const g=document.querySelector('#nat-map svg .gs-stack');return g?g.getAttribute('transform'):''}")
    t0 = time.time()
    await pg.mouse.move(cx, cy)
    await pg.mouse.down()
    lat = []
    for i in range(1, 21):
        await pg.mouse.move(cx + i * 8, cy + i * 3)
        lat.append(round((time.time() - t0) * 1000))
    await pg.mouse.up()
    await pg.wait_for_timeout(1500)
    after = await pg.evaluate(
        "()=>{const g=document.querySelector('#nat-map svg .gs-stack');return g?g.getAttribute('transform'):''}")
    tiles = await pg.evaluate(
        "()=>[...document.querySelectorAll('#nat-map .esri-imagery img')].filter(i=>i.naturalWidth>0).length")
    print(f"  20 步拖动共 {lat[-1]} ms · transform 变化: {before != after} · 瓦片 {tiles} 张")
    print(f"  每步耗时: {lat}")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"], executable_path=CHROME)
        pg = await (await b.new_context(viewport={"width": 1600, "height": 950})).new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)[:160]))
        await pg.goto(TARGET + "?t=" + str(int(time.time())), wait_until="load", timeout=90000)
        await pg.wait_for_timeout(2500)
        if await pg.locator("#sfGate").count():
            await pg.evaluate("()=>{try{sessionStorage.setItem('sf3s_gate_ok_v1','1')}catch(e){}"
                              "const g=document.getElementById('sfGate');if(g)g.remove();"
                              "document.documentElement.style.overflow='';}")
        await pg.wait_for_timeout(1800)
        print(f"目标：{TARGET}")
        await drill(pg)
        await views(pg)
        await strokes(pg)
        await seams(pg)
        await gap_px(pg)
        await labels(pg)
        await drag(pg)
        if errs:
            print("\n运行期错误:", list(dict.fromkeys(errs))[:3])
        await b.close()


asyncio.run(main())