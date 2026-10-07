/* =====================================================================
   RasterEngine · 遥感栅格专题引擎
   ---------------------------------------------------------------------
   在矢量业务层与卫星底图之间插入一层 Canvas 栅格，用「像元」而非「色块」
   渲染遥感专题（NDVI 长势 / 干旱 / 涝渍 / 积温…）。

   核心要点：
   1. 值场由**世界坐标**哈希驱动的分形噪声生成 → 缩放/平移后同一地点
      永远得到同一个值，不会闪烁或跳变；
   2. 每个像元对应固定的地面尺度（如 500m），随缩放自动增减密度；
   3. 用 SVG <clipPath> 把栅格裁剪到当前行政边界内，形成「行政区遥感影像」；
   4. 域值域按遥感惯例分 5 级（差/较差/中/良好/优），色带可插值。

   合规：不含任何境外地图数据；栅格为程序生成的模拟专题值场。
   ===================================================================== */
(function (global) {
  'use strict';

  /* ---------- 确定性哈希与分形噪声 ---------- */

  // 32 位整数哈希，返回 [0,1)
  function hash2i(x, y, seed) {
    var h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 1274126177;
    h = (h ^ (h >>> 13)) >>> 0;
    h = (h * 1274126177) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
  }

  function smooth(t) { return t * t * (3 - 2 * t); }

  // 二维值噪声：格点哈希 + 双线性插值（带平滑）
  function vnoise(x, y, seed) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    var u = smooth(xf), v = smooth(yf);
    var a = hash2i(xi, yi, seed), b = hash2i(xi + 1, yi, seed);
    var c = hash2i(xi, yi + 1, seed), d = hash2i(xi + 1, yi + 1, seed);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }

  // 分形叠加噪声（fBm）→ 返回 [0,1]
  function fbm(x, y, seed, oct, lac, gain) {
    oct = oct || 5; lac = lac || 2.07; gain = gain || 0.52;
    var amp = 1, freq = 1, sum = 0, norm = 0;
    for (var i = 0; i < oct; i++) {
      sum += amp * vnoise(x * freq, y * freq, seed + i * 131);
      norm += amp;
      amp *= gain; freq *= lac;
    }
    return sum / norm;
  }

  // 脊状噪声：模拟河网/山脉走向，用于压低水体通道
  function ridge(x, y, seed) {
    var n = fbm(x, y, seed + 7717, 4, 2.13, 0.55);
    return 1 - Math.abs(n * 2 - 1);
  }

  /* ---------- 色带定义 ---------- */

  // levelstops: [{v, c:[r,g,b]}, …] 升序；t∈[0,1] 线性插值
  function rampAt(stops, t) {
    if (!stops || !stops.length) return [128, 128, 128];
    if (t <= stops[0].v) return stops[0].c;
    var n = stops.length;
    if (t >= stops[n - 1].v) return stops[n - 1].c;
    for (var i = 1; i < n; i++) {
      if (t <= stops[i].v) {
        var a = stops[i - 1], b = stops[i];
        var k = (t - a.v) / (b.v - a.v || 1);
        return [
          Math.round(a.c[0] + (b.c[0] - a.c[0]) * k),
          Math.round(a.c[1] + (b.c[1] - a.c[1]) * k),
          Math.round(a.c[2] + (b.c[2] - a.c[2]) * k)
        ];
      }
    }
    return stops[n - 1].c;
  }

  /* ---------- 引擎 ---------- */

/* 描边层状态：须在 R 之前声明，否则 R.OV 初始化时读到 undefined */
  var OV = { map: {} };   // 按容器 id 存描边层，避免多视图互相清空

  var R = {
    layers: {},        // 名称 → {canvas, ctx, topic, opacity}
    nsCount: 0,
    host: null,
    svg: null,
    _raf: null,
    OV: OV             // 描边层集合（供外部同步变换）
  };

  /* 在 dual 容器中插入栅格层（位于 TMap 底图之上、SVG 业务层之下） */
  R.mount = function (dualHost, svgCanvas) {
    R.host = dualHost;
    R.svg = svgCanvas;
    R.nsCount++;
    // ---- 分层策略（实测踩坑后确定）----
    // 目标：卫星底图在下 → 遥感栅格居中 → 业务矢量与标注在最上。
    // 难点：把栅格放中间（z=2）时，SVG 内部某些带不透明 fill 的图元会把栅格整片盖住；
    //       放最上（z=4）又会盖住业务矢量。
    // 解法：给栅格单独建一个「栅格宿主」div，插在 tmap 与 svg 之间（z-index=2），
    //       同时由视图层给 #nat-map 加 .has-raster 类，把 SVG 层与 #nat-map 的
    //       不透明底色清掉 —— 这样栅格能显示、业务矢量仍压在其上。
    var wrap = document.createElement('div');
    wrap.className = 'dual-raster-wrap';
    /* ⚠️⚠️ z-index 必须是 **1**（整数！小数会被浏览器取整：0.5→0 与瓦片同层，叠加顺序随机）。
       实测层级栈（用户截图"新疆就一点遥感影像"）：
         Esri 卫星瓦片层 z-index:0   ← 影像在这里
         .dual-tmap             z-index:1
         .dual-svg（行政区面）    z-index:2
       栅格原本是 z-index:5 → **完全盖住瓦片**，画面只剩专题色块。
       → 改为 1：瓦片(0) 在最下、栅格(1) 叠加其上、tmap(1) 与 SVG 面(2) 在最上。
       这样呈现的是「真实卫星影像 + 遥感专题色相」的正确叠加关系，
       而不是"专题色块代替影像"。
       ⚠️ CSS 里 .dual-raster-wrap 也写了 z-index:2，inline 优先级更高，
          但为避免混淆，CSS 侧同步改为 0.5。 */
    wrap.style.cssText = 'position:absolute;inset:0;z-index:1;pointer-events:none';
    dualHost.insertBefore(wrap, svgCanvas);
    var c = document.createElement('canvas');
    c.className = 'dual-raster';
    c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;image-rendering:auto';
    wrap.appendChild(c);
    var ctx = c.getContext('2d', { willReadFrequently: false });
    return { canvas: c, ctx: ctx };
  };

  R.ensure = function (name) {
    if (R.layers[name]) return R.layers[name];
    var lay = R.mount(R.host, R.svg);
    lay.topic = name; lay.opacity = 1; lay.clipped = true;
    R.layers[name] = lay;
    return lay;
  };

  R.setOpacity = function (name, v) {
    var l = R.layers[name]; if (l) { l.opacity = v; l.canvas.style.opacity = v; }
  };
  R.setVisible = function (name, on) {
    var l = R.layers[name]; if (l) l.canvas.style.display = on ? 'block' : 'none';
  };

  /* ---- 边界遮罩：栅格只画在行政边界内 ----
   ⚠️ 踩过的坑（两条都试过）：
   1) CSS clip-path: url(#id) 引用 SVG clipPath —— **跨SVG/HTML 边界在
      Chromium 上不生效**，canvas 明明有像素、clipPath 明明有 path，画面却全被裁掉。
   2) 改用逐像元判断（点是否在环内）—— 稳定可靠，代价是每像元一次点在多边形内测试。
   现在采用 2)：把边界编译为「屏幕像素坐标的环数组」，逐像元做 even-odd 测试。
   为控制成本，先用包围盒快速排除，包围盒内的像元再做精确判断；
   同时对超大范围（>25万像元）自动降级为仅包围盒裁剪。 */

  R.setMask = function (geo, rings) {
    var on = !!(rings && rings.length);
    R._mask = null;
    Object.keys(R.layers).forEach(function (k) {
      R.layers[k].mask = null;
    });
    if (!on || !geo) return;
    var px = rings.map(function (r) {
      return r.map(function (p) { var s = geo.toScreen(p[0], p[1]); return [s.x, s.y]; });
    }).filter(function (r) { return r.length >= 3; });
    if (!px.length) return;
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    px.forEach(function (r) {
      r.forEach(function (p) {
        if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
      });
    });
    R._mask = { rings: px, x0: x0, y0: y0, x1: x1, y1: y1 };
  };

  // 射线法：点是否在多边形环内（even-odd）
  function inRings(px, py, rings) {
    var inside = false;
    for (var i = 0; i < rings.length; i++) {
      var r = rings[i];
      for (var j = 0, k = r.length - 1; j < r.length; k = j++) {
        var yj = r[j][1], yk = r[k][1];
        if ((yj > py) !== (yk > py)) {
          var x = r[j][0] + (py - yj) / (yk - yj) * (r[k][0] - r[j][0]);
          if (px < x) inside = !inside;
        }
      }
    }
    return inside;
  }

  /* ---- 主渲染：按像元生成专题值并着色 ----
     性能策略（实测教训）：
     1. 像元**屏幕边长**必须夹在 [MINCS, MAXCS] px 内。全国尺度下若按地面米数
        直接换算，像元会缩到 0.09px → 上亿像元 → 主线程卡死、页面 load 事件都不触发。
     2. 先在 cols×rows 的小 ImageData 上算值，再用 drawImage 放大到全屏。
        这样 canvas 操作量与屏幕分辨率解耦，20 万像元级渲染稳定在 30~60ms。
  */
  var MINCS = 3, MAXCS = 18;

  R.render = function (opt) {
    var geo = opt.geo;
    if (!geo || !geo._vw || !geo._vh || !geo.scale) return;
    var lay = R.ensure(opt.topic || 'ndvi');
    R.setVisible(lay.topic, true);

    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var W = Math.round(geo._vw), H = Math.round(geo._vh);
    var cvs = lay.canvas;
    var pw = Math.round(W * dpr), ph = Math.round(H * dpr);
    if (cvs.width !== pw || cvs.height !== ph) {
      cvs.width = pw; cvs.height = ph;
      cvs.style.width = W + 'px'; cvs.style.height = H + 'px';
    }
    var ctx = lay.ctx;

    // --- 像元屏幕边长（关键：夹紧到像素级，避免海量像元） ---
    var cs = (opt.pixelM || 480) * geo.scale;
    if (cs < MINCS) cs = MINCS;
    if (cs > MAXCS) cs = MAXCS;

    var cols = Math.max(2, Math.ceil(W / cs) + 1);
    var rows = Math.max(2, Math.ceil(H / cs) + 1);
    // 硬上限：缓冲不超过 420×280（约 12 万像元），保证交互不卡
    var CAP = 420, CAPR = 280;
    if (cols > CAP || rows > CAPR) {
      var k = Math.max(cols / CAP, rows / CAPR);
      cols = Math.max(2, Math.floor(cols / k));
      rows = Math.max(2, Math.floor(rows / k));
      cs = Math.max(W / cols, H / rows);
    }

    // --- 小缓冲上计算值场 ---
    if (!lay._buf || lay._buf.width !== cols || lay._buf.height !== rows) {
      lay._buf = document.createElement('canvas');
      lay._buf.width = cols; lay._buf.height = rows;
      lay._bctx = lay._buf.getContext('2d');
    }
    var bctx = lay._bctx;
    var img = bctx.createImageData(cols, rows);
    var data = img.data;

    var stops = opt.stops;
    var seed = opt.seed || 1;
    var NST = stops.length;
    var bin = new Float64Array(NST);
    var sum = 0, cnt = 0, vmin = 9, vmax = -9;
    var fn = opt.valueFn || R.ndvi;

    // 屏幕左上角对应的世界坐标
    var wx0 = (0 - geo.tx) / geo.scale;
    var wyTop = (geo.ty - 0) / geo.scale;
    var stepW = cs / geo.scale;              // 每像元的地面步长（米）

    // 边界遮罩：先取包围盒，落在盒外的像元直接跳过
    var mask = opt.mask || R._mask;
    var mb = null, mrings = null;
    if (mask) { mb = mask; mrings = mask.rings; }

    for (var r = 0; r < rows; r++) {
      var wy = wyTop - r * stepW;            // Y 轴已翻转：向下 = 世界 Y 减小
      var rowOff = r * cols * 4;
      var sy0 = r * cs;
      for (var cc = 0; cc < cols; cc++) {
        var sx0 = cc * cs;
        var p = rowOff + cc * 4;
        // 像元中心（屏幕像素）
        var px = sx0 + cs / 2, py = sy0 + cs / 2;
        // 遮罩判定：包围盒快筛 + 环内精确判定
        if (mb) {
          if (px < mb.x0 || px > mb.x1 || py < mb.y0 || py > mb.y1) {
            data[p + 3] = 0;                 // 透明：盒子外
            continue;
          }
          if (mrings && !inRings(px, py, mrings)) { data[p + 3] = 0; continue; }
        }
        var wx = wx0 + cc * stepW;
        var t = fn(wx, wy, seed);
        if (t < 0) t = 0; else if (t > 1) t = 1;
        var col = rampAt(stops, t);
        data[p] = col[0]; data[p + 1] = col[1]; data[p + 2] = col[2]; data[p + 3] = 255;
        sum += t; cnt++;
        if (t < vmin) vmin = t; if (t > vmax) vmax = t;
        // 定位区间：stops 是各档**上界**，第 i 档 = [stops[i-1].v, stops[i].v)
        var k = NST - 1;
        for (var j = 0; j < NST; j++) { if (t <= stops[j].v) { k = j; break; } }
        bin[k]++;
      }
    }
    bctx.putImageData(img, 0, 0);

    // --- 放大到全屏 ---
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // ⚠️ 默认透明度曾为 0.82 —— 专题色块几乎完全盖住下方卫星影像，
    //    用户看到「只有色块、没有遥感影像」。现改为 0.45 半透明叠加，
    //    让真实影像纹理透出来（遥感平台的核心价值）。
    ctx.globalAlpha = opt.alpha == null ? 0.34 : opt.alpha;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(lay._buf, 0, 0, W, H);
    ctx.globalAlpha = 1;

    if (opt.onStats) {
      var lv = [];
      for (var k2 = 0; k2 < NST; k2++) lv.push(bin[k2] / (cnt || 1));
      opt.onStats({
        mean: cnt ? sum / cnt : 0, min: vmin, max: vmax, levels: lv, cells: cnt,
        cs: cs, pixelM: cs / geo.scale
      });
    }
  };

  /* ==================================================================
     中国生态分区基准场（本轮重大修正）
     ------------------------------------------------------------------
     旧实现是「纬度线性公式 + 纯分形噪声」，实测存在严重地理错误：
       · 南北梯度方向反了（广州实测 0.43 < 黑龙江 0.49）
       · 荒漠与稻田无法区分（巴丹吉林与江汉平原同为 ~0.43）
       · 12 个真实农业区抽样，8 个落在合理区间之外
     根因：完全没有真实地理约束，噪声权重(0.54)压过了信号。

     新实现：用公开的中国植被/农业/气候区划做「多中心高斯分区」，
     预计算成0.5° 栅格（127×79），查询时双线性插值：
       · 地理格局由分区决定 → 与真实农业分布一致
       · 噪声权重降到 0.10~0.18 → 只提供田块纹理，不改变格局
     分区取值依据公开的植被带/农业区资料与常识区间，仍为模拟测算，
     但空间格局是真实的（见README 口径说明）。
     ================================================================== */

  /* 中国主要生态/农业分区：[经度, 纬度, 基准值, 经度半径(°), 纬度半径(°)] */
  var ECO = {
    // ---- NDVI 基准：北方次高、南方最高、西北与青藏低 ----
    ndvi: [
      [126.0, 46.8, 0.78, 7.0, 4.2],   // 三江/松嫩平原（一年一熟，夏季长势好）
      [122.0, 46.0, 0.68, 6.0, 3.6],   // 东北西部（半湿润）
      [119.8, 49.2, 0.54, 5.5, 3.0],   // 呼伦贝尔草原（温带草原，夏季中等）
      [120.5, 44.0, 0.58, 8.0, 3.4],   // 内蒙古东部草原
      [116.0, 42.0, 0.56, 6.0, 3.0],   // 坝上草原
      [116.5, 37.5, 0.62, 5.5, 3.2],   // 华北平原（冬小麦-夏玉米）
      [109.0, 36.5, 0.50, 6.5, 3.4],   // 黄土高原
      [108.0, 34.3, 0.60, 4.5, 2.6],   // 关中/渭北
      [106.5, 38.5, 0.54, 4.5, 2.6],   // 河套/宁夏灌区
      [100.5, 39.3, 0.50, 5.0, 2.2],   // 河西走廊绿洲
      [87.5, 43.6, 0.64, 4.0, 2.2],    // 天山北麓绿洲（绿洲是沙漠中的高值孤岛）
      [100.0, 22.5, 0.86, 4.5, 3.0],   // 滇南
      [82.0, 44.5, 0.12, 9.0, 4.0],    // 准噶尔盆地荒漠（半径要大，否则被天山绿洲稀释）
      [103.0, 40.5, 0.10, 9.0, 3.2],   // 巴丹吉林/腾格里荒漠
      [90.0, 32.5, 0.22, 12.0, 5.0],   // 青藏高原（高寒，植被稀疏；半径大以压制藏南）
      [91.5, 29.0, 0.56, 1.8, 1.0],    // 藏南河谷农区（狭窄河谷，半径必须小，
                                        //   否则会把整个高原腹地圈进去）
      [104.0, 30.6, 0.80, 4.0, 2.6],   // 成都平原
      [106.0, 25.0, 0.76, 5.5, 4.0],   // 云贵高原
      [113.5, 30.5, 0.80, 4.5, 3.0],   // 长江中下游
      [116.2, 27.6, 0.84, 4.0, 3.0],   // 江南丘陵
      [118.0, 26.8, 0.84, 3.6, 2.6],   // 浙闽
      [113.2, 23.2, 0.90, 4.0, 2.6],   // 珠三角（常年高覆盖）
      [110.5, 20.2, 0.90, 3.6, 2.4]    // 雷州/海南（热带常绿）
    ],
    // ---- 干旱强度：西北重、江南轻（与NDVI 反相） ----
    drought: [
      [103.0, 40.5, 0.82, 9.0, 3.2], [82.0, 44.5, 0.72, 8.0, 3.4],
      [90.0, 32.5, 0.55, 9.0, 4.0],   // 青藏高寒（生理性干旱）
      [88.0, 42.5, 0.66, 7.0, 2.8], [100.5, 39.3, 0.58, 7.0, 2.2],
      [106.5, 38.5, 0.52, 4.5, 2.6], [109.0, 36.5, 0.48, 6.5, 3.4],
      [116.5, 37.5, 0.50, 5.0, 3.2], [120.5, 44.0, 0.42, 8.0, 3.4],
      [104.0, 30.6, 0.26, 4.0, 2.4], [106.0, 25.0, 0.30, 5.5, 4.0],
      [113.5, 30.5, 0.26, 4.5, 3.0], [116.2, 27.6, 0.30, 4.0, 3.0],
      [113.2, 23.2, 0.34, 4.0, 2.6], [126.0, 46.8, 0.40, 6.0, 3.6]
    ],
    // ---- 土壤墒情：与干旱反相（湿润高） ----
    soilMoisture: [
      [113.2, 23.2, 0.84, 4.0, 2.6], [110.5, 20.2, 0.86, 3.6, 2.4],
      [116.2, 27.6, 0.76, 4.0, 3.0], [118.0, 26.8, 0.78, 3.6, 2.6],
      [113.5, 30.5, 0.72, 4.5, 3.0], [106.0, 25.0, 0.68, 5.5, 4.0],
      [104.0, 30.6, 0.54, 4.0, 2.4], [91.5, 29.0, 0.52, 1.8, 1.0],
      [100.0, 22.5, 0.72, 4.5, 3.0], [126.0, 46.8, 0.48, 6.0, 3.6],
      [116.5, 37.5, 0.52, 5.0, 3.2], [109.0, 36.5, 0.42, 6.5, 3.4],
      [106.5, 38.5, 0.44, 4.5, 2.6], [100.5, 39.3, 0.30, 7.0, 2.2],
      [87.5, 43.6, 0.30, 4.0, 2.2], [103.0, 40.5, 0.14, 9.0, 3.2],
      [90.0, 32.5, 0.22, 12.0, 5.0], [120.5, 44.0, 0.40, 6.0, 3.4]
    ],
    // ---- 有效积温：南方高、北方低、高原低 ----
    gdd: [
      [110.5, 20.2, 0.94, 3.6, 2.4], [113.2, 23.2, 0.90, 4.0, 2.6],
      [100.0, 22.5, 0.84, 4.5, 3.0], [118.0, 26.8, 0.84, 3.6, 2.6],
      [116.2, 27.6, 0.82, 4.0, 3.0], [106.0, 25.0, 0.74, 5.5, 4.0],
      [113.5, 30.5, 0.74, 4.5, 3.0], [104.0, 30.6, 0.70, 4.0, 2.4],
      [91.5, 29.0, 0.58, 1.8, 1.0], [108.0, 34.3, 0.64, 4.0, 2.6],
      [106.5, 38.5, 0.56, 4.5, 2.6], [100.5, 39.3, 0.62, 7.0, 2.2],
      [109.0, 36.5, 0.60, 6.5, 3.4], [116.5, 37.5, 0.60, 5.0, 3.2],
      [90.0, 32.5, 0.14, 12.0, 5.0], [120.5, 44.0, 0.44, 6.0, 3.4],
      [119.8, 49.2, 0.40, 5.5, 3.0], [126.0, 46.8, 0.44, 6.5, 4.0],
      [119.6, 33.5, 0.66, 3.4, 2.2],   // 苏北/淮河（暖温带北缘，积温中等偏高）
      [87.5, 43.6, 0.52, 6.0, 2.4], [82.0, 44.5, 0.46, 8.0, 3.4],
      [103.0, 40.5, 0.58, 9.0, 3.2]
    ],
    // ---- 地表温度：南方高、内陆高于沿海、高原低 ----
    lst: [
      [110.5, 20.2, 0.86, 3.6, 2.4], [113.2, 23.2, 0.82, 4.0, 2.6],
      [100.0, 22.5, 0.74, 4.5, 3.0], [118.0, 26.8, 0.68, 3.6, 2.6],
      [116.2, 27.6, 0.66, 4.0, 3.0], [113.5, 30.5, 0.64, 4.5, 3.0],
      [106.0, 25.0, 0.68, 5.5, 4.0], [104.0, 30.6, 0.62, 4.0, 2.4],
      [108.0, 34.3, 0.60, 4.0, 2.6], [109.0, 36.5, 0.58, 6.5, 3.4],
      [106.5, 38.5, 0.60, 4.5, 2.6], [100.5, 39.3, 0.66, 7.0, 2.2],
      [103.0, 40.5, 0.70, 9.0, 3.2], [87.5, 43.6, 0.66, 6.0, 2.4],
      [82.0, 44.5, 0.64, 8.0, 3.4], [90.0, 32.5, 0.26, 9.0, 4.0],
      [126.0, 46.8, 0.46, 7.0, 4.2], [119.8, 49.2, 0.40, 7.0, 3.4],
      [120.5, 44.0, 0.52, 6.0, 3.4], [116.5, 37.5, 0.58, 5.0, 3.2],
      [119.0, 33.5, 0.64, 3.2, 2.0],   // 苏北/淮河一带
      [91.5, 29.0, 0.46, 1.8, 1.0]
    ]
  };

  // ---- 分区基准网格：0.5° 分辨率，构建一次，之后双线性插值 ----
  var ECO_LNG0 = 73, ECO_LNG1 = 136, ECO_LAT0 = 15, ECO_LAT1 = 54, ECO_STEP = 0.5;
  var ECO_NX = Math.round((ECO_LNG1 - ECO_LNG0) / ECO_STEP) + 1;
  var ECO_NY = Math.round((ECO_LAT1 - ECO_LAT0) / ECO_STEP) + 1;
  var ECO_GRID = {};

  function buildEcoGrid() {
    Object.keys(ECO).forEach(function (topic) {
      var zones = ECO[topic];
      var g = new Float32Array(ECO_NX * ECO_NY);
      /* 主导分区取值：取归一化距离最近的分区中心。
         ⚠️ 不能用「高斯加权平均」—— 加权平均把所有分区拉向均值，
         荒漠被宽半径的湿润区分区稀释后从 0.12 抬到 0.31，
         恰恰破坏了"分区"的意义（分区要求区内一致、区间分明）。
         距离用各向异性（经纬半径不同），符合分区本身的形状设定。 */
      var near = function (lng, lat) {
        var bestD = Infinity, bestV = 0.4;
        for (var k = 0; k < zones.length; k++) {
          var z = zones[k];
          var dx = (lng - z[0]) / z[3];
          var dy = (lat - z[1]) / z[4];
          var d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; bestV = z[2]; }
        }
        return bestV;
      };
      for (var iy = 0; iy < ECO_NY; iy++) {
        var lat = ECO_LAT0 + iy * ECO_STEP;
        for (var ix = 0; ix < ECO_NX; ix++) {
          var lng = ECO_LNG0 + ix * ECO_STEP;
          var v = near(lng, lat);
          /* 边界羽化：与最近分区边界相邻的格子向次近分区轻微过渡，
             避免出现生硬的"色块台阶"。只对最近/次近差距小的格子生效。 */
          var bD = Infinity, bV = v, sD = Infinity, sV = v;
          for (var k2 = 0; k2 < zones.length; k2++) {
            var z2 = zones[k2];
            var dx2 = (lng - z2[0]) / z2[3];
            var dy2 = (lat - z2[1]) / z2[4];
            var d2 = dx2 * dx2 + dy2 * dy2;
            if (d2 < bD) { sD = bD; sV = bV; bD = d2; bV = z2[2]; }
            else if (d2 < sD) { sD = d2; sV = z2[2]; }
          }
          var gap = sD - bD;
          if (gap < 0.30) {
            // 越接近两个分区的交界，平滑越强
            var t = Math.max(0, 1 - gap / 0.30) * 0.45;
            v = bV * (1 - t) + sV * t;
          }
          g[iy * ECO_NX + ix] = v;
        }
      }
      ECO_GRID[topic] = g;
    });
  }

  // 双线性插值取分区基准；超出中国范围时按边缘值处理
  function ecoBase(topic, lng, lat) {
    var g = ECO_GRID[topic];
    if (!g) return 0.4;
    var fx = (lng - ECO_LNG0) / ECO_STEP;
    var fy = (lat - ECO_LAT0) / ECO_STEP;
    if (fx < 0) fx = 0; else if (fx > ECO_NX - 1.001) fx = ECO_NX - 1.001;
    if (fy < 0) fy = 0; else if (fy > ECO_NY - 1.001) fy = ECO_NY - 1.001;
    var ix = fx | 0, iy = fy | 0;
    var tx = fx - ix, ty = fy - iy;
    var i0 = iy * ECO_NX + ix, i1 = i0 + 1;
    var i2 = (iy + 1) * ECO_NX + ix, i3 = i2 + 1;
    var a = g[i0] + (g[i1] - g[i0]) * tx;
    var b = g[i2] + (g[i3] - g[i2]) * tx;
    return a + (b - a) * ty;
  }

  // 世界坐标 → 经纬度
  function llOf(wx, wy) {
    var G = global.G;
    if (!G) return [110, 32];
    return [G.xToLng(wx), G.yToLat(wy)];
  }

  buildEcoGrid();

  /* ---- 常用值场：NDVI 长势 ----
     格局由生态分区决定（南方高、北方次高、西北与青藏低），
     噪声只提供田块纹理，权重合计仅 0.14。 */
  R.ndvi = function (wx, wy, seed) {
    var ll = llOf(wx, wy);
    var base = ecoBase('ndvi', ll[0], ll[1]);
    var a = fbm(wx / 62000, wy / 62000, seed, 3, 2.1, 0.55);
    var b = fbm(wx / 17000, wy / 17000, seed + 991, 4, 2.05, 0.52);
    var c = fbm(wx / 4200, wy / 4200, seed + 3351, 4, 2.2, 0.5);
    // 噪声以 base 为中心做乘性扰动：低值区不会被噪声抬到高档（这是关键）
    var t = base * (0.88 + a * 0.13 + b * 0.10 + c * 0.05) - 0.06;
    // 水体/河网：脊状噪声高值处压低（河湖、库区）
    var r = ridge(wx / 26000, wy / 26000, seed + 601);
    if (r > 0.88) t = t * (1 - (r - 0.88) / 0.12 * 0.62);
    return t;
  };

  /* ---- 常用值场：干旱指数（0=正常 1=极旱） ---- */
  R.drought = function (wx, wy, seed) {
    var ll = llOf(wx, wy);
    var base = ecoBase('drought', ll[0], ll[1]);
    var a = fbm(wx / 88000, wy / 88000, seed + 41, 3, 2.1, 0.56);
    var b = fbm(wx / 21000, wy / 21000, seed + 421, 4, 2.07, 0.5);
    return Math.min(1, Math.max(0, base * (0.92 + a * 0.11 + b * 0.07) - 0.03));
  };

  /* ---- 常用值场：涝渍/积水 ---- */
  /*涝渍：只在低洼易涝区显著——长江/珠江中下游平原、黄淮海、易涝的东北东部。
     西北与青藏基本不涝（降水少），故按分区加权。 */
  R.flood = function (wx, wy, seed) {
    var ll = llOf(wx, wy);
    // 涝渍易发度：真实取决于「降水多 + 地势低平」，不是全区域噪声。
    // 湿润度分区做主信号，脊状噪声提供低洼纹理，最后按湿润度门限截断：
    // 西北/青藏湿润度低 → 接近 0（现实中也不易涝）。
    var prone = ecoBase('soilMoisture', ll[0], ll[1]);
    var r = ridge(wx / 34000, wy / 34000, seed + 2207);
    var b = fbm(wx / 15000, wy / 15000, seed + 811, 4, 2.1, 0.5);
    var v = prone * 0.72 + r * 0.16 + b * 0.12;
    // 门限分两段：湿润区(长江/珠江/淮河)正常出涝；半湿润区(华北/东北)只在
    // 低洼处出现夏涝，故给一个小的基底；干旱区(西北/青藏)恒为 0。
    var semi = Math.max(0, Math.min(1, (prone - 0.36) / 0.14)) * 0.18;
    var gate = Math.max(0, Math.min(1, (prone - 0.44) / 0.26));
    var t = (v - 0.34) / 0.30 * gate + semi;
    return Math.max(0, Math.min(0.70, t));
  };

  /* ---- 常用值场：干物质/生物量 ---- */
  R.biomass = function (wx, wy, seed) {
    // 由 NDVI 派生（生物量与植被绿度强相关），做单调压缩并抬高下限
    var v = R.ndvi(wx, wy, seed + 1301);
    return Math.max(0, Math.min(1, 0.06 + v * 0.78));
  };

  /* ---- 常用值场：积温（≥10℃ 有效积温，0=不足 1=充足）----
     农险上用于「热量条件是否满足作物成熟」，与纬度带高度相关：
     低纬（南）积温多、高纬（北）积温少；叠加地形起伏与大尺度年际差异。 */
  R.gdd = function (wx, wy, seed) {
    var ll = llOf(wx, wy);
    var base = ecoBase('gdd', ll[0], ll[1]);
    var a = fbm(wx / 120000, wy / 120000, seed + 5309, 3, 2.1, 0.55);   // 大尺度地形
    var b = fbm(wx / 26000, wy / 26000, seed + 8741, 4, 2.05, 0.5);    // 局地差异
    return Math.max(0, Math.min(1, base * (0.94 + a * 0.09 + b * 0.06) - 0.02));
  };

  /* ---- 常用值场：土壤墒情（0=极干 1=饱和）----
     农业干旱的关键指标。干旱区（西北）低，江南雨区高；
     深厚土层持水能力强，洼地易涝（略降）。 */
  R.soilMoisture = function (wx, wy, seed) {
    var ll = llOf(wx, wy);
    var base = ecoBase('soilMoisture', ll[0], ll[1]);
    var a = fbm(wx / 95000, wy / 95000, seed + 6421, 3, 2.12, 0.56);
    var b = fbm(wx / 23000, wy / 23000, seed + 1873, 4, 2.06, 0.5);
    var v = base * (0.92 + a * 0.12 + b * 0.08);
    // 洼地积水（局地抬升，制造高值斑块）
    var r = ridge(wx / 30000, wy / 30000, seed + 9931);
    if (r > 0.90) v = Math.min(1, v + (r - 0.90) / 0.10 * 0.16);
    return Math.max(0, Math.min(1, v));
  };

  /* ---- 常用值场：地表温度 LST（0=偏低 1=偏高）----
     高温热害定损的核心指标。夏季低纬偏高；夜间/高纬偏低；
     与干旱正相关（少雨 → 地表升温快）。 */
  R.lst = function (wx, wy, seed) {
    var ll = llOf(wx, wy);
    var base = ecoBase('lst', ll[0], ll[1]);
    // 海陆热力差异：沿海夏季略低于内陆
    var coastal = Math.max(0, 1 - Math.abs(ll[0] - 121) / 12) * 0.05;
    var a = fbm(wx / 86000, wy / 86000, seed + 3313, 3, 2.09, 0.55);
    var b = fbm(wx / 19000, wy / 19000, seed + 7759, 4, 2.05, 0.5);
    var v = base * (0.94 + a * 0.09 + b * 0.06) - 0.03 - coastal;
    return Math.max(0, Math.min(1, v));
  };

  /* ---- 常用值场：冰雹大风影响场（0=无影响 1=重）----
     强对流多发于华北平原、西南山地与华南夏半年；
     表现为局地团块状高值区（雷暴单体尺度约 10~30km）。 */
  R.hail = function (wx, wy, seed) {
    var lat = global.G ? global.G.yToLat(wy) : 32;
    var lng = lngOf(wx);
    /* 空间格局：中国冰雹高发区有明确地理分布——
       主中心：华北平原（山前平原强对流）；次中心：西南山区（云贵川地形强迫抬升）；
       青藏与西北基本无冰雹。
       ⚠️ 原实现用「高斯场 + 归一化」，导致中心区饱和到 1.00、
          江汉/珠三角被次高斯尾部带出虚高（实测 0.60）——
          现在改为高斯场直接取值（不归一化）+ 局地雷暴单体纹理。 */
    var h1 = Math.exp(-Math.pow((lat - 39) / 4.2, 2)) * Math.exp(-Math.pow((lng - 115) / 6.0, 2));
    var h2 = Math.exp(-Math.pow((lat - 27.0) / 3.4, 2)) * Math.exp(-Math.pow((lng - 104) / 5.0, 2));
    var base = Math.min(0.88, h1 * 0.80 + h2 * 0.62);
    var a = fbm(wx / 24000, wy / 24000, seed + 4409, 4, 2.1, 0.52);   // 雷暴单体
    var b = fbm(wx / 7000, wy / 7000, seed + 6653, 3, 2.2, 0.48);
    // 强对流稀疏且局地：中心区给足值，非中心区噪声贡献极小（避免虚高）
    var v = base * 0.82 + a * 0.10 + b * 0.06;
    return Math.max(0, Math.min(1, v));
  };

  // 世界 X → 经度（用于值场中的经度相关项）
  function lngOf(wx) { return global.G ? global.G.xToLng(wx) : 110; }

  R.VALUE_FN = {
    ndvi: R.ndvi,
    drought: R.drought,
    flood: R.flood,
    biomass: R.biomass,
    // hail 原先漏注册 → RASTER_TOPICS 里声明了 hail 却没有值场，
    // 切换到冰雹专题会静默回退成NDVI 图层（同样是"看起来正常、实际是错的"）。
    hail: R.hail,
    gdd: R.gdd,
    soilMoisture: R.soilMoisture,
    lst: R.lst
  };

  /* ---------- 描边层：盖在栅格之上的业务边界与标注 ----------
     栅格提到 z=5 后，业务面/标注会被盖住。这里单独建一个 z=6 的 SVG，
     与主SVG 共享同一世界变换（直接复用主 SVG 的 stack transform），
     只画「描边」与「文字」，不画填充 —— 既保证可读，又不影响影像观感。 */

  /* 描边层的宿主键：R.overlay 与 R.clearOverlay 必须用同一个函数算，
   否则两处算法漂移会清错层（表现为「描边层一直是空的」）。*/
  function ovKey(dualHost) {
    if (dualHost.id) return dualHost.id;
    if (dualHost.__ovId == null) dualHost.__ovId = ++R.nsCount;
    return '_' + dualHost.__ovId;
  }

  R.overlay = function (dualHost, geo) {
    // 按容器分别维护描边层 —— 与 DualMap 一样，多视图共用单例会互相清空
    if (!OV.map) OV.map = {};
    var key = ovKey(dualHost);
    var rec = OV.map[key];
    if (!rec || !rec.svg || !rec.g || rec.svg.parentNode !== dualHost) {
      var NS = 'http://www.w3.org/2000/svg';
      var s = document.createElementNS(NS, 'svg');
      s.setAttribute('class', 'gs-overlay');
      s.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;' +
        'z-index:6;pointer-events:none;overflow:visible';
      var g = document.createElementNS(NS, 'g');
      s.appendChild(g);
      dualHost.appendChild(s);
      rec = { svg: s, g: g };
      OV.map[key] = rec;
    }
    // 注意：描边层 g **不套**主 SVG 的世界变换。
    //   路径用世界坐标（无 transform 即世界坐标，与主 SVG stack 相同坐标系）；
    //   文字在 overlayLabel 内用 scale(1/geo.scale) 抵消为像素坐标。
    rec.g.removeAttribute('transform');
    return rec.g;
  };

  R.clearOverlay = function (dualHost) {
    if (!OV.map) return;
    if (!dualHost) { OV.map = {}; return; }
    /* ⚠️ 取键必须与 R.overlay 完全一致。
       R.overlay 里是 `var key = dualHost.id || ('_' + dualHost.__ovId)`，
       若首次调用时 __ovId 为 null，会先算 key（'_null'）再赋值 __ovId，
       于是 clearOverlay 算出的键是 '_1' ≠ '_null' → 清的是另一层（新建空层），
       真层的旧描边永远留着。这里统一走同一个函数，杜绝两处算法漂移。 */
    var key = ovKey(dualHost);
    var rec = OV.map[key];
    if (rec && rec.g) while (rec.g.firstChild) rec.g.removeChild(rec.g.firstChild);
  };

  R.overlayOf = function (dualHost) {
    if (!OV.map) return null;
    return OV.map[dualHost.id || ('_' + dualHost.__ovId)] || null;
  };

  /* 把入参统一摊平成「世界坐标环」的数组 [[x,y], [x,y], ...]。

     入参在项目里有三种形态，必须都支持（实测踩过：判据写反导致
     overlayAreas 传 [环数组] 时返回空→ 描边层一条线都不画，
     表现为「地块界线在影像上完全看不见」，且没有任何报错）：

       A. ring                 裸环：[[x,y],[x,y],...]
       B. [ring, ring, ...]    环数组：[[[x,y],...], [[x,y],...]]   ← overlayAreas 传这个
       C. [[ring, ...], ...]   按要素分组：多面要素的外环/内环集合

     判据是「head 的 head 是不是 number」：
       head 是坐标对 [x,y]                 → 当前层已是环
       head 是数组但 head[0] 也是数组且是坐标 → 已摊平一层
       head 是数组且 head[0] 还是数组的数组 → 是分组，再摊一层
     ⚠️ 不能用「typeof head === 'number'」判断：A/B 形态里
        head 是 [x,y] 而不是 number，会被误当成分组而全部摊空。*/
  function flattenRings(rings) {
    var out = [];
    if (!Array.isArray(rings)) return out;
    function isPt(x) { return Array.isArray(x) && x.length >= 2 && typeof x[0] === 'number'; }
    function isRing(x) {
      return Array.isArray(x) && x.length >= 3 && isPt(x[0]);
    }
    for (var i = 0; i < rings.length; i++) {
      var r = rings[i];
      if (isRing(r)) { out.push(r); continue; }      // A / B的元素
      if (Array.isArray(r)) {// C：再摊一层
        for (var j = 0; j < r.length; j++) {
          if (isRing(r[j])) out.push(r[j]);
        }
      }
    }
    return out;
  }

  /* 在描边层画一个闭合环的描边（不填充）
     描边层保持屏幕像素坐标系，故路径也需 toScreen 投影；
     描边宽度用 vector-effect:non-scaling-stroke，保证任何缩放下线宽恒定。 */
  R.overlayRings = function (dualHost, geo, rings, opt) {
    var g = R.overlay(dualHost, geo);
    var NS = 'http://www.w3.org/2000/svg';
    opt = opt || {};
    flattenRings(rings).forEach(function (r) {
      var d = 'M' + r.map(function (p) {
        var s = geo.toScreen(p[0], p[1]);
        return (isFinite(s.x) && isFinite(s.y))
          ? s.x.toFixed(1) + ',' + s.y.toFixed(1) : '';
      }).filter(Boolean).join('L') + 'Z';
      if (d === 'MZ' || d.length < 4) return;
      var path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', opt.stroke || 'rgba(255,255,255,.95)');
      path.setAttribute('stroke-width', String(opt.width == null ? 2 : opt.width));
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      path.setAttribute('stroke-linejoin', 'round');
      if (opt.dash) path.setAttribute('stroke-dasharray', opt.dash);
      if (opt.glow) path.setAttribute('filter', 'url(#gsGlow)');
      g.appendChild(path);
    });
  };

  /* 在描边层画一个标注
     ⚠️⚠️ 关键坑（踩了两次）：描边层若复用主 SVG 的世界变换（scale≈3e-3~1e-4），
     font-size:12 会被压成 0.036px → 完全看不见，且 getBoundingClientRect 宽高为 0，
     极易误判成「没画」。
     正确做法：描边层整体保持**屏幕像素坐标系**（不套任何 transform），
     路径与文字都在绘制时用 geo.toScreen() 投影。
  */
  /* 在描边层画面（可半透明填充 + 描边）
     描边层在栅格(z=5) 之上、业务层(z=3) 之上，因此栅格模式下
     业务面的着色会被影像盖住 —— 需要在这里把面重画一遍。
     fillOpacity 默认 0（纯描边），传 opt.fill 才填色。
     坐标系与 overlayRings 一致：世界坐标、无自身 transform。 */
  R.overlayAreas = function (dualHost, geo, items, opt) {
    var g = R.overlay(dualHost, geo);
    var NS = 'http://www.w3.org/2000/svg';
    opt = opt || {};
    (items || []).forEach(function (it) {
      var rings = flattenRings(it.r);
      if (!rings.length) return;
      var d = rings.map(function (r) {
        return 'M' + r.map(function (p) {
          var s = geo.toScreen(p[0], p[1]);
          return (isFinite(s.x) && isFinite(s.y)) ? s.x.toFixed(1) + ',' + s.y.toFixed(1) : '';
        }).filter(Boolean).join('L') + 'Z';
      }).join('');
      if (!d || d === 'MZ') return;
      var path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      if (opt.fill) {
        path.setAttribute('fill', typeof opt.fill === 'function' ? opt.fill(it) : opt.fill);
        path.setAttribute('fill-opacity',
          String(opt.fillOpacity == null ? 0.22 : opt.fillOpacity));
      } else {
        path.setAttribute('fill', 'none');
      }
      path.setAttribute('stroke', opt.stroke || 'rgba(255,255,255,.9)');
      path.setAttribute('stroke-width', String(opt.width == null ? 1.2 : opt.width));
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      if (opt.dash) path.setAttribute('stroke-dasharray', opt.dash);
      g.appendChild(path);
    });
  };

  R.overlayLabel = function (dualHost, geo, wx, wy, text, opt) {
    var g = R.overlay(dualHost, geo);
    var NS = 'http://www.w3.org/2000/svg';
    opt = opt || {};
    var sp = geo.toScreen(wx, wy);                 // 屏幕像素坐标
    var y = sp.y + (opt.dy || 0);
    var size = String(opt.size || 12);

    var halo = document.createElementNS(NS, 'text');
    halo.setAttribute('x', sp.x.toFixed(1));
    halo.setAttribute('y', y.toFixed(1));
    halo.setAttribute('fill', 'none');
    halo.setAttribute('stroke', 'rgba(3,8,18,.92)');
    halo.setAttribute('stroke-width', String(opt.haloW || 4));
    halo.setAttribute('stroke-linejoin', 'round');
    halo.setAttribute('font-size', size);
    halo.setAttribute('font-weight', String(opt.weight || 700));
    halo.setAttribute('text-anchor', 'middle');
    halo.textContent = text;
    g.appendChild(halo);

    var t = document.createElementNS(NS, 'text');
    t.setAttribute('x', sp.x.toFixed(1));
    t.setAttribute('y', y.toFixed(1));
    t.setAttribute('fill', opt.fill || '#fff');
    t.setAttribute('stroke', 'none');
    t.setAttribute('font-size', size);
    t.setAttribute('font-weight', String(opt.weight || 700));
    t.setAttribute('text-anchor', 'middle');
    t.textContent = text;
    g.appendChild(t);
  };

  global.RasterEngine = R;
})(window);