"""实测两个参考平台，产出可对比的差异清单。

目标不是抄功能，而是回答用户的问题：
"别的平台在【使用端】上强在哪、我这边差在哪"。

探查维度（每站都跑一遍）：
  ① 首屏观感：布局、配色、信息密度
  ② 地图交互：下钻层级、标签归属、图层控制
  ③ 响应速度：首屏可交互时间、各视图切换耗时
  ④ 细节处理：空态、加载态、错误提示、键盘可达
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
PW = "nongxian2026"
OUT = os.path.join(os.getcwd(), "docs", "stress")

SITES = [
    ("A", "https://afa82d8a470ae00bd.app.workbuddy.link"),
    ("B", "https://c12d944b49e34724a0ed76569c8b3110.app.workbuddy.link"),
]

PROBE = r"""
() => {
  const vw = innerWidth, vh = innerHeight;
  const vis = el => { const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && cs.display !== 'none' && cs.visibility !== 'hidden'; };
  // 交互元素盘点
  const clickables = [...document.querySelectorAll(
    'button,a,[role=button],[onclick],.tab,.btn,.item,.card,.row,li')].filter(vis);
  const inputs = [...document.querySelectorAll('input,select,textarea')].filter(vis);
  const svgs = [...document.querySelectorAll('svg')].filter(vis);
  const texts = [...document.querySelectorAll('svg text')].filter(vis);
  // 文字重叠
  let overlap = 0;
  const bx = texts.map(t => { const r = t.getBoundingClientRect();
    return {x:r.x,y:r.y,w:r.width,h:r.height}; });
  for (let i=0;i<bx.length;i++) for (let j=i+1;j<bx.length;j++) {
    const a=bx[i], c=bx[j];
    if (Math.min(a.x+a.w,c.x+c.w)-Math.max(a.x,c.x)>2 &&
        Math.min(a.y+a.h,c.y+c.h)-Math.max(a.y,c.y)>2) overlap++;
  }
  // 元素重叠（控件打架）
  const ctl = [...document.querySelectorAll('button,.btn,[class*=btn],[class*=ctl],[class*=toolbar]')]
    .filter(vis).map(e => { const r = e.getBoundingClientRect(); return {r}; });
  let ctlOverlap = 0;
  for (let i=0;i<ctl.length;i++) for (let j=i+1;j<ctl.length;j++) {
    const a=ctl[i].r, c=ctl[j].r;
    const ox = Math.min(a.right,c.right)-Math.max(a.left,c.left);
    const oy = Math.min(a.bottom,c.bottom)-Math.max(a.top,c.top);
    if (ox>3&&oy>3) ctlOverlap++;
  }
  // 色板
  const cs = getComputedStyle(document.body);
  return {
    title: document.title,
    bodyBg: cs.backgroundColor, bodyColor: cs.color, bodyFont: cs.fontFamily.slice(0,60),
    clickables: clickables.length, inputs: inputs.length,
    svgCount: svgs.length, svgTexts: texts.length,
    textOverlap: overlap, ctlOverlap,
    textSample: texts.slice(0,8).map(t => t.textContent.trim().slice(0,10)).filter(Boolean),
    headings: [...document.querySelectorAll('h1,h2,h3')].map(h=>h.textContent.trim().slice(0,24)).slice(0,8),
    // 是否暗色主题
    dark: (function(){ const c=getComputedStyle(document.body).backgroundColor;
      const m=c.match(/\d+/g); if(!m) return null;
      return (+m[0]+ +m[1] + +m[2])/3 < 90; })(),
    images: document.querySelectorAll('img').length,
    // 懒加载/动画
    animated: document.getAnimations ? document.getAnimations().length : -1
  };
}
"""

GATE = r"""
async (pw) => {
  const s = ms => new Promise(r => setTimeout(r, ms));
  const out = [];
  const tries = [
    ['input[placeholder*=密码]', 'input[type=password]', 'input'],
    ['input[name*=pass]', null, null]
  ];
  let el = null;
  for (const sel of tries[0].slice(0,2)) { const q = document.querySelector(sel);
    if (q) { el = q; break; } }
  if (el) {
    el.value = pw;
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
    await s(150);
    const btn = [...document.querySelectorAll('button,input[type=submit],[class*=btn]')]
      .find(b => /登录|进入|确定|解锁|登 录|Login|Go/i.test(b.textContent||b.value||''));
    if (btn) btn.click();
    await s(2500);
    out.push('gate: 用选择器登录');
  } else {
    // 回退：找所有可见 input
    const inputs = [...document.querySelectorAll('input')].filter(e=>{
      const r=e.getBoundingClientRect(); return r.width>10 && r.height>10;});
    out.push('gate: 可见输入框 ' + inputs.length + ' 个 ' +
      inputs.map(i=>i.type+':'+(i.placeholder||i.name||'')).join(' | '));
    if (inputs.length) {
      inputs[inputs.length-1].value = pw;
      inputs[inputs.length-1].dispatchEvent(new Event('input',{bubbles:true}));
      await s(150);
      const btn = [...document.querySelectorAll('button,input[type=submit]')]
        .find(b => /登录|进入|确定|解锁|Submit/i.test(b.textContent||b.value||''));
      if (btn) { btn.click(); await s(2500); out.push('gate: 点登录按钮'); }
    }
  }
  out.push('gate 后是否还有遮罩: ' + (document.querySelectorAll('[class*=gate],[class*=login],[class*=mask],[class*=lock]').length));
  return out;
}
"""


async def probe_site(tag, url, pg):
    print(f"\n{'='*72}\n【{tag}】{url}\n{'='*72}")
    t0 = time.time()
    try:
        await pg.goto(url, wait_until="load", timeout=90000)
    except Exception as e:
        print("  打开失败:", str(e)[:160]); return
    await pg.wait_for_timeout(2500)
    # 门禁
    try:
        logs = await pg.evaluate(GATE, PW)
        for x in logs: print("  ", x)
    except Exception as e:
        print("  门禁处理异常:", str(e)[:160])
    await pg.wait_for_timeout(2500)
    # 首屏可交互时间
    try:
        d = await pg.evaluate(PROBE)
        print(f"  打开耗时 ~{time.time()-t0:.1f}s")
        for k in ("title", "dark", "bodyBg", "bodyFont", "clickables", "inputs",
                  "svgCount", "svgTexts", "textOverlap", "ctlOverlap", "images",
                  "textSample", "headings", "animated"):
            if k in d: print(f"  {k}: {d[k]}")
    except Exception as e:
        print("  探针失败:", str(e)[:200])
    # 逐视图切换耗时
    print("  —— 视图切换耗时 ——")
    tabs = await pg.evaluate(
        "()=>[...document.querySelectorAll('[class*=tab],[class*=nav],.tab,.on')]"
        ".filter(e=>{const r=e.getBoundingClientRect();return r.width>20&&r.height>12&&r.height<70;})"
        ".slice(0,10).map((e,i)=>({i, txt:(e.textContent||'').replace(/\\s+/g,' ').trim().slice(0,10)}))")
    print("   可点导航候选:", [t["txt"] for t in tabs])
    for t in tabs[:8]:
        try:
            s = time.time()
            await pg.evaluate("(i)=>{const els=[...document.querySelectorAll("
                              "'[class*=tab],[class*=nav],.tab,.on')].filter(e=>{const r=e.getBoundingClientRect();"
                              "return r.width>20&&r.height>12&&r.height<70;});(els[i]||{}).click&&els[i].click();}", t["i"])
            await pg.wait_for_timeout(1800)
            print(f"   · 「{t['txt']}」 {time.time()-s:.2f}s")
        except Exception:
            pass
    try:
        await pg.screenshot(path=os.path.join(OUT, f"ref_{tag}_final.png"))
        print("   截图: docs/stress/ref_" + tag + "_final.png")
    except Exception as e:
        print("   截图失败:", str(e)[:100])


async def main():
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"], executable_path=CHROME)
        for tag, url in SITES:
            ctx = await b.new_context(viewport={"width": 1600, "height": 950})
            pg = await ctx.new_page()
            errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)[:160]))
            try:
                await probe_site(tag, url, pg)
            finally:
                if errs:
                    print("  运行期错误:", list(dict.fromkeys(errs))[:3])
                await ctx.close()
        await b.close()


asyncio.run(main())