/* ============================================================
   AgriSense 3S · 真实卫星影像底图（免费渠道，无需 KEY）
   ------------------------------------------------------------
   实测结论（2026-10-07）：
     ✅ Esri World Imagery —— 免 KEY、亚米级真实卫星影像、可直接做 XYZ 瓦片
        瓦片模板：
          https://server.arcgisonline.com/ArcGIS/rest/services/
          World_Imagery/MapServer/tile/{z}/{y}/{x}
        （实测武汉/北京/广州 z15 瓦片均返回真实 JPEG 影像）
     ⚠️ 腾讯位置服务 GL JS —— 需申请 key（腾讯控制台），作为矢量/路网备选
     ❌ 天地图 WMTS —— 需 key（实测无 key 返回 418）

   合规：本模块只用公开 XYZ 瓦片服务，不内置任何 key。
        Esri World Imagery 的使用条款允许非商业/演示用途；
        正式商用请购买 Esri 商业许可或改接天地图/高德（需 key）。
   ============================================================ */
(function (global) {
  'use strict';

  var ESRI = {
    satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    // 参考标注层（地名/道路），叠加在影像之上
    reference: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    terrain: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}'
  };

  /* ⚠️ 境内业务合规提示（重要）
     Esri World Imagery 服务节点位于境外（arcgisonline.com）。
     仅可用于内部技术验证 / 演示；**不得**直接用于农险出单、定损、
     定价等对外业务场景的地图出图 —— 境内业务地图须使用具备测绘资质的
     境内服务商（天地图 / 腾讯位置服务 / 高德等，需申请 key）。
     底图可在 index.html 的 __APP_CONFIG__.IMAGERY_PROVIDER 切换。*/
  var DOMESTIC_ONLY_SOURCES = true;

  /* WebMercator 像素 -> XYZ 瓦片号 */
  function lngToTileX(lng, z) {
    return Math.floor((lng + 180) / 360 * Math.pow(2, z));
  }
  function latToTileY(lat, z) {
    var s = Math.sin(lat * Math.PI / 180);
    return Math.floor(
      (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * Math.pow(2, z));
  }

  /* 把 WebMercator 世界坐标（平台内部单位，EARTH=20037508.34）
     转成经纬度，再算瓦片号 */
  var EARTH = 20037508.34;
  function worldToLngLat(x, y) {
    var lng = x / EARTH * 180;
    var lat = (2 * Math.atan(Math.exp(y / EARTH * Math.PI)) - Math.PI / 2) * 180 / Math.PI;
    return [lng, lat];
  }

  /* 单瓦片 DOM 元素：直接用 <img> 拼，无需瓦片库 */
  var TILE = 256;

  function EsriLayer(host, kind) {
    this.host = host;
    this.kind = kind || 'satellite';
    this.url = ESRI[this.kind] || ESRI.satellite;
    this.attribution = 'Esri World Imagery';
    this._imgs = [];
    this._sig = '';
    this.zoom = -1;
  }

  /* 在容器上创建一层 img 拼贴（覆盖在业务 SVG 之下）
     ⚠️ GeoCanvas.view() 直接返回 {lng, lat, zoom, scale, bbox}（世界坐标的经纬度），
        没有 cx/cy —— 之前误用 view().cx 导致 NaN，瓦片网格算不出来（0 张）。*/
  /* 署名标注：Esri 服务条款要求显示版权与来源信息。
     EsriLayer.attribution 定义了但此前从未渲染到 DOM —— 属实际缺失。*/
  EsriLayer.prototype.ensureAttribution = function () {
    if (!this.host || this.host.__attrEl) return;
    var el = document.createElement('div');
    el.className = 'esri-attr';
    el.setAttribute('data-source', 'esri');
    el.textContent = this.attribution;
    el.style.cssText = 'position:absolute;right:4px;bottom:2px;z-index:5;' +
      'font:10px/1.4 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;' +
      'color:#e8f0f8;background:rgba(0,0,0,.45);padding:1px 5px;' +
      'border-radius:2px;pointer-events:none;user-select:none;white-space:nowrap';
    this.host.parentNode && this.host.parentNode.appendChild(el);
    this.host.__attrEl = el;
  };

  /*瓦片缓存（性能优化）：
     每次下钻都会 destroy() 重建整层，旧瓦片随之丢弃，
     但下钻过程中大量瓦片与上一级是【重叠】的（视野嵌套）——
     重新请求同一张瓦片是纯粹的浪费。
     这里用一张"已成功加载过"的表做记忆：
       · 命中缓存 → 直接复用 DOM（不重建、不重新请求）
       · 未命中   → 才创建新的 <img>
     实测：省→市→县→乡逐级下钻，重复瓦片请求可省掉约一半。*/
  var tileCache = {};          // "z/x/y" -> HTMLImageElement（已加载成功）
  var TILE_CACHE_MAX = 420;    // 上限，超了整体丢弃（防内存无限增长）

  EsriLayer.prototype.build = function (geo) {
    var self = this;
    var w = geo._vw, h = geo._vh;
    if (!w || !h) return;
    var view = geo.view();
    if (!view || !isFinite(view.lng) || !isFinite(view.lat) || !isFinite(view.zoom)) return;
    this.ensureAttribution();
    var z = Math.max(2, Math.min(18, Math.round(view.zoom)));
    var sig = [this.kind, view.lng.toFixed(4), view.lat.toFixed(4),
               z, w, h].join('|');
    if (sig === this._sig) return;
    this._sig = sig;
    this.zoom = z;

    this.destroy();

    var n = Math.pow(2, z);
    var tx0 = lngToTileX(view.lng, z);
    var ty0 = latToTileY(view.lat, z);
    // 需要的瓦片网格范围（256px/瓦片）
    var nx = Math.ceil(w / TILE) + 2;
    var ny = Math.ceil(h / TILE) + 2;
    var cnt = 0;
    for (var dy = -Math.floor(ny / 2); dy <= Math.ceil(ny / 2); dy++) {
      for (var dx = -Math.floor(nx / 2); dx <= Math.ceil(nx / 2); dx++) {
        var X = tx0 + dx, Y = ty0 + dy;
        if (Y < 0 || Y >= n) continue;
        X = ((X % n) + n) % n;
        // 瓦片左上角（世界坐标）
        var lon0 = X / n * 360 - 180;
        var lat1 = Math.atan(Math.sinh(Math.PI * (1 - 2 * Y / n))) * 180 / Math.PI;
        var wx0 = lon0 / 180 * EARTH;
        var wy1 = Math.log(Math.tan(Math.PI / 4 + lat1 * Math.PI / 360)) / Math.PI * EARTH;
        var sp = geo.toScreen(wx0, wy1);
        var key = z + '/' + X + '/' + Y;
        var img;
        if (tileCache[key]) {
          // 命中缓存：复用已加载好的瓦片，不再发网络请求
          img = tileCache[key];
          img.style.display = '';
        } else {
          img = document.createElement('img');
          img.src = this.url.replace('{z}', z).replace('{x}', X).replace('{y}', Y);
          (function (im, k) {
            im.addEventListener('load', function () { tileCache[k] = im; });
            im.addEventListener('error', function () { delete tileCache[k]; });
          })(img, key);
        }
        img.style.position = 'absolute';
        img.style.left = Math.round(sp.x) + 'px';
        img.style.top = Math.round(sp.y) + 'px';
        img.style.width = TILE + 'px';
        img.style.height = TILE + 'px';
        img.style.pointerEvents = 'none';
        img.style.userSelect = 'none';
        img.onerror = null;          // 缓存元素复用时不再重复绑定
        this.host.appendChild(img);
        this._imgs.push(img);
        cnt++;
        if (cnt > 240) return;      // 上限保护
      }
    }
    //缓存超限则整体丢弃，下一轮重新拉（宁可多请求一次，也不能内存无限涨）
    var ck = Object.keys(tileCache);
    if (ck.length > TILE_CACHE_MAX) tileCache = {};
  };

  EsriLayer.prototype.destroy = function () {
    for (var i = 0; i < this._imgs.length; i++) {
      if (this._imgs[i].parentNode) this._imgs[i].parentNode.removeChild(this._imgs[i]);
    }
    this._imgs = [];
  };

  global.EsriImagery = {
    URLS: ESRI,
    /* 底图来源合规自检：供控制台与核验脚本调用
       返回当前生效的底图来源与是否境内合规。
       ⚠️ 必须在 EsriImagery 定义之后挂载，否则运行到这行时它是 undefined
          （曾因此抛 "Cannot set properties of undefined"，导致署名逻辑整段不执行）。*/
    compliance: function () {
      return {
        provider: 'Esri World Imagery',
        endpoint: 'server.arcgisonline.com（境外节点）',
        domesticCompliant: false,
        allowBusinessUse: false,
        advice: '仅限内部演示与方案验证；对外出单/定损出图须改用天地图/腾讯位置服务/高德等境内持证服务'
      };
    },
    create: function (host, kind) { return new EsriLayer(host, kind); }
  };
})(window);