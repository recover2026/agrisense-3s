/* ============================================================
   阳光3S遥感平台 · 地图引擎
   纯 SVG 矢量引擎 · WebMercator · 无外部依赖 · 断网可用
   ============================================================ */
(function (global) {
  'use strict';

  var EARTH = 20037508.34;

  /* ---------- 坐标工具 ---------- */
  function mercY(lat) {
    var s = Math.min(Math.max(lat, -85.05112878), 85.05112878);
    return Math.log(Math.tan(Math.PI / 4 + s * Math.PI / 360)) / Math.PI * EARTH;
  }
  function lngToX(lng) { return lng * EARTH / 180; }
  function xToLng(x) { return x * 180 / EARTH; }
  function yToLat(y) { return (2 * Math.atan(Math.exp(y * Math.PI / EARTH)) - Math.PI / 2) * 180 / Math.PI; }

  /* ---------- 伪随机（保证每次打开数据一致） ---------- */
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* ---------- 点在多边形内（射线法） ---------- */
  function pointInRings(x, y, rings) {
    var inside = false;
    for (var i = 0; i < rings.length; i++) {
      var r = rings[i], n = r.length;
      for (var j = 0, k = n - 1; j < n; k = j++) {
        var xi = r[j][0], yi = r[j][1], xk = r[k][0], yk = r[k][1];
        if (((yi > y) !== (yk > y)) && (x < (xk - xi) * (y - yi) / (yk - yi + 1e-12) + xi)) inside = !inside;
      }
      if (inside) return true;
    }
    return inside;
  }

  function ringsBBox(rings) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    for (var i = 0; i < rings.length; i++) {
      var r = rings[i];
      for (var j = 0; j < r.length; j++) {
        if (r[j][0] < b[0]) b[0] = r[j][0];
        if (r[j][1] < b[1]) b[1] = r[j][1];
        if (r[j][0] > b[2]) b[2] = r[j][0];
        if (r[j][1] > b[3]) b[3] = r[j][1];
      }
    }
    return b;
  }

  /* ============================================================
     GeoCanvas —— 地图画布
     ============================================================ */
  function GeoCanvas(host, opts) {
    this.host = host;
    this.opts = opts || {};
    this.scale = 1;         // 1 = fit
    this.baseScale = 1;
    this.tx = 0; this.ty = 0;
    this.minScale = 1; this.maxScale = 60;
    this.layers = {};       // name -> {group, visible, order}
    this.onPick = this.opts.onPick || function () {};
    this.onView = this.opts.onView || function () {};
    this._build();
    this._bind();
  }

  GeoCanvas.prototype._build = function () {
    var h = this.host;
    h.classList.add('gs-map');
    h.innerHTML =
      '<svg class="gs-svg" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
      '<filter id="gsGlow" x="-50%" y="-50%" width="200%" height="200%">' +
      '<feGaussianBlur stdDeviation="4" result="b"/><feMerge>' +
      '<feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
      '<pattern id="gsHatch" width="8" height="8" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">' +
      '<line x1="0" y1="0" x2="0" y2="8" stroke="rgba(255,255,255,.28)" stroke-width="2"/></pattern>' +
      '</defs>' +
      '<g class="gs-world"><rect class="gs-bg" x="-1e5" y="-1e5" width="2e5" height="2e5"/></g>' +
      '<g class="gs-stack"></g>' +
      '</svg>' +
      '<div class="gs-ctl">' +
      '<button data-act="zin" title="放大">＋</button>' +
      '<button data-act="zout" title="缩小">－</button>' +
      '<button data-act="home" title="复位">⌂</button>' +
      '</div>' +
      '<div class="gs-scale"><span class="gs-scale-bar"></span><span class="gs-scale-txt"></span></div>' +
      '<div class="gs-coord"></div>';

    this.svg = h.querySelector('.gs-svg');
    this.stack = h.querySelector('.gs-stack');
    this.coordEl = h.querySelector('.gs-coord');
    this.scaleTxt = h.querySelector('.gs-scale-txt');
    this.scaleBar = h.querySelector('.gs-scale-bar');

    var self = this;
    h.querySelector('.gs-ctl').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var a = b.dataset.act;
      if (a === 'zin') self.zoomBy(1.5);
      else if (a === 'zout') self.zoomBy(1 / 1.5);
      else if (a === 'home') self.fit(self._fullBBox || self.bbox, true);
    });
  };

  GeoCanvas.prototype._bind = function () {
    var self = this, h = this.host;
    var dragging = false, moved = false, lx = 0, ly = 0, pointers = {}, pinchD = 0;
    var downTarget = null;   // pointerdown 时命中的元素（见下方 setPointerCapture 坑）

    h.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = h.getBoundingClientRect();
      var cx = e.clientX - r.left, cy = e.clientY - r.top;
      var f = e.deltaY < 0 ? 1.22 : 1 / 1.22;
      self.zoomAt(cx, cy, f);
    }, { passive: false });

    h.addEventListener('pointerdown', function (e) {
      try { h.setPointerCapture(e.pointerId); } catch (_) { }
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      // ⚠️ 关键坑（实测）：setPointerCapture 之后，pointerup 的 e.target 会变成
      // host容器 DIV，而不是按下时的 SVG path → closest('[data-pick]') 为 null
      // → 点击下钻（省/市/县/乡镇）全部静默失效。必须在 down 时把命中元素存下来。
      downTarget = e.target;
      var ids = Object.keys(pointers);
      if (ids.length === 2) {
        pinchD = self._pinchDist(pointers[ids[0]], pointers[ids[1]]);
        dragging = false;
      } else {
        dragging = true; moved = false; lx = e.clientX; ly = e.clientY;
      }
    });

    h.addEventListener('pointermove', function (e) {
      if (pointers[e.pointerId]) pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(pointers);
      if (ids.length === 2 && pinchD) {
        var d = self._pinchDist(pointers[ids[0]], pointers[ids[1]]);
        if (d > 0) { self.zoomAt(self.host.clientWidth / 2, self.host.clientHeight / 2, d / pinchD); pinchD = d; }
        return;
      }
      // 悬停地名提示：未按下拖拽时，命中可拾取要素则显示其名称（2026-10：默认不显示地名，悬停才显示）
      if (!dragging) { self._hoverTip(e); return; }
      var dx = e.clientX - lx, dy = e.clientY - ly;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      // Y 轴翻转后，向下拖动屏幕 → 世界 Y 增大 → ty 减小
      self.tx += dx; self.ty += dy; lx = e.clientX; ly = e.clientY;
      self._apply();
    });

    function up(e) {
      delete pointers[e.pointerId];
      if (self._getTip) self._getTip().style.display = 'none';
      if (Object.keys(pointers).length < 2) pinchD = 0;
      if (dragging && !moved) {
        //用 down 时的命中元素（pointerup 的 target 已被指针捕获改写）
        if (downTarget) {
          var hit = downTarget.closest ? downTarget.closest('[data-pick]') : null;
          if (hit) {
            var pl = {};
            if (hit.dataset.id) pl.id = hit.dataset.id;
            if (hit.dataset.kind) pl.kind = hit.dataset.kind;
            if (hit.dataset.ti != null) pl.ti = Number(hit.dataset.ti);
            // 村级（第5级）：vi=村在乡镇桶内的下标，vk=桶键"<县码>-<乡镇下标>"
            if (hit.dataset.vi != null) pl.vi = Number(hit.dataset.vi);
            if (hit.dataset.vk) pl.vk = hit.dataset.vk;
            self.onPick(pl, hit);
            downTarget = null;
            dragging = false;
            return;
          }
        }
        self._pick(e);
      }
      downTarget = null;
      dragging = false;
    }
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', function (e) { delete pointers[e.pointerId]; dragging = false; pinchD = 0; });

    h.addEventListener('pointerleave', function (e) { delete pointers[e.pointerId]; if (self._getTip) self._getTip().style.display = 'none'; });

    // 键盘
    h.tabIndex = 0;
    h.addEventListener('keydown', function (e) {
      var step = 60;
      if (e.key === 'ArrowLeft') { self.tx += step; }
      else if (e.key === 'ArrowRight') { self.tx -= step; }
      else if (e.key === 'ArrowUp') { self.ty -= step; }      // 北 = 屏幕向上
      else if (e.key === 'ArrowDown') { self.ty += step; }
      else if (e.key === '+' || e.key === '=') { self.zoomBy(1.4); return; }
      else if (e.key === '-') { self.zoomBy(1 / 1.4); return; }
      else return;
      e.preventDefault(); self._apply();
    });
  };

  GeoCanvas.prototype._pinchDist = function (a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  /* ---------- 悬停地名提示（2026-10：默认不显示地名，鼠标移到要素上才显示） ----------
     实现为跟随光标的浮层（position:fixed），命中 [data-pick] 且带名称的要素即显示，
     移出或命中无名称要素即隐藏。所有地图视图共用同一个 #gsHoverTip 节点。 */
  GeoCanvas.prototype._getTip = function () {
    var t = document.getElementById('gsHoverTip');
    if (!t) {
      t = document.createElement('div');
      t.id = 'gsHoverTip';
      t.className = 'gs-tip';
      t.style.display = 'none';
      var root = document.body || document.documentElement;
      if (root) root.appendChild(t);
    }
    return t;
  };
  GeoCanvas.prototype._hoverTip = function (e) {
    var tip = this._getTip();
    if (!tip) return;
    var el0 = (e.target && e.target.closest) ? e.target.closest('[data-pick]') : null;
    var nm = '';
    if (el0) {
      nm = el0.getAttribute('data-nm');
      if (!nm && el0.querySelector) {
        var tt = el0.querySelector('title');
        if (tt) nm = tt.textContent;
      }
    }
    if (nm) {
      tip.textContent = nm;
      tip.style.display = 'block';
      // 先显示再测量，避免超出视口右/下边界
      var r = tip.getBoundingClientRect();
      var x = e.clientX + 14, y = e.clientY + 16;
      if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - 14;
      if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - 16;
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
    } else {
      tip.style.display = 'none';
    }
  };

  /* ---------- 视图变换 ---------- */
  GeoCanvas.prototype.resize = function () {
    var w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    var oldW = this._vw, oldH = this._vh;
    this._vw = w; this._vh = h;
    if (!oldW || !oldH) {
      // 首次获得真实尺寸：补做一次自适应（此前隐藏状态下 fit 被跳过）
      if (this._fullBBox) this.fit(this._fullBBox);
      else this._apply();
      return;
    }
    // 尺寸变化时保持中心点地理坐标不变
    this.tx += (w - oldW) / 2; this.ty += (h - oldH) / 2;   // 尺寸变化保持中心
    this._apply();
  };

  GeoCanvas.prototype.fit = function (bbox, animate) {
    if (bbox) this._fullBBox = bbox.slice();
    if (!bbox || !this._vw || !this._vh) return;   // 容器未就绪，保留 bbox 待 resize 后重试
    /*防御非法 bbox：任一分量非有限数（NaN/undefined 参与运算后的产物）
       会让 scale/tx/ty 全变 NaN → <g transform="translate(NaN,NaN)"> →
       整张地图不可见且所有面无法拾取，且此后任何 fit 都救不回来
       （实测北京：县界 bbox 为 2 元素 [x0,y0]+w/h，旧代码硬取 b[2]/b[3]
         得到 undefined，全图 NaN）。这里直接忽略脏 bbox，保持上一帧视图。*/
    for (var i = 0; i < 4; i++) {
      if (typeof bbox[i] !== 'number' || !isFinite(bbox[i])) {
        if (window.console) console.warn('[geo] fit 收到非法 bbox，已忽略', bbox);
        return;
      }
    }
    var pad = this.opts.padding == null ? 24 : this.opts.padding;
    var bw = bbox[2] - bbox[0], bh = bbox[3] - bbox[1];
    if (bw <= 0 || bh <= 0) { bw = bh = 1; }
    var s = Math.min((this._vw - pad * 2) / bw, (this._vh - pad * 2) / bh);
    this.baseScale = s; this.minScale = s * 0.6; this.maxScale = s * 120;
    this.scale = s;
    this.tx = this._vw / 2 - (bbox[0] + bw / 2) * s;
    // Y 轴已翻转（scale(1,-1)），ty = 视口中心 + 中心Y * s
    this.ty = this._vh / 2 + (bbox[1] + bh / 2) * s;
    this._fullBBox = bbox.slice();
    this.bbox = bbox.slice();
    if (animate) this.stack.classList.add('anim'); else this.stack.classList.remove('anim');
    this._apply();
    /* ⚠️ 修复（2026-10-13）：原写成 `setTimeout(function(){ self_off(self); }, 420)`，
       但 fit() 作用域里**没有 self 这个变量**（self 是 GeoCanvas 构造函数里的局部变量）。
       定时器到点后抛 "Cannot read properties of undefined (reading 'classList')"，
       异常虽被外部吞掉，但 CSS 过渡类永远摘不掉，
       会让后续所有视图变换都停留在动画态（用户感知为"地图动不了/很卡"）。 */
    if (animate) {
      var stack = this.stack;
      setTimeout(function () {
        if (stack && stack.classList) stack.classList.remove('anim');
      }, 420);
    }
    this.onView(this.view());
  };

  GeoCanvas.prototype.zoomBy = function (f) {
    this.zoomAt(this._vw / 2, this._vh / 2, f);
  };

  GeoCanvas.prototype.zoomAt = function (cx, cy, f) {
    var ns = Math.max(this.minScale, Math.min(this.maxScale, this.scale * f));
    var real = ns / this.scale;
    this.tx = cx - (cx - this.tx) * real;
    this.ty = cy + (cy - this.ty) * real;   // Y 翻转：符号相反
    this.scale = ns;
    this._apply();
  };

  GeoCanvas.prototype._apply = function () {
    // ⚠️ Y 轴翻转：墨卡托 Y 向北为正，而 SVG 的 y 向��为正，
    //    直接绘制会导致地图上下颠倒（北方跑到下方）。
    //    因此这里叠一层 scale(1,-1) 做纵向翻转。
    var t = 'translate(' + this.tx.toFixed(2) + ',' + this.ty.toFixed(2) + ') ' +
            'scale(' + this.scale.toExponential(6) + ',' + (-this.scale).toExponential(6) + ')';
    this._clampView();
    this.stack.setAttribute('transform', t);
    this._syncPx();
    /* 当前视野 bbox —— 必须保持**世界坐标**。
       ⚠️ 修正（2026-10-13）：此处曾用 xToLng()/yToLat() 把世界坐标换算成经纬度
          再写入 this.bbox，导致：
            · 全国视图 bbox 变成 [54,1,155,55]（经纬度度数），与图元所在的
              墨卡托空间（1.3e7）完全不同量级；
            · 影像瓦片按经纬度中心去算瓦片号 → 落到地球另一头 → 屏幕一块纯色；
            · fit() 的 _fullBBox 与实际 bbox 语义不一致，缩放/复位全部跑偏。
          世界坐标与经纬度两套表示，前者用于一切几何运算，后者只在读数时换算。 */
    this.bbox = [
      (0 - this.tx) / this.scale,                     // 西（世界 X）
      (this.ty - this._vh) / this.scale,               // 南（世界 Y）
      (this._vw - this.tx) / this.scale,               // 东（世界 X）
      this.ty / this.scale                             // 北（世界 Y）
    ];
    this._updateScaleBar();
    this.onView(this.view());
    // 视图变换后的外部钩子（影像/栅格层用它做拖动瞬时跟随，避免脱节）
    if (this.onViewChange) { try { this.onViewChange(this); } catch (e) { } }
  };

  /* px 图层：抵消父级变换，使内部 px 坐标等于真实屏幕像素
   ⚠️ 数学推导（实测发现原实现错误，导致所有 px 标注整体偏移约 ty）：
     父 M = translate(tx,ty)·scale(s,-s)
     子 N = translate(A,B)·scale(1/s,-1/s)
     合成作用于 (px,py)：
       M: x = px·s + tx      y = py·(-s) + ty
       N: x = (px·s+tx)/s + A = px + tx/s + A   → 令A = -tx/s 得 px ✓
          y = (py·(-s)+ty)/(-s) + B = py - ty/s + B → 令 B = ty/s 得 py ✓
     所以正确值是 translate(-tx/s, ty/s)，不是 translate(-tx, -ty)。 */
  GeoCanvas.prototype._syncPx = function () {
    var inv = 1 / this.scale;
    var ax = (-this.tx * inv).toFixed(3);
    var ay = (this.ty * inv).toFixed(3);
    for (var n in this.layers) {
      var L = this.layers[n];
      if (!L.isPx) continue;
      L.g.setAttribute('transform',
        'translate(' + ax + ',' + ay + ') scale(' +
        inv.toExponential(6) + ',' + (-inv).toExponential(6) + ')');
    }
    // 重投影标记（screen 坐标随视图变化需重算）
    if (this.pxAnchors) {
      for (var i = 0; i < this.pxAnchors.length; i++) {
        var a = this.pxAnchors[i];
        if (!a.el) continue;
        // 窄屏：可选标注自动隐藏，避免文字堆叠
        if (a.optional) {
          var show = (this._vw || 0) >= a.minW;
          if (a.el.style.display !== (show ? '' : 'none')) {
            a.el.style.display = show ? '' : 'none';
          }
          if (!show) continue;
        }
        var s = this.toPx(a.wx, a.wy);
        if (a.el.tagName === 'circle') {
          a.el.setAttribute('cx', s.x.toFixed(1));
          a.el.setAttribute('cy', s.y.toFixed(1));
        } else {
          a.el.setAttribute('x', s.x.toFixed(1));
          a.el.setAttribute('y', (s.y + (a.dy || 0)).toFixed(1));
        }
        // 关联的附属图元（外环、内圈）跟随同一屏幕坐标
        if (a.siblings) {
          for (var j = 0; j < a.siblings.length; j++) {
            var sb = a.siblings[j];
            if (!sb) continue;
            sb.setAttribute('cx', s.x.toFixed(1));
            sb.setAttribute('cy', s.y.toFixed(1));
          }
        }
      }
    }
  };

  /* 把世界坐标点转成 px 图层用的屏幕坐标 */
  GeoCanvas.prototype.toPx = function (wx, wy) {
    return { x: wx * this.scale + this.tx, y: this.ty - wy * this.scale };
  };

  /* 登记一个需要随视图重投影的 px 标记
     optional=true 时，容器宽度不足 minW 自动隐藏（防窄屏标注堆叠） */
  GeoCanvas.prototype.anchor = function (el, wx, wy, dy, siblings, optional, minW) {
    this.pxAnchors = this.pxAnchors || [];
    this.pxAnchors.push({
      el: el, wx: wx, wy: wy, dy: dy || 0, siblings: siblings,
      optional: !!optional, minW: minW || 620
    });
    return el;
  };

  /* zoom 换算
     ⚠️ 本引擎的 scale 语义是 **像素 / 世界单位**（见 toPx: x·scale + tx），
        与 Leaflet 等库的 scale（米/像素）方向相反，这里极易搞错。
     世界总宽 = 2·EARTH 米；在 zoom=z 时切成 256·2^z 像素：
        scale = (256·2^z) / (2·EARTH)
        ⇒ z = log2(scale · 2 · EARTH / 256)
     ⚠️ 基准错过的三次，全部表现为"影像整屏空白/纯色"：
        · log2(256 / scale)      —— 完全反向
        · log2(156543.03 / scale) —— 少了 2·EARTH/256 = 156543 这一层
        · log2(EARTH / scale)     —— 仍少 128 倍（把 EARTH 当成了 scale 的分母）
     现在统一用 z = log2(scale · EARTH / 128)，全国视图得 ≈11，与实际相符。 */
  var EARTH_HALF = 20037508.34;

  GeoCanvas.prototype.view = function () {
    var b = this.bbox || [0, 0, 0, 0];
    var cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    // 仅当坐标落在标准墨卡托范围内时，zoom 才是真实地理层级；
    // 否则（如全国平移坐标）退化为 0，交由调用方按相对缩放处理
    var inMerc = Math.abs(cx) <= 20037509 && Math.abs(cy) <= 20037509;
    var z = (this.scale && inMerc) ? Math.log2(this.scale * EARTH_HALF / 128) : 0;
    return {
      // ⚠️ lng/lat 历史上返回的是**世界坐标中值**（量级 1e7 或 3e6），
      //    不是经纬度。字段名误导导致 esri-imagery 曾把它当经度用，
      //    算出 1.4e10 的瓦片号。保留原字段兼容既有调用，
      //    同时新增语义正确的 lngLL/latLL（仅标准墨卡托下有效）。
      lng: +cx.toFixed(4),
      lat: +cy.toFixed(4),
      lngLL: +(cx / 20037508.34 * 180).toFixed(6),
      latLL: +((2 * Math.atan(Math.exp(cy / 20037508.34 * Math.PI)) - Math.PI / 2) * 180 / Math.PI).toFixed(6),
      inMercator: inMerc,
      zoom: +z.toFixed(2),
      scale: this.scale,
      bbox: b
    };
  };

  GeoCanvas.prototype._updateScaleBar = function () {
    if (!this._vw || !this.scale) return;
    // 内部变换 scale = 世界单位/像素，而 WebMercator 世界单位即「米」
    var mPerPx = 1 / this.scale;
    if (!isFinite(mPerPx) || mPerPx <= 0 || mPerPx > 1e12) return;
    var targetPx = 92;
    var m = mPerPx * targetPx;
    var pow = Math.pow(10, Math.floor(Math.log10(m)));
    var nice = [1, 2, 5, 10].map(function (x) { return x * pow; })
      .reduce(function (a, b) { return Math.abs(b - m) < Math.abs(a - m) ? b : a; });
    var px = nice / mPerPx;
    px = Math.max(40, Math.min(130, px));
    var shown = px * mPerPx;
    this.scaleBar.style.width = Math.round(px) + 'px';
    this.scaleTxt.textContent = shown >= 1000
      ? (shown / 1000).toFixed(shown >= 10000 ? 0 : 1) + ' km'
      : Math.round(shown) + ' m';
  };

  /* ---------- 图层 ---------- */
  GeoCanvas.prototype.layer = function (name, order) {
    var g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'gs-layer gs-layer-' + name);
    this.stack.appendChild(g);
    var L = this.layers[name] = { g: g, visible: true, order: order || 0 };
    this._reorder();
    return L;
  };

  GeoCanvas.prototype._reorder = function () {
    var self = this;
    Object.keys(this.layers)
      .sort(function (a, b) { return self.layers[a].order - self.layers[b].order; })
      .forEach(function (n) { self.stack.appendChild(self.layers[n].g); });
  };

  GeoCanvas.prototype.show = function (name, on) {
    var L = this.layers[name]; if (!L) return;
    L.visible = on !== false;
    L.g.style.display = L.visible ? '' : 'none';
  };

  GeoCanvas.prototype.clear = function (name) {
    var L = this.layers[name]; if (!L) return;
    L.g.innerHTML = '';
    /* ⚠️ 必须同时清 pxItems（像素坐标元素登记表）。
       pxDot/pxLabel 会把元素挂到 L.pxItems，视图变化时 _apply() 遍历
       pxItems 按世界坐标重新定位。若只清 innerHTML 而留下 pxItems，
       已脱离 DOM 的旧元素仍会被 _apply 反复 move，
       而它们的坐标是按上一级视图算的 —— 表现为切层级后
       "地图边缘凭空残留几个红圈/文字"，且怎么缩放都去不掉。 */
    L.pxItems = [];
  };

  /* ---------- 拾取 ---------- */
  GeoCanvas.prototype._pick = function (e) {
    var target = e.target.closest ? e.target.closest('[data-pick]') : null;
    if (target) {
      var payload = {};
      if (target.dataset.id) payload.id = target.dataset.id;
      if (target.dataset.kind) payload.kind = target.dataset.kind;
      if (target.dataset.ti != null) payload.ti = Number(target.dataset.ti);
      this.onPick(payload, target);
      return;
    }
    // 兜底：按坐标找要素
    var r = this.host.getBoundingClientRect();
    var px = e.clientX - r.left, py = e.clientY - r.top;
    var gx = (px - this.tx) / this.scale, gy = (this.ty - py) / this.scale;
    if (this._hitTest) this.onPick(this._hitTest(gx, gy) || {}, null);
  };

  /* ---------- 屏幕像素标记 ----------
     在 px 类图层中，坐标以【屏幕像素】给出，内部自动反缩放，
     保证标记在任何缩放级别下视觉大小恒定（避免世界坐标硬编码半径失控） */
  GeoCanvas.prototype.pxLayer = function (name, order) {
    var L = this.layer(name, order);
    L.isPx = true;
    L.g.setAttribute('data-px', '1');
    return L;
  };

  GeoCanvas.prototype.pxDot = function (layerName, x, y, radiusPx, style, meta) {
    var L = this.layers[layerName]; if (!L) return null;
    var c = el('circle', { cx: x, cy: y, r: radiusPx, class: 'gs-dot ' + (style.cls || '') });
    if (style.fill) c.setAttribute('fill', style.fill);
    if (style.stroke) { c.setAttribute('stroke', style.stroke); c.setAttribute('stroke-width', style.sw || 1.5); }
    if (style.opacity != null) c.setAttribute('opacity', style.opacity);
    if (style.filter) c.setAttribute('filter', style.filter);
    if (style.dash) c.setAttribute('stroke-dasharray', style.dash);
    if (meta) {
      c.setAttribute('data-pick', '1');
      if (meta.id) c.setAttribute('data-id', meta.id);
      if (meta.kind) c.setAttribute('data-kind', meta.kind);
      if (meta.title) { var t = el('title'); t.textContent = meta.title; c.appendChild(t); }
    }
    L.g.appendChild(c); L.pxItems = L.pxItems || []; L.pxItems.push(c);
    return c;
  };

  GeoCanvas.prototype.pxRing = function (layerName, x, y, radiusPx, style) {
    return this.pxDot(layerName, x, y, radiusPx, {
      fill: 'none', stroke: style.stroke, sw: style.sw || 2,
      opacity: style.opacity == null ? .9 : style.opacity, dash: style.dash, filter: style.filter
    });
  };

  /* 标签避让：让新标签不与同层已有标签的**包围盒**相交。
     ⚠️ 用户要求"地名不能重影"（2026-10-14），原实现三个真 bug：
       ① 只判「新标签的锚点 X 是否落在旧标签的横向范围内」，
          完全没判纵向 —— 两个标签中心高度接近时，
          只要锚点 X 落在对方盒内就判为重叠 → 长地名被误判、
          短地名被漏判（实测省级重叠 7 对，其中「恩施州」与「武汉」相距
          数百像素仍被判重叠）；
       ② 只向上让位 8 次，且不做螺旋尝试 ——
          上方被挡死就放弃，标签仍然叠着；
       ③ 用 getBoundingClientRect 取已插入元素的尺寸，
          但 pxItems 里的旧元素可能尚未完成布局（返回 0 宽高），
          导致避让"看不见"它们。

     现在：按文字实际宽高做**包围盒相交**判定 + 上下左右螺旋找位 +
     找不到就缩字号重试。字号由 pxLabel 的 style.size 提供。 */
  GeoCanvas.prototype._avoidLabels = function (layerName, x, y, textW, textH) {
    var L = this.layers[layerName];
    if (!L || !L.pxItems) return y;
    var R = this.host.getBoundingClientRect();
    var hostX = R.left, hostY = R.top;
    var self = this;
    function boxes() {
      var out = [];
      for (var i = 0; i < L.pxItems.length; i++) {
        var it = L.pxItems[i];
        if (!it._lx || !it.textContent) continue;
        var b = it.getBoundingClientRect();
        if (b.width <= 0) continue;               // 未完成布局 → 跳过（原来会误判）
        out.push(b);
      }
      return out;
    }
    function hits(bb, arr) {
      for (var i = 0; i < arr.length; i++) {
        var b = arr[i];
        if (bb.left < b.right + 2 && bb.right > b.left - 2 &&
            bb.top < b.bottom + 2 && bb.bottom > b.top - 2) return true;
      }
      return false;
    }
    var w = textW || 40, h = textH || 14;
    var arr = boxes();
    if (!hits({ left: hostX + x - w / 2, right: hostX + x + w / 2,
                top: hostY + y - h, bottom: hostY + y + h * 0.3 }, arr)) return y;

    /* 螺旋找位：先上下（最自然），再左右，最后对角 */
    /* ⚠️ 步长太小挪不开（实测湖北省级 17 个市挤在一起，
       step≈10px 时 7 圈最多挪 70px，而相邻市名间距只有 40~80px，
       挪完还是压着 —— 而且"缩小字号"反而让它们靠得更近，重叠反而从 7 对涨到 11 对）。
       现在步长按字号×1.6 取，并放宽到 12 圈。 */
    var step = Math.max(16, h * 1.6);
    var dirs = [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (var ring = 1; ring <= 12; ring++) {
      for (var d = 0; d < dirs.length; d++) {
        var nx = x + dirs[d][0] * step * ring;
        var ny = y + dirs[d][1] * step * ring;
        /* 边界内收，避免溢出地图外 */
        if (hostX + nx - w / 2 < R.left + 6 || hostX + nx + w / 2 > R.right - 6) continue;
        if (hostY + ny - h < R.top + 14 || hostY + ny + h * 0.3 > R.bottom - 8) continue;
        if (!hits({ left: hostX + nx - w / 2, right: hostX + nx + w / 2,
                    top: hostY + ny - h, bottom: hostY + ny + h * 0.3 }, arr)) {
          return ny;
        }
      }
    }
    return y;                                   // 实在没位置：宁可轻微重叠也不要丢地名
  };

  GeoCanvas.prototype.pxLabel = function (layerName, x, y, text, style, meta) {
    var L = this.layers[layerName]; if (!L) return null;
    /* 预估文字占位：中文按 1em 宽，英文数字按 0.58em
       （真实宽度由 measureText 校准，见下方 estTextW） */
    var size = style.size || 12;
    var estW = 0;
    for (var ci = 0; ci < text.length; ci++) {
      estW += text.charCodeAt(ci) > 255 ? size : size * 0.58;
    }
    estW = Math.max(size, estW);
    var estH = size * 1.15;
    /* ① 先按原字号避让 */
    y = this._avoidLabels(layerName, x, y, estW, estH);
    var t = el('text', {
      x: x, y: y, class: 'gs-label', fill: style.fill || '#e8f0fb',
      'font-size': size, 'text-anchor': style.anchor || 'middle',
      'paint-order': 'stroke', stroke: style.halo || 'rgba(3,8,18,.9)',
      'stroke-width': style.haloW || 3.4, 'font-weight': style.weight || 700, 'font-family': 'inherit'
    });
    if (style.opacity != null) t.setAttribute('opacity', style.opacity);
    t.textContent = text;
    t._lx = 1;              // 标记：供 _avoidLabels 识别为标签
    t._estW = estW; t._estH = estH;
    if (meta) {
      t.setAttribute('data-pick', '1');
      if (meta.id) t.setAttribute('data-id', meta.id);
      if (meta.kind) t.setAttribute('data-kind', meta.kind);
      t.style.cursor = meta.kind ? 'pointer' : 'default';
    }
    L.g.appendChild(t); L.pxItems = L.pxItems || []; L.pxItems.push(t);

    /* ② 插入后按**真实尺寸**重定位 —— 这才是真正消重影的关键一步
       ⚠️ 实测教训（2026-10-14，湖北省级 17 个市）：
       插入前只能拿"估算宽高"算位置，而浏览器量出的真实宽度差得很远
       ——「恩施土家族苗族自治州」估算 68px、**实际 85px**。
       于是第一轮避让以为放得下，插入后却压着别人（实测重叠 16 对）。
       而"一撞就缩字号"更糟：缩完横向占位变小、两个标签靠得更近，
       重叠不减反增。

       现在的正确顺序：**先位移 → 位移无解才缩字号**。
       位移用插入后的真实矩形算；keepIn 回调保证落点仍在本行政区界内
       （防止「北京」被推到「河北」境内）。 */
    if (!style.noAvoid) {
      try {
        for (var guard = 0; guard < 3; guard++) {
          var pos = this._findFreeSpot(layerName, t, x, y, style.keepIn);
          if (!pos) break;
          t.setAttribute('x', pos.x);
          t.setAttribute('y', pos.y);
          x = pos.x; y = pos.y;
          if (!this._labelBoxHits(layerName, t)) break;
        }
        /* 挪不动才降字号，且下限 8.5px（再小用户看不清地名） */
        if (this._labelBoxHits(layerName, t)) {
          if (style.keepIn) {
            /* keepIn 是主体名（如全国层省名），不缩 ——
               交给 national-view 的第二轮"引线出框"处理 */
            t.setAttribute('data-hits', '1');
          } else {
            for (var k = 1; k <= 2; k++) {
              var ns = Math.max(8.5, size * (k === 1 ? 0.86 : 0.75));
              t.setAttribute('font-size', ns);
              t.setAttribute('stroke-width', Math.max(2.6, ns * 0.34));
              if (!this._labelBoxHits(layerName, t)) break;
            }
          }
        }
      } catch (e) { }
    }
    return t;
  };

  /* 为已插入的标签找一个不与他人相交的空位
     keepIn(x,y) 返回 true 表示该点仍在本行政区界内（可选）。
     找不到返回 null —— 由调用方决定是缩字号还是保留原地。 */
  GeoCanvas.prototype._findFreeSpot = function (layerName, self, x0, y0, keepIn) {
    var L = this.layers[layerName];
    if (!L) return null;
    var R = this.host.getBoundingClientRect();
    var b0 = self.getBoundingClientRect();
    var w = b0.width || 40, h = b0.height || 14;
    var step = Math.max(13, h * 0.9);
    var DIRS = [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (var ring = 0; ring <= 14; ring++) {
      for (var d = 0; d < (ring === 0 ? 1 : 8); d++) {
        var ang = (d / (ring === 0 ? 1 : ring * 8)) * Math.PI * 2;
        var nx = ring === 0 ? x0 : x0 + Math.cos(ang) * step * ring;
        var ny = ring === 0 ? y0 : y0 + Math.sin(ang) * step * ring;
        var sx = R.left + nx, sy = R.top + ny;
        /* 屏幕边界内收，避免溢出地图外 */
        if (sx - w / 2 < R.left + 4 || sx + w / 2 > R.right - 4) continue;
        if (sy - h * 0.8 < R.top + 10 || sy + h * 0.3 > R.bottom - 6) continue;
        /* 必须仍在本行政区界内（防止地名被推到邻省） */
        if (keepIn && !keepIn(nx, ny)) continue;
        var hit = false;
        for (var i = 0; i < L.pxItems.length; i++) {
          var it = L.pxItems[i];
          if (it === self || !it._lx) continue;
          var b = it.getBoundingClientRect();
          if (b.width <= 0) continue;
          if (sx - w / 2 < b.right + 3 && sx + w / 2 > b.left - 3 &&
              sy - h * 0.8 < b.bottom + 2 && sy + h * 0.3 > b.top - 2) { hit = true; break; }
        }
        if (!hit) return { x: nx, y: ny };
      }
    }
    return null;
  };

  /* 标签真实包围盒是否与同层其它标签相交（排除自己） */
  GeoCanvas.prototype._labelBoxHits = function (layerName, self) {
    var L = this.layers[layerName];
    if (!L || !L.pxItems) return false;
    var b0 = self.getBoundingClientRect();
    if (b0.width <= 0) return false;
    for (var i = 0; i < L.pxItems.length; i++) {
      var it = L.pxItems[i];
      if (it === self || !it._lx) continue;
      var b = it.getBoundingClientRect();
      if (b.width <= 0) continue;
      if (b0.left < b.right + 2 && b0.right > b.left - 2 &&
          b0.top < b.bottom + 2 && b0.bottom > b.top - 2) return true;
    }
    return false;
  };

  /* ---------- 绘制基元 ---------- */
  var NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    return n;
  }

  GeoCanvas.prototype.area = function (layerName, obj, style) {
    var L = this.layers[layerName]; if (!L) return null;
    var d = [];
    for (var i = 0; i < obj.r.length; i++) {
      var r = obj.r[i];
      for (var j = 0; j < r.length; j++) {
        d.push((j ? 'L' : 'M') + r[j][0].toFixed(1) + ',' + r[j][1].toFixed(1));
      }
      d.push('Z');
    }
    var p = el('path', {
      d: d.join(''), class: 'gs-area ' + (style.cls || ''),
      fill: style.fill, 'fill-opacity': style.fillOpacity,
      stroke: style.stroke, 'stroke-width': style.strokeWidth == null ? 1 : style.strokeWidth,
      'stroke-dasharray': style.dash || null,
      'vector-effect': 'non-scaling-stroke'
    });
    if (obj.n != null) {
      p.setAttribute('data-pick', '1');
      p.setAttribute('data-nm', obj.n);   // 悬停提示用：要素名称
      if (obj.c != null) p.setAttribute('data-id', obj.c);
      if (obj.kind) p.setAttribute('data-kind', obj.kind);
      // 乡镇等子级要素需要带索引，才能定位到具体那一个
      if (obj._ti != null) p.setAttribute('data-ti', obj._ti);
      // 村（第5级）：vi=村下标，vk=所属乡镇桶键
      if (obj._vi != null) p.setAttribute('data-vi', obj._vi);
      if (obj._vk) p.setAttribute('data-vk', obj._vk);
      var t = el('title'); t.textContent = obj.n; p.appendChild(t);
    }
    L.g.appendChild(p);
    return p;
  };

  GeoCanvas.prototype.dot = function (layerName, x, y, r, style, meta) {
    var L = this.layers[layerName]; if (!L) return null;
    var attrs = { cx: x.toFixed(1), cy: y.toFixed(1), r: r, class: 'gs-dot ' + (style.cls || '') };
    if (style.fill) attrs.fill = style.fill;
    if (style.stroke) { attrs.stroke = style.stroke; attrs['stroke-width'] = style.sw || 1.5; }
    if (style.opacity != null) attrs.opacity = style.opacity;
    if (style.filter) attrs.filter = style.filter;
    if (meta) {
      attrs['data-pick'] = '1';
      if (meta.id) attrs['data-id'] = meta.id;
      if (meta.kind) attrs['data-kind'] = meta.kind;
      if (meta.title) attrs['data-nm'] = meta.title;
    }
    var c = el('circle', attrs);
    if (meta && meta.title) { var t = el('title'); t.textContent = meta.title; c.appendChild(t); }
    L.g.appendChild(c);
    return c;
  };

  GeoCanvas.prototype.poly = function (layerName, pts, style, meta) {
    var L = this.layers[layerName]; if (!L) return null;
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join('');
    var p = el('path', {
      d: d, class: 'gs-line', fill: 'none',
      stroke: style.stroke, 'stroke-width': style.width == null ? 2 : style.width,
      'stroke-dasharray': style.dash || null,
      'stroke-opacity': style.opacity == null ? 1 : style.opacity,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    });
    if (meta) { p.setAttribute('data-pick', '1'); if (meta.id) p.setAttribute('data-id', meta.id); if (meta.kind) p.setAttribute('data-kind', meta.kind); if (meta.name || meta.title) p.setAttribute('data-nm', meta.name || meta.title); }
    L.g.appendChild(p);
    return p;
  };

  GeoCanvas.prototype.label = function (layerName, x, y, text, style, meta) {
    var L = this.layers[layerName]; if (!L) return null;
    var attrs = {
      x: x.toFixed(1), y: y.toFixed(1), class: 'gs-label',
      fill: style.fill || '#e8f0fb', 'font-size': (style.size || 12) / this.scale,
      'text-anchor': style.anchor || 'middle',
      'paint-order': 'stroke', stroke: style.halo || 'rgba(3,8,18,.85)',
      'stroke-width': (style.haloW || 3) / this.scale,
      'font-family': 'inherit', 'font-weight': style.weight || 600
    };
    if (style.opacity != null) attrs.opacity = style.opacity;
    var t = el('text', attrs);
    t.textContent = text;
    t._lx = 1;              // 标记：供 _avoidLabels 识别为标签
    if (meta) { t.setAttribute('data-pick', '1'); if (meta.id) t.setAttribute('data-id', meta.id); if (meta.kind) t.setAttribute('data-kind', meta.kind); }
    L.g.appendChild(t);
    return t;
  };

  /* ---------- 视野约束 ----------
     防止用户把地图拖到数据范围之外导致「地图丢失」（画面全空）。
     约束：视口中心必须落在数据外接框内（按比例投影到 5%–95% 区间），
     保证任何时候都能看到中国主体。 */
  GeoCanvas.prototype._clampView = function () {
    var bb = this._fullBBox;
    if (!bb || !this._vw || !this.scale) return;
    var bw = bb[2] - bb[0], bh = bb[3] - bb[1];
    if (bw <= 0 || bh <= 0) return;
    // 允许的中心区间：数据框内缩 5%（即 5%–95%）
    var padX = bw * 0.05, padY = bh * 0.05;
    var vx = (this._vw / 2 - this.tx) / this.scale;
    var vy = (this.ty - this._vh / 2) / this.scale;   // Y 轴已翻转
    var nvx = Math.min(bb[2] - padX, Math.max(bb[0] + padX, vx));
    var nvy = Math.min(bb[3] - padY, Math.max(bb[1] + padY, vy));
    if (nvx !== vx) this.tx = this._vw / 2 - nvx * this.scale;
    if (nvy !== vy) this.ty = this._vh / 2 + nvy * this.scale;
  };

  /* ---------- 屏幕坐标互转 ---------- */
  // Y 轴已翻转（stack 上叠了 scale(1,-1)），故屏幕 y = ty - 世界Y * scale
  GeoCanvas.prototype.toScreen = function (x, y) {
    return { x: x * this.scale + this.tx, y: this.ty - y * this.scale };
  };
  GeoCanvas.prototype.toWorld = function (px, py) {
    return { x: (px - this.tx) / this.scale, y: (this.ty - py) / this.scale };
  };

  GeoCanvas.prototype.project = function (lng, lat) {
    return [lngToX(lng), mercY(lat)];
  };

  /* ---------- 几何工具 ---------- */
  /* 面积最大的单环质心（保留原语义，供面积计算等场合用） */
  function polyCentroid(rings) {
    var best = null, ba = -1;
    if (!rings || !rings.length) return [0, 0];
    for (var i = 0; i < rings.length; i++) {
      var r = rings[i], a = 0, cx = 0, cy = 0;
      for (var j = 0, k = r.length - 1; j < r.length; k = j++) {
        var f = r[j][0] * r[k][1] - r[k][0] * r[j][1];
        a += f; cx += (r[j][0] + r[k][0]) * f; cy += (r[j][1] + r[k][1]) * f;
      }
      a *= 0.5;
      if (Math.abs(a) > ba) { ba = Math.abs(a); best = a ? [cx / (6 * a), cy / (6 * a)] : r[0]; }
    }
    return best || [0, 0];
  }

  /* ---------- 标签锚点（2026-10-14 新增）----------
     为什么不能用 polyCentroid：它取"面积最大的单个环的质心"，
     且**不保证落在多边形内部**。对凹形行政区（内蒙古、甘肃、
     湖北这类带明显凹陷的省）质心会跑到界外，
     结果就是"地名不在自己区域里"——用户反馈的核心问题。

     算法（三步，保证点一定在自己的区域内且尽量靠中心）：
     ① 先取所有环的**面积加权质心**（比"最大环"更符合整体形状）；
     ② 若该点在界内 → 直接用（绝大多数情况，零成本）；
     ③ 若不在界内 → 以质心为起点，在包围盒内做「半径递增扫描」：
        从 0 开始按 bbox 对角线的 5% 步长向外找第一个落在界内的点，
        取距离质心最近的 —— 即"落在界内且离几何中心最近"的点。

     多环（如内蒙 + 飞地）统一处理：先用最大环，失败再试其他环。
     opt.screenPx / scale 可选：传入后会把「5% 步长」换算成像素，
     使缩放时锚点稳定（避免缩放一次挪一次）。 */
  function labelAnchor(rings, scale) {
    if (!rings || !rings.length) return [0, 0];

    // ① 面积加权质心
    var A = 0, cx = 0, cy = 0;
    for (var i = 0; i < rings.length; i++) {
      var r = rings[i];
      if (!r || r.length < 3) continue;
      var a = 0, rx = 0, ry = 0;
      for (var j = 0, k = r.length - 1; j < r.length; k = j++) {
        var f = r[j][0] * r[k][1] - r[k][0] * r[j][1];
        a += f; rx += (r[j][0] + r[k][0]) * f; ry += (r[j][1] + r[k][1]) * f;
      }
      a *= 0.5;
      if (!a) continue;
      A += a; cx += rx / 6; cy += ry / 6;
    }
    var c0 = A ? [cx / A, cy / A] : null;
    if (!c0) {
      // 全退化（面积≈0）→ 退回最大环的首点
      var big = rings.reduce(function (m, r) {
        return (!m || (r && r.length > m.length)) ? r : m;
      }, null);
      return big && big[0] ? big[0] : [0, 0];
    }

    // ② 质心在界内 → 直接用
    if (pointInRings(c0[0], c0[1], rings)) return c0;

    // ③ 界内最近点扫描
    var bb = ringsBBox(rings);
    var diag = Math.sqrt(Math.pow(bb[2] - bb[0], 2) + Math.pow(bb[3] - bb[1], 2)) || 1;
    var step = diag * 0.05;
    /* 缩放感知：把步长换算成"至少 ~18 屏幕像素"，
       否则全国视图下一步跨度过小要扫上百次，县级视图又过粗 */
    if (scale) {
      var minWorld = 18 / scale;
      if (step < minWorld) step = minWorld;
    }
    var best = null, bestD = Infinity;
    /* 8 个方向 × 逐环尝试（第一个成功的立即返回，因为8向已够密） */
    for (var ri = 0; ri < rings.length && !best; ri++) {
      for (var s = step; s <= diag; s += step) {
        for (var di = 0; di < 8; di++) {
          var ang = di * Math.PI / 4;
          var qx = c0[0] + Math.cos(ang) * s;
          var qy = c0[1] + Math.sin(ang) * s;
          if (qx < bb[0] || qx > bb[2] || qy < bb[1] || qy > bb[3]) continue;
          if (pointInRings(qx, qy, rings)) {
            /* 落在当前环内即采纳（它已在整体界内，pointInRings 已确认） */
            var d = Math.pow(qx - c0[0], 2) + Math.pow(qy - c0[1], 2);
            if (d < bestD) { bestD = d; best = [qx, qy]; }
            break;
          }
        }
        if (best) break;
      }
    }
    return best || c0;
  }

  function polyArea(rings) {
    var s = 0;
    for (var i = 0; i < rings.length; i++) {
      var r = rings[i];
      for (var j = 0, k = r.length - 1; j < r.length; k = j++) s += r[k][0] * r[j][1] - r[j][0] * r[k][1];
    }
    return Math.abs(s / 2);
  }

  /* ---------- 标签排布器（防重影，2026-10-14）----------
     用户反馈"地名不能重影"。此前各视图用的是简单数组：
         for (i) for (j) if (距离 < 46²) 算重叠
     问题：① 只判圆心距，不判文字实际占位（长地名更容易压）；
           ② 冲突就整体不画 → 小地名被大地名"吃掉"，图上缺字；
           ③ 字号固定，小区域地名和大地名一样大，视觉突兀。

     本排布器按优先级（区域大者优先）逐个放：
       · 字号按区域的屏幕面积自适应（大 14px → 小 9px）
       · 用**文字包围盒**判重叠（按字数估宽，比圆心距准）
       · 冲突时不放弃，改为在锚点周围按螺旋偏移找空位（4px 步进，8 圈）
       · 螺旋找位仍失败且半径已到边 → 缩字号再试一档
       · 全部失败 → 退回原点，保证地名仍在（只是可能轻微重叠）
     */
  function LabelPlacer() {
    var boxes = [];
    var W = 0, H = 0;
    return {
      reset: function (vw, vh) { boxes = []; W = vw; H = vh; },
      /* prio 越大越优先（一般传区域面积） */
      place: function (x, y, text, size, prio) {
        var n = Math.max(1, (text || '').length);
        /* 中文按 1em 宽，英文数字按 0.58em 估宽 */
        var wEst = 0;
        for (var i = 0; i < n; i++) {
          var c = text.charAt(i);
          wEst += (c.charCodeAt(0) > 255 ? size : size * 0.58);
        }
        var hEst = size * 1.15;
        var s = size;
        var pad = 2.2;                        // 最小视觉间隙
        var placed = null;
        /* 由大到小试三档字号 */
        var tries = [s, s * 0.84, s * 0.72];
        for (var ti = 0; ti < tries.length && !placed; ti++) {
          s = tries[ti];
          wEst = 0;
          for (var j = 0; j < n; j++) {
            var ch = text.charAt(j);
            wEst += (ch.charCodeAt(0) > 255 ? s : s * 0.58);
          }
          hEst = s * 1.15;
          /* 螺旋找位 */
          for (var ring = 0; ring <= 8 && !placed; ring++) {
            var steps = ring === 0 ? 1 : ring * 8;
            for (var q = 0; q < steps; q++) {
              var ang = (q / steps) * Math.PI * 2;
              var rad = ring * Math.max(6, s * 0.42);
              var px = x + Math.cos(ang) * rad;
              var py = y + Math.sin(ang) * rad;
              if (px - wEst / 2 < 0 || px + wEst / 2 > W ||
                  py - hEst / 2 < 0 || py + hEst / 2 > H) continue;
              var bb = [px - wEst / 2 - pad, py - hEst / 2 - pad,
                        px + wEst / 2 + pad, py + hEst / 2 + pad];
              if (!hitAny(bb, boxes)) { placed = { x: px, y: py, size: s, w: wEst }; boxes.push(bb); }
            }
          }
        }
        /* 都放不下 → 用原位（宁可轻微重叠，也不要缺地名） */
        if (!placed) {
          placed = { x: x, y: y, size: tries[2], w: wEst };
          boxes.push([x - wEst / 2, y - hEst / 2, x + wEst / 2, y + hEst / 2]);
        }
        return placed;
      },
      count: function () { return boxes.length; }
    };
    function hitAny(bb, arr) {
      for (var i = 0; i < arr.length; i++) {
        var o = arr[i];
        if (bb[0] < o[2] && bb[2] > o[0] && bb[1] < o[3] && bb[3] > o[1]) return true;
      }
      return false;
    }
  }

  /* 点是否落在行政区的**世界坐标环**内（含飞地）
     ⚠️ 2026-10-15 补：全国层省名的 keepIn 回调调用它判断
        "标签挪位后是否还在本省境内"（防止「北京」被推到「河北」境内）。
        重建文件时该函数丢失，导致 redraw() 抛
        "G.inRingsWorld is not a function" → 全国层直接不渲染。
     与 pointInRings 的区别：本函数只判**最大环或任一环**（行政区语义，
     飞地也属于本行政区），不做 even-odd 抵消。 */
  function inRingsWorld(px, py, rings) {
    if (!rings || !rings.length) return false;
    var insideAny = false;
    for (var i = 0; i < rings.length; i++) {
      var r = rings[i];
      if (!r || r.length < 3) continue;
      var ins = false;
      for (var j = 0, k = r.length - 1; j < r.length; k = j++) {
        var xi = r[j][0], yi = r[j][1], xk = r[k][0], yk = r[k][1];
        if (((yi > py) !== (yk > py)) &&
            (px < (xk - xi) * (py - yi) / (yk - yi + 1e-12) + xi)) ins = !ins;
      }
      if (ins) { insideAny = true; break; }
    }
    return insideAny;
  }

  /* 点是否落在行政区的**世界坐标环**内（含飞地）
     ⚠️ 2026-10-15 补：全国层省名的 keepIn 回调调用它判断
        "标签挪位后是否还在本省境内"（防止「北京」被推到「河北」境内）。
        重建文件时该函数丢失，导致 redraw() 抛
        "G.inRingsWorld is not a function" → 全国层直接不渲染。
     与 pointInRings 的区别：本函数只判**最大环或任一环**（行政区语义，
     飞地也属于本行政区），不做 even-odd 抵消。 */
  function inRingsWorld(px, py, rings) {
    if (!rings || !rings.length) return false;
    var insideAny = false;
    for (var i = 0; i < rings.length; i++) {
      var r = rings[i];
      if (!r || r.length < 3) continue;
      var ins = false;
      for (var j = 0, k = r.length - 1; j < r.length; k = j++) {
        var xi = r[j][0], yi = r[j][1], xk = r[k][0], yk = r[k][1];
        if (((yi > py) !== (yk > py)) &&
            (px < (xk - xi) * (py - yi) / (yk - yi + 1e-12) + xi)) ins = !ins;
      }
      if (ins) { insideAny = true; break; }
    }
    return insideAny;
  }


  /* ============================================================
     以下三个原型方法于 2026-10-15 从官网版移植回来
     ------------------------------------------------------------
     背景：重建 national-view.js 时误用了官网版底本，而当前版
     geo-engine 缺少这三个方法，导致运行期抛错、全国层直接白屏：
       DM.dedupLabels  —— 画完后终检，去掉仍然叠字的标签
       DM.fixLabelHome —— 把被引擎让位推出本行政区界的标签拉回来
                         （如「北京」被推到「河北」境内）
       DM.leader       —— 小面标签出框时画引线，连回本行政区中心
     三者与 _findFreeSpot（本次新写的包围盒避让）是**互补**关系：
       前者解决"画完才发现重叠/跑偏"的终检，
       _findFreeSpot 解决"画的时候就别叠"的预防。
     ============================================================ */
GeoCanvas.prototype.dedupLabels = function (layerName) {
    var L = this.layers[layerName];
    if (!L || !L.g) return { total: 0, removed: 0 };
    var host = this.host.getBoundingClientRect();
    var items = [];
    /* ⚠️ 扫描范围不能只限 L.g：栅格开启时，业务标签会被【克隆】一份到
       描边层（overlayLabels），好让名字压在栅格之上可见 ——
       于是同一个名字在两棵 <g> 里各有一份实体。
       全国视图的省名就属于这种情况，只扫 lab 层会漏掉描边层那一份，
       实测「北京」「天津」的重叠正是在描边层上（removed 始终为 0）。
       这里按 id/class 找出该容器内所有标注实体一起判重叠。*/
    var sel = 'text.gs-label, text.gs-overlay-label, text[class*="label"]';
    var nodes = [];
    if (L.g) nodes = nodes.concat(Array.prototype.slice.call(L.g.querySelectorAll(sel)));
    var host2 = this.host;
    if (host2 && host2.querySelectorAll) {
      var extra = Array.prototype.slice.call(host2.querySelectorAll(sel));
      for (var q = 0; q < extra.length; q++) {
        if (nodes.indexOf(extra[q]) < 0 &&
            extra[q].closest('svg') && extra[q].closest('svg') === this.svg.svg) nodes.push(extra[q]);
      }
    }
    for (var i = 0; i < nodes.length; i++) {
      var r = nodes[i].getBoundingClientRect();
      if (!(r.width > 1) || !(r.height > 1)) continue;
      items.push({ el: nodes[i], x: r.left, y: r.top, w: r.width, h: r.height });
    }
    /* 面积大的优先占位：小县名让位给带数值的长标签 */
    items.sort(function (a, b) { return b.w * b.h - a.w * a.h; });
    var keep = [], removed = 0;
    for (var j = 0; j < items.length; j++) {
      var o = items[j], bad = false;
      for (var k = 0; k < keep.length; k++) {
        var z = keep[k];
        if (o.x < z.x + z.w && o.x + o.w > z.x && o.y < z.y + z.h && o.y + o.h > z.y) {
          bad = true; break;
        }
      }
      if (bad) {
        try { o.el.remove(); } catch (e) { }
        removed++;
      } else keep.push(o);
    }
    if (L.pxItems) L.pxItems = L.pxItems.filter(function (t) { return t.parentNode; });
    return { total: keep.length, removed: removed };
  };
GeoCanvas.prototype.fixLabelHome = function (layerName, pairs, opt) {
    var L = this.layers[layerName];
    if (!L || !L.g || !pairs || !pairs.length) return { fixed: 0, checked: 0, skipped: 0 };
    var host = this.host.getBoundingClientRect();
    var fixed = 0, checked = 0, skipped = 0;
    /* 其他省标签的当前矩形 —— 修正落点必须避开它们。
       ⚠️ 不避让会连带出二次伤害：「河北」从北京的坑里被拉出来，
       若落点恰好压在「北京」标签上，后面的 dedupLabels 会把
       "面积更小"的河北当重叠者删掉 —— 屏幕上就是"河北"两个字
       彻底消失（实测）。
       ⚠️ 必须在循环【内】按当前元素构建：放到循环外访问 pairs[i]
          会抛 TypeError，被调用方的 try/catch 静默吞掉，
          表现为"终检完全没跑、界面毫无变化"，极难定位。 */
    var freeOfOthers = function (self, sx, sy, w, h) {
      for (var k = 0; k < pairs.length; k++) {
        var oe = pairs[k].el;
        if (!oe || oe === self || !oe.parentNode) continue;
        var orb = oe.getBoundingClientRect();
        if (!(orb.width > 1) || !(orb.height > 1)) continue;
        if (sx + w / 2 > orb.left - 2 && sx - w / 2 < orb.right + 2 &&
            sy + h / 2 > orb.top - 2 && sy - h / 2 < orb.bottom + 2) return false;
      }
      return true;
    };
    for (var i = 0; i < pairs.length; i++) {
      var pair = pairs[i];
      var t = pair.el, face = pair.face;
      if (!t || !face || !t.parentNode) continue;
      var tr = t.getBoundingClientRect();
      var fr = face.getBoundingClientRect();
      if (!(tr.width > 1) || !(fr.width > 1)) continue;
      checked++;
      var tw = tr.width + 4;
      /* 小面豁免：标签比面还宽，callout 是正解，拉回只会叠字 */
      if (fr.width < tw * 1.25) { skipped++; continue; }
      var fm = face.getScreenCTM();
      if (!fm) continue;
      var inv = fm.inverse();
      var cx = tr.left + tr.width / 2, cy = tr.top + tr.height / 2;
      /* ⚠️⚠️ 必须判定【anchor 落点】而不是当前属性位置。
         pxLabel 的引擎让位会把属性挪开，但 anchor 记录的是调用方给的
         世界坐标 —— 下一次 view 变化（resize/缩放/fit）时 _syncPx 会按
         anchor 把标签重投影回去。
         早先终检查的是"当前属性位置"：那一刻标签还没被重投影，
         判定为"在本省内"就跳过了；随后 _syncPx 生效，标签被挪到了
         anchor 指向的那个错位点（北京坑里），错位就此固化。
         这里改成：以 anchor 的世界坐标为准判定与修正，
         修正后同步写回 anchor，两者永远一致。*/
      var an = null, w0 = false;
      if (this.pxAnchors) {
        for (var q = 0; q < this.pxAnchors.length; q++) {
          if (this.pxAnchors[q].el === t) { an = this.pxAnchors[q]; w0 = true; break; }
        }
      }
      if (an && isFinite(an.wx) && isFinite(an.wy)) {
        var ap = this.toPx(an.wx, an.wy);
        if (isFinite(ap.x) && isFinite(ap.y)) {
          cx = host.left + ap.x;
          /* ⚠️ 文字的 y 属性是【基线】，视觉中心在基线上方。
             引擎的矩形定义 top = y - h*0.78、bottom = y + h*0.22，
             故视觉中心 = y - h*0.28。
             不做这个换算会差 5~6px —— 而内蒙古的新月形凹口、
             北京嵌在河北里的坑都只有几像素宽，5px 之差就是
             "在本省"与"在邻省"的分界（实测内蒙古、河北因此漏判）。*/
          cy = host.top + ap.y - tr.height * 0.28;
        }
      }
      var inside = (function (sx, sy) {
        var q2 = new DOMPoint(sx, sy).matrixTransform(inv);
        try { return face.isPointInFill ? face.isPointInFill(q2) : false; } catch (e) { return false; }
      });
      /* 判据必须是【整个标签矩形都在本省面内】，不能只看中心。
         ⚠️ 只判中心会漏掉"骑在边界上"的一类错位 —— 用户截图里
            「内蒙古」三个字正有一半压在国界外侧、视觉上像是印在
            蒙古国境内；「河北」则有一半压在北京的坑里。
            实测这两省的标签中心（anchor 视觉中心）判定为"在本省内"，
            终检直接跳过，实则整块字都有一截在境外。
         改成：矩形四角 + 中心共 5 个采样点全部在面内才算数。*/
      var hw2 = tr.width / 2, hh2 = tr.height / 2;
      var fullIn = inside(cx, cy)
        && inside(cx - hw2, cy - hh2) && inside(cx + hw2, cy - hh2)
        && inside(cx - hw2, cy + hh2) && inside(cx + hw2, cy + hh2);
      if (fullIn) continue;
      /* 拉回：以 anchor 落点为中心做【环形搜索】，找最近的面内点。
         ⚠️ 不能朝"面的 bbox 中心"直线推进 —— bbox 中心未必在面内：
           内蒙古是新月形，bbox 中心正落在凹口里、在境外，
           朝它推进永远进不去，标签就一直卡在省外。
         半径上限放到面 bbox 的对角线，保证"面内还有点"就一定能找到。*/
      var hitX = null, hitY = null;
      var maxR = Math.max(96, Math.min(240,
        Math.round(Math.hypot(fr.width, fr.height))));
      for (var rad = 4; rad <= maxR && hitX == null; rad += 3) {
        var seg = Math.max(12, Math.round(rad * 1.8));
        if (seg > 400) seg = 400;
        for (var s = 0; s < seg; s++) {
          var ang = s / seg * Math.PI * 2;
          var sx2 = cx + Math.cos(ang) * rad, sy2 = cy + Math.sin(ang) * rad;
          if (sx2 < fr.left || sx2 > fr.right || sy2 < fr.top || sy2 > fr.bottom) continue;
          if (!inside(sx2, sy2) ||
              !inside(sx2 - hw2, sy2 - hh2) || !inside(sx2 + hw2, sy2 - hh2) ||
              !inside(sx2 - hw2, sy2 + hh2) || !inside(sx2 + hw2, sy2 + hh2)) continue;
          if (!freeOfOthers(t, sx2, sy2, tr.width, tr.height)) continue;
          hitX = sx2; hitY = sy2; break;
        }
      }
      if (hitX == null) continue;
      /* 用【增量】平移，不做世界↔屏幕坐标换算。
         ⚠️ 踩坑：先前写成 newX = toPx(hitX - host.left)，一旦引擎的
            scale/tx/ty 此刻不可用就会得到 NaN，属性写成 "NaN" 后
            SVG 元素回落到原点 —— 「河北」直接飞到地图左上角 (344,56)。
         px 图层的坐标就是容器内屏幕坐标，所以"屏幕位移"直接等于"属性位移"。*/
      var dxs = hitX - cx, dys = hitY - cy;
      var nx = parseFloat(t.getAttribute('x')) + dxs;
      var ny = parseFloat(t.getAttribute('y')) + dys;
      if (!isFinite(nx) || !isFinite(ny)) continue;
      t.setAttribute('x', nx.toFixed(1));
      t.setAttribute('y', ny.toFixed(1));
      t._pxBox = { left: tr.left + dxs, right: tr.right + dxs,
                   top: tr.top + dys, bottom: tr.bottom + dys };
      /* anchor 与属性必须同步改：终检修的正是 anchor 落点，
         不写回的话下一次 _syncPx 又会把标签拽回那个错位点。*/
      if (w0) {
        var w = this.toWorld(hitX - host.left, hitY - host.top);
        /* isFinite 护栏：数组 [NaN,NaN] 也是 truthy，
           直接写进去会让下一次 _syncPx 把标签重投影到 NaN，
           SVG 属性失效 → 元素渲染在原点（屏幕左上角）。*/
        if (w && isFinite(w[0]) && isFinite(w[1])) {
          for (var q3 = 0; q3 < this.pxAnchors.length; q3++) {
            if (this.pxAnchors[q3].el === t) { this.pxAnchors[q3].wx = w[0]; this.pxAnchors[q3].wy = w[1]; }
          }
        }
      }
      fixed++;
    }
    return { fixed: fixed, checked: checked, skipped: skipped };
  };
  /* 引线（2026-10-15 移植）：小面标签出框时连回本行政区中心 */
GeoCanvas.prototype.pxLeader = function (layerName, x1, y1, x2, y2, style) {
    var L = this.layers[layerName]; if (!L) return null;
    /* 屏幕像素 → 世界坐标 */
    var wx1 = (x1 - this.tx) / this.scale, wy1 = (this.ty - y1) / this.scale;
    var wx2 = (x2 - this.tx) / this.scale, wy2 = (this.ty - y2) / this.scale;
    /* 引线专用子层：必须排在标签之前，否则会盖住所有标签。
       ⚠️ 踩坑：初版直接 appendChild / insertBefore 到图层最前，
       结果 5 条引线铺在最上层，elementsFromPoint 命中的全是 line.gs-leader，
       整幅地图被挡成白底（实测白色像素 98.4%，回退 geo-engine 才恢复 0.2%）。 */
    if (!L.leaders) {
      var lg = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      lg.setAttribute('class', 'gs-leaders');
      L.g.insertBefore(lg, L.g.firstChild);
      L.leaders = lg;
    }
    var ln = el('line', {
      x1: wx1.toFixed(1), y1: wy1.toFixed(1),
      x2: wx2.toFixed(1), y2: wy2.toFixed(1),
      stroke: (style && style.stroke) || 'rgba(255,255,255,.5)',
      'stroke-width': (style && style.sw) || 1,
      'stroke-linecap': 'round',
      'vector-effect': 'non-scaling-stroke',
      'pointer-events': 'none',
      class: 'gs-leader'
    });
    L.leaders.appendChild(ln);
    return ln;
  };

  /* 引线（2026-10-15 移植）：小面标签出框时连回本行政区中心 */
GeoCanvas.prototype.pxLeader = function (layerName, x1, y1, x2, y2, style) {
    var L = this.layers[layerName]; if (!L) return null;
    /* 屏幕像素 → 世界坐标 */
    var wx1 = (x1 - this.tx) / this.scale, wy1 = (this.ty - y1) / this.scale;
    var wx2 = (x2 - this.tx) / this.scale, wy2 = (this.ty - y2) / this.scale;
    /* 引线专用子层：必须排在标签之前，否则会盖住所有标签。
       ⚠️ 踩坑：初版直接 appendChild / insertBefore 到图层最前，
       结果 5 条引线铺在最上层，elementsFromPoint 命中的全是 line.gs-leader，
       整幅地图被挡成白底（实测白色像素 98.4%，回退 geo-engine 才恢复 0.2%）。 */
    if (!L.leaders) {
      var lg = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      lg.setAttribute('class', 'gs-leaders');
      L.g.insertBefore(lg, L.g.firstChild);
      L.leaders = lg;
    }
    var ln = el('line', {
      x1: wx1.toFixed(1), y1: wy1.toFixed(1),
      x2: wx2.toFixed(1), y2: wy2.toFixed(1),
      stroke: (style && style.stroke) || 'rgba(255,255,255,.5)',
      'stroke-width': (style && style.sw) || 1,
      'stroke-linecap': 'round',
      'vector-effect': 'non-scaling-stroke',
      'pointer-events': 'none',
      class: 'gs-leader'
    });
    L.leaders.appendChild(ln);
    return ln;
  };

  global.GeoCanvas = GeoCanvas;
  global.G = {
    mercY: mercY, lngToX: lngToX, xToLng: xToLng, yToLat: yToLat,
    mulberry32: mulberry32, pointInRings: pointInRings, inRingsWorld: inRingsWorld, inRingsWorld: inRingsWorld, ringsBBox: ringsBBox,
    polyCentroid: polyCentroid, polyArea: polyArea,
    labelAnchor: labelAnchor, LabelPlacer: LabelPlacer
  };
})(window);