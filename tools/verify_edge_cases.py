"""补测上次回归没覆盖到的场景，重点是"用户实际会怎么用"。"""
import asyncio, json, time
from playwright.async_api import async_playwright
URL = "http://127.0.0.1:8899/index.html"
CHROME = "/Users/recover/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell"

R=[]
def rec(n, ok, note=""):
    R.append((n,ok,note)); print(f"{'✓' if ok else '✗'} {n}{('  — '+note) if note else ''}")

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"], executable_path=CHROME)
        pg = await b.new_page(viewport={"width":1600,"height":950}, device_scale_factor=2)
        await pg.add_init_script("try{sessionStorage.setItem('sf3s_gate_ok_v1','1')}catch(e){}")
        errs=[]
        pg.on("pageerror", lambda e: errs.append(str(e)[:150]))
        pg.on("console", lambda m: errs.append("console:"+m.text[:130]) if m.type=="error" else None)
        await pg.goto(URL, wait_until="load", timeout=60000)
        await pg.wait_for_timeout(1500)

        # ① 刷新后是否记住上次所在标签（真实使用场景）
        await pg.click('.tab[data-tab="claims"]'); await pg.wait_for_timeout(2500)
        h1 = await pg.evaluate("document.getElementById('dt-title')||''") # 触发一次详情
        await pg.evaluate("()=>window.__APP__.closeDetail()")
        await pg.reload(wait_until="load"); await pg.wait_for_timeout(3500)
        rec("刷新后定位到上次标签",
            await pg.evaluate("()=>document.querySelector('.view.on').id")=='v-claims',
            await pg.evaluate("()=>document.querySelector('.view.on').id"))

        # ② 连续快速切换 8 个标签（压力场景）
        for tab in ["national","qual","overview","underwrite","uw","claims","warn","assess"]:
            await pg.click(f'.tab[data-tab="{tab}"]'); await pg.wait_for_timeout(260)
        await pg.wait_for_timeout(4000)
        ok = await pg.evaluate("""()=>{const v=document.querySelector('.view.on');
          return {on:v&&v.id, paths:v?v.querySelectorAll('path.gs-area').length:0,
                  busy:!!document.querySelector('#busybar.on')};}""")
        rec("快速连切 8 标签后状态正常", ok['on']=='v-assess' and not ok['busy'], json.dumps(ok))

        # ③ 下钻到很深后返回上级（面包屑回跳）
        await pg.click('.tab[data-tab="national"]'); await pg.wait_for_timeout(4000)
        await pg.evaluate("()=>{window.__NAT_VIEW__.renderProvince('370000')}")
        for i in range(150):
            if await pg.evaluate("()=>document.querySelectorAll('#nat-map path[data-kind=city]').length")>0: break
            await pg.wait_for_timeout(100)
        await pg.evaluate("()=>{const s=window.__NAT_VIEW__.state;window.__NAT_VIEW__.pickCity(s.cityCache['370000'][6].c)}")
        for i in range(150):
            if await pg.evaluate("()=>document.querySelectorAll('#nat-map path[data-kind=county]').length")>0: break
            await pg.wait_for_timeout(100)
        ks = await pg.evaluate("()=>[...document.querySelectorAll('#nat-map path[data-kind=county]')].map(p=>p.dataset.id)")
        if ks:
            await pg.evaluate("(c)=>{window.__NAT_VIEW__.pickCounty(c)}", ks[0])
            for i in range(150):
                if await pg.evaluate("()=>document.querySelectorAll('#nat-map path[data-kind=town]').length")>0: break
                await pg.wait_for_timeout(100)
        crumb_n = await pg.evaluate("()=>document.querySelectorAll('#nat-crumb span').length")
        rec("深钻后面包屑层级完整", crumb_n>=4, f"{crumb_n} 级")
        # 点面包屑回省
        await pg.evaluate("""()=>{const sp=[...document.querySelectorAll('#nat-crumb span')];
          sp.find(s=>s.dataset.lv==='province')?.click();}""")
        await pg.wait_for_timeout(2500)
        back = await pg.evaluate("document.getElementById('nat-scope').textContent")
        rec("面包屑回跳到省", '山东省' in back, back)

        # ④ 详情弹层打开时点其他功能（遮挡问题回归）
        await pg.click('.tab[data-tab="warn"]'); await pg.wait_for_timeout(2800)
        await pg.evaluate("document.querySelector('#wn-list .row').click()"); await pg.wait_for_timeout(900)
        d_on = await pg.evaluate("document.getElementById('detail').classList.contains('on')")
        # 弹层开着时，切标签
        await pg.click('.tab[data-tab="claims"]'); await pg.wait_for_timeout(2200)
        # ⚠️ 判定标准不是「弹层是否关闭」—— 跨标签保留详情是有意设计
        #    （用户可能在对照两个视图的数据）。真正的判据是：
        #    弹层有没有【挡住当前视图的地图操作】。
        blocked = await pg.evaluate("""()=>{const d=document.getElementById('detail');
          if(!d.classList.contains('on')) return {open:false, blocked:false};
          const m=document.querySelector('#map-cl').getBoundingClientRect();
          const rc=d.getBoundingClientRect();
          // 地图四角 + 中心，取样判断是否被弹层覆盖
          const pts=[[0.5,0.5],[0.2,0.2],[0.8,0.2],[0.2,0.8],[0.8,0.8],[0.5,0.15]];
          let b=0;
          pts.forEach(([fx,fy])=>{const x=m.left+m.width*fx,y=m.top+m.height*fy;
            if(x>=rc.left&&x<=rc.right&&y>=rc.top&&y<=rc.bottom)b++;});
          return {open:true, blocked:b>0, blockedPts:b};}""")
        rec("切标签后弹层不挡地图操作", not blocked.get('blocked'),
            f"open={blocked.get('open')} 遮挡采样点={blocked.get('blockedPts','-')}/6")
        await pg.evaluate("()=>window.__APP__.closeDetail()")

        # ⑤ 承保上传：不选文件时操作按钮必须真正不可点
        #    ⚠️ 判据不能用「按钮数量」—— #uw-main 里的按钮始终存在，
        #    只是父容器 display:none（实测 4 个）。要看实际可点性。
        await pg.click('.tab[data-tab="uw"]'); await pg.wait_for_timeout(2500)
        u = await pg.evaluate("""()=>{const b=document.querySelector('#uw-go');
          const m=document.getElementById('uw-main');
          return {mainDisp:m.style.display, visible:b.offsetParent!==null,
                  box:Math.round(b.getBoundingClientRect().width)};}""")
        rec("未上传时操作按钮真不可点",
            u['mainDisp']=='none' and not u['visible'],
            f"uw-main={u['mainDisp']} 按钮可见={u['visible']}")

        # ⑥ 键盘可达：Tab 能否走到标签与地图
        await pg.click('.tab[data-tab="national"]'); await pg.wait_for_timeout(3500)
        await pg.evaluate("()=>document.body.focus()")
        seq=[]
        for i in range(14):
            await pg.keyboard.press("Tab"); await pg.wait_for_timeout(90)
            f = await pg.evaluate("""()=>{const a=document.activeElement;
              return (a.tagName||'')+'.'+(typeof a.className==='string'?a.className.split(' ')[0]:(a.className.baseVal||''))}""")
            seq.append(f)
        rec("键盘 Tab 可达标签/地图",
            any('tab' in x for x in seq) or any('gs-' in x for x in seq),
            " → ".join(seq[:7]))

        # ⑦ 灾情详情里的"定位到受影响省份"入口（一条灾情影响多省）
        await pg.click('.tab[data-tab="national"]'); await pg.wait_for_timeout(4000)
        dis = await pg.evaluate("""()=>{const rows=document.querySelectorAll('#nat-disasters .row');
          if(!rows.length)return {n:0};
          rows[0].click();
          const btns=[...document.querySelectorAll('#detail [data-dis-code]')];
          return {n:rows.length, btns:btns.length,
                  names:btns.map(b=>b.textContent.trim().replace(' ›',''))};}""")
        rec("灾情详情→多省定位入口", dis.get('btns',0)>0,
            f"{dis.get('btns')} 个省：{dis.get('names')}")
        if dis.get('btns',0)>0:
            await pg.evaluate("document.querySelector('#detail [data-dis-code]').click()")
            for i in range(200):
                cn = await pg.evaluate("()=>document.querySelectorAll('#nat-map path[data-kind=city]').length")
                if cn>0: break
                await pg.wait_for_timeout(100)
            sc = await pg.evaluate("document.getElementById('nat-scope').textContent")
            rec("点省入口真能下钻", cn>0, f"{sc} · {cn} 个市面")

        # ⑧ 内存/句柄泄漏粗查：反复切换后瓦片数是否失控
        for i in range(3):
            for tab in ["overview","underwrite","claims","warn"]:
                await pg.click(f'.tab[data-tab="{tab}"]'); await pg.wait_for_timeout(700)
        counts = await pg.evaluate("""()=>{
          const o={};
          document.querySelectorAll('.view').forEach(v=>{
            if(v.classList.contains('on'))return;
            o[v.id]=v.querySelectorAll('.esri-imagery img').length;});
          return o;}""")
        total = sum(counts.values())
        rec("反复切换后瓦片未失控", total < 2000, f"非活动视图残留瓦片合计 {total}")

        ok = sum(1 for _,o,_ in R if o)
        print(f"\n{'='*54}\n★ 补测 {ok}/{len(R)} 通过 ({ok*100//len(R)}%)   JS错误 {len(errs)}")
        for e in errs[:6]: print("   ", e)
        await b.close()

asyncio.run(main())
