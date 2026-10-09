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
      h.setPointerCapture(e.pointerId);
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
      if (!dragging) return;
      var dx = e.clientX - lx, dy = e.clientY - ly;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      // Y 轴翻转后，向下拖动屏幕 → 世界 Y 增大 → ty 减小
      self.tx += dx; self.ty += dy; lx = e.clientX; ly = e.clientY;
      self._apply();
    });

    function up(e) {
      delete pointers[e.pointerId];
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

    h.addEventListener('pointerleave', function (e) { delete pointers[e.pointerId]; });

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
    if (animate) setTimeout(function () { self_off(self); }, 420);
    function self_off(c) { c.stack.classList.remove('anim'); }
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
    // 当前视野 bbox（Y 轴已翻转：屏幕 y 越小 → 世界 Y 越大/越靠北）
    var b = [
      xToLng((0 - this.tx) / this.scale),            // 西
      yToLat((this.ty - this._vh) / this.scale),       // 南（屏幕底部）
      xToLng((this._vw - this.tx) / this.scale),       // 东
      yToLat(this.ty / this.scale)                     // 北（屏幕顶部）
    ];
    this.bbox = b;
    this._updateScaleBar();
    this.onView(this.view());
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

  GeoCanvas.prototype.view = function () {
    var b = this.bbox || [0, 0, 0, 0];
    // scale = 世界单位/像素(=米/px)，换算为常见 zoom 级别（256px 瓦片）
    var z = this.scale ? Math.log2(256 / this.scale) : 0;
    return {
      lng: +(((b[0] + b[2]) / 2)).toFixed(4),
      lat: +(((b[1] + b[3]) / 2)).toFixed(4),
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
  /* ⚠️ 必须【穿透式】拾取，不能只取最上层命中元素。
     原因：同一视图里会叠多层可拾取要素（省域底面 → 市域面 → 县面 → 乡镇面），
     后画的在上面。原实现用 closest('[data-pick]') 只取第一个命中，
     于是被上层的省域底面挡住时，下面的县面点不到 ——
     实测全国 106 个县面中 10 个点错（达坂城→乌鲁木齐县、
     玛纳斯县/奇台县/木垒县完全点不到、武昌区→洪山区…）。
     用户看到的现象就是「点不进乡镇」。
     现在改为：沿 document.elementsFromPoint 自上而下遍历，
     取第一个【kind 层级更细】的可拾取要素（即用户视觉上想点的那层），
     找不到再退回最上层命中。 */
  var PICK_ORDER = { vill: 0, town: 1, county: 2, city: 3, prov: 4 };
  GeoCanvas.prototype._pick = function (e) {
    var self = this;
    var stack = [];
    /* els 需在同层消歧时复用，故提到外层并保证始终有值 */
    var els = (document.elementsFromPoint)
      ? document.elementsFromPoint(e.clientX, e.clientY) : [];
    for (var i = 0; i < els.length; i++) {
      var t = els[i].closest ? els[i].closest('[data-pick]') : null;
      if (t && stack.indexOf(t) < 0) stack.push(t);   // 去重
    }
    if (!stack.length) {
      var tgt = e.target.closest ? e.target.closest('[data-pick]') : null;
      if (tgt) stack.push(tgt);
    }
    if (stack.length) {
      // 取层级最细的一个（vill > town > county > city > prov）
      var best = stack[0], bestRank = 99;
      for (var j = 0; j < stack.length; j++) {
        var rk = PICK_ORDER[stack[j].dataset.kind];
        if (rk != null && rk < bestRank) { bestRank = rk; best = stack[j]; }
      }
      /* 同层重叠消歧：CF 聚合的县面彼此可能重叠
         （实测阿勒泰市/布尔津县、昌吉市/呼图壁县、洛龙区/老城区、
           锦江区/武侯区 —— 源数据乡镇环共用边界所致）。
         此时命中兄弟县面而非本县，用户点 A 却进 B。

         规则不能只比面积：小县被大县完全覆盖时面积更小，但用户点击的
         位置若落在大县外缘的可见部分，就该进大县。
         正确判据是「谁在该点的最上层」——
         即在 elementsFromPoint 序列中，index 最小的那个就是视觉上在最上面的，
         同层重叠时它就是用户真正点到的那个。
         只有当它不在栈里时，才退回面积最小者。 */
      var sameRank = stack.filter(function (t) {
        return PICK_ORDER[t.dataset.kind] === bestRank && t !== best;
      });
      if (sameRank.length) {
        var cand = [best].concat(sameRank);
        // 在 elementsFromPoint 序列里最靠前的 = 绘制顺序上最上层
        var win = null;
        for (var q = 0; q < els.length; q++) {
          for (var w = 0; w < cand.length; w++) {
            if (els[q] === cand[w] || (els[q].closest && els[q].closest('[data-pick]') === cand[w])) {
              win = cand[w]; break;
            }
          }
          if (win) break;
        }
        if (!win) {
          var scored = cand.map(function (t) {
            var bb = t.getBBox ? t.getBBox() : null;
            return { t: t, a: bb ? bb.width * bb.height : Infinity };
          });
          scored.sort(function (x, y) { return x.a - y.a; });
          win = scored[0].t;
        }
        best = win;
      }
      var payload = {};
      if (best.dataset.id) payload.id = best.dataset.id;
      if (best.dataset.kind) payload.kind = best.dataset.kind;
      if (best.dataset.ti != null) payload.ti = Number(best.dataset.ti);
      if (best.dataset.vi != null) payload.vi = Number(best.dataset.vi);
      if (best.dataset.vk) payload.vk = best.dataset.vk;
      this.onPick(payload, best);
      return;
    }
    // 兜底：按世界坐标找要素
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

  /* 标签避让：同层内已注册的标签若与新标签重叠，则把新标签上移让位。
     ⚠️ 用户截图（大兴安岭/新疆）：县级名密集且贴近时互相压字、
        边缘地名溢出到地图外。→ 加简单的垂直避让 + 边界内收。 */
  GeoCanvas.prototype._avoidLabels = function (layerName, x, y, w, h) {
    var L = this.layers[layerName];
    if (!L || !L.pxItems) return y;
    var R = this.host.getBoundingClientRect();
    var hostX = this.host.getBoundingClientRect().left;
    var hostY = this.host.getBoundingClientRect().top;
    var fs = (arguments[5] || 11);
    var estW = w || fs * 4;                       // 无参时按字号估宽
    var estH = h || fs * 1.2;
    var tryY = y, guard = 0, hitOne = false;
    /* 判定必须用【矩形相交】，不能用「中心点是否落在对方横范围内」。
       旧逻辑：cx ∈ [b.left-3, b.right+3] 且 cy ∈ [b.top-3, b.bottom+3]
       —— 只能挡住「正上方/正下方」的标签，挡不住斜向相邻的。
       实测因此留下 5 处重叠：河北省∩北京市、河北省∩天津市、
       广东省∩香港、澳门∩香港、南海诸岛∩台湾。
       改判：本标签矩形 [x±estW/2, tryY±estH/2] 与已有标签矩形是否真相交。 */
    while (guard++ < 14) {
      hitOne = false;
      var myL = hostX + x - estW / 2, myR = hostX + x + estW / 2;
      var myT = hostY + tryY - estH / 2, myB = hostY + tryY + estH / 2;
      for (var i = 0; i < L.pxItems.length; i++) {
        var it = L.pxItems[i];
        if (!it._lx) continue;
        /* ★ 必须用【元素上缓存的最终位置】，不能用 getBoundingClientRect()。
           标签是刚 append 进 DOM 的，此刻 getBoundingClientRect() 常返回
           width=0（尚未完成排版），旧代码直接 `continue` 跳过 →
           避让等于没做。实测这正是河北∩北京、河北∩天津、
           广东∩香港、港澳台、南海诸岛∩台湾 5 处重叠的根因。
           改为读取 pxLabel 写入的 _pxBox（屏幕坐标矩形，绘制时即已确定）。 */
        var b = it._pxBox;
        if (!b) {
          var r0 = it.getBoundingClientRect();
          if (r0.width === 0) continue;
          b = { left: r0.left, right: r0.right, top: r0.top, bottom: r0.bottom };
        }
        var gap = 4;   // 标签间至少留 4px 呼吸
        var ix = Math.min(myR + gap, b.right + gap) - Math.max(myL - gap, b.left - gap);
        var iy = Math.min(myB + gap, b.bottom + gap) - Math.max(myT - gap, b.top - gap);
        if (ix > 0 && iy > 0) {
          /* 相交时优先往下让；下方空间不够（会顶出视口）则改为上让 */
          var down = b.bottom + gap + estH / 2;
          var up = b.top - gap - estH / 2;
          var candY = (down + hostY < R.bottom - 6) ? down : up;
          tryY = candY;
          hitOne = true;
          break;
        }
      }
      if (!hitOne) break;
    }
    // 边界内收：贴边时把标签往里推，避免溢出地图外
    var finalY = tryY;
    if (hostY + finalY < R.top + 12) finalY = R.top - hostY + 12;
    if (hostY + finalY > R.bottom - 10) finalY = R.bottom - hostY - 10;
    return finalY;
  };

  /* 标签底衬方案（第四次返工 · 定稿）
     ⚠️ 这个问题我连修三次都错，完整记录以免再走老路：
     1) 各视图传 haloW=3.4~5.5 固定值（占字号 34~40%）→ 糊成黑块；
     2) 改「8 方位光晕副本」→ 每标签 9 个 text、副本偏移 → 用户看到"重影"；
     3) 改回单 text + paint-order:stroke → 用户仍报"两个"；
     4) 用 elementsFromPoint 查标签中心点的元素堆叠才看清真因：
        **最上层是省域面的描边（stroke rgba(14,26,44,.88) / width 1.3）——
        省界线从文字下方穿过，再叠上文字自身的深色描边，
        两者共同构成"双层"错觉。不是文字重复。**

     定稿方案：文字【不用描边】，改为在下方垫一块半透明深色圆角底衬
     （地图标签通行做法）：
     - 底衬是纯色块、无描边 → 不会侵入字腔、不产生任何双线；
     - 压住穿过文字的省界线，文字区域始终干净；
     - 深浅底图上都成立（白字 + 深底衬）。
     style.plate === false 或 halo === 'none' 时不画底衬。 */
  GeoCanvas.prototype.pxLabel = function (layerName, x, y, text, style, meta) {
    var L = this.layers[layerName]; if (!L) return null;
    y = this._avoidLabels(layerName, x, y, 0, 0, style.size || 12);
    var fs = style.size || 12;
    var usePlate = (style.plate !== false && style.halo !== 'none');

    var t = el('text', {
      x: x, y: y, class: 'gs-label', fill: style.fill || '#e8f0fb',
      'font-size': fs, 'text-anchor': style.anchor || 'middle',
      'font-weight': style.weight || 700, 'font-family': 'inherit'
    });
    t.textContent = text;
    t._lx = 1;              // 标记：供 _avoidLabels 识别为标签
    /* 预先记录屏幕矩形，供后续标签做避让判定。
       必须在元素尚未入 DOM 时就算好 —— 入 DOM 后 getBoundingClientRect
       可能返回 0 宽，导致避让整体失效（见 _avoidLabels 注释）。 */
    var estW2 = fs * text.length * 0.62, estH2 = fs * 1.2;
    try { if (t.getComputedTextLength) estW2 = t.getComputedTextLength(); } catch (e0) { }
    var hb = this.host.getBoundingClientRect();
    var anc2 = style.anchor || 'middle';
    var bx0 = anc2 === 'start' ? x : (anc2 === 'end' ? x - estW2 : x - estW2 / 2);
    t._pxBox = { left: hb.left + bx0, right: hb.left + bx0 + estW2,
                 top: hb.top + y - estH2 * 0.78, bottom: hb.top + y + estH2 * 0.22 };
    if (meta) {
      t.setAttribute('data-pick', '1');
      if (meta.id) t.setAttribute('data-id', meta.id);
      if (meta.kind) t.setAttribute('data-kind', meta.kind);
      t.style.cursor = meta.kind ? 'pointer' : 'default';
    }

    if (usePlate) {
      /* 先把文字入 DOM 量出宽度，再回填底衬宽度 —— SVG 文字宽度只能实测 */
      L.g.appendChild(t);
      var tw = fs * text.length * 0.62;
      try { if (t.getComputedTextLength) tw = t.getComputedTextLength(); } catch (e2) { }
      /* 底衬参数必须克制到"几乎看不见"：
         初版 padX=0.32em / 不透明度 .66 / 圆角 0.26em → 11px 字号下是
         一块 12×15px 深色圆角方块，4 倍放大就是"字底压个黑框"；
         收到 0.10em / .34 仍偏重。用户诉求是【文字干净】，
         故再压：透明度 .26、内收 0.06em、圆角 0.08em ——
         只够压住穿过字身的省界线，不形成任何可见边框。 */
      var padX = fs * 0.06, padY = fs * 0.04;
      var plate = el('rect', {
        x: (x - tw / 2 - padX).toFixed(1),
        y: (y - fs * 0.80 - padY).toFixed(1),
        width: (tw + padX * 2).toFixed(1),
        height: (fs + padY * 2).toFixed(1),
        rx: (fs * 0.08).toFixed(1),
        class: 'gs-label-plate',
        fill: 'rgba(9,15,26,.26)'
      });
      /* 底衬插到文字之前（同层内 z 序靠前），文字压在底衬上 */
      L.g.insertBefore(plate, t);
      if (style.opacity != null) { plate.setAttribute('opacity', style.opacity); t.setAttribute('opacity', style.opacity); }
      L.pxItems = L.pxItems || []; L.pxItems.push(t);
      return t;
    }

    if (style.opacity != null) t.setAttribute('opacity', style.opacity);
    L.g.appendChild(t); L.pxItems = L.pxItems || []; L.pxItems.push(t);
    return t;
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
    /* ⚠️ 每个环必须【独立闭合】，不得跨环连线。
       CF（乡镇数据聚合的县面）是由该县下各乡镇的外环拼成的，这些环
       彼此并不首尾相接（有的相隔几公里）。若把它们首尾串成一条 path，
       环与环之间就会拉出横穿整幅图的长直线 —— 视觉上就是"尖刺乱线"
       （实测潍坊潍城 maxJump/span=0.68、坊子 0.55、奎文 0.45）。
       正确做法：每个环 Z 结束即断，SVG 会分别填充，互不干扰。
       之前尝试过"按空间邻接重排 + 最近邻串接"，相邻关系改善了，
       但非相邻环之间仍会产生长跳变（奎文 0.59），且多岛县会被串成
       一条畸形带状区，反而更像拉丝。故改为独立闭合。 */
    var rings = obj.r || [];
    for (var i = 0; i < rings.length; i++) {
      var r = rings[i];
      if (!r || r.length < 3) continue;
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
    if (meta) { p.setAttribute('data-pick', '1'); if (meta.id) p.setAttribute('data-id', meta.id); if (meta.kind) p.setAttribute('data-kind', meta.kind); }
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

  function polyArea(rings) {
    var s = 0;
    for (var i = 0; i < rings.length; i++) {
      var r = rings[i];
      for (var j = 0, k = r.length - 1; j < r.length; k = j++) s += r[k][0] * r[j][1] - r[j][0] * r[k][1];
    }
    return Math.abs(s / 2);
  }

  global.GeoCanvas = GeoCanvas;
  global.G = {
    mercY: mercY, lngToX: lngToX, xToLng: xToLng, yToLat: yToLat,
    mulberry32: mulberry32, pointInRings: pointInRings, ringsBBox: ringsBBox,
    polyCentroid: polyCentroid, polyArea: polyArea
  };
})(window);