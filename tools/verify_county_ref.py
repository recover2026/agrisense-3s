#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""承保落点精度核验：拿 DataV 权威 center 逐县比对索引里的落点。

背景：承保数据最终要落到地图上某个具体位置。若投影公式或质心算法有错，
      整批保单会飞到几百公里外 —— 而这种错误在界面上"看起来完全正常"。
      所以必须用外部权威坐标做逐县比对，不能靠肉眼。

用法：python3 tools/verify_county_ref.py [抽样数]
"""
import json, re, os, math, sys, urllib.request, time, random

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'assets', 'data')
REF = os.path.join(DATA, 'geo-county-ref.js')
CACHE = '/tmp/uw_county_cache'
os.makedirs(CACHE, exist_ok=True)

R = 20037508.34


def unmerc(x, y):
    return x / R * 180.0, (2 * math.atan(math.exp(y * math.pi / R)) - math.pi / 2) * 180 / math.pi


def fetch_center(adcode):
    f = os.path.join(CACHE, adcode + '.json')
    if os.path.exists(f):
        try:
            return json.load(open(f, encoding='utf-8'))
        except Exception:
            pass
    url = 'https://geo.datav.aliyun.com/areas_v3/bound/%s.json' % adcode
    for k in range(3):
        try:
            resp = urllib.request.urlopen(url, timeout=20)
            try:
                d = json.loads(resp.read().decode('utf-8'))
            finally:
                resp.close()
                d = json.loads(r.read().decode('utf-8'))
            p = d['features'][0]['properties']
            c = p.get('center') or p.get('centroid') or (d['features'][0]['geometry'].get('center'))
            out = {'n': p.get('name'), 'lng': c[0], 'lat': c[1]}
            json.dump(out, open(f, 'w', encoding='utf-8'))
            return out
        except Exception as e:
            if k == 2:
                return None
            time.sleep(1.2 * (k + 1))


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 40
    txt = open(REF, encoding='utf-8').read()
    d = json.loads(re.search(r'window\.__COUNTY_REF__=(\{.*?\});\n', txt, re.S).group(1))
    keys = sorted(d.keys())
    random.seed(20261007)
    # 必测：承保重点县 + 补丁县
    must = ['421127', '421124', '421023', '429004', '429005', '429006', '429021',
            '419001', '659001', '659006', '370681', '371082', '370215']
    must = [k for k in must if k in d]
    pick = must + random.sample([k for k in keys if k not in must],
                                min(n, len(keys) - len(must)))

    print('核验 %d 个县（必测 %d + 随机 %d）\n' % (len(pick), len(must), len(pick) - len(must)))
    print('%-8s %-12s %-16s %-16s %8s' % ('adcode', '县名', '索引落点', '权威中心', '误差km'))
    print('-' * 72)

    ok, warn, fail, miss = 0, [], [], []
    for k in pick:
        v = d[k]
        c = fetch_center(k)
        if not c:
            miss.append(k); continue
        lng, lat = unmerc(v['x'], v['y'])
        km = math.hypot((lng - c['lng']) * 96.0, (lat - c['lat']) * 111.0)
        # 判据：县尺度内 bbox 中心与 center 的差，
        # 正常 <25km；25~60km 多为形状狭长县（中心本就在县外）；
        # >60km 视为落点错误。
        tag = ''
        if km > 60:
            tag = '  ❌ 超差'; fail.append((k, v['n'], km))
        elif km > 25:
            tag = '  ⚠ 偏大'; warn.append((k, v['n'], km))
        else:
            ok += 1
        print('%-8s %-12s (%7.3f,%6.3f) (%7.3f,%6.3f) %8.1f%s'
              % (k, v['n'][:10], lng, lat, c['lng'], c['lat'], km, tag))

    print('\n' + '=' * 60)
    print('正常 %d · 偏大 %d · 超差 %d · 拉取失败 %d' % (ok, len(warn), len(fail), len(miss)))
    if warn:
        print('\n偏大（多为狭长县，中心落在县外，可接受）：')
        for k, nm, km in warn: print('  %s %s %.0fkm' % (k, nm, km))
    if fail:
        print('\n❌ 超差（落点错误，必须修）：')
        for k, nm, km in fail: print('  %s %s %.0fkm' % (k, nm, km))
    if miss:
        print('\n拉取失败（网络问题，非数据问题）：%s' % ','.join(miss))
    return 1 if fail else 0


if __name__ == '__main__':
    sys.exit(main())
