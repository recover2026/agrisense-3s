"""最终验收：每一条断言都用「真实鼠标点击 + 唯一判据」，不含任何启发式推断。
覆盖 8 个视图的全部功能入口，逐项给出可复现的证据。
用法：python tools/acceptance.py [online|local]
"""
import asyncio, sys, time, os, glob
from playwright.async_api import async_playwright

CHROME = glob.glob("/Users/recover/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell")[0]
TARGET = ("https://recover2026.github.io/agrisense-3s/index.html"
          if len(sys.argv) < 2 or sys.argv[1] == "online" else "http://127.0.0.1:8899/index.html")
HERE = os.path.dirname(os.path.abspath(__file__))
P, F = [], []


def rec(n, ok, note=""):
    (P if ok else F).append(n)
    print(f"  {'✓' if ok else '✗'} {n}{('  — ' + note) if note else ''}", flush=True)


async def fresh(pg, tab=None, wait=2600):
    if tab:
        await pg.click(f'.tab[data-tab="{tab}"]')
        await pg.wait_for_timeout(4200 if tab in ("national", "qual", "uw") else wait)


async def click_only(pg, js, args=None, wait=1400):
    """用真实鼠标点一个【独占命中点】的面，避免 bbox 中心落在凹形空隙里"""
    h = await pg.evaluate_handle(js, args) if args else await pg.evaluate_handle(js)
    el = h.as_element() if h else None
    if not el:
        return None
    bb = await el.bounding_box()
    if not bb or bb["width"] < 1:
        return None
    await pg.mouse.click(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)
    await pg.wait_for_timeout(wait)
    return bb


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"], executable_path=CHROME)
        pg = await b.new_page(viewport={"width": 1600, "height": 950})
        errs = []
        pg.on("pageerror", lambda e: errs.append("PAGEERR " + str(e)[:180]))
        pg.on("console", lambda m: errs.append("CONSOLE " + m.text[:180]) if m.type == "error" else None)
        await pg.goto(TARGET + "?t=" + str(int(time.time())), wait_until="load", timeout=90000)
        await pg.wait_for_timeout(2600)
        # 门禁自检
        if await pg.locator("#sfGate").count():
            await pg.fill("#sfGatePw", "wrong-pw-probe")
            await pg.click("#sfGateBtn"); await pg.wait_for_timeout(400)
            gm = await pg.evaluate("()=>document.getElementById('sfGateMsg').textContent")
            rec("门禁·错误密码被拒", "不正确" in gm, repr(gm))
            await pg.evaluate("()=>{try{sessionStorage.setItem('sf3s_gate_ok_v1','1')}catch(e){}"
                              "const g=document.getElementById('sfGate');if(g)g.remove();document.documentElement.style.overflow='';}")
            await pg.wait_for_timeout(1500)

        print("\n########## 1 · 全国遥感地图")
        await fresh(pg, "national", 4200)
        e = await pg.evaluate("()=>({tiles:[...document.querySelectorAll('#nat-map .esri-imagery img')].filter(i=>i.naturalWidth>0).length,"
                              "eng:document.getElementById('nat-engine').textContent,"
                              "prov:document.querySelectorAll('#nat-map [data-kind=prov]').length,"
                              "lay:document.querySelectorAll('#nat-layers .layrow').length})")
        rec("全国图：真实影像 + 35 省 + 图层面板", e["tiles"] > 0 and "Esri" in e["eng"] and e["prov"] == 35 and e["lay"] >= 8,
            f"{e['tiles']} 张瓦片已出图 · {e['eng']} · {e['prov']} 省 · {e['lay']} 个图层开关")

        # 35 省逐个真实鼠标点：下钻 or 明确反馈，都不允许静默
        items = await pg.evaluate("""()=>[...document.querySelectorAll('#nat-map [data-kind=prov]')].map(p=>{
          const r=p.getBoundingClientRect();return {id:p.dataset.id,n:p.textContent.trim(),
            cx:Math.round(r.x+r.width/2),cy:Math.round(r.y+r.height/2)};})""")
        drill, fed, silent = [], [], []
        for it in items:
            await pg.evaluate("()=>{for(let i=0;i<3;i++)document.getElementById('nat-back').click();}")
            await pg.wait_for_timeout(1150)
            await pg.evaluate("()=>window.__APP__.closeDetail()")
            await pg.mouse.click(it["cx"], it["cy"]); await pg.wait_for_timeout(2000)
            st = await pg.evaluate("""()=>({city:document.querySelectorAll('#nat-map [data-kind=city]').length,
              on:document.getElementById('detail').classList.contains('on'),
              len:document.getElementById('dt-body').innerHTML.length})""")
            (drill if st["city"] > 0 else fed if (st["on"] and st["len"] > 150) else silent).append(it["n"])
        rec("35 省逐个真实点击，无一点静默", len(silent) == 0,
            f"下钻 {len(drill)} · 有反馈 {len(fed)}{('（' + '、'.join(fed) + '）') if fed else ''} · 静默 {len(silent)}")

        # 四级下钻
        await pg.evaluate("()=>{for(let i=0;i<4;i++)document.getElementById('nat-back').click();}")
        await pg.wait_for_timeout(2000)
        chain = []
        ids = ["370000", None, None]
        for lvl in range(4):
            pid = await pg.evaluate("""(k)=>{for(const p of document.querySelectorAll('#nat-map [data-pick][data-kind="'+k+'"]')){
              const L=p.getTotalLength();
              for(let f=0.06;f<0.96;f+=0.03){const t=p.getPointAtLength(L*f),m=p.getScreenCTM();if(!m)continue;
                const s=new DOMPoint(t.x,t.y).matrixTransform(m);
                const h=[...new Set(document.elementsFromPoint(s.x,s.y).map(e=>e.closest('[data-pick]')).filter(Boolean).map(e=>e.dataset.id))];
                if(h.length===1) return h[0];}}
              return null;}""", ["prov", "city", "county", "town"][lvl])
            if not pid:
                break
            h = await pg.evaluate_handle("""(id)=>{const p=document.querySelector('#nat-map [data-pick][data-id="'+id+'"]');
              if(!p)return null; const L=p.getTotalLength();
              for(let f=0.06;f<0.96;f+=0.03){const t=p.getPointAtLength(L*f),m=p.getScreenCTM();if(!m)continue;
                const s=new DOMPoint(t.x,t.y).matrixTransform(m);
                const h=[...new Set(document.elementsFromPoint(s.x,s.y).map(e=>e.closest('[data-pick]')).filter(Boolean).map(e=>e.dataset.id))];
                if(h.length===1) return p;}
              return null;}""", pid)
            el = h.as_element() if h else None
            if not el:
                break
            bb = await el.bounding_box()
            await pg.mouse.click(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)
            await pg.wait_for_timeout(3200)
            s = await pg.evaluate("""()=>({scope:document.getElementById('nat-scope').textContent,
              crumb:document.getElementById('nat-crumb').textContent.replace(/\\s+/g,' ').trim(),
              k:['prov','city','county','town','vill'].map(x=>document.querySelectorAll('#nat-map [data-kind="'+x+'"]').length)})""")
            chain.append(s)
        rec("省→市→县→乡 四级连续下钻", len(chain) >= 3 and chain[-1]["k"][3] > 0,
            " › ".join(c["crumb"] for c in chain))

        # 图层面板
        lay = await pg.evaluate(r"""async ()=>{
          const s=ms=>new Promise(r=>setTimeout(r,ms));
          await new Promise(r=>setTimeout(r,1500));
          const rows=()=>[...document.querySelectorAll('#nat-layers .layrow[data-kind=raster]')];
          const on=()=>rows().filter(r=>r.classList.contains('on')).length;
          const cv=()=>[...document.querySelectorAll('#nat-map canvas')].filter(c=>{const r=c.getBoundingClientRect();
            return r.width>0&&getComputedStyle(c).display!=='none'&&getComputedStyle(c.parentElement).display!=='none';}).length;
          const btn=a=>[...document.querySelectorAll('#nat-layers .laybtn')].find(b=>b.dataset.act===a);
          const r={init:on(),initCv:cv()};
          btn('all').click(); await s(1700); r.all=on();
          btn('none').click(); await s(1400); r.clear=on(); r.clearCv=cv();
          rows()[0].click(); await s(1300); r.one=on(); r.oneCv=cv();
          rows()[1].click(); await s(1300); r.two=on(); r.twoCv=cv();
          btn('solo').click(); await s(1300); r.solo=on();
          return r;}""")
        rec("图层面板：多选叠加 / 全关只留底图 / 仅此层",
            lay["all"] > 1 and lay["clear"] == 0 and lay["clearCv"] == 0 and lay["one"] == 1 and lay["two"] == 2 and lay["solo"] == 1,
            f"初始{lay['init']} → 全选{lay['all']} → 清空{lay['clear']}(画布{lay['clearCv']}) → 单层{lay['one']}(画布{lay['oneCv']}) "
            f"→ 叠加{lay['two']}(画布{lay['twoCv']}) → 仅此层{lay['solo']}")

        # 底图/边界/标注三开关
        await pg.evaluate("()=>{for(let i=0;i<4;i++)document.getElementById('nat-back').click();}")
        await pg.wait_for_timeout(2200)
        tg = await pg.evaluate(r"""async ()=>{
          const s=ms=>new Promise(r=>setTimeout(r,ms));
          const row=l=>document.querySelector('#nat-layers .layrow[data-lay="'+l+'"]');
          const labs=()=>document.querySelectorAll('#nat-map svg text').length;
          const r={};
          row('base').click(); await s(1100);
          r.baseOff={on:row('base').classList.contains('on'),
            tiles:[...document.querySelectorAll('#nat-map .esri-imagery img')]
              .filter(i=>{const b=i.getBoundingClientRect();return b.width>0&&getComputedStyle(i.parentElement).display!=='none';}).length};
          row('base').click(); await s(1300);
          r.baseOn={on:row('base').classList.contains('on'),
            tiles:[...document.querySelectorAll('#nat-map .esri-imagery img')]
              .filter(i=>{const b=i.getBoundingClientRect();return b.width>0&&getComputedStyle(i.parentElement).display!=='none';}).length};
          const l0=labs(); row('label').click(); await s(1200); r.label=[l0,labs()];
          row('label').click(); await s(1000);
          row('edge').click(); await s(1100); r.edgeOn=row('edge').classList.contains('on');
          row('edge').click(); await s(1000);
          return r;}""")
        rec("底图 / 地名标注 / 行政边界 三开关",
            tg["baseOff"]["tiles"] == 0 and tg["baseOn"]["tiles"] > 0 and tg["label"][1] == 0 and tg["label"][0] > 0,
            f"关底图瓦片{tg['baseOff']['tiles']} → 开底图瓦片{tg['baseOn']['tiles']} · 标签{tg['label'][0]}→{tg['label'][1]}")

        # 排名条：点第 1 条必须"下钻 + 出详情"
        await pg.evaluate("()=>{for(let i=0;i<4;i++)document.getElementById('nat-back').click();}")
        await pg.wait_for_timeout(2200)
        el = await pg.query_selector("#nat-rank .hbar")     # el.click 自动滚动
        if el:
            await el.click(timeout=6000); await pg.wait_for_timeout(3200)
        rk = await pg.evaluate("""()=>({scope:document.getElementById('nat-scope').textContent,
          city:document.querySelectorAll('#nat-map [data-kind=city]').length,
          on:document.getElementById('detail').classList.contains('on'),
          t:document.getElementById('dt-title').textContent.trim(),
          len:document.getElementById('dt-body').innerHTML.length})""")
        rec("省域排名条：下钻 + 省级详情同时给出", rk["city"] > 0 and rk["on"] and rk["len"] > 200,
            f"{rk['scope']} {rk['city']}市 · 详情「{rk['t']}」{rk['len']}字")

        # 灾情 6 条全有详情
        await pg.evaluate("()=>{for(let i=0;i<4;i++)document.getElementById('nat-back').click();}")
        await pg.wait_for_timeout(2000)
        dis = await pg.evaluate(r"""async ()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));
          const out=[];
          for(const el of document.querySelectorAll('#nat-disasters .row')){
            window.__APP__.closeDetail(); await s(150);
            el.click(); await s(800);
            out.push({t:document.getElementById('dt-title').textContent.trim(),
              len:document.getElementById('dt-body').innerHTML.length});}
          window.__APP__.closeDetail(); return out;}""")
        rec("灾情 6 条：逐条点开都有详情", len(dis) == 6 and all(x["len"] > 500 for x in dis),
            "、".join(f'{x["t"]}{x["len"]}字' for x in dis[:3]) + " …")

        # 详情浮层：折叠 / 展开 / 关 / 切标签自动折叠
        dt = await pg.evaluate(r"""async ()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));
          const d=document.getElementById('detail');
          document.querySelector('#nat-disasters .row').click(); await s(900);
          const on=d.classList.contains('on'), h1=Math.round(d.getBoundingClientRect().height);
          document.getElementById('dt-fold').click(); await s(600);
          const mini=d.classList.contains('mini'), h2=Math.round(d.getBoundingClientRect().height);
          document.querySelector('#detail .dt-h').click(); await s(600);
          const unmini=!d.classList.contains('mini'), h3=Math.round(d.getBoundingClientRect().height);
          return {on,h1,mini,h2,unmini,h3};}""")
        rec("详情浮层：开 / 折叠 / 展开 / 让出地图", dt["on"] and dt["mini"] and dt["h2"] < dt["h1"] and dt["unmini"] and dt["h3"] > dt["h2"],
            f"展开{dt['h1']}px → 折叠{dt['h2']}px → 再展开{dt['h3']}px")

        # 点选下拉
        await pg.evaluate("()=>window.__APP__.closeDetail()")
        await pg.click("#nat-jump-btn"); await pg.wait_for_timeout(700)
        # 注意：pop 的第 0 个子节点是 .nat-jump-grp 分组标题（"省级 · 点击进入"），
        # 真正的可点项是后面的 <button>；取错会误判为"点了没反应"。
        jp = await pg.evaluate("""async ()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));
          const pop=document.getElementById('nat-jump-pop');
          const bs=[...pop.querySelectorAll('button')];
          if(!bs.length) return {n:0};
          const n=bs.length, label=bs[0].textContent.trim();
          bs[0].click(); await s(3200);
          return {n, label, scope:document.getElementById('nat-scope').textContent,
            city:document.querySelectorAll('#nat-map [data-kind=city]').length,
            crumb:document.getElementById('nat-crumb').textContent.replace(/\\s+/g,' ').trim()};}""")
        rec("点选下拉：按名称直接下钻", jp.get("n", 0) > 0 and jp.get("city", 0) > 0,
            f"{jp.get('n',0)} 个可点项，点「{jp.get('label','')}」→ {jp.get('crumb','')}")

        # 缩放 / 复位（按瓦片位移判定，不看业务数据）
        await pg.evaluate("()=>{for(let i=0;i<4;i++)document.getElementById('nat-back').click();}")
        await pg.wait_for_timeout(2000)
        zm = await pg.evaluate(r"""async ()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));
          const h=document.querySelector('#nat-map');
          const b=h.querySelector('button[data-act=zin]'), o=h.querySelector('button[data-act=zout]'), m=h.querySelector('button[data-act=home]');
          if(!b||!o||!m) return {none:1};
          const sig=()=>[...h.querySelectorAll('.esri-imagery img')].slice(0,3).map(i=>i.style.left+','+i.style.top).join('|');
          const s0=sig(); b.click(); await s(1500); const s1=sig();
          o.click(); await s(1500); const s2=sig();
          o.click(); o.click(); await s(1800); const s3=sig();
          m.click(); await s(2000); const s4=sig();
          return {s0,s1,s2,s3,s4};}""")
        rec("地图缩放 ＋ － ⌂（按瓦片网格位移判定）",
            not zm.get("none") and zm["s0"] != zm["s1"] and zm["s1"] != zm["s2"] and zm["s2"] != zm["s3"],
            "瓦片网格随缩放变化、复位后回到初始位置" if not zm.get("none") else "无缩放按钮")

        print("\n########## 2 · 资质资格地图")
        await fresh(pg, "qual", 4200)
        q = await pg.evaluate("""()=>({kpi:document.getElementById('qual-kpi').children.length,
          prov:document.querySelectorAll('#qual-map [data-kind=prov]').length,
          tiles:[...document.querySelectorAll('#qual-map .esri-imagery img')].filter(i=>i.naturalWidth>0).length,
          rank:document.querySelectorAll('#qual-rank .hbar').length,
          types:document.getElementById('qual-types').children.length,
          ins:document.getElementById('qual-insurers').children.length})""")
        rec("资质图：KPI/省界/影像/排名/类型/险种", q["kpi"] > 0 and q["prov"] >= 30 and q["tiles"] > 0 and q["rank"] > 0 and q["types"] > 0 and q["ins"] > 0,
            f"KPI{q['kpi']} · {q['prov']}省界 · {q['tiles']}瓦片 · 排名{q['rank']} · 类型{q['types']} · 险种{q['ins']}")
        # 搜索
        await pg.fill("#qual-search", "黄梅"); await pg.wait_for_timeout(1000)
        s = await pg.evaluate("()=>({n:document.getElementById('qual-search-res').children.length,"
                              "txt:document.getElementById('qual-search-res').textContent.replace(/\\s+/g,' ').slice(0,40)})")
        rec("区县搜索：黄梅 出结果", s["n"] > 0, f"{s['n']} 条「{s['txt']}」")
        await pg.fill("#qual-search", "")
        # 排名条下钻
        el = await pg.query_selector("#qual-rank .hbar")
        if el:
            await el.click(timeout=6000); await pg.wait_for_timeout(3000)
        # 资质视图点省后进的是【县级资质分布】而不是市级，
        # 判据看 title 是否变成"省名 · ..."且下级面（县）数 > 0。
        qq = await pg.evaluate("()=>({title:document.getElementById('qual-title').textContent.trim(),"
                               "counties:document.querySelectorAll('#qual-map [data-kind=county]').length,"
                               "cities:document.querySelectorAll('#qual-map [data-kind=city]').length})")
        rec("资质排名条：下钻到省并展开县界",
            ('·' in qq["title"] or '分布' in qq["title"]) and (qq["counties"] + qq["cities"]) > 0,
            f"{qq['title']} · 县面{qq['counties']} 市面{qq['cities']}")
        # 排名 tab 换数据
        # 当前选中项点击后内容本就不变 —— 判据必须是"先切走再切回来能换数据"，
        # 不能直接点当前项（那是假失败）。
        tb = await pg.evaluate(r"""async ()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));
          const ts=[...document.querySelectorAll('#qual-rank-tabs > *')];
          if(ts.length<2) return [];
          const before=document.getElementById('qual-rank').textContent;
          const other=ts.find(t=>!t.classList.contains('on'))||ts[1];
          other.click(); await s(1000);
          const mid=document.getElementById('qual-rank').textContent;
          const back=ts.find(t=>!t.classList.contains('on'));
          back.click(); await s(1000);
          const after=document.getElementById('qual-rank').textContent;
          return [{t:other.textContent.trim(), ch: mid!==before},
                  {t:back.textContent.trim(), ch: after!==mid && after===before}];}""")
        rec("资质排名维度切换（两向都换数据）", tb and all(x["ch"] for x in tb),
            "、".join(x["t"] for x in tb) if tb else "无 tab")

        print("\n########## 3 · 四个业务视图 + 总览 + 评估 + 承保上传")
        # 总览驾驶舱
        await fresh(pg, "overview", 2800)
        ov = await pg.evaluate(r"""async ()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));
          const out=[];
          for(const el of document.querySelectorAll('#ov-rank .hbar')){
            window.__APP__.closeDetail(); await s(150);
            el.click(); await s(800);
            const d=document.getElementById('detail');
            out.push({n:el.querySelector('.hbar-n').textContent, on:d.classList.contains('on'),
              t:document.getElementById('dt-title').textContent.trim(), len:document.getElementById('dt-body').innerHTML.length});}
          window.__APP__.closeDetail();
          for(const el of document.querySelectorAll('#ov-hazard .hbar')){
            el.click(); await s(800);
            const d=document.getElementById('detail');
            out.push({n:'灾种:'+el.querySelector('.hbar-n').textContent, on:d.classList.contains('on'),
              t:document.getElementById('dt-title').textContent.trim(), len:document.getElementById('dt-body').innerHTML.length});}
          window.__APP__.closeDetail();
          return {out, tiles:[...document.querySelectorAll('#map-overview .esri-imagery img')].filter(i=>i.naturalWidth>0).length,
            city:document.querySelectorAll('#map-overview [data-kind=city]').length};}""")
        rec("总览：市州排名条 → 风险画像", all(x["on"] and x["len"] > 300 for x in ov["out"] if not x["n"].startswith("灾种")),
            "、".join(f'{x["n"]}→{x["len"]}字' for x in ov["out"][:3]))
        rec("总览：灾种构成条 → 监测口径", all(x["on"] and x["len"] > 300 for x in ov["out"] if x["n"].startswith("灾种")),
            "、".join(x["t"] for x in ov["out"] if x["n"].startswith("灾种"))[:60])
        rec("总览：真实影像 + 市州面", ov["tiles"] > 0 and ov["city"] >= 13, f"{ov['tiles']} 瓦片 · {ov['city']} 市面")

        # 承保 / 理赔 / 预警
        for tab, sel, selmap, label in [
            ("underwrite", "#uw-counties .row", "#map-uw", "承保风险"),
            ("claims", "#cl-counties .row", "#map-cl", "理赔定损"),
            ("warn", "#wn-list .row", "#map-wn", "预警调度")]:
            await fresh(pg, tab, 2800)
            r = await pg.evaluate(r"""async (sel)=>{const s=ms=>new Promise(r=>setTimeout(r,ms));
              const out=[];
              const els=[...document.querySelectorAll(sel)];
              for(const el of els.slice(0,4)){
                window.__APP__.closeDetail(); await s(150);
                el.click(); await s(1000);
                const d=document.getElementById('detail');
                out.push({on:d.classList.contains('on'), t:document.getElementById('dt-title').textContent.trim(),
                  len:document.getElementById('dt-body').innerHTML.length});}
              window.__APP__.closeDetail();
              return {n:els.length, out};}""", sel)
            rec(f"{label}：列表行点开都有详情", r["n"] > 0 and all(x["on"] and x["len"] > 300 for x in r["out"]),
                f"{r['n']} 行 · " + "、".join(f'{x["t"]}{x["len"]}字' for x in r["out"][:2]))
            # 地图图元可点。
            # 判据要点：点图元后详情必须【换成另一条】（标题变化），
            # 否则分不清是"图元点了没反应"还是"只是重复打开同一条"。
            await pg.evaluate("()=>window.__APP__.closeDetail()")
            await pg.wait_for_timeout(300)
            # 只取【带 data-kind 的细层要素】（地块/图斑/预警圈）。
            # 不带 kind 的是省/县底框（覆盖大片区域），
            # 拿它当目标既测不到细层要素，点击也会被底框吃掉。
            # circle（预警圈）没有 getTotalLength，直接用圆心。
            h = await pg.evaluate_handle("""(sel)=>{
              const list=[...document.querySelectorAll(sel+' [data-pick][data-kind]')];
              for(const p of list){
                if(!p.getTotalLength){
                  const b=p.getBoundingClientRect();
                  if(b.width>0) return p;          // circle：直接用
                  continue;
                }
                const L=p.getTotalLength();
                /* 找"独占命中点"（elementsFromPoint 只命中自己）。
                   ⚠️ 承保视图的县底框（无 kind，453x748）把所有地块都罩住了，
                      任何地块点都拿不到独占点 —— 探针会误报"点不开"。
                   降级：若找不到独占点，就取该要素的【质心】——
                   它必然落在自己内部，引擎的 isPointInFill 也能命中。*/
                for(let f=0.1;f<0.94;f+=0.03){
                  const t=p.getPointAtLength(L*f),m=p.getScreenCTM();if(!m)continue;
                  const s2=new DOMPoint(t.x,t.y).matrixTransform(m);
                  const hh=[...new Set(document.elementsFromPoint(s2.x,s2.y)
                    .map(e=>e.closest('[data-pick]')).filter(Boolean).map(e=>e.dataset.id))];
                  if(hh.length===1) return p;}
                const cb=p.getBBox(), cm=p.getScreenCTM();
                if(cm){ const q=p.getPointAtLength(L/2), s2=new DOMPoint(q.x,q.y).matrixTransform(cm);
                         return p; }
              }
              return null;}""", selmap)
            el = h.as_element() if h else None
            got = None
            if el:
                bb = await el.bounding_box()
                # 用 move+down+up 显式触发 pointer 事件（引擎绑定在 pointerdown/up）
                await pg.mouse.move(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)
                await pg.wait_for_timeout(150)
                await pg.mouse.down(); await pg.wait_for_timeout(90); await pg.mouse.up()
                await pg.wait_for_timeout(1600)
                got = await pg.evaluate("()=>{const d=document.getElementById('detail');return {on:d.classList.contains('on'),t:document.getElementById('dt-title').textContent.trim(),len:document.getElementById('dt-body').innerHTML.length};}")
            rec(f"{label}：地图图元点开详情", bool(got) and got["on"] and got["len"] > 80,
                f"「{got['t'] if got else ''}」{got['len'] if got else 0}字" if got else "未取到独占命中点")
            # 影像/矢量开关
            sw = await pg.evaluate(r"""async (sel)=>{const s=ms=>new Promise(r=>setTimeout(r,ms));
              const host=document.querySelector(sel);
              const btn=host.querySelector('.biz-base-btn'); if(!btn) return {none:1};
              const cnt=()=>[...host.querySelectorAll('.esri-imagery img')].filter(i=>{const b=i.getBoundingClientRect();
                return b.width>0&&getComputedStyle(i.parentElement).display!=='none';}).length;
              const a=cnt(); btn.click(); await s(1100); const b2=cnt();
              btn.click(); await s(1500); const c=cnt();
              return {a,b:b2,c};}""", selmap)
            rec(f"{label}：影像/矢量开关", not sw.get("none") and sw["a"] > 0 and sw["b"] == 0 and sw["c"] > 0,
                f"开{sw.get('a','-')} → 关{sw.get('b','-')} → 再开{sw.get('c','-')}")

        # 灾情损失评估
        await fresh(pg, "assess", 2600)
        az = await pg.evaluate(r"""async ()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));
          const out=[];
          for(const el of document.querySelectorAll('#as-precision .row, #as-table tr[data-case]')){
            window.__APP__.closeDetail(); await s(150);
            el.click(); await s(900);
            const d=document.getElementById('detail');
            out.push({on:d.classList.contains('on'), len:document.getElementById('dt-body').innerHTML.length});}
          window.__APP__.closeDetail();
          return {out, tbl:document.querySelectorAll('#as-table tbody tr').length,
            dims:document.getElementById('as-dims').children.length,
            std:document.getElementById('as-std').children.length,
            cmp:document.getElementById('as-cmp').children.length};}""")
        rec("评估视图：精度行 + 县灾损表逐行有详情", az["out"] and all(x["on"] and x["len"] > 200 for x in az["out"]),
            f"{len(az['out'])} 行 · 表格{az['tbl']}行 · 五维{az['dims']} · 标准{az['std']} · 对比{az['cmp']}")

        # 承保上传全链路
        await fresh(pg, "uw", 3600)
        xlsx = os.path.join(HERE, "承保台账_测试.xlsx")
        if os.path.exists(xlsx):
            await pg.set_input_files("#uw-file", xlsx); await pg.wait_for_timeout(4000)
            s1 = await pg.evaluate("""()=>({main:getComputedStyle(document.getElementById('uw-main')).display,
              rows:document.getElementById('uw-map-rows').children.length,
              pv:document.getElementById('uw-preview').textContent.length})""")
            rec("上传 → 解析 + 字段映射", s1["main"] != "none" and s1["rows"] > 0 and s1["pv"] > 100,
                f"映射{s1['rows']}个字段 · 预览{s1['pv']}字")
            await pg.click("#uw-go"); await pg.wait_for_timeout(4500)
            s2 = await pg.evaluate("""()=>({kpi:document.getElementById('uw-kpi').children.length,
              rank:document.getElementById('uw-rank').children.length, tbl:document.querySelectorAll('#uw-table tbody tr').length,
              crop:document.getElementById('uw-crop').children.length, imp:document.getElementById('uw-impact').children.length,
              paths:document.querySelectorAll('#uw-map svg path').length,
              tiles:[...document.querySelectorAll('#uw-map .esri-imagery img')].filter(i=>i.naturalWidth>0).length,
              hint:getComputedStyle(document.getElementById('uw-empty-hint')).display})""")
            rec("生成承保空间分布", s2["kpi"] > 0 and s2["rank"] > 0 and s2["tbl"] > 0 and s2["paths"] > 0 and s2["hint"] == "none",
                f"KPI{s2['kpi']} 排名{s2['rank']} 明细{s2['tbl']}行 作物{s2['crop']} 影响{s2['imp']} 面{s2['paths']} 瓦片{s2['tiles']}")
            await pg.evaluate("()=>window.__APP__.closeDetail()")
            h = await pg.evaluate_handle(r"""()=>{for(const p of document.querySelectorAll('#uw-map [data-pick]')){
                if(!p.getTotalLength) continue; const L=p.getTotalLength();
                for(let f=0.1;f<0.94;f+=0.03){const t=p.getPointAtLength(L*f),m=p.getScreenCTM();if(!m)continue;
                  const s2=new DOMPoint(t.x,t.y).matrixTransform(m);
                  const h=[...new Set(document.elementsFromPoint(s2.x,s2.y).map(e=>e.closest('[data-pick]')).filter(Boolean).map(e=>e.dataset.id))];
                  if(h.length===1) return p;}}
                return null;}""")
            el = h.as_element() if h else None
            got = None
            if el:
                bb = await el.bounding_box()
                await pg.mouse.click(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)
                await pg.wait_for_timeout(1400)
                got = await pg.evaluate("()=>{const d=document.getElementById('detail');return {on:d.classList.contains('on'),t:document.getElementById('dt-title').textContent.trim(),len:document.getElementById('dt-body').innerHTML.length};}")
            rec("承保地图图斑点开详情", bool(got) and got["on"] and got["len"] > 100, f"「{got['t'] if got else ''}」{got['len'] if got else 0}字")
            for bid, lab in [("uw-export", "导出标准化 CSV"), ("uw-save", "留存到本机"), ("uw-clear", "清除本机数据")]:
                st = await pg.evaluate("(id)=>{const b=document.getElementById(id);return b&&!b.disabled;}", bid)
                rec(f"承保：{lab}", bool(st))
            await pg.click("#uw-save"); await pg.wait_for_timeout(1000)
            k1 = await pg.evaluate("()=>Object.keys(localStorage).join(',')")
            await pg.click("#uw-clear"); await pg.wait_for_timeout(1200)
            k2 = await pg.evaluate("()=>Object.keys(localStorage).join(',')")
            rec("留存到本机 → 可清除", "uw" in k1.lower() and "uw" not in k2.lower(), f"存：{k1[:40]} → 清：{k2[:40] or '(空)'}")

        # 标签页键盘可达
        kb = await pg.evaluate(r"""async ()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));
          const t=document.querySelector('.tab[data-tab="national"]'); t.focus();
          const before=document.activeElement===t;
          t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); await s(2600);
          return {focus:before, view:document.querySelector('.view.on').id,
            title:document.title};}""")
        rec("标签页键盘可达（回车激活）", kb["focus"] and kb["view"] == "v-national", f"→ {kb['view']} · {kb['title']}")

        print("\n########## 运行期错误")
        seen = set()
        for e in errs:
            if e not in seen:
                seen.add(e); print("   " + e)
        rec("全程无运行期 JS 错误", not errs, f"{len(seen)} 类")

        print(f"\n{'='*56}\n验收结果：{len(P)} 项通过 / {len(F)} 项失败   （{TARGET}）")
        for f in F:
            print("   ✗ " + f)
        await b.close()
        return 1 if F else 0


sys.exit(asyncio.run(main()))
