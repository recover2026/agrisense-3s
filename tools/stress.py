"""压力测试：把每个功能往死里用 ——
  A 快速连点/ 连点同一个目标
  B 高频切换标签（来回 20 轮）
  C 图层开关反复乱切（30 次随机序列）
  D 地图疯狂拖动 + 极限缩放（滚轮 + 按钮）
  E 下钻到底再一路返回、反复进出同一层级
  F 极端输入（空、超长、特殊字符、Emoji）到搜索框
  G 窗口尺寸剧烈变化（窄屏 / 超宽 / 极扁）
  H 上传异常文件（空表、乱列、只有表头、超大行数）
每一步都记异常、卡顿、内存增长、控制台报错，并留下截图供目检。
"""
import asyncio, glob, json, os, sys, time, random
from playwright.async_api import async_playwright

CHROME = glob.glob("/Users/recover/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell")[0]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOT = os.path.join(ROOT, "docs", "stress")
TARGET = "http://127.0.0.1:8899/index.html"

issues = []


def bad(tag, note):
    issues.append((tag, note))
    print(f"  ✗ {tag} — {note}", flush=True)


def ok(tag, note=""):
    print(f"  ✓ {tag}{('  — ' + note) if note else ''}", flush=True)


class Watch:
    """监听运行期异常 + 请求失败 + 探测内存/句柄增长"""

    def __init__(self, pg):
        self.errs, self.fails = [], []
        pg.on("pageerror", lambda e: self.errs.append("JS " + str(e)[:160]))
        pg.on("console", lambda m: self.errs.append("CON " + m.text[:160]) if m.type == "error" else None)
        pg.on("requestfailed", lambda r: self.fails.append(r.url.split("/")[-1][:60] + " " + str(r.failure)[:60]))

    async def mem(self):
        """读 JS 堆占用（usedJSHeapSize）。仅 chromium 有 performance.memory，
        没有时返回 0，调用方按 0 跳过内存断言。"""
        try:
            return int(await self.pg.evaluate(
                "() => (window.performance && performance.memory) ? performance.memory.usedJSHeapSize : 0") or 0)
        except Exception:
            return 0

    def drain(self):
        e, self.errs, self.fails = self.errs[:], [], []
        return e


async def main():
    os.makedirs(SHOT, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"], executable_path=CHROME)
        pg = await b.new_page(viewport={"width": 1600, "height": 950}, device_scale_factor=1)
        await pg.goto(TARGET + "?t=" + str(int(time.time())), wait_until="load", timeout=60000)
        await pg.wait_for_timeout(2500)
        if await pg.locator("#sfGate").count():
            await pg.evaluate("()=>{try{sessionStorage.setItem('sf3s_gate_ok_v1','1')}catch(e){}"
                              "const g=document.getElementById('sfGate');if(g)g.remove();document.documentElement.style.overflow='';}")
        await pg.wait_for_timeout(1500)
        w = Watch(pg)
        w.pg = pg
        shot = lambda n: pg.screenshot(path=os.path.join(SHOT, n + ".png"))

        # ================= A 快速连点 =================
        print("\n########## A · 快速连点（同一目标 40 次 / 多个目标交替 60 次）")
        await pg.click('.tab[data-tab="national"]'); await pg.wait_for_timeout(4000)
        el = await pg.query_selector("#nat-disasters .row")
        t0 = time.time()
        for _ in range(40):
            await el.click(timeout=4000, force=True)
        dt = time.time() - t0
        st = await pg.evaluate("""()=>{const d=document.getElementById('detail');
          return {cls:d.className, t:document.getElementById('dt-title').textContent.trim(),
            len:document.getElementById('dt-body').innerHTML.length,
            fold:document.getElementById('dt-fold').textContent};}""")
        if st["len"] < 200:
            bad("A1 连点40次后详情异常", json.dumps(st, ensure_ascii=False))
        else:
            ok("A1 灾情行连点 40 次", f"{dt:.1f}s，详情仍正常「{st['t']}」{st['len']}字")
        e = w.drain()
        if e:
            bad("A1 连点抛错", "; ".join(e[:3]))
        await shot("A1_连点后")

        # 交替点不同详情源，看有没有内容错位
        print("\n########## B · 详情来源交替（防止 A 覆盖 B 的内容）")
        await pg.click('.tab[data-tab="underwrite"]'); await pg.wait_for_timeout(3000)
        seq = []
        for i in range(6):
            await pg.evaluate("()=>window.__APP__.closeDetail()"); await pg.wait_for_timeout(200)
            await pg.evaluate("()=>document.querySelector('#uw-counties .row').click()")
            await pg.wait_for_timeout(700)
            seq.append(await pg.evaluate("()=>document.getElementById('dt-title').textContent.trim()"))
            await pg.evaluate("()=>window.__APP__.closeDetail()"); await pg.wait_for_timeout(200)
            await pg.evaluate("()=>document.querySelector('#nat-disasters .row') && 0")
            await pg.click('.tab[data-tab="national"]'); await pg.wait_for_timeout(2200)
            await pg.evaluate("()=>document.querySelector('#nat-disasters .row').click()")
            await pg.wait_for_timeout(700)
            seq.append(await pg.evaluate("()=>document.getElementById('dt-title').textContent.trim()"))
            await pg.click('.tab[data-tab="underwrite"]'); await pg.wait_for_timeout(2400)
        if any(not s for s in seq):
            bad("B 详情来源交替", f"出现空标题：{seq}")
        else:
            ok("B 详情来源交替 12 次", " / ".join(seq[:4]) + " …")
        e = w.drain()
        if e:
            bad("B 交替抛错", "; ".join(e[:3]))

        # ================= C 标签高频切换 =================
        print("\n########## C · 标签高频切换（8 个标签来回 20 轮）")
        TABS = ["national", "qual", "overview", "underwrite", "uw", "claims", "warn", "assess"]
        m0 = await w.mem()
        t0 = time.time()
        for r in range(20):
            for t in TABS:
                await pg.click(f'.tab[data-tab="{t}"]')
                await pg.wait_for_timeout(60)          # 故意不等切完就切下一个
            if r % 5 == 4:
                await pg.wait_for_timeout(800)
        dt = time.time() - t0
        await pg.wait_for_timeout(3000)
        m1 = await w.mem()
        st = await pg.evaluate("()=>({view:document.querySelector('.view.on').id,"
                               "t:document.querySelector('.tab.on').textContent.trim()})")
        if st["view"] != "v-" + TABS[-1]:
            bad("C 160 次切换后视图错乱", json.dumps(st, ensure_ascii=False))
        else:
            ok("C 标签 160 次无间隔连切", f"{dt:.0f}s，末态正确（{st['t']}）")
        growth = (m1 - m0) / 1024 / 1024 if m1 and m0 else -1
        if growth > 180:
            bad("C 切标签内存暴涨", f"{growth:.0f} MB（基线 {m0/1048576:.0f}MB → {m1/1048576:.0f}MB）")
        else:
            ok("C 切标签内存", f"{growth:+.0f} MB")
        e = w.drain()
        if e:
            bad("C 切标签抛错", "; ".join(e[:4]))
        await shot("C_连切160次后")

        # ================= D 图层乱切 =================
        print("\n########## D · 图层开关随机乱切 40 次")
        await pg.click('.tab[data-tab="national"]'); await pg.wait_for_timeout(4200)
        random.seed(7)
        m0 = await w.mem()
        for i in range(40):
            n = await pg.evaluate("()=>document.querySelectorAll('#nat-layers .layrow').length")
            if not n:
                break
            k = random.randrange(n)
            await pg.evaluate("(k)=>{const e=document.querySelectorAll('#nat-layers .layrow')[k];e&&e.click();}", k)
            await pg.wait_for_timeout(120)
        await pg.wait_for_timeout(2500)
        st = await pg.evaluate("""()=>({on:document.querySelectorAll('#nat-layers .layrow.on').length,
          total:document.querySelectorAll('#nat-layers .layrow').length,
          cv:[...document.querySelectorAll('#nat-map canvas')].filter(c=>{const r=c.getBoundingClientRect();
            return r.width>0&&getComputedStyle(c).display!=='none';}).length,
          cnt:(document.querySelector('#nat-layers .lay-count')||{}).textContent||'(无计数)'})""")
        m1 = await w.mem()
        if st["cv"] > 12:
            bad("D 乱切后画布失控", f"可见画布 {st['cv']} 个（上限应 ≤11），{json.dumps(st, ensure_ascii=False)}")
        else:
            ok("D 图层乱切 40 次", f"当前开 {st['on']}/{st['total']} 行 · 画布 {st['cv']} 个")
        growth = (m1 - m0) / 1048576 if m1 and m0 else -1
        if growth > 120:
            bad("D 切图层内存暴涨", f"{growth:.0f} MB")
        else:
            ok("D 切图层内存", f"{growth:+.0f} MB")
        e = w.drain()
        if e:
            bad("D 乱切抛错", "; ".join(e[:4]))
        await shot("D_图层乱切后")

        # ================= E 疯狂拖动 + 极限缩放 =================
        print("\n########## E · 地图拖动/缩放压力")
        await pg.evaluate("()=>{const b=document.getElementById('nat-back');for(let i=0;i<4;i++)b.click();}")
        await pg.wait_for_timeout(2500)
        box = await (await pg.query_selector("#nat-map")).bounding_box()
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        t0 = time.time()
        for i in range(30):                       # 快速甩动
            dx = random.randint(-260, 260); dy = random.randint(-180, 180)
            await pg.mouse.move(cx, cy)
            await pg.mouse.down()
            for s in range(4):
                await pg.mouse.move(cx + dx * s / 3, cy + dy * s / 3)
                await pg.wait_for_timeout(8)
            await pg.mouse.up()
        await pg.wait_for_timeout(2000)
        st = await pg.evaluate("""()=>{const s=document.querySelector('#nat-map svg .gs-stack');
          return {tr:s?s.getAttribute('transform'):'(无)',
            tiles:[...document.querySelectorAll('#nat-map .esri-imagery img')].filter(i=>i.naturalWidth>0).length,
            scale:(()=>{const e=document.querySelector('#nat-map .gs-scale-txt');return e?e.textContent:'(无)';})()};}""")
        if st["tr"] in (None, "(无)", ""):
            bad("E 甩动后变换丢失", json.dumps(st, ensure_ascii=False))
        else:
            ok("E 快速甩动 30 次", f"transform 正常 · {st['tiles']} 瓦片 · 比例尺「{st['scale']}」")
        # 滚轮极限缩放
        for i in range(40):
            await pg.mouse.wheel(0, -300)
        await pg.wait_for_timeout(2500)
        zin = await pg.evaluate("()=>{const t=[...document.querySelectorAll('#nat-map .esri-imagery img')];return t.length;}")
        for i in range(60):
            await pg.mouse.wheel(0, 300)
        await pg.wait_for_timeout(2500)
        st2 = await pg.evaluate("""()=>{const t=[...document.querySelectorAll('#nat-map .esri-imagery img')];
          return {tiles:t.length, loaded:t.filter(i=>i.naturalWidth>0).length,
            tr:(()=>{const s=document.querySelector('#nat-map svg .gs-stack');return s?s.getAttribute('transform'):''})()};}""")
        if st2["tr"] == "":
            bad("E 极限缩放后变换丢失", json.dumps(st2, ensure_ascii=False))
        else:
            ok("E 滚轮极限缩放 100 次", f"放大后 {zin} 瓦片 · 缩小后 {st2['loaded']}/{st2['tiles']} 已加载")
        # 复位
        await pg.evaluate("()=>{const h=document.querySelector('#nat-map');h.querySelector('button[data-act=home]').click();}")
        await pg.wait_for_timeout(2200)
        e = w.drain()
        if e:
            bad("E 拖动缩放抛错", "; ".join(e[:4]))
        await shot("E_极限缩放后")

        # ================= F 下钻到底 + 反复进出 =================
        print("\n########## F · 下钻到底再返回 + 同一层级反复进出 12 次")
        await pg.click('.tab[data-tab="national"]'); await pg.wait_for_timeout(4200)
        # 用点选下拉反复进出河南
        cyc = []
        for i in range(12):
            await pg.evaluate("()=>{for(let k=0;k<6;k++)document.getElementById('nat-back').click();}")
            await pg.wait_for_timeout(900)
            await pg.click("#nat-jump-btn"); await pg.wait_for_timeout(600)
            ok1 = await pg.evaluate(r"""async ()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));
              const pop=document.getElementById('nat-jump-pop');
              const b=[...pop.querySelectorAll('button')].find(x=>x.textContent.trim().indexOf('河南')===0);
              if(!b) return 0; b.click(); await s(2600);
              return document.querySelectorAll('#nat-map [data-kind=city]').length;}""")
            cyc.append(ok1)
        if any(c == 0 for c in cyc):
            bad("F 反复进出同一省", f"第 {cyc.index(0)+1} 次下钻失败：{cyc}")
        else:
            ok("F 河南反复进出 12 次", f"每次都下钻到市：{sorted(set(cyc))} 个市")
        st = await pg.evaluate("""()=>({cr:document.getElementById('nat-crumb').textContent.replace(/\\s+/g,' ').trim(),
          loadCls:document.getElementById('nat-loading').className,
          nodes:document.querySelectorAll('#nat-map *').length})""")
        if "on" in st["loadCls"] or "show" in st["loadCls"]:
            bad("F 返回后加载指示器卡死", json.dumps(st, ensure_ascii=False))
        else:
            ok("F 返回后状态干净", f"面包屑「{st['cr']}」· 加载态「{st['loadCls'] or '(无)'}」· DOM {st['nodes']} 节点")
        if st["nodes"] > 60000:
            bad("F DOM 节点堆积", f"{st['nodes']} 个（可能泄漏）")
        e = w.drain()
        if e:
            bad("F 反复进出抛错", "; ".join(e[:4]))
        await shot("F_反复进出后")

        # ================= G 极端输入 =================
        print("\n########## G · 搜索框极端输入")
        await pg.click('.tab[data-tab="qual"]'); await pg.wait_for_timeout(4000)
        for label, val in [("空串", ""), ("单字符", "黄"), ("超长200字", "黄" * 200),
                           ("特殊符号", "%%%^&*()"), ("Emoji", "🌾🚜📍"),
                           ("注入尝试", "<img src=x onerror=alert(1)>"),
                           ("数字", "420527"), ("英文", "Huangmei")]:
            await pg.fill("#qual-search", val)
            await pg.wait_for_timeout(700)
            st = await pg.evaluate("""()=>{const r=document.getElementById('qual-search-res');
              return {n:r.children.length, disp:getComputedStyle(r).display,
                html:r.innerHTML.length, inp:document.getElementById('qual-search').value.length};}""")
            injected = "<img" in await pg.evaluate("()=>document.getElementById('qual-search-res').innerHTML")
            if injected:
                bad(f"G 搜索[{label}] 存在注入风险", "结果区出现了真实 <img> 标签")
            elif st["disp"] == "block" and st["n"] == 0 and len(val) > 0:
                bad(f"G 搜索[{label}] 空结果却显示容器", json.dumps(st, ensure_ascii=False))
        ok("G 搜索极端输入 8 组", "无异常、无注入、空结果正确隐藏")
        e = w.drain()
        if e:
            bad("G 搜索抛错", "; ".join(e[:4]))
        await pg.fill("#qual-search", "")
        await pg.wait_for_timeout(400)
        await shot("G_搜索后")

        # ================= H 窗口尺寸剧变 =================
        print("\n########## H · 窗口尺寸剧变")
        for w_, h_ in [(560, 900), (2400, 700), (900, 420), (1600, 950)]:
            await pg.set_viewport_size({"width": w_, "height": h_})
            await pg.wait_for_timeout(1800)
            st = await pg.evaluate("""()=>{const maps=['#nat-map','#map-overview','#map-uw','#map-cl','#map-wn','#uw-map','#qual-map'];
              const bad=[]; const tinfo={};
              maps.forEach(m=>{const e=document.querySelector(m); if(!e) return;
                const r=e.getBoundingClientRect();
                tinfo[m]=[Math.round(r.width),Math.round(r.height)];
                if(r.width>0 && (r.width<80||r.height<60)) bad.push(m+'='+Math.round(r.width)+'x'+Math.round(r.height));});
              // 溢出检查
              const of=[...document.querySelectorAll('.topbar,.ticker,.disc,.side,.detail')]
                .filter(e=>{const r=e.getBoundingClientRect();return r.right>window.innerWidth+2||r.left<-2;})
                .map(e=>e.className||e.tagName);
              return {small:bad, overflow:[...new Set(of)], tinfo};}""")
            if st["overflow"]:
                bad(f"H 视口 {w_}x{h_} 元素溢出", str(st["overflow"])[:110])
            if st["small"]:
                bad(f"H 视口 {w_}x{h_} 地图被压扁", str(st["small"])[:110])
        ok("H 四种极端视口", "无溢出、无地图压扁")
        await shot("H_窄屏560")
        await pg.set_viewport_size({"width": 1600, "height": 950}); await pg.wait_for_timeout(1500)
        e = w.drain()
        if e:
            bad("H 尺寸变化抛错", "; ".join(e[:4]))

        # ================= I 异常上传 =================
        print("\n########## I · 异常承保台账")
        await pg.click('.tab[data-tab="uw"]'); await pg.wait_for_timeout(3400)
        import tempfile
        cases = [
            ("空文件", b""),
            ("只有表头", "姓名,身份证,面积\n".encode()),
            ("乱列", "aaa,bbb,ccc\n1,2,3\n4,5,6\n".encode()),
            ("超宽(50列×200行)", ("c"+",".join("c%d"%i for i in range(50))+"\n").encode()
             + b"".join((",".join(str(r*50+c) for c in range(50))+"\n").encode() for r in range(200))),
            ("超长单元格", ("姓名,面积\n" + "很长的名字"*5000 + ",1\n").encode()),
            ("二进制垃圾", bytes(range(256)) * 40),
        ]
        for label, data in cases:
            p = os.path.join(tempfile.gettempdir(), "uwtest_%d.dat" % abs(hash(label)))
            open(p, "wb").write(data)
            try:
                await pg.set_input_files("#uw-file", p)
            except Exception as e:
                bad(f"I 上传[{label}] 输入被拒", str(e)[:80]); continue
            await pg.wait_for_timeout(2500)
            st = await pg.evaluate("""()=>({alive:!!document.getElementById('uw-preview'),
              status:(document.getElementById('uw-status').textContent||'').replace(/\\s+/g,' ').trim().slice(0,70),
              view:document.querySelector('.view.on').id})""")
            if not st["alive"]:
                bad(f"I 上传[{label}] 页面结构被破坏", json.dumps(st, ensure_ascii=False))
            elif not st["status"]:
                bad(f"I 上传[{label}] 无任何反馈", json.dumps(st, ensure_ascii=False))
            else:
                print(f"     · {label:14} → {st['status'][:56]}")
            e2 = w.drain()
            # 「解析失败」类 console.error 是预期行为（页面已给出可读提示），
            # 只把非该类的异常算作问题
            real_err = [x for x in e2 if '没有读到任何数据行' not in x and '没匹配到任何字段' not in x]
            if real_err:
                bad(f"I 上传[{label}] 抛错", "; ".join(real_err[:2]))
        # 正常文件再走一遍，确认没被前面的异常搞坏
        xlsx = os.path.join(ROOT, "tools", "承保台账_测试.xlsx")
        if os.path.exists(xlsx):
            await pg.set_input_files("#uw-file", xlsx); await pg.wait_for_timeout(3200)
            st = await pg.evaluate("""()=>({main:getComputedStyle(document.getElementById('uw-main')).display,
              rows:document.getElementById('uw-map-rows').children.length})""")
            if st["main"] == "none" or st["rows"] == 0:
                bad("I 异常文件后正常文件也坏了", json.dumps(st, ensure_ascii=False))
            else:
                ok("I 异常文件后正常台账仍可解析", f"映射 {st['rows']} 个字段")
        await shot("I_异常上传后")

        # ================= J 键盘穷举 =================
        print("\n########## J · 键盘操作")
        await pg.click('.tab[data-tab="national"]'); await pg.wait_for_timeout(4000)
        await pg.evaluate("()=>document.querySelector('.tab[data-tab=overview]').focus()")
        for key in ["ArrowRight", "ArrowRight", "ArrowLeft", "Home", "End", " ", "Enter"]:
            await pg.keyboard.press(key)
            await pg.wait_for_timeout(900)
        st = await pg.evaluate("()=>({view:document.querySelector('.view.on').id, focus:document.activeElement.textContent.trim().slice(0,14)})")
        ok("J 标签键盘导航", f"末态 {st['view']} · 焦点「{st['focus']}」")
        await pg.evaluate("()=>document.getElementById('nat-jump-btn').focus()")
        await pg.keyboard.press("Enter"); await pg.wait_for_timeout(700)
        # hidden 属性被移除 == 浮层已打开（此前判反了，误报"回车打不开"）
        st = await pg.evaluate("()=>!document.getElementById('nat-jump-pop').hasAttribute('hidden')")
        if not st:
            bad("J 回车打不开点选浮层", "")
        else:
            ok("J 回车打开点选浮层", "")
        e = w.drain()
        if e:
            bad("J 键盘抛错", "; ".join(e[:3]))

        # ================= 汇总 =================
        print("\n" + "=" * 58)
        print(f"压力测试发现 {len(issues)} 个问题")
        for t, n in issues:
            print(f"  ✗ {t}: {n}")
        print(f"\n截图目录：{SHOT}")
        await b.close()


asyncio.run(main())
