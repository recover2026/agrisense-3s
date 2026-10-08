/* ============================================================
   AgriSense 3S · 阳光农险资质与政策性资格地区地图
   数据来源:专家包 08库 11类《01-阳光农险资质与政策性农险资格地区台账》
   基准 2026-08-14 | 内部脱敏:仅含区域资格标记与机构层级
   ============================================================ */
(function () {
  'use strict';

  /* 性能优化：资质资格台账（246KB）首屏用不到，已从 index.html 移除同步引入，
     改为首次进入「资质资格地图」视图时按需加载。
     故此处不能直接取 window.__QUAL__（此刻尚未加载），改为惰性 getter。*/
  var GP = window.__GEO_PROV__;
  var DM = window.DualMap;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* 惰性数据容器：真实数据到达前，属性访问返回 undefined（等价于"没数据"），
     到达后被完整填充。因果调用点无需改动，只在 ensureQual() 之后才有值。*/
  var Q = {};

  /* 懒加载资质数据（246KB，首屏用不到） */
  function ensureQual() {
    if (window.__QUAL_LOADED__) return Promise.resolve(Q);
    if (window.__QUAL_LAZY_P__) return window.__QUAL_LAZY_P__;
    window.__QUAL_LAZY_P__ = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'assets/data/sunshine-qualification.js';
      s.onload = function () {
        var d = window.__QUAL__ || {};
        for (var k in d) Q[k] = d[k];
        window.__QUAL_LOADED__ = true;
        res(Q);
      };
      s.onerror = function () { rej(new Error('资质数据加载失败')); };
      document.head.appendChild(s);
    });
    return window.__QUAL_LAZY_P__;
  }

  var MI = null;          // 本视图的 DualMap 实例
  var N = {
    level: 'country', curProvince: null,
    mode: 'all',        // all | qual | pol
    view: 'coverage',   // coverage | policy
    search: '',
    ready: false
  };
  window.__QUAL_VIEW__ = {
    init: init,
    render: function () { DM.resize(MI); },
    renderCountry: renderCountry,
    renderProvince: renderProvince,
    state: N
  };

  /* ---------- 索引 ---------- */
  var IDX = {};
  function buildIdx() {
   IDX = (function () {
    var qualByCode = {}, polByCode = {}, provQual = {}, provPol = {};
    var qAll = Q.qual || [], pAll = Q.pol || [];
    function pk(s) { return String(s||'').replace(/维吾尔|壮族|回族|自治区|特别行政区|省|市/g, ''); }
    // 台账含开发区/管委会/乡镇级条目，无对应县级行政要素（c 为空），
    // 这些记录保留在总数口径里（与台账一致），但不参与地图着色与搜索。
    var qMappable = qAll.filter(function (r) { return !!r.c; });
    var pMappable = pAll.filter(function (r) { return !!r.c; });
    qMappable.forEach(function (r) {
      if (!qualByCode[r.c]) qualByCode[r.c] = [];
      qualByCode[r.c].push(r);
      // 只用归一化名做 key：同时写入原名与归一化名会让 Object.keys 长度翻倍
      // （实测导致「覆盖 62 个省级行政区」，实际 32 省）
      var k = pk(r.p);
      provQual[k] = (provQual[k] || 0) + 1;
    });
    pMappable.forEach(function (r) {
      if (!polByCode[r.c]) polByCode[r.c] = { t: r.t, k: r.k, list: [] };
      polByCode[r.c].list.push(r);
      var k = pk(r.p);
      provPol[k] = (provPol[k] || 0) + 1;
    });
    return {
      qual: qAll, pol: pAll,          // 全量（与台账一致，用于总数展示）
      qualMappable: qMappable, polMappable: pMappable,   // 有 adcode 的（用于着色/搜索）
      qualByCode: qualByCode, polByCode: polByCode,
      provQual: provQual, provPol: provPol,
      qualCodes: Object.keys(qualByCode),
      polCodes: Object.keys(polByCode),
      allCodes: Object.keys(qualByCode).concat(Object.keys(polByCode).filter(function (c) { return !qualByCode[c]; }))
    };
   })();
   return IDX;
  }
  buildIdx();     // 数据若已就绪则立即建立；未就绪时先建空索引，加载后再建

  function hasQual(c) { return !!IDX.qualByCode[c]; }
  function hasPol(c) { return !!IDX.polByCode[c]; }

  // 省级 code 反查（台账省名 → adcode）
  var PROV_CODE = (function () {
    var m = {};
    (GP.provinces || []).forEach(function (p) { m[p.n.replace(/省|市|自治区|特别行政区|维吾尔|壮族|回族/g, '')] = p.c; });
    var alias = {
      '内蒙古': 150000, '广西': 450000, '西藏': 540000, '宁夏': 640000, '新疆': 650000,
      '黑龙江': 230000, '海南': 460000, '大连': 210000, '宁波': 330000, '青岛': 370000, '深圳': 440000
    };
    Object.keys(alias).forEach(function (k) { m[k] = alias[k]; });
    return m;
  })();


/* ---------- 首屏渲染调度 ----------
   视图 init 时容器可能尚未获得真实尺寸（display:none 或布局未完成），
   此时 fit() 会直接 return，导致地图空白且不再重试。
   这里统一：等待容器就绪 → 渲染 → 校验图元数，失败则重试（最多 6 次）。 */
  function renderWhenReady(view, drawFn, hostSel, probeSel) {
    var tries = 0;
    (function attempt() {
      tries++;
      var MIx = view && view.MI;
      var host = MIx && MIx.svg && MIx.svg.host;
      var ok = MIx && MIx.svg && MIx.svg._vw > 50 && MIx.svg._vh > 50;
      if (ok) {
        try { drawFn(); } catch (e) { ok = false; }
      }
      if (ok) {
        if (probeSel) {
          var n = document.querySelectorAll(probeSel).length;
          if (n > 0) return;         // 已画出内容
        } else return;
      }
      if (tries < 6) setTimeout(attempt, 260);
    })();
  }

  /* ---------- 初始化 ---------- */
  // 台账省名带后缀（"湖北省"），PROV_CODE 的 key 已去后缀（"湖北"），
  // 点击下钻时必须归一化后再查，否则匹配不到
  function provCodeOf(name) {
    if (!name) return null;
    if (PROV_CODE[name]) return PROV_CODE[name];
    var key = String(name).replace(/维吾尔|壮族|回族|自治区|特别行政区|省|市/g, '');
    return PROV_CODE[key] || null;
  }

  function init() {
    var host = $('#qual-map');
    if (!host) return;

    /* 性能优化：资质台账改为懒加载 —— 先确保数据到位，再建索引与面板，
       否则各面板会拿到空数据渲染成"0 条"。*/
    ensureQual().then(function () {
      buildIdx();
      buildKPI(); buildProvRank(); buildTypePanel(); buildInsurerPanel(); bindUI();
      renderCountry();
    }).catch(function (e) {
      if (window.console) console.warn('[资质资格] 数据加载失败', e);
    });

    MI = DM.init(host, {
      center: { lat: 34.0, lng: 106.0 }, zoom: 4,
      onPick: function (p) {
        if (p.kind === 'prov') { renderProvince(p.id); }
        else if (p.kind === 'county') { countyDetail(p.id); }
      },
      onEngine: function (e) { setEngine(e.ok, e.label); renderCountry(); },
      onHome: function () { renderCountry(); },
      onTilesOk: function () { setEngine(true, '卫星影像底图 · 腾讯位置服务'); },
      onTilesFail: function () { setEngine(false, '矢量底图 · 卫星影像待配置 KEY'); }
    });
    MI.svg.onViewChange = null;
    window.__QUAL_VIEW__.MI = MI;   // 供 renderWhenReady 访问

    var back = $('#qual-back');
    if (back) back.addEventListener('click', function () { renderCountry(); });

    // 等容器就绪后再首屏渲染（避免 fit 因尺寸为 0 而空白）
    window.__QUAL_VIEW__.renderCountry = renderCountry;
    renderWhenReady(window.__QUAL_VIEW__, function () { if (!N.ready || !document.querySelectorAll('#qual-map path.gs-area').length) renderCountry(); },
                    '#qual-map', '#qual-map path.gs-area');
  }

  /* ---------- 全国：按省聚合显示 ---------- */
  function renderCountry() {
    N.level = 'country'; N.curProvince = null; N.ready = true;
    $('#qual-title').textContent = '全国农险经营资质与政策性资格分布';
    $('#qual-scope').textContent = '全国 · ' + (GP.provinces || []).length + ' 省';

    DM.clearLayer(MI, 'base'); DM.clearBIZ(MI, ); DM.clearLayer(MI, 'lab'); DM.clearLayer(MI, 'risk');
    var st = MI.svg;
    if (st) st.pxAnchors = [];

    var bbox = null, placed = [];
    (GP.provinces || []).forEach(function (p) {
      var pk = p.n.replace(/省|市|自治区|特别行政区|维吾尔|壮族|回族/g, '');
      var q = IDX.provQual[shortProv(p.n)] || IDX.provQual[pk] || 0;
      var g = IDX.provPol[shortProv(p.n)]  || IDX.provPol[pk]  || 0;
      var col = provColor(q, g);
      var rgb = col.match(/\d+/g);
      var has = q > 0 || g > 0;
      DM.area(MI, { n: p.n, c: p.c, kind: 'prov', r: absOf(p) }, {
        fill: 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + (has ? .62 : .14) + ')',
        stroke: has ? 'rgba(255,255,255,.9)' : 'rgba(120,150,190,.28)',
        strokeWidth: has ? 1.5 : .9
      });
      var b = aboxOf(p);
      bbox = bbox ? [Math.min(bbox[0],b[0]),Math.min(bbox[1],b[1]),Math.max(bbox[2],b[2]),Math.max(bbox[3],b[3])] : b.slice();
    });

    // 省名 + 数量标注
    if (st && st._vw > 620) {
      (GP.provinces || []).slice().sort(function (a, b) {
        var ab = (aboxOf(b)[2]-aboxOf(b)[0]) * (aboxOf(b)[3]-aboxOf(b)[1]);
        var aa = (aboxOf(a)[2]-aboxOf(a)[0]) * (aboxOf(a)[3]-aboxOf(a)[1]);
        return bb2(ab) - bb2(aa);
      }).forEach(function (p) {
        var pk = p.n.replace(/省|市|自治区|特别行政区|维吾尔|壮族|回族/g, '');
        var q = IDX.provQual[shortProv(p.n)] || IDX.provQual[pk] || 0;
        var g = IDX.provPol[shortProv(p.n)]  || IDX.provPol[pk]  || 0;
        if (!q && !g) return;
        var ct = G.polyCentroid(absOf(p));
        var px = st.toPx(ct[0], ct[1]);
        var hit = false;
        for (var i = 0; i < placed.length; i++) {
          var dx = placed[i][0] - px.x, dy = placed[i][1] - px.y;
          if (dx*dx + dy*dy < 78*78) { hit = true; break; }
        }
        if (hit) return;
        placed.push([px.x, px.y]);
        var short = p.n.replace(/维吾尔|壮族|回族|自治区|特别行政区|省|市/g, '');
        var txt = q >= 100 ? short : short + ' ' + q + (g ? '/' + g : '');
        var el = DM.pxLabel(MI, 'lab', px.x, px.y, txt, { fill:'#fff', size:10.5, halo:'rgba(3,8,18,.96)' });
        if (el) DM.anchor(MI, el, ct[0], ct[1], 0, null, true, 620);
      });
    }

    DM.fit(MI, bbox);
  }
  function bb2(x) { return x; }

  /* 省级配色：政策性资格占比越高越金黄 */
  function provColor(q, g) {
    if (!q && !g) return 'rgb(56,74,96)';
    if (!g) return 'rgb(59,130,246)';            // 仅农险资质：蓝
    var r = g / q;                                 // 政策占比
    if (r >= .6) return 'rgb(255,211,90)';         // 政策为主：金
    if (r >= .3) return 'rgb(251,146,60)';         // 兼有：橙
    return 'rgb(250,204,21)';                      // 政策少量：黄
  }

  /* ---------- 县级边界：按省按需加载 ---------- */
  var KB = window.__KB__ || {};              // 已加载的县界（码 → 边界）
  var KB_IDX = window.__KBI__ || [];
  var kbLoading = {};
  var kbHas = {};

  function kbOf(code) { return KB[String(code)] || null; }

  function loadCountyOf(provCode, cb) {
    var pc = String(provCode).slice(0, 2);
    var meta = KB_IDX.filter(function (x) { return x.p === pc; })[0];
    if (!meta) return cb(false);

    // 该省已有县界 → 直接回调（避免重复请求）
    if (kbHas[pc]) return cb(true);

    // 正在加载 → 挂入等待队列，不要提前回调（否则会画不出县界）
    if (kbLoading[pc]) { kbLoading[pc].push(cb); return; }

    kbLoading[pc] = [cb];
    var s = document.createElement('script');
    s.src = 'assets/data/' + meta.f;
    s.onload = function () {
      var d = window.__KBP__;
      try { delete window.__KBP__; } catch (e) { window.__KBP__ = null; }
      if (d) { for (var k in d) KB[k] = d[k]; kbHas[pc] = true; }
      var list = kbLoading[pc] || [];
      kbLoading[pc] = null;
      list.forEach(function (f) { f(!!d); });
    };
    s.onerror = function () {
      var list = kbLoading[pc] || [];
      kbLoading[pc] = null;
      list.forEach(function (f) { f(false); });
    };
    document.head.appendChild(s);
  }

  /* ---------- 省级下钻：县区级 ---------- */
  function renderProvince(pcode) {
    N.level = 'province'; N.curProvince = pcode;
    var pv = (GP.provinces || []).filter(function (p) { return String(p.c) === String(pcode); })[0];
    if (!pv) return;
    var sk = shortProv(pv.n);
    var q = IDX.provQual[shortProv(pv.n)] || IDX.provQual[sk] || 0;
    var g = IDX.provPol[shortProv(pv.n)]  || IDX.provPol[sk]  || 0;
    $('#qual-title').textContent = pv.n + ' · 资质县区分布';
    $('#qual-scope').textContent = '农险资质 ' + q + ' 县区 / 政策性资格 ' + g + ' 县区 · 加载县界…';
    // 先画出省界 + 散点（秒出），县界加载完再重绘
    drawCounties(pv);
    loadCountyOf(pcode, function () { drawCounties(pv); });
  }

  function shortProv(n) {
    return String(n || '').replace(/维吾尔|壮族|回族|自治区|特别行政区|省|市/g, '');
  }

  function drawCounties(pv) {
    var st = MI.svg; if (!st) return;
    DM.clearLayer(MI, 'base'); DM.clearBIZ(MI, ); DM.clearLayer(MI, 'lab'); DM.clearLayer(MI, 'risk');
    // 省界（深色底衬托县界）
    DM.area(MI, { n: pv.n, c: pv.c, r: absOf(pv) },
      { fill: 'rgba(9,16,29,.72)', stroke: 'rgba(96,165,250,.85)', strokeWidth: 1.8 });

    var bbox = aboxOf(pv);
    var drawn = 0, points = [];

    // 1) 有精确县界的 → 画真实面
    IDX.allCodes.forEach(function (code) {
      if (!startsWith(code, pv.c)) return;
      var k = KB[code];
      if (!k || !k.r || !k.r.length) return;
      var cq = IDX.qualByCode[code], cp = IDX.polByCode[code];
      var col = (cq && cp) ? 'rgb(255,211,90)' : cp ? 'rgb(250,204,21)' : 'rgb(59,130,246)';
      var rgb = col.match(/\d+/g);
      var rings = k.r.map(function (r) {
        return r.map(function (p) { return [p[0] + k.b[0], p[1] + k.b[1]]; });
      });
      DM.area(MI, { n: k.n, c: code, kind: 'county', r: rings }, {
        fill: 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',.72)',
        stroke: 'rgba(255,255,255,.92)', strokeWidth: 1.2
      });
      var b = [k.b[0], k.b[1], k.b[0] + (k.w != null ? k.w : k.b[2]-k.b[0]), k.b[1] + (k.h != null ? k.h : k.b[3]-k.b[1])];
      bbox = union(bbox, b);
      drawn++;
    });

    // 2) 无县界的 → 在省内按 code 稳定散点（保证不遗漏）
    var miss = [];
    IDX.allCodes.forEach(function (code) {
      if (!startsWith(code, pv.c)) return;
      if (KB[code] && KB[code].r && KB[code].r.length) return;
      miss.push(code);
    });
    if (miss.length) drawScatter(pv, miss);

    // 县名标注（有边界且空间允许）
    if (drawn && st._vw > 700) {
      var placed = [];
      Object.keys(KB).forEach(function (code) {
        if (!startsWith(code, pv.c)) return;
        var k = KB[code]; if (!k || !k.r || !k.r.length) return;
        var rings = k.r.map(function (r) {
          return r.map(function (p) { return [p[0] + k.b[0], p[1] + k.b[1]]; });
        });
        var ct = G.polyCentroid(rings);
        var px = st.toPx(ct[0], ct[1]);
        var hit = false;
        for (var i = 0; i < placed.length; i++) {
          var dx = placed[i][0]-px.x, dy = placed[i][1]-px.y;
          if (dx*dx + dy*dy < 56*56) { hit = true; break; }
        }
        if (hit) return;
        placed.push([px.x, px.y]);
        var isPol = !!IDX.polByCode[code];
        var el = DM.pxLabel(MI, 'lab', px.x, px.y, k.n, {
          fill: isPol ? '#ffd35a' : '#cfe0f5', size: 10, halo:'rgba(3,8,18,.96)'
        });
        if (el) DM.anchor(MI, el, ct[0], ct[1], 0, null, true, 700);
      });
    }

    DM.fit(MI, bbox);
    $('#qual-scope').textContent = '农险资质 ' + (IDX.provQual[shortProv(pv.n)]||IDX.provQual[shortProv(pv.n)]||0) +
      ' / 政策性 ' + (IDX.provPol[shortProv(pv.n)]||IDX.provPol[shortProv(pv.n)]||0) +
      ' · 已绘县界 ' + drawn + (miss.length ? ' · 点位 ' + miss.length : '');
  }

  function union(a, b) {
    return [Math.min(a[0],b[0]), Math.min(a[1],b[1]), Math.max(a[2],b[2]), Math.max(a[3],b[3])];
  }

  /* 无精确边界时的稳定散点（按 adcode 哈希在省内定位） */
  function drawScatter(pv, codes) {
    var st = MI.svg; if (!st) return;
    var b = aboxOf(pv);
    DM.fit(MI, b);
    var cs = G.polyCentroid(absOf(pv));
    codes.forEach(function (code) {
      var h = 0, s = String(code);
      for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
      var rx = ((h % 10000) / 10000 - .5);
      var ry = (((h >> 13) % 10000) / 10000 - .5);
      var x = cs[0] + rx * (b[2]-b[0]) * .78;
      var y = cs[1] + ry * (b[3]-b[1]) * .78;
      var px = st.toPx(x, y);
      var both = IDX.qualByCode[code] && IDX.polByCode[code];
      var onlyPol = IDX.polByCode[code];
      DM.pxDot(MI, 'risk', px.x, px.y, 5, {
        fill: both ? '#ffd35a' : onlyPol ? '#facc15' : '#3b82f6',
        stroke: 'rgba(7,13,24,.9)', sw: 1.3
      }, { kind: 'county', id: code, title: '点击查看资质详情' });
    });
  }

  // 县级 adcode 前2位为省码：421222 -> 42；省级 adcode 前2位同样是 42
  // 不能直接用 indexOf(省adcode)，因 421xxx 并不以 420000 开头
  function startsWith(code, pcode) {
    return String(code).slice(0, 2) === String(pcode).slice(0, 2);
  }
  function absOf(o) {
    if (o._abs) return o._abs;
    var b = o.b;
    o._abs = o.r.map(function (r) { return r.map(function (p) { return [p[0]+b[0], p[1]+b[1]]; }); });
    return o._abs;
  }
  function aboxOf(o) {
    var b = o.b;
    return [b[0], b[1], b[0] + (o.w!=null?o.w:b[2]-b[0]), b[1] + (o.h!=null?o.h:b[3]-b[1])];
  }

  /* ---------- 县区详情 ---------- */
  function countyDetail(code) {
    var q = IDX.qualByCode[code], p = IDX.polByCode[code];
    if (!q && !p) return;
    var q0 = q ? q[0] : null, p0 = p ? p.list[0] : null;
    var base = q0 || p0;
    var html = '';
    if (q) {
      html += '<div class="dt-sub">农险经营资质</div>';
      html += kv('区县', q0.n) + kv('所属省市', q0.p + ' / ' + q0.ct);
      html += kv('分公司', q0.o || '—');
      html += kv('中支公司', q0.z || '—');
      html += kv('支公司', q0.b || '—');
      if (q.length > 1) html += kv('机构记录数', q.length + ' 条');
    }
    if (p) {
      html += '<div class="dt-sub">政策性业务资格</div>';
      html += kv('资格类型', typeName(p.t));
      if (p.k) html += kv('具体落地险种', p.k);
      html += kv('区县', p0.n) + kv('所属省市', p0.p + ' / ' + p0.ct);
    }
    html += '<div class="dt-sub">业务含义</div>';
    html += '<div class="note">' + bizMeaning(!!q, !!p) + '</div>';
    html += '<div class="note warn" style="margin-top:8px"><b>数据基准</b>：2026-08-14 内部脱敏台账，仅含区域资格标记与机构层级，不含保费/赔付等经营数字。</div>';
    window.__APP__.detail((base.n || '') + ' · 资质详情', '阳光农险经营资质地图', html);
  }
  function typeName(t) {
    return t === 'I' ? '政策性农险统一遴选入围（含后备）'
      : t === 'J' ? '地方特色非遴选 / 中央政策性森林险单独遴选'
      : '两者兼具（统一遴选 + 地方特色/森林险）';
  }
  function bizMeaning(q, p) {
    if (p && q) return '<b>双资格地区</b>：既具备农险经营资质，又具备政策性业务资格，是政策性农险遴选与展业的<b>核心准入地区</b>，可在该地区参与统一遴选与地方特色险种投标。';
    if (p && !q) return '<b>政策性资格地区</b>：具备政策性业务资格，可参与该地区政策性农险遴选。';
    if (q && !p) return '<b>农险资质地区</b>：具备农险经营资质但无政策性业务资格，可开展商业性农险或以农险资质作为切入点。';
    return '—';
  }
  function kv(k, v) { return '<div class="kv"><span>' + k + '</span><b>' + (v==null?'':v) + '</b></div>'; }

  /* ---------- 面板 ---------- */
  function buildKPI() {
    var s = Q.stats || {};
    var qs = s.qualTotal || IDX.qual.length, ps = s.polTotal || IDX.pol.length;
    var pc = (GP.provinces||[]).length;
    var qprov = Object.keys(IDX.provQual).length, pprov = Object.keys(IDX.provPol).length;
    var st = Q.stats || {};
    var qMap = IDX.qualMappable.length, pMap = IDX.polMappable.length;
    $('#qual-kpi').innerHTML =
      kcard('农险经营资质记录', String(qs), '条', '覆盖 ' + qprov + ' 个省级行政区', '#3b82f6') +
      kcard('政策性业务资格记录', String(ps), '条', '覆盖 ' + pprov + ' 个省级行政区', '#ffd35a') +
      kcard('政策性占资质比', (ps/qs*100).toFixed(1), '%', '双资格为核心准入', '#34d399') +
      kcard('涉及省级行政区', String(pc), '个', '全国', '#fb923c');

    // 上图口径说明：台账含乡镇级/开发区/管委会条目，无对应县级行政要素
    var unmapped = (st.qualNone || 0) + (st.polNone || 0);
    var note = $('#qual-scope-note');
    if (!note) {
      note = document.createElement('div');
      note.id = 'qual-scope-note';
      note.className = 'note';
      var kp = $('#qual-kpi');
      if (kp && kp.parentNode) kp.parentNode.insertBefore(note, kp.nextSibling);
    }
    note.innerHTML =
      '<b>记录数与台账完全一致</b>（资质 ' + qs + ' 条 / 政策 ' + ps + ' 条）。' +
      '其中<b>可上图 ' + qMap + ' / ' + pMap + ' 条</b>' +
      '（匹配到县级行政区划的记录）；' +
      '另有 ' + (st.qualCity || 0) + ' + ' + (st.polCity || 0) + ' 条降级归属到所属市级辖区' +
      (unmapped ? '，<b>' + unmapped + ' 条</b>（开发区/管委会/乡镇等无对应县级行政要素）仅计入总数、不参与着色与检索。' : '。') +
      '数据基准 2026-08-14。';
  }
  function kcard(l, v, u, d, c) {
    return '<div class="kpi" style="--c:' + c + '"><div class="kpi-l">' + l + '</div>' +
      '<div class="kpi-v">' + v + '<small>' + u + '</small></div><div class="kpi-d">' + d + '</div></div>';
  }

  function buildProvRank() {
    var rows = (Q.byprov || []).slice().sort(function (a, b) { return b.g - a.g || b.q - a.q; });
    var tabs = [['g','政策性资格'],['q','农险资质']];
    $('#qual-rank-tabs').innerHTML = tabs.map(function (t, i) {
      return '<span class="rk-tab' + (i===0?' on':'') + '" data-k="' + t[0] + '">' + t[1] + '</span>';
    }).join('');
    function paint(k) {
      var mx = Math.max.apply(null, rows.map(function (r) { return r[k]; })) || 1;
      $('#qual-rank').innerHTML = rows.slice(0, 14).map(function (r) {
        var w = (r[k]/mx*100).toFixed(0);
        var col = k==='g' ? 'linear-gradient(90deg,#ffd35a,#fb923c)' : 'linear-gradient(90deg,#3b82f6,#22d3ee)';
        return '<div class="hbar" data-p="' + r.p + '" style="cursor:pointer">' +
          '<div class="hbar-n">' + r.p.replace(/省|市|壮族|回族|维吾尔|自治区/g,'') + '</div>' +
          '<div class="hbar-t"><i style="width:' + w + '%;background:' + col + '"></i></div>' +
          '<div class="hbar-v">' + r[k] + '</div></div>';
      }).join('');
      $$('#qual-rank .hbar').forEach(function (el) {
        el.addEventListener('click', function () {
          var code = provCodeOf(el.dataset.p);
          if (code) renderProvince(code);
        });
      });
    }
    paint('g');
    $$('#qual-rank-tabs .rk-tab').forEach(function (t) {
      t.addEventListener('click', function () {
        $$('#qual-rank-tabs .rk-tab').forEach(function (x){x.classList.remove('on');});
        t.classList.add('on'); paint(t.dataset.k);
      });
    });
  }

  function buildTypePanel() {
    var s = Q.stats || {};
    var t = s.types || {};
    var I = t.I||0, J = t.J||0, B = t.both||0;
    $('#qual-types').innerHTML =
      '<div class="hbar"><div class="hbar-n">统一遴选</div><div class="hbar-t"><i style="width:' + (I/271*100).toFixed(0) + '%;background:linear-gradient(90deg,#facc15,#fb923c)"></i></div><div class="hbar-v">' + I + '</div></div>' +
      '<div class="hbar"><div class="hbar-n">森林/特色</div><div class="hbar-t"><i style="width:' + (J/271*100).toFixed(0) + '%;background:linear-gradient(90deg,#22d3ee,#3b82f6)"></i></div><div class="hbar-v">' + J + '</div></div>' +
      '<div class="hbar"><div class="hbar-n">两者兼具</div><div class="hbar-t"><i style="width:' + (B/271*100).toFixed(0) + '%;background:linear-gradient(90deg,#a78bfa,#ffd35a)"></i></div><div class="hbar-v">' + B + '</div></div>' +
      '<div class="note" style="margin-top:9px;font-size:10.5px">政策性资格县区<b>全部同时具备</b>农险经营资质（资格逻辑自洽）。其中「两者兼具」指既入围统一遴选、又具地方特色/中央森林险资格。</div>';
  }

  function buildInsurerPanel() {
    var ks = {};
    (Q.pol||[]).forEach(function (r) { if (r.k) ks[r.k] = (ks[r.k]||0)+1; });
    var arr = Object.keys(ks).map(function (k){return {k:k,v:ks[k]};})
      .sort(function (a,b){return b.v-a.v;});
    var top = arr.slice(0, 10);
    $('#qual-insurers').innerHTML = top.length ? top.map(function (r) {
      return '<div class="hbar"><div class="hbar-n" title="' + r.k + '">' + r.k + '</div>' +
        '<div class="hbar-t"><i style="width:' + (r.v/top[0].v*100).toFixed(0) + '%;background:linear-gradient(90deg,#34d399,#22d3ee)"></i></div>' +
        '<div class="hbar-v">' + r.v + '</div></div>';
    }).join('') + '<div class="note" style="margin-top:8px;font-size:10.5px">共 ' + arr.length + ' 种具体落地险种有明确记载，其余县区按 J 列资格类型开展相应险种。</div>'
      : '<div class="note">暂无险种记载</div>';
  }

  /* ---------- UI ---------- */
  function bindUI() {
    var search = $('#qual-search');
    if (search) {
      search.addEventListener('input', function () {
        N.search = (search.value||'').trim();
        var box = $('#qual-search-res');
        if (!box) return;
        if (!N.search) { box.style.display='none'; return; }
        var hitQ = IDX.qual.filter(function(r){ return r.n && r.n.indexOf(N.search)>=0; }).slice(0,12);
        var hitP = IDX.pol.filter(function(r){ return r.n && r.n.indexOf(N.search)>=0; }).slice(0,12);
        var all = hitQ.map(function(r){return ['资质',r];}).concat(hitP.map(function(r){return ['政策',r];})).slice(0,14);
        box.innerHTML = all.length ? all.map(function (x) {
          var r = x[1];
          return '<div class="row" data-code="' + r.c + '"><div class="row-h"><div class="row-t">' + r.n + '</div>' +
            '<span class="tag ' + (x[0]==='政策'?'tag-yellow':'tag-blue') + '">' + x[0] + '</span></div>' +
            '<div class="row-m"><span>' + r.p + ' / ' + r.ct + '</span></div></div>';
        }).join('') : '<div class="note">未找到匹配县区</div>';
        box.style.display = 'block';
        $$('#qual-search-res .row').forEach(function (el) {
          el.addEventListener('click', function () {
            countyDetail(el.dataset.code);
            var code = el.dataset.code, pv = null;
            (GP.provinces||[]).forEach(function (p) {
              if (startsWith(code, p.c)) pv = p;
            });
            if (pv) renderProvince(pv.c);
            else { box.style.display = 'none'; }
          });
        });
      });
    }
  }

  function setEngine(ok, text) {
    var e = $('#qual-engine'); if (!e) return;
    e.textContent = text; e.className = ok ? 'engine-ok' : 'engine-warn';
  }
})();