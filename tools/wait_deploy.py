"""轮询等待 GitHub Pages 部署新版本，检测到即验证。
不靠猜、不靠本地测试 —— 只以线上真实文件为准。"""
import urllib.request, time, sys

BASE = "https://recover2026.github.io/agrisense-3s/"
LOCAL = "/Users/recover/WorkBuddy/2026-10-06-12-40-38/农险3S遥感地图平台-官网"

def get(path, timeout=20):
    req = urllib.request.Request(BASE+path, headers={'Cache-Control':'no-cache','Pragma':'no-cache'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def local_size(p):
    import os
    return os.path.getsize(LOCAL+"/"+p)

def check():
    """返回 (是否已更新, 说明)"""
    try:
        app = get("assets/js/app.js")
    except Exception as e:
        return False, f"请求失败: {e}"
    ls = local_size("assets/js/app.js")
    marks = {
        "app.js 新增函数": (b"countyRiskDetail" in app),
        "app.js 体积一致": (len(app) == ls),
    }
    try:
        esri = get("assets/js/esri-imagery.js")
        marks["esri dpr 修复"] = (b"devicePixelRatio" in esri)
    except Exception:
        marks["esri dpr 修复"] = False
    try:
        geo = get("assets/js/geo-engine.js")
        marks["geo self 修复"] = (b"if (c && c.stack)" in geo)
    except Exception:
        marks["geo self 修复"] = False
    try:
        nat = get("assets/js/national-view.js")
        marks["市即县兜底"] = (b"drawTownsFromSiblings" in nat)
    except Exception:
        marks["市即县兜底"] = False

    allok = all(marks.values())
    detail = " ".join(f"{'✓' if v else '✗'}{k}" for k,v in marks.items())
    return allok, f"线上 app.js={len(app)}字节(本地{ls}) | {detail}"

if __name__ == "__main__":
    tries = int(sys.argv[1]) if len(sys.argv)>1 else 30
    for i in range(1, tries+1):
        ok, msg = check()
        print(f"[{i}/{tries}] {'✅ 新版本已上线' if ok else '⏳ 仍是旧版'} — {msg}", flush=True)
        if ok:
            sys.exit(0)
        time.sleep(20)
    print("\n超时：GitHub Pages 仍未部署新版本。")
    sys.exit(1)
