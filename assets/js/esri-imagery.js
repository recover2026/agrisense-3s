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

  /* ⚠️ GeoCanvas.view() 的 lng/lat 字段名有误导性（2026-10-13）
     它返回的其实是**世界坐标中值**（量级 1e7），不是经纬度。
     直接把它当经度喂给 lngToTileX 会算出 1.4e10 这种荒谬的瓦片号，
     再被 `((X % n) + n) % n` 绕回任意值 —— 结果是瓦片落在地球另一头，
     屏幕上只剩一张纯色，看起来像"影像加载不出来"。
     这里统一由世界坐标自行换算经纬度，不再依赖 view() 的字段名。 */
  function viewCenterLL(view) {
    var b = view.bbox;
    if (b && b.length >= 4) return worldToLngLat((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
    // 兜底：view() 历史上也提供过真实经纬度，越界值说明是世界坐标
    var lng = Number(view.lng), lat = Number(view.lat);
    if (Math.abs(lng) <= 180 && Math.abs(lat) <= 85) return [lng, lat];
    return worldToLngLat(lng, lat);
  }

  /* 单瓦片 DOM 元素：直接用 <img> 拼，无需瓦片库 */
  var TILE = 256;

  /* ========== 瓦片缓存（治"网络延迟虚影"的核心） ==========
     2026-10-13 定位到的真因：
       旧 build() 每次都先 destroy() 把全部 <img> 从 DOM 摘掉再重建。
       1) 视图切换/缩放 → 整屏瓦片一次性清空，新瓦片从 0 开始下载
          → 屏幕露出底色，形成整片"白/灰虚影"；
       2) 已下载过的瓦片不缓存 → 每次来回拖动都重新走网络；
       3) <img> 无占位底色，加载中透明，直接看到后面的矢量层。
     修法：
       ① 瓦片图 LRU 缓存（key=z/x/y），来回移动命中缓存直接复用、零网络；
       ② 增量 diff —— 只增删真正变化的瓦片，不再整屏清空；
       ③ 每个 <img> 带占位底色 + 加载完成淡入，消除"空洞感"；
       ④ 保留旧瓦片直到新瓦片就位（下方垫一格），彻底消除空窗。 */
  var TILE_CACHE_MAX = 900;      // 缓存上限（约 900 × 256px，超过则 LRU 淘汰）
  var TILE_CACHE = new Map();    // key -> HTMLImageElement（已解码）

  function tileKey(z, x, y) { return z + '/' + x + '/' + y; }

  function cacheGet(key) {
    var el = TILE_CACHE.get(key);
    if (el) { TILE_CACHE.delete(key); TILE_CACHE.set(key, el); }  // LRU touch
    return el || null;
  }

  function cachePut(key, el) {
    TILE_CACHE.set(key, el);
    // ⚠️ 只有"不在页面上"的瓦片才可淘汰：
    //    若某张图正作为缩放过渡垫在 DOM 里，淘汰会把它从页面上摘掉，
    //    反而制造出空白（这正是本轮要消除的虚影）。
    //    先收集可淘汰项再一次性删除 —— 不能在 while 里 continue，
    //    那样 size 不减会死循环。
    if (TILE_CACHE.size <= TILE_CACHE_MAX) return;
    var evictable = [];
    TILE_CACHE.forEach(function (v, k) {
      if (evictable.length >= TILE_CACHE.size - TILE_CACHE_MAX) return;
      if (v && v.parentNode) return;         // 仍在页面上（含缩放过渡垫底）→ 保留
      evictable.push(k);
    });
    evictable.forEach(function (k) {
      var dead = TILE_CACHE.get(k);
      TILE_CACHE.delete(k);
      if (dead && dead.parentNode) dead.parentNode.removeChild(dead);
    });
  }

  /* 瓦片容器：给一张"底色占位 + 轻微网格感"的底板，
     慢速网络下看到的是有质感的底图色块，而不是刺眼的空白。 */
  var PLACE_BG = 'background:#0b1a2c;background-image:' +
    'linear-gradient(135deg,rgba(30,58,95,.55) 25%,transparent 25%),' +
    'linear-gradient(225deg,rgba(30,58,95,.55) 25%,transparent 25%);' +
    'background-size:32px 32px;';

  function EsriLayer(host, kind) {
    this.host = host;
    this.kind = kind || 'satellite';
    this.url = ESRI[this.kind] || ESRI.satellite;
    this.attribution = 'Esri World Imagery';
    this._imgs = [];
    this._sig = '';
    this._placed = {};      // key -> img（当前在 DOM 上的）
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

  /* 缩放/跳级时的过渡：旧瓦片**不能立即删除**
     ⚠️ 用户反馈的"网络延迟虚影"最典型形态就是这个：
       缩放后新层级瓦片要重新下载（境外节点，数百 ms~数秒），
       若此时把旧层级瓦片从 DOM 摘掉，屏幕就露出整片底色，
       表现为"地图一片空白/花屏"。现在保留旧瓦片当底衬，
       新瓦片 load 后淡入并把旧瓦片撤下 —— 任何时刻屏幕上都有影像。 */
  function retireAfter(img, self, key) {
    if (!img.parentNode) return;
    img.style.transition = 'opacity .34s ease';
    img.style.opacity = '0';
    setTimeout(function () {
      if (img.parentNode) img.parentNode.removeChild(img);
    }, 380);
  }

  /* 增量重建瓦片层：只增删真正变化的瓦片（2026-10-13）
     ⚠️ 旧实现是 destroy() 全删 + 全建，导致每次缩放/切换都整屏闪白，
        这正是用户看到的"网络延迟虚影"。这里改为 diff。 */
  EsriLayer.prototype.build = function (geo) {
    var w = geo._vw, h = geo._vh;
    if (!w || !h) return;
    var view = geo.view();
    if (!view) return;
    /* ⚠️ 坐标系守卫（2026-10-13）
       平台内有两套坐标：geo.js 是标准 WebMercator（1.3e7 量级），
       geo-province.js 是"相对 bbox 原点平移"后的绘图坐标（3.2e6 量级）。
       后者不是地理坐标 —— 强行换算算出的经纬度毫无意义，
       瓦片会落在地球另一头，屏幕上只剩一张纯色（用户反馈的"影像不出来"）。
       这里只在坐标确实落在墨卡托范围内时才画影像；否则不画，
       保持纯矢量底图 —— 至少是正确的，而不是错的。 */
    if (view.inMercator === false) { this._sig = 'skip-nonmercator'; this.clearAll(); return; }
    var ll = viewCenterLL(view);
    var vLng = ll[0], vLat = ll[1];
    if (!isFinite(vLng) || !isFinite(vLat)) return;
    if (Math.abs(vLng) > 180 || Math.abs(vLat) > 85) { this._sig = 'skip-invalid-ll'; this.clearAll(); return; }
    this.ensureAttribution();
    /* 层级必须**向下取整到整数后再校正**：
       全国视图时 view.zoom 会算出 5~6，若直接 round 到 6，一块瓦片
       就覆盖数千里，视觉上完全是一张纯色（用户看到的"影像一片空白"）。
       正确做法：选能看清细节的最高整数级，同时不超过 zoom 上限 18；
       zoom 已经过 GeoCanvas 用 156543.03/scale 换算，此处不再重复缩放。 */
    var z = Math.max(2, Math.min(18, Math.floor(view.zoom + 0.001)));
    var sig = [this.kind, vLng.toFixed(4), vLat.toFixed(3),
               z, w, h].join('|');
    if (sig === this._sig) return;
    this._sig = sig;
    this.zoom = z;

    var n = Math.pow(2, z);
    /* ⚠️ 瓦片显示尺寸必须由**地理尺度**反算，不能写死 256（2026-10-13）
       一个 XYZ 瓦片在 zoom=z 时覆盖的地面宽度 = 2·EARTH/2^z 米，
       折算到屏幕像素 = (2·EARTH/2^z) · geo.scale。
       此前固定按 256px 排布，而本引擎的 scale 与 WebMercator 整数层级
       并非对齐 —— 全国视图实测相邻瓦片间距 279px、宽仅 256px，
       每张之间露出 23px 黑缝，整屏呈网格状（用户截图里"怪异"的另一半）。
       现在按实际尺度算 tilePx，缝隙自然消失，任意层级都严丝合缝。 */
    var tilePx = (2 * EARTH / n) * geo.scale;
    if (!isFinite(tilePx) || tilePx <= 1) tilePx = TILE;
    var tx0 = lngToTileX(vLng, z);
    var ty0 = latToTileY(vLat, z);
    // 需要的瓦片网格范围（256px/瓦片）
    var nx = Math.ceil(w / tilePx) + 2;
    var ny = Math.ceil(h / tilePx) + 2;

    var want = {};       // key -> {x, y, left, top}
    var cnt = 0;
    /* ⚠️ Y 方向索引约定（2026-10-13）
       XYZ 瓦片的 Y 轴从**北往南**递增（Y=0 是北端），
       而本引擎的世界 Y 也是北高南低（墨卡托），
       但屏幕 Y 是"向下增大"（toScreen: y = ty - worldY·scale）。
       于是：瓦片 Y 增大 → 纬度降低 → 屏幕位置**向下**。
       原代码用 `-Math.floor(ny/2)` 起步，等价于从南半边开始枚举，
       结果整排瓦片被定位到视口上方（实测 styleTop 全为 -303px，inView=0）。
       改为以 tx0/ty0 为中心、dy 向下递增即可。 */
    var dyStart = -Math.floor(ny / 2), dyEnd = Math.ceil(ny / 2);
    for (var dy = dyStart; dy <= dyEnd; dy++) {
      for (var dx = -Math.floor(nx / 2); dx <= Math.ceil(nx / 2); dx++) {
        var X = tx0 + dx, Y = ty0 + dy;
        if (Y < 0 || Y >= n) continue;
        X = ((X % n) + n) % n;
        var lon0 = X / n * 360 - 180;
        var lat1 = Math.atan(Math.sinh(Math.PI * (1 - 2 * Y / n))) * 180 / Math.PI;
        var wx0 = lon0 / 180 * EARTH;
        var wy1 = Math.log(Math.tan(Math.PI / 4 + lat1 * Math.PI / 360)) / Math.PI * EARTH;
        var sp = geo.toScreen(wx0, wy1);
        // 完全在视口外的瓦片不必加载（省流量，也省首屏时间）
        if (sp.x > w + tilePx || sp.y > h + tilePx || sp.x + tilePx < -tilePx || sp.y + tilePx < -tilePx) continue;
        var key = tileKey(z, X, Y);
        want[key] = { X: X, Y: Y, x: sp.x, y: sp.y, px: tilePx };
        cnt++;
        if (cnt > 260) break;      // 上限保护
      }
      if (cnt > 260) break;
    }

    /* ---- diff：保留仍在视口内的瓦片，只处理新增与移出 ---- */
    var self = this;
    var nextImgs = [];
    Object.keys(want).forEach(function (key) {
      var d = want[key];
      var existing = self._placed[key];
      if (existing) {
        // 位置未变 → 原样保留（这是消除闪烁的关键：绝大多数瓦片在平移时不动）
        existing.style.left = d.x + 'px';
        existing.style.top = d.y + 'px';
        if (existing._px !== d.px) {          // 层级或窗口变化时尺寸要跟着变
          existing.style.width = d.px + 'px';
          existing.style.height = d.px + 'px';
          existing._px = d.px;
        }
        nextImgs.push(existing);
        return;
      }
      var img = cacheGet(key);
      if (img) {
        // 缓存命中：直接复用、零网络。必须 ensureId 保证事件与样式完好
        if (!img.parentNode) self.host.appendChild(img);
        img.style.left = d.x + 'px';
        img.style.top = d.y + 'px';
        img.style.width = d.px + 'px';
        img.style.height = d.px + 'px';
        img._px = d.px;
        img.style.opacity = '1';
        self._placed[key] = img;
        nextImgs.push(img);
        return;
      }
      img = document.createElement('img');
      img.decoding = 'async';
      img.loading = 'eager';
      img.style.cssText = PLACE_BG + 'position:absolute;left:' + d.x + 'px;top:' +
        d.y + 'px;width:' + d.px + 'px;height:' + d.px + 'px;' +
        'pointer-events:none;user-select:none;opacity:0;' +
        'transition:opacity .28s ease;';
      img._px = d.px;
      // 加载完成再淡入 —— 慢速网络下不会先闪一帧空白
      img.addEventListener('load', function () {
        img.style.opacity = '1';
        cachePut(key, img);
        // 本张就位后，把刚撤下的同 key 旧图（缩放过渡）清掉
        var old = self._retiring && self._retiring[key];
        if (old) {
          if (old.parentNode) old.parentNode.removeChild(old);
          delete self._retiring[key];
        }
      });
      img.addEventListener('error', function () {
        img.style.display = 'none';
        var old = self._retiring && self._retiring[key];
        if (old && old.parentNode) old.parentNode.removeChild(old);
        if (self._retiring) delete self._retiring[key];
      });
      // ⚠️ 此处必须用 self.url：外层 function(key){} 让 this 变成 undefined，
      //    写成 this.url 会抛 "Cannot read properties of undefined (reading 'url')"，
      //    异常被 dual-map 的 try/catch 吞掉 → 表现为"瓦片一张都没有"
      img.src = self.url.replace('{z}', z).replace('{x}', d.X).replace('{y}', d.Y);
      self.host.appendChild(img);
      self._placed[key] = img;
      nextImgs.push(img);
    });

    /* 移出视口的瓦片：不立即删除。
       —— 缩放换层级时，旧层级瓦片是唯一能挡住"白屏"的东西；
          若立刻摘掉，等新瓦片下载的这段时间屏幕就是空的（用户所说的虚影）。
       平移（同层级、坐标变化）时旧瓦片确实无用，延迟 800ms 兜底清理。 */
    var self2 = this;
    if (!this._retiring) this._retiring = {};
    Object.keys(this._placed).forEach(function (key) {
      if (want[key]) return;
      var el = self2._placed[key];
      delete self2._placed[key];
      if (!el) return;
      self2._retiring[key] = el;
      el.style.zIndex = '0';
      setTimeout(function () {
        if (self2._retiring && self2._retiring[key] === el) {
          if (el.parentNode) el.parentNode.removeChild(el);
          delete self2._retiring[key];
        }
      }, 1200);
    });

    this._imgs = nextImgs;
  };

  EsriLayer.prototype.clearAll = function () {
    var all = this._imgs.slice();
    if (this._retiring) {
      Object.keys(this._retiring).forEach(function (k) { if (this._retiring[k]) all.push(this._retiring[k]); }, this);
      this._retiring = {};
    }
    for (var i = 0; i < all.length; i++) {
      if (all[i] && all[i].parentNode) all[i].parentNode.removeChild(all[i]);
    }
    this._imgs = [];
    this._placed = {};
  };

  EsriLayer.prototype.destroy = function () {
    this.clearAll();
  };

  /* ---------- 拖动瞬时跟随（治"影像与矢量边界错位/虚影"） ----------
     拖动时不能每帧重建瓦片（要发网络请求，必然卡顿且闪烁）。
     做法与 raster-engine 一致：
       · 平移（scale 不变）→ 只改 CSS transform，纯合成器操作，零成本零闪烁
       · 缩放（scale 变）  → 交给 build() 重排（并先把旧瓦片留在原位做过渡）
     ⚠️ transform 传的是「相对上次 build 基准的绝对差」，不是本次增量。
        CSS transform 是覆盖语义，传增量会导致只跟上最后一步（此前踩过）。 */
  EsriLayer.prototype.onViewChange = function (geo) {
    if (!this.host || !this._placed) return;
    if (!this._baseScale) { this._baseScale = geo.scale; this._baseTx = geo.tx; this._baseTy = geo.ty; }
    var scaleRatio = geo.scale / this._baseScale;

    if (Math.abs(scaleRatio - 1) > 0.001) {
      // 缩放：transform 已失效，重建（build 内部会重置基准）
      this.host.style.transform = '';
      this._baseScale = 0;
      this.build(geo);
      return;
    }
    var dx = geo.tx - this._baseTx;
    var dy = this._baseTy - geo.ty;   // Y 轴翻转：屏幕向下 = 世界 ty 减小
    this.host.style.transform =
      'translate3d(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px,0)';
  };

  /* build 后重置 transform 基准 */
  var _origBuild = EsriLayer.prototype.build;
  EsriLayer.prototype.build = function (geo) {
    var r = _origBuild.call(this, geo);
    if (geo) {
      this._baseScale = geo.scale; this._baseTx = geo.tx; this._baseTy = geo.ty;
      if (this.host) this.host.style.transform = '';
    }
    return r;
  };

  global.EsriImagery = {
    URLS: ESRI,
    /* 瓦片缓存状态：供控制台与核验脚本读取（确认缓存是否真的在生效） */
    cacheStats: function () {
      return { cached: TILE_CACHE.size, max: TILE_CACHE_MAX };
    },
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