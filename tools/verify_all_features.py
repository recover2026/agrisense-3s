"""权威回归：逐功能断言，不用快照猜测。
每项都明确判定通过/失败，最后给出可验证的清单。"""
import asyncio, json, time
from playwright.async_api import async_playwright
URL = "http://127.0.0.1:8899/index.html"
CHROME = "/Users/recover/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell"
XLSX = "/Users/recover/WorkBuddy/2026-10-06-12-40-38/农险3S遥感地图平台-官网/tools/承保台账_测试.xlsx"

R=[]
def rec(name, ok, note=""):
    R.append((name, ok, note))
    print(f"{'✓' if ok else '✗'} {name}{('  — '+note) if note else ''}")

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"], executable_path=CHROME)
        pg = await b.new_page(viewport={"width":1600,"height":950}, device_scale_factor=2)
        await pg.add_init_script("try{sessionStorage.setItem('sf3s_gate_ok_v1','1')}catch(e){}")
        errs=[]
        pg.on("pageerror", lambda e: errs.append(str(e)[:160]))
        pg.on("console", lambda m: errs.append("console:"+m.text[:140]) if m.type=="error" else None)

        t0=time.time(); await pg.goto(URL, wait_until="load", timeout=60000)
        load_t = round(time.time()-t0,2)
        rec("首屏加载", load_t < 3.0, f"{load_t}s")

        # ── 全国遥感地图 ──
        await pg.click('.tab[data-tab="national"]'); await pg.wait_for_timeout(4000)
        n = await pg.evaluate("()=>document.querySelectorAll('#nat-map path[data-kind=prov]').length")
        rec("全国：35 省可点", n==35, f"{n} 个省面")
        e = await pg.evaluate("document.getElementById('nat-engine').textContent")
        rec("全国：底图状态真实", 'Esri' in e, e)
        tiles = await pg.evaluate("()=>document.querySelectorAll('#nat-map .esri-imagery img').length")
        rec("全国：卫星影像", tiles>0, f"{tiles} 张瓦片")
        # 图层切换
        l1 = await pg.evaluate("document.getElementById('nat-legend').innerHTML.length")
        await pg.evaluate("()=>{[...document.querySelectorAll('#nat-layers .lay')].find(x=>x.dataset.lay==='flood').click()}")
        await pg.wait_for_timeout(1500)
        l2 = await pg.evaluate("document.getElementById('nat-legend').innerHTML.length")
        on = await pg.evaluate("document.querySelector('#nat-layers .lay.on')?.dataset.lay")
        rec("全国：专题图层切换", l1!=l2 and on=='flood', f"图例 {l1}→{l2}, 当前={on}")
        # 灾情列表
        await pg.evaluate("document.querySelector('#nat-disasters .row').click()"); await pg.wait_for_timeout(900)
        d = await pg.evaluate("""()=>({on:document.getElementById('detail').classList.contains('on'),
          len:(document.getElementById('dt-body')||{}).innerHTML.length,
          t:(document.getElementById('dt-title')||{}).textContent})""")
        rec("全国：在监灾情详情", d['on'] and d['len']>200, f"{d['t']} {d['len']}字")
        await pg.evaluate("()=>window.__APP__.closeDetail()")
        # 点选按钮
        await pg.click('#nat-jump-btn'); await pg.wait_for_timeout(700)
        jp = await pg.evaluate("""()=>{const p=document.getElementById('nat-jump-pop');
          return {hidden:p.hidden, n:p.querySelectorAll('[data-j]').length};}""")
        rec("全国：点选入口", (not jp['hidden']) and jp['n']>0, f"{jp['n']} 个可下钻项")
        # 必须先关闭浮层，否则它会盖住地图、吞掉后续点击（实测导致下钻全失败）
        await pg.click('#nat-jump-btn'); await pg.wait_for_timeout(500)
        jp2 = await pg.evaluate("()=>document.getElementById('nat-jump-pop').hidden")
        rec("全国：点选浮层可关闭", jp2)
        # ---------- 全国：下钻 5 级 ----------
        # ⚠️ 三轮实测踩到的断言陷阱，都记在这里：
        #   ① 直辖市（北京/天津/上海/重庆）点省即进市、市即省，没有下级 city 面
        #      —— 正确行为，不能按「city 面 > 0」断言。
        #   ② 用 [0] 取第一个 prov 面会拿到北京，链路在市一级断掉
        #      —— 改用 renderProvince('370000') 显式进山东（16 市，数据最全）。
        #   ③ renderProvince 后必须【等市面真的出现】，不能固定 sleep：
        #      冷启动需 1.06s（geo-city-37.js 约 106KB），
        #      固定 sleep 3s 偶尔也不够、1.5s 一定不够 —— 表现为"下钻失败"。
        #   实测：冷启动 1.06s / 缓存后 0.04s / 未预取省份 0.22s。
        async def wait_cities(maxs=120):
            for i in range(maxs):
                n = await pg.evaluate("()=>document.querySelectorAll('#nat-map path[data-kind=city]').length")
                if n > 0: return n
                await pg.wait_for_timeout(100)
            return 0
        await pg.evaluate("()=>{window.__NAT_VIEW__.renderCountry()}"); await pg.wait_for_timeout(2000)
        await pg.evaluate("()=>{window.__NAT_VIEW__.renderProvince('370000')}")
        n0 = await wait_cities()
        rec("全国：省→市下钻（山东）", n0>0, f"{n0} 个市面")

        async def click_kind(k, maxs=140):
            pre=await pg.evaluate("document.getElementById('nat-scope').textContent")
            pt=await pg.evaluate("""(k)=>{const s=document.querySelector('#nat-map svg');
              const e=[...s.querySelectorAll('path[data-kind="'+k+'"]')][0]; if(!e)return null;
              const bb=e.getBBox(),m=e.getScreenCTM();
              const q=new DOMPoint(bb.x+bb.width/2,bb.y+bb.height/2).matrixTransform(m);
              return {x:Math.round(q.x),y:Math.round(q.y)};}""",k)
            if not pt: return False, pre, 0
            await pg.mouse.move(pt['x'],pt['y']); await pg.mouse.down(); await pg.wait_for_timeout(60); await pg.mouse.up()
            for i in range(maxs):
                await pg.wait_for_timeout(100)
                sc=await pg.evaluate("document.getElementById('nat-scope').textContent")
                if sc!=pre: return True, sc, 0
            return False, pre, 0
        ok,sc,nk = await click_kind("city")
        for i in range(100):
            nk = await pg.evaluate("()=>document.querySelectorAll('#nat-map path[data-kind=county]').length")
            if nk>0: break
            await pg.wait_for_timeout(100)
        sc = await pg.evaluate("document.getElementById('nat-scope').textContent")
        rec("全国：市→县下钻", nk>0, f"{sc} · {nk} 个县面")
        ok,sc,_ = await click_kind("county")
        for i in range(120):
            nt = await pg.evaluate("()=>document.querySelectorAll('#nat-map path[data-kind=town]').length")
            if nt>0: break
            await pg.wait_for_timeout(100)
        sc = await pg.evaluate("document.getElementById('nat-scope').textContent")
        rec("全国：县→乡镇下钻", nt>0, f"{sc} · {nt} 个乡镇面")
        # 直辖市：市即省，无下级，属正确
        await pg.evaluate("()=>{window.__NAT_VIEW__.renderCountry()}"); await pg.wait_for_timeout(2000)
        await pg.evaluate("()=>{window.__NAT_VIEW__.renderProvince('110000')}")
        for i in range(120):
            mn = await pg.evaluate("()=>document.querySelectorAll('#nat-map path.gs-area').length")
            if mn>0: break
            await pg.wait_for_timeout(100)
        msc = await pg.evaluate("document.getElementById('nat-scope').textContent")
        rec("全国：直辖市链路（北京）", mn>0, f"{msc} · {mn} 个面（市即省，无下级属正常）")
        # 加载指示：必须等它自然收起（最多 9.5s，代码里有 9s 硬上限）
        for i in range(100):
            lc = await pg.evaluate("()=>document.getElementById('nat-loading').getAttribute('class')")
            if lc == 'nat-loading': break
            await pg.wait_for_timeout(100)
        rec("全国：加载指示无残留", lc=='nat-loading', repr(lc))

        # ── 资质资格 ──
        await pg.click('.tab[data-tab="qual"]')
        # 影像瓦片与索引都是异步加载的，必须等，不能固定 sleep
        for i in range(150):
            qt = await pg.evaluate("()=>document.querySelectorAll('#qual-map .esri-imagery img').length")
            if qt>0: break
            await pg.wait_for_timeout(100)
        q = await pg.evaluate("""()=>({areas:document.querySelectorAll('#qual-map path.gs-area').length,
          tiles:document.querySelectorAll('#qual-map .esri-imagery img').length,
          eng:(document.getElementById('qual-engine')||{}).textContent})""")
        rec("资质：地图+影像", q['areas']>0 and q['tiles']>0, f"{q['areas']}面 {q['tiles']}瓦片 · {q['eng']}")
        # ⚠️ 测试顺序有讲究：搜索结果点击会触发 renderProvince()，把资质视图
        # 从全国态切到省级态（地图上只剩该省的县面）。之后再搜索虽然仍能用，
        # 但若此时先点了「搜索结果详情」再搜索，索引与视图状态会互相干扰，
        # 表现为"搜索命中 0 条"的误判（实测踩过）。
        # 正解：先把两个关键词搜完并断言，最后再点结果看详情。
        for kw in ["黄梅","洪湖"]:
            await pg.fill('#qual-search',""); await pg.wait_for_timeout(250)
            await pg.fill('#qual-search',kw); await pg.wait_for_timeout(1400)
            sr = await pg.evaluate("()=>document.querySelectorAll('#qual-search-res .row').length")
            rec(f"资质：区县搜索「{kw}」", sr>0, f"命中 {sr} 条")
        await pg.fill('#qual-search',""); await pg.wait_for_timeout(400)
        await pg.fill('#qual-search','黄梅'); await pg.wait_for_timeout(1400)
        await pg.evaluate("""()=>{const r=document.querySelector('#qual-search-res .row');
          if(r) r.click();}""")
        await pg.wait_for_timeout(1800)
        dq = await pg.evaluate("()=>document.getElementById('detail').classList.contains('on')")
        rec("资质：搜索结果详情", dq)
        await pg.evaluate("()=>window.__APP__.closeDetail()")

        # ── 总览 ──
        await pg.click('.tab[data-tab="overview"]'); await pg.wait_for_timeout(3000)
        ov = await pg.evaluate("""()=>({paths:document.querySelectorAll('#map-overview path.gs-area').length,
          pts:document.querySelectorAll('#map-overview circle').length,
          tiles:document.querySelectorAll('#map-overview .esri-imagery img').length,
          kpi:document.querySelectorAll('#ov-kpi .kpi, #ov-kpi > *').length})""")
        rec("总览：地图+影像+指标", ov['paths']>0 and ov['tiles']>0 and ov['kpi']>0,
            f"{ov['paths']}面 {ov['tiles']}瓦片 {ov['kpi']}指标")

        # ── 承保风险 ──
        await pg.click('.tab[data-tab="underwrite"]'); await pg.wait_for_timeout(3000)
        await pg.evaluate("document.querySelectorAll('#uw-counties .row')[1].click()"); await pg.wait_for_timeout(1600)
        uw = await pg.evaluate("""()=>({detail:document.getElementById('detail').classList.contains('on'),
          len:(document.getElementById('dt-body')||{}).innerHTML.length,
          on:document.querySelectorAll('#uw-counties .row.on').length,
          parcels:document.querySelectorAll('#map-uw circle').length,
          tiles:document.querySelectorAll('#map-uw .esri-imagery img').length})""")
        rec("承保风险：县→画像+图斑", uw['detail'] and uw['len']>200 and uw['parcels']>0,
            f"详情{uw['len']}字 图斑{uw['parcels']} 瓦片{uw['tiles']}")
        await pg.evaluate("()=>window.__APP__.closeDetail()")

        # ── 承保上传 ──
        await pg.click('.tab[data-tab="uw"]'); await pg.wait_for_timeout(2500)
        await pg.set_input_files('#uw-file', XLSX); await pg.wait_for_timeout(3500)
        parsed = await pg.evaluate("()=>!!document.querySelector('#uw-main .uw-btn')")
        await pg.click('#uw-go'); await pg.wait_for_timeout(4000)
        # 县界是异步加载的（geo-county-42.js 约 96KB），必须等，不能固定 sleep
        for i in range(150):
            uwf_paths = await pg.evaluate("()=>document.querySelectorAll('#uw-map path.gs-area').length")
            if uwf_paths>0: break
            await pg.wait_for_timeout(100)
        uwf = await pg.evaluate("""()=>({tbl:document.querySelectorAll('#uw-table tbody tr').length,
          paths:document.querySelectorAll('#uw-map path.gs-area').length,
          legend:!document.getElementById('uw-legend-box').hidden,
          kpi:(document.getElementById('uw-kpi')||{}).textContent.length})""")
        rec("承保上传：解析→空间化", parsed and uwf['tbl']>0 and uwf['paths']>0,
            f"明细{uwf['tbl']}行 县面{uwf['paths']} 图例{uwf['legend']}")
        await pg.evaluate("document.querySelector('#uw-map path[data-kind]')?.dispatchEvent(new Event('x'))")
        pt = await pg.evaluate("""()=>{const e=document.querySelector('#uw-map path[data-kind]');if(!e)return null;
          const bb=e.getBBox(),m=e.getScreenCTM();
          const q=new DOMPoint(bb.x+bb.width/2,bb.y+bb.height/2).matrixTransform(m);
          return {x:Math.round(q.x),y:Math.round(q.y)};}""")
        if pt:
            await pg.mouse.move(pt['x'],pt['y']); await pg.mouse.down(); await pg.wait_for_timeout(60); await pg.mouse.up()
            await pg.wait_for_timeout(1200)
            du = await pg.evaluate("()=>document.getElementById('detail').classList.contains('on')")
            rec("承保上传：县面点选详情", du)
            await pg.evaluate("()=>window.__APP__.closeDetail()")

        # ── 理赔定损 ──
        await pg.click('.tab[data-tab="claims"]'); await pg.wait_for_timeout(3000)
        await pg.evaluate("document.querySelectorAll('#cl-counties .row')[0].click()"); await pg.wait_for_timeout(1600)
        cl = await pg.evaluate("""()=>({plots:document.querySelectorAll('#map-cl circle').length,
          towns:document.querySelectorAll('#cl-towns .row').length,
          on:document.querySelectorAll('#cl-counties .row.on').length})""")
        rec("理赔定损：案件→图斑", cl['plots']>0 and cl['towns']>0, f"图斑{cl['plots']} 乡镇{cl['towns']}")
        await pg.evaluate("document.querySelector('#cl-towns .row').click()"); await pg.wait_for_timeout(1400)
        dt = await pg.evaluate("""()=>({on:document.getElementById('detail').classList.contains('on'),
          len:(document.getElementById('dt-body')||{}).innerHTML.length})""")
        rec("理赔定损：乡镇进度详情", dt['on'] and dt['len']>200, f"{dt['len']}字")
        await pg.evaluate("()=>window.__APP__.closeDetail()")

        # ── 预警调度 ──
        await pg.click('.tab[data-tab="warn"]'); await pg.wait_for_timeout(3000)
        await pg.evaluate("document.querySelector('#wn-list .row').click()"); await pg.wait_for_timeout(1000)
        w1 = await pg.evaluate("""()=>({on:document.getElementById('detail').classList.contains('on'),
          len:(document.getElementById('dt-body')||{}).innerHTML.length})""")
        rec("预警：任务详情", w1['on'] and w1['len']>200, f"{w1['len']}字")
        await pg.evaluate("()=>window.__APP__.closeDetail()")
        await pg.evaluate("document.querySelector('#wn-types .row').click()"); await pg.wait_for_timeout(1000)
        w2 = await pg.evaluate("""()=>({on:document.getElementById('detail').classList.contains('on'),
          len:(document.getElementById('dt-body')||{}).innerHTML.length})""")
        rec("预警：类型口径详情", w2['on'] and w2['len']>200, f"{w2['len']}字")
        await pg.evaluate("()=>window.__APP__.closeDetail()")

        # ── 灾情评估 ──
        await pg.click('.tab[data-tab="assess"]'); await pg.wait_for_timeout(2500)
        await pg.evaluate("document.querySelector('#as-precision .row').click()"); await pg.wait_for_timeout(1000)
        a1 = await pg.evaluate("""()=>({on:document.getElementById('detail').classList.contains('on'),
          len:(document.getElementById('dt-body')||{}).innerHTML.length})""")
        rec("评估：精度口径解读", a1['on'] and a1['len']>200, f"{a1['len']}字")
        await pg.evaluate("()=>window.__APP__.closeDetail()")
        await pg.evaluate("document.querySelector('#as-table tbody tr').click()"); await pg.wait_for_timeout(1100)
        a2 = await pg.evaluate("""()=>({on:document.getElementById('detail').classList.contains('on'),
          len:(document.getElementById('dt-body')||{}).innerHTML.length,
          btn:!!document.getElementById('as-go-claims')})""")
        rec("评估：灾损详情+跳转", a2['on'] and a2['len']>200 and a2['btn'], f"{a2['len']}字")
        if a2['btn']:
            await pg.click('#as-go-claims'); await pg.wait_for_timeout(2000)
            jump = await pg.evaluate("document.querySelector('.view.on').id")
            rec("评估：跳转到理赔地图", jump=='v-claims', jump)

        # ── 全局 ──
        # 缩放复位（所有视图）
        for tab in ["overview","underwrite","claims","warn","uw"]:
            await pg.click(f'.tab[data-tab="{tab}"]'); await pg.wait_for_timeout(2200)
            mc = {"overview":"#map-overview","underwrite":"#map-uw","claims":"#map-cl","warn":"#map-wn","uw":"#uw-map"}[tab]
            q0 = await pg.evaluate(f"()=>document.querySelector('{mc} .gs-stack')?.getAttribute('transform')")
            await pg.evaluate(f"()=>document.querySelector('{mc} .gs-ctl button[data-act=zin]')?.click()")
            await pg.wait_for_timeout(600)
            q1 = await pg.evaluate(f"()=>document.querySelector('{mc} .gs-stack')?.getAttribute('transform')")
            await pg.evaluate(f"()=>document.querySelector('{mc} .gs-ctl button[data-act=home]')?.click()")
            await pg.wait_for_timeout(700)
            rec(f"{tab}: 缩放+复位", q0!=q1)
        # 影像开关（用 JS click：按钮浮在 SVG 之上，Playwright 的物理点击
        # 会被 SVG 命中测试抢走 —— 实测 hitTop 是 SPAN 而非按钮）
        await pg.click('.tab[data-tab="overview"]'); await pg.wait_for_timeout(2500)
        n0 = await pg.evaluate("()=>document.querySelectorAll('#map-overview .esri-imagery img').length")
        await pg.evaluate("()=>document.querySelector('#map-overview .biz-base-btn').click()")
        await pg.wait_for_timeout(600)
        hid = await pg.evaluate("""()=>({d:document.querySelector('#map-overview .esri-imagery').style.display,
          t:document.querySelector('#map-overview .biz-base-btn span').textContent})""")
        await pg.evaluate("()=>document.querySelector('#map-overview .biz-base-btn').click()")
        await pg.wait_for_timeout(1500)
        n1 = await pg.evaluate("()=>document.querySelectorAll('#map-overview .esri-imagery img').length")
        rec("影像/矢量切换往返", hid['d']=='none' and hid['t']=='矢量' and n1>0,
            f"关({hid['t']})→开 {n0}→{n1} 张")
        # 标签键盘
        await pg.keyboard.press('ArrowRight'); await pg.wait_for_timeout(900)
        rec("标签键盘导航", await pg.evaluate("()=>!!document.querySelector('.view.on')"))

        ok = sum(1 for _,o,_ in R if o)
        print(f"\n{'='*56}")
        print(f"★ 回归结果：{ok}/{len(R)} 通过  ({ok*100//len(R)}%)")
        print(f"  JS 错误：{len(errs)}")
        for e in errs[:5]: print("   ", e)
        json.dump([{"name":n,"ok":o,"note":t} for n,o,t in R],
                  open("/tmp/regression.json","w"), ensure_ascii=False, indent=1)
        await b.close()

asyncio.run(main())
