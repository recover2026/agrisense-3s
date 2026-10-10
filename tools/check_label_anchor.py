"""判定每个省名标签是否真的落在本省面内。

用户反馈：全国视图里「内蒙古」「北京」这些名字没有落在本省位置上。

判定方式（硬证据，不用肉眼估）：
  1. 遍历 #nat-map 里所有可见的 text 标签；
  2. 找到与标签文字对应的省/区面（data-kind=prov 的 path）；
  3. 用 isPointInFill(标签中心点) 判定标签是否落在该面内部；
  4. 输出「越界」清单 —— 文字挂在别的省/省外，就是错位。
另附：标签与本省面中心的偏移量（像素），便于判断是"完全跑错"还是"略微偏移"。
"""
import asyncio
import glob
import json
import sys

from playwright.async_api import async_playwright

CHROME = glob.glob(
    "/Users/recover/Library/Caches/ms-playwright/chromium_headless_shell-*/"
    "chrome-headless-shell-mac-arm64/chrome-headless-shell"
)[0]
LOCAL = "http://127.0.0.1:8899/index.html"

JS = r"""
() => {
  const host = document.querySelector('#nat-map');
  const svg  = host.querySelector('svg');
  // 省面：data-kind=prov
  const provs = [...host.querySelectorAll('[data-kind=prov][data-id]')];
  // 标签：文本内容 + 真实屏幕中心
  const texts = [...svg.querySelectorAll('text')]
    .filter(t => { const r = t.getBoundingClientRect(); return r.width > 1 && r.height > 1; });

  const norm = s => String(s || '')
    .replace(/省|市|自治区|壮族|回族|维吾尔|特别行政区|特别行政区/g, '')
    .replace(/\s+/g, '');
  // 建立省面索引：用面内 textContent 或索引表
  const nameOf = el => {
    const t = (el.textContent || '').replace(/\s+/g, '');
    return t;
  };

  const out = [];
  for (const t of texts) {
    const label = t.textContent.trim();
    if (!label) continue;
    const r = t.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // ⚠️ isPointInFill 接受的是【SVG 用户坐标】，不是屏幕坐标。
    //    地图的 g.gs-stack 上有 translate+scale，直接传 clientX/Y 恒为 false
    //    （实测 32 个标签全部误报"越界"）。必须先用 getScreenCTM 的逆矩阵换算。
    const insideTest = el => {
      const m = el.getScreenCTM();
      if (!m) return null;
      const q = new DOMPoint(cx, cy).matrixTransform(m.inverse());
      try { return el.isPointInFill ? el.isPointInFill(q) : null; } catch (e) { return null; }
    };
    // 找同名面
    const cand = provs.filter(p => {
      const pn = norm(nameOf(p));
      const ln = norm(label);
      return pn && (pn.indexOf(ln) >= 0 || ln.indexOf(pn) >= 0);
    });
    let hitId = null, inside = null, best = null;
    const insideList = provs.filter(p => insideTest(p) === true).map(nameOf);
    if (cand.length) {
      best = cand[0];
      hitId = best.dataset.id;
      inside = insideTest(best);
    }
    let off = null;
    if (best) {
      const br = best.getBoundingClientRect();
      off = [Math.round(cx - (br.left + br.width / 2)), Math.round(cy - (br.top + br.height / 2)),
             Math.round(br.width), Math.round(br.height)];
    }
    out.push({
      label, cx: Math.round(cx), cy: Math.round(cy),
      w: Math.round(r.width), h: Math.round(r.height),
      hitId, inside, face: best ? nameOf(best) : null,
      faceBox: off, insideList
    });
  }
  return { total: texts.length, out };
}
"""


async def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "local"
    url = (LOCAL if mode == "local" else
           "https://recover2026.github.io/agrisense-3s/index.html") + "?t=" + str(int(__import__("time").time()))
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"], executable_path=CHROME)
        pg = await b.new_page(viewport={"width": 1600, "height": 950})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
        await pg.goto(url, wait_until="load", timeout=90000)
        await pg.wait_for_timeout(2500)
        if await pg.locator("#sfGate").count():
            await pg.evaluate(
                "()=>{try{sessionStorage.setItem('sf3s_gate_ok_v1','1')}catch(e){}"
                "const g=document.getElementById('sfGate');if(g)g.remove();"
                "document.documentElement.style.overflow='';}"
            )
        await pg.wait_for_timeout(1600)
        await pg.click('.tab[data-tab="national"]')
        await pg.wait_for_timeout(5000)
        d = await pg.evaluate(JS)
        print(f"=== {mode} · 全国视图标签归属核查 · 共 {d['total']} 个标签")
        print(f"{'标签':12} {'中心':>12} {'对应面':10} {'面盒(偏移x,偏移y,宽,高)':26} 判定")
        wrong, unknown = [], []
        for x in d["out"]:
            if x["hitId"] is None:
                # 无同名面 —— 也要看它落在了谁身上
                tag = ",".join(x["insideList"])[:24] or "(无面内)"
                flag = "?" if x["insideList"] else "悬空"
                print(f"{x['label']:12} {str((x['cx'], x['cy'])):>12} {'(无同名面)':10} {'':26} {flag} 落在:{tag}")
                unknown.append(x)
                continue
            if x["inside"] is False:
                flag = "✗ 越界(挂在:" + (",".join(x["insideList"])[:18] or "省外") + ")"
                wrong.append(x)
            else:
                flag = "✓"
            fb = x["faceBox"]
            print(f"{x['label']:12} {str((x['cx'], x['cy'])):>12} {x['face']:10} "
                  f"{str(fb):26} {flag}")
        print(f"\n判定为越界：{len(wrong)} 个")
        for x in wrong:
            print(f"   ✗ {x['label']} 中心({x['cx']},{x['cy']}) 实际落在 {x['insideList'] or '省外'} "
                  f"本省面中心偏移 {x['faceBox'][:2]}")
        if errs:
            print("错误:", errs[:3])
        await b.close()


asyncio.run(main())