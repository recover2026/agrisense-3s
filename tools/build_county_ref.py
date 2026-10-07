#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""构建全国县级参照索引 geo-county-ref.js

用途：承保信息上传后，需要把表里的「县名/乡镇名」落到地图 adcode 上。
      本索引只含名称 + adcode + 中心点 + bbox，不含任何边界几何，
      因此体积很小（约 60KB），可常驻首屏加载。

数据来源：assets/data/geo-county-*.js（34 省真实县界）
输出：window.__COUNTY_REF__ = { "<adcode>": {n, p, pc, x, y, b:[x0,y0,x1,y1]} }
"""
import re, json, glob, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'assets', 'data')

PROV = {}
pf = os.path.join(DATA, 'geo-province.js')
txt = open(pf, encoding='utf-8').read()
m = re.search(r'window\.__GEO_PROV__\s*=\s*(\{.*\})\s*;?\s*$', txt, re.S)
if not m:
    # 兼容 var 形式
    m = re.search(r'=\s*(\{.*\})\s*;?\s*$', txt, re.S)
pv = json.loads(m.group(1))
for p in pv['provinces']:
    PROV[str(p['c'])[:2]] = p['n']

def poly_bbox(rings, b):
    xs, ys = [], []
    for ring in rings:
        for pt in ring:
            xs.append(pt[0] + b[0]); ys.append(pt[1] + b[1])
    if not xs:
        return None
    return [min(xs), min(ys), max(xs), max(ys)]

def poly_centroid(rings, b):
    """面积加权质心（多环用最大环），落到 bbox 范围内。"""
    best, ba = None, -1
    for ring in rings:
        a = 0.0; cx = 0.0; cy = 0.0
        n = len(ring)
        for i in range(n):
            x0, y0 = ring[i][0] + b[0], ring[i][1] + b[1]
            x1, y1 = ring[(i + 1) % n][0] + b[0], ring[(i + 1) % n][1] + b[1]
            cr = x0 * y1 - x1 * y0
            a += cr; cx += (x0 + x1) * cr; cy += (y0 + y1) * cr
        a = abs(a / 2.0)
        if a > ba:
            ba = a
            if a > 1e-9:
                best = (cx / (6 * (a if a > 0 else -a)) if False else cx / (3.0 * (2 * a / 2 * 2) / 2), 0)
            # 直接用标准公式重算，避免符号错误
            A2 = 0.0; CX = 0.0; CY = 0.0
            for i in range(n):
                x0, y0 = ring[i][0] + b[0], ring[i][1] + b[1]
                x1, y1 = ring[(i + 1) % n][0] + b[0], ring[(i + 1) % n][1] + b[1]
                cr = x0 * y1 - x1 * y0
                A2 += cr; CX += (x0 + x1) * cr; CY += (y0 + y1) * cr
            A2 = A2 / 2.0
            if abs(A2) > 1e-9:
                best = (CX / (6 * A2), CY / (6 * A2))
            else:
                sx = sum(p[0] + b[0] for p in ring) / n
                sy = sum(p[1] + b[1] for p in ring) / n
                best = (sx, sy)
    return best

ref = {}
prov_files = sorted(glob.glob(os.path.join(DATA, 'geo-county-*.js')))
if not prov_files:
    sys.exit('找不到 geo-county-*.js')

for f in prov_files:
    base = os.path.basename(f)
    if base == 'geo-county-index.js':
        continue
    txt = open(f, encoding='utf-8').read()
    m = re.search(r'window\.__KBP__\s*=\s*(\{.*\})\s*;?\s*$', txt, re.S)
    if not m:
        print('  跳过（正则未匹配）:', base); continue
    try:
        d = json.loads(m.group(1))
    except Exception as e:
        print('  跳过（JSON 解析失败）:', base, e); continue
    n_ok = 0
    for code, o in d.items():
        if not o.get('r') or not o.get('b'):
            continue
        b = o['b']
        if len(b) == 2:
            b = [b[0], b[1], b[0] + (o.get('w') or 0), b[1] + (o.get('h') or 0)]
        bb = poly_bbox(o['r'], b)
        if not bb:
            continue
        c = poly_centroid(o['r'], b)
        if not c:
            continue
        # 质心必须落在 bbox 内（凹形县可能落在界外，夹一下更安全）
        cx = min(max(c[0], bb[0]), bb[2])
        cy = min(max(c[1], bb[1]), bb[3])
        pc = code[:2]
        ref[code] = {
            'n': o['n'],
            'p': PROV.get(pc, ''),
            'pc': pc,
            'x': int(cx), 'y': int(cy),
            'b': [int(bb[0]), int(bb[1]), int(bb[2]), int(bb[3])],
        }
        n_ok += 1
    print('  %-28s %4d 县' % (base, n_ok))

out = os.path.join(DATA, 'geo-county-ref.js')
body = json.dumps(ref, ensure_ascii=False, separators=(',', ':'))
with open(out, 'w', encoding='utf-8') as fh:
    fh.write('/* 全国县级参照索引：名称 + adcode + 中心点 + bbox（不含边界几何）\n'
             '   数据源：assets/data/geo-county-*.js（DataV.GeoAtlas 真实县界）\n'
             '   用途：承保信息上传后按县名匹配 adcode 并落点。共 %d 县。 */\n' % len(ref))
    fh.write('window.__COUNTY_REF__=' + body + ';\n')

print('\n✅ 输出 %s' % out)
print('   县数 %d · 覆盖省 %d · 体积 %.1f KB' % (
    len(ref), len(set(v['pc'] for v in ref.values())), os.path.getsize(out) / 1024.0))
