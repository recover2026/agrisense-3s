#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""补齐县级参照索引缺失的「省直辖县级行政区」

背景：DataV 县级边界里，仙桃市(429004)、潜江市(429005)、天门市(429006)、
      神农架林区(429021)、济源市(419001)、石河子市(659001) 等
      省直辖县级行政区是独立 adcode，不挂在任何地级市下。
      本地 geo-county-<省>.js 在构建时按地级市分组，这些被整批漏掉，
      导致承保台账里出现这些县时无法上图。

做法：直接向 DataV 逐个请求这些 adcode 的边界（bound/<adcode>.json），
      转成与本地一致的「原点平移 + 整数化 + DP 抽稀」格式，
      写进 geo-county-ref.js 作为补丁（只补名称+落点+边界，不动已有数据）。

用法：python3 tools/patch_direct_counties.py
"""
import json, os, sys, math, urllib.request, time, re

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'assets', 'data')
REF = os.path.join(DATA, 'geo-county-ref.js')

# 省直辖县级行政区清单（adcode -> 所属省）
DIRECT = {
    '419001': '河南省',
    '429004': '湖北省', '429005': '湖北省', '429006': '湖北省', '429021': '湖北省',
    '469007': '海南省',   # 儋州市
    '659001': '新疆维吾尔自治区', '659002': '新疆维吾尔自治区', '659003': '新疆维吾尔自治区',
    '659004': '新疆维吾尔自治区', '659005': '新疆维吾尔自治区', '659006': '新疆维吾尔自治区',
    '659007': '新疆维吾尔自治区', '659008': '新疆维吾尔自治区', '659009': '新疆维吾尔自治区',
    '659010': '新疆维吾尔自治区',
}

# 撤县设市 / 撤县设区 等历史名称 -> 现名
# 承保台账常年沿用旧名，必须能匹配上，否则整批数据落不了图
ALIAS = {
    '监利县': '监利市', '仙桃县': '仙桃市', '潜江县': '潜江市', '天门县': '天门市',
    '神农架县': '神农架林区',
    '邹平县': '邹平市', '即墨县': '即墨区', '胶县': '胶州市', '龙口县': '龙口市',
    '文登县': '文登区', '荣成县': '荣城市', '章丘县': '章丘区', '兖州县': '兖州区',
    '撤销县': '', '双流县': '双流区', '郫县': '郫都区', '新都区': '新都区',
    '荆门市': '荆门市', ' undetermined': '',
    '确山县': '确山县', '光山县': '光山县',
    '商河县': '商河县', '济阳县': '济阳区', '商河': '商河县',
    '长垣县': '长垣市', '封丘县': '封丘县', '获嘉县': '获嘉县',
    '霍山县': '霍山县', '霍邱县': '霍邱县', '寿县': '寿县',
    '歙县': '歙县', '休宁县': '休宁县', '黟县': '黟县', '祁门县': '祁门县',
    '无为县': '无为市', '庐江县': '庐江县', '巢湖县': '巢湖市',
    '广德县': '广德市', '宁国县': '宁国市', '旌德县': '旌德县', '绩溪县': '绩溪县',
    '临海县': '临海市', '温岭县': '温岭市', '玉环县': '玉环市', '天台县': '天台县',
    '仙居县': '仙居县', '三门县': '三门县', '黄岩县': '黄岩区',
    '溧阳县': '溧阳市', '溧水县': '溧水区', '高淳县': '高城区',
    '江宁县': '江宁区', '江浦县': '浦口区', '六合县': '六合区', '溧水': '溧水区',
    '金坛县': '金坛区', '溧水县': '溧水区',
    '吴县': '吴中区', '锡山县': '锡山区', '武进县': '武进区', '金坛县': '金坛区',
    '宜兴县': '宜兴市', '江阴县': '江阴市', '常熟县': '常熟市', '太仓县': '太仓市',
    '昆山县': '昆山市', '吴江县': '吴江区',
    '建湖县': '建湖县', '阜宁县': '阜宁县', '射阳县': '射阳县', '大丰县': '大丰区',
    '东台县': '东台市', '兴化县': '兴化市', '泰兴县': '泰兴市', '靖江县': '靖江市',
    '宝应县': '宝应县', '高邮县': '高邮市', '仪征县': '仪征市',
    '赣榆县': '赣榆区', '东海县': '东海县', '灌云县': '灌云县', '灌南县': '灌南县',
    '泗阳县': '泗阳县', '泗洪县': '泗洪县', '沭阳县': '沭阳县',
    '萧县': '萧县', '砀山县': '砀山县', '亳州市': '亳州市',
    '确山': '确山县',
    '浑江区': '浑江区', '临江县': '临江区', '长白县': '长白朝鲜族自治县',
    '双辽市': '双辽市', '公主岭市': '公主岭市',
    '老河口市': '老河口市',
}


def merc(lng, lat):
    """Web Mercator 正算，必须与 assets/js/geo-engine.js 的 G.lngToX / G.mercY 完全一致。

    ⚠️ 踩过的坑：y 不能写成 2*atan(exp(y/R*π))-π/2 那个形式 ——
       那是「由 y 反算 lat」的公式，方向搞反会让纬度整体偏移十几度
       （仙桃市一度算到北纬 50°）。正算必须是 log(tan(π/4+φ/2))·R/π。
    """
    R = 20037508.34
    lat = max(-85.05112878, min(85.05112878, lat))
    x = R * lng / 180.0
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) / math.pi * R
    return x, y


def unmerc(x, y):
    """Web Mercator 反算（仅用于构建期自检）"""
    R = 20037508.34
    lng = x / R * 180.0
    lat = (2 * math.atan(math.exp(y * math.pi / R)) - math.pi / 2) * 180 / math.pi
    return lng, lat


def fetch(adcode):
    url = 'https://geo.datav.aliyun.com/areas_v3/bound/%s.json' % adcode
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=25) as r:
                return json.loads(r.read().decode('utf-8'))
        except Exception as e:
            if attempt == 2:
                print('  ✗ %s 拉取失败: %s' % (adcode, e)); return None
            time.sleep(1.5 * (attempt + 1))


def rings_of(geom):
    """GeoJSON geometry -> list of rings [[x,y],...]（经纬度）"""
    t = geom.get('type')
    c = geom.get('coordinates')
    out = []
    if t == 'Polygon':
        out.append(c[0])
    elif t == 'MultiPolygon':
        for poly in c:
            out.append(poly[0])
    return [r for r in out if len(r) >= 3]


def dp(pts, tol):
    """Douglas-Peucker 抽稀（输入输出均为投影米坐标）"""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        ax, ay = pts[i]; bx, by = pts[j]
        dx, dy = bx - ax, by - ay
        den = math.hypot(dx, dy)
        best, bi = -1.0, -1
        for k in range(i + 1, j):
            px, py = pts[k]
            if den > 0:
                d = abs(dy * px - dx * py + bx * ay - by * ax) / den
            else:
                d = math.hypot(px - ax, py - ay)
            if d > best:
                best, bi = d, k
        if best > tol:
            keep[bi] = True
            stack.append((i, bi)); stack.append((bi, j))
    return [p for p, k in zip(pts, keep) if k]


def main():
    ref = json.loads(re.search(r'window\.__COUNTY_REF__=(\{.*\});',
                               open(REF, encoding='utf-8').read(), re.S).group(1))
    before = len(ref)
    print('现有索引 %d 县' % before)

    added = 0
    for adcode, prov in DIRECT.items():
        if adcode in ref:
            continue
        d = fetch(adcode)
        if not d or not d.get('features'):
            print('  - %s 无数据' % adcode); continue
        f = d['features'][0]
        p = f.get('properties') or {}
        name = p.get('name')
        geom = f.get('geometry') or {}
        rings_ll = rings_of(geom)
        if not rings_ll:
            print('  - %s %s 无几何' % (adcode, name)); continue

        # 投影 → 绝对米坐标 → 抽稀（统一存绝对坐标，_dr 为渲染时平移量）
        proj = []
        for ring in rings_ll:
            pr = [merc(pt[0], pt[1]) for pt in ring]
            pr = dp(pr, 300)          # 抽稀在绝对坐标下做，避免平移丢失精度
            if len(pr) < 3:
                continue
            pr.append(pr[0])
            proj.append([[int(round(q[0])), int(round(q[1]))] for q in pr])
        if not proj:
            print('  - %s %s 抽稀后为空' % (adcode, name)); continue

        xs = [q[0] for r in proj for q in r]
        ys = [q[1] for r in proj for q in r]
        b = [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))]
        cx, cy = (b[0] + b[2]) // 2, (b[1] + b[3]) // 2
        # 合理性自检：落点必须在 Web Mercator 的中国范围内。
        # ---- 构建期自检：反算回经纬，必须与源数据 center 同量级 ----
        # 这一步必须有：投影公式写反时，正算出的数"看起来仍然正常"，
        # 只有反算比对才能发现（曾因此把仙桃市算到北纬 50°）。
        rc = p.get('center') or p.get('centroid') or geom.get('center')
        if rc and len(rc) >= 2:
            rlng, rlat = float(rc[0]), float(rc[1])
            glng, glat = unmerc(cx, cy)
            km = max(abs(glng - rlng) * 96.0, abs(glat - rlat) * 111.0)
            if km > 60:
                print('  ❌ %s %s 反算偏差 %.0fkm（算得 %.3f,%.3f / 应为 %.3f,%.3f）已跳过'
                      % (adcode, name, km, glng, glat, rlng, rlat)); continue

        # ⚠️ 下界不能用 10.0e6：新疆兵团市（石河子/阿拉尔/图木舒克等）
        #    经度约 75~88°E，投影后 x 仅 8.3~9.8e6，属正常地理位置。
        #    真实中国陆域 x 约 7.3e6(西端) ~ 13.6e6(东端)。
        if not (7.0e6 < cx < 14.0e6 and 1.0e6 < cy < 7.0e6):
            print('  ❌ %s %s 落点异常 (%d,%d) 已跳过' % (adcode, name, cx, cy)); continue

        ref[adcode] = {
            'n': name, 'p': prov, 'pc': adcode[:2],
            'x': cx, 'y': cy, 'b': b,
            # 省直辖县的真实边界（绝对米坐标，已抽稀）
            '_r': proj,
        }
        added += 1
        glng, glat = unmerc(cx, cy)
        print('  ✅ %s %-10s %-10s 环=%-2d 落点=(%d,%d) → %.3f,%.3f'
              % (adcode, name, prov, len(proj), cx, cy, glng, glat))

    # 别名表
    print('\n写入别名 %d 条' % len(ALIAS))
    with open(REF, 'w', encoding='utf-8') as fh:
        fh.write('/* 全国县级参照索引：名称 + adcode + 中心点 + bbox（不含边界几何）\n'
                 '   数据源：assets/data/geo-county-*.js（DataV.GeoAtlas 真实县界）\n'
                 '              + 省直辖县级行政区补丁（DataV bound/<adcode>.json）\n'
                 '   用途：承保信息上传后按县名匹配 adcode 并落点。共 %d 县。\n'
                 '   _r 为省直辖县的真实边界（绝对米坐标，已原点化），供地图着色用。 */\n'
                 % len(ref))
        fh.write('window.__COUNTY_REF__=' + json.dumps(ref, ensure_ascii=False, separators=(',', ':')) + ';\n')
        fh.write('/* 行政区历史名称别名：承保台账常年沿用旧名（撤县设市/撤县设区），\n'
                 '   匹配不到时按此表二次尝试。 */\n')
        fh.write('window.__COUNTY_ALIAS__=' + json.dumps(ALIAS, ensure_ascii=False, separators=(',', ':')) + ';\n')

    print('\n✅ 索引 %d → %d 县（新增 %d）' % (before, len(ref), added))
    print('   体积 %.1f KB' % (os.path.getsize(REF) / 1024.0))


if __name__ == '__main__':
    main()
