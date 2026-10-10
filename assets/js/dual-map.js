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
    /* ⚠️ 必须用局部变量锁住本实例，不能让后续逻辑去读模块级的 D：
       D 是"当前操作实例"，每次 init() 都会被覆盖成最后初始化的那个。
       先建 national、后建 qual 时，national 上注册的钩子若闭包捕获 D，
       实际指向的就是 qual 实例 —— 表现为「只有 national 的影像不动」。
       这正是本次的实测现象（qual 修好了、national 没修好）。*/
    var SELF = D;
    INSTANCES[key] = SELF;
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

    /* DualMap 视图（全国遥感 / 资质资格）的影像跟随。
       与业务视图不同，这里的瓦片挂在实例的 esriHost 上、由 syncEsri 管理，
       所以钩子要指向实例的 esri，而不是宿主的属性。
       ⚠️ 必须闭包捕获【局部 SELF】而非模块级 D：
          D 会被后建的视图覆盖（national → qual），钩子会指向别的实例，
          表现为「只有第一个视图的影像钉死不动」（实测确认）。
       同样不能少这一行 —— 否则拖动/缩放时影像钉死不动（实测复现）。*/
    SELF.svg.onImageryRefresh = function () {
      var inst = SELF;
      if (!inst.esri || !inst.svg) return;
      if (inst.esriHost && inst.esriHost.style.display === 'none') return;
      try { inst.esri.rebuild(inst.svg); } catch (e) { }
    };

    // 相机：优先用 TMap（卫星底图），失败则用 SVG 自身
    // 主动加载 SDK（attachTMap 内部会等待就绪并重试）
    /* ⚠️ Esri 底图必须【立即】建起来，不能等 TMap：
       attachTMap 在无 key 时要走一轮判定才降级，而 Esri 是免 KEY 的、
       本该第一时间就有图。此前只在 svgToSat / fit 里间接触发，
       结果资质资格视图首屏【一张瓦片都没有】（实测 tiles=0），
       用户看到的"各个功能没有遥感地图"包含这个视图。*/
    try { syncEsri(SELF); } catch (e0) { }
    if (window.SatMap && window.SatMap.loadSDK) {
      try { window.SatMap.loadSDK(function () { attachTMap(SELF, tmapHost, opts); }); }
      catch (e) { attachTMap(SELF, tmapHost, opts); }
    } else {
      attachTMap(SELF, tmapHost, opts);
    }
    return SELF;
  }

  /* ---------- 接入 TMap 卫星底图 ----------
     SDK 是异步加载的，首次调用时通常还没就绪。
     因此这里做「等待式接入」：轮询最多 12s，一旦 TMap 就绪立即接入；
     超时才降级。避免"首次没就绪 → 永远无底图"。 */
  function attachTMap(I, tmapHost, opts) {
    if (!I) return;
    if (I.map) return;                       // 已接入
    if (!window.TMap) {
      /* ⚠️ 关键提速点（实测卡 11.4 秒的元凶）：
         腾讯 SDK 在【无自有 key 且无代理】时，sat-map.loadSDK 会直接放弃
         （flush(false)，压根不注入 window.TMap）。此时 attachTMap 若还按老逻辑
         轮询 40 次 × 300ms = 12 秒才 fallback，右上角引擎文字就在
         「加载中…」上僵持 11.4 秒 —— 而 Esri 真实卫星影像其实 0.22 秒
         就已经铺满屏幕了。用户看到的就是「一直在加载」。
         现在先问 sat-map 要一个明确答复：是"决定不加载"还是"还在加载"。
           · 决定不加载 → 立刻走 Esri 底图 + 立刻回报状态（0 等待）
           · 还在加载   → 才保留短轮询（SDK 可能马上就绪）
         轮询上限也从 12s 压到 3.6s：Esri 已能独立供图，再等腾讯纯属拖慢。*/
      var SM = window.SatMap;
      var abandoned = SM && SM.state && (SM.state.failed === true) &&
                      (SM.state.provider === 'esri' || SM.state.provider === 'none');
      if (abandoned) {
        I._tries = (I._tries || 0) + 1;
        if (I._tries < 2) { setTimeout(function () { attachTMap(I, tmapHost, opts); }, 120); return; }
        fallbackEsriOnly(I, '腾讯底图未配置 KEY，已切换 Esri 卫星影像');
        return;
      }
      if (I._tries === undefined) I._tries = 0;
      I._tries++;
      if (I._tries < 12) {                   // 12 × 300ms ≈ 3.6s
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
          if (ok === false) {
            /* ⚠️ 必须把腾讯底图整层隐藏，不只是改文字提示。
               腾讯位置服务鉴权失败时行为是「瓦片请求发出、但图片画不出来」
               —— canvas 采样全黑（sat-map.probeTiles 就是据此判定的）。
               这些黑色 canvas 就留在页面上，叠在 SVG 之上，
               表现为地图上凭空出现一条条纯黑矩形（用户截图：新疆图上 8 条黑带）。
               既然这层没有任何可用内容，直接 display:none 最干净 ——
               底图主力本就是免 KEY 的 Esri World Imagery，隐藏它不影响任何功能。 */
            if (tmapHost) tmapHost.style.display = 'none';
            I.baseHidden = true;
            if (I.onTilesFail) I.onTilesFail(reason);
          } else {
            /* 探测通过（腾讯可用）时才显示。上面失败路径已隐藏过，
               这里复原，避免「先失败后成功」时底图一直空着。 */
            if (tmapHost && !I.baseUserOff) tmapHost.style.display = '';
            I.baseHidden = false;
            if (I.onTilesOk) I.onTilesOk(reason);
          }
        });
      }

      if (opts.onEngine) opts.onEngine({
        ok: true, label: '卫星影像底图 · 腾讯位置服务',
        note: (typeof I.map.__authFail !== 'undefined' && I.map.__authFail) ? '鉴权受限' : '',
        source: 'tencent'
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
   独立于腾讯 SDK：无论实例的 map 是否就绪都生效。
   腾讯不可用时（无 KEY / SDK 加载失败）也能出真实卫星影像。

   ⚠️ 原来 `I = I || D` 的兜底是有害的：D 是模块级的"当前操作实例"，
   每次 init() 都会被覆盖成最后初始化的那个（national）。
   于是「不带参数调用 syncEsri()」时，会把瓦片挂到【别的视图】的宿主上
   —— 表面能跑，但影像与地图对不上，且很难查。
   现在：调用方一律显式传实例；只有确实要取"当前实例"时才读 D。*/
  function syncEsri(I) {
    /* 不再兜底到 D —— 多视图并存时会张冠李戴。
       忘传参数时直接失败，比默默画错地方好排查。*/
    if (!I || !I.svg || !I.svg._vw || !I.host) return;
    if (!window.EsriImagery) return;
    try {
      if (!I.esriHost) {
        I.esriHost = document.createElement('div');
        I.esriHost.className = 'esri-imagery';
        I.esriHost.style.cssText = 'position:absolute;inset:0;z-index:0;' +
          'pointer-events:none;overflow:hidden';
        I.host.insertBefore(I.esriHost, I.host.firstChild);
        /* 与业务视图同理的开关 class：清不透明底色 + svg 抬到瓦片之上。
           全国/资质视图原本是靠 #nat-map.has-raster 这类各自的选择器
           处理的，加了通用开关后统一由 .has-basemap 承担。*/
        I.host.classList.add('has-basemap');
      }
      if (!I.esri) {
        I.esri = window.EsriImagery.create(I.esriHost, 'satellite');
        /* 底图真实出图状态 → 立即回报上层，不等腾讯。
           实测：Esri 首批瓦片 0.22s 出图，这里就会把「加载中…」顶掉；
           此前这一条链完全不存在，用户只能盯着「加载中…」等满 11.4 秒。*/
        I.esri.onStatus = function (ok, info) {
          if (!I.onEngine) return;
          if (ok) {
            I.tilesOk = true;
            I.tilesReason = 'esri';
            var hide = $('#nat-keyhint'); if (hide) hide.style.display = 'none';
            I.onEngine({
              ok: true, label: '卫星影像底图 · Esri World Imagery',
              note: '实拍影像 z' + (info && info.z != null ? info.z : ''),
              source: 'esri'
            });
          } else {
            I.tilesOk = false;
            I.tilesReason = 'esri-tiles-blank';
            I.onEngine({
              ok: false, label: '矢量底图 · 卫星影像未取到',
              note: '瓦片为空', source: 'esri'
            });
          }
        };
      }
      I.esri.build(I.svg);
    } catch (e) { }
  }

  /* 无腾讯 KEY 时的一键降级：直接由 Esri 独立供图。
     与 fallback() 的区别是【不宣告"卫星不可用"】——
     卫星影像明明是有的（Esri 免 KEY），说不可用既不准确也会让用户
     以为平台没有遥感能力。*/
  function fallbackEsriOnly(I, reason) {
    if (!I) return;
    I.satOk = false;
    if (I.tmapHost) I.tmapHost.style.display = 'none';
    if (I.svg) I.svg.onViewChange = null;
    syncEsri(I);
    if (!I.tilesOk && I.onEngine) {
      I.onEngine({ ok: true, label: '卫星影像底图 · Esri World Imagery', note: reason || '', source: 'esri-pending' });
    }
  }

  function svgToSat(I) {
    /* 同样不再兜底到模块级 D —— 多视图并存时会同步错对象。
       所有调用方（onViewChange 闭包、fit 的 setTimeout）都已显式传实例。*/
    if (!I) return;
    if (!I.map || !I.svg || !I.svg._vw) { syncEsri(I); return; }
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
    /* 覆写 _apply：视图变化后驱动【卫星底图跟随】+【栅格层重绘】

       ⚠️ 用户报障："地图移动或变大变小，底层地理图片也要跟着变化啊，不能不动"。
       实测确认：6 个地图全部复现 —— 拖动后业务面 transform 变了，
       而 Esri 瓦片的 left/top 纹丝不动（影像被"钉死"在屏幕上）。

       根因有两条，都在这里：
       ① 根本没有触发影像重建。build() 只在 attachImagery()/syncEsri()
          时调用一次；之后 _apply 再怎么改 tx/ty/scale，瓦片位置都不重算。
       ② `if (self._rafRaster) return;` 这个提前 return 有害 ——
          本意是"栅格重绘用 rAF 合并，别每帧都算"，但它 return 的是
          整个 _apply 函数体，连下面的 onViewChange 一起跳过了。
          结果：拖拽时 onViewChange（它会调 svgToSat → syncEsri）被吞掉，
          卫星层永远收不到"视图变了"的信号。

       修法：
         · 影像跟随独立走自己的 rAF，与栅格重绘互不影响（去掉耦合的 return）
         · 用 rebuild() 而非 build()：视图变了 _sig 也会变，build 本可生效，
           但拖拽过程中一帧可能触发多次，rAF 合并后只算一次即可
         · 只在瓦片确实需要重算时才动手（比对 _sig，EsriLayer.build 内部已有去重）*/
    GeoCanvas_.prototype._apply = (function (orig) {
      return function () {
        orig.call(this);
        var self = this;
        /* ① 卫星影像跟随
           ⚠️ 合并策略很关键：不能用"已排队就跳过"（if (_rafImagery) return），
              那样【连续两次快速缩放时，第二次会被丢弃】——
              实测滚轮放大，第一次 scale 完全不变、第二次才生效，
              用户表现为"滚一下没反应，要滚两下"。
           正确做法：始终以【最后一帧】为准 —— 排队期间只置脏标记，
           rAF 执行时读当前的 tx/ty/scale 重建。
           这样无论来几次、间隔多短，最终渲染的都是最新视图。*/
        if (self.onImageryRefresh) {
          self._imageryDirty = true;
          if (!self._rafImagery) {
            self._rafImagery = requestAnimationFrame(function () {
              self._rafImagery = null;
              if (!self._imageryDirty) return;
              self._imageryDirty = false;
              try { self.onImageryRefresh(); } catch (e) { }
            });
          }
        }
        /* ② 栅格专题层重绘（逐像元计算，开销大）。
           同样用脏标记合并，且它与影像层【各走各的 rAF】，
           互不拖累（原来两者共用一个 return，会互相吞帧）。*/
        if (self.onRasterRefresh) {
          self._rasterDirty = true;
          if (!self._rafRaster) {
            self._rafRaster = requestAnimationFrame(function () {
              self._rafRaster = null;
              if (!self._rasterDirty) return;
              self._rasterDirty = false;
              try { self.onRasterRefresh(); } catch (e) { }
            });
          }
        }
        // ③ 相机同步（腾讯底图 / 业务视图的联动回调）
        //    ⚠️ 必须无条件执行：原来被上面那个 return 跳过了
        if (this.onViewChange) {
          var v = this.view();
          try { this.onViewChange(v.lng, v.lat, this.scale); } catch (e2) { }
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
        : { type: 'vector', features: ['base', 'building2d', 'road'] });
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
    /* ⚠️ 这里曾经固定宣告「矢量底图（卫星不可用）」，是**事实错误**：
       腾讯不可用不等于卫星影像不可用 —— Esri World Imagery 免 KEY 一直
       在正常供图（实测首屏 63 张瓦片全部有图）。用户看到这句会误以为
       平台没有遥感能力。改为先问 Esri 要真实结论，问不到才给中性文案。*/
    syncEsri(I);
    if (I.tilesOk === true) {
      if (I.onEngine) I.onEngine({ ok: true, label: '卫星影像底图 · Esri World Imagery', note: reason || '', source: 'esri' });
    } else if (I.onEngine) {
      I.onEngine({ ok: false, label: '卫星影像底图加载中…', note: reason || '' });
    }
    // SVG 层自己作为主视图，独立工作
    if (I.svg) {
      I.svg.onViewChange = null;   // 解除反向驱动
      I.svg.host.style.pointerEvents = 'auto';
    }
    if (!I.ctl) {
      var c = I.host && I.host.querySelector('.dual-ctl');
      if (c) {
        c.innerHTML = '<button data-a="zin" title="放大">＋</button>' +
          '<button data-a="zout" title="缩小">－</button>' +
          '<button data-a="home" title="复位">⌂</button>';
        c.addEventListener('click', function (e) {
          var b = e.target.closest('button'); if (!b || !I.svg) return;
          var a = b.dataset.a;
          if (a === 'zin') I.svg.zoomBy(1.5);
          else if (a === 'zout') I.svg.zoomBy(1 / 1.5);
          else if (a === 'home' && I.onHome) I.onHome();
        });
        I.ctl = c;
      }
    }
  }

  /* ---------- 业务图层绘制 API ----------
   I = 目标实例（由视图 init 时捕获），避免多视图互相踩踏 */
  function area(I, obj, style) { return I && I.svg && I.svg.area('biz', obj, style); }
  function pxDot(I, l, x, y, r, st, m) { return I && I.svg && I.svg.pxDot(l, x, y, r, st, m); }
    function pxLeader(I, layer, x1, y1, x2, y2, style) {
    return I && I.svg ? I.svg.pxLeader(layer, x1, y1, x2, y2, style) : null;
  }
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
        : { type: 'vector', features: ['base', 'building2d', 'road'] });
      var b = I.ctl && I.ctl.querySelector('button[data-a="base"]');
      if (b) b.classList.toggle('on', I.satOn);
      if (I.onBaseChange) I.onBaseChange(I.satOn);
    } catch (e) { }
  }

  /* ---------- 给任意 GeoCanvas 挂 Esri 影像底图 ----------
     业务视图（总览驾驶舱 / 承保风险 / 理赔定损 / 预警调度）此前直接
     `new GeoCanvas(容器)`，从不经过 DualMap，因此【一张影像瓦片都没有】——
     实测 4 个视图的地图容器 canvas=0、img=0，屏幕上只有纯矢量色块。
     用户原话："各个功能我也没看到有遥感地图"，指的就是这个。
     这里把 Esri 底图能力独立出来，供这些视图直接挂载。*/
  function attachImagery(geo, onStatus) {
    if (!geo || !geo.host) return null;
    var host = geo.host;
    if (!host.__imageryHost) {
      var el = document.createElement('div');
      el.className = 'esri-imagery biz-imagery';
      el.style.cssText = 'position:absolute;inset:0;z-index:0;pointer-events:none;overflow:hidden';
      if (host.firstChild) host.insertBefore(el, host.firstChild);
      else host.appendChild(el);
      host.__imageryHost = el;
      /* 必须加 has-basemap：该 class 是 CSS 里"清掉不透明底色 +
         svg 提升到瓦片之上 + .gs-bg 透明"的唯一开关。
         少了它，svg 的不透明 .gs-bg 会整片盖住影像（实测只露出零星几块）。*/
      host.classList.add('has-basemap');
    }
    if (!host.__imageryLayer) {
      host.__imageryLayer = window.EsriImagery
        ? window.EsriImagery.create(host.__imageryHost, 'satellite')
        : null;
      if (host.__imageryLayer && onStatus) host.__imageryLayer.onStatus = onStatus;
    }
    /* 关键：把影像重建挂到 GeoCanvas 的视图变化钩子上。
       没有这一行，attachImagery 只在挂载时建一次瓦片，
       之后拖动/缩放影像就钉死不动（用户报障，实测 6 个地图全复现）。
       _apply 每次视图变化都会调 onImageryRefresh，内部用 rAF 合并。*/
    if (!geo.onImageryRefresh) {
      geo.onImageryRefresh = function () {
        var h = geo.host;
        if (!h || !h.__imageryLayer) return;
        if (h.__imageryHost && h.__imageryHost.style.display === 'none') return;  // 矢量模式下不重建
        try { h.__imageryLayer.rebuild(geo); } catch (e) { }
      };
    }
    if (host.__imageryLayer) {
      /* 用 rebuild 而非 build：build 开头有 _sig 去重，视图没变时直接 return。
         但标签切换/resize 场景下容器刚从 display:none 恢复，
         瓦片 DOM 还在却已错位或被清空，必须强制重建。
         瓦片本身走 tileCache 复用，不会重复发网络请求。*/
      try { host.__imageryLayer.rebuild(geo); } catch (e) { }
    }
    /* 影像/矢量切换按钮：业务视图此前完全没有底图概念，
       用户看的是纯矢量色块，加了影像后需要一个开关以便对比。*/
    if (!host.__imageryBtn) {
      var btn = document.createElement('button');
      btn.className = 'biz-base-btn';
      btn.type = 'button';
      btn.title = '切换卫星影像 / 纯矢量';
      btn.setAttribute('aria-label', '切换卫星影像或纯矢量底图');
      btn.innerHTML = '<i>◐</i><span>影像</span>';
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var el = host.__imageryHost;
        if (!el) return;
        var on = el.style.display === 'none';
        el.style.display = on ? '' : 'none';
        host.classList.toggle('basemap-off', !on);
        btn.classList.toggle('on', on);
        btn.querySelector('span').textContent = on ? '影像' : '矢量';
        /* 切回影像时必须强制重建：_sig 去重会挡住同一视图的重复 build，
           而瓦片 DOM 在上一轮 destroy 里已被移除 → 切回来是一片空白
           （实测「关了再开，影像消失」）。*/
        if (on) { try { host.__imageryLayer.rebuild(geo); } catch (e2) { } }
      });
      host.appendChild(btn);
      host.__imageryBtn = btn;
    }
    return host.__imageryLayer;
  }

  window.DualMap = {
    init: init, area: area, pxDot: pxDot, pxRing: pxRing, leader: pxLeader, pxLabel: pxLabel,
    anchor: anchor, clearBIZ: clearBIZ, clearLayer: clearLayer,
    fit: fit, fitLL: fitLL, resize: resize, toPx: toPx, toggleBase: toggleBase,
    syncToSat: svgToSat,
    syncEsri: syncEsri,
    attachImagery: attachImagery,
    svgHost: function (I) { return I && I.svg && I.svg.host; },
    tmapHost: function (I) { return I && I.tmapHost; },
    get: function (hostId) { return inst(typeof hostId === 'string' ? $(hostId) : hostId); },
    instances: INSTANCES
  };
})(window);