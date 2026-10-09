/* ============================================================
   AgriSense 3S · 全国遥感地图视图（双层架构版）
   底图：腾讯卫星影像（TMap）；业务图层：内置 SVG 引擎
   数据：省级首屏加载 + 市级按需加载
   范围：全国 35 省 → 20 省 279 市
   ============================================================ */
(function () {
  'use strict';

  var GP = window.__GEO_PROV__;                     // {provinces:[...]}
  var CITY_IDX = window.__GEO_CITY_INDEX__ || [];   // [{p,f,n,c,v}]
  var NAT = window.NAT, SAT = window.SatMap, DM = window.DualMap;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var fmt = function (n, d) { return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); };
  var wan = function (n) { return (n / 10000).toFixed(1); };

  var MI = null;          // 本视图的 DualMap 实例
  var RS = window.RasterEngine;
  var N = {
    level: 'country', curProvince: null, curCity: null, activeLayer: 'ndvi',
    satOn: true, engine: '', ready: false, cityCache: {}, countyCache: {},
    rasterOn: true, lastStats: null
  };
  window.__NAT__ = N;

  /* ---------- 坐标还原：数据为相对 bbox 左上角的整数米 ----------
     ⚠️ 容错：b/r 可能缺失（例如外部只传 {n, c} 的轻量对象），
        原实现直接 o.b[0] 会抛 "Cannot read properties of undefined"，
        一旦抛错整个下钻链断在这里（实测踩过）。缺失时返回 null 由调用方降级。 */
  function abs(o) {
    if (!o || !o.r || !o.b) return null;
    if (o._abs) return o._abs;
    var b = o.b;
    o._abs = o.r.map(function (r) {
      return r.map(function (p) { return [p[0] + b[0], p[1] + b[1]]; });
    });
    return o._abs;
  }
  function abox(o) {
    if (!o || !o.b) return null;
    var b = o.b;
    /* b 有两种语义并存：
       - 4 元素 [x0,y0,x1,y1]（省界/多数县界）
       - 2 元素 [x0,y0] + w/h（市界、部分县界、乡镇）
       必须按实际长度判断，否则会把 2 元素的 undefined 参与运算 → NaN。 */
    if (b.length >= 4) return [b[0], b[1], b[2], b[3]];
    var w = o.w != null ? o.w : 0;
    var h = o.h != null ? o.h : 0;
    return [b[0], b[1], b[0] + w, b[1] + h];
  }

/* ---------- 首屏渲染调度 ----------
   视图 init 时容器可能尚未获得真实尺寸（display:none 或布局未完成），
   此时 fit() 会直接 return，导致地图空白且不再重试。
   这里统一：等待容器就绪 → 渲染 → 校验图元数，失败则重试（最多 6 次）。 */
  function renderWhenReady(view, drawFn, hostSel, probeSel) {
    var tries = 0;
    (function attempt() {
      tries++;
      var MIx = view && view.MI;
      var ok = MIx && MIx.svg && MIx.svg._vw > 50 && MIx.svg._vh > 50;
      if (ok) { try { drawFn(); } catch (e) { ok = false; } }
      if (ok) {
        if (probeSel) { if (document.querySelectorAll(probeSel).length > 0) return; }
        else return;
      }
      if (tries < 6) setTimeout(attempt, 260);
    })();
  }

  /* ---------- 色彩 ---------- */
  function ramp(stops, t) {
    t = Math.max(0, Math.min(1, t));
    var i = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
    var f = t * (stops.length - 1) - i;
    var a = stops[i], b = stops[i + 1];
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * f) + ',' +
      Math.round(a[1] + (b[1] - a[1]) * f) + ',' +
      Math.round(a[2] + (b[2] - a[2]) * f) + ')';
  }
  function rgbOf(c) {
    var m = (c || '').match(/\d+/g);
    return (m && m.length >= 3) ? [ +m[0], +m[1], +m[2] ] : [128, 128, 128];
  }
  function hex2rgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function layerStops(k) {
    var L = NAT.LAYERS[k];
    return L ? L.legend.map(function (l) { return hex2rgb(l.c); }) : [[148, 163, 184], [239, 68, 68]];
  }
  var RISK_STOPS = [[52, 211, 153], [250, 204, 21], [251, 146, 60], [248, 113, 113]];
  function riskColor(r) { return ramp(RISK_STOPS, (r - 2.2) / 2.2); }
  function premColor(p, mx) {
    return ramp([[30, 58, 95], [59, 130, 246], [250, 204, 21], [248, 113, 113]], mx ? p / mx : 0);
  }

  /* ---------- 县级边界按需加载（真实县界） ---------- */
  var KBI = window.__KBI__ || [];
  var KB = {};              // adcode -> 县界要素
  var kbLoading = {}, kbHas = {};

  function loadCountyOf(provCode, cb) {
    var pc = String(provCode).slice(0, 2);
    var meta = KBI.filter(function (x) { return x.p === pc; })[0];
    if (!meta) return cb(false);
    if (kbHas[pc]) return cb(true);
    if (kbLoading[pc]) { kbLoading[pc].push(cb); return; }
    kbLoading[pc] = [cb];
    var settled = false;
    /* 兜底超时：动态 <script> 在网络异常时可能既不触发 onload 也不触发
       onerror（DNS 污染 / 连接重置后请求挂起），此时回调队列永远不执行，
       界面会永久停在「· 加载县级边界…」且一个可点元素都没有（新疆实测）。
       超时后按失败处理，让 renderCity 走 CF（乡镇数据）兜底路径，
       至少保证「点得进去、看得见县面」。 */
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      console.warn('[nat] 县界数据加载超时（' + meta.f + '），转入乡镇数据兜底');
      var list = kbLoading[pc] || []; kbLoading[pc] = null;
      list.forEach(function (f) { f(false); });
    }, 4500);
    var s = document.createElement('script');
    s.src = 'assets/data/' + meta.f;
    s.onload = function () {
      if (settled) return;
      settled = true; clearTimeout(timer);
      var d = window.__KBP__;
      try { delete window.__KBP__; } catch (e) { window.__KBP__ = null; }
      if (d) { for (var k in d) KB[k] = d[k]; kbHas[pc] = true; }
      var list = kbLoading[pc] || []; kbLoading[pc] = null;
      list.forEach(function (f) { f(!!d); });
    };
    s.onerror = function () {
      if (settled) return;
      settled = true; clearTimeout(timer);
      var list = kbLoading[pc] || []; kbLoading[pc] = null;
      list.forEach(function (f) { f(false); });
    };
    document.head.appendChild(s);
  }

  /* ---------- 省直辖县级行政区的真实边界（county-ref 的 _r）----------
     背景：农险业务里「省直辖县级行政区」不是概念，是真实承保单元 ——
     河南济源(419001)、湖北仙桃/潜江/天门/神农架(429004/05/06/21)。
     它们在「市」这一层出现（点河南 → 列表里有「济源市」），
     但县界文件 geo-county-<省>.js 里【没有】它们的要素
     （实测 geo-county-41.js 有156 个县，唯独没有 419001）。
     结果：点进去提示「县级边界未取到（仅市级）」，地图一个县面都没有，
     真正能承保的单元反而进不去 —— 与业务直觉相反。

     这 5 个（连同海南儋州等）的真实边界其实已在 county-ref.js 的 `_r` 里
     （仓库 tools/patch_direct_counties.py 当初就是为此写的补丁），
     只是 national-view 从未加载该文件（此前仅 uw-view 用到）。
     这里按需加载并注册进 KB，使其与普通县走完全相同的绘制/拾取/下钻路径。 */
  var refLoading = [], refHas = false;
  function ensureCountyRef(cb) {
    if (window.__COUNTY_REF__) { refHas = true; return cb(true); }
    if (refLoading.length) { refLoading.push(cb); return; }
    refLoading.push(cb);
    var s = document.createElement('script');
    s.src = 'assets/data/geo-county-ref.js';
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return; settled = true;
      var l = refLoading; refLoading = [];
      l.forEach(function (f) { f(false); });
    }, 4000);
    s.onload = function () {
      if (settled) return; settled = true; clearTimeout(timer);
      refHas = true;
      var l = refLoading; refLoading = [];
      l.forEach(function (f) { f(true); });
    };
    s.onerror = function () {
      if (settled) return; settled = true; clearTimeout(timer);
      var l = refLoading; refLoading = [];
      l.forEach(function (f) { f(false); });
    };
    document.head.appendChild(s);
  }
  /* 把 county-ref 中带 _r 的省直辖县注册进 KB（_r 已是绝对世界坐标）。
     已存在于 KB 的不覆盖 —— 省级县界文件优先。 */
  function absorbCountyRef() {
    if (!window.__COUNTY_REF__) return 0;
    var REF = window.__COUNTY_REF__, add = 0;
    for (var code in REF) {
      var v = REF[code];
      if (!v || !v._r || !v._r.length) continue;
      if (KB[String(code)]) continue;
      /* ⚠️ b 必须填【真实世界坐标 bbox】，不能图省事写 [0,0,0,0]。
         countyBox()/abox() 会读 b 交给 fit()，b 为 0 会把视野fit 到
         原点 —— 画面全空、比例尺显示「0 m」，而 DOM 里 17 个面都在
         （实测济源）。county-ref 里本身带 x/y/b，正好可用（已是绝对坐标）。 */
      var bb = (v.b && v.b.length === 4) ? v.b.slice() : bboxOfRings(v._r);
      KB[String(code)] = { n: v.n, c: Number(code), r: v._r, b: bb, _absRef: true };
      add++;
    }
    return add;
  }
  function bboxOfRings(rings) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    rings.forEach(function (rg) {
      rg.forEach(function (p) {
        if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
      });
    });
    return (x0 === Infinity) ? [0, 0, 0, 0] : [x0, y0, x1, y1];
  }

  // 县级 adcode 前2位 = 省码；不能直接 indexOf(省adcode)
  function countyOfProv(code) {
    var p2 = String(code).slice(0, 2);
    return Object.keys(KB).filter(function (c) { return String(c).slice(0, 2) === p2; });
  }

  function absKB(k) {
    if (k._abs) return k._abs;
    /* county-ref 补进来的省直辖县：_r 已是【绝对世界坐标】，
       再加 b 会平移出一个错位的空区（实测会画到省外）。
       故以 _absRef 标记，b 固定为 [0,0] 并跳过加法。 */
    if (k._absRef) { k._abs = k.r; return k._abs; }
    var b = k.b;
    k._abs = k.r.map(function (r) { return r.map(function (p) { return [p[0] + b[0], p[1] + b[1]]; }); });
    return k._abs;
  }

  /* ---------- 乡镇级边界按需加载（真实乡镇界·第5 级下钻） ----------
     数据源：全国乡镇行政边界 GeoJSON（github.com/rooma1989/china_geo_data）
     编码：与县界一致，WebMercator 整数米 + 相对该县 bbox 左上角平移
     结构 window.__KBT__ = { "<县adcode>": {n,c,s,b,w,h,t:[{n,r}]} }
     s = adcode 映射来源：exact 精确 / byname 同名 / fuzzy 历史更名(已几何校验) */
  var KBTI = window.__KBTI__ || [];
  var T = {};              // 县adcode(或 省|市|县 兜底键 ) -> 乡镇要素
  var tbLoading = {}, tbHas = {};

  function loadTownOf(provCode, cb) {
    var pc = String(provCode).slice(0, 2);
    var meta = null;
    for (var i = 0; i < KBTI.length; i++) if (KBTI[i].p === pc) { meta = KBTI[i]; break; }
    if (!meta) return cb(false);
    if (tbHas[pc]) return cb(true);
    if (tbLoading[pc]) { tbLoading[pc].push(cb); return; }
    tbLoading[pc] = [cb];
    /* 与 loadCountyOf 同理：网络挂起时必须超时兜底，
       否则「进乡镇」会永久停在加载态。 */
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      console.warn('[nat] 乡镇界数据加载超时（' + meta.f + '）');
      var list = tbLoading[pc] || []; tbLoading[pc] = null;
      list.forEach(function (f) { f(false); });
    }, 4500);
    var s = document.createElement('script');
    s.src = 'assets/data/' + meta.f;
    s.onload = function () {
      if (settled) return;
      settled = true; clearTimeout(timer);
      var d = window.__KBT__;
      try { delete window.__KBT__; } catch (e) { window.__KBT__ = null; }
      if (d) { for (var k in d) T[k] = d[k]; tbHas[pc] = true; }
      var list = tbLoading[pc] || []; tbLoading[pc] = null;
      list.forEach(function (f) { f(!!d); });
    };
    s.onerror = function () {
      if (settled) return;
      settled = true; clearTimeout(timer);
      var list = tbLoading[pc] || []; tbLoading[pc] = null;
      list.forEach(function (f) { f(false); });
    };
    document.head.appendChild(s);
  }

  // 乡镇要素还原为世界坐标（加回该县 bbox 原点）
  function absTown(t) {
    if (t._abs) return t._abs;
    var b = t.b;
    t._abs = t.t.map(function (o) {
      return o.r.map(function (ring) {
        return ring.map(function (p) { return [p[0] + b[0], p[1] + b[1]]; });
      });
    });
    return t._abs;
  }

  // 乡镇域的 bbox（由 t 的 b/w/h 直接给出，避免重算）
  function tbox(t) {
    return [t.b[0], t.b[1], t.b[0] + (t.w || 0), t.b[1] + (t.h || 0)];
  }

  /* ---------- 村（第 5 级）数据加载 ----------
     数据文件 geo-vill-<县码>.js，一个县一个文件，进入该县时才加载。
     结构：{n:县名, b:[x0,y0,x1,y1], w, h, g:{"<县码>-<ti>":[村...]}}
     其中 ti 与乡镇数据 t 数组下标一致，键尾 "~" 是本县内未归属乡镇的村。*/
  var V = {};              // 县码 -> 村要素
  var vLoading = {}, vHas = {};

  /* 该省是否已接入村界数据（索引 window.__KVILL_IDX__ = 省码 -> 县数） */
  var VILL_IDX = window.__KVILL_IDX__ || {};
  function villProvReady(pc) {
    var n = VILL_IDX[String(pc).slice(0, 2)];
    return n ? Number(n) : 0;
  }

  /* 判断某县是否可能有村界数据，避免对必然 404 的县发起请求。
     全国 2.8 万个县里目前只有一小部分建了村界，若对每个县都发请求，
     浏览器控制台会堆满 404（实测湖北/浙江等未覆盖县的乡镇视图各触发一次），
     既掩盖真实错误，也让核验脚本无法用「无 4xx」作为断言。*/
  var vTried = {};
  function loadVillageOf(countyCode, cb) {
    var code = String(countyCode);
    if (!/^\d{6}$/.test(code)) return cb(false);
    if (V[code]) return cb(true);
    if (vHas[code] || vTried[code]) return cb(false);
    var pc = code.slice(0, 2);
    // 无该省索引时也直接判失败（索引缺失 = 该省未接入）
    if (!villProvReady(pc)) { vTried[code] = true; return cb(false); }
    vTried[code] = true;
    if (vLoading[code]) { vLoading[code].push(cb); return; }
    vLoading[code] = [cb];
    /* 同样加超时兜底：村界文件缺失时若请求挂起（既不 ok 也不 error），
       乡镇视图会永久停在加载态。 */
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      vHas[code] = true;
      var list = vLoading[code] || []; vLoading[code] = null;
      list.forEach(function (f) { f(false); });
    }, 4500);
    var s = document.createElement('script');
    s.src = 'assets/data/geo-vill-' + code + '.js';
    s.onload = function () {
      if (settled) return;
      settled = true; clearTimeout(timer);
      var d = window.__KVILL__;
      try { delete window.__KVILL__; } catch (e) { window.__KVILL__ = null; }
      if (d) { V[code] = d; vHas[code] = true; }
      else { vHas[code] = true; }
      var list = vLoading[code] || []; vLoading[code] = null;
      list.forEach(function (f) { f(!!d); });
    };
    s.onerror = function () {
      if (settled) return;
      settled = true; clearTimeout(timer);
      // 该县确实没有村界文件（县级要素缺失，非同县其他问题）
      vHas[code] = true;
      var list = vLoading[code] || []; vLoading[code] = null;
      list.forEach(function (f) { f(false); });
    };
    document.head.appendChild(s);
  }

  // 村要素还原为世界坐标
  function absVill(v) {
    if (v._abs) return v._abs;
    var b = v.b, out = {};
    for (var key in v.g) {
      out[key] = v.g[key].map(function (o) {
        return o.r.map(function (ring) {
          return ring.map(function (p) { return [p[0] + b[0], p[1] + b[1]]; });
        });
      });
    }
    v._abs = out;
    return out;
  }

  // 某乡镇下的村列表（键 "<县码>-<ti>"，另含未归属桶 "<县码>~"）
  function villageOf(code, ti) {
    var v = V[String(code)];
    if (!v) return null;
    var k1 = String(code) + '-' + ti;
    if (v.g[k1]) return { key: k1, list: v.g[k1] };
    var k2 = String(code) + '~';
    if (ti == null && v.g[k2]) return { key: k2, list: v.g[k2] };
    return null;
  }

  // 由环集算bbox（用于「只 zoom 到某一个乡镇」）
  function ringBBox(rings) {
    var x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18;
    rings.forEach(function (r) {
      r.forEach(function (p) {
        if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
      });
    });
    if (x0 > x1) return null;
    // 留 4% 余量，避免边界贴边
    var pad = Math.max(x1 - x0, y1 - y0) * 0.04;
    return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  }

  // 取某县的乡镇集合：优先 adcode 命中，其次用「省|市|县」兜底键
  function townOf(countyCode, pvName, cityName) {
    var k = String(countyCode);
    /* 标准县码直取。新疆乡镇数据里同一地方两套命名：
       key='650502' 而 n='哈密市'（组合键那条），countyName() 却返回
       「伊州区」（来自县界）。按名称匹配必然对不上（实测 T 里 650502
       明明存在，却因 pvName='伊州区' ≠ '哈密市' 而匹配失败，
       乡镇面画不出一个）。故先试标准码，命中即用，不再依赖名称。 */
    if (T[k] && T[k].t && T[k].t.length) return T[k];
    var p2 = k.slice(0, 2);
    var keys = Object.keys(T);
    for (var i = 0; i < keys.length; i++) {
      var parts = keys[i].split('|');
      if (parts.length === 3 && parts[0] === p2 && parts[2] === (pvName || '')) {
        return T[keys[i]];
      }
    }
    /* 再按 CF 的标准码映射兜底（CF 构建时已用 bbox 重叠登记） */
    var byC = CF_BY_CODE[k];
    if (byC && byC.t && byC.t.length) {
      if (!T[k]) T[k] = { n: byC.n, c: Number(k) || 0, t: byC.t, b: byC.b, w: byC.w, h: byC.h };
      return T[k];
    }
    /* 最后按组合键的市名/省名匹配。 */
    if (cityName) {
      for (var j = 0; j < keys.length; j++) {
        var pt = keys[j].split('|');
        if (pt.length === 3 && pt[0] === p2 && pt[1] === String(cityName)) return T[keys[j]];
      }
    }
    var cand = [];
    for (var m = 0; m < keys.length; m++) {
      var pm = keys[m].split('|');
      if (pm.length === 3 && pm[0] === p2 && pm[1] === String(pvName || '')) cand.push(keys[m]);
    }
    if (cand.length === 1) return T[cand[0]];
    return null;
  }

/* ---------- 遥感专题色带 ----------
     统一用 [{v:上界, c:[r,g,b]}] 结构：
     - RasterEngine 的 rampAt() 直接消费它（含阈值语义，用于像元着色）
     - ramp() 取其 c 数组做纯 RGB 插值，供矢量面使用
     两套结构曾不一致，导致 rgbOf() 拿到 null 而整段渲染中断。 */
  var RAMP = {
    ndvi: [{ v: .15, c: [166, 118, 72] }, { v: .32, c: [212, 190, 110] }, { v: .45, c: [122, 186, 96] },
    { v: .58, c: [66, 152, 74] }, { v: .72, c: [26, 108, 62] }],
    drought: [{ v: .26, c: [92, 148, 214] }, { v: .40, c: [126, 196, 208] }, { v: .52, c: [226, 216, 122] },
    { v: .64, c: [238, 158, 74] }, { v: .80, c: [196, 74, 58] }],
    flood: [{ v: .10, c: [222, 232, 226] }, { v: .26, c: [166, 206, 218] }, { v: .40, c: [96, 164, 208] },
    { v: .55, c: [46, 108, 190] }, { v: .68, c: [24, 58, 148] }],
    hail: [{ v: .14, c: [186, 206, 226] }, { v: .34, c: [128, 178, 214] }, { v: .50, c: [214, 158, 190] },
    { v: .66, c: [176, 92, 142] }, { v: .84, c: [124, 42, 104] }],
    biomass: [{ v: .15, c: [206, 190, 146] }, { v: .35, c: [170, 186, 108] }, { v: .52, c: [122, 168, 84] },
    { v: .68, c: [70, 132, 66] }, { v: .84, c: [32, 92, 52] }],
    gdd: [{ v: .26, c: [59, 130, 246] }, { v: .46, c: [103, 199, 184] }, { v: .66, c: [163, 217, 119] },
    { v: .82, c: [230, 183, 74] }, { v: .94, c: [221, 107, 61] }],
    soilMoisture: [{ v: .24, c: [180, 83, 9] }, { v: .34, c: [217, 119, 6] }, { v: .48, c: [234, 179, 8] },
    { v: .62, c: [101, 163, 13] }, { v: .78, c: [21, 128, 61] }],
    lst: [{ v: .30, c: [15, 76, 129] }, { v: .46, c: [63, 167, 214] }, { v: .60, c: [143, 214, 148] },
    { v: .74, c: [244, 185, 66] }, { v: .88, c: [232, 80, 58] }],
    cover: [{ v: .08, c: [38, 62, 96] }, { v: .45, c: [52, 116, 178] }, { v: 1, c: [126, 196, 238] }],
    disaster: [{ v: .10, c: [70, 76, 96] }, { v: .45, c: [208, 148, 62] }, { v: 1, c: [236, 92, 78] }]
  };
  /* ---------- 行政边界描边配色（可读性改造） ----------
     ⚠️ 改造原因（用户反馈"各地区边界太不明显"）：
     原来 16 处边界描边**全部是白色半透明**（rgba(255,255,255,.9) 左右），
     在绿色/褐色的遥感影像上几乎不可见 —— 截图里县级市界只能靠文字辨认。
     → 改为【深色主描边 + 浅色外发光】双层：
        深色（近黑蓝）在任何影像上都形成对比，
        外发光保证在深色底图上也不糊。
     分级：国/省最粗最实，市次之，县/乡镇稍细。 */
  var EDGE = {
    prov:   { c: 'rgba(12,22,38,.92)',   glow: 'rgba(255,255,255,.55)', w: 2.0, gw: 4.6 },
    city:   { c: 'rgba(14,26,44,.88)',   glow: 'rgba(255,255,255,.42)', w: 1.6, gw: 3.8 },
    county: { c: 'rgba(16,30,50,.84)',   glow: 'rgba(255,255,255,.36)', w: 1.25, gw: 3.0 },
    town:   { c: 'rgba(18,34,56,.78)',   glow: 'rgba(255,255,255,.30)', w: 1.0, gw: 2.4 },
    vill:   { c: 'rgba(20,38,62,.70)',   glow: 'rgba(255,255,255,.24)', w: 0.8, gw: 2.0 }
  };

  /* ---------- 遥感专题栅格透明度（关键观感参数） ----------
     ⚠️ 用户反馈「新疆就一点遥感影像」——实测根因：
       栅格宿主 z-index=5（在卫星瓦片 z=0 之上），
       而alpha=0.8~0.82 → 专题色块几乎完全盖住卫星影像，
       画面只剩一片橙色/绿色色块，看不到真实影像。
     → 改为【栅格半透明叠加】：专题色相 + 下方真实影像同时可见。
       0.34 左右：色相仍可辨（长势/涝渍分档），戈壁与绿洲纹理清晰可见；
       左侧「栅格叠加」滑块仍可临时调高看纯专题色。 */
  var RASTER_ALPHA = 0.34;

  /* 栅格专题白名单：可生成为「像元影像」的图层。
     ⚠️ 这里决定某专题切换后是「遥感图片」还是「矢量色块」。
        业务属性明显的专题（承保热力 cover / 灾情分布 disaster）刻意保持矢量，
        因为它们的语义是业务分级而非地表观测；把它们栅格化会让业务口径失真。*/
  var RASTER_TOPICS = {
    ndvi: 1, drought: 1, flood: 1, biomass: 1, hail: 1,
    gdd: 1, soilMoisture: 1, lst: 1
  };

  function rasterFor(layer) {
    return RASTER_TOPICS[layer] ? layer : null;
  }
  // 栅格用带阈值的 stops
  function stopsFor(layer) {
    return RAMP[layer] || RAMP.ndvi;
  }
  // 矢量用纯 RGB 数组（与 ramp() 匹配）
  function vstopsFor(layer) {
    return stopsFor(layer).map(function (s) { return s.c; });
  }
  function seedFor(layer, code) {
    var h = 0, s = String(code) + '|' + layer;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 100000;
  }

  /* ---------- 真实 Sentinel-2 值场（优先于模拟噪声） ----------
     数据：window.__S2__（由 tools/build_s2_index.py 从 Sentinel-2 L2A 实测反演生成）
     何时用真实值：
       · 当前处于县级视图、且该县在 __S2__.c 中有记录
       · 该记录含 8×8 真实反演网格 g（每格 20×20 像元均值）
     取值方式：把该县 8×8 网格按当前视野的世界坐标范围做**双线性插值**，
     因此缩放/平移时连续过渡，不会出现格块跳变；超出网格范围则夹到边缘。
     未覆盖的县/省市视图 → 回退原有确定性模拟值场（并在详情中注明）。 */
  /* S2 索引懒加载：数据已扩到 391 县（约 234KB），放首屏会拖慢打开。
     只有进入县级视图才需要它，所以那时再拉。
     ⚠️ 不能像以前那样在模块加载时 `var S2 = window.__S2__` ——
        那时数据还没到，会把 null 永久固化下来。改为每次动态读。 */
  var s2Loading = null;
  function loadS2(cb) {
    if (window.__S2__) { if (cb) cb(); return; }
    if (!s2Loading) {
      s2Loading = new Promise(function (res) {
        var s = document.createElement('script');
        s.src = 'assets/data/s2-index.js';
        s.onload = function () { res(!!window.__S2__); };
        s.onerror = function () { console.warn('[nat] S2 索引加载失败，回退模拟值场'); res(false); };
        document.head.appendChild(s);
      });
    }
    if (cb) s2Loading.then(cb); else return s2Loading;
  }
  function s2Data() { return window.__S2__ || null; }

  function s2Of(code) {
    var S2 = s2Data();
    if (!S2 || !S2.c) return null;
    var r = S2.c[String(code)];
    return (r && r.g && r.g.length) ? r : null;
  }

  /* ---------- 数据口径说明（据实生成，禁止"模拟值场"含糊其辞） ----------
     规则（对齐用户「每个省/县的规模信息必须准确有依据」的要求）：
       县级视图且该县有 S2 实测网格 → 写明"真实 Sentinel-2 反演"+日期+云量+指数值
       其余层级（省市/乡镇/村）→ 明确写"模拟值场"，并说明不代表卫星观测
     绝不出现"遥感专题影像"却不说来源的情况。 */
  function s2Caliber(level, code, townOrVillName) {
    var SD = s2Data();
    var M = (SD && SD.meta) ? SD.meta : null;
    if (level === 'county') {
      var r = s2Of(code);
      if (r) {
        return '<div class="note" style="margin-top:8px"><b>数据口径</b>：本县专题影像为<b>真实卫星反演</b>——' +
          (M ? M.source : 'Sentinel-2 L2A') + '；时相 ' + (r.date || '—') +
          '（云量 ' + (r.cloud != null ? r.cloud + '%' : '—') + '）；' +
          (M ? M.window : '') + '。' +
          'NDVI=' + (r.ndvi != null ? r.ndvi.toFixed(3) : '—') +
          'NDWI=' + (r.ndwi != null ? r.ndwi.toFixed(3) : '—') +
          'NDMI=' + (r.ndmi != null ? r.ndmi.toFixed(3) : '—') +
          'NDRE=' + (r.ndre != null ? r.ndre.toFixed(3) : '—') + '。</div>';
      }
    }
    var lvlName = level === 'town' ? '乡镇' : (level === 'village' ? '行政村' : '该区域');
    return '<div class="note warn" style="margin-top:8px"><b>数据口径</b>：' + lvlName + '边界来自公开行政区划边界数据集' +
      (townOrVillName ? '（' + townOrVillName + '）' : '') + '；但<b>专题影像为模拟值场</b>' +
      '（按名称确定性生成、同地稳定复现），<b>不代表实际卫星观测</b>。' +
      '县域级已有真实 Sentinel-2 反演数据。</div>';
  }

  /* 把某县的 8×8 网格编译成"世界坐标 → 值"的取值器。
     网格已按县域外接矩形等分，编译时记录该矩形在世界坐标下的范围。 */
  function makeS2ValueFn(rec, st) {
    var g = rec.g;
    var ll = rec.ll || null;   // 县中心经纬度（构建时写入）
    if (!ll) return null;
    // 网格的地理跨度：构建时窗口为 ±0.05°，8 格等分 → 每格 0.0125°
    var half = 0.05, span = half * 2 / g.length;
    var lon0 = ll[0] - half, lat0 = ll[1] + half;   // 左上角（北纬在上）
    var E = 20037508.34;
    var wx0 = lon0 / 180 * E;
    var wyTop = Math.log(Math.tan(Math.PI / 4 + lat0 * Math.PI / 360)) / Math.PI * E;
    var cellW = (span / 180) * E;                    // 每格世界 X 宽（米）
    var cellH = (span * Math.PI / 360) * (E / Math.cos(lat0 * Math.PI / 180)); // 每格世界 Y 高
    var n = g.length;

    return function (wx, wy) {
      // → 网格浮点坐标（超出则夹边）
      var fx = (wx - wx0) / cellW;
      var fy = (wyTop - wy) / cellH;
      if (fx < 0) fx = 0; else if (fx > n - 1) fx = n - 1;
      if (fy < 0) fy = 0; else if (fy > n - 1) fy = n - 1;
      var i = Math.floor(fx), j = Math.floor(fy);
      var tx = fx - i, ty = fy - j;
      if (i > n - 2) i = n - 2;
      if (j > n - 2) j = n - 2;
      // 双线性插值，缺值视为邻域可用值
      var q = function (a, b) {
        var v = g[a] && g[a][b];
        return (typeof v === 'number') ? v : null;
      };
      var v00 = q(j, i), v01 = q(j, i + 1), v10 = q(j + 1, i), v11 = q(j + 1, i + 1);
      var vs = [v00, v01, v10, v11].filter(function (v) { return v !== null; });
      if (!vs.length) return -1;                       // -1 = 无数据（透明）
      var v0 = (v00 === null || v01 === null) ? (v00 !== null ? v00 : v01) : v00 + (v01 - v00) * tx;
      var v1 = (v10 === null || v11 === null) ? (v10 !== null ? v10 : v11) : v10 + (v11 - v10) * tx;
      var v = (v0 === null || v1 === null) ? (v0 !== null ? v0 : v1) : v0 + (v1 - v0) * ty;
      if (v === null || v === undefined) return -1;
      // 专题差异：NDVI 直接用；涝渍/干旱等取自不同指数时由调用方传入映射
      return S2_MAP(rec, v);
    };
  }

  /* 把一个「NDVI 实测网格值」映射到当前专题所需的标量。
     目前实测网格是 NDVI；其余专题在无对应实测指数时，
     仍以 NDVI 的空间格局做相对表达（并在界面明确标注口径）。
     若后续补齐 NDWI/NDMI 的分县网格，可在此按 record.ndwi 等做分档换算。 */
  function S2_MAP(rec, ndviVal) {
    // NDVI 约定域 [0,1]；实测可能出现负值（水体/裸土），负值统一压到 0
    return ndviVal < 0 ? 0 : ndviVal;
  }

  /* 把某县的 8×8 真实反演网格画成空间分布图（SVG）。
     用真实实测值着色，不用模拟数据 —— 这正是本次改造的意义所在。
     每格标注实测值，便于核对；缺值画成斜纹"无观测"。 */
  function s2GridSvg(rec, layer) {
    var g = rec.g;
    if (!g || !g.length) return '';
    var stops = vstopsFor(layer || 'ndvi');
    var n = g.length;
    var cell = 26, pad = 1;
    var W = n * cell, H = n * cell;
    var parts = [];
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < n; j++) {
        var v = g[i] && g[i][j];
        var x = j * cell, y = i * cell;
        if (typeof v !== 'number') {
          parts.push('<rect x="' + x + '" y="' + y + '" width="' + cell + '" height="' + cell +
            '" fill="#f6f7f9" stroke="#dcdfe4" stroke-width="0.4"/>' +
            '<path d="M' + (x + 4) + ' ' + (y + cell - 4) + 'L' + (x + cell - 4) + ' ' + (y + 4) +
            '" stroke="#c9cdd4" stroke-width="0.8" fill="none"/>');
          continue;
        }
        var col = ramp(stops, Math.max(0, Math.min(1, v)));
        var txt = v.toFixed(2);
        var dark = (v < 0.42);   // 深色底用白字
        parts.push('<rect x="' + x + '" y="' + y + '" width="' + cell + '" height="' + cell +
          '" fill="' + col + '" stroke="rgba(255,255,255,.35)" stroke-width="' + pad + '"/>' +
          '<text x="' + (x + cell / 2) + '" y="' + (y + cell / 2 + 3.2) + '" text-anchor="middle" ' +
          'font-size="8.5" fill="' + (dark ? '#fff' : '#1a1a1a') + '">' + txt + '</text>');
      }
    }
    // 色带图例（用与主色带一致的连续渐变，避免分档色带在高位难分辨）
    var lw = 150, lh = 8, lx = 0, ly = H + 12;
    var gid = 's2lg' + (rec.date || '').replace(/[^0-9]/g, '') + (rec.nm || '').length;
    var gradStops = [];
    for (var k = 0; k <= 10; k++) {
      var t = k / 10;
      gradStops.push('<stop offset="' + (t * 100) + '%" stop-color="' + ramp(stops, t) + '"/>');
    }
    var grad = '<defs><linearGradient id="' + gid + '" x1="0%" y1="0%" x2="100%" y2="0%">' +
      gradStops.join('') + '</linearGradient></defs>';
    var legend = grad +
      '<text x="' + lx + '" y="' + (ly - 3) + '" font-size="8.5" fill="#7a7a7a">NDVI</text>' +
      '<rect x="' + lx + '" y="' + ly + '" width="' + lw + '" height="' + lh + '" fill="url(#' + gid + ')"/>' +
      '<rect x="' + lx + '" y="' + ly + '" width="' + lw + '" height="' + lh +
      '" fill="none" stroke="rgba(0,0,0,.12)" stroke-width="0.6"/>';
    // 刻度域用 DOM（NDVI 实用上限 0.8；色带本身到 0.72封顶，
    // 超出部分沿用最深色）——用常量表达，避免散落魔数
    var DOM = 0.8;
    var ticks = [0, 0.2, 0.4, 0.6, 0.8];
    var tl = ticks.map(function (t) {
      var xx = lx + (t / DOM) * lw;
      var anc = (t === 0) ? 'start' : (t === 0.8 ? 'end' : 'middle');
      return '<text x="' + xx + '" y="' + (ly + lh + 10) + '" text-anchor="' + anc +
        '" font-size="8.5" fill="#7a7a7a">' + t.toFixed(1) + '</text>';
    }).join('');
    // 分级边界（虚线，让用户看清"差/较差/中/良好/优"的分界）
    var NDVI_LEVELS = [0.2, 0.35, 0.5, 0.65];
    var bnd = NDVI_LEVELS.map(function (t) {
      var xx = lx + (t / DOM) * lw;
      return '<line x1="' + xx + '" y1="' + ly + '" x2="' + xx + '" y2="' + (ly + lh) +
        '" stroke="rgba(0,0,0,.3)" stroke-width="0.6" stroke-dasharray="1.5,1.5"/>' +
        '<text x="' + (xx + 2) + '" y="' + (ly - 3) + '" font-size="7.5" fill="#a0a4ab">' +
        ({ '0.2': '差', '0.35': '较差', '0.5': '中', '0.65': '良好' })[String(t)] + '</text>';
    }).join('');
    return '<svg viewBox="0 0 ' + W + ' ' + (H + 34) + '" width="' + W + '" height="' + (H + 34) +
      '" style="max-width:100%;border:1px solid #e3e6ea;border-radius:3px;background:#fff">' +
      parts.join('') + legend + tl + bnd + '</svg>';
  }

  /* ---------- 栅格渲染 ---------- */
  function renderRaster(opt) {
    if (!RS || !MI || !MI.svg) return;
    var layer = opt.layer || N.activeLayer;
    var topic = rasterFor(layer);
    // 无栅格专题时隐藏栅格层
    Object.keys(RS.layers).forEach(function (k) {
      if (k !== topic) RS.setVisible(k, false);
    });
    if (!topic || !N.rasterOn) {
      if (topic) RS.setVisible(topic, false);
      N.lastStats = null;
      if (opt && opt.onStats) opt.onStats(null);
      return;
    }
    var st = MI.svg;
    if (!st._vw || !st._vh) return;

    var fn = RS.VALUE_FN[topic] || RS.ndvi;
    // ★ 真实 Sentinel-2 优先：县级视图且该县有实测网格时，用实测值场
    var rec = (N.level === 'county') ? s2Of(opt.code) : null;
    var realFn = rec ? makeS2ValueFn(rec, st) : null;
    N.s2Active = rec ? rec : null;
    // 遮罩到当前行政边界（setMask 内部投影为像素坐标，逐像元判定）
    RS.setMask(st, (opt.rings && opt.rings.length) ? opt.rings : null);

    applyRasterMode();
    if (opt.overlay !== false) paintOverlay(opt.overlay || {});
    RS.render({
      geo: st, topic: topic, stops: stopsFor(layer),
      seed: opt.seed == null ? seedFor(layer, opt.code || 0) : opt.seed,
      valueFn: realFn ? realFn : function (wx, wy, sd) { return fn(wx, wy, sd); },
      pixelM: opt.pixelM || 460,
      alpha: opt.alpha == null ? RASTER_ALPHA : opt.alpha,
      onStats: function (s) { N.lastStats = s; if (opt.onStats) opt.onStats(s); }
    });
  }

  /* ---------- 当前裁剪范围与像元尺度 ---------- */
  /* ---------- 国界遮罩（35 个省级行政区界合并） ----------
     用途：全国 / 省级视图下，栅格必须裁剪到中国境内。
     ⚠️ 之前这里返回 null（不裁剪），导致遥感影像铺满整个画布——
        包括境外的中亚、东南亚、太平洋，用户看到的是"中国地图上盖了一层
        延伸到国外的遥感噪声"，这是明显的错误呈现。
     省界环的并集即为国界范围；含台湾省、海南岛等岛屿。 */
  var CN_MASK = null;
  function chinaMaskRings() {
    if (CN_MASK) return CN_MASK;
    var rings = [];
    var ps = (GP.provinces || []);
    for (var i = 0; i < ps.length; i++) {
      var r = abs(ps[i]);
      if (!r || !r.length) continue;
      for (var j = 0; j < r.length; j++) {
        if (r[j] && r[j].length >= 3) rings.push(r[j]);
      }
    }
    CN_MASK = rings;
    return CN_MASK;
  }

  function currentClipRings() {
    if (N.level === 'village' && N.curVillage != null) {
      var vv = V[String(N.curCounty)];
      if (vv) {
        var av = absVill(vv);
        var vk = String(N.curVillageKey || (N.curCounty + '-' + N.curTown));
        if (av[vk] && av[vk][N.curVillage]) return av[vk][N.curVillage];
      }
    }
    if (N.level === 'town' && N.curTown != null) {
      var tf = townOf(N.curCounty, countyName(N.curCounty), null);
      if (tf && tf.t[N.curTown]) return absTown(tf)[N.curTown];
    }
    if (N.level === 'county' && N.curCounty) {
      var cr = countyRings(N.curCounty);
      if (cr) return cr;
    }
    if (N.level === 'city' && N.curCity) {
      var list = N.cityCache[N.curProvince] || [];
      var c = list.filter(function (x) { return String(x.c) === String(N.curCity); })[0];
      return c ? abs(c) : null;
    }
    // 省级视图：裁到本省界
    if (N.level === 'province' && N.curProvince) {
      var pv = GP.provinces.filter(function (x) { return String(x.c) === String(N.curProvince); })[0];
      var pr = pv ? abs(pv) : null;
      return (pr && pr.length) ? pr : chinaMaskRings();
    }
    // 全国视图：裁到国界（35 省界并集）—— 不裁剪会让影像溢出到境外
    return chinaMaskRings();
  }
  function currentCode() {
    if (N.level === 'town' && N.curTown != null) {
      var tf = townOf(N.curCounty, countyName(N.curCounty), null);
      if (tf && tf.t[N.curTown]) return String(N.curCounty) + '-' + tf.t[N.curTown].n;
    }
    if (N.level === 'county') return N.curCounty;
    if (N.level === 'city') return N.curCity;
    return N.curProvince || 0;
  }
  // 层级越深像元越细（地面米数越小）
  function pixelForLevel() {
    if (N.level === 'town') return 60;
    return N.level === 'village' ? 25 : (N.level === 'town' ? 60
      : (N.level === 'county' ? 220 : (N.level === 'city' ? 340 : 900)));
  }
  // 大尺度下栅格只作氛围纹理，下钻后才成为主视觉
  function alphaForLevel() {
    if (N.level === 'town') return 0.95;
    return N.level === 'village' ? 0.96 : (N.level === 'town' ? 0.95
      : (N.level === 'county' ? 0.92 : (N.level === 'city' ? 0.82 : (N.level === 'province' ? 0.55 : 0.22))));
  }

  /* ---------- 栅格模式下的描边层 ----------
     栅格 canvas 在 z=5（业务矢量之上），因此边界线与标注必须重画到 z=6 的描边层，
     否则会被影像盖住。矢量模式下不清描边（避免与主 SVG 重复）。 */

  // 当前应叠加到描边层的乡镇面（县级=全县乡镇，乡镇级=仍画该乡镇以便与村界同层）
  // 注意：absTown() 返回的是按乡镇分组的嵌套数组 [ [ring...], [ring...] ]，
  // 必须在这里摊平成「每个乡镇一项」，供 overlayAreas 逐面上色。
  function currentTownFaces() {
    if (N.level !== 'county' && N.level !== 'town') return [];
    if (N.curCounty == null) return [];
    var kn = countyName(N.curCounty); if (!kn) return [];
    var tf = townOf(N.curCounty, kn, null);
    if (!tf || !tf.t) return [];
    var rings = absTown(tf);
    var out = [];
    for (var i = 0; i < tf.t.length; i++) {
      // 乡镇级只画当前乡镇
      if (N.level === 'town' && Number(i) !== Number(N.curTown)) continue;
      var rs = rings[i];
      // 字段名必须是 r：RS.overlayAreas 内部读 it.r（不是 rings）
      if (rs && rs.length) out.push({ n: tf.t[i].n, r: rs });
    }
    return out;
  }

  /* 当前应叠加的村面。
     县级视图：只画「未归属乡镇」的村（乡镇面已由 currentTownFaces 画了）；
     乡镇级：只画该乡镇名下的村；
     村级：不再叠加（当前村已在业务层单独画）。*/
  function currentVillageFaces() {
    if (N.level !== 'county' && N.level !== 'town') return [];
    if (N.curCounty == null) return [];
    var v = V[String(N.curCounty)];
    if (!v) return [];
    var abs = absVill(v);
    var out = [];
    for (var key in abs) {
      if (N.level === 'town') {
        if (key !== String(N.curCounty) + '-' + N.curTown) continue;
      } else if (key !== String(N.curCounty) + '~') {
        continue;
      }
      /* 结构：v.g[key][vi] = 村对象；abs[key][vi] = 该村的环数组。
         这两个下标必须用同一个 vi，不能拿 forEach 的形参当环数组。*/
      var list = v.g[key] || [];
      for (var i = 0; i < list.length; i++) {
        var rs = abs[key] && abs[key][i];
        if (rs && rs.length) out.push({ n: list[i].n, c: list[i].c, r: rs });
      }
    }
    return out;
  }

  function paintOverlay(opt) {
    if (!RS || !MI || !MI.svg || !MI.host) return;
    var on = N.rasterOn && !!rasterFor(N.activeLayer);
    RS.clearOverlay(MI.host);
    if (!on) return;
    N._overlayOpt = opt;          // 供视图刷新时重绘
    var rings = opt.rings || null;
    if (rings && rings.length) {
      RS.overlayRings(MI.host, MI.svg, rings, {
        stroke: EDGE.prov.c,
        width: N.level === 'village' ? 2.2 : (N.level === 'town' ? 2.4 : (N.level === 'county' ? 2.6 : 1.5)),
        dash: (opt.dash || ''), glow: false
      });
    }
    // 县域内的乡镇界：栅格在业务层之上，业务面着色会被影像盖住，
    // 必须在描边层(z=6)重画一遍面+边，地块划分才看得见。
    // 填充只做极轻的白色提亮（0.045）——目的是「能看清地块边界」，
    // 而不是用矢量色盖住遥感长势影像（0.10 实测会让整幅影像发灰）。
    var townFaces = currentTownFaces();
    if (townFaces.length) {
      RS.overlayAreas(MI.host, MI.svg, townFaces, {
        fill: 'rgba(255,255,255,.045)', fillOpacity: 1,
        stroke: (N.level === 'town' ? EDGE.town : EDGE.city).c, width: (N.level === 'town' ? 1.6 : 1.4)
      });
    }
    // 村面：栅格在业务层之上，村面着色会被影像盖住，
    // 同样必须在描边层重画（填充更轻，只勾地块线）
    var villFaces = currentVillageFaces();
    if (villFaces.length) {
      RS.overlayAreas(MI.host, MI.svg, villFaces, {
        fill: 'rgba(255,255,255,.03)', fillOpacity: 1,
        stroke: EDGE.vill.c, width: 1.0
      });
    }
    // 面标注（县名/市名）
    if (opt.labels && MI.svg._vw >= 420) {
      var st = MI.svg;
      (opt.labels || []).forEach(function (L) {
        // 只在视野内标注
        var sp = st.toPx(L[0], L[1]);
        if (sp.x < 40 || sp.x > st._vw - 40 || sp.y < 30 || sp.y > st._vh - 30) return;
        RS.overlayLabel(MI.host, st, L[0], L[1], L[2], {
          fill: L[3] || '#fff', size: L[4] || 12, weight: 700, dy: L[5] || 0
        });
      });
    }
  }

  // 视图变化时描边层要跟着移动
  // 描边层 g 不带世界变换（路径用世界坐标、文字用像素坐标），
  // 因此视图变化时只需重绘整个描边层
  function syncOverlay() {
    if (!RS || !MI || !MI.svg || !MI.host) return;
    if (!N.rasterOn || !rasterFor(N.activeLayer)) return;
    var ovl = N._overlayOpt || {};
    paintOverlay(ovl);
  }

  /* ---------- 层级面包屑 ---------- */
  function paintCrumb() {
    var box = $('#nat-crumb'); if (!box) return;
    var pv = N.curProvince ? GP.provinces.filter(function (x) { return String(x.c) === String(N.curProvince); })[0] : null;
    var cityObj = null;
    if (N.level === 'city' || N.level === 'county' || N.level === 'town' || N.level === 'village') {
      var list = N.cityCache[N.curProvince] || [];
      var cc = (N.level === 'city') ? N.curCity : N.curCounty;
      cityObj = list.filter(function (x) { return String(cc).slice(0, 4) === String(x.c).slice(0, 4); })[0];
    }
    var parts = [{ t: '全国', lv: 'country' }];
    if (pv) parts.push({ t: pv.n, lv: 'province' });
    if (cityObj) parts.push({ t: cityObj.n, lv: 'city' });
    if ((N.level === 'county' || N.level === 'town' || N.level === 'village') && N.curCounty) {
      var kn = countyName(N.curCounty);
      parts.push({ t: kn || String(N.curCounty), lv: 'county' });
    }
    if ((N.level === 'town' || N.level === 'village') && N.curTown != null) {
      var tf2 = townOf(N.curCounty, countyName(N.curCounty) || '', cityObj ? cityObj.n : '');
      var onm = tf2 && tf2.t[N.curTown] ? tf2.t[N.curTown].n : '乡镇';
      parts.push({ t: onm, lv: 'town' });
    }
    if (N.level === 'village' && N.curVillage != null) {
      var vv2 = V[String(N.curCounty)];
      var vk2 = String(N.curVillageKey || (N.curCounty + '-' + N.curTown));
      var vn = (vv2 && vv2.g[vk2] && vv2.g[vk2][N.curVillage]) ? vv2.g[vk2][N.curVillage].n : '村';
      parts.push({ t: vn, lv: 'village' });
    }
    var html = parts.map(function (p, i) {
      var cur = (i === parts.length - 1);
      return (i ? '<i>›</i>' : '') + '<span class="' + (cur ? 'cur' : '') + '" data-lv="' + p.lv + '">' + p.t + '</span>';
    }).join('');
    box.innerHTML = html;
    $$('#nat-crumb span').forEach(function (el) {
      el.addEventListener('click', function () {
        var lv = el.dataset.lv;
        if (lv === 'country') renderCountry();
        else if (lv === 'province' && N.curProvince) renderProvince(N.curProvince);
        else if (lv === 'city' && pv && cityObj) renderCity(pv, cityObj);
        else if (lv === 'county' && N.curCounty) {
          // 县面可能来自 KB（真实县界）或 CF（乡镇聚合），两者都要能回跳
          if (countyName(N.curCounty)) renderCounty(pv, cityObj, N.curCounty);
        }
        else if (lv === 'town' && N.curCounty && N.curTown != null) {
          var kk = KB[String(N.curCounty)] || { n: countyName(N.curCounty), c: String(N.curCounty) };
          renderTown(pv, cityObj, kk, N.curTown, N.curCounty);
        }
      });
    });
    /* 同步浏览器标签标题：用户收藏/开多标签时能分辨当前在看哪一层，
       此前标题恒为「阳光3S遥感平台（测试版）」，多标签下完全无法区分。 */
    try {
      var deep = parts[parts.length - 1];
      document.title = (deep && deep.lv !== 'country' ? deep.t + ' · ' : '') + '阳光3S遥感平台（测试版）';
    } catch (e) { }
  }

  /* ---------- 地名简称 ----------
     用户要求（2026-10-09）：地图上省名一律用简称。
     原用全称（「新疆维吾尔自治区」8 字）在 11px 字号下压在新疆的
     狭长经度带上，既挤成一团又与「新疆」混读；实测截图里字被压扁变形，
     看着像两行重影。
     简称取「专名 + 通称」的规范简称（与新华社标准简称一致）：
     内蒙古自治区→内蒙古、新疆维吾尔自治区→新疆、西藏自治区→西藏、
     广西壮族自治区→广西、宁夏回族自治区→宁夏、
     香港/澳门特别行政区→香港/澳门。
     已经是简称的（北京、天津、河北…）原样返回。 */
  var PROV_SHORT = {
    '内蒙古自治区': '内蒙古', '新疆维吾尔自治区': '新疆',
    '西藏自治区': '西藏', '广西壮族自治区': '广西',
    '宁夏回族自治区': '宁夏', '香港特别行政区': '香港',
    '澳门特别行政区': '澳门', '新疆生产建设兵团': '兵团'
  };
  function shortName(n) {
    if (!n) return '';
    if (PROV_SHORT[n]) return PROV_SHORT[n];
    /* 兜底：任意「××自治区/特别行政区」去掉后缀与民族名 */
    var m = String(n).match(/^(.+?)(维吾尔|壮族|回族)?(自治区|特别行政区|省|市)/);
    if (m) {
      var s = m[1];
      if (PROV_SHORT[s]) return PROV_SHORT[s];
      return s;
    }
    return String(n);
  }

  /* ---------- 长势面板 ---------- */
  var LVNAME = {
    ndvi: ['差', '较差', '中', '良好', '优'],
    biomass: ['低', '偏低', '中', '较高', '高'],
    drought: ['正常', '轻旱', '中旱', '重旱', '极旱'],
    flood: ['无', '轻', '中', '重', '极重'],
    hail: ['无', '轻', '中', '重', '极重'],
    gdd: ['不足', '偏少', '适中', '充足', '偏多'],
    soilMoisture: ['极干', '偏干', '适中', '偏湿', '饱和'],
    lst: ['偏低', '较凉', '适中', '偏高', '高温']
  };
  // 各专题的档位阈值说明（与 RAMP 对齐）
  var LVRANGE = {
    ndvi: ['<0.15', '0.15~0.32', '0.32~0.45', '0.45~0.58', '>0.58'],
    biomass: ['<0.15', '0.15~0.35', '0.35~0.52', '0.52~0.68', '>0.68'],
    drought: ['<0.26', '0.26~0.40', '0.40~0.52', '0.52~0.64', '>0.64'],
    flood: ['<0.10', '0.10~0.26', '0.26~0.40', '0.40~0.55', '>0.55'],
    hail: ['<0.14', '0.14~0.34', '0.34~0.50', '0.50~0.66', '>0.66'],
    gdd: ['<0.26', '0.26~0.46', '0.46~0.66', '0.66~0.82', '>0.82'],
    soilMoisture: ['<0.24', '0.24~0.34', '0.34~0.48', '0.48~0.62', '>0.62'],
    lst: ['<0.30', '0.30~0.46', '0.46~0.60', '0.60~0.74', '>0.74']
  };
  // 各专题的「优良方向」：1 = 值越高越好；-1 = 值越高越差（用于均值评级措辞）
  var LVDIR = { ndvi: 1, biomass: 1, drought: -1, flood: -1, hail: -1, gdd: 1, soilMoisture: 1, lst: -1 };

  function paintGrowthPanel(stats) {
    var box = $('#nat-growth');
    if (!box) return;
    var lv = $('#nat-growth-lv');
    var lk = N.activeLayer;
    if (lv) lv.textContent = (NAT.LAYERS[lk] || {}).name || '—';
    var gt = $('#nat-growth-t');
    if (gt) gt.textContent = rasterFor(lk) ? '遥感专题统计' : '业务分级统计';
    if (!stats) {
      // 业务分级专题（承保热力 / 灾情分布）没有观测值场，这里要说清是「口径不同」而非「坏了」
      var isBiz = (N.activeLayer === 'cover' || N.activeLayer === 'disaster');
      box.innerHTML = '<div class="note">' + (isBiz
        ? '当前为<b>业务分级专题</b>，按保费规模 / 灾情等级以矢量色块呈现，不含遥感观测值。'
        : '当前图层无栅格影像。可在上方切换 NDVI 长势 / 干旱 / 涝渍 / 积温 / 土壤墒情 / 地表温度等遥感专题。')
        + '</div>';
      return;
    }
    var stops = stopsFor(lk);
    var names = LVNAME[lk] || LVNAME.ndvi;
    var rng = LVRANGE[lk] || LVRANGE.ndvi;
    var pct = function (v) { return (v * 100).toFixed(v * 100 < 10 ? 1 : 0); };
    // 每档取区间中值的代表色（阈值色会误导：那是区间上界）
    var rows = stats.levels.map(function (v, i) {
      var lo = i === 0 ? 0 : stops[i - 1].v;
      var hi = i === stops.length - 1 ? 1 : stops[i].v;
      var mid = (lo + hi) / 2;
      var col = rampAtLocal(stops, mid);
      return '<div class="glev" title="' + rng[i] + '"><i style="background:' + col + '"></i>' +
        '<span>' + (names[i] || ('级' + (i + 1))) + '</span>' +
        '<b>' + pct(v) + '%</b><em><u style="width:' + Math.max(0, Math.min(100, v * 100)).toFixed(1) + '%;background:' + col + '"></u></em></div>';
    }).join('');
    var mean = (stats.mean * 100).toFixed(1);
    /* 评级措辞不能硬编码 NDVI 的"良好/较差"：
       干旱、涝渍、冰雹、地表温度是「值越高越糟」，照NDVI 的措辞会得出
       「均值 0.7 → 良好以上」这种完全错误的结论（实测踩过）。
       按LVDIR 方向翻转评级，并给出专题对应的用词。 */
    var dir = LVDIR[lk] || 1;
    var grade;
    if (dir === 1) {
      // 值越高越好
      grade = stats.mean >= .58 ? '良好以上' : (stats.mean >= .45 ? '中等' : (stats.mean >= .32 ? '偏较差' : '较差'));
    } else {
      // 值越高越差
      grade = stats.mean <= .30 ? '轻微' : (stats.mean <= .45 ? '中度' : (stats.mean <= .62 ? '较重' : '严重'));
    }
    var unitTxt = ((NAT.LAYERS[lk] || {}).unit) || '';
    box.innerHTML =
      '<div class="kv"><span>区域均值</span><b>' + mean + '<em class="gr">' + grade + '</em></b></div>' +
      '<div class="kv"><span>有效像元</span><b>' + fmt(stats.cells, 0) + '<em class="gs">地面 ' + fmt(stats.pixelM, 0) + ' m/像元</em></b></div>' +
      (unitTxt ? '<div class="kv"><span>单位口径</span><b>' + unitTxt + '（0~100 归一化）</b></div>' : '') +
      '<div class="glevs">' + rows + '</div>';
  }
  function rampAtLocal(stops, t) {
    var n = stops.length;
    if (t <= stops[0].v) return 'rgb(' + stops[0].c.join(',') + ')';
    for (var i = 1; i < n; i++) {
      if (t <= stops[i].v) {
        var a = stops[i - 1].c, b = stops[i].c;
        var k2 = (t - stops[i - 1].v) / (stops[i].v - stops[i - 1].v || 1);
        return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * k2) + ',' +
          Math.round(a[1] + (b[1] - a[1]) * k2) + ',' + Math.round(a[2] + (b[2] - a[2]) * k2) + ')';
      }
    }
    return 'rgb(' + stops[n - 1].c.join(',') + ')';
  }

  /* ---------- 县级下钻：进入某个县，显示大比例尺遥感影像 + 长势 ---------- */
  function renderCounty(pv, cityObj, code) {
    closeJump();
    /* S2 索引懒加载：只有县级视图用得到真实反演网格。
       首次进入时拉取（约 234KB），拉到后重绘一次把模拟值场换成实测值场；
       拉取失败或该县无记录则维持模拟值场（界面会如实标注）。 */
    if (!window.__S2__ && !s2Loading) {
      loadS2(function () {
        // 用 redrawCurrent 重绘当前层级：它是既有入口，会按 N.level
        // 走正确的渲染分支。不要自己拼 renderRaster(opt)，opt 的组装
        // 分散在各级 render 函数里，重拼容易漏字段。
        if (N.level === 'county' && N.curCounty === code) {
          try { redrawCurrent(); } catch (e) { console.warn('[nat] S2 载入后重绘失败', e); }
        }
      });
    }
    // 该县的边界有两条来源：①真实县界数据(KB)；②由乡镇数据聚合(CF)。
    // 新疆等 15 个省没有县界数据，但乡镇数据里有县级归属 → 走 CF。
    var k = KB[String(code)] || (CF[String(code)] ? { n: CF[String(code)].n, c: CF[String(code)].c || code } : null);
    var name = k ? k.n : (cityObj ? cityObj.n : code);
    DM.clearLayer(MI, 'risk');
    N.level = 'county'; N.curCounty = code; N.curTown = null;
    N.curVillage = null; N.curVillageKey = null;

    DM.clearLayer(MI, 'base'); DM.clearBIZ(MI); DM.clearLayer(MI, 'lab'); DM.clearLayer(MI, 'risk');
    var st = MI.svg; if (st) st.pxAnchors = [];

    var kr = countyRings(code), kb2 = countyBox(code);
    if (kr && kb2) {
      // 真实县界（或由乡镇数据聚合的县面）
      DM.area(MI, { n: k.n, c: code, kind: 'county', r: kr }, {
        fill: 'rgba(255,255,255,.04)', stroke: EDGE.county.c, strokeWidth: 1.7
      });
      DM.fit(MI, kb2);
      $('#nat-title').textContent = name + ' · ' + ((NAT.LAYERS[N.activeLayer] || {}).name || '遥感专题');
      $('#nat-scope').textContent = (pv ? pv.n + ' / ' : '') + (cityObj ? cityObj.n + ' / ' : '') + name;

      var kct = G.polyCentroid(kr);
      // 标注放在县域偏上 30% 处，避开底部比例尺/提示条（实测踩过）
      var kh = kb2[3] - kb2[1];
      var ly = kb2[1] + kh * 0.3;
      renderRaster({
        layer: N.activeLayer, rings: kr, code: code, pixelM: 220, alpha: .92,
        onStats: paintGrowthPanel,
        overlay: {
          rings: kr,
          labels: [[kct[0], ly, k.n, '#fff', 21, 0],
                   [kct[0], ly - kh * 0.06, (pv ? pv.n : '') + (cityObj ? ' · ' + cityObj.n : ''), 'rgba(232,241,255,.94)', 12, 0]]
        }
      });
      paintCrumb();
      drawCountyLabels(k, cityObj, pv);
      // 详情改为「点县区再开」，避免进入下钻瞬间浮层遮挡整幅遥感影像
      showCountyHint(k);
      syncSatZoom();

      // 异步叠加真实乡镇界（进入县后才有乡镇级地块）
      loadTownOf(code, function (ok) {
        if (!ok || N.level !== 'county' || String(N.curCounty) !== String(code)) return;
        var tf = townOf(code, name, cityObj ? cityObj.n : '');
        if (!tf || !tf.t || !tf.t.length) return;
        absTown(tf);                 // 预还原世界坐标，供描边层复用
        drawTownsInCounty(tf, k, pv, cityObj, code);
        // 乡镇界已就绪 → 重画描边层，让边界压在遥感影像之上
        if (RS && N.rasterOn && rasterFor(N.activeLayer)) {
          paintOverlay({ rings: kr });
        }
      });
    } else {
      // 无县界数据（该省未抓取）→ 退化为市级面 + 栅格
      var b = cityObj ? abox(cityObj) : abox(pv);
      DM.area(MI, { n: name, c: code, r: cityObj ? abs(cityObj) : abs(pv) }, {
        fill: 'rgba(255,255,255,.04)', stroke: EDGE.city.c, strokeWidth: 1.5
      });
      DM.fit(MI, b);
      $('#nat-title').textContent = name + ' · 遥感专题';
      $('#nat-scope').textContent = '该区域暂无县级精细边界';
      renderRaster({ layer: N.activeLayer, rings: cityObj ? abs(cityObj) : abs(pv), code: code, pixelM: 400, alpha: RASTER_ALPHA, onStats: paintGrowthPanel });
      syncSatZoom();
    }
  }

  /* ---------- 县级边界的统一取法 ----------
     两个来源：
       KB[adcode]  真实县界数据（有 b/w/h/r，20 个省）
       CF[adcode]  由乡镇数据聚合（有 rings/t，31 个省全覆盖）
     新疆等 15 个省没有县界数据，只有乡镇数据 —— 若只认 KB，这些省点到省就再也点不动。*/
  function countyRings(code) {
    var k = KB[String(code)];
    if (k) return absKB(k);
    var f = CF[String(code)];
    return f ? f.rings : null;
  }
  function countyBox(code) {
    var k = KB[String(code)];
    // ⚠️ 必须走 abox()，不能硬取 b[2]/b[3]：
    //    县界数据存在两种 bbox 语义并存 —— 多数省是 [x0,y0,x1,y1]（4 元素），
    //    但直辖市等文件是 [x0,y0] + w/h（2 元素）。硬取 b[2]/b[3] 得到 undefined，
    //    后续 fit() 算出 NaN → 整张地图变换失效、所有面点不动（实测北京）。
    if (k) return abox(k);
    var f = CF[String(code)];
    if (!f || !f.rings) return null;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    f.rings.forEach(function (rg) {
      rg.forEach(function (p) {
        if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
      });
    });
    return (x0 > x1) ? null : [x0, y0, x1, y1];
  }
  function countyName(code) {
    var k = KB[String(code)];
    if (k) return k.n;
    var f = CF[String(code)];
    if (f) return f.n;
    /* 新疆等省的乡镇数据用组合键「65|哈密地区|哈密市」存县级单元，
       而县面用的是标准码 650502。此时 CF[String(code)] 取不到，
       countyName 返回 null → pickCounty 首行 `if (!kn) return;`
       静默退出 → 用户点县「没反应」（实测新疆伊州区）。
       故补一层按县面自身登记的 c 反查。 */
    var byC = CF_BY_CODE[String(code)];
    if (byC && byC.n) return byC.n;
    return null;
  }

  /* 标准县码 → CF 条目。countyFacesFromTown 建 CF 时登记。 */
  var CF_BY_CODE = {};

  /* 取某县的**绝对世界坐标**环（用于按 shoelace 算真实多边形面积）。
     与 countyBox 一样要兼容两种来源：
       1) KB（省级县界文件）→ 相对坐标，必须经 absKB 加回 b[0]/b[1]
       2) CF（乡镇数据聚合的县）→ rings 已是绝对坐标
     ⚠️ 别把相对坐标当绝对坐标去算面积 —— 结果会差出bbox 的量级。 */
  function countyRings(code) {
    var k = KB[String(code)];
    if (k && k.r) return absKB(k);
    var f = CF[String(code)];
    if (f && f.rings) return f.rings;
    return null;
  }

  /* ---------- 乡镇级下钻 ----------
     进入某县后把真实乡镇界叠加到县界之下：
     · 填色按当前遥感专题的确定性模拟值（与栅格同一色带）
     · 描边与名称标注走 z=6 描边层，避免被 z=5 栅格盖住
     · 点击乡镇 → 进入乡镇级大比例尺遥感视图（第 5 级） */
  function drawTownsInCounty(tf, k, pv, cityObj, ccode) {
    var st = MI.svg; if (!st) return;
    var stops = vstopsFor(N.activeLayer);
    var tw = absTown(tf);
    var placed = [];
    var kw = st._vw > 700;
    // 县界数据只有字典键（adcode），没有 c 字段；统一用传进来的 ccode
    var cc = ccode != null ? ccode : (k && k.c != null ? k.c : N.curCounty);
    tf.t.forEach(function (o, i) {
      var rings = tw[i]; if (!rings || !rings.length) return;
      var v = NAT.topicValue(N.activeLayer, cc + '-' + o.n);
      var rgb = rgbOf(ramp(stops, v));
      DM.area(MI, { n: o.n, c: cc, kind: 'town', r: rings, _ti: i }, {
        fill: 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + (kw ? .46 : .32) + ')',
        stroke: EDGE.town.c, strokeWidth: kw ? 1.4 : 1.05
      });
    });
    // 标注（描边层 z=6，避免被栅格盖住）
    // 乡镇面数量大（一个县常有 10~40 个），阈值按可用宽度分档，
    // 并用占位网格做碰撞剔除，避免地名互相压叠成糊状。
    if (kw) {
      var GAP = st._vw > 1200 ? 58 : 48;
      tf.t.forEach(function (o, i) {
        var rings = tw[i]; if (!rings || !rings.length) return;
        var ct = G.polyCentroid(rings);
        var px = st.toPx(ct[0], ct[1]);
        if (px.x < 30 || px.x > st._vw - 30 || px.y < 24 || px.y > st._vh - 24) return;
        var hit = false;
        for (var j = 0; j < placed.length; j++) {
          var dx = placed[j][0] - px.x, dy = placed[j][1] - px.y;
          if (dx * dx + dy * dy < GAP * GAP) { hit = true; break; }
        }
        if (hit) return;
        placed.push([px.x, px.y]);
        var el = DM.pxLabel(MI, 'lab', px.x, px.y, shortName(o.n),
          { fill: '#fff', size: 11.5, halo: 'rgba(3,8,18,.97)', weight: 700 });
        if (el) DM.anchor(MI, el, ct[0], ct[1], 0, null, true, Math.round(GAP * 1.5));
      });
    }
    showTownHint(tf, k);
  }

  function showTownHint(tf, k) {
    var el = $('#nat-hint');
    if (!el) return;
    el.innerHTML = '<b>' + k.n + '</b> 已叠加真实乡镇界 <b>' + tf.t.length + '</b> 个乡镇/街道 · <b>点击任一乡镇</b>查看地块级遥感影像';
    el.style.display = 'block'; el.style.opacity = '1';
    clearTimeout(el._t1); clearTimeout(el._t2);
    el._t1 = setTimeout(function () { el.style.opacity = '0'; }, 7000);
    el._t2 = setTimeout(function () { el.style.display = 'none'; }, 7500);
  }

  // 点击乡镇 → 乡镇级大比例尺遥感视图
  function renderTown(pv, cityObj, k, ti, ccode) {
    closeJump();
    var cc = ccode != null ? ccode : (k && k.c != null ? k.c : N.curCounty);
    var tf = townOf(cc, k.n, cityObj ? cityObj.n : '');
    if (!tf || !tf.t[ti]) { showCountyInfo(k, cityObj, pv); return; }
    var o = tf.t[ti];
    DM.clearLayer(MI, 'risk');
    N.level = 'town'; N.curCounty = cc; N.curTown = ti;

    DM.clearLayer(MI, 'base'); DM.clearBIZ(MI); DM.clearLayer(MI, 'lab'); DM.clearLayer(MI, 'risk');
    var st = MI.svg; if (st) st.pxAnchors = [];

    var rings = absTown(tf)[ti];
    if (!rings || !rings.length) { showCountyInfo(k, cityObj, pv); return; }
    // 视野必须用「该乡镇自身」的 bbox，而不是所属县的 bbox，
    // 否则每次进乡镇都飞回全县视野，等于没下钻。
    var bx = ringBBox(rings) || tbox(tf);
    DM.area(MI, { n: o.n, c: cc, kind: 'town', r: rings },
      { fill: 'rgba(255,255,255,.05)', stroke: EDGE.county.c, strokeWidth: 1.5 });
    DM.fit(MI, bx);
    $('#nat-title').textContent = o.n + ' · ' + ((NAT.LAYERS[N.activeLayer] || {}).name || '遥感专题');
    $('#nat-scope').textContent = (pv ? pv.n + ' / ' : '') + (cityObj ? cityObj.n + ' / ' : '') + k.n + ' / ' + o.n;

    var ct = G.polyCentroid(rings);
    var th = bx[3] - bx[1];
    renderRaster({
      layer: N.activeLayer, rings: rings, code: cc + '-' + o.n,
      pixelM: 60, alpha: .95, onStats: paintGrowthPanel,
      overlay: {
        rings: rings,
        labels: [[ct[0], bx[1] + th * 0.3, o.n, '#fff', 18, 0],
                 [ct[0], bx[1] + th * 0.3 - th * 0.06,
                  (pv ? pv.n : '') + (cityObj ? ' · ' + cityObj.n : '') + ' · ' + k.n,
                  'rgba(232,241,255,.92)', 11, 0]]
      }
    });
    // 叠加该乡镇的真实村界（业务层，可点击进村）
    var vk = cc + '-' + ti;
    var vv = V[String(cc)];
    /* 把某乡镇桶下的村逐个画到业务层。
       ⚠️ v.g[vk][vi] 是【村对象】{n,c,r}，absVill() 后是【环数组】[[x,y],...]，
       两者层级不同：先前误把 forEach 的形参 rs 当环数组，
       于是 rs.length 恒为 undefined → 全部被 return 掉 → 村面一条都不画
       （但提示语仍显示"已叠加 30 个村"，极具迷惑性）。*/
    function paintVillageBucket(code0, key, tiIdx) {
      var v2 = V[String(code0)];
      if (!v2) return 0;
      var a2 = absVill(v2);
      var list = v2.g[key] || [];
      var n = 0;
      for (var vi = 0; vi < list.length; vi++) {
        var rings = a2[key] && a2[key][vi];
        if (!rings || !rings.length) continue;
        var vo = list[vi];
        DM.area(MI, { n: vo.n, c: code0, kind: 'vill', r: rings,
          _vi: vi, _vk: key, _ti: tiIdx },
          { fill: 'rgba(255,255,255,.10)', stroke: EDGE.town.c, strokeWidth: 1.05 });
        n++;
      }
      return n;
    }
    if (!vv) {
      // 村界数据按县懒加载：进乡镇时若尚未加载，先加载再叠加
      var code0 = String(cc);
      loadVillageOf(code0, function (ok) {
        if (!ok) { showVillageHint(-1, o.n); return; }
        var painted = paintVillageBucket(code0, vk, ti);
        showVillageHint(painted, o.n);
        // 描边层也要跟着补（栅格会盖住业务层）
        if (RS && N.rasterOn && rasterFor(N.activeLayer)) syncOverlay();
      });
    } else if (vv.g[vk]) {
      var painted2 = paintVillageBucket(String(cc), vk, ti);
      showVillageHint(painted2, o.n);
    } else {
      // 该乡镇名下无村（数据源未细分到乡镇），给明确提示而不是让用户以为没数据
      showVillageHint(0, o.n);
    }
    paintCrumb();
    syncSatZoom();
    showTownInfo(tf, ti, k, cityObj, pv, cc);
  }

    function showVillageHint(n, townName) {
    var el = $('#nat-hint');
    if (!el) return;
    el.innerHTML = n > 0
      ? '<b>' + townName + '</b> 已叠加真实村界 <b>' + n + '</b> 个行政村/社区 · <b>点击任一村</b>查看地块级遥感影像'
      : (n === 0
        ? '<b>' + townName + '</b> 该乡镇在公开数据源中未细分到村级（可返回上一级查看其他乡镇）'
        : '<b>' + townName + '</b> 该县暂无村级边界数据（乡镇/街道级遥感影像仍可用）');
    el.style.display = 'block'; el.style.opacity = '1';
    clearTimeout(el._t1); clearTimeout(el._t2);
    el._t1 = setTimeout(function () { el.style.opacity = '0'; }, 7000);
    el._t2 = setTimeout(function () { el.style.display = 'none'; }, 7500);
  }

  /* 点击村 → 村级大比例尺遥感视图（第 5 级）
     像元 25m —— 这是"地块级"能给出的最细合理分辨率
     （卫星底图在高 zoom 下本身也到这个量级，再细只是噪声）。*/
  function renderVillage(pv, cityObj, k, ti, vi, vk, ccode) {
    var cc = ccode != null ? ccode : N.curCounty;
    var vv = V[String(cc)];
    if (!vv || !vv.g[vk] || !vv.g[vk][vi]) { showTownInfo(townOf(cc, k.n, cityObj ? cityObj.n : ''), ti, k, cityObj, pv, cc); return; }
    var vo = vv.g[vk][vi];
    var vabs = absVill(vv);
    var rings = vabs[vk][vi];
    if (!rings || !rings.length) return;

    DM.clearLayer(MI, 'risk');
    N.level = 'village'; N.curCounty = cc; N.curTown = ti; N.curVillage = vi; N.curVillageKey = vk;

    DM.clearLayer(MI, 'base'); DM.clearBIZ(MI); DM.clearLayer(MI, 'lab'); DM.clearLayer(MI, 'risk');
    var st = MI.svg; if (st) st.pxAnchors = [];

    var tf = townOf(cc, k.n, cityObj ? cityObj.n : '');
    var townName = (tf && tf.t[ti]) ? tf.t[ti].n : '';
    var bx = ringBBox(rings);
    if (!bx) return;
    DM.area(MI, { n: vo.n, c: cc, kind: 'vill', r: rings },
      { fill: 'rgba(255,255,255,.05)', stroke: EDGE.county.c, strokeWidth: 1.4 });
    DM.fit(MI, bx);
    $('#nat-title').textContent = vo.n + ' · ' + ((NAT.LAYERS[N.activeLayer] || {}).name || '遥感专题');
    $('#nat-scope').textContent = (pv ? pv.n + ' / ' : '') + (cityObj ? cityObj.n + ' / ' : '')
      + k.n + ' / ' + townName + ' / ' + vo.n;

    var ct = G.polyCentroid(rings);
    var vh = bx[3] - bx[1];
    renderRaster({
      layer: N.activeLayer, rings: rings, code: cc + '-' + vo.c,
      pixelM: 25, alpha: .96, onStats: paintGrowthPanel,
      overlay: {
        rings: rings,
        labels: [[ct[0], bx[1] + vh * 0.32, vo.n, '#fff', 16, 0],
                 [ct[0], bx[1] + vh * 0.32 - vh * 0.07,
                  (pv ? pv.n : '') + (cityObj ? ' · ' + cityObj.n : '') + ' · ' + k.n
                  + (townName ? ' · ' + townName : ''),
                  'rgba(232,241,255,.92)', 10.5, 0]]
      }
    });
    paintCrumb();
    syncSatZoom();
    showVillageInfo(vo, rings, bx, pv, cityObj, k, townName, cc);
  }

  // 大比例尺时卫星底图也要跟到对应 zoom
  function syncSatZoom() {
    if (DM.syncToSat) DM.syncToSat(MI);
  }

  function drawCountyLabels(k, cityObj, pv) {
    var st = MI.svg; if (!st || st._vw < 480) return;
    // 县面可能来自 CF（乡镇数据聚合），此时 k 没有 r/b，必须走 countyRings 统一入口
    var rings = countyRings(k.c != null ? k.c : N.curCounty);
    if (!rings) return;
    var ct = G.polyCentroid(rings);
    var px = st.toPx(ct[0], ct[1]);
    var el = DM.pxLabel(MI, 'lab', px.x, px.y - 22, k.n,
      { fill: '#fff', size: 16, halo: 'rgba(3,8,18,.96)', weight: 800 });
    if (el) DM.anchor(MI, el, ct[0], ct[1], -22);
    var sub = (pv ? pv.n : '') + (cityObj ? ' · ' + cityObj.n : '');
    var el2 = DM.pxLabel(MI, 'lab', px.x, px.y + 6, sub,
      { fill: 'rgba(230,240,255,.9)', size: 11, halo: 'rgba(3,8,18,.94)' });
    if (el2) DM.anchor(MI, el2, ct[0], ct[1], 6);
  }

  /* ---------- 市级下钻 ---------- */
  /* 加载期间的即时轮廓：只画市域面 + 居中，不设 kind（不可点）。
     有意不设 data-pick —— 县界没到之前点市域面无意义，
     设了反而会让用户以为能下钻却原地不动。 */
  function paintCityOutline(pv, cityObj) {
    if (!MI || !cityObj) return;
    DM.clearLayer(MI, 'base'); DM.clearBIZ(MI);
    DM.clearLayer(MI, 'lab'); DM.clearLayer(MI, 'risk');
    var st = MI.svg; if (st) st.pxAnchors = [];
    var rings = abs(cityObj);
    if (!rings || !rings.length) return;
    DM.area(MI, { n: pv.n, c: pv.c, r: abs(pv) },
      { fill: 'rgba(59,130,246,.04)', stroke: 'rgba(96,165,250,.5)', strokeWidth: 1.4 });
    DM.area(MI, { n: cityObj.n, c: cityObj.c, r: rings }, {
      fill: 'rgba(59,130,246,.28)', stroke: 'rgba(96,165,250,.75)', strokeWidth: 1.5
    });
    var b = abox(cityObj);
    if (b) DM.fit(MI, b);
    if (st && st._vw > 620) {
      var ct = G.polyCentroid(rings);
      var px = st.toPx(ct[0], ct[1]);
      var el = DM.pxLabel(MI, 'lab', px.x, px.y, cityObj.n + ' · 加载中',
        { fill: '#fff', size: 13, halo: 'rgba(3,8,18,.96)', weight: 800 });
      if (el) DM.anchor(MI, el, ct[0], ct[1]);
    }
  }

  function renderCity(pv, cityObj) {
    closeJump();
    // 返回上级时收起下级列表（避免面板跨层级残留）
    var _pk = document.getElementById('nat-picker'); if (_pk) _pk.style.display = 'none';

    // 清掉上一级遗留的灾点圈（risk 层）
    DM.clearLayer(MI, 'risk');
    N.level = 'city'; N.curCity = cityObj.c; N.curCounty = null; N.curTown = null;
    N.curVillage = null; N.curVillageKey = null;
    $('#nat-title').textContent = pv.n + ' / ' + cityObj.n + ' · 加载县级边界…';
    $('#nat-scope').textContent = pv.n + ' / ' + cityObj.n;

    /* 先把市域轮廓画出来，避免「加载…」期间地图是空的、用户以为没响应。
       县界/乡镇界到位后下面的回调会 clearLayer 重画，不影响最终结果。
       （实测弱网下这一步能明显缩短「点进去没反应」的主观等待） */
    try { paintCityOutline(pv, cityObj); } catch (e) { /* 非致命 */ }

    /* mc 提到外层：proceedCity 内部（countyFacesFromTown 的回调）也要用它，
       定义在 loadCountyOf 回调里会因作用域不到而抛 "mc is not defined"。 */
    var mc = String(cityObj.c);

    loadCountyOf(pv.c, function () {
      /* 省直辖县级行政区（济源/仙桃/潜江/天门/神农架…）：
         县界文件里没有它们，但 county-ref 的 _r 里有真实边界。
         不补这一步，这些「真实承保单元」点进去会停在「县级边界未取到」。
         判据直接看 KB 是否有本级要素 —— countyOfProv() 每次都现算，
         补进 KB 后自然为真，无需缓存快照。 */
      if (!KB[mc]) {
        ensureCountyRef(function () { absorbCountyRef(); proceedCity(); });
      } else { proceedCity(); }
    });

    function proceedCity() {
      /* ⚠️ ks 必须在这里重取，不能用外层快照 ——
         absorbCountyRef() 会往 KB 里补进省直辖县（如 419001 济源），
         外层 ks 是补全前算的，里面没有这些码，
         导致判定永远不成立、界面停在「加载县级边界…」。 */
      var ks = countyOfProv(pv.c);
      /* 省级直辖县级市：市码本身就是县级码（海南儋州 460400、五指山 469001…），
         本级即是县，直接进县级视图下钻到乡镇。
         ⚠️ 绝不能按"前4位相同"筛辖县：海南 10 个直辖县都是 4690xx，
            前4位全都等于 4690，会把全省直辖县一次性全画出来（实测五指山
            点进去出现了 10 个县面），而且每个都点不动。
         这里用 CF（乡镇数据，全国 31 省齐全且含县级归属）一并判定——
         DataV 县界只给了海南 12 个县，469021/22/24/25 等靠 CF 兜住。 */
      countyFacesFromTown(pv.c, function (okCf) {
        var hasCf = okCf && CF[mc] && CF[mc].rings && CF[mc].rings.length;
        if (ks.indexOf(mc) >= 0 || hasCf) {
          drawCityAsCounty(pv, cityObj, mc);
          return;
        }
        /* 一般地级市：用 adcode 前4位筛出辖县（排除与市码相同的异常情况） */
        var inCity = ks.filter(function (c) {
          var cs = String(c);
          return cs !== mc && cs.slice(0, 4) === mc.slice(0, 4);
        });
        /* ⚠️ 县界数据本身可能漏县：DataV 县级要素并不完整，
           山东实测缺 17 个（全是市区：潍城/坊子/奎文/历城/天桥/张店/芝罘/兰山…）。
           这些县的乡镇数据是齐的，但因 `inCity` 非空而直接走
           drawCityWithCounties，缺掉的县既画不出来也点不进去
           （用户报障：「潍坊我不能点到乡镇」——潍坊下辖 12 个区，
            市界只画出 9 个，潍城区/坊子区/奎文区三个主城区直接消失）。
           故：先把 CF（乡镇数据聚合出的县面）中属于本市、而县界缺的补上，
           两类合并后再画。 */
        var cfMiss = [];
        if (okCf) {
          for (var fk in CF) {
            var fks = String(fk);
            if (fks.length !== 6) continue;
            if (fks.slice(0, 4) !== mc.slice(0, 4)) continue;
            if (fks === mc) continue;
            if (!CF[fk] || !CF[fk].rings || !CF[fk].rings.length) continue;
            if (inCity.indexOf(fk) >= 0) continue;
            cfMiss.push(fk);
          }
        }
        if (cfMiss.length) {
          if (inCity.length) {
            drawCityMixed(pv, cityObj, inCity, cfMiss);
          } else if (cfMiss.length) {
            drawCityWithCountyFaces(pv, cityObj, cfMiss);
          }
          return;
        }
        if (inCity.length) {
          drawCityWithCounties(pv, cityObj, inCity);
          return;
        }
        /* 直辖市（京 110000 / 津 120000 / 沪 310000 / 渝 500000）：
           市码就是省码，而县码是1101xx / 1201xx…，前 4 位与市码不同，
           上面的通用规则一条都筛不出来 → 市级退化成纯栅格、再也点不动。
           判据：市码后 4 位全 0（省级行政区代码形态）。
           此时辖县 = 本省（=本市）全部县。 */
        if (/^[0-9]{2}0000$/.test(mc)) {
          var muni = ks.filter(function (c) { return String(c).slice(0, 2) === mc.slice(0, 2); });
          if (muni.length) {
            drawCityWithCounties(pv, cityObj, muni);
            return;
          }
          // 县界数据缺失时用 CF 兜底
          if (okCf) {
            var mcodes = [];
            for (var mk in CF) {
              var mks = String(mk);
              if (mks.slice(0, 2) !== mc.slice(0, 2)) continue;
              if (!CF[mk].rings || !CF[mk].rings.length) continue;
              mcodes.push(mk);
            }
            if (mcodes.length) {
              drawCityWithCountyFaces(pv, cityObj, mcodes);
              return;
            }
          }
        }
        /* 该省没有县界数据（如新疆），但乡镇数据全国 31 省都有。
           用「市码前4位」从 CF 里筛出该市辖县，直接画出县面，
           否则市级会退化成纯栅格、再也点不动（实测新疆乌鲁木齐就是这种情况）。 */
        if (!okCf) { renderRasterCity(pv, cityObj); return; }
        var codes = [];
        for (var k in CF) {
          var ks2 = String(k);
          // 同样要排除「县码 == 市码」（省直辖县级市）
          if (ks2 === mc) continue;
          if (ks2.slice(0, 4) !== mc.slice(0, 4)) continue;
          if (!CF[k].rings || !CF[k].rings.length) continue;
          codes.push(k);
        }
        if (!codes.length) { renderRasterCity(pv, cityObj); return; }
        drawCityWithCountyFaces(pv, cityObj, codes);
      });
    }
    }

  /* 省级直辖县级市（如海南儋州/五指山/琼海、河南济源）：
     本级就是县级行政区，没有下辖区县，但仍可下钻到乡镇。
     画法：把本级面按县样式渲染 + 异步叠加乡镇界（与县级视图一致）。 */
  function drawCityAsCounty(pv, cityObj, code) {
    renderCounty(pv, cityObj, code);
  }

  /* 市级视图的第三种画法：县界 + CF 混合。
     用于「县界数据部分缺失」的省（山东缺 17 个市区县、吉林延边等）。
     两类县用同一样式绘制，用户看不出差别，也都能正常点击下钻。 */
  function drawCityMixed(pv, cityObj, kbCodes, cfCodes) {
    DM.clearLayer(MI, 'base'); DM.clearBIZ(MI); DM.clearLayer(MI, 'lab'); DM.clearLayer(MI, 'risk');
    var st = MI.svg; if (st) st.pxAnchors = [];

    var mc = String(cityObj.c);
    if (!/^[0-9]{2}0000$/.test(mc)) {
      DM.area(MI, { n: pv.n, c: pv.c, r: abs(pv) },
        { fill: 'rgba(59,130,246,.04)', stroke: 'rgba(96,165,250,.5)', strokeWidth: 1.4 });
    }

    var stops = vstopsFor(N.activeLayer);
    var bbox = null, placed = [];
    function paint(name, code, rings, kindLabel) {
      var v = NAT.topicValue(N.activeLayer, code);
      var col = N.activeLayer === 'cover' ? 'rgb(59,130,246)' : ramp(stops, v);
      var rgb = rgbOf(col);
      DM.area(MI, { n: name, c: code, kind: 'county', r: rings }, {
        fill: 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',.66)',
        stroke: EDGE.town.c, strokeWidth: 1.2
      });
      if (st && st._vw > 620) {
        var ct = G.polyCentroid(rings);
        var px = st.toPx(ct[0], ct[1]);
        var hit = false;
        for (var i = 0; i < placed.length; i++) {
          var dx = placed[i][0] - px.x, dy = placed[i][1] - px.y;
          if (dx * dx + dy * dy < 48 * 48) { hit = true; break; }
        }
        if (!hit) {
          placed.push([px.x, px.y]);
          var el = DM.pxLabel(MI, 'lab', px.x, px.y, name,
            { fill: '#fff', size: 10.5, halo: 'rgba(3,8,18,.96)' });
          if (el) DM.anchor(MI, el, ct[0], ct[1], 0, null, true, 620);
        }
      }
      var b = ringBBox(rings);
      if (b) bbox = bbox ? [Math.min(bbox[0], b[0]), Math.min(bbox[1], b[1]),
        Math.max(bbox[2], b[2]), Math.max(bbox[3], b[3])] : b.slice();
    }

    // 第一类：县界数据里的县
    kbCodes.forEach(function (c) {
      var kk = KB[c]; if (!kk) return;
      var rings = absKB(kk);
      if (!rings || !rings.length) return;
      paint(kk.n, c, rings, 'kb');
    });
    // 第二类：县界缺失、由乡镇数据聚合出的县面
    cfCodes.forEach(function (c) {
      var f = CF[c]; if (!f || !f.rings || !f.rings.length) return;
      paint(f.n, f.c || Number(c), f.rings, 'cf');
    });

    $('#nat-title').textContent = pv.n + ' / ' + cityObj.n + ' · ' +
      (kbCodes.length + cfCodes.length) + ' 个县区遥感分布';
    renderRaster({ layer: N.activeLayer, rings: abs(cityObj), code: cityObj.c, pixelM: 320, alpha: .82, onStats: paintGrowthPanel });
    paintCrumb();
    if (bbox) DM.fit(MI, bbox);
    syncSatZoom();
    showCityInfo(cityObj, pv.c);
  }

  /* 市级视图的第二种画法：县面来自 CF（由乡镇数据聚合）
     用于「该省无县界数据」的省（新疆/青海/甘肃/云南/陕西/贵州/西藏…）。*/
  function drawCityWithCountyFaces(pv, cityObj, codes) {
    DM.clearLayer(MI, 'base'); DM.clearBIZ(MI); DM.clearLayer(MI, 'lab'); DM.clearLayer(MI, 'risk');
    var st = MI.svg; if (st) st.pxAnchors = [];

    // 直辖市市=省，市域与省域重合；画底面会挡住县面且无法拾取（同 drawCityWithCounties）
    if (!/^[0-9]{2}0000$/.test(String(cityObj.c))) {
      DM.area(MI, { n: cityObj.n, c: cityObj.c, kind: 'city', r: abs(cityObj) },
        { fill: 'rgba(59,130,246,.05)', stroke: 'rgba(96,165,250,.7)', strokeWidth: 1.4 });
    } else {
      // 直辖市仍需一个可拾取的市级面供面包屑/回退用，但放在县面之下（先画）
      DM.area(MI, { n: cityObj.n, c: cityObj.c, kind: 'city', r: abs(cityObj) },
        { fill: 'rgba(59,130,246,.02)', stroke: 'rgba(96,165,250,.35)', strokeWidth: 1 });
    }

    var stops = layerStops(N.activeLayer);
    var bbox = null, placed = [];
    codes.forEach(function (c) {
      var f = CF[c]; if (!f) return;
      var v = NAT.topicValue(N.activeLayer, c);
      var rgb = rgbOf(ramp(stops, v));
      DM.area(MI, { n: f.n, c: f.c || c, kind: 'county', r: f.rings }, {
        fill: 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',.62)',
        stroke: EDGE.vill.c, strokeWidth: 1.05
      });
      var ct = G.polyCentroid(f.rings);
      if (st && st._vw > 620) {
        var px = st.toPx(ct[0], ct[1]);
        var hit = false;
        for (var j = 0; j < placed.length; j++) {
          var dx = placed[j][0] - px.x, dy = placed[j][1] - px.y;
          if (dx * dx + dy * dy < 46 * 46) { hit = true; break; }
        }
        if (!hit) {
          placed.push([px.x, px.y]);
          var el = DM.pxLabel(MI, 'lab', px.x, px.y, f.n,
            { fill: '#fff', size: 10, halo: 'rgba(3,8,18,.96)' });
          if (el) DM.anchor(MI, el, ct[0], ct[1], 0, null, true, 620);
        }
      }
      var b = countyBox(c);
      if (b) bbox = bbox ? [Math.min(bbox[0], b[0]), Math.min(bbox[1], b[1]),
        Math.max(bbox[2], b[2]), Math.max(bbox[3], b[3])] : b;
    });


    DM.fit(MI, bbox || abox(cityObj));
    $('#nat-title').textContent = pv.n + ' / ' + cityObj.n + ' · ' + codes.length + ' 个县区遥感分布';
    var prings = abs(cityObj);
    renderRaster({
      layer: N.activeLayer, rings: prings, code: cityObj.c, pixelM: 340, alpha: .82,
      onStats: paintGrowthPanel, overlay: { rings: prings }
    });
    paintCrumb();
    showCountyListHint({ n: pv.n + ' / ' + cityObj.n }, codes.length);
  }

  function renderRasterCity(pv, cityObj) {
    DM.clearLayer(MI, 'base'); DM.clearBIZ(MI); DM.clearLayer(MI, 'lab'); DM.clearLayer(MI, 'risk');
    var st = MI.svg; if (st) st.pxAnchors = [];

    /* 走到这里说明县界与乡镇界都没取到（通常是弱网/请求挂起）。
       只画市域面会让「点进去什么都点不到」，与用户报障现象一致。
       因此如实告知并给出去哪儿了，而不是默默停在市级。 */
    console.warn('[nat] ' + pv.n + '/' + cityObj.n + ' 县级边界未取到，仅显示市级范围');

    DM.area(MI, { n: pv.n, c: pv.c, r: abs(pv) },
      { fill: 'rgba(59,130,246,.04)', stroke: 'rgba(96,165,250,.5)', strokeWidth: 1.4 });
    var stops = vstopsFor(N.activeLayer);
    var v = NAT.topicValue(N.activeLayer, cityObj.c);
    var rgb = rgbOf(ramp(stops, v));
    DM.area(MI, { n: cityObj.n, c: cityObj.c, kind: 'city', r: abs(cityObj) }, {
      fill: 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',.62)',
      stroke: EDGE.county.c, strokeWidth: 1.4
    });
    var ct = G.polyCentroid(abs(cityObj));
    var px = st.toPx(ct[0], ct[1]);
    var el = DM.pxLabel(MI, 'lab', px.x, px.y, cityObj.n, { fill: '#fff', size: 14, halo: 'rgba(3,8,18,.96)', weight: 800 });
    if (el) DM.anchor(MI, el, ct[0], ct[1]);

    /* 据实标注：县界未取到，不能让标题看起来像已下钻成功 */
    $('#nat-title').textContent = pv.n + ' / ' + cityObj.n + ' · 县级边界未取到（仅市级）';
    renderRaster({ layer: N.activeLayer, rings: abs(cityObj), code: cityObj.c, pixelM: 320, alpha: .82, onStats: paintGrowthPanel });
    paintCrumb();
    DM.fit(MI, abox(cityObj));
    syncSatZoom();
    showCityInfo(cityObj, pv.c);
  }

  function drawCityWithCounties(pv, cityObj, codes) {
    DM.clearLayer(MI, 'base'); DM.clearBIZ(MI); DM.clearLayer(MI, 'lab'); DM.clearLayer(MI, 'risk');
    var st = MI.svg; if (st) st.pxAnchors = [];

    /* 直辖市（北京/天津/上海/重庆）市=省，市域与省域完全重合。
       若再画一层省域底面，它会盖住下面所有县面 —— 而它没有 data-pick，
       elementFromPoint 只能命中它 → 县面点不动（实测北京 16 个县面全部点不到）。
       故直辖市场景跳过底面，只画县面。*/
    var mc = String(cityObj.c);
    if (!/^[0-9]{2}0000$/.test(mc)) {
      DM.area(MI, { n: pv.n, c: pv.c, r: abs(pv) },
        { fill: 'rgba(59,130,246,.04)', stroke: 'rgba(96,165,250,.5)', strokeWidth: 1.4 });
    }

    var stops = vstopsFor(N.activeLayer);
    var bbox = null, placed = [];
    codes.forEach(function (c) {
      var k = KB[c]; if (!k) return;
      var v = NAT.topicValue(N.activeLayer, c);
      var col = N.activeLayer === 'cover' ? 'rgb(59,130,246)' : ramp(stops, v);
      var rgb = rgbOf(col);
      DM.area(MI, { n: k.n, c: c, kind: 'county', r: absKB(k) }, {
        fill: 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',.66)',
        stroke: EDGE.town.c, strokeWidth: 1.2
      });
      if (st && st._vw > 620) {
        var ct = G.polyCentroid(absKB(k));
        var px = st.toPx(ct[0], ct[1]);
        var hit = false;
        for (var i = 0; i < placed.length; i++) {
          var dx = placed[i][0] - px.x, dy = placed[i][1] - px.y;
          if (dx * dx + dy * dy < 46 * 46) { hit = true; break; }
        }
        if (!hit) {
          placed.push([px.x, px.y]);
          var el = DM.pxLabel(MI, 'lab', px.x, px.y, k.n,
            { fill: '#fff', size: 10.5, halo: 'rgba(3,8,18,.96)' });
          if (el) DM.anchor(MI, el, ct[0], ct[1], 0, null, true, 620);
        }
      }
      // 同countyBox：b 可能是 [x0,y0,x1,y1] 也可能是 [x0,y0]+w/h，统一用 abox
      var b = abox(k);
      if (!b) return;
      bbox = bbox ? [Math.min(bbox[0], b[0]), Math.min(bbox[1], b[1]), Math.max(bbox[2], b[2]), Math.max(bbox[3], b[3])] : b;
    });

    var ct2 = G.polyCentroid(abs(cityObj));
    $('#nat-title').textContent = pv.n + ' / ' + cityObj.n + ' · ' + codes.length + ' 个县区遥感分布';
    var ovLabels = [];
    codes.forEach(function (c) {
      var k = KB[c]; if (!k) return;
      var kr = absKB(k);
      var ctr = G.polyCentroid(kr);
      var yb = 1e12, yt = -1e12;
      kr.forEach(function (rg) {
        rg.forEach(function (q) { if (q[1] < yb) yb = q[1]; if (q[1] > yt) yt = q[1]; });
      });
      ovLabels.push([ctr[0], yb + (yt - yb) * 0.32, k.n, '#fff', 12, 0]);
    });
    renderRaster({
      layer: N.activeLayer, rings: null, code: cityObj.c, pixelM: 380, alpha: .82,
      onStats: paintGrowthPanel,
      overlay: { rings: null, labels: ovLabels }
    });
    paintCrumb();
    DM.fit(MI, bbox || abox(cityObj));
    syncSatZoom();
    showCityInfo(cityObj, pv.c);
  }

  // 进入县级后的操作提示（不遮挡地图，5 秒自动消失）
  function showCountyHint(k) {
    var el = $('#nat-hint');
    if (!el) {
      el = document.createElement('div');
      el.id = 'nat-hint'; el.className = 'nathint';
      var mw = $('#nat-map'); if (mw) mw.appendChild(el);
    }
    el.innerHTML = '已进入 <b>' + k.n + '</b> · 点击县区查看遥感专题详情 · 滚轮缩放至更细像元';
    el.style.display = 'block';
    clearTimeout(el._t1); clearTimeout(el._t2);
    el._t1 = setTimeout(function () { el.style.opacity = '0'; }, 5200);
    el._t2 = setTimeout(function () { el.style.display = 'none'; }, 5700);
    renderPicker(k);
  }

  /* ---------- 下级行政区列表面板（可点击） ----------
     解决什么问题（用户反馈"还是点不到乡镇级"）：
       大兴安岭这类地区，下辖县**地理上彼此分散、中间有大片空白**
       （漠河/呼玛/塔河三县互不相邻），用户在地图上很难瞄准目标，
       于是"看到文字标注却点不到"。
     → 提供一个**文字列表入口**，不必在地图上盲点。
       点列表项 = 触发与点击地图面完全相同的下钻逻辑。 */
  function renderPicker(k) {
    var host = $('#nat-picker');
    if (!host) {
      host = document.createElement('div');
      host.id = 'nat-picker';
      host.style.cssText = 'position:absolute;left:10px;bottom:34px;z-index:12;' +
        'max-width:250px;max-height:44%;overflow:auto;display:none;' +
        'background:rgba(12,20,32,.86);border:1px solid rgba(120,170,220,.28);' +
        'border-radius:8px;padding:8px 10px;backdrop-filter:blur(3px);' +
        'box-shadow:0 6px 18px rgba(0,0,0,.4)';
      var mw = $('#nat-map'); if (mw) mw.appendChild(host);
    }
    var code = k.c != null ? k.c : N.curCounty;
    var items = [], title = '', sub = '';
    // 乡镇级
    var tf = T[String(code)];
    if (tf && tf.t && tf.t.length) {
      title = k.n + ' · 下辖 ' + tf.t.length + ' 个乡镇/街道';
      for (var i = 0; i < tf.t.length; i++) {
        items.push({ label: tf.t[i].n, act: 'town', ti: i, cc: code });
      }
      sub = '点击列表项直接下钻，或在地图上点乡镇面';
    } else {
      // 没有乡镇数据 → 列出同市其他县
      var city = N.curCity || (k.c ? k.c.slice(0, 4) + '00' : null);
      var cf = city ? CF[String(city)] : null;
      var ks = cf && cf.rings ? Object.keys(cf) : [];
      if (!ks.length && KB[String(code)]) { ks = []; }
      if (ks.length) {
        title = k.n + ' · 本市共 ' + ks.length + ' 个县区';
        for (var j = 0; j < ks.length; j++) {
          if (ks[j] === String(code)) continue;
          items.push({ label: countyName(ks[j]) || ks[j], act: 'county', cc: ks[j] });
        }
        sub = '本县暂无乡镇数据，可从下方县区继续下钻';
      }
    }
    if (!items.length) { host.style.display = 'none'; return; }
    var html = '<div style="color:#ffd98a;font-size:11.5px;font-weight:700;margin-bottom:5px">' +
      title + '</div><div style="display:flex;flex-wrap:wrap;gap:4px">' +
      items.map(function (it, ix) {
        return '<button data-i="' + ix + '" style="font:inherit;font-size:11.5px;' +
          'padding:3px 8px;border-radius:11px;cursor:pointer;' +
          'border:1px solid rgba(120,170,220,.3);background:rgba(255,255,255,.07);' +
          'color:#dce8f4">' + it.label + '</button>';
      }).join('') + '</div>' +
      '<div style="color:#8aa0b8;font-size:10px;margin-top:5px">' + sub + '</div>';
    host.innerHTML = html;
    host.style.display = 'block';
    // 事件委托
    if (!host._bound) {
      host._bound = true;
      host.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-i]');
        if (!b || !host._items) return;
        var it = host._items[+b.getAttribute('data-i')];
        if (!it) return;
        if (it.act === 'town') {
          var tfi = T[String(it.cc)];
          if (tfi && tfi.t && tfi.t[it.ti]) {
            pickTown(it.cc, it.ti);
          }
        } else {
          pickCounty(it.cc);
        }
      });
    }
    host._items = items;
  }

  function showCountyInfo(k, cityObj, pv) {
    // 县面可能来自 CF（乡镇数据聚合），此时 k 没有 b，用countyBox 取范围
    var kb = countyBox(k.c != null ? k.c : N.curCounty) || k.b;
    var lat0 = G.yToLat(kb[1]), lon0 = G.xToLng(kb[0]);
    var lat1 = G.yToLat(kb[3]), lon1 = G.xToLng(kb[2]);
    var wkm = Math.abs(lon1 - lon0) * 111.32 * Math.cos(lat0 * Math.PI / 180);
    var hkm = Math.abs(lat1 - lat0) * 110.57;
    // ⚠️ 原式 `wkm * hkm * 10000` 是错的：wkm/hkm 本身已是 km，
    //    相乘即 km²，再乘 10000 把东西湖区算成 858 万 km²（实际约 836 km²）。
    //    且这是**外接矩形**面积（bbox 宽×高），非多边形面积，须如实标注。
    var area = wkm * hkm;
    // 用 shoelace 算真实多边形面积（比 bbox 矩形更接近实际），
    // 无边界数据时退回 bbox 矩形值。
    var areaPoly = null;
    try {
      var rings2 = countyRings(code);
      if (rings2 && rings2.length) {
        var acc = 0;
        for (var ri = 0; ri < rings2.length; ri++) {
          var rr = rings2[ri];
          for (var k2 = 0, j2 = rr.length - 1; k2 < rr.length; j2 = k2++) {
            acc += rr[j2][0] * rr[k2][1] - rr[k2][0] * rr[j2][1];
          }
        }
        areaPoly = Math.abs(acc / 2) / 1e6;      // m² → km²
      }
    } catch (e) { }
    var areaShown = areaPoly || area;
    var v = NAT.topicValue(N.activeLayer, k.c);
    var st = N.activeStats;
    var code = k.c != null ? k.c : N.curCounty;
    var rec = s2Of(code);
    var M2 = (window.__S2__ && window.__S2__.meta) ? window.__S2__.meta : null;
    /* 有真实 S2 反演时，专题读数直接用实测值；否则标注为模拟。
       （绝不再让"遥感专题"显示的其实是模拟值而用户不知情） */
    var showVal = rec ? rec.ndvi : v;
    var isReal = !!rec;
    var html =
      '<div class="kv"><span>县区</span><b>' + k.n + '</b></div>' +
      '<div class="kv"><span>行政区划代码</span><b>' + code + '</b></div>' +
      '<div class="kv"><span>经纬度范围</span><b>' + lon0.toFixed(2) + '~' + lon1.toFixed(2) + '°E, ' + lat0.toFixed(2) + '~' + lat1.toFixed(2) + '°N</b></div>' +
      '<div class="kv"><span>幅员跨度</span><b>' + wkm.toFixed(0) + ' × ' + hkm.toFixed(0) + ' km</b></div>' +
      '<div class="kv"><span>' + (areaPoly ? '县域面积（实测多边形）' : '区域概面积（外接矩形）') +
        '</span><b>' + areaShown.toFixed(0) + ' km²</b></div>' +
      '<div class="dt-sub">' + (isReal ? '真实卫星反演 · NDVI 长势' : '当前遥感专题（模拟值场）') + '</div>' +
      (isReal
        ? '<div class="kv"><span>NDVI 均值</span><b>' + rec.ndvi.toFixed(3) + '</b></div>' +
          '<div class="bar"><i style="width:' + Math.min(100, rec.ndvi * 100).toFixed(0) + '%;background:' + ramp(vstopsFor('ndvi'), rec.ndvi) + '"></i></div>' +
          '<div class="dt-sub" style="margin-top:12px">NDVI 空间分布（8×8 实测格网，格内为实测均值）</div>' +
          '<div style="margin:6px 0 10px">' + s2GridSvg(rec, 'ndvi') + '</div>' +
          '<div class="note" style="margin:0 0 8px">格网由 Sentinel-2 ' +
          (rec.date || '') + ' 影像在县域中心 ±0.05° 范围内 160×160 像元降采样聚合而成；' +
          '斜纹格表示该格无有效观测（云遮或边缘）。</div>' +
          (rec.ndwi != null ? '<div class="kv"><span>NDWI 水体指数</span><b>' + rec.ndwi.toFixed(3) + '</b></div>' : '') +
          (rec.ndmi != null ? '<div class="kv"><span>NDMI 土壤湿度</span><b>' + rec.ndmi.toFixed(3) + '</b></div>' : '') +
          (rec.ndre != null ? '<div class="kv"><span>NDRE 水分胁迫</span><b>' + rec.ndre.toFixed(3) + '</b></div>' : '') +
          '<div class="kv"><span>影像日期 / 云量</span><b>' + (rec.date || '—') + ' · ' +
            (rec.cloud != null ? rec.cloud + '%' : '—') + '</b></div>' +
          '<div class="kv"><span>有效像元</span><b>' + (rec.np != null ? rec.np : '—') + '</b></div>'
        : '<div class="kv"><span>' + ((NAT.LAYERS[N.activeLayer] || {}).name || '长势') + '</span><b>' + (v * 100).toFixed(0) + ' / 100</b></div>' +
          '<div class="bar"><i style="width:' + (v * 100).toFixed(0) + '%;background:' + ramp(vstopsFor(N.activeLayer), v) + '"></i></div>') +
      (N.lastStats && !isReal ? '<div class="kv"><span>像元均值</span><b>' + (N.lastStats.mean * 100).toFixed(1) + '</b></div>' : '') +
      (function () {
        var L = NAT.LAYERS[N.activeLayer];
        return L ? '<div class="note" style="margin-top:9px"><b>指标说明</b>：' + L.desc + '<br><b>数据来源</b>：' + L.source + '</div>' : '';
      })() +
      '<div class="note" style="margin-top:8px"><b>县界数据</b>：阿里云 DataV.GeoAtlas 公开行政边界。</div>' +
      s2Caliber('county', code);
    window.__APP__.detail(k.n + ' · 遥感专题详情',
      (pv ? pv.n + ' / ' : '') + (cityObj ? cityObj.n + ' / ' : '') + '行政区划 ' + code,
      html);
  }

  /* ---------- 乡镇级详情 ---------- */
  function showTownInfo(tf, ti, k, cityObj, pv, ccode) {
    var o = tf.t[ti];
    if (!o) return;
    var cc = ccode != null ? ccode : (k && k.c != null ? k.c : N.curCounty);
    var rings = absTown(tf)[ti];
    var bx = rings && rings.length ? (ringBBox(rings) || tbox(tf)) : tbox(tf);
    var lat0 = G.yToLat(bx[1]), lon0 = G.xToLng(bx[0]);
    var lat1 = G.yToLat(bx[3]), lon1 = G.xToLng(bx[2]);
    var wkm = Math.abs(lon1 - lon0) * 111.32 * Math.cos(lat0 * Math.PI / 180);
    var hkm = Math.abs(lat1 - lat0) * 110.57;
    var v = NAT.topicValue(N.activeLayer, cc + '-' + o.n);
    var stats = N.lastStats;
    var html =
      '<div class="kv"><span>乡镇 / 街道</span><b>' + o.n + '</b></div>' +
      '<div class="kv"><span>所属县区</span><b>' + k.n + '</b></div>' +
      '<div class="kv"><span>行政区划代码</span><b>' + (cc != null ? cc : '—') + '</b></div>' +
      '<div class="kv"><span>经纬度范围</span><b>' + lon0.toFixed(3) + '~' + lon1.toFixed(3) + '°E, ' +
        lat0.toFixed(3) + '~' + lat1.toFixed(3) + '°N</b></div>' +
      '<div class="kv"><span>幅员跨度</span><b>' + wkm.toFixed(1) + ' × ' + hkm.toFixed(1) + ' km</b></div>' +
      '<div class="kv"><span>本县乡镇数</span><b>' + tf.t.length + ' 个</b></div>' +
      '<div class="dt-sub">当前遥感专题</div>' +
      '<div class="kv"><span>' + ((NAT.LAYERS[N.activeLayer] || {}).name || '长势') + '</span><b>' + (v * 100).toFixed(0) + ' / 100</b></div>' +
      (stats ? '<div class="kv"><span>有效像元 / 像元尺寸</span><b>' + fmt(stats.cells, 0) + ' · ' + fmt(stats.pixelM, 0) + ' m</b></div>' +
        '<div class="kv"><span>区域均值</span><b>' + (stats.mean).toFixed(2) + '</b></div>' : '') +
      (function () {
        var L = NAT.LAYERS[N.activeLayer];
        return L ? '<div class="note" style="margin-top:9px"><b>指标说明</b>：' + L.desc + '<br><b>数据来源</b>：' + L.source + '</div>' : '';
      })() +
      '<div class="note warn" style="margin-top:8px"><b>数据口径</b>：乡镇边界来自公开行政区划边界数据集（已按县 adcode 挂接，' +
      '历史更名县经几何校验）。</div>' +
      s2Caliber('town', cc, o.n);
    window.__APP__.detail(o.n + ' · 乡镇遥感专题详情',
      (pv ? pv.n + ' / ' : '') + (cityObj ? cityObj.n + ' / ' : '') + k.n,
      html);
  }

  /* 村级详情（第 5 级）。村级像元 25m，是"地块级"能给出的最细合理分辨率。*/
  function showVillageInfo(vo, rings, bx, pv, cityObj, k, townName, ccode) {
    var cc = ccode != null ? ccode : N.curCounty;
    bx = bx || ringBBox(rings);
    if (!bx) return;
    var lat0 = G.yToLat(bx[1]), lon0 = G.xToLng(bx[0]);
    var lat1 = G.yToLat(bx[3]), lon1 = G.xToLng(bx[2]);
    var wkm = Math.abs(lon1 - lon0) * 111.32 * Math.cos(lat0 * Math.PI / 180);
    var hkm = Math.abs(lat1 - lat0) * 110.57;
    // 村级面积（近似）：用外接矩形估算，量级足够
    var areaKm2 = Math.max(0, wkm * hkm);
    var v = NAT.topicValue(N.activeLayer, cc + '-' + vo.c);
    var stats = N.lastStats;
    var vv = V[String(cc)];
    // 本乡镇的村数
    var nInTown = (vv && vv.g[cc + '-' + N.curTown]) ? vv.g[cc + '-' + N.curTown].length : 0;
    var nInCounty = 0;
    if (vv) for (var kk in vv.g) nInCounty += vv.g[kk].length;
    var html =
      '<div class="kv"><span>行政村 / 社区</span><b>' + vo.n + '</b></div>' +
      '<div class="kv"><span>所属乡镇 / 街道</span><b>' + (townName || '—') + '</b></div>' +
      '<div class="kv"><span>所属县区</span><b>' + (k ? k.n : '—') + '</b></div>' +
      '<div class="kv"><span>村级行政区划代码</span><b>' + (vo.c || '—') + '</b></div>' +
      '<div class="kv"><span>经纬度范围</span><b>' + lon0.toFixed(4) + '~' + lon1.toFixed(4) + '°E, ' +
        lat0.toFixed(4) + '~' + lat1.toFixed(4) + '°N</b></div>' +
      '<div class="kv"><span>幅员跨度</span><b>' + wkm.toFixed(2) + ' × ' + hkm.toFixed(2) + ' km</b></div>' +
      '<div class="kv"><span>估算地块面积</span><b>' + areaKm2.toFixed(2) + ' km²</b></div>' +
      '<div class="kv"><span>本乡镇村数 / 本县村数</span><b>' + nInTown + ' / ' + nInCounty + ' 个</b></div>' +
      '<div class="dt-sub">当前遥感专题</div>' +
      '<div class="kv"><span>' + ((NAT.LAYERS[N.activeLayer] || {}).name || '长势') + '</span><b>' + (v * 100).toFixed(0) + ' / 100</b></div>' +
      (stats ? '<div class="kv"><span>有效像元 / 像元尺寸</span><b>' + fmt(stats.cells, 0) + ' · ' + fmt(stats.pixelM, 0) + ' m</b></div>' +
        '<div class="kv"><span>区域均值</span><b>' + (stats.mean).toFixed(2) + '</b></div>' : '') +
      (function () {
        var L = NAT.LAYERS[N.activeLayer];
        return L ? '<div class="note" style="margin-top:9px"><b>指标说明</b>：' + L.desc + '<br><b>数据来源</b>：' + L.source + '</div>' : '';
      })() +
      '<div class="note" style="margin-top:8px"><b>村界数据</b>：全国公开村界数据集' +
      '（约 87.5 万条行政/村级边界，WGS84，已按几何抽稀至60m 并按县分片），' +
      '村→乡镇的归属关系由【村面质心落在乡镇面内】的空间包含关系判定' +
      '（源数据本身不含乡镇码）。</div>' +
      s2Caliber('village', ccode != null ? ccode : N.curCounty, vo.n);
    window.__APP__.detail(vo.n + ' · 村级遥感专题详情',
      (pv ? pv.n + ' / ' : '') + (cityObj ? cityObj.n + ' / ' : '')
      + (k ? k.n + ' / ' : '') + (townName || ''),
      html);
  }

  /* ---------- 市级按需加载 ---------- */
  function loadCity(provCode, cb) {
    if (N.cityCache[provCode]) return cb(N.cityCache[provCode]);
    var meta = CITY_IDX.filter(function (x) { return x.p == provCode; })[0];
    if (!meta) return cb(null);
    /* 并发去重：下钻时 renderProvince 与预取可能同时请求同一省，
       原实现会重复发请求（实测弱网下每次点击都新发一次 2MB 的市界文件）。
       在途请求把回调入队，加载完统一兑现。 */
    if (CITY_LOADING[provCode]) { CITY_LOADING[provCode].push(cb); return; }
    CITY_LOADING[provCode] = [cb];

    var settled = false;
    function finish(list) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      var q = CITY_LOADING[provCode] || [];
      CITY_LOADING[provCode] = null;
      q.forEach(function (f) { f(list); });
    }
    /* 超时兜底：市界文件最大 2MB+，弱网/冷启动可能十几秒才到
       （实测 GitHub Pages 首次取 0.3MB 就要 27.9s）。
       无超时时用户会看到「点了没反应、地图空白」且无从判断。
       取 6 秒：再慢的收益也不抵用户等待，且可重新点击重试。 */
    var timer = setTimeout(function () {
      console.warn('[nat] 市界数据加载超时（' + meta.f + '）');
      finish(null);
    }, 6000);

    var s = document.createElement('script');
    s.src = 'assets/data/' + meta.f;
    s.onload = function () {
      var d = window.__GEO_CITY__;
      try { delete window.__GEO_CITY__; } catch (e) { window.__GEO_CITY__ = null; }
      if (d) { d.list.forEach(abs); N.cityCache[provCode] = d.list; }
      finish(d ? d.list : null);
    };
    s.onerror = function () { finish(null); };
    document.head.appendChild(s);
  }
  var CITY_LOADING = {};

  /* ============ 初始化 ============ */
  function init() {
    if (N.ready) { DM.resize(MI); return; }
    var host = $('#nat-map'); if (!host) return;

    buildLayerPanel(); buildLegend(); buildProvinceRank(); buildStats(); buildDisasterList();

    MI = DM.init(host, {
      center: { lat: 35.0, lng: 106.0 }, zoom: 4,
      onPick: function (p) {
        if (p.kind === 'prov') pickProvince(p.id);
        else if (p.kind === 'city') pickCity(p.id);
        else if (p.kind === 'vill') pickVillage(p.id, p.ti, p.vi, p.vk);
        else if (p.kind === 'town') pickTown(p.id, p.ti);
        else if (p.kind === 'county') pickCounty(p.id);
      },
      onEngine: function (e) {
        N.engine = e.label; setEngine(e.ok, e.label);
        /* 只在【国家级】才重绘。
           ⚠️ 底图引擎就绪回调是异步的，用户可能已经下钻到省/市/县/乡；
           此时若无条件 renderCountry() 会把视图猛地打回全国（实测点县后 2 秒被弹回）。
           这在加 defer（引擎就绪更快）后暴露得更频繁。*/
        if (N.level === 'country') renderCountry();
      },
      onHome: function () { renderCountry(); },
      onTilesFail: function (reason) {
        /* 瓦片取不到：据实说明，不再指向已停用的腾讯 KEY。
           ⚠️ 上一版这里写「卫星影像待配置 KEY」，是**过时文案**——
           底图早已换成 Esri World Imagery（免 KEY），腾讯 SDK 只在无有效
           key 时才加载且必然鉴权失败。实测瓦片 48/48 全部正常，
           但文案让用户以为"新疆/黑龙江没影像"，属误导。*/
        N.tilesOk = false;
        setEngine(false, '矢量底图 · 卫星影像瓦片加载失败');
        showKeyHint(reason);
      },
      onTilesOk: function () {
        N.tilesOk = true;
        // 数据源据实标注：Esri World Imagery（免 KEY），不冒称腾讯
        setEngine(true, '卫星影像底图 · Esri World Imagery');
        var el = $('#nat-keyhint'); if (el) el.style.display = 'none';
      },
      onBaseChange: function (on) {
        N.satOn = on;
        if (on && N.tilesOk === false) { setEngine(false, '矢量底图 · 卫星影像瓦片加载失败'); showKeyHint(); }
        else if (on) setEngine(true, '卫星影像底图 · Esri World Imagery');
        else setEngine(true, '矢量底图 · Esri World Imagery');
      }
    });
    MI.svg.onViewChange = null;
    window.__NAT_VIEW__.MI = MI;   // 供 renderWhenReady 访问

    // 栅格层挂在双层容器里（TMap 之上、SVG 之下）
    if (RS) { RS.host = MI.host; RS.svg = MI.svg.host; }

    // 视图变化（缩放/平移）后重绘栅格，保持像元与地理对齐
    MI.svg.onRasterRefresh = function () {
      if (!N.rasterOn || !rasterFor(N.activeLayer)) return;
      var rings = currentClipRings();
      var lk = N.activeLayer;
      RS.setVisible(lk, true);
      // 边界遮罩是像素坐标，视图变化后必须重算
      RS.setMask(MI.svg, rings);
      syncOverlay();
      RS.render({
        geo: MI.svg, topic: lk, stops: stopsFor(lk),
        seed: seedFor(lk, currentCode()),
        valueFn: function (wx, wy, sd) { return (RS.VALUE_FN[lk] || RS.ndvi)(wx, wy, sd); },
        pixelM: pixelForLevel(),
        alpha: alphaForLevel()
      });
    };
    // 裁剪路径需随下钻层级更新
    MI._clipRings = function () { return currentClipRings(); };

    var back = $('#nat-back');
    if (back) back.addEventListener('click', function () { renderCountry(); });

    /* 右上角「点选」入口（香港/澳门/厦门/济源/苏州 不显示文字，但仍需可进入） */
    initJump();
    /* 下钻层级变化时关闭已展开的点选列表 —— 否则它停在下层的旧内容上。
       直接在 render* / pick* 内部调用（closeJump 对未展开时是空操作），
       不做导出包装，避免内外两套函数引用。 */

    /* 腾讯 SDK 仅作为「有有效 key 时」的备用底图：
       无 key 时 sat-map.js 会直接跳过加载（省 40 次无效请求）。
       底图主力是免 KEY 的 Esri World Imagery，
       因此这里**不因腾讯 SDK 未加载而报故障** —— 否则用户会误以为没有卫星图。*/
    SAT.loadSDK(function (ok) {
      if (!ok && !RS) setEngine(false, '矢量底图（卫星影像不可用）');
    });
    // 等容器就绪后再首屏渲染（避免 fit 因尺寸为 0 而空白）
    window.__NAT_VIEW__.renderCountry = renderCountry;
    renderWhenReady(window.__NAT_VIEW__, function () { if (!N.ready || !document.querySelectorAll('#nat-map path.gs-area').length) renderCountry(); },
                    '#nat-map', '#nat-map path.gs-area');
  }

  /* ---------- KEY 配置提示 ---------- */
  function showKeyHint(reason) {
    var el = $('#nat-keyhint');
    if (!el) {
      el = document.createElement('div');
      el.id = 'nat-keyhint';
      el.className = 'keyhint';
      var mw = $('#nat-map');
      if (mw) mw.appendChild(el);
    }
    var hasKey = (window.__APP_CONFIG__ && window.__APP_CONFIG__.TMAP_KEY) || '';
    el.innerHTML = hasKey
      ? '<b>卫星影像瓦片加载失败</b><span>本次视野内的 Esri 瓦片未取到（网络波动或该区域无影像）。当前显示矢量底图，矢量边界与全部业务功能正常。可点击「底图」切换重试。</span>'
      /* ⚠️ 原文案是「卫星底图需配置 KEY」，已过时 ——
         底图主力是**免 KEY 的 Esri World Imagery**，腾讯位置服务仅在
         填了 TMAP_KEY 时才作为备用加载。写「待配置 KEY」会让用户误以为
         新疆/黑龙江等地没有卫星影像（实测这些地区瓦片 48/48 正常）。 */
      : '<b>卫星底图说明</b><span>卫星影像使用 <b>Esri World Imagery</b>（免 KEY，全球覆盖）。若需接入境内持证影像源（天地图／高德／腾讯位置服务），可在 <code>index.html</code> 的 <code>__APP_CONFIG__.TMAP_KEY</code> 填写密钥作为备用底图。</span>';
    el.style.display = 'flex';
    el.style.opacity = '1';
    setTimeout(function () { el.style.opacity = '0'; }, 11000);
    setTimeout(function () { el.style.display = 'none'; }, 11700);
  }

  /* ---------- 全国 ---------- */
  function renderCountry() {
    closeJump();
    // 返回上级时收起下级列表（避免面板跨层级残留）
    var _pk = document.getElementById('nat-picker'); if (_pk) _pk.style.display = 'none';

    // 切换层级时清掉上一级遗留的灾点圈（risk 层）
    if (MI) DM.clearLayer(MI, 'risk');
    N.level = 'country'; N.curProvince = null; N.curCounty = null; N.curTown = null;
    N.curVillage = null; N.curVillageKey = null; N.ready = true;
    $('#nat-title').textContent = '全国农业遥感总览 · 35 省';
    $('#nat-scope').textContent = '全国';

    DM.clearLayer(MI, 'base'); DM.clearBIZ(MI); DM.clearLayer(MI, 'lab'); DM.clearLayer(MI, 'risk');
    var st = MI.svg;
    if (st) st.pxAnchors = [];

    var premMax = 0;
    GP.provinces.forEach(function (p) {
      var info = NAT.provInfo(p.c);
      if (info && info.prem > premMax) premMax = info.prem;
    });

    var bbox = null;
    GP.provinces.forEach(function (p) {
      var info = NAT.provInfo(p.c) || { risk: 3, prem: null };
      var c;
      if (N.activeLayer === 'cover') {
        // 未核实省份不着色（用中性色），避免"未核实"被误读成"规模低"
        c = (typeof info.prem === 'number' && premMax > 0) ? premColor(info.prem, premMax) : 'rgb(38,52,70)';
      }
      else if (N.activeLayer === 'disaster') c = NAT.disasterField(p.c) ? 'rgb(248,113,113)' : 'rgb(56,89,120)';
      else c = riskColor(info.risk);
      var rgb = rgbOf(c);
      DM.area(MI, { n: p.n, c: p.c, kind: 'prov', r: abs(p) }, {
        fill: 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',.55)',
        stroke: EDGE.city.c, strokeWidth: 1.3
      });
      var b = abox(p);
      bbox = bbox ? [Math.min(bbox[0], b[0]), Math.min(bbox[1], b[1]), Math.max(bbox[2], b[2]), Math.max(bbox[3], b[3])] : b.slice();
    });

    // 灾点圈已挪到 DM.fit 之后绘制（toPx 需要新变换）


    DM.fit(MI, bbox);

    /* 栅格底纹必须在 DM.fit 之后 —— 栅格 canvas 依赖当前视图变换定位，
       放在 fit 之前会导致整幅底色错位（实测地图区白底占比 98.4%）。
       ⚠️ 原来还传了 overlay.labels = 全部省名（ovl3），会把下方已标注
       （含避让与引线）的省名【再画一遍】，且第二遍无避让 ——
       北京/天津压在河北上、港澳压在广东旁，正是用户看到的"重叠"。
       现只传栅格层，省名标注单一来源。 */
    if (N.activeLayer !== 'disaster') drawDisasterCircles();   // 必须在 fit 之后：否则 toPx 用的还是上一级变换
    /* 栅格底纹。⚠️ 这里原本还传了 overlay.labels = 全部省名（ovl3），
       会把上面已标注（含避让与引线）的省名【再画一遍】——
       第二遍没有任何碰撞避让，于是北京/天津直接压在河北上、
       港澳压在广东旁，正是用户看到的"重叠"。
       现只传栅格层，省名标注统一由上方的 pxLabel 负责，单一来源。 */
    renderRaster({
      layer: N.activeLayer, rings: null, code: 0, pixelM: 1200, alpha: .22,
      onStats: paintGrowthPanel,
      overlay: { rings: null }
    });

    /* 省名标注必须在 DM.fit 之后 —— toPx 依赖当前视图变换，
       放在 fit 之前算的是上一级视图的坐标，避让判据完全失效
       （实测北京与河北实际相距 5px，却双双通过了避让判定）。 */

    /* 省名标注（面积优先 + 碰撞避让 + 引线标注）
       实测遗留 5 处重叠：河北∩北京、河北∩天津、广东∩香港、
       香港∩澳门、南海诸岛∩台湾 —— 全是地理紧邻区。
       旧逻辑用固定 56px 圆距避让：北京与河北质心仅 10px、
       香港与澳门仅 8px（而分开需要 77px），固定阈值根本挡不住。
       现改为【矩形真实相交】判定；重叠时把标签拉到旁边并画引线，
       这是地图标注的标准做法（callout label）。 */
    if (st && st._vw > 620) {
      var placed = [];
      var shortList = GP.provinces.slice().sort(function (a, b) { return (b.w * b.h) - (a.w * a.h); });
      /* 第一轮：正常标注，重叠的记下来 */
      var crowded = [];
      shortList.forEach(function (p) {
        var nm = shortName(p.n);
        var estW = nm.length * 11 + 2;
        var ct = G.polyCentroid(abs(p));
        var px = st.toPx(ct[0], ct[1]);
        var half = estW / 2 + 2, ht = 9;
        var hit = false;
        for (var i = 0; i < placed.length; i++) {
          var o = placed[i];
          if (Math.abs(o[0] - px.x) < half + o[2] && Math.abs(o[1] - px.y) < ht * 2 + 3) { hit = true; break; }
        }
        if (hit) { crowded.push({ p: p, ct: ct, px: px, w: estW }); return; }
        placed.push([px.x, px.y, half]);
        var el = DM.pxLabel(MI, 'lab', px.x, px.y, nm, { fill: '#fff', size: 11, halo: 'rgba(3,8,18,.96)' });
        if (el) DM.anchor(MI, el, ct[0], ct[1], 0, null, true, 620);
      });
      /* 第二轮：拥挤者按上下左右四个方向找空位，用引线连回原质心 */
      var DIRS = [[0, -1], [0, 1], [1, 0], [-1, 0], [1, -1], [-1, 1], [1, 1], [-1, -1]];
      crowded.forEach(function (c) {
        var half2 = c.w / 2 + 2, ok = null;
        for (var ring = 1; ring <= 5 && !ok; ring++) {
          for (var di = 0; di < DIRS.length && !ok; di++) {
            var nx = c.px.x + DIRS[di][0] * (26 + ring * 15);
            var ny = c.px.y + DIRS[di][1] * (26 + ring * 15);
            if (nx < 30 || nx > st._vw - 30 || ny < 16 || ny > st._vh - 16) continue;
            var bad = false;
            for (var j = 0; j < placed.length; j++) {
              var o2 = placed[j];
              if (Math.abs(o2[0] - nx) < o2[2] + half2 && Math.abs(o2[1] - ny) < 21) { bad = true; break; }
            }
            if (!bad) ok = { x: nx, y: ny };
          }
        }
        if (!ok) ok = { x: c.px.x, y: c.px.y };
        placed.push([ok.x, ok.y, half2]);
        /* 引线：从标签位置回到该省质心 */
        try {
          DM.leader(MI, 'lab', ok.x, ok.y, c.px.x, c.px.y,
            { stroke: 'rgba(255,255,255,.5)', sw: 1 });
        } catch (e) { }
        var el2 = DM.pxLabel(MI, 'lab', ok.x, ok.y, shortName(c.p.n),
          { fill: '#fff', size: 11, halo: 'rgba(3,8,18,.96)' });
        if (el2) DM.anchor(MI, el2, c.ct[0], c.ct[1], 0, null, true, 620);
      });
    }

    paintCrumb();;
  }

  /* 灾点影响圈（红/橙色虚线圆）。

   ⚠️ 三条硬约束（都是实测踩出来的）：
   1) 只在【全国视图】与【省级视图】画 —— 市级以下 zoom 已很深，
      再画全国灾点圈毫无意义。
   2) **必须在 DM.fit 之后**调用 —— 之前 4 处调用全在 fit 之前，
      此时 toPx() 用的还是上一级视图的变换，坐标全错：
      全国视图 0 个圈、省级视图反而 29 个（实测）。
   3) 省级视图**只画本省境内**的灾点圈 —— 灾点数据是全国口径，
      直接遍历会把外省的圈画到当前省的地图边缘/境外海域上，
      视觉上就是"地图右侧凭空悬着几个红圈"（用户截图实况）。

   ★ 2026-10-09 用户明确要求移除：「你不要放那个虚线圆圈」。
     全国视图会同时出现 29 个大圆圈压在省名标签上，既干扰读图
     （用户曾两次把圈边误认成"文字重影"），又只是示意、无明确业务含义
     （灾点数据本身只到省级，不构成精确落区）。
     现整段停用、函数保留为空实现，调用点无需改动。
     灾点信息仍在左侧「全国在监灾情」面板中可查 —— 移到面板是更合适的呈现方式。 */
  function drawDisasterCircles() { /* 已停用：见上方说明 */ }

  /* ---------- 省级下钻 ---------- */
  function renderProvince(pcode) {
    closeJump();
    // 返回上级时收起下级列表（避免面板跨层级残留）
    var _pk = document.getElementById('nat-picker'); if (_pk) _pk.style.display = 'none';

    var pv = GP.provinces.filter(function (p) { return p.c == pcode; })[0];
    if (!pv) return;
    var meta = CITY_IDX.filter(function (x) { return x.p == pcode; })[0];

    N.level = 'province'; N.curProvince = pcode; N.curCity = null; N.curCounty = null; N.curTown = null;
    N.curVillage = null; N.curVillageKey = null;
    /* 层级切换必须清掉 risk层（灾点圈等）。
       否则上一级（全国视图，29 个灾点圈）画出的 circle 会被
       DM.anchor 继续跟随缩放，残留在新视图里——实测进内蒙古省级后
       地图右侧仍有 4~5 个红圈凭空悬在境外/海域上。 */
    DM.clearLayer(MI, 'risk');
    $('#nat-scope').textContent = pv.n + (meta ? ' / ' + meta.c + ' 市' : '');

    /* 预取该省县界 + 乡镇界。
       实测 GitHub Pages 首次取 geo-county-65.js 耗时 27.9s（0.3MB，纯冷启动），
       用户「点地市没反应」正是卡在等这个文件。提前在省级就发起，
       等用户点市时通常已就绪；配合 loadCountyOf 的 4.5s 超时兜底双保险。 */
    try {
      loadCountyOf(pcode, function () { });
      countyFacesFromTown(pcode, function () { });
    } catch (e) { /* 预取失败不影响主流程 */ }
    /* 市界预取：有市界的省，进入省级视图时就把市界拉起来。
       不预取的话，用户点省 → 立刻要等市界文件（最大 2MB+），
       线上实测这一等就是十几秒，表现为「点了没反应、地图空白」。 */
    if (meta) { try { loadCity(pcode, function () { }); } catch (e2) { } }

    if (!meta) {
      // 该省无市级边界数据（15 个省含新疆/青海/甘肃/云南…）
      // 但【乡镇边界数据覆盖全国 31 省】，其中已带县级归属与 adcode，
      // 因此不必停在省级：直接用乡镇数据聚合出县级面，实现 省 → 县 → 乡镇 下钻。
      $('#nat-title').textContent = pv.n + ' · 正在准备县级下钻…';
      drawProvinceOnly(pv);
      buildCountyFacesFromTown(pcode, function (ok) {
        if (!ok) { showProvinceInfo(pv); return; }
        $('#nat-scope').textContent = pv.n + ' / 县级下钻（由乡镇边界聚合）';
      });
      showProvinceInfo(pv);
      return;
    }
    $('#nat-title').textContent = pv.n + ' · 加载中…';
    /* 下钻期间给进度条反馈：市界文件最大 2MB+，弱网下可能十几秒
       （实测 GitHub Pages 首次取 0.3MB 需 27.9s）。
       此前只有标题文字变化，地图区域空白，用户无从判断是否卡死。 */
    var BUSY = window.__BUSY__;
    if (BUSY) BUSY.on('正在加载' + pv.n + '市界数据…');
    loadCity(pcode, function (list) {
      if (BUSY) BUSY.off();
      if (!list) {
        /* 市界取不到（网络失败/超时）。此前只改标题、画省域面，
           用户看到的是「标题写着市级下钻、地图却一片空白」，
           长达 9 秒且无任何说明 → 以为坏了。
           现在标题据实说明，并给出可操作的下一步。 */
        $('#nat-title').textContent = pv.n + ' · 市界数据未取到，已切至省级视图';
        $('#nat-scope').textContent = pv.n + ' / 市级下钻数据缺失';
        drawProvinceOnly(pv); showProvinceInfo(pv); return;
      }
      $('#nat-title').textContent = pv.n + ' · 市级遥感下钻';
      drawCities(pv, list);
    });
  }

  /* ---------- 剔除孤立跳点 ----------
   源数据里偶有离群点：相邻点间距是中位数的 8~16 倍。
   实测潍坊潍城区「于河街道」有 8215m 的跳段、「潍城经济开发区」8850m，
   而正常相邻间距约 550m —— 渲染出来就是边界上的小尖刺/拉丝
   （用户报「边界明显有问题」）。
   判定：以环内间距中位数为基准，超过 8 倍且两侧方向一致（说明该点
   插在一条直边上、不构成拐角）时删除。真正的大转折若两侧方向变化，
   则保留，避免削掉真实的半岛/拐角。 */
  function cleanSpikes(ring) {
    var n = ring.length;
    if (n < 8) return ring;
    var ds = [];
    for (var i = 1; i < n; i++) {
      ds.push(Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]));
    }
    var sorted = ds.slice().sort(function (a, b) { return a - b; });
    var med = sorted[Math.floor(sorted.length / 2)];
    if (!(med > 0)) return ring;
    var th = med * 8;

    var out = [ring[0]];
    for (var k = 1; k < n; k++) {
      var d = ds[k - 1];
      if (d > th) {
        // 方向一致性检查：与前后两段的夹角是否接近直线
        var p = out[out.length - 1], c = ring[k], q = ring[(k + 1) % n];
        var v1x = c[0] - p[0], v1y = c[1] - p[1];
        var v2x = q[0] - c[0], v2y = q[1] - c[1];
        var cross = v1x * v2y - v1y * v2x;
        var dot = v1x * v2x + v1y * v2y;
        // 共线（同向）→ 尖刺，丢弃该点；明显转折 → 保留
        if (Math.abs(cross) < Math.abs(dot) * 0.15) continue;
      }
      out.push(ring[k]);
    }
    return out.length >= 3 ? out : ring;
  }

  /* ---------- 无市界省份：用乡镇边界聚合出县级面 ----------
     数据前提：geo-town-<省>.js 里每个 key 是一个县级单元，
     含 n(县名) / c(adcode) / b,w,h(县域 bbox) / t(乡镇列表)。
     于是「省 → 县」这一层不必依赖市界数据，可直接由乡镇数据拼出县面：
     把该县下所有乡镇的外环合并为一个多边形。 */
  var CF = {};               // 县adcode -> {n, rings:[[ring...]]}
  var cfLoading = {}, cfHas = {};

  function countyFacesFromTown(provCode, cb) {
    var pc = String(provCode).slice(0, 2);
    if (cfHas[pc]) return cb(true);
    if (cfLoading[pc]) { cfLoading[pc].push(cb); return; }
    cfLoading[pc] = [cb];
    var meta = null;
    for (var i = 0; i < KBTI.length; i++) if (KBTI[i].p === pc) { meta = KBTI[i]; break; }
    if (!meta) { cfLoading[pc] = null; return cb(false); }
    /* 超时兜底：新疆等无县界省份完全依赖这条 CF 路径，
       一旦请求挂起不回调，市级就永久停在「加载县级边界…」且无任何可点元素。 */
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      console.warn('[nat] 乡镇界(CF)加载超时（' + meta.f + '）');
      var lst = cfLoading[pc] || []; cfLoading[pc] = null;
      lst.forEach(function (f) { f(false); });
    }, 4500);
    var s = document.createElement('script');
    s.src = 'assets/data/' + meta.f;
    s.onload = function () {
      if (settled) return;
      settled = true; clearTimeout(timer);
      var d = window.__KBT__;
      try { delete window.__KBT__; } catch (e) { window.__KBT__ = null; }
      if (d) {
        for (var k in d) {
          var v = d[k];
          /* 不能用absTown(v)：它会读 v.t（乡镇列表）并缓存 v._abs；
             这里要的是「整个县域的全部乡镇外环」，
             两者结构不同，必须独立还原，且不能污染 v._abs——
             否则后续 townOf()/absTown() 拿到的是错的东西。 */
          var rings = [];
          for (var ti = 0; ti < v.t.length; ti++) {
            var o = v.t[ti];
            for (var ri = 0; ri < o.r.length; ri++) {
              var src = o.r[ri];
              if (!src || src.length < 3) continue;
              var dst = new Array(src.length);
              for (var pi = 0; pi < src.length; pi++) {
                dst[pi] = [src[pi][0] + v.b[0], src[pi][1] + v.b[1]];
              }
              rings.push(cleanSpikes(dst));
            }
          }
          CF[k] = { n: v.n, c: v.c || (/^\d+$/.test(k) ? Number(k) : 0), rings: rings, t: v.t, b: v.b };
          // 同步登记到 T：后续进入县/乡镇时 townOf() 直接命中，无需再发一次请求
          T[k] = v;
          tbHas[pc] = true;

          /* 新疆等省：乡镇数据的 key 是「省|地区|市」组合键且 c=0，
             与县界的标准码（650502）完全对不上 —— 导致 countyName() 返回
             null、pickCounty() 首行静默 return，用户点县「没反应」。
             这里用【县域 bbox 重叠最大】把 CF 条目挂到标准县码上：
             实测「65|哈密地区|哈密市」bbox 起点与「650502 伊州区」仅差 260m，
             重叠率 >99%，可安全判定为同一县。 */
          if (!v.c) {
            var nb = [v.b[0], v.b[1], v.b[0] + (v.w || 0), v.b[1] + (v.h || 0)];
            var bestCode = null, bestOv = 0;
            for (var ck in KB) {
              if (ck.slice(0, 2) !== pc) continue;
              var kb2 = KB[ck];
              if (!kb2 || !kb2.b) continue;
              var bb2 = kb2.b.length >= 4
                ? kb2.b
                : [kb2.b[0], kb2.b[1], kb2.b[0] + (kb2.w || 0), kb2.b[1] + (kb2.h || 0)];
              var ox = Math.min(nb[2], bb2[2]) - Math.max(nb[0], bb2[0]);
              var oy = Math.min(nb[3], bb2[3]) - Math.max(nb[1], bb2[1]);
              if (ox <= 0 || oy <= 0) continue;
              var ar = (ox * oy) / Math.max(1, nb[2] - nb[0]) / Math.max(1, nb[3] - nb[1]);
              if (ar > bestOv) { bestOv = ar; bestCode = ck; }
            }
            // 阈值 0.6：低于此不敢认定是同一县，宁可不映射也不挂错
            if (bestCode && bestOv > 0.6) {
              CF_BY_CODE[bestCode] = CF[k];
              CF[bestCode] = CF[k];
              CF[bestCode].c = Number(bestCode);
            }
          }
        }
        cfHas[pc] = true;
      }
      var list = cfLoading[pc] || []; cfLoading[pc] = null;
      list.forEach(function (f) { f(!!d); });
    };
    s.onerror = function () {
      if (settled) return;
      settled = true; clearTimeout(timer);
      var list = cfLoading[pc] || []; cfLoading[pc] = null;
      list.forEach(function (f) { f(false); });
    };
    document.head.appendChild(s);
  }

  // 把某省乡镇数据装载后，按省码取出全部县面
  function buildCountyFacesFromTown(provCode, cb) {
    countyFacesFromTown(provCode, function (ok) {
      if (!ok) return cb(false);
      var pc = String(provCode).slice(0, 2);
      var list = [];
      for (var k in CF) if (String(k).slice(0, 2) === pc && CF[k].rings && CF[k].rings.length) list.push(k);
      if (!list.length) return cb(false);
      N._cfList = list;
      var pv = GP.provinces.filter(function (x) { return x.c == provCode; })[0];
      if (pv) drawCountyFacesFromTown(pv, list);
      cb(true);
    });
  }

  function drawCountyFacesFromTown(pv, list) {
    DM.clearLayer(MI, 'base'); DM.clearBIZ(MI); DM.clearLayer(MI, 'lab'); DM.clearLayer(MI, 'risk');
    var st = MI.svg; if (st) st.pxAnchors = [];

    DM.area(MI, { n: pv.n, c: pv.c, r: abs(pv) },
      { fill: 'rgba(59,130,246,.04)', stroke: 'rgba(96,165,250,.55)', strokeWidth: 1.5 });

    var stops = layerStops(N.activeLayer);
    var bbox = null, placed = [];
    list.forEach(function (code) {
      var f = CF[code]; if (!f) return;
      var v = NAT.topicValue(N.activeLayer, code);
      var rgb = rgbOf(ramp(stops, v));
      DM.area(MI, { n: f.n, c: f.c || code, kind: 'county', r: f.rings }, {
        fill: 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',.60)',
        stroke: EDGE.city.c, strokeWidth: 1.1
      });
      if (st && st._vw > 620) {
        var ct = G.polyCentroid(f.rings);
        var px = st.toPx(ct[0], ct[1]);
        var hit = false;
        for (var j = 0; j < placed.length; j++) {
          var dx = placed[j][0] - px.x, dy = placed[j][1] - px.y;
          if (dx * dx + dy * dy < 46 * 46) { hit = true; break; }
        }
        if (!hit) {
          placed.push([px.x, px.y]);
          var el = DM.pxLabel(MI, 'lab', px.x, px.y, f.n,
            { fill: '#fff', size: 10, halo: 'rgba(3,8,18,.96)' });
          if (el) DM.anchor(MI, el, ct[0], ct[1], 0, null, true, 620);
        }
      }
      for (var i = 0; i < f.rings.length; i++) {
        var b = f.rings[i];
        var xs = b[0][0], ys = b[0][1], x1 = xs, y1 = ys;
        for (var j2 = 1; j2 < b.length; j2++) {
          if (b[j2][0] < xs) xs = b[j2][0];
          if (b[j2][0] > x1) x1 = b[j2][0];
          if (b[j2][1] < ys) ys = b[j2][1];
          if (b[j2][1] > y1) y1 = b[j2][1];
        }
        bbox = bbox ? [Math.min(bbox[0], xs), Math.min(bbox[1], ys), Math.max(bbox[2], x1), Math.max(bbox[3], y1)]
          : [xs, ys, x1, y1];
      }
    });

    // 灾点圈已挪到 DM.fit 之后绘制（toPx 需要新变换）
    if (bbox) DM.fit(MI, bbox);
    drawDisasterCircles();   // 必须在 fit 之后：否则 toPx 用的还是上一级变换
    var prings = abs(pv);
    renderRaster({
      layer: N.activeLayer, rings: prings, code: pv.c, pixelM: 700, alpha: .55,
      onStats: paintGrowthPanel,
      overlay: { rings: prings }
    });
    $('#nat-title').textContent = pv.n + ' · 县级遥感下钻';
    showCountyListHint(pv, list.length);
  }

  function showCountyListHint(pv, n) {
    var el = $('#nat-hint');
    if (!el) return;
    el.innerHTML = '<b>' + pv.n + '</b> · 已加载 <b>' + n + '</b> 个县区（由乡镇边界聚合）· <b>点击县区</b>查看乡镇级遥感影像';
    el.style.display = 'block'; el.style.opacity = '1';
    clearTimeout(el._t1); clearTimeout(el._t2);
    el._t1 = setTimeout(function () { el.style.opacity = '0'; }, 6500);
    el._t2 = setTimeout(function () { el.style.display = 'none'; }, 7000);
  }

  function drawProvinceOnly(pv) {
    DM.clearLayer(MI, 'base'); DM.clearBIZ(MI, ); DM.clearLayer(MI, 'lab'); DM.clearLayer(MI, 'risk');
    var st = MI.svg; if (st) st.pxAnchors = [];
    var info = NAT.provInfo(pv.c) || { risk: 3 };
    var rgb = rgbOf(riskColor(info.risk));
    DM.area(MI, { n: pv.n, c: pv.c, kind: 'prov', r: abs(pv) }, {
      fill: 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',.58)',
      stroke: EDGE.prov.c, strokeWidth: 1.8
    });
    var ct = G.polyCentroid(abs(pv));
    if (st && st._vw > 620) {
      var px = st.toPx(ct[0], ct[1]);
      var el = DM.pxLabel(MI, 'lab', px.x, px.y, shortName(pv.n), { fill: '#fff', size: 13, halo: 'rgba(3,8,18,.96)' });
      if (el) DM.anchor(MI, el, ct[0], ct[1]);
    }
    // 灾点圈已挪到 DM.fit 之后绘制（toPx 需要新变换）
    DM.fit(MI, abox(pv));
    drawDisasterCircles();   // 必须在 fit 之后：否则 toPx 用的还是上一级变换
    var pct2 = G.polyCentroid(abs(pv));
    renderRaster({
      layer: N.activeLayer, rings: abs(pv), code: pv.c, pixelM: 700, alpha: .46,
      onStats: paintGrowthPanel,
      overlay: { rings: abs(pv), labels: [[pct2[0], pct2[1], pv.n, '#fff', 15, 0]] }
    });
    paintCrumb();
  }

  function drawCities(pv, list) {
    DM.clearLayer(MI, 'base'); DM.clearBIZ(MI); DM.clearLayer(MI, 'lab'); DM.clearLayer(MI, 'risk');
    var st = MI.svg;
    if (st) st.pxAnchors = [];

    DM.area(MI, { n: pv.n, c: pv.c, r: abs(pv) },
      { fill: 'rgba(59,130,246,.04)', stroke: 'rgba(96,165,250,.55)', strokeWidth: 1.5 });

    var stops = layerStops(N.activeLayer);
    var bbox = null, placed = [];
    list.forEach(function (c) {
      var v = NAT.topicValue(N.activeLayer, c.c);
      var col;
      if (N.activeLayer === 'cover') col = 'rgb(59,130,246)';
      else if (N.activeLayer === 'disaster') col = 'rgb(248,113,113)';
      else col = ramp(stops, v);
      var rgb = rgbOf(col);
      DM.area(MI, { n: c.n, c: c.c, kind: 'city', r: abs(c) }, {
        fill: 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',.62)',
        stroke: EDGE.vill.c, strokeWidth: 1.05
      });
      if (st && st._vw > 620) {
        var ct = G.polyCentroid(abs(c));
        var px = st.toPx(ct[0], ct[1]);
        var hit = false;
        for (var k = 0; k < placed.length; k++) {
          var dx = placed[k][0] - px.x, dy = placed[k][1] - px.y;
          if (dx * dx + dy * dy < 48 * 48) { hit = true; break; }
        }
        if (!hit) {
          placed.push([px.x, px.y]);
          var el = DM.pxLabel(MI, 'lab', px.x, px.y, c.n, { fill: '#fff', size: 10.5, halo: 'rgba(3,8,18,.96)' });
          if (el) DM.anchor(MI, el, ct[0], ct[1], 0, null, true, 620);
        }
      }
      var b = abox(c);
      bbox = bbox ? [Math.min(bbox[0], b[0]), Math.min(bbox[1], b[1]), Math.max(bbox[2], b[2]), Math.max(bbox[3], b[3])] : b.slice();
    });

    // 灾点圈已挪到 DM.fit 之后绘制（toPx 需要新变换）
    DM.fit(MI, bbox);
    drawDisasterCircles();   // 必须在 fit 之后：否则 toPx 用的还是上一级变换
    var ovl2 = [];
    list.forEach(function (c) {
      var cc = G.polyCentroid(abs(c));
      ovl2.push([cc[0], cc[1], c.n.replace(/市|土家族苗族自治州|林区/g, ''), '#fff', 12, 0]);
    });
    renderRaster({
      layer: N.activeLayer, rings: null, code: pv.c, pixelM: 620, alpha: .55,
      onStats: paintGrowthPanel,
      overlay: { rings: null, labels: ovl2 }
    });
    paintCrumb();
  }

  /* ---------- 右上角「点选」入口 ----------
     香港/澳门/厦门/济源/苏州 这类区域按用户要求不显示文字
     （面积极小或紧邻他区，名字压在图上既看不清又挤占空间），
     但仍要能进去 —— 所以提供按名称直接下钻的入口。
     与地图点击走同一套pickProvince/pickCity/pickCounty，
     不另造逻辑，保证「点按钮进去」与「点图面进去」结果完全一致。

     列表随当前层级变化：
       全国 → 34 个省级（含香港/澳门，它们在这里仍可选）
       省级 → 该省全部地级市（厦门、苏州、济源在这里）
       市级 → 该市全部县区
       县级 → 该县全部乡镇
     屏蔽名单里若有当前层的项，仍照常列出（只是图上不画字）。 */
  var jumpPop = null;
  function jumpItems() {
    var out = [];
    if (N.level === 'country' || !N.curProvince) {
      out.push({ grp: '省级 · 点击进入' });
      GP.provinces.forEach(function (p) {
        out.push({ t: shortName(p.n), sub: p.n, act: function () { pickProvince(p.c); } });
      });
      return out;
    }
    var list = N.cityCache[N.curProvince] || [];
    if (N.level === 'province') {
      out.push({ grp: '地级市 · 点击进入' });
      if (!list.length) {
        /*市界数据还在路上（弱网/冷启动实测可达十几秒）。
           此时不能给一个空列表 —— 用户点开只看到标题、下面什么都没有，
           会以为功能坏了。如实说明并在数据到齐后自动重建。 */
        out.push({ pending: true });
        return out;
      }
      list.forEach(function (c) {
        out.push({ t: shortName(c.n), sub: c.n, act: function () { pickCity(c.c); } });
      });
      return out;
    }
    var pv = GP.provinces.filter(function (x) { return String(x.c) === String(N.curProvince); })[0];
    var cc = (N.level === 'city') ? N.curCity : N.curCounty;
    var cityObj = list.filter(function (x) { return String(cc).slice(0, 4) === String(x.c).slice(0, 4); })[0];
    if (N.level === 'city') {
      /* 省直辖县级行政区（如济源/仙桃）本级就是县，无下辖县区，
         此时列表里的其实是乡镇 —— 分组标题要跟着变，否则写着「县区」
         却列出一堆镇，用户会以为点错了。 */
      var selfIsCounty = !!(cityObj && String(cityObj.c) === String(N.curCounty));
      out.push({ grp: (cityObj ? shortName(cityObj.n) + ' · ' : '') +
        (selfIsCounty ? '乡镇 · 点击进入' : '县区 · 点击进入') });
      countyListOf().forEach(function (k) {
        /* 不展示裸 adcode —— 用户要的是地名，编码对它无意义 */
        out.push({ t: k.n, sub: '', act: function () { pickCounty(k.c); } });
      });
      return out;
    }
    /* 县级：列出乡镇 */
    out.push({ grp: '乡镇 · 点击进入' });
    var kb = KB[String(N.curCounty)] || { n: countyName(N.curCounty), c: String(N.curCounty) };
    var tf = townOf(N.curCounty, kb.n || countyName(N.curCounty) || '', cityObj ? cityObj.n : '');
    if (tf && tf.t) {
      tf.t.forEach(function (o, i) {
        out.push({ t: o.n, sub: '', act: function () {
          renderTown(pv, cityObj, kb, i, N.curCounty);
        } });
      });
    }
    return out;
  }

  /* 当前市级下辖的县区清单。
     ⚠️ 必须与 renderCity 画出的一致，否则「列表里有、图上点不到」或反之。
     KB（真实县界）与 CF（乡镇聚合）都是【异步填充】的：
     市级渲染完成时二者可能只到一部分，此时读快照会漏项
     （实测苏州图上 9 个县面，列表只列出 5 个 —— 因为读的是 KB 的瞬时快照）。

     正解：直接从 DOM 上已绘制的 path[data-kind="county"] 读取 ——
     它就是用户眼睛看到、鼠标能点到的集合，且已含 CF 兜底与混合绘制的结果。 */
  function countyListOf() {
    var out = [];
    if (!MI || !MI.svg || !MI.svg.host) return out;
    var seen = {};
    $$('#nat-map path[data-kind="county"]').forEach(function (p) {
      var c = p.getAttribute('data-id');
      var t = p.querySelector('title');
      var n = (t && t.textContent) || countyName(c) || c;
      if (c && !seen[c]) { seen[c] = 1; out.push({ n: n, c: c }); }
    });
    if (out.length) return out;
    /* 图上还没画（数据未到）时退回 KB/CF 快照，至少让用户看到名字 */
    var pv = GP.provinces.filter(function (x) { return String(x.c) === String(N.curProvince); })[0];
    var list = N.cityCache[N.curProvince] || [];
    var cc = (N.level === 'city') ? N.curCity : N.curCounty;
    var cityObj = list.filter(function (x) { return String(cc).slice(0, 4) === String(x.c).slice(0, 4); })[0];
    if (!cityObj) return out;
    var mc = String(cityObj.c);
    Object.keys(KB).forEach(function (c) {
      if (String(c) !== mc && String(c).slice(0, 4) === mc.slice(0, 4)) {
        out.push({ n: KB[c].n || countyName(c) || c, c: c });
      }
    });
    if (!out.length) {
      Object.keys(CF).forEach(function (c) {
        if (String(c) !== mc && String(c).slice(0, 4) === mc.slice(0, 4)) {
          out.push({ n: (CF[c] && CF[c].n) || countyName(c) || c, c: c });
        }
      });
    }
    return out;
  }

  function closeJump() {
    if (!jumpPop) return;
    jumpPop.hidden = true;
    var b = $('#nat-jump-btn');
    if (b) b.setAttribute('aria-expanded', 'false');
  }
  function buildJump() {
    var pop = $('#nat-jump-pop'), btn = $('#nat-jump-btn');
    if (!pop || !btn) return;
    jumpPop = pop;
    var items = jumpItems();
    if (!items.length) {
      pop.innerHTML = '<div class="nat-jump-empty">当前层级无可下钻项。<br>请先返回上一级。</div>';
      return;
    }
    /* 副标题只在【提供额外信息】时才显示。
       shortName('福州市')='福州'、sub='福州市' —— 直接并列会显示成
       「福州 福州市」这种同义重复（实测列表里 9 个福建市全是这个样子）。
       规则：sub 去掉尾部「市/县/区/地区/盟/州」后若与 t 相同，则不显示副标题。 */
    function subUseful(t, sub) {
      if (!sub || sub === t) return '';
      var bare = String(sub).replace(/(市|县|区|地区|盟|自治州|自治县|旗|盟|县|市辖区)$/g, '');
      if (bare === t || bare === String(t).replace(/(市|县|区)$/g, '')) return '';
      return sub;
    }
    var pending = items.some(function (it) { return it.pending; });
    if (pending) {
      pop.innerHTML = '<div class="nat-jump-grp">地级市</div>' +
        '<div class="nat-jump-empty">正在加载本市下辖区县数据…<br>' +
        '若持续无内容，请返回上级后重试（网络较慢时需数秒）。</div>';
      /* 数据到齐后自动重建，用户不用手动再点一次 */
      clearInterval(buildJump._t);
      var tries = 0;
      buildJump._t = setInterval(function () {
        if (tries++ > 40) { clearInterval(buildJump._t); return; }
        var l = N.cityCache[N.curProvince] || [];
        if (!l.length) return;
        clearInterval(buildJump._t);
        if (jumpPop && !jumpPop.hidden) { buildJump(); }
      }, 500);
      return;
    }
    pop.innerHTML = items.map(function (it, i) {
      if (it.grp) return '<div class="nat-jump-grp">' + it.grp + '</div>';
      var sb = subUseful(it.t, it.sub);
      return '<button type="button" data-j="' + i + '">' + it.t +
        (sb ? '<small>' + sb + '</small>' : '') + '</button>';
    }).join('');
    $$('#nat-jump-pop button').forEach(function (b) {
      b.addEventListener('click', function () {
        var it = items[Number(b.dataset.j)];
        closeJump();
        if (it && it.act) it.act();
      });
    });
  }

  function initJump() {
    var btn = $('#nat-jump-btn');
    if (!btn || btn._hooked) return;
    btn._hooked = true;
    /* 点地图任意处关闭。用 document 捕获阶段监听，
       但【不能】让按钮自己被它拦掉—— 所以这里判一下事件目标：
       命中按钮（或按钮内部元素）时直接 return，交给按钮自己的 handler。
       ⚠️ 实测踩坑：原先在按钮 handler 里调 e.stopPropagation()，
          而地图监听挂在祖先的捕获阶段 —— 捕获先于目标阶段执行，
          stopPropagation 拦不住它，于是点第二下时
          「按钮 handler 先展开 → 立刻又被地图监听 closeJump()」，
          表现为【点开后再点收不起来】（实测 3 次点击 open 恒为 true）。 */
    document.addEventListener('click', function (e) {
      if (btn.contains(e.target)) return;      // 点按钮本身不关
      var pop = $('#nat-jump-pop');
      if (pop && !pop.hidden && e.target.closest && e.target.closest('#nat-jump-pop')) return;
      closeJump();
    }, true);
    btn.addEventListener('click', function () {
      var pop = $('#nat-jump-pop');
      if (!pop) return;
      if (!pop.hidden) { closeJump(); return; }
      buildJump();
      pop.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeJump();
    });
  }

  /* ---------- 交互 ---------- */
  function pickProvince(code) {
    closeJump();
    var p = GP.provinces.filter(function (x) { return String(x.c) === String(code); })[0];
    if (p) renderProvince(p.c);
  }
  // 点市 → 进入市级（县级下钻）
  function pickCity(code) {
    closeJump();
    var pv = GP.provinces.filter(function (x) { return String(x.c) === String(N.curProvince); })[0];
    var list = N.cityCache[N.curProvince]; if (!pv || !list) return;
    var c = list.filter(function (x) { return String(x.c) === String(code); })[0];
    if (c) renderCity(pv, c);
  }
  // 点县 → 进入县级（大比例尺遥感长势影像）；已在该县时再点则出详情
  function pickCounty(code) {
    closeJump();
    var k = KB[String(code)];
    var kn = countyName(code);
    if (!kn) return;
    k = k || { n: kn, c: String(code) };
    k.c = k.c != null ? k.c : String(code);   // 县界数据无 c 字段，统一补上 adcode
    var pv = GP.provinces.filter(function (x) { return String(x.c) === String(N.curProvince); })[0];
    var list = N.cityCache[N.curProvince] || [];
    var cityObj = list.filter(function (x) { return String(code).slice(0, 4) === String(x.c).slice(0, 4); })[0];
    if (N.level === 'county' && String(N.curCounty) === String(code)) {
      showCountyInfo(k, cityObj, pv); return;
    }
    if (N.level === 'town' && String(N.curCounty) === String(code)) { renderCounty(pv, cityObj, code); return; }
    renderCounty(pv, cityObj, code);
  }

  // 乡镇拾取：县/乡镇视图下点乡镇 → 进入乡镇级大比例尺遥感
  function pickTown(code, ti) {
    var k = KB[String(code)];
    var kn = countyName(code); if (!kn) return;
    k = k || { n: kn, c: String(code) };
    var pv = GP.provinces.filter(function (x) { return String(x.c) === String(N.curProvince); })[0];
    var list = N.cityCache[N.curProvince] || [];
    var cityObj = list.filter(function (x) { return String(code).slice(0, 4) === String(x.c).slice(0, 4); })[0];
    var tf = townOf(code, kn, cityObj ? cityObj.n : '');
    if (!tf || !tf.t[ti]) { showCountyInfo(k, cityObj, pv); return; }
    if (N.level === 'town' && String(N.curCounty) === String(code) && Number(N.curTown) === Number(ti)) {
      showTownInfo(tf, ti, k, cityObj, pv, code); return;
    }
    renderTown(pv, cityObj, k, ti, code);
  }

  /* 点击村 → 村级视图（第 5 级）
     vi 为村在该乡镇桶内的下标，vk 为桶键 "<县码>-<乡镇下标>"。*/
  function pickVillage(code, ti, vi, vk) {
    var k = KB[String(code)];
    var kn = countyName(code); if (!kn) return;
    k = k || { n: kn, c: String(code) };
    var pv = GP.provinces.filter(function (x) { return String(x.c) === String(N.curProvince); })[0];
    var list = N.cityCache[N.curProvince] || [];
    var cityObj = list.filter(function (x) { return String(code).slice(0, 4) === String(x.c).slice(0, 4); })[0];
    var tf = townOf(code, kn, cityObj ? cityObj.n : '');
    if (!vk) vk = String(code) + '-' + ti;
    if (N.level === 'village' && String(N.curCounty) === String(code)
      && Number(N.curTown) === Number(ti) && String(N.curVillageKey) === String(vk)
      && Number(N.curVillage) === Number(vi)) {
      showVillageInfoByCode(code, ti, vi, vk, pv, cityObj, k); return;
    }
    renderVillage(pv, cityObj, k, ti, vi, vk, code);
  }

  function showVillageInfoByCode(code, ti, vi, vk, pv, cityObj, k) {
    var vv = V[String(code)];
    if (!vv || !vv.g[vk] || !vv.g[vk][vi]) return;
    var rings = absVill(vv)[vk][vi];
    if (!rings) return;
    var tf = townOf(code, countyName(code), cityObj ? cityObj.n : '');
    var townName = (tf && tf.t[ti]) ? tf.t[ti].n : '';
    showVillageInfo(vv.g[vk][vi], rings, ringBBox(rings), pv, cityObj, k, townName, code);
  }

  function showProvinceInfo(p) {
    var info = NAT.provInfo(p.c) || {};
    var d = NAT.disasterField(p.c);
    // 保费规模：已核实省份填真实值+来源；未核实省份显示「未核实」而非 0.0（避免误读为"零保费"）
    var premTxt = (info.prem === null || info.prem === undefined)
      ? '未核实（省级公开口径未获取）'
      : info.prem.toFixed(1) + ' 亿元';
    var rows = [
      ['行政区域', p.n], ['行政区划代码', p.c],
      ['耕地面积（参考值）', fmt(info.farm || 0, 0) + ' 千亩'],
      ['保费规模（2024公开数据）', premTxt],
      ['保费同比增速（2024）', (typeof info.growth === 'number')
        ? (info.growth > 0 ? '+' : '') + info.growth + '%'
        : '未获取'],
      ['综合成本率（模拟测算）', (info.cor || 0) + '%'],
      ['主导作物', info.crop || '—'],
      ['综合风险指数（模拟测算）', (info.risk || 3).toFixed(1)],
      ['主要灾种', info.haz || '—']
    ];
    if (d) rows.push(['当前灾情', d.name + ' · ' + d.level + '预警']);
    // 数据来源逐省标注（用户要求"规模信息必须准确有依据"）
    var srcHtml = info.src
      ? '<div class="note" style="margin-top:10px;padding:8px 10px;border-left:2px solid var(--brand);background:rgba(255,255,255,.03)">' +
        '<b>保费数据来源</b><br>' + info.src + '</div>'
      : '<div class="note" style="margin-top:10px;padding:8px 10px;border-left:2px solid #64748b;background:rgba(255,255,255,.03)">' +
        '<b>保费数据来源</b><br>该省 2024 年农险保费收入<b>尚未取得省级公开口径</b>，此处不显示数值，' +
        '以免以估算值误导判断。待补充官方数据后自动显示。</div>';
    window.__APP__.detail(p.n, '省级遥感概况 · 保费为公开数据／其余为模拟测算',
      rows.map(function (r) { return '<div class="kv"><span>' + r[0] + '</span><b>' + r[1] + '</b></div>'; }).join('') +
      srcHtml +
      '<div class="note" style="margin-top:10px"><b>下钻说明</b>：' + p.n +
      ((N._cfList && N._cfList.length)
        ? '本省已由<b>乡镇边界聚合出 ' + N._cfList.length + ' 个县区</b>，可直接点县区进入乡镇级遥感影像。'
        : '本省暂无市级边界数据，将由乡镇边界聚合出县区后下钻。') +
      '</div>' +
      '<div class="note warn" style="margin-top:8px"><b>数据口径</b>：业务指标为模拟测算演示数据，不代表阳光财险真实经营数据。</div>');
  }

  function showCityInfo(c, pcode) {
    var pv = GP.provinces.filter(function (p) { return p.c == pcode; })[0];
    var v = NAT.topicValue(N.activeLayer, c.c);
    var L = NAT.LAYERS[N.activeLayer];
    var d = NAT.disasterField(pcode);
    var ct = G.polyCentroid(abs(c));
    var html =
      '<div class="kv"><span>城市</span><b>' + c.n + '</b></div>' +
      '<div class="kv"><span>所属省份</span><b>' + (pv ? pv.n : pcode) + '</b></div>' +
      '<div class="kv"><span>行政区划代码</span><b>' + c.c + '</b></div>' +
      '<div class="kv"><span>中心经纬度</span><b>' + G.yToLat(ct[1]).toFixed(3) + '°N, ' + G.xToLng(ct[0]).toFixed(3) + '°E</b></div>' +
      '<div class="dt-sub">' + (L ? L.name : '遥感专题') + '</div>' +
      '<div class="kv"><span>专题值</span><b>' + (v * 100).toFixed(0) + ' / 100</b></div>' +
      '<div class="bar"><i style="width:' + (v * 100).toFixed(0) + '%;background:' + ramp(layerStops(N.activeLayer), v) + '"></i></div>' +
      (L ? '<div class="note" style="margin-top:9px"><b>指标说明</b>：' + L.desc + '<br><b>数据来源</b>：' + L.source + '</div>' : '') +
      (d ? '<div class="note warn" style="margin-top:8px"><b>当前灾情</b>：' + d.name + ' ' + d.level + '预警，影响范围含本省</div>' : '') +
      '<div class="note warn" style="margin-top:8px"><b>演示数据</b>：专题值为按区域代码生成的稳定模拟值，用于演示图层渲染，不代表实际遥感监测结果。</div>';
    window.__APP__.detail(c.n + ' · 遥感专题', (pv ? pv.n : '') + ' · 模拟测算', html);
  }

  /* ---------- 面板 ---------- */
  function buildLayerPanel() {
    var keys = Object.keys(NAT.LAYERS);
    var TAG = { ndvi: 'tag-green', drought: 'tag-orange', flood: 'tag-blue', hail: 'tag-purple',
      biomass: 'tag-green', gdd: 'tag-yellow', soilMoisture: 'tag-teal', lst: 'tag-red' };
    // 遥感观测类专题（栅格影像）放一组；业务分级类（矢量色块）另置一组，避免混淆口径
    var rsItems = keys.map(function (k) {
      var L = NAT.LAYERS[k];
      return '<div class="row lay' + (k === 'ndvi' ? ' on' : '') + '" data-lay="' + k + '">' +
        '<div class="row-h"><div class="row-t">' + L.name + '</div>' +
        '<span class="tag ' + (TAG[k] || 'tag-grey') + '">' + (k === 'ndvi' ? '推荐' : '遥感') + '</span></div>' +
        '<div class="row-m"><span class="ell">' + L.desc + '</span></div></div>';
    }).join('');
    var bizItems =
      '<div class="row lay" data-lay="cover"><div class="row-h"><div class="row-t">承保热力分布</div><span class="tag tag-yellow">业务</span></div>' +
      '<div class="row-m"><span>按保费规模分级渲染（矢量）</span></div></div>' +
      '<div class="row lay" data-lay="disaster"><div class="row-h"><div class="row-t">灾情分布场</div><span class="tag tag-red">业务</span></div>' +
      '<div class="row-m"><span>在监预警影响范围（矢量）</span></div></div>';
    $('#nat-layers').innerHTML =
      '<div class="lay-group">遥感观测专题 · 切换后为遥感影像</div>' + rsItems +
      '<div class="lay-group">业务分级专题 · 切换后为矢量色块</div>' + bizItems;

    $$('#nat-layers .lay').forEach(function (el) {
      el.addEventListener('click', function () {
        $$('#nat-layers .lay').forEach(function (x) { x.classList.remove('on'); });
        el.classList.add('on');
        N.activeLayer = el.dataset.lay;
        buildLegend();
        // 详情抽屉是打开那一刻的快照，切换专题后其内容已与地图不一致，
        // 留着会让人误以为「地图没换专题」。直接收起，重新点要素即可看到新专题详情。
        if (window.__APP__ && window.__APP__.closeDetail) window.__APP__.closeDetail();
        redrawCurrent();
      });
    });

    // 栅格/矢量影像开关
    var rg = $('#nat-raster-toggle');
    if (rg) rg.addEventListener('click', function () {
      N.rasterOn = !N.rasterOn;
      rg.classList.toggle('off', !N.rasterOn);
      rg.querySelector('span').textContent = N.rasterOn ? '影像' : '纯矢量';
      applyRasterMode();
      if (N.rasterOn) redrawCurrent();
      else {
        if (RS) { Object.keys(RS.layers).forEach(function (k) { RS.setVisible(k, false); }); }
        paintGrowthPanel(null);
      }
    });
  }

  /* 栅格影像模式：给容器加 has-raster，让 SVG 层背景透明
     —— 否则 z-index 更高的 SVG 层不透明底色会把栅格整片盖住 */
  function applyRasterMode() {
    var host = $('#nat-map');
    if (!host) return;
    var on = N.rasterOn && !!rasterFor(N.activeLayer);
    host.classList.toggle('has-raster', on);
    if (MI && MI.host) MI.host.classList.toggle('has-raster', on);
  }

  // 按当前层级重绘
  function redrawCurrent() {
    var pv0 = GP.provinces.filter(function (x) { return String(x.c) === String(N.curProvince); })[0];
    var list0 = N.cityCache[N.curProvince] || [];
    if ((N.level === 'town' || N.level === 'village') && N.curCounty != null && N.curTown != null) {
      var kn0 = countyName(N.curCounty);
      var k0 = KB[String(N.curCounty)] || { n: kn0, c: String(N.curCounty) };
      var co0 = list0.filter(function (x) {
        return String(N.curCounty).slice(0, 4) === String(x.c).slice(0, 4);
      })[0];
      if (kn0) {
        if (N.level === 'village' && N.curVillage != null) {
          renderVillage(pv0, co0, k0, N.curTown, N.curVillage,
            N.curVillageKey || (String(N.curCounty) + '-' + N.curTown), N.curCounty);
        } else {
          renderTown(pv0, co0, k0, N.curTown, N.curCounty);
        }
        return;
      }
    }
    if (N.level === 'county' && N.curCounty) {
      var pv = pv0;
      var cityObj = list0.filter(function (x) {
        return String(N.curCounty).slice(0, 4) === String(x.c).slice(0, 4);
      })[0];
      if (countyName(N.curCounty)) { renderCounty(pv, cityObj, N.curCounty); return; }
    }
    if (N.level === 'city' && N.curCity) {
      var c2 = list0.filter(function (x) { return String(x.c) === String(N.curCity); })[0];
      if (pv0 && c2) { renderCity(pv0, c2); return; }
    }
    if (N.level === 'province' && N.curProvince) { renderProvince(N.curProvince); return; }
    renderCountry();
  }

  function buildLegend() {
    var k = N.activeLayer;
    if (k === 'cover') {
      // 只统计有真实值的省，避免把"未核实"当成 0 拉低/拉高色阶
      var ps = Object.keys(NAT.PROV)
        .map(function (c) { return NAT.PROV[c].prem; })
        .filter(function (v) { return typeof v === 'number' && v > 0; });
      if (!ps.length) {
        $('#nat-legend').innerHTML = '<div class="note">暂无可溯源的保费规模数据</div>';
        return;
      }
      var lo = Math.min.apply(null, ps), hi = Math.max.apply(null, ps);
      $('#nat-legend').innerHTML =
        '<div class="lg-row" style="cursor:default"><span class="lg-sw" style="background:linear-gradient(90deg,#1e3a5f,#f87171)"></span><span>保费规模</span></div>' +
        '<div class="row-m" style="padding:4px 7px"><span>低 <b>' + lo.toFixed(1) + '亿</b></span>' +
        '<span style="margin-left:auto">高 <b>' + hi.toFixed(1) + '亿</b></span></div>' +
        '<div class="note" style="margin-top:8px;font-size:10.5px">按<b>已核实公开数据</b>分级渲染（2024年省级农险保费收入，共 ' +
        ps.length + ' 省），仅用于识别业务集中区；未核实省份不着色。</div>';
      return;
    }
    if (k === 'disaster') {
      $('#nat-legend').innerHTML = NAT.DISASTERS.map(function (d) {
        var cls = { '红色': 'tag-red', '橙色': 'tag-orange', '黄色': 'tag-yellow', '蓝色': 'tag-blue' }[d.level];
        return '<div class="lg-row" style="cursor:default"><span class="lg-sw" style="background:rgba(248,113,113,.5);border-radius:50%"></span>' +
          '<span>' + d.name + '</span><span class="' + cls + '" style="margin-left:auto;font-size:10px">' + d.level + '</span></div>';
      }).join('');
      return;
    }
    var L = NAT.LAYERS[k]; if (!L) return;
    $('#nat-legend').innerHTML = L.legend.map(function (l) {
      return '<div class="lg-row" style="cursor:default"><span class="lg-sw" style="background:' + l.c + '"></span>' +
        '<span>' + (l.d || l.t) + '</span><span class="lg-n">' + l.t + '</span></div>';
    }).join('') +
      '<div class="note" style="margin-top:9px;font-size:10.5px"><b>' + L.name + '</b>：' + L.desc + '<br>数据来源：' + L.source + '</div>';
  }

  function buildProvinceRank() {
    // 仅列出有真实保费数据的省；未核实的不参与排名（宁缺毋滥）
    var arr = GP.provinces.map(function (p) {
      return { n: p.n, c: p.c, info: NAT.provInfo(p.c) || { prem: null, risk: 3, cor: 0 } };
    }).filter(function (x) { return typeof x.info.prem === 'number' && x.info.prem > 0; });

    if (!arr.length) {
      $('#nat-rank').innerHTML = '<div class="note">暂无可溯源的保费规模数据</div>';
      $('#nat-rank-tabs').innerHTML = '';
      return;
    }

    var tabs = [['prem', '保费规模'], ['growth', '保费增速'], ['cor', '综合成本率'], ['risk', '风险指数']];
    $('#nat-rank-tabs').innerHTML = tabs.map(function (t, i) {
      return '<span class="rk-tab' + (i === 0 ? ' on' : '') + '" data-k="' + t[0] + '">' + t[1] + '</span>';
    }).join('');

    function paint(k) {
      // 增速可能为负：排序与条长均按绝对值处理（增长与萎缩都值得关注）
      var isG = (k === 'growth');
      var pool = isG ? GP.provinces.map(function (p) {
        var inf = NAT.provInfo(p.c);
        return (inf && typeof inf.growth === 'number')
          ? { n: p.n, c: p.c, info: inf } : null;
      }).filter(Boolean) : arr;
      if (!pool.length) {
        $('#nat-rank').innerHTML = '<div class="note">暂无该指标数据</div>';
        return;
      }
      var s = pool.slice().sort(function (a, b) {
        return Math.abs(b.info[k]) - Math.abs(a.info[k]);
      }).slice(0, 12);
      var mxa = s.reduce(function (m, x) { return Math.max(m, Math.abs(x.info[k])); }, 1);
      $('#nat-rank').innerHTML = s.map(function (x) {
        var w = (Math.abs(x.info[k]) / mxa * 100).toFixed(0);
        var col, v;
        if (k === 'growth') {
          col = x.info.growth >= 0
            ? 'linear-gradient(90deg,#34d399,#22c55e)'
            : 'linear-gradient(90deg,#f87171,#ef4444)';
          v = (x.info.growth > 0 ? '+' : '') + x.info.growth + '%';
        } else if (k === 'cor') {
          col = x.info.cor >= 85 ? '#f87171' : x.info.cor >= 80 ? '#fb923c' : '#34d399';
          v = x.info.cor + '%';
        } else if (k === 'risk') {
          col = riskColor(x.info.risk);
          v = x.info.risk.toFixed(1);
        } else {
          col = 'linear-gradient(90deg,#3b82f6,#22d3ee)';
          v = x.info.prem.toFixed(1) + '亿';
        }
        // 数据溯源：保费/增速为公开数据（悬停看来源）；COR/风险指数为模拟测算
        var tip = '';
        if (k === 'prem') {
          tip = ' title="' + (x.info.src || '省级公开口径未获取，暂不参与排名').replace(/"/g, '&quot;') + '"';
        } else if (k === 'growth') {
          tip = ' title="' + (NAT.GROWTH_SRC || '2024年各地区农业保险保费同比增速').replace(/"/g, '&quot;') + '"';
        }
        var mark = (k === 'cor' || k === 'risk')
          ? '<span style="font-size:9px;opacity:.6;margin-left:4px">模拟测算</span>' : '';
        return '<div class="hbar" data-code="' + x.c + '" style="cursor:pointer"' + tip + '>' +
          '<div class="hbar-n">' + x.n + '</div>' +
          '<div class="hbar-t"><i style="width:' + w + '%;background:' + col + '"></i></div>' +
          '<div class="hbar-v">' + v + mark + '</div></div>';
      }).join('');
      // 各 tab 的口径说明（区分公开数据与模拟测算）
      if (k === 'prem') {
        $('#nat-rank').innerHTML += '<div class="note" style="font-size:10px;margin-top:8px;line-height:1.6">' +
          '数据口径：<b>2024年省级农业保险保费收入</b>，取自各省财政厅/农业农村厅/统计公报/金融监管局公开披露；' +
          '悬停条目可查看该省具体来源。仅列已核实省份，' + arr.length + ' 个省。</div>';
      } else if (k === 'growth') {
        $('#nat-rank').innerHTML += '<div class="note" style="font-size:10px;margin-top:8px;line-height:1.6">' +
          '数据口径：<b>2024年各地区农业保险保费同比增速</b>（行业研报整理，覆盖31 地区）。' +
          '<b>绿色为增长、红色为负增长</b>——负增长省份市场收缩，需重点关注。' +
          '注：增速为相对值，与下方「保费规模」（绝对值）口径不同，不可直接相加比较。</div>';
      }
      $$('#nat-rank .hbar').forEach(function (el) {
        el.addEventListener('click', function () { pickProvince(el.dataset.code); });
      });
    }
    paint('prem');
    $$('#nat-rank-tabs .rk-tab').forEach(function (t) {
      t.addEventListener('click', function () {
        $$('#nat-rank-tabs .rk-tab').forEach(function (x) { x.classList.remove('on'); });
        t.classList.add('on'); paint(t.dataset.k);
      });
    });
  }

  function buildStats() {
    var s = NAT.provSummary();
    var cityN = CITY_IDX.reduce(function (a, g) { return a + g.c; }, 0);
    $('#nat-kpi').innerHTML =
      kcard('纳入省级', String(GP.provinces.length), '个', '全覆盖', '#3b82f6') +
      kcard('市级下钻', String(cityN), '个', CITY_IDX.length + ' 个农业大省', '#34d399') +
      kcard('耕地面积', wan(s.farm), '万亩', '模拟测算', '#ffd35a') +
      kcard('平均成本率', s.cor.toFixed(1), '%', '健康线<85%', s.cor < 85 ? '#34d399' : '#fb923c');
  }
  function kcard(l, v, u, d, c) {
    return '<div class="kpi" style="--c:' + c + '"><div class="kpi-l">' + l + '</div>' +
      '<div class="kpi-v">' + v + '<small>' + u + '</small></div><div class="kpi-d">' + d + '</div></div>';
  }

  function buildDisasterList() {
    $('#nat-disasters').innerHTML = NAT.DISASTERS.map(function (d) {
      var cls = { '红色': 'tag-red', '橙色': 'tag-orange', '黄色': 'tag-yellow', '蓝色': 'tag-blue' }[d.level];
      return '<div class="row"><div class="row-h"><div class="row-t">' + d.name + '</div>' +
        '<span class="tag ' + cls + '">' + d.level + '</span></div>' +
        '<div class="row-m"><span>' + d.region + '</span></div>' +
        '<div class="row-m"><span>农户 <b>' + fmt(d.farmers, 0) + '</b></span>' +
        '<span>涉及 <b>' + wan(d.mu) + '万亩</b></span><span>损失 <b>' + d.loss + '亿</b></span></div></div>';
    }).join('');
  }

  function setEngine(ok, text) {
    var e = $('#nat-engine'); if (!e) return;
    e.textContent = text; e.className = ok ? 'engine-ok' : 'engine-warn';
  }

  window.__NAT_VIEW__ = {
    init: init, render: function () { DM.resize(MI); }, state: N,
    renderCountry: renderCountry, renderProvince: renderProvince,
    renderCity: renderCity, renderCounty: renderCounty,
    pickProvince: pickProvince, pickCity: pickCity, pickCounty: pickCounty,
    showProvinceInfo: showProvinceInfo,
    /* 补齐各级详情与真实S2 相关函数导出。
       此前只导出省级详情，导致县级/乡镇级详情无法被自动化核验
       （本轮想核验"县级真实反演详情"时才发现）。 */
    showCountyInfo: showCountyInfo,
    showTownInfo: showTownInfo,
    showVillageInfo: showVillageInfo,
    s2Of: s2Of,
    s2Caliber: s2Caliber,
    redraw: redrawCurrent
  };
})();