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

    /* 相机：优先用 TMap（卫星底图），失败则用 SVG 自身
       ⚠️ 关键（2026-10-13）：Esri 影像层是**主底图**，必须无条件先建起来。
       此前把它的建立挂在 TMap 成功之后，于是无 key 环境下
       attachTMap 会先空转 40×300ms≈12s 才 fallback，
       这 12 秒里 Esri 层完全不存在 → 用户看到"影像一点也没有"。
       ⚠️ 但 init 此刻容器尺寸多半还是 0（视图 display:none），
       build() 会因 _vw=0 直接返回并把 _sig 写脏。这里做两件事：
         ① 建立 EsriLayer 实例（此时不建瓦片）
         ② 把首次建瓦片推迟到 resize/渲染时由 syncEsri 兜底触发 */
    ensureEsri(D);
    buildCtl(D);          // 缩放/复位控件：无论底图引擎是否就绪都必须存在

    if (window.SatMap && window.SatMap.loadSDK) {
      try { window.SatMap.loadSDK(function (ok) { if (ok) attachTMap(D, tmapHost, opts); else fallback(D, '未配置腾讯位置服务 KEY，已使用 Esri 影像底图'); }); }
      catch (e) { fallback(D, '卫星 SDK 异常，已使用 Esri 影像底图'); }
    } else {
      fallback(D, '无卫星 SDK，已使用 Esri 影像底图');
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
      // ⚠️ 与 Esri 层的 onViewChange 是同一个钩子位，此处用组合而非覆盖，
      //    否则后初始化的 EsriLayer 会把 TMap 跟随清掉（反之亦然）。
      I.svg.onViewChange = function (g) {
        svgToSat(I);
        if (I.esri && I.esri.onViewChange) { try { I.esri.onViewChange(g); } catch (e) { } }
      };

      // 底图切换按钮：TMap 成功路径才有意义（Esri 路径下没有可切换的第二底图）
      if (I.ctl) {
        var ctl2 = I.ctl;
        if (!ctl2.querySelector('button[data-a="base"]')) {
          var bb2 = document.createElement('button');
          bb2.type = 'button'; bb2.dataset.a = 'base'; bb2.title = '切换底图'; bb2.textContent = '🛰';
          bb2.classList.add('on');
          bb2.addEventListener('click', function () { toggleBase(I); });
          ctl2.appendChild(bb2);
        }
      }

      // 初始跟随一次 SVG 视角
      setTimeout(function () { svgToSat(I); }, 320);

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
  /* 建立 Esri 影像层实例（不要求容器已有尺寸）
     叠层顺序：Esri 底图(0) → TMap(1) → SVG 业务层(3) → Raster 栅格(4) */
  function ensureEsri(I) {
    if (!I || !I.host || !window.EsriImagery) return null;
    if (!I.esriHost) {
      I.esriHost = document.createElement('div');
      I.esriHost.className = 'esri-imagery';
      I.esriHost.style.cssText = 'position:absolute;inset:0;z-index:0;' +
        'pointer-events:none;overflow:hidden;will-change:transform';
      I.host.insertBefore(I.esriHost, I.host.firstChild);
      /* 让 .dual-svg / .gs-map 的不透明深色背景让位
         （否则 Esri 瓦片被整片遮住，画面只剩文字标签）。
         同时给容器与地图本体都加类 —— #nat-map.gs-map 是 ID 选择器，
         只给父容器加类压不过它。 */
      var wrap = I.host.parentNode || I.host;
      if (wrap && wrap.classList) wrap.classList.add('esri-on');
      if (I.host.classList) I.host.classList.add('esri-on');
    }
    if (!I.esri) {
      I.esri = window.EsriImagery.create(I.esriHost, 'satellite');
      // 组合式挂载：保留 TMap 的跟随逻辑，不要整体覆盖
      var prevHook = I.svg && I.svg.onViewChange;
      if (I.svg) {
        I.svg.onViewChange = function (g) {
          if (prevHook) { try { prevHook(g); } catch (e) { } }
          if (I.esri && I.esri.onViewChange) { try { I.esri.onViewChange(g); } catch (e) { } }
        };
      }
    }
    return I.esri;
  }

  function syncEsri(I) {
    I = I || D;
    if (!I || !I.svg || !I.host) return;
    var esri = ensureEsri(I);
    // 容器还没量到尺寸时不能建瓦片：此时 build 会早退并写脏 _sig，
    // 等 resize/render 时再来一次即可（renderWhenReady 已保证会重试）
    if (!esri || !I.svg._vw || !I.svg._vh) return;
    try { esri.build(I.svg); } catch (e) { }
  }

  function svgToSat(I) {
    I = I || D;
    if (!I || !I.map || !I.svg || !I.svg._vw) { syncEsri(I); return; }
    syncEsri(I);
    try {
      var v = I.svg.view();
      // ⚠️ 必须用 lngLL/latLL：view().lng/lat 是世界坐标（1e7 量级），
      //    喂给 TMap.LatLng 会让相机飞到 (19070000°, ...) 的非法位置
      I.map.setCenter(new TMap.LatLng(v.latLL, v.lngLL));
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
      // 返回真实经纬度（view().lng/lat 是世界坐标，字段名误导）
      return { lng: v.lngLL, lat: v.latLL };
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

  /* ---------- 降级：无 TMap，纯 SVG + Esri 影像 ---------- */
  function fallback(I, reason) {
    if (!I) return;
    I.satOk = false;
    if (I.tmapHost) I.tmapHost.style.display = 'none';
    // ⚠️ 文案修正（2026-10-13）：此前写「卫星不可用」，但影像底图实际由
    //    Esri World Imagery 正常承担，说"不可用"会让用户误以为影像坏了。
    if (I.onEngine) I.onEngine({ ok: true, label: '卫星影像底图 · Esri World Imagery', note: reason });
    // SVG 层自己作为主视图，独立工作
    if (I.svg) {
      // 保留 Esri 层的拖动跟随（置 null 会让影像与行政边界脱节）
      I.svg.onViewChange = function (g) {
        if (I.esri && I.esri.onViewChange) { try { I.esri.onViewChange(g); } catch (e) { } }
      };
      I.svg.host.style.pointerEvents = 'auto';
    }
    // 控件已在 init 建立（buildCtl），此处只兜底；不重复绑定，
    // 否则监听器叠加会让"点一次放大"变成放大多次
    if (!I.ctl) buildCtl(I);
    syncEsri(I);
  }

  /* 缩放/复位控件：与相机实现解耦，init 时即建立
     ⚠️ 修复（2026-10-13）：此前控件只在 attachTMap（TMap 成功路径）里创建，
        而 fallback 分支判断 `if (I.ctl)` —— I.ctl 从未被赋值，
        于是无 key 环境下控件容器是空的（实测 width=0/height=0），
        用户**完全没有缩放与复位入口**。 */
  function buildCtl(I) {
    if (!I || !I.host || I.ctl) return I.ctl;
    var ctl = I.host.querySelector('.dual-ctl');
    if (!ctl) return null;
    ctl.innerHTML = '<button type="button" data-a="zin" title="放大">＋</button>' +
      '<button type="button" data-a="zout" title="缩小">－</button>' +
      '<button type="button" data-a="home" title="复位">⌂</button>';
    ctl.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || !I.svg) return;
      var a = b.dataset.a;
      if (a === 'zin') I.svg.zoomBy(1.5);
      else if (a === 'zout') I.svg.zoomBy(1 / 1.5);
      else if (a === 'home') {
        if (I.onHome) I.onHome();
        else I.svg.fit(I.svg._fullBBox || I.svg.bbox, true);
      }
    });
    I.ctl = ctl;
    return ctl;
  }

  /* ---------- 业务图层绘制 API ----------
   I = 目标实例（由视图 init 时捕获），避免多视图互相踩踏 */
  function area(I, obj, style) { return I && I.svg && I.svg.area('biz', obj, style); }
  function pxDot(I, l, x, y, r, st, m) { return I && I.svg && I.svg.pxDot(l, x, y, r, st, m); }
  function pxRing(I, l, x, y, r, st) { return I && I.svg && I.svg.pxRing(l, x, y, r, st); }
  function pxLabel(I, l, x, y, t, st, m) { return I && I.svg && I.svg.pxLabel(l, x, y, t, st, m); }
  function anchor(I, el, wx, wy, dy, sib, opt, minW) { return I && I.svg && I.svg.anchor(el, wx, wy, dy, sib, opt, minW); }
  function dedupLabels(I, l) { return I && I.svg ? I.svg.dedupLabels(l) : { total: 0, removed: 0 }; }
  /* 标注归属终检：核对每个标签是否仍在本行政区面内，跑偏的拉回来。*/
  function fixLabelHome(I, l, pairs, opt) {
    return I && I.svg ? I.svg.fixLabelHome(l, pairs, opt) : { fixed: 0, checked: 0, skipped: 0 };
  }
  function pxLeader(I, l, x1, y1, x2, y2, st) { return I && I.svg ? I.svg.pxLeader(l, x1, y1, x2, y2, st) : null; }
  function clearBIZ(I) { if (I && I.svg) I.svg.clear('biz'); }
  function clearLayer(I, n) { if (I && I.svg) I.svg.clear(n); }
  /* ⚠️ 视图 fit 完成后必须重投影本轮新建的标签（2026-10-16 修）
     ------------------------------------------------------------
     背景：national-view 有 7 处是「先 pxLabel(用 st.toPx 换算的屏幕坐标)
     → 后 DM.fit」的写法。fit 会整体改写 scale/tx/ty，
     那些已经算好的屏幕坐标全部作废 —— 标签整体偏移。

     实测：新疆省级 24 个市名全部堆到左上角，
     「乌鲁木齐市」本应在 (738,309) 实际出现在 (423,222)；
     新疆、内蒙、广东等所有省份都受影响，不是个别现象。

     修法：pxLabel 内部已把元素登记进 svg.pxAnchors（带世界坐标 wx/wy），
     这里在 fit 之后统一调 _syncPx 重投影一次 ——
     这样无论调用方是「先画后 fit」还是「先 fit 后画」都能正确落位，
     不必逐个改 7 处调用点（改动面小、覆盖全）。

     仅处理 fit 之前创建的（标记 _fitNew），避免重复处理后画的。 */
  function fit(I, b) {
    if (!I || !I.svg) return;
    I.svg.fit(b);
    try {
      /* 标记本轮 fit 前新建的标签（与 fit 后新建的区分开） */
      var items = I.svg.layers.lab && I.svg.layers.lab.pxItems;
      if (items) {
        for (var i = 0; i < items.length; i++) {
          if (items[i] && items[i]._lx) items[i]._pendingReproj = true;
        }
      }
      /* 兜底：给**没有登记 anchor** 的标签补一个。
         pxLabel 的调用方有两种写法 —— 有的调了 DM.anchor（登记了世界坐标），
         有的没调。这类没 anchor 的元素 _syncPx 修不了，
         而它们恰恰是本次要修的（fit 前用旧变换画的那批）。
         做法：用当前屏幕坐标反算世界坐标补登记，
         这样下一次视图变化（含本次 fit 之后）都能正确重投影。 */
      if (I.svg.toWorld && items) {
        for (var m = 0; m < items.length; m++) {
          var el = items[m];
          if (!el || !el._lx || el._hasAnchor) continue;
          var x = parseFloat(el.getAttribute('x'));
          var y = parseFloat(el.getAttribute('y'));
          if (!isFinite(x) || !isFinite(y)) continue;
          var wp = I.svg.toWorld(x, y);
          if (wp && isFinite(wp[0]) && isFinite(wp[1])) {
            I.svg.anchor(el, wp[0], wp[1], 0, null, false, 0);
            el._hasAnchor = true;
          }
        }
      }
      /* 标记已登记，供 pxLabel 后续识别 */
      var anch = I.svg.pxAnchors || [];
      for (var q = 0; q < anch.length; q++) {
        if (anch[q] && anch[q].el) anch[q].el._hasAnchor = true;
      }

      I.svg._syncPx();          // 用 anchor 的世界坐标重投影
      if (items) {
        for (var j = 0; j < items.length; j++) {
          if (items[j]) items[j]._pendingReproj = false;
        }
      }
      /* 标签挪位后，占位记录已失效 —— 清掉让下一轮避让重新计算 */
      if (items) {
        for (var k = 0; k < items.length; k++) {
          if (items[k]) items[k]._pxBox = null;
        }
      }
    } catch (e) { }
    setTimeout(function () { svgToSat(I); }, 60);
  }
  function fitLL(I, bboxLL) {
    if (!I || !I.svg) return;
    var b = [G_.lngToX(bboxLL[0]), G_.mercY(bboxLL[1]), G_.lngToX(bboxLL[2]), G_.mercY(bboxLL[3])];
    I.svg.fit(b);
    setTimeout(function () { svgToSat(I); }, 60);
  }
  function resize(I) {
    if (I && I.svg) I.svg.resize();
    if (I && I.map) { try { I.map.resize && I.map.resize(); } catch (e) { } }
    // 容器尺寸变化后必须重建瓦片：视图从 display:none 切出时尺寸才从 0 变正，
    // 之前少了这一步，Esri 层就停在"实例已建、瓦片为 0"的状态（实测影像全无）
    syncEsri(I);
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
    /* 标注终检三件套（2026-10-15 补）：重建时丢失导致全国层抛错白屏 */
    dedupLabels: dedupLabels, fixLabelHome: fixLabelHome,
    leader: pxLeader, pxLeader: pxLeader,
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