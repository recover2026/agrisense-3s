/* ============================================================
   AgriSense 3S · 卫星遥感底图模块
   底图来源：腾讯位置服务 GL JS（卫星影像 / 路网 / 矢量）
   合规：仅使用腾讯/高德/百度/天地图；不内置任何可用 key
   模式：SDK 未就绪或无网络时自动降级到内置 SVG 矢量引擎
   ============================================================ */
(function (global) {
  'use strict';

  var SDK_URL = 'https://map.qq.com/api/gljs?v=1.exp';
  var state = {
    ready: false, loading: false, failed: false,
    provider: 'none', // none | tencent
    keyMode: 'proxy', // proxy | own
    maps: {}
  };

  /* ---------- 卫星影像底图定义 ---------- */
  var BASEMAPS = {
    satellite: { type: 'satellite', features: ['base', 'road'], label: '卫星影像' },
    vector:    { type: 'vector', features: ['base', 'building2d', 'road', 'label'], label: '矢量地图' },
    terrain:   { type: 'vector', features: ['base'], label: '简约底图' }
  };

  /* ---------- 加载腾讯 GL JS SDK ---------- */
  function loadSDK(cb) {
    if (global.TMap) return cb(true);
    // 记录等待者，SDK 就绪后统一回调（避免重复调用时后者拿不到通知）
    state.waiters = state.waiters || [];
    if (cb) state.waiters.push(cb);
    if (state.loading) return;
    state.loading = true;

    function flush(ok) {
      var ws = state.waiters || [];
      state.waiters = [];
      ws.forEach(function (f) { try { f(ok); } catch (e) { } });
    }

    // 用户自有 key（推荐，商用需域名白名单）
    //    申请入口: https://lbs.qq.com/dev/console/key/manager
    var ownKey = '';
    try { ownKey = (global.__APP_CONFIG__ && global.__APP_CONFIG__.TMAP_KEY) || ''; } catch (e) { }
    ownKey = String(ownKey).trim();
    state.keyMode = ownKey ? 'own' : 'proxy';
    state.hasKey = !!ownKey;

    // 默认场景：注入 WorkBuddy 本地代理，key 由后端持有，前端零 key 暴露
    var hasProxy = false;
    if (!ownKey) {
      try {
        var cfg = global.__WB_TMAP_PROXY__;
        if (cfg && cfg.serviceHost) { global._TMapSecurityConfig = { serviceHost: cfg.serviceHost }; hasProxy = true; }
      } catch (e) { }
    }

    /* 性能优化（省掉约 40 次无效请求 + 2 条鉴权报错）：
       既没有自有 key、也没有可用代理时，加载腾讯 SDK 必然鉴权失败。
       此时 Esri World Imagery 已提供真实卫星影像底图，
       再去拉一遍注定失败的 SDK 纯属浪费 —— 直接放弃腾讯路径。*/
    if (!ownKey && !hasProxy && !(global.TMap)) {
      state.loading = false;
      state.failed = true;
      state.provider = 'esri';     // 由 Esri 影像层接管
      flush(false);
      return;
    }

    var s = document.createElement('script');
    // 代理模式下不传 key（key 由后端持有，前端零暴露）
    s.src = ownKey
      ? SDK_URL + '&key=' + encodeURIComponent(ownKey) + '&libraries=service'
      : SDK_URL;
    s.async = true;
    s.onload = function () {
      state.loading = false;
      if (global.TMap) { state.ready = true; state.provider = 'tencent'; flush(true); }
      else { state.failed = true; flush(false); }
    };
    s.onerror = function () { state.loading = false; state.failed = true; flush(false); };
    document.head.appendChild(s);

    // 20s 超时兜底，避免加载悬挂
    setTimeout(function () {
      if (!global.TMap) { state.failed = true; flush(false); }
      else if (!state.ready) { state.ready = true; state.provider = 'tencent'; flush(true); }
    }, 20000);
  }

  /* ---------- 瓦片出图探测 ----------
     卫星瓦片是异步加载的，且**鉴权失败时瓦片请求会发出但图片无法绘制**，
     此时 canvas 采样为纯黑。这比监听 tilesloaded 可靠 —— 鉴权失败事件不触发。
     判定：全图采样，非黑像素占比过低即视为未鉴权。 */
  function probeTiles(map, onResult, timeout) {
    timeout = timeout || 8000;
    var done = false;
    function finish(ok, reason) {
      if (done) return; done = true;
      clearTimeout(timer);
      onResult(ok, reason);
    }
    var timer = setTimeout(function () { finish(null, 'probe-timeout'); }, timeout);
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      var cv = map && map.getContainer && map.getContainer()
        ? map.getContainer().querySelector('canvas') : null;
      if (!cv) { if (tries > 20) { clearInterval(iv); finish(false, 'no-canvas'); } return; }
      try {
        var tmp = document.createElement('canvas');
        tmp.width = 120; tmp.height = 80;
        var ctx = tmp.getContext('2d');
        ctx.drawImage(cv, 0, 0, 120, 80);
        var d = ctx.getImageData(0, 0, 120, 80).data;
        var nonBlack = 0;
        for (var i = 0; i < d.length; i += 4) {
          if (d[i] > 12 || d[i + 1] > 12 || d[i + 2] > 12) nonBlack++;
        }
        var pct = nonBlack / (d.length / 4);
        if (pct > 0.12) { clearInterval(iv); finish(true, 'tiles-ok ' + (pct * 100).toFixed(0) + '%'); }
        else if (tries > 22) { clearInterval(iv); finish(false, 'tiles-blank ' + (pct * 100).toFixed(0) + '%'); }
      } catch (e) {
        clearInterval(iv); finish(null, 'probe-skip');
      }
    }, 400);
  }

  /* ---------- 创建卫星底图实例 ---------- */
  function create(hostId, opts) {
    opts = opts || {};
    var host = typeof hostId === 'string' ? document.getElementById(hostId) : hostId;
    if (!host) return null;

    var bmType = opts.baseMap || 'satellite';
    var cfg = BASEMAPS[bmType] || BASEMAPS.satellite;

    var center = opts.center || { lat: 30.6, lng: 112.3 }; // 湖北上空
    if (opts.provinceCentroid) center = opts.provinceCentroid;

    var map;
    try {
      map = new global.TMap.Map(host, {
        center: new global.TMap.LatLng(center.lat, center.lng),
        zoom: opts.zoom == null ? 7 : opts.zoom,
        minZoom: 3,
        maxZoom: 18,
        baseMap: { type: cfg.type, features: cfg.features },
        viewMode: '2D',              // 农险作业更适合固定朝向
        pitchable: false,
        rotatable: false,
        showControl: false,          // 自定义控件，避免样式冲突
        scrollable: true,
        touchZoomable: true
      });
    } catch (e) {
      state.failed = true;
      return null;
    }

    // 标准缩放级别范围
    try { map.setBoundary && null; } catch (e) { }

    return map;
  }

  /* ---------- 叠加遥感专题图层（栅格样式示意） ----------
     真实 NDVI/灾情栅格需接服务商瓦片或影像服务；
     演示版以半透明分级面表达，接口位置已固定 */
  function addPolygonLayer(map, polygons, style) {
    if (!map || !global.TMap || !polygons || !polygons.length) return null;
    try {
      return new global.TMap.MultiPolygon(map, {
        styles: {
          default: new global.TMap.PolygonStyle({
            fillColor: style.fill,
            fillOpacity: style.fillOpacity == null ? .45 : style.fillOpacity,
            strokeColor: style.stroke,
            strokeWidth: style.strokeWidth == null ? 1 : style.strokeWidth,
            strokeOpacity: style.strokeOpacity == null ? .8 : style.strokeOpacity,
            lineJoin: 'round'
          })
        },
        geometries: polygons
      });
    } catch (e) { return null; }
  }

  function addCircleLayer(map, circles, style) {
    if (!map || !global.TMap || !circles || !circles.length) return null;
    try {
      return new global.TMap.MultiCircle(map, {
        styles: {
          default: new global.TMap.CircleStyle({
            color: style.stroke,
            fillColor: style.fill,
            fillOpacity: style.fillOpacity == null ? .16 : style.fillOpacity,
            strokeWidth: style.strokeWidth == null ? 2 : style.strokeWidth,
            strokeOpacity: style.strokeOpacity == null ? .85 : style.strokeOpacity
          })
        },
        geometries: circles
      });
    } catch (e) { return null; }
  }

  function addMarkerLayer(map, markers, style) {
    if (!map || !global.TMap || !markers || !markers.length) return null;
    try {
      return new global.TMap.MultiMarker(map, {
        styles: { default: new global.TMap.MarkerStyle(style) },
        geometries: markers
      });
    } catch (e) { return null; }
  }

  /* ---------- 坐标转换 ---------- */
  function polygonGeometry(latlngs, props) {
    return { id: props.id, styleId: 'default', points: latlngs,
      properties: props.properties || {} };
  }

  global.SatMap = {
    BASEMAPS: BASEMAPS,
    loadSDK: loadSDK,
    probeAuth: probeTiles,
    create: create,
    addPolygonLayer: addPolygonLayer,
    addCircleLayer: addCircleLayer,
    addMarkerLayer: addMarkerLayer,
    polygonGeometry: polygonGeometry,
    state: state
  };
})(window);