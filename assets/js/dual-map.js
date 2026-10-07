/* ============================================================
   AgriSense 3S · 卫星底图 + 业务图层 双层架构
   ---------------------------------------------------------
   设计要点（针对实测踩坑的修复）：
   1. TMap GL JS 在 key 鉴权失败时，MultiPolygon/MultiCircle 等
      图层构造会抛 "Cannot set property id" —— 因此业务图层
      **不再依赖 TMap**，改由内置 SVG 引擎渲染。
   2. TMap 只负责卫星影像底图与相机（center/zoom），通过事件
      把视野回传给 SVG 层，两层严格对齐。
   3. 若 TMap 完全不可用（无网络/无 SDK），SVG 层独立工作，
      使用 WebMercator 自绘，地图始终可用。

   这样做的额外好处：业务图斑/标注用 SVG 渲染，样式与像素级
   控制力远强于 WebGL 栅格，且打印/截图清晰。
   ============================================================ */
(function () {
  'use strict';

  var G_ = window.G, GeoCanvas_ = window.GeoCanvas;
  var $ = function (s, r) { return (r || document).querySelector(s); };

  /* 每个地图容器一个独立实例：
   national 与 qual 两个视图各有自己的 #nat-map / #qual-map，
   若共用单例会互相覆盖（D.svg 指向最后初始化的那个），
   导致切回先前视图时地图空白。*/
  var INSTANCES = {};      // hostId -> 实例状态
  window.__DUAL__ = INSTANCES;

  var D = null;            // 当前操作实例（由 API 参数指定）

  function inst(hostId) { return INSTANCES[hostId] || null; }

  /* ---------- 初始化 ---------- */
  function init(hostId, opts) {
    opts = opts || {};
    var host = typeof hostId === 'string' ? $(hostId) : hostId;
    if (!host) return null;
    var key = host.id || ('_' + Object.keys(INSTANCES).length);

    // 该容器已初始化过则复用，避免重复建实例
    if (INSTANCES[key] && INSTANCES[key].svg && INSTANCES[key].host === host) {
      D = INSTANCES[key];
      return D;
    }

    D = {
      key: key,
      map: null,          // TMap 实例（仅底图+相机）
      svg: null,          // SVG 业务层
      layers: {},
      host: host,
      satOk: false,
      _tries: 0
    };
    INSTANCES[key] = D;
    window.__DUAL__ = INSTANCES;

    // 叠层容器：TMap 在下，SVG 在上
    D.host.innerHTML = '<div class="dual-tmap"></div><div class="dual-svg"></div>' +
      '<div class="gs-ctl dual-ctl"></div>' +
      '<div class="gs-scale"><span class="gs-scale-bar"></span><span class="gs-scale-txt"></span></div>' +
      '<div class="gs-coord"></div>';

    var tmapHost = D.host.querySelector('.dual-tmap');
    var svgHost = D.host.querySelector('.dual-svg');
    // 叠层顺序（从下到上）：TMap 底图(1) → SVG 业务层(3) → Raster 栅格(4)
    // 栅格层由 RasterEngine 动态 append，因此z-index 高于 SVG：
    // SVG 内部部分图元带不透明 fill，放在下面会被整片遮挡（实测踩过）。
    // 栅格 pointer-events:none，交互仍由 SVG 承担。
    if (tmapHost) tmapHost.style.zIndex = '1';
    if (svgHost) svgHost.style.zIndex = '3';
    svgHost.className = 'dual-svg gs-map';

    // SVG 业务层
    D.svg = new GeoCanvas_(svgHost, {
      onPick: opts.onPick || function () { },
      onView: function () { }
    });
    D.layers.base = D.svg.layer('base', 1);
    D.layers.biz = D.svg.layer('biz', 2);
    D.layers.risk = D.svg.pxLayer('risk', 3);
    D.layers.lab = D.svg.pxLayer('lab', 4);
    D.onHome = opts.onHome;
    D.onBaseChange = opts.onBaseChange;
    D.onEngine = opts.onEngine;
    D.onTilesOk = opts.onTilesOk;
    D.onTilesFail = opts.onTilesFail;
    D.onPick = opts.onPick;

    // 相机：优先用 TMap（卫星底图），失败则用 SVG 自身
    // 主动加载 SDK（attachTMap 内部会等待就绪并重试）
    if (window.SatMap && window.SatMap.loadSDK) {
      try { window.SatMap.loadSDK(function () { attachTMap(D, tmapHost, opts); }); }
      catch (e) { attachTMap(D, tmapHost, opts); }
    } else {
      attachTMap(D, tmapHost, opts);
    }
    return D;
  }

  /* ---------- 接入 TMap 卫星底图 ----------
     SDK 是异步加载的，首次调用时通常还没就绪。
     因此这里做「等待式接入」：轮询最多 12s，一旦 TMap 就绪立即接入；
     超时才降级。避免"首次没就绪 → 永远无底图"。 */
  function attachTMap(I, tmapHost, opts) {
    if (!I) return;
    if (I.map) return;                       // 已接入
    if (!window.TMap) {
      if (I._tries === undefined) I._tries = 0;
      I._tries++;
      if (I._tries < 40) {                   // 40 × 300ms ≈ 12s
        setTimeout(function () { attachTMap(I, tmapHost, opts); }, 300);
        return;
      }
      fallback(I, '卫星 SDK 加载超时');
      return;
    }
    try {
      I.map = new TMap.Map(tmapHost, {
        center: new TMap.LatLng((opts.center && opts.center.lat) || 34.5, (opts.center && opts.center.lng) || 108.0),
        zoom: satZoomFromScale(scaleFromSatZoom(opts.zoom == null ? 4 : opts.zoom)),
        minZoom: 2, maxZoom: 18,
        baseMap: { type: 'satellite', features: ['base', 'road'] },
        viewMode: '2D', pitchable: false, rotatable: false, showControl: false
      });
      I.satOk = true;
      I.tmapHost = tmapHost;
      try {
        tmapHost.style.pointerEvents = 'none';
        tmapHost.style.zIndex = '1';
      } catch (e) { }

      // SVG 交互 → 驱动 TMap（单向跟随）
      I.svg.onViewChange = function () { svgToSat(I); };

      // 控件
      var ctl = I.host.querySelector('.dual-ctl');
      ctl.innerHTML = '<button data-a="zin" title="放大">＋</button>' +
        '<button data-a="zout" title="缩小">－</button>' +
        '<button data-a="home" title="复位">⌂</button>' +
        '<button data-a="base" title="切换底图">🛰</button>';
      ctl.addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (!b) return;
        var a = b.dataset.a;
        if (a === 'zin') I.svg.zoomBy(1.55);
        else if (a === 'zout') I.svg.zoomBy(1 / 1.55);
        else if (a === 'home') { if (opts.onHome) opts.onHome(); }
        else if (a === 'base') toggleBase(I);
      });
      I.ctl = ctl;

      // 初始跟随一次 SVG 视角
      setTimeout(function () { svgToSat(I); }, 320);
      // 卫星底图按钮默认激活
      var bb = ctl.querySelector('button[data-a="base"]');
      if (bb) bb.classList.add('on');

      // 瓦片出图探测：未鉴权时明确提示用户配置 key
      if (window.SatMap && window.SatMap.probeAuth) {
        window.SatMap.probeAuth(I.map, function (ok, reason) {
          I.tilesOk = (ok === true);
          I.tilesReason = reason;
          if (ok === false && I.onTilesFail) I.onTilesFail(reason);
          else if (ok === true && I.onTilesOk) I.onTilesOk(reason);
        });
      }

      if (opts.onEngine) opts.onEngine({
        ok: true, label: '卫星影像底图 · 腾讯位置服务',
        note: D.map.__authFail ? '鉴权受限' : ''
      });
    } catch (e) {
      fallback('初始化异常');
    }
  }

  /* ---------- 相机同步（共用同一套变换） ----------
     核心难点：TMap 的 zoom 与 SVG 的 scale 语义不同，直接换算必然错位
     （实测踩过：zoom 反算 scale 导致 SVG 视口塌缩成一条线）。

     解法：**不用 zoom 换算 scale**。
     墨卡托下，zoom z 时地图宽度 = 256·2^z 像素 恰好覆盖世界宽度 W 米，
     因此 scale = 256·2^z / W。W 为常量，取 2·EARTH。
     两层都用同一个 scale 公式，中心点都用经纬度 → 天然对齐。
     交互统一由 SVG 处理，单向把「中心经纬度 + scale」同步给 TMap。 */
  var WORLD_M = 2 * 20037508.34;          // 墨卡托世界宽度（米）

  function satZoomFromScale(scale) {
    return Math.log2(scale * WORLD_M / 256);
  }
  function scaleFromSatZoom(z) {
    return 256 * Math.pow(2, z) / WORLD_M;
  }

  /* ---------- Esri 真实卫星影像底图（免 KEY） ----------
   独立于腾讯 SDK：无论 I.map 是否就绪都生效。
   腾讯不可用时（无 KEY / SDK 加载失败）也能出真实卫星影像。 */
function syncEsri(I) {
    I = I || D;
    if (!I || !I.svg || !I.svg._vw || !I.host) return;
    if (!window.EsriImagery) return;
    try {
      if (!I.esriHost) {
        I.esriHost = document.createElement('div');
        I.esriHost.className = 'esri-imagery';
        I.esriHost.style.cssText = 'position:absolute;inset:0;z-index:0;' +
          'pointer-events:none;overflow:hidden';
        I.host.insertBefore(I.esriHost, I.host.firstChild);
      }
      if (!I.esri) I.esri = window.EsriImagery.create(I.esriHost, 'satellite');
      I.esri.build(I.svg);
    } catch (e) { }
  }

  function svgToSat(I) {
    I = I || D;
    if (!I || !I.map || !I.svg || !I.svg._vw) { syncEsri(I); return; }
    syncEsri(I);
    try {
      var v = I.svg.view();
      I.map.setCenter(new TMap.LatLng(v.lat, v.lng));
      var z = satZoomFromScale(I.svg.scale);
      if (z >= 2 && z <= 18 && Math.abs(z - I.map.getZoom()) > .3) I.map.setZoom(Math.round(z));
    } catch (e) { }
  }

  /* ---------- SVG 引擎补充：按经纬度设视图 ---------- */
  if (GeoCanvas_ && GeoCanvas_.prototype) {
    GeoCanvas_.prototype.setViewByLL = function (lng, lat, scale) {
      if (!this._vw || !scale) return;
      var x = G_.lngToX(lng), y = G_.mercY(lat);
      this.scale = this.baseScale = scale;
      this.minScale = scale * .5; this.maxScale = scale * 200;
      this.tx = this._vw / 2 - x * this.scale;
      this.ty = this._vh / 2 + y * this.scale;   // Y 轴已翻转
      this._fullBBox = [x - this._vw / (2 * scale), y - this._vh / (2 * scale),
                        x + this._vw / (2 * scale), y + this._vh / (2 * scale)];
      this._apply();
    };
    GeoCanvas_.prototype.getViewLL = function () {
      var v = this.view();
      return { lng: v.lng, lat: v.lat };
    };
    // 覆写 _apply：视图变化后驱动卫星层跟随 + 栅格层重绘
    GeoCanvas_.prototype._apply = (function (orig) {
      return function () {
        orig.call(this);
        // 栅格层：视图变化后需重新按像元渲染并同步裁剪
        if (this.onRasterRefresh) {
          var self = this;
          // 用 rAF 合并连续变更（拖拽/缩放时避免重复重算）
          if (self._rafRaster) return;
          self._rafRaster = requestAnimationFrame(function () {
            self._rafRaster = null;
            try { self.onRasterRefresh(); } catch (e) { }
          });
        }
        if (this.onViewChange) {
          var v = this.view();
          this.onViewChange(v.lng, v.lat, this.scale);
        }
      };
    })(GeoCanvas_.prototype._apply);
  }

  /* ---------- 底图切换 ---------- */
  function toggleBase() {
    if (!D.map) return;
    D.satOn = !D.satOn;
    try {
      D.map.setBaseMap(D.satOn
        ? { type: 'satellite', features: ['base', 'road'] }
        : { type: 'vector', features: ['base', 'building2d', 'road', 'label'] });
      var b = D.ctl && D.ctl.querySelector('button[data-a="base"]');
      if (b) b.classList.toggle('on', D.satOn);
      if (D.onBaseChange) D.onBaseChange(D.satOn);
    } catch (e) { }
  }

  /* ---------- 降级：无 TMap，纯 SVG ---------- */
  function fallback(I, reason) {
    if (!I) return;
    I.satOk = false;
    if (I.tmapHost) I.tmapHost.style.display = 'none';
    if (I.onEngine) I.onEngine({ ok: false, label: '矢量底图（卫星不可用）', note: reason });
    // SVG 层自己作为主视图，独立工作
    if (I.svg) {
      I.svg.onViewChange = null;   // 解除反向驱动
      I.svg.host.style.pointerEvents = 'auto';
    }
    if (I.ctl) {
      D.ctl.innerHTML = '<button data-a="zin" title="放大">＋</button>' +
        '<button data-a="zout" title="缩小">－</button>' +
        '<button data-a="home" title="复位">⌂</button>';
      D.ctl.addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (!b || !I.svg) return;
        var a = b.dataset.a;
        if (a === 'zin') I.svg.zoomBy(1.5);
        else if (a === 'zout') I.svg.zoomBy(1 / 1.5);
        else if (a === 'home' && I.onHome) I.onHome();
      });
    }
  }

  /* ---------- 业务图层绘制 API ----------
   I = 目标实例（由视图 init 时捕获），避免多视图互相踩踏 */
  function area(I, obj, style) { return I && I.svg && I.svg.area('biz', obj, style); }
  function pxDot(I, l, x, y, r, st, m) { return I && I.svg && I.svg.pxDot(l, x, y, r, st, m); }
  function pxRing(I, l, x, y, r, st) { return I && I.svg && I.svg.pxRing(l, x, y, r, st); }
  function pxLabel(I, l, x, y, t, st, m) { return I && I.svg && I.svg.pxLabel(l, x, y, t, st, m); }
  function anchor(I, el, wx, wy, dy, sib, opt, minW) { return I && I.svg && I.svg.anchor(el, wx, wy, dy, sib, opt, minW); }
  function clearBIZ(I) { if (I && I.svg) I.svg.clear('biz'); }
  function clearLayer(I, n) { if (I && I.svg) I.svg.clear(n); }
  function fit(I, b) { if (I && I.svg) { I.svg.fit(b); setTimeout(function () { svgToSat(I); }, 60); } }
  function fitLL(I, bboxLL) {
    if (!I || !I.svg) return;
    var b = [G_.lngToX(bboxLL[0]), G_.mercY(bboxLL[1]), G_.lngToX(bboxLL[2]), G_.mercY(bboxLL[3])];
    I.svg.fit(b);
    setTimeout(function () { svgToSat(I); }, 60);
  }
  function resize(I) {
    if (I && I.svg) I.svg.resize();
    if (I && I.map) { try { I.map.resize && I.map.resize(); } catch (e) { } }
  }
  function toPx(I, x, y) { return I && I.svg ? I.svg.toPx(x, y) : { x: 0, y: 0 }; }
  function toggleBase(I) {
    if (!I || !I.map) return;
    I.satOn = !I.satOn;
    try {
      I.map.setBaseMap(I.satOn
        ? { type: 'satellite', features: ['base', 'road'] }
        : { type: 'vector', features: ['base', 'building2d', 'road', 'label'] });
      var b = I.ctl && I.ctl.querySelector('button[data-a="base"]');
      if (b) b.classList.toggle('on', I.satOn);
      if (I.onBaseChange) I.onBaseChange(I.satOn);
    } catch (e) { }
  }

  window.DualMap = {
    init: init, area: area, pxDot: pxDot, pxRing: pxRing, pxLabel: pxLabel,
    anchor: anchor, clearBIZ: clearBIZ, clearLayer: clearLayer,
    fit: fit, fitLL: fitLL, resize: resize, toPx: toPx, toggleBase: toggleBase,
    syncToSat: svgToSat,
    syncEsri: syncEsri,
    svgHost: function (I) { return I && I.svg && I.svg.host; },
    tmapHost: function (I) { return I && I.tmapHost; },
    get: function (hostId) { return inst(typeof hostId === 'string' ? $(hostId) : hostId); },
    instances: INSTANCES
  };
})(window);