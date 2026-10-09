/* ============================================================
   阳光3S遥感平台 · 主应用
   四大模块：承保风险地图 / 理赔定损地图 / 预警调度 / 灾情损失评估
   ============================================================ */
(function () {
  'use strict';

  var GEO = window.__GEO__, D = window.DATA;
  // 安全查询：元素缺失时返回空占位对象，避免单点缺失导致整模块崩溃
  function Nul() {
    return new Proxy({}, { get: function () { return function () { return ''; }; }, set: function () { return true; } });
  }
  var $ = function (s, r) { return (r || document).querySelector(s) || Nul(); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var fmt = function (n, d) { return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); };
  var st = {};   // 全局状态

  /* ============ 通用 UI ============ */
  function detail(title, sub, html) {
    var d = $('#detail');
    $('#dt-title').textContent = title;
    $('#dt-sub').textContent = sub || '';
    $('#dt-body').innerHTML = html;
    d.classList.add('on');
    /* 详情弹层（#detail，在页面根部 z-index:30）固定在地图右上角，
       会把同样位于右上角的「点选」按钮盖住 —— 用户点不到。
       打开时标记 <body>，CSS 侧据此把按钮下移到弹层下方。

       ⚠️ 这里踩了两个坑，都记下来：
       1) 原来用 document.querySelector('.mapwrap') 打has-detail，
          但全站有 7 个 mapwrap，只取到【第一个】（总览驾驶舱的），
          全国视图的按钮纹丝不动；
       2) 改成全量标记后仍不生效 —— 因为 #detail 根本不在任何 mapwrap 内，
          它是 body 的直接子元素（index.html:440），
          而 CSS 规则写的是 `.mapwrap.has-detail`（后代选择器），
          两者之间没有祖先-后代关系，自然匹配不上。
       正解：标记挂在 body 上，与 #detail 同级，作用域关系才成立。 */
    document.body.classList.add('has-detail');
  }
  function closeDetail() {
    $('#detail').classList.remove('on');
    document.body.classList.remove('has-detail');
  }
  $('#dt-close').addEventListener('click', closeDetail);

  function tick() {
    var d = new Date();
    var p = function (n) { return n < 10 ? '0' + n : n; };
    $('#clock-date').textContent = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    $('#clock-time').textContent = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  tick(); setInterval(tick, 1000);

  /* ============================================================
     视图 0 · 总览驾驶舱
     ============================================================ */
  function buildOverview() {
    var v = $('#v-overview');
    var hb = GEO.provinces.filter(function (p) { return p.c === 420000; })[0];
    var cities = GEO.cities;
    var biz = cities.map(function (c) { return D.CITY_BIZ[c.n] || { area: 0, insure: 0, cor: 80, risk: 3 }; });

    var sum = biz.reduce(function (a, b) {
      a.area += b.area; a.insure += b.insure; a.risk += b.risk; return a;
    }, { area: 0, insure: 0, risk: 0 });
    var avgCor = biz.reduce(function (a, b) { return a + b.cor; }, 0) / biz.length;

    // 湖北定位
    var hbB = G.ringsBBox(hb.r);

    // 模拟热点（黄梅/监利/秭归定位点）
    var focus = GEO.counties.map(function (c) { return { name: c.n, xy: G.polyCentroid(c.r) }; });

    var map = new GeoCanvas($('#map-overview'), {
      onPick: function (p) {
        if (p.kind === 'city') {
          var o = cities.filter(function (c) { return String(c.c) === p.id; })[0];
          if (o) cityDetail(o);
        } else if (p.kind === 'county') {
          var k = GEO.counties.filter(function (c) { return String(c.c) === p.id; })[0];
          if (k) switchTab('claims');
        }
      },
      onView: function (vv) { $('#ov-coord').textContent = vv.lng.toFixed(2) + '°E  ' + vv.lat.toFixed(2) + '°N'; }
    });

    map.layer('base', 1); map.layer('biz', 2); map.pxLayer('hot', 3); map.pxLayer('lab', 4);
    st.ovMap = map;

    // 湖北面
    map.area('base', hb, { fill: 'rgba(59,130,246,.09)', stroke: 'rgba(96,165,250,.62)', strokeWidth: 1.6 });
    /* 邻省淡显。
       ⚠️ 此前遍历 GEO.provinces（geo.js 里的全国 35 省，449KB），
         而该文件在 app.js 里只被用到湖北一省 —— 为此首屏多背了 437KB。
         现改用已在首屏的 __GEO_PROV__（geo-province.js，全国省界），
         并同样只取湖北的 bbox 邻域，效果一致、首屏省437KB。
         两套省界精度不同，此处仅作极淡的底图轮廓，无可辨识要求。 */
    (window.__GEO_PROV__ && window.__GEO_PROV__.provinces || []).forEach(function (p) {
      if (p.c === 420000) return;
      var d2 = G.ringsBBox(p.r);
      var near = !(d2[2] < hbB[0] - 200000 || d2[0] > hbB[2] + 200000 ||
                   d2[3] < hbB[1] - 200000 || d2[1] > hbB[3] + 200000);
      if (near) map.area('base', p, { fill: 'rgba(120,160,220,.035)', stroke: 'rgba(120,160,220,.13)', strokeWidth: .8 });
    });

    // 市界：按综合风险指数着色（带 pick 元数据）
    cities.forEach(function (c) {
      var b = D.CITY_BIZ[c.n] || { risk: 3, insure: 0, cor: 80 };
      var t = Math.max(0, Math.min(1, (b.risk - 2) / 2.3));
      var col = riskColor(t);
      map.area('biz', { n: c.n, c: c.c, kind: 'city', r: c.r }, {
        fill: 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + (0.14 + t * 0.4).toFixed(3) + ')',
        stroke: col[3], strokeWidth: 1.3
      });
    });

    // 重点县标记（屏幕像素，任何缩放级别大小恒定）
    focus.forEach(function (f) {
      var p = map.toPx(f.xy[0], f.xy[1]);
      var r1 = map.pxRing('hot', p.x, p.y, 17, { stroke: 'rgba(255,211,90,.9)', sw: 1.6, dash: '4,3' });
      var d1 = map.pxDot('hot', p.x, p.y, 6, { fill: '#ffd35a', stroke: 'rgba(7,13,24,.9)', sw: 1.4, filter: 'url(#gsGlow)' },
        { kind: 'city', title: f.name + ' · 点击进入理赔定损' });
      var t1 = map.pxLabel('lab', p.x, p.y - 24, f.name, { fill: '#ffd35a', size: 12, halo: '#1c1408', haloW: 4.2 });
      map.anchor(d1, f.xy[0], f.xy[1], 0, [r1]);
      map.anchor(t1, f.xy[0], f.xy[1], -24);
    });

    map.fit(hbB);
    // 市级标注（屏幕像素）——加深描边，确保在彩色面上清晰可读
    cities.forEach(function (c) {
      var ct = G.polyCentroid(c.r);
      if (ct[0] < hbB[0] || ct[0] > hbB[2] || ct[1] < hbB[1] || ct[1] > hbB[3]) return;
      var p = map.toPx(ct[0], ct[1]);
      var lt3 = map.pxLabel('lab', p.x, p.y, c.n.replace(/市|土家族苗族自治州|林区/, ''),
        { fill: '#ffffff', size: 11.5, halo: '#1c1408', haloW: 4.2, weight: 700 });
      map.anchor(lt3, ct[0], ct[1], 0, null, true, 700);
    });

    // 指标卡
    $('#ov-kpi').innerHTML = [
      card('承保面积', fmt(sum.area, 0), '万亩', '模拟测算 · 湖北17市', '#3b82f6'),
      card('保费规模', fmt(sum.insure, 1), '亿元', '模拟测算 · 政策性+商业性', '#34d399'),
      card('平均综合成本率', avgCor.toFixed(1), '%', '行业健康线<85%', avgCor < 85 ? '#34d399' : '#fb923c'),
      card('在保农户', '12.8', '万户', '模拟测算', '#ffd35a')
    ].join('');

    // 市州保费排名条
    var rank = cities.slice().sort(function (a, b) {
      return (D.CITY_BIZ[b.n] || {}).insure - (D.CITY_BIZ[a.n] || {}).insure;
    }).slice(0, 9);
    var maxI = rank[0] ? (D.CITY_BIZ[rank[0].n] || {}).insure : 1;
    $('#ov-rank').innerHTML = rank.map(function (c) {
      var b = D.CITY_BIZ[c.n] || {};
      var w = (b.insure / maxI * 100).toFixed(1);
      return '<div class="hbar"><div class="hbar-n">' + c.n + '</div>' +
        '<div class="hbar-t"><i style="width:' + w + '%;background:linear-gradient(90deg,#3b82f6,#22d3ee)"></i></div>' +
        '<div class="hbar-v">' + (b.insure || 0).toFixed(1) + '亿</div></div>';
    }).join('');

    // 灾种分布
    $('#ov-hazard').innerHTML = Object.keys(D.HAZARD).map(function (k) {
      var h = D.HAZARD[k];
      var w = (h.w * 100 / 0.30 * 26).toFixed(0);
      return '<div class="hbar"><div class="hbar-n">' + k + '</div>' +
        '<div class="hbar-t"><i style="width:' + Math.min(100, w) + '%;background:' + h.color + '"></i></div>' +
        '<div class="hbar-v">' + (h.w * 100).toFixed(0) + '%</div></div>';
    }).join('');

    $('#ov-total-area').textContent = fmt(sum.area, 0);
    $('#ov-total-premium').textContent = fmt(sum.insure, 1);
  }

  function card(l, v, u, d, c) {
    return '<div class="card" style="--c:' + c + '">' +
      '<div class="card-c">' + (c === '#3b82f6' ? '◎' : c === '#34d399' ? '◈' : c === '#fb923c' ? '▲' : '✦') + '</div>' +
      '<div class="card-t">' + l + '</div>' +
      '<div class="card-v">' + v + '<small>' + u + '</small></div>' +
      '<div class="card-d">' + d + '</div></div>';
  }

  function riskColor(t) {
    // 低 → 高：绿 → 黄 → 橙 → 红
    var stops = [[52, 211, 153], [250, 204, 21], [251, 146, 60], [248, 113, 113]];
    var i = Math.min(2, Math.floor(t * 3)), f = t * 3 - i;
    var a = stops[i], b = stops[i + 1] || stops[3];
    return [
      Math.round(a[0] + (b[0] - a[0]) * f),
      Math.round(a[1] + (b[1] - a[1]) * f),
      Math.round(a[2] + (b[2] - a[2]) * f),
      'rgba(' + a[0] + ',' + a[1] + ',' + a[2] + ',.8)'
    ];
  }

  function cityDetail(c) {
    var b = D.CITY_BIZ[c.n] || {};
    var html =
      '<div class="kv"><span>行政区域</span><b>' + c.n + '</b></div>' +
      '<div class="kv"><span>行政区划代码</span><b>' + c.c + '</b></div>' +
      '<div class="kv"><span>耕地面积</span><b>' + fmt(b.area || 0, 0) + ' 千亩</b></div>' +
      '<div class="kv"><span>保费规模</span><b>' + (b.insure || 0).toFixed(1) + ' 亿元</b></div>' +
      '<div class="kv"><span>综合成本率</span><b style="color:' + ((b.cor || 80) < 85 ? 'var(--green)' : 'var(--red)') + '">' + (b.cor || 0) + '%</b></div>' +
      '<div class="kv"><span>主导作物</span><b>' + (b.main || '—') + '</b></div>' +
      '<div class="dt-sub">综合风险指数（五维加权）</div>' +
      D.RISK_DIMS.map(function (d) {
        var v = (b.risk || 3) / 5 * (0.6 + (d.w * 1.4));
        return '<div class="hbar"><div class="hbar-n">' + d.n + '</div>' +
          '<div class="hbar-t"><i style="width:' + (v * 100).toFixed(0) + '%;background:linear-gradient(90deg,#fb923c,#f87171)"></i></div>' +
          '<div class="hbar-v">' + (v * 100).toFixed(0) + '</div></div>';
      }).join('') +
      '<div class="note" style="margin-top:11px"><b>数据口径</b>：本页业务指标为模拟测算演示数据，不代表阳光财险真实经营数据。真实数据以公司业务系统导出为准。</div>';
    detail(c.n, '承保端 · 市州风险画像 · 模拟测算', html);
  }

  /* ============================================================
     视图 1 · 承保端风险地图
     ============================================================ */
  function buildUnderwrite() {
    var map = new GeoCanvas($('#map-uw'), {
      onPick: function (p) {
        if (p.kind === 'parcel') parcelDetail(p.id);
      },
      onView: function (v) { $('#uw-coord').textContent = v.lng.toFixed(2) + '°E  ' + v.lat.toFixed(2) + '°N'; }
    });
    map.layer('base', 1); map.layer('cover', 2); map.layer('parcel', 3); map.pxLayer('risk', 4); map.pxLayer('lab', 5);
    st.uwMap = map;

    // 默认显示湖北省 + 县界下钻到黄梅
    var hb = GEO.provinces.filter(function (p) { return p.c === 420000; })[0];
    map.area('base', hb, { fill: 'rgba(59,130,246,.05)', stroke: 'rgba(96,165,250,.4)', strokeWidth: 1.2 });

    renderUWParcels('421127');
    // 县列表：整行可点，点击即在该县重绘地块并联动右栏
    // （原文案"点击下钻"是静态字样、无指引性，改为明确动作提示）
    $('#uw-counties').innerHTML = GEO.counties.map(function (c) {
      return '<div class="row" data-cd="' + c.c + '" title="点击查看' + c.n + '地块风险统计">' +
        '<div class="row-h">' +
        '<div class="row-t">' + c.n + '</div>' +
        '<span class="tag tag-blue">重点县</span></div>' +
        '<div class="row-m"><span>adcode <b>' + c.c + '</b></span>' +
        '<span style="color:var(--brand);font-weight:600">▸ 点击查看地块 ›</span></div></div>';
    }).join('');
    $$('#uw-counties .row').forEach(function (el) {
      el.addEventListener('click', function () { renderUWParcels(el.dataset.cd); syncUW(el.dataset.cd); });
    });

    // 图例
    $('#uw-legend').innerHTML = [
      { n: '低风险（≤2.8）', c: 'rgba(52,211,153,.55)' },
      { n: '中风险（2.8–3.4）', c: 'rgba(250,204,21,.55)' },
      { n: '较高风险（3.4–4.0）', c: 'rgba(251,146,60,.6)' },
      { n: '高风险（>4.0）', c: 'rgba(248,113,113,.62)' }
    ].map(function (l) {
      return '<div class="lg-row"><span class="lg-sw" style="background:' + l.c + '"></span><span>' + l.n + '</span></div>';
    }).join('');

    $('#uw-flow').innerHTML = [
      { n: '01', t: '影像预处理', d: '高分/雷达/多光谱多源融合，云量与几何校正' },
      { n: '02', t: 'AI 地物识别', d: '深度学习提取耕地边界、作物分类、面积勾绘' },
      { n: '03', t: '重复投保核验', d: '按图承保，与历史保单空间比对识别重叠投保' },
      { n: '04', t: '风险分级落库', d: '五维加权风险指数，按乡镇/地块分级定价' }
    ].map(function (f) {
      return '<div class="fl"><div class="fl-n">' + f.n + '</div><div class="fl-t">' + f.t + '</div><div class="fl-d">' + f.d + '</div></div>';
    }).join('');
  }

  function renderUWParcels(code) {
    var map = st.uwMap; if (!map) return;
    var cty = GEO.counties.filter(function (c) { return String(c.c) === code; })[0];
    if (!cty) return;
    map.clear('cover'); map.clear('parcel'); map.clear('risk'); map.clear('lab');
    st.uwMap.pxAnchors = [];
    map.area('cover', cty, { fill: 'rgba(59,130,246,.07)', stroke: 'rgba(96,165,250,.75)', strokeWidth: 1.6 });

    var loss = D.LOSS_CASES[code] || { towns: [] };
    var parcels = D.makeParcels(cty.r, code, 190, cty.b);
    var rnd = D.mulberry32(code);
    st.uwParcels = [];

    parcels.forEach(function (p, i) {
      var t = rnd();
      var col = riskColor(t);
      var poly = [{ n: '地块' + (i + 1), c: code + '-' + i, kind: 'parcel', r: [p.pts] }];
      map.area('parcel', poly[0], {
        fill: 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',.34)',
        stroke: 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',.75)', strokeWidth: .8
      });
      st.uwParcels.push({ id: code + '-' + i, xy: [p.cx, p.cy], risk: t, area: 40 + rnd() * 320 });
    });

    // 乡镇标注（用聚类点）
    var towns = loss.towns || [];
    st.uwParcels.forEach(function (p) {
      if (p.risk > 0.72) {
        var sp = map.toPx(p.xy[0], p.xy[1]);
        var nd = map.pxDot('risk', sp.x, sp.y, 4.5, { fill: '#f87171', stroke: 'rgba(255,255,255,.85)', sw: 1.2 });
        map.anchor(nd, p.xy[0], p.xy[1]);
      }
    });
    if (towns.length && st.uwParcels.length) {
      towns.forEach(function (t, i) {
        var idx = Math.min(st.uwParcels.length - 1,
                           Math.floor((i + .5) / towns.length * st.uwParcels.length));
        var pp = st.uwParcels[idx];
        if (!pp) return;
        var sp = map.toPx(pp.xy[0], pp.xy[1]);
        var lt = map.pxLabel('lab', sp.x, sp.y, t.n, { fill: '#ffffff', size: 11, halo: '#1c1408', haloW: 4, weight: 700 });
        map.anchor(lt, pp.xy[0], pp.xy[1], 0, null, true, 620);
      });
    }
    map.fit(cty.b);
    $('#uw-title').textContent = cty.n + ' · 承保地块风险分布';
    var avgR = st.uwParcels.reduce(function (a, p) { return a + p.risk; }, 0) / (st.uwParcels.length || 1);
    var highN = st.uwParcels.filter(function (p) { return p.risk > 0.72; }).length;
    $('#uw-stats').innerHTML =
      kv('在保地块', st.uwParcels.length + ' 块') +
      kv('平均风险指数', (avgR * 100).toFixed(0) + ' / 100') +
      kv('高风险地块', highN + ' 块') +
      kv('可重复投保疑似', Math.max(1, Math.round(highN * 0.12)) + ' 块');
  }

  function syncUW(code) {
    $$('#uw-counties .row').forEach(function (r) { r.classList.toggle('on', r.dataset.cd === code); });
  }

  function parcelDetail(id) {
    var p = st.uwParcels.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    var code = id.split('-')[0];
    var cty = GEO.counties.filter(function (c) { return String(c.c) === code; })[0];
    var col = riskColor(p.risk);
    var html =
      '<div class="kv"><span>地块编号</span><b>' + id + '</b></div>' +
      '<div class="kv"><span>所属区域</span><b>' + (cty ? cty.n : '—') + '</b></div>' +
      '<div class="kv"><span>地块面积</span><b>' + p.area.toFixed(1) + ' 亩</b></div>' +
      '<div class="kv"><span>风险指数</span><b style="color:rgb(' + col[0] + ',' + col[1] + ',' + col[2] + ')">' + (p.risk * 100).toFixed(0) + ' / 100</b></div>' +
      '<div class="kv"><span>风险等级</span><b>' + (p.risk > .72 ? '高风险' : p.risk > .45 ? '中风险' : '低风险') + '</b></div>' +
      '<div class="dt-sub">建议承保策略</div>' +
      '<div class="note">' +
      (p.risk > .72
        ? '<b>建议</b>：纳入重点风险管控名单，承保前追加实地验标；建议上浮费率或加设免赔额；纳入灾前预警重点推送名单。'
        : p.risk > .45
          ? '<b>建议</b>：按标准条款承保，纳入常规灾前预警推送；关注长势监测变化。'
          : '<b>建议</b>：可按标准条件承保，风险可控。') +
      '</div>' +
      '<div class="note warn" style="margin-top:8px"><b>演示数据</b>：地块面积、风险指数均为模拟测算，不代表真实承保数据。</div>';
    detail('地块详情 · ' + id, '承保端 · 地块级风险画像 · 模拟测算', html);
  }

  function kv(k, v) { return '<div class="kv"><span>' + k + '</span><b>' + v + '</b></div>'; }

  /* ============================================================
     视图 2 · 理赔端定损地图
     ============================================================ */
  function buildClaims() {
    var map = new GeoCanvas($('#map-cl'), {
      onPick: function (p) {
        if (p.kind === 'plot') plotDetail(p.id);
      },
      onView: function (v) { $('#cl-coord').textContent = v.lng.toFixed(2) + '°E  ' + v.lat.toFixed(2) + '°N'; }
    });
    map.layer('base', 1); map.layer('cover', 2); map.layer('loss', 3); map.pxLayer('plot', 4); map.pxLayer('lab', 5);
    st.clMap = map;

    $('#cl-counties').innerHTML = Object.keys(D.LOSS_CASES).map(function (code) {
      var c = D.LOSS_CASES[code];
      return '<div class="row" data-cd="' + code + '"><div class="row-h">' +
        '<div class="row-t">' + c.name + '</div>' +
        '<span class="tag ' + (c.level === '重灾' ? 'tag-red' : 'tag-orange') + '">' + c.level + '</span></div>' +
        '<div class="row-m"><span>' + c.crop + '</span><span>' + c.disaster + '</span></div>' +
        '<div class="row-m"><span>出险 <b>' + fmt(c.claimMu, 0) + ' 亩</b></span><span>完成 <b>' + (c.done * 100).toFixed(0) + '%</b></span></div>' +
        '<div class="bar"><i style="width:' + (c.done * 100).toFixed(0) + '%"></i></div></div>';
    }).join('');
    $$('#cl-counties .row').forEach(function (el) {
      el.addEventListener('click', function () { renderClaims(el.dataset.cd); syncCL(el.dataset.cd); });
    });

    $('#cl-img').innerHTML = D.WARN_TYPES.slice(0, 4).map(function (t) {
      return '<div class="note" style="padding:7px 9px"><b>' + t.name + '</b></div>';
    }).join('');

    $('#cl-flow').innerHTML = [
      { n: '01', t: '灾后影像获取', d: '高分光学 + 合成孔径雷达，半天内覆盖受灾区域' },
      { n: '02', t: 'AI 灾害图斑提取', d: '深度学习解译受灾范围与程度，生成定损图斑' },
      { n: '03', t: '损失面积计算', d: '图斑与承保地块空间叠加，自动算损失面积比例' },
      { n: '04', t: '人工抽核定损', d: '遥感初筛 + 人工抽核，避免全自动误判争议' }
    ].map(function (f) {
      return '<div class="fl"><div class="fl-n">' + f.n + '</div><div class="fl-t">' + f.t + '</div><div class="fl-d">' + f.d + '</div></div>';
    }).join('');

    renderClaims('421127');
  }

  function renderClaims(code) {
    var map = st.clMap; if (!map) return;
    var c = D.LOSS_CASES[code];
    var cty = GEO.counties.filter(function (x) { return String(x.c) === code; })[0];
    if (!c || !cty) return;
    ['cover', 'loss', 'plot', 'lab'].forEach(function (L) { map.clear(L); });
    st.clMap.pxAnchors = [];

    map.area('cover', cty, { fill: 'rgba(248,113,113,.05)', stroke: 'rgba(96,165,250,.75)', strokeWidth: 1.6 });

    // 生成乡镇图斑（按乡镇损失率着色）
    var towns = c.towns, total = towns.reduce(function (a, t) { return a + t.mu; }, 0);
    var rnd = D.mulberry32(code + 7);
    var parcels = D.makeParcels(cty.r, code + 7, 210, cty.b);
    st.clPlots = [];

    // 把乡镇按面积权重分配图斑数
    var start = 0;
    towns.forEach(function (t) {
      var cnt = Math.max(3, Math.round(t.mu / total * parcels.length));
      cnt = Math.min(cnt, parcels.length - start);
      for (var i = 0; i < cnt && start < parcels.length; i++, start++) {
        var p = parcels[start];
        var lr = Math.max(0, Math.min(1, t.loss + (rnd() - .5) * 0.22));
        var col = lossColor(lr);
        map.area('loss', { n: t.n, c: code + '-' + start, kind: 'plot', r: [p.pts] }, {
          fill: 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',.5)',
          stroke: 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',.85)', strokeWidth: .9
        });
        st.clPlots.push({ id: code + '-' + start, town: t.n, lr: lr, xy: [p.cx, p.cy], mu: t.mu / cnt });
      }
    });

    // 高损失图斑高亮
    st.clPlots.forEach(function (p) {
      if (p.lr > 0.42) {
        var hp = map.toPx(p.xy[0], p.xy[1]);
        var hn = map.pxDot('plot', hp.x, hp.y, 4, { fill: '#f87171', stroke: 'rgba(255,255,255,.8)', sw: 1.1 });
        map.anchor(hn, p.xy[0], p.xy[1]);
      }
    });

    // 乡镇标注（屏幕像素）——窄屏时跳过，避免标注堆叠重叠
    towns.forEach(function (t) {
      var group = st.clPlots.filter(function (p) { return p.town === t.n; });
      if (!group.length) return;
      var cx = group.reduce(function (a, p) { return a + p.xy[0]; }, 0) / group.length;
      var cy = group.reduce(function (a, p) { return a + p.xy[1]; }, 0) / group.length;
      var col = lossColor(t.loss);
      var sp = map.toPx(cx, cy);
      var lt2 = map.pxLabel('lab', sp.x, sp.y - 13, t.n + ' ' + (t.loss * 100).toFixed(0) + '%', {
        fill: 'rgb(' + col[0] + ',' + col[1] + ',' + col[2] + ')', size: 11.5, halo: '#1c1408', haloW: 4.2
      });
      // 标记为可选标注：由引擎按当前容器宽度统一显隐
      map.anchor(lt2, cx, cy, -13, null, true);
    });

    map.fit(cty.b);

    $('#cl-title').textContent = c.name + ' · ' + c.crop + c.disaster + '定损图斑';
    $('#cl-stats').innerHTML =
      kv('承保面积', fmt(c.areaMu, 0) + ' 亩') +
      kv('出险面积', fmt(c.claimMu, 0) + ' 亩') +
      kv('损失率', (c.lossRate * 100).toFixed(0) + '%') +
      kv('受灾农户', fmt(c.households, 0) + ' 户') +
      kv('平均亩均损失', fmt(c.avgLoss, 0) + ' 元/亩') +
      kv('定损进度', (c.done * 100).toFixed(0) + '%') +
      kv('影像来源', c.imagery) +
      kv('数据更新', c.updated);

    $('#cl-towns').innerHTML = towns.map(function (t) {
      var cls = t.st === '已定损' ? 'tag-green' : t.st === '核验中' ? 'tag-yellow' : t.st === '待查损' ? 'tag-orange' : 'tag-grey';
      var col = lossColor(t.loss);
      return '<div class="row" data-town="' + t.n + '"><div class="row-h">' +
        '<div class="row-t">' + t.n + '</div><span class="tag ' + cls + '">' + t.st + '</span></div>' +
        '<div class="row-m"><span>承保 <b>' + fmt(t.mu, 0) + ' 亩</b></span><span>出险 <b>' + fmt(t.claim, 0) + ' 亩</b></span>' +
        '<span style="color:rgb(' + col[0] + ',' + col[1] + ',' + col[2] + ')">损失率 <b>' + (t.loss * 100).toFixed(0) + '%</b></span></div>' +
        '<div class="bar"><i style="width:' + (t.loss * 100).toFixed(0) + '%;background:rgb(' + col[0] + ',' + col[1] + ',' + col[2] + ')"></i></div></div>';
    }).join('');
    $$('#cl-towns .row').forEach(function (el) {
      el.addEventListener('click', function () {
        var tn = el.dataset.town;
        var g = st.clPlots.filter(function (p) { return p.town === tn; });
        if (!g.length) return;
        var xs = g.map(function (p) { return p.xy[0]; }), ys = g.map(function (p) { return p.xy[1]; });
        var b = [Math.min.apply(null, xs), Math.min.apply(null, ys), Math.max.apply(null, xs), Math.max.apply(null, ys)];
        st.clMap.fit([b[0] - 12000, b[1] - 12000, b[2] + 12000, b[3] + 12000], true);
        $$('#cl-towns .row').forEach(function (r) { r.classList.toggle('on', r === el); });
      });
    });
  }

  function syncCL(code) {
    $$('#cl-counties .row').forEach(function (r) { r.classList.toggle('on', r.dataset.cd === code); });
  }

  function lossColor(t) {
    var stops = [[250, 204, 21], [251, 146, 60], [248, 113, 113], [190, 24, 93]];
    var i = Math.min(2, Math.floor(t * 3)), f = Math.max(0, Math.min(1, t * 3 - i));
    var a = stops[i], b = stops[i + 1];
    return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
  }

  function plotDetail(id) {
    var p = st.clPlots.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    var code = id.split('-')[0];
    var c = D.LOSS_CASES[code];
    var town = c.towns.filter(function (t) { return t.n === p.town; })[0] || {};
    var col = lossColor(p.lr);
    var grade = p.lr > .55 ? '重损' : p.lr > .35 ? '中损' : p.lr > .18 ? '轻损' : '微损';
    var est = (p.mu * c.avgLoss * (0.6 + p.lr)).toFixed(0);
    var html =
      '<div class="kv"><span>图斑编号</span><b>' + id + '</b></div>' +
      '<div class="kv"><span>所属乡镇</span><b>' + p.town + '</b></div>' +
      '<div class="kv"><span>作物</span><b>' + c.crop + '</b></div>' +
      '<div class="kv"><span>灾害类型</span><b>' + c.disaster + '</b></div>' +
      '<div class="kv"><span>图斑面积</span><b>' + p.mu.toFixed(1) + ' 亩</b></div>' +
      '<div class="kv"><span>损失程度</span><b style="color:rgb(' + col[0] + ',' + col[1] + ',' + col[2] + ')">' + grade + ' ' + (p.lr * 100).toFixed(0) + '%</b></div>' +
      '<div class="kv"><span>损失初估</span><b>' + fmt(est, 0) + ' 元</b></div>' +
      '<div class="dt-sub">证据链（可解释可追溯）</div>' +
      '<div class="note"><b>① 原始影像</b>：' + c.imagery + '<br>' +
      '<b>② 解译图斑</b>：AI 提取受灾范围，边界可回溯<br>' +
      '<b>③ 承保底图</b>：与保单地块空间叠加比对<br>' +
      '<b>④ 人工抽核</b>：查勘员现场确认</div>' +
      '<div class="note warn" style="margin-top:8px"><b>合规提示</b>：定损结论须可解释、可追溯；重大灾损应「遥感初筛 + 人工抽核」，避免全自动误判引发争议。</div>';
    detail('定损图斑 ' + id, p.town + ' · ' + c.crop + c.disaster + ' · 模拟测算', html);
  }

  /* ============================================================
     视图 3 · 灾害预警与调度
     ============================================================ */
  function buildWarn() {
    var map = new GeoCanvas($('#map-wn'), {
      onPick: function (p) {
        if (p.kind === 'task') taskDetail(p.id);
      },
      onView: function (v) { $('#wn-coord').textContent = v.lng.toFixed(2) + '°E  ' + v.lat.toFixed(2) + '°N'; }
    });
    map.layer('base', 1); map.layer('cover', 2); map.pxLayer('warn', 3); map.pxLayer('lab', 4);
    st.wnMap = map;

    var hb = GEO.provinces.filter(function (p) { return p.c === 420000; })[0];
    var hbB = G.ringsBBox(hb.r);
    map.area('base', hb, { fill: 'rgba(59,130,246,.05)', stroke: 'rgba(96,165,250,.42)', strokeWidth: 1.2 });
    GEO.cities.forEach(function (c) { map.area('base', c, { fill: 'rgba(120,160,220,.03)', stroke: 'rgba(120,160,220,.16)', strokeWidth: .8 }); });

    // 预警影响范围（屏幕像素同心圈，视觉大小不随缩放失控）
    var rnd = D.mulberry32(20260708);
    var cityCent = {};
    GEO.cities.forEach(function (c) { cityCent[c.n] = G.polyCentroid(c.r); });

    st.warnTasks = [];
    D.WARN_TASKS.forEach(function (t) {
      var cc = cityCent[t.city]; if (!cc) return;
      var colorMap = { '红色': '#f87171', '橙色': '#fb923c', '黄色': '#facc15', '蓝色': '#60a5fa' };
      var col = colorMap[t.level] || '#60a5fa';
      var p = map.toPx(cc[0], cc[1]);
      // 影响范围：外圈虚线 + 内部淡填充
      var R0 = 58 + rnd() * 26;
      var a1 = map.pxDot('warn', p.x, p.y, R0, { fill: col, opacity: .10 });
      var a2 = map.pxRing('warn', p.x, p.y, R0, { stroke: col, sw: 1.8, dash: '6,4', opacity: .9 });
      var a3 = map.pxDot('warn', p.x, p.y, 6.5, { fill: col, stroke: 'rgba(7,13,24,.9)', sw: 1.5 },
        { id: t.id, kind: 'task', title: t.type + t.level + '预警 · ' + t.city });
      var a4 = map.pxRing('warn', p.x, p.y, 13, { stroke: col, sw: 1.2, opacity: .55 });
      var a5 = map.pxLabel('lab', p.x, p.y - R0 - 9, t.city + ' · ' + t.level, { fill: col, size: 11.5, halo: '#1c1408', haloW: 4.2 });
      map.anchor(a3, cc[0], cc[1], 0, [a1, a2, a4]);
      map.anchor(a5, cc[0], cc[1], -(R0 + 9), null, true, 620);
      st.warnTasks.push(t);
    });

    map.fit(hbB);

    // 预警卡片
    $('#wn-list').innerHTML = D.WARN_TASKS.map(function (t) {
      var cls = { '红色': 'tag-red', '橙色': 'tag-orange', '黄色': 'tag-yellow', '蓝色': 'tag-blue' }[t.level];
      var sCls = t.status === '处置中' ? 'tag-orange' : t.status === '已响应' ? 'tag-blue' : 'tag-green';
      return '<div class="row" data-wid="' + t.id + '"><div class="row-h">' +
        '<div class="row-t">' + t.type + '预警 · ' + t.city + '</div>' +
        '<span class="tag ' + cls + '">' + t.level + '</span></div>' +
        '<div class="row-m"><span>' + t.area + '</span></div>' +
        '<div class="row-m"><span>受影响 <b>' + fmt(t.farmers, 0) + ' 户</b></span><span>涉及 <b>' + fmt(t.mu, 0) + ' 亩</b></span>' +
        '<span class="tag ' + sCls + '">' + t.status + '</span></div></div>';
    }).join('');
    $$('#wn-list .row').forEach(function (el) {
      el.addEventListener('click', function () {
        $$('#wn-list .row').forEach(function (r) { r.classList.toggle('on', r === el); });
        taskDetail(el.dataset.wid);
      });
    });

    // 预警类型（对接中国气象局预警分类）
    $('#wn-types').innerHTML = D.WARN_TYPES.map(function (t) {
      var cls = { '红色': 'tag-red', '橙色': 'tag-orange', '黄色': 'tag-yellow', '蓝色': 'tag-blue' }[t.level];
      return '<div class="row" style="cursor:default"><div class="row-h">' +
        '<div class="row-t">' + t.name + '</div><span class="tag ' + cls + '">' + t.level + '</span></div></div>';
    }).join('');

    $('#wn-flow').innerHTML = [
      { n: '01', t: '预警接收', d: '对接气象部门 14 类气象预警 + 台风实时路径' },
      { n: '02', t: '影响面匹配', d: '预警落区 × 承保地块空间叠加，秒级算出受影响保单' },
      { n: '03', t: '分级推送', d: '按灾害等级与保额分级推送农户与协保员' },
      { n: '04', t: '减损跟踪', d: '记录转移避险与防灾减损行动，形成闭环证据' }
    ].map(function (f) {
      return '<div class="fl"><div class="fl-n">' + f.n + '</div><div class="fl-t">' + f.t + '</div><div class="fl-d">' + f.d + '</div></div>';
    }).join('');
  }

  function taskDetail(id) {
    var t = D.WARN_TASKS.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    var cls = { '红色': 'tag-red', '橙色': 'tag-orange', '黄色': 'tag-yellow', '蓝色': 'tag-blue' }[t.level];
    var est = fmt(t.mu * 720, 0);
    var html =
      '<div style="display:flex;gap:7px;margin-bottom:11px;flex-wrap:wrap">' +
      '<span class="tag ' + cls + '">' + t.level + '预警</span>' +
      '<span class="tag tag-grey">' + t.type + '</span>' +
      '<span class="tag ' + (t.status === '已闭环' ? 'tag-green' : 'tag-orange') + '">' + t.status + '</span></div>' +
      kv('预警编号', t.id) +
      kv('发布单位', t.src) +
      kv('发布时间', t.time) +
      kv('影响区域', t.area) +
      kv('受影响农户', fmt(t.farmers, 0) + ' 户') +
      kv('涉及面积', fmt(t.mu, 0) + ' 亩') +
      kv('风险敞口初估', est + ' 元') +
      '<div class="dt-sub">处置建议（防灾减损前置）</div>' +
      '<div class="note warn"><b>' + t.suggest + '</b></div>' +
      '<div class="dt-sub">已执行动作</div>' +
      '<ul style="margin:0;padding-left:18px;font-size:12px;color:var(--txt-2);line-height:1.85">' +
      t.actions.map(function (a) { return '<li>' + a + '</li>'; }).join('') + '</ul>' +
      '<div class="note" style="margin-top:11px"><b>能力归属说明</b>：预警接收与推送能力对应阳光财险<b>「阳光天眼风险地图平台」</b>公开口径（位置智能 + 灾害大数据，含气象预警对接与台风路径）；3S 遥感与 AI 定损能力对应<b>「向日葵农险」平台</b>，两者分属不同产品线。</div>';
    detail(t.type + t.level + '预警', t.city + ' · ' + t.id, html);
  }

  /* ============================================================
     视图 4 · 灾情损失评估
     ============================================================ */
  function buildAssess() {
    $('#as-precision').innerHTML = D.PRECISION.items.map(function (p) {
      return '<div class="row" style="cursor:default"><div class="row-h">' +
        '<div class="row-t" style="font-size:12.5px">' + p.name + '</div>' +
        '<span class="tag tag-blue">' + p.val + '</span></div>' +
        '<div class="row-m"><span>' + p.src + '</span></div></div>';
    }).join('');

    $('#as-std').innerHTML = D.PRECISION.standards.map(function (s) {
      return kv(s.name, s.date);
    }).join('');

    $('#as-comp').innerHTML = D.PRECISION.compliance.map(function (c) {
      return '<div class="note warn" style="margin-bottom:7px">' + c + '</div>';
    }).join('');

    // 损失评估对比（定损周期 / 成本）
    $('#as-cmp').innerHTML = [
      { n: '定损周期', a: '15 天', b: '7 天', p: 53 },
      { n: '查勘人力', a: '100%', b: '60%', p: 40 },
      { n: '单亩定损成本', a: '100%', b: '65%', p: 35 }
    ].map(function (r) {
      return '<div class="hbar"><div class="hbar-n">' + r.n + '</div>' +
        '<div class="hbar-t"><i style="width:' + r.p + '%;background:linear-gradient(90deg,#34d399,#22d3ee)"></i></div>' +
        '<div class="hbar-v">' + r.a + '→' + r.b + '</div></div>';
    }).join('');

    // 各县损失构成
    var rows = Object.keys(D.LOSS_CASES).map(function (k) {
      var c = D.LOSS_CASES[k];
      return '<tr><td><b>' + c.name + '</b></td><td>' + c.crop + '</td><td>' + c.disaster + '</td>' +
        '<td>' + fmt(c.areaMu, 0) + '</td><td>' + fmt(c.claimMu, 0) + '</td>' +
        '<td style="color:' + (c.lossRate > .4 ? '#f87171' : '#fb923c') + '"><b>' + (c.lossRate * 100).toFixed(0) + '%</b></td>' +
        '<td>' + fmt(c.claimMu * c.avgLoss / 10000, 0) + ' 万</td></tr>';
    }).join('');
    $('#as-table tbody').innerHTML = rows;

    // 减损闭环（真实案例锚点）
    $('#as-case').innerHTML =
      '<div class="note"><b>2024 年汛期 · 湖北分公司</b><br>' +
      '经预警平台预警，协助 <b>18 户养殖户</b>提前转移物资，减少经济损失<b>超 200 万元</b>。<br>' +
      '<span style="color:var(--txt-3)">（此为阳光财险公开报道口径，用于说明风险减量业务价值）</span></div>';

    $('#as-dims').innerHTML = D.RISK_DIMS.map(function (d) {
      return '<div class="hbar"><div class="hbar-n">' + d.n + '</div>' +
        '<div class="hbar-t"><i style="width:' + (d.w * 300).toFixed(0) + '%;background:linear-gradient(90deg,#a78bfa,#3b82f6)"></i></div>' +
        '<div class="hbar-v">' + (d.w * 100).toFixed(0) + '%</div></div>';
    }).join('') +
      '<div class="note" style="margin-top:10px">' + D.RISK_DIMS.map(function (d) { return d.n + '（' + d.d + '）'; }).join(' · ') + '</div>';
  }

  /* ============================================================
     路由
     ============================================================ */
  var built = {};
  /* ---------- 加载反馈 ----------
     实测：切换「全国遥感地图」耗时 2186ms、「灾情损失评估」2009ms，
     期间界面完全静止、无任何提示，用户会以为卡死或重复点击。
     这里加一个顶部细进度条 + 极简文案，>250ms 才显示（避免快速切换闪烁），
     操作完成或超上限自动消失。用 rAF 驱动、不阻塞交互。 */
  /* 说明：busyOff 的延后时间必须 > busyOn 的显示阈值（250ms），
     否则慢视图会「先关后开」，加载条一次都不显示（实测始终 on=false）。 */
  var busyDepth = 0, busyTimer = null, busyShown = false, busyT0 = 0;
  function busyEl() {
    var el = document.getElementById('busybar');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'busybar';
    // ⚠️ 必须用 createElement 逐个建子节点：innerHTML 字符串里若含 <i>/<span>，
    //    某些情况下 querySelector 会拿到字符串而非元素，
    //    随后 set textContent 就报 "Cannot create property on string"。
    var bar = document.createElement('i');
    var txt = document.createElement('span');
    el.appendChild(bar); el.appendChild(txt);
    document.body.appendChild(el);
    return el;
  }
  function busyOn(label) {
    busyDepth++;
    var el = busyEl();
    var sp = el.children[1];
    if (sp && sp.textContent !== label) sp.textContent = label || '加载中';
    if (busyShown) return;
    clearTimeout(busyTimer);
    busyTimer = setTimeout(function () {
      busyShown = true; busyT0 = Date.now();
      var e = document.getElementById('busybar');
      if (e) e.classList.add('on');
    }, 250);
  }
  function busyOff() {
    busyDepth = Math.max(0, busyDepth - 1);
    if (busyDepth > 0) return;
    clearTimeout(busyTimer);
    var e = document.getElementById('busybar');
    if (!e) { busyShown = false; return; }
    // 已显示 → 留一点驻留时间让用户看清，再淡出；未显示 → 直接复位
    if (busyShown) {
      clearTimeout(busyTimer);
      busyTimer = setTimeout(function () {
        e.classList.remove('on'); busyShown = false;
      }, 320);
    } else { busyShown = false; }
  }
  /* 兜底：任何情况下最多显示 6 秒，绝不留下"永远转圈"的界面 */
  setInterval(function () {
    var e = document.getElementById('busybar');
    if (e && e.classList.contains('on') && busyShown && busyT0 &&
        Date.now() - busyT0 > 6000) {
      e.classList.remove('on'); busyShown = false; busyDepth = 0; busyT0 = 0;
    }
  }, 1000);
  window.__BUSY__ = { on: busyOn, off: busyOff };

  var TAB_LABEL = {
    national: '正在加载全国遥感地图…', qual: '正在加载资质资格分布…',
    overview: '正在汇总全国农险总览…', underwrite: '正在加载承保风险数据…',
    uw: '正在准备承保信息上传…', claims: '正在加载理赔定损数据…',
    warn: '正在加载预警调度…', assess: '正在加载灾情评估…'
  };
  var TAB_TITLE = {
    national: '全国遥感地图', qual: '资质资格地图', overview: '总览驾驶舱',
    underwrite: '承保风险地图', uw: '承保信息上传', claims: '理赔定损地图',
    warn: '预警与调度', assess: '灾情损失评估'
  };

  function switchTab(key) {
    $$('.tab').forEach(function (t) {
      var on = t.dataset.tab === key;
      t.classList.toggle('on', on);
      // ARIA 状态同步，供读屏软件正确播报"当前选中第几个标签"
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.setAttribute('tabindex', on ? '0' : '-1');
    });
    $$('.view').forEach(function (v) { v.classList.toggle('on', v.id === 'v-' + key); });
    /* 标签切换时更新浏览器标题；地图视图随后会再由 paintCrumb 细化为具体层级 */
    try { document.title = (TAB_TITLE[key] || '') + ' · 阳光3S遥感平台（测试版）'; } catch (e) { }
    busyOn(TAB_LABEL[key] || '加载中');
    var done = function () { setTimeout(busyOff, 120); };
    if (!built[key]) {
      built[key] = true;
      var FNS = { overview: buildOverview, underwrite: buildUnderwrite, claims: buildClaims,
                  warn: buildWarn, assess: buildAssess, national: function () { window.__NAT_VIEW__.init(); },
                  qual: function () { window.__QUAL_VIEW__.init(); },
                  uw: function () { window.__UW_VIEW__.init(); } };
      (FNS[key] || function () { })();
    }
    // 视图已 display:block，容器此时才有真实尺寸 —— 重新测量并重绘
    var MAPS = { overview: 'ovMap', underwrite: 'uwMap', claims: 'clMap', warn: 'wnMap' };
    if (key === 'national' && window.__NAT_VIEW__) { window.__NAT_VIEW__.render(); setTimeout(done, 700); return; }
    if (key === 'qual' && window.__QUAL_VIEW__) { window.__QUAL_VIEW__.render(); setTimeout(done, 500); return; }
    if (key === 'uw' && window.__UW_VIEW__) {
      // 承保视图已构建过也要重绘：容器从 display:none 恢复后尺寸才真实
      setTimeout(function () { window.__UW_VIEW__.init(); done(); }, 40);
      return;
    }
    var slot = MAPS[key];
    setTimeout(function () {
      var m = slot && st[slot];
      if (m && m.resize) {
        m.resize();
        if (m._fullBBox) m.fit(m._fullBBox);
      }
      done();
    }, 40);
    try { location.hash = key; } catch (e) { }
  }
  /* 标签页键盘可达：标签已改为 <button role="tab">，此处补
     ① 点击（含回车/空格，button 原生支持）
     ② 左右方向键在标签间移动焦点并即时切换（WAI-ARIA Tabs 模式）
     ③ Home/End 跳到首/末 —— 此前实测「回车激活切换 national→national ❌」，
        因为标签原是 <div>，天然不可键盘激活。 */
  var tabEls = $$('.tab');
  function focusTab(i) {
    var n = tabEls.length;
    if (!n) return;
    var k = (i + n) % n;
    tabEls[k].focus();
    switchTab(tabEls[k].dataset.tab);
  }
  tabEls.forEach(function (t, i) {
    t.addEventListener('click', function () { switchTab(t.dataset.tab); });
    t.addEventListener('keydown', function (e) {
      var k = e.key;
      if (k === 'ArrowRight') { e.preventDefault(); focusTab(i + 1); }
      else if (k === 'ArrowLeft') { e.preventDefault(); focusTab(i - 1); }
      else if (k === 'Home') { e.preventDefault(); focusTab(0); }
      else if (k === 'End') { e.preventDefault(); focusTab(tabEls.length - 1); }
      else if (k === 'Enter' || k === ' ') { e.preventDefault(); switchTab(t.dataset.tab); }
    });
  });
  $$('[data-goto]').forEach(function (b) { b.addEventListener('click', function () { switchTab(b.dataset.goto); }); });

  window.addEventListener('resize', function () {
    Object.keys(st).forEach(function (k) { if (st[k] && st[k].resize) st[k].resize(); });
    if (window.__NAT_VIEW__) window.__NAT_VIEW__.render();
    if (window.__QUAL_VIEW__) window.__QUAL_VIEW__.render();
  });

  // ticker
  $('#ticker-c').innerHTML = '<div>' + [
    '湖北 17 市纳入承保风险地图 · 3 个重点县下钻到地块级',
    '4 类定损图斑引擎就绪 · 已生成 ' + (Object.keys(D.LOSS_CASES).length) + ' 个县定损场景',
    '气象预警 8 类在监控中 · 红色预警 1 条处置中',
    '「阳光天眼风险地图」预警 · 阳光3S遥感平台遥感定损，双核能力已接入'
  ].join('　|　') + '</div>';

  var initial = (location.hash || '').replace('#', '');
  var KEYS = ['national', 'qual', 'overview', 'underwrite', 'uw', 'claims', 'warn', 'assess'];
  switchTab(KEYS.indexOf(initial) >= 0 ? initial : 'national');

  // 暴露给测试
  window.__APP__ = { switchTab: switchTab, st: st, D: D, GEO: GEO, detail: detail, closeDetail: closeDetail };
})();