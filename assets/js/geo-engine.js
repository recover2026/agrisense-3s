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
        /* ⚠️ 这里原先有一条"捷径"：pointerdown 时若 closest('[data-pick]')
           命中，就直接 onPick 并 return，不走 _pick。
           后果是【拾取规则被绕过】：
             · 同层重叠消歧（点 A 进 B 的纠正）不生效；
             · 极小面补偿（港澳 1x1、7x5）不生效；
             · 覆盖型消歧（海南/台湾被南海诸岛罩住）不生效；
             · 就近吸附与"点空隙"的兜底提示也拿不到 cx/cy。
           实测全国视图 35 个省真实鼠标点击只有 31 个能下钻，
           内蒙古/海南/台湾/N海诸岛 一点反应没有。
           现统一交给 _pick 处理（它内部已用 downTarget 的等价信息
           ——elementsFromPoint ——做了全部消歧），只在 downTarget 缺失时
           才回退到旧逻辑。*/
        if (!downTarget && e.target) downTarget = e.target;
        self._pick(e, downTarget);
        downTarget = null;
        dragging = false;
        return;
      }
      downTarget = null;
      dragging = false;
    }
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', function (e) { delete pointers[e.pointerId]; dragging = false; pinchD = 0; });

    /* ⚠️ pointerleave 不能删 pointers —— 它在【正常拖动中】就会大量触发
       （实测一次拖动收到 4 次 pointerleave，原因是浏览器把指针捕获期间的
       移动也派发 leave 给原元素）。
       后果链条：leave 删掉 pointers[id] → 下一次 pointermove 里
       `pointers[e.pointerId]` 为空、ids.length 变 1 → if (ids.length===2 && pinchD)
       不成立但 dragging 仍为 true，看似还能拖；然而真正致命的是
       某些机型/浏览器上 leave 后不再补 pointermove，拖动中途"卡住"，
       松手时 moved 判定失效 → 被当成点击 → 触发下钻 → renderProvince
       重新 fit() → 视图瞬间弹回原位。
       实测症状完全吻合：tx 一路走到 -510，松手后被重置回 -666。
       正确做法：leave 只在【没有按键】时清理（鼠标已离开窗口），
       按住拖动过程中一律保留。 */
    h.addEventListener('pointerleave', function (e) {
      // 只有"按住拖出窗口"才清理；正常拖动中的 leave 一律忽略
      if (e.buttons === 0) { delete pointers[e.pointerId]; dragging = false; }
    });

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
    /*⚠️ 这里原来写的是 `self_off(self)`，但 fit() 体内【从来没有声明 self】
       —— `self` 是 undefined，420ms 后 self_off(undefined) 抛
       "Cannot read properties of undefined (reading 'classList')"。
       影响面极大：fit(bbox, true) 是【带动画复位/下钻定位】的唯一入口，
       也就是说所有"打开详情后自动定位到该区县"的动作都会在 420ms 后报错，
       动画收尾 class 也去不掉（下次 anim 会失效、地图看起来"卡一下"）。
       实测：理赔定损 14 个可点项里 8 个触发此错，其余视图点「返回上级」
       与新加的影像开关也命中（它们都走 fit）。
       正确写法：用已存在的 this，或直接箭头函数捕获。*/
    var self = this;
    if (animate) setTimeout(function () { self_off(self); }, 420);
    function self_off(c) {
      if (c && c.stack) c.stack.classList.remove('anim');
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
 
    /* 遥感专题层跟随视图变换（平移即时对齐）。
       见 raster-engine 的 R.onViewChange —— 拖动后专题色块
       曾整块溢出省界（用户截图实况）。*/
    if (typeof RasterEngine !== 'undefined' && RasterEngine.onViewChange) {
      try { RasterEngine.onViewChange(this); } catch (e) { }
    }
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
        /* ⚠️ 通用护栏：坐标非有限时【保留原属性不动】。
           SVG 属性一旦写成 "NaN" 就整体失效，元素会渲染在 (0,0)，
           屏幕上表现为标签凭空飞到地图左上角（实测「河北」→ 344,56）。
           与其让一个元素坏掉，不如这一帧不动它 —— 下一次 view 变化
           若拿到合法坐标，自然就归位了。*/
        if (!isFinite(a.wx) || !isFinite(a.wy)) continue;
        var s = this.toPx(a.wx, a.wy);
        if (!isFinite(s.x) || !isFinite(s.y)) continue;
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

  /* toPx 的逆变换：屏幕(容器内)像素 → 世界坐标，返回 [x, y]。
     ⚠️ 与 toPx 不同这里返回【数组】不是对象 —— 调用方按 w[0]/w[1] 取值。
        （曾误照抄 toPx 返回 {x,y}，调用处却用下标访问，判定结果全是 NaN，
          内蒙古的标签因而被判定"永远出界"，反被踢到框外 39px。）
     标签归属约束需要在让位过程中把像素点反算回世界坐标，
     才能用射线法判断"这个新位置还在不在本行政区面内"。*/
  GeoCanvas.prototype.toWorld = function (px, py) {
    var s = this.scale;
    if (!s) return null;
    return [(px - this.tx) / s, (this.ty - py) / s];
  };

  /* 登记一个需要随视图重投影的 px 标记
     optional=true 时，容器宽度不足 minW 自动隐藏（防窄屏标注堆叠） */
  GeoCanvas.prototype.anchor = function (el, wx, wy, dy, siblings, optional, minW) {
    this.pxAnchors = this.pxAnchors || [];
    /* ⚠️ 同一元素重复注册会互相打架：_syncPx 逐条写属性，
       后一条会把前一条覆盖，于是"修正过的锚点"被旧的重新拽回去
       （实测「内蒙古」「河北」两个标签被归属终检修好，
        下一帧 _syncPx 又按重复记录弹回原错位）。
       这里保证每个元素在表里只有一条，后注册覆盖先注册。*/
    for (var i = this.pxAnchors.length - 1; i >= 0; i--) {
      if (this.pxAnchors[i].el === el) this.pxAnchors.splice(i, 1);
    }
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
      .filter(function (n) { return n !== 'lab'; })
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
  /* downEl：pointerdown 时命中的元素。
     setPointerCapture 之后 pointerup 的 e.target 会变成 host DIV，
     所以必须靠它把"按下时命中的面"补进候选栈。*/
  GeoCanvas.prototype._pick = function (e, downEl) {
    var self = this;
    var stack = [];
    /* els 需在同层消歧时复用，故提到外层并保证始终有值 */
    var els = (document.elementsFromPoint)
      ? document.elementsFromPoint(e.clientX, e.clientY) : [];
    for (var i = 0; i < els.length; i++) {
      var t = els[i].closest ? els[i].closest('[data-pick]') : null;
      if (t && stack.indexOf(t) < 0) stack.push(t);   // 去重
    }
    /* 按下时命中的面优先补入（指针捕获会改写 target，这里是唯一可靠来源） */
    var downHit = downEl && downEl.closest ? downEl.closest('[data-pick]') : null;
    if (downHit && stack.indexOf(downHit) < 0) stack.unshift(downHit);
    if (!stack.length) {
      var tgt = e.target.closest ? e.target.closest('[data-pick]') : null;
      if (tgt) stack.push(tgt);
    }
    if (stack.length) {
      /* ---------- 极小面补偿：先给点不准的面补一个命中机会 ----------
         全国视图缩得很大时，澳门只有 1x1 像素、香港 7x5 像素 ——
         鼠标不可能点中，用户只能干瞪眼。
         这里把【屏幕面积不足 12x12 像素】的同级可拾取面，
         按 12px 的命中半径补进候选栈，让它们在容差范围内也能被点中。
         只在同一拾取层级内补，不会把细层要素抢走。*/
      var tinyStack = [];
      var sels = document.querySelectorAll('[data-pick]');
      for (var ti = 0; ti < sels.length; ti++) {
        var el = sels[ti];
        if (stack.indexOf(el) >= 0) continue;
        if (el.getAttribute('data-tiny-pick') === '1') continue;
        var br = el.getBoundingClientRect();
        if (br.width > 13 && br.height > 13) continue;
        if (e.clientX < br.left - 9 || e.clientX > br.right + 9) continue;
        if (e.clientY < br.top - 9 || e.clientY > br.bottom + 9) continue;
        /* 只补【与已命中项同级】的极小面，避免细层要素被省级小面抢走 */
        var tinyRank = PICK_ORDER[el.dataset.kind];
        var topRank = 99;
        for (var tq = 0; tq < stack.length; tq++) {
          var rq = PICK_ORDER[stack[tq].dataset.kind];
          if (rq != null && rq < topRank) topRank = rq;
        }
        if (tinyRank !== topRank) continue;
        /* 已在容差范围内 → 加入候选；标记后本次不再重复加入 */
        el.setAttribute('data-tiny-pick', '1');
        tinyStack.push(el);
        (function (x) {
          setTimeout(function () { x.removeAttribute('data-tiny-pick'); }, 800);
        })(el);
      }
      for (var ts = 0; ts < tinyStack.length; ts++) {
        if (stack.indexOf(tinyStack[ts]) < 0) stack.push(tinyStack[ts]);
      }
      // 取层级最细的一个（vill > town > county > city > prov）
      /* ⚠️ 关键：stack 里可能混有【没有 data-kind】的元素
         —— 四个业务视图（总览/承保/理赔/预警）的县面、地块面都是
         `map.area('cover', cty, {...})` 画的，没设 data-kind，
         但带 data-pick 与 data-id，靠 onPick 里的 p.id 分派。
         原写法 `var best = stack[0], bestRank = 99;` 遇到它们时
         所有 rank 都是 undefined、`rk < bestRank` 恒不成立，
         best 就永久停在 stack[0] —— 常常正是那个"无 kind 的底框"，
         于是 payload 里没有 kind，上层 `p.kind === 'parcel'` 全部失配：
         实测承保/理赔/预警三个视图点地块"完全没反应"。
         正解：只在【有 kind 的候选】里比 rank；
         若一个都没有，则按绘制顺序取最上层（stack[0]），
         保留它的 data-id，让上层按 id 分派。*/
      var best = null, bestRank = 99;
      for (var j = 0; j < stack.length; j++) {
        var rk = PICK_ORDER[stack[j].dataset.kind];
        if (rk != null && rk < bestRank) { bestRank = rk; best = stack[j]; }
      }
      if (!best) {
        /* 无任何带 kind 的候选 → 取最上层的可拾取元素 */
        for (var k2 = 0; k2 < stack.length; k2++) {
          if (stack[k2].dataset.id || stack[k2].dataset.kind) { best = stack[k2]; break; }
        }
        if (!best) best = stack[0];
      }
      /* ---------- 无 kind 的底框要让位 ----------
         四个业务视图的县界/省界底框（map.area('cover', cty, ...)）带 data-pick
         与 data-id、但没有 data-kind；地块/图斑/预警圈则是带 kind 的细层要素，
         且视觉上就画在底框上面。
         ⚠️ 坑点：底框一旦进入 elementsFromPoint 栈首，下面的 parcel 就再也进不来
            （elementsFromPoint 只返回命中该点、且未被遮挡的元素 ——
            而"被遮挡"是浏览器按绘制顺序算的，底框虽然先画，
            SVG 的命中测试却会返回最上面那个……但只要底框的 path 是
            覆盖大片区域的封闭图形，parcel 完全落在它内部时，
            浏览器认为底框"在最上"（后画的在上面，而底框常常画在最后
            覆盖到 cover 层）→ stack 里就只有底框，parcel 根本没进候选。
         正解：不依赖 elementsFromPoint 的遮挡结果，直接按几何判定 ——
         在本容器内遍历所有带 data-kind 的可拾取元素，
         用 isPointInFill 检查点击点是否落在其实心区域内，取层级最细的一个。
         这样无论绘制顺序如何，用户点在地块/图斑/预警圈上都能命中它。*/
      var host = this.host;
      var withKind = host.querySelectorAll('[data-pick][data-kind]');
      if (withKind.length) {
        var geoBest = null, geoRank = 99;
        /* ⚠️ isPointInFill 的入参必须是 DOMPointInit 对象，
           传两个数字会抛 TypeError（实测）。
           这里统一用 DOMPoint 构造，并再包一层 try —— 老浏览器
           不支持时退回"按屏幕矩形粗判"（对同一视图内层要素足够）。*/
        var probe = null;
        try { probe = new DOMPoint(e.clientX, e.clientY); } catch (e0) { probe = null; }
        for (var g1 = 0; g1 < withKind.length; g1++) {
          var ge = withKind[g1];
          var gr = PICK_ORDER[ge.dataset.kind];
          if (gr == null || gr >= geoRank) continue;      // 只关心更细的层级
          var inside = true;
          if (ge.isPointInFill && probe) {
            try { inside = ge.isPointInFill(probe); } catch (e2) {
              var gb = ge.getBoundingClientRect();
              inside = e.clientX >= gb.left && e.clientX <= gb.right &&
                       e.clientY >= gb.top && e.clientY <= gb.bottom;
            }
          }
          if (!inside) continue;
          geoBest = ge; geoRank = gr;
        }
        if (geoBest) { best = geoBest; bestRank = geoRank; }
      } else if (best && best.dataset.kind == null) {
        for (var k3 = 0; k3 < stack.length; k3++) {
          if (stack[k3].dataset.kind != null) { best = stack[k3]; bestRank = PICK_ORDER[best.dataset.kind]; break; }
        }
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
      /* ---------- 同层"盖住型"重叠的二次消歧 ----------
         上面解决的是「点 A 却命中 B」这种绘制顺序错位（两个面都露在外面）。
         这里解决的是另一种，实测在全国视图下造成 4/35 的省点不动：
           · 南海诸岛是 181x273 的示意大面，把海南(115x208)、台湾(64x55)
             整个罩在里面 —— 用户看到的是"海南省"，点下去命中的是南海诸岛；
           · 澳门(1x1)、香港(7x5) 面积过小，几乎点不到。
         特征：被选中的面 screen 面积远大于同层其他面，且点击位置并不在它
         自己的 path 内部（说明点在它"填不满"的位置，实际想点的是被它
         盖住的小省）。
         判据：① 同层存在更小的候选；② 点击点不在 best 的 path 实心区域内
              （用 isPointInFill 判断）；③ best 的屏幕面积是次大者的 3 倍以上。
         满足则改判为「被盖住的那一个」——也就是用户视觉上想点的目标。*/
      if (sameRank.length) {
        var areaOf = function (t) {
          var b = t.getBoundingClientRect();
          return b.width * b.height;
        };
        /* isPointInFill 需要 DOMPointInit 对象，传两个数字会抛 TypeError。
           传不出对象时退回"恒真"，等价于不做覆盖型改判（保守，不会点错）。*/
        var solid = true;
        try {
          solid = (best.isPointInFill && e.target && e.target.ownerSVGElement)
            ? best.isPointInFill(new DOMPoint(e.clientX, e.clientY))
            : true;
        } catch (err) { solid = true; }
        var aBest = areaOf(best);
        var sorted = cand.slice().sort(function (x, y) { return areaOf(x) - areaOf(y); });
        var aSmall = areaOf(sorted[0]);
        /* 覆盖型：点不在大面实心区，且大面远大于同层最小面 → 改判为被盖住的小面 */
        if (!solid && aBest > aSmall * 3 && aSmall > 0) {
          best = sorted[0];
        } else if (aBest > 400) {
          /* 点确实落在大面内部（大面没被"穿透"）：此时若同层存在
             紧贴点击点的极小面（香港 7x5、澳门 1x1 这类肉眼几乎点不到的），
             且它的中心离点击点更近，按"就近优先"判给它 ——
             否则用户永远进不去这两个地方。*/
          var near = null, nd = 1e9;
          for (var nI = 0; nI < cand.length; nI++) {
            var c2 = cand[nI];
            if (c2 === best) continue;
            if (areaOf(c2) > 400) continue;
            var cb = c2.getBoundingClientRect();
            var d2 = Math.hypot((cb.x + cb.width / 2) - e.clientX, (cb.y + cb.height / 2) - e.clientY);
            if (d2 < nd) { nd = d2; near = c2; }
          }
          if (near && nd < 18) best = near;
        }
      }
      var payload = {};
      if (best.dataset.id) payload.id = best.dataset.id;
      if (best.dataset.kind) payload.kind = best.dataset.kind;
      if (best.dataset.ti != null) payload.ti = Number(best.dataset.ti);
      if (best.dataset.vi != null) payload.vi = Number(best.dataset.vi);
      if (best.dataset.vk) payload.vk = best.dataset.vk;
      /* 一并带上点击屏幕坐标：命中了面但下钻失败时，上层可据此就近吸附 */
      payload.cx = e.clientX;
      payload.cy = e.clientY;
      this.onPick(payload, best);
      return;
    }
    /* 兜底：点到要素之间的空隙，或 pointerdown 命中了背景矩形。
       ⚠️ 原来这里判 `if (this._hitTest)` —— 而 _hitTest 从未被赋值，
          整个分支是死代码，点击被静默丢弃：
          用户点内蒙古/海南/台湾（凹形，bbox 中心是空白）毫无反应，
          全国 35 个省实测只有 31 个能点得动。
       现在无条件把点击交出去（含屏幕坐标 cx/cy），
       由上层 nearestPick 做"就近吸附"、pickNoop 给明确提示。*/
    var r = this.host.getBoundingClientRect();
    var px = e.clientX - r.left, py = e.clientY - r.top;
    var out = {};
    if (this._hitTest) {
      var hit = this._hitTest((px - this.tx) / this.scale, (this.ty - py) / this.scale);
      if (hit) {
        if (hit.id) out.id = hit.id;
        if (hit.kind) out.kind = hit.kind;
        if (hit.ti != null) out.ti = hit.ti;
        if (hit.vi != null) out.vi = hit.vi;
        if (hit.vk) out.vk = hit.vk;
      }
    }
    out.cx = e.clientX;
    out.cy = e.clientY;
    this.onPick(out, null);
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

  /* 引线（callout leader）：标签位置 → 要素质心，画一条细白线。
     用于地理紧邻、质心几乎重合而无法直接分开标注的区域
     （实测北京↔河北质心距 10px、香港↔澳门仅 8px）。
     坐标直接存【世界坐标】，随图层变换自动缩放，屏幕上线宽恒定。 */
  /* 标注归属终检：把"跑到别省脚下"的地名拉回本行政区。
     ⚠️ 为什么必须在绘制之后做，而不是只靠 labelAnchor + 引擎让位：
        绘制链路上有三处会把标签推出本省 ——
          ① pxLabel 的横向让位 _avoidLabels（它只管不重叠，不知道归属）；
          ② 调用方第二轮"往四周找空位"（四周往往是邻省）；
          ③ 引线标注路径（允许出框，对直辖市是对的，对大省是错的）。
        前面两条已加 keepIn 约束，但 draw 之后视图还会 fit/resize，
        标签最终落点只能事后量。

     判据用浏览器原生 isPointInFill —— 它接受【SVG 用户坐标】，
     必须先用 getScreenCTM().inverse() 把屏幕点换算过去
     （直接传 clientX/Y 恒为 false，是本项目踩过的坑）。

     豁免规则：面在屏幕上的像素宽 < 标签宽 × 1.25 的不处理 ——
     那是直辖市/特别行政区（实测北京面 26px、「北京」二字 22px），
     标签物理上塞不进面内，本就该用引线出框（callout），
     强行拉回只会叠字。*/
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
    /* 记下调用方给的原始 x，供末尾做位移封顶判定 */
    this._avoidInX = x;
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
          /* 相交时的让位顺序（实测单一策略不够用）：
             ① 先试【横向让】——上下都是密集区时，纵向让位会不断往下堆，
                最终顶出视口或仍与别的标签交叠
                （实测「克拉玛依市 × 塔城地区」正是同高相邻、纵向怎么让都躲不开）；
             ② 横向找不到位再退回纵向（下优先、下顶出视口则上）。
             横向候选按「离原位由近到远」逐档试探。*/
          var moved = false;
          for (var hs = 1; hs <= 5 && !moved; hs++) {
            var dxs = [hs * (estW / 2 + 6), -hs * (estW / 2 + 6)];
            for (var di = 0; di < 2 && !moved; di++) {
              var cX = x + dxs[di];
              if (hostX + cX - estW / 2 < R.left + 6) continue;
              if (hostX + cX + estW / 2 > R.right - 6) continue;
              var nL = hostX + cX - estW / 2, nR = hostX + cX + estW / 2;
              var stillHit = false;
              for (var j = 0; j < L.pxItems.length; j++) {
                var jt = L.pxItems[j];
                if (!jt._lx || !jt._pxBox) continue;
                var bb2 = jt._pxBox;
                var g2 = 4;
                if (Math.min(nR + g2, bb2.right + g2) - Math.max(nL - g2, bb2.left - g2) > 0 &&
                    Math.min(myB + g2, bb2.bottom + g2) - Math.max(myT - g2, bb2.top - g2) > 0) {
                  stillHit = true; break;
                }
              }
              if (!stillHit) { x = cX; moved = true; }
            }
          }
          if (moved) { hitOne = true; break; }
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
    /* 边界内收：贴边时把标签往里推，避免溢出地图外 */
    var finalY = tryY;
    if (hostY + finalY < R.top + 12) finalY = R.top - hostY + 12;
    if (hostY + finalY > R.bottom - 10) finalY = R.bottom - hostY - 10;
    /* 横向让位的结果要传出去（x 是形参、调用方拿不到）。
       ⚠️ 位移封顶的语义要分清：超限【拉回原位】是错的——
          引擎让开是有理由的（原来那里会叠字），拉回去就等于没让。
          实测新疆省级因此出现 23 对重叠（「克孜勒苏柯尔克孜自治州」压
          「图木舒克市」42×14px）。
          正确做法：超限时把该标签**撤掉**（返回 null），
          由调用方决定用引线标注补回，或干脆不显示。
          —— 少一个名字，好过两个名字叠在一起。*/
    /* 横向位移封顶：按【标签自身宽度】的倍数算，而不是固定像素。
       ⚠️ 为什么不"超限就丢标签"（返回 null）：实测丢得很惨 ——
         新疆省级 24 个市只剩 12 个、河南 18 个市只剩 7 个，
         全国也有 32 → 少量缺失。原因是引擎的让位本来就是"就近挪一点"，
         密集区里标签互相挤，横向挪 1.2 倍宽已足够让开，超限的少数几个
         再交给调用方的第二轮贴边+引线即可，不需要在这里直接丢。
       所以这里：超限只提示（dropped=true 供调用方参考），
       但仍返回让位后的坐标 —— 视觉上略偏，但不丢名字。
       「南海诸岛」那种几百像素的乱飞已由 HIDE_LABELS 从源头排除。*/
    var maxShift = this.maxLabelShift || (estW * 1.2 + 24);
    this._avoidOut = { x: x, y: finalY,
      dropped: Math.abs(x - this._avoidInX) > maxShift };
    return finalY;
  };

  /* ---------- 标注终检去重（全站共用）----------
     为什么需要：pxLabel 的 _avoidLabels 是"逐个画、边画边让"，
     只能保证"新画的让开已画的"。但让位有距离上限、也受视口边界约束，
     密集区里仍有少量标签最终落在同一处 ——
     实测河北「117/1」与天津「11/1」实体重叠 31x10px、
     黄冈市的红色与橙色预警标签重叠 71x11px、北京与天津擦边 9x2px。
     任何基于"请求坐标"的事前判据都拦不住（引擎让位结果事先不可知），
     唯一可靠的判据是画完之后量真实矩形。
     这里用引擎已算好的 _pxBox（不依赖布局时机，getBoundingClientRect
     在刚入 DOM 时会返回 0）做一次全局扫描，保留面积大的、
     移除与已保留者相交的那些 —— 宁可少一个名字，也不两个叠在一起。*/
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
  /* ---------- 标签屏蔽名单（用户要求不显示的文字）----------
     需求（2026-10-09）：香港、澳门、厦门、济源（计划单列市）、苏州
     这些面积极小或紧邻他区，名称压在图上既看不清又挤占空间，
     但必须仍能点进去 —— 所以只【不画文字】，面本身照旧可拾取下钻。
     入口改由地图右上角的「点选」按钮提供（见 nat-jump）。

     实现放在引擎层而不是各视图调用点：pxLabel 有 13 处调用，
     逐处判断必然漏改，且以后新增视图又会踩同一个坑。
     用精确匹配 + 「名称含关键字」两级：
       精确——「香港」只匹配「香港」，不会误伤「香港中路」之类；
       关键字——用于简称形态（如「香港特别行政区」与「香港」）。
     名单可运行时增删，便于用户后续自己调整。 */
  /* 屏蔽名单：这些名称在任何层级都不绘制文字。
   ⚠️ 加入「南海诸岛」的缘由：它是全国视图里最小的面（面积极小、
      质心远在南海），标注避让时被引擎一路横向推到华北 ——
      实测屏幕上「北京」「天津」中间压着一个"洋"字，
      用户完全不知所云。
      极小面 + 避让无解 = 不标。右上角「点选」入口仍可进入，
      不影响功能可达性。*/
var HIDE_LABELS = ['香港', '澳门', '厦门', '济源', '苏州', '南海诸岛'];
  GeoCanvas.hiddenLabels = function () { return HIDE_LABELS.slice(); };
  GeoCanvas.setHiddenLabels = function (arr) {
    HIDE_LABELS = (arr || []).map(function (s) { return String(s).trim(); })
      .filter(function (s) { return !!s; });
  };
  function labelHidden(text) {
    if (!text) return false;
    var t = String(text);
    for (var i = 0; i < HIDE_LABELS.length; i++) {
      var h = HIDE_LABELS[i];
      if (!h) continue;
      if (t === h) return true;          // 精确
      if (t.indexOf(h) >= 0) return true; // 「香港特别行政区」含「香港」
    }
    return false;
  }

  /* 标签样式（第五版 · 定稿：描边，不用底衬）
     ⚠️ 这个函数返工四次，完整教训链必须留着：
     1) 各视图传 haloW=3.4~5.5 固定值（占字号 34~40%）→ 糊成黑块；
     2) 改「8 方位光晕副本」→ 每标签 9 个 text、副本偏移 → 用户看到"重影"；
     3) 改回单 text + paint-order:stroke（0.12×字号）→ 用户仍报"文字有两个"；
     4) 改「半透明深色底衬 rect」→ 参数压到 0.26 不透明度仍然失败：
        用户报的"文字下方很多黑影"就是它。
        底衬是【一块独立矩形】，无论透明度多低都会在彩色面（黄/绿/褐的省域）
        上显出可见的脏色方块 —— 这是原理性缺陷，不是参数问题。
        对照实验（11px 与 16px 字、黄褐底、paint-order=stroke）：
          描边 1.8~4.5 各档 → 字腔干净、无任何方块；
          半透明底衬 .26     → 明显的脏灰色矩形。
     5) 定稿：**去掉底衬，改用 paint-order:stroke 描边**。
        描边画在字形外沿（不侵入字腔），任何底色上都清晰，
        且不会在地图上留下矩形痕迹。

     描边宽度：字号 × 0.28，上限 4.6px。
       小字号（10~11px）取 2.0~3.1px —— 对照实验里 11px 字配 2.2~3.2px
       依然字腔清晰（此前"小字号描边必糊"的结论是错的，
       起因是在半透明黑上做实验、与现在的实色深棕不同）。
       大字号（16px）取 4.5px。stroke-linejoin:round 避免拐角出尖刺。 */
  /* 文字宽度测量：离屏 <text> 量，纯 CSS 像素、无任何变换。
     ⚠️ 不可直接对图层内的标签调 getComputedTextLength()：
        px 图层为抵消地图变换被施加了 scale(≈8408)，与栈上scale(≈1.19e-4)
        叠加抵消，这个双重缩放会让量出的宽度失真。
     ⚠️ 也曾因为只量宽度、不入 DOM 就填底衬，导致底衬撑不住文字 ——
        现底衬已去掉，本函数只用于标签避让的矩形估算，允许少量误差。 */
  var MEASURE_SVG = null;
  function measureText(text, fs, weight) {
    try {
      if (!MEASURE_SVG) {
        MEASURE_SVG = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        MEASURE_SVG.setAttribute('width', '10');
        MEASURE_SVG.setAttribute('height', '10');
        MEASURE_SVG.style.cssText = 'position:absolute;left:-9999px;top:-9999px;' +
          'width:10px;height:10px;overflow:visible;pointer-events:none';
        var mt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        mt.setAttribute('id', '__gs_mt');
        MEASURE_SVG.appendChild(mt);
        document.body.appendChild(MEASURE_SVG);
      }
      var t = MEASURE_SVG.querySelector('#__gs_mt');
      t.setAttribute('font-size', fs);
      t.setAttribute('font-weight', weight || 700);
      t.setAttribute('font-family', 'inherit');
      t.textContent = text;
      var w = t.getComputedTextLength();
      /* 兜底：CJK 按 1.0em/字，西文按 0.55em/字符 估算 */
      return (w > 0 ? w : (String(text).match(/[\u4e00-\u9fa5]/g) || []).length * fs
        + (String(text).length - (String(text).match(/[\u4e00-\u9fa5]/g) || []).length) * fs * 0.55);
    } catch (e) {
      return String(text).length * fs * 0.8;
    }
  }

  /* 螺旋搜索：找离 (px,py) 最近、且满足 keepIn 的点。
     用于「标签必须留在自己行政区内」这一硬约束 —— 让位可以挪，
     但绝不能挪出本行政区，否则用户看到的就是「内蒙古」三个字
     印在黑龙江/吉林脚下，完全对不上号。*/
  function searchNear(px, py, keepIn, maxR, step) {
    if (keepIn(px, py)) return [px, py];
    maxR = maxR || 40; step = step || 4;
    for (var r = step; r <= maxR; r += step) {
      var n = Math.max(8, Math.round(r * 1.6));
      for (var i = 0; i < n; i++) {
        var a = i / n * Math.PI * 2;
        var x = px + Math.cos(a) * r, y = py + Math.sin(a) * r;
        if (keepIn(x, y)) return [x, y];
      }
    }
    return null;
  }

  GeoCanvas.prototype.pxLabel = function (layerName, x, y, text, style, meta) {
    var L = this.layers[layerName]; if (!L) return null;
    if (labelHidden(text)) return null;   // 命中屏蔽名单：不画任何文字
    var fs = style.size || 12;
    /* ⚠️ noAvoid：调用方自己做避让时必须置位，否则会被这里的
       _avoidLabels 再挪一次。
       全国视图的省名就是这样踩的坑：调用方已经把标签放在【面边缘 + 引线】
       的正确位置上，_avoidLabels 只管"不重叠"、不知道标签属于哪个省，
       又把它挪到几百像素外的空旷处 ——
       实测「北京」被挪到河北省境内、「天津」被直接挤掉。
       style.noAvoid = true 时跳过自动避让，完全尊重调用方给的坐标。*/
    var realW = measureText(text, fs, style.weight || 700);
    if (!style.noAvoid) {
      var ox = x, oy = y;
      y = this._avoidLabels(layerName, x, y, realW, fs * 1.2, fs);
      /* _avoidLabels 可能把标签横向让位（x 会变），取回调整后的坐标。
         ⚠️ 这里不再因"位移超限"丢弃标签 ——
            实测丢得很惨（新疆 24 市只剩 12、河南 18 市只剩 7）。
            密集区里标签互相挤是常态，就近让开即可。*/
      if (this._avoidOut) { x = this._avoidOut.x; y = this._avoidOut.y; }
      /* ⚠️⚠️ 归属约束：_avoidLabels 只管"不重叠"、【完全不知道标签属于哪个行政区】，
         横向让位没有边界约束。实测内蒙古的锚点本在面内（面 359x284，狭长形），
         却因东侧有黑龙江/吉林的标签而被整体右推 39px —— 结果「内蒙古」三个字
         印在吉林脚下，用户看到的就是"内蒙古和北京没对上号"。
         有 keepIn（本行政区面内判定）时：让位可以挪，但绝不能挪出去；
         挪出去了就螺旋回搜最近的合法位置。*/
      if (style.keepIn) {
        var ok = searchNear(x, y, style.keepIn, 46, 4);
        if (ok) { x = ok[0]; y = ok[1]; }
        else { x = ox; y = oy; }   /* 一步都挪不动：退回调用方给的锚点 */
      }
    }

    /* 描边色：默认用与底图协调的深棕黑（而非纯黑/半透明黑）。
       实色描边在浅色面上边缘更利落，不会因半透明而"发灰显脏"。 */
    var halo = style.halo;
    if (halo == null || halo === 'none') halo = '#1c1408';
    var useHalo = (halo !== 'none');
    var hw = style.haloW || fs * 0.22;
    var maxHw = 3.4;
    if (hw > maxHw) hw = maxHw;
    if (!useHalo) hw = 0;

    var t = el('text', {
      x: x, y: y, class: 'gs-label', fill: style.fill || '#fff',
      'font-size': fs, 'text-anchor': style.anchor || 'middle',
      'font-weight': style.weight || 700, 'font-family': 'inherit'
    });
    if (useHalo) {
      t.setAttribute('paint-order', 'stroke');
      t.setAttribute('stroke', halo);
      t.setAttribute('stroke-width', hw.toFixed(2));
      t.setAttribute('stroke-linejoin', 'round');
    }
    t.textContent = text;
    t._lx = 1;              // 标记：供 _avoidLabels 识别为标签
    /* 预先记录屏幕矩形，供后续标签做避让判定。
       必须在元素尚未入 DOM 时就算好 —— 入 DOM 后 getBoundingClientRect
       可能返回 0 宽，导致避让整体失效（见 _avoidLabels 注释）。 */
    var estW = measureText(text, fs, style.weight || 700), estH = fs * 1.2;
    var hb = this.host.getBoundingClientRect();
    var anc = style.anchor || 'middle';
    var bx0 = anc === 'start' ? x : (anc === 'end' ? x - estW : x - estW / 2);
    t._pxBox = { left: hb.left + bx0, right: hb.left + bx0 + estW,
                 top: hb.top + y - estH * 0.78, bottom: hb.top + y + estH * 0.22 };
    if (meta) {
      t.setAttribute('data-pick', '1');
      if (meta.id) t.setAttribute('data-id', meta.id);
      if (meta.kind) t.setAttribute('data-kind', meta.kind);
      t.style.cursor = meta.kind ? 'pointer' : 'default';
    }
    if (style.opacity != null) t.setAttribute('opacity', style.opacity);
    L.g.appendChild(t);
    L.pxItems = L.pxItems || []; L.pxItems.push(t);
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
    /* ⚠️ 原来固定"数据框内缩 5%"作为可拖动范围，实测导致【全国视图完全拖不动】：
       全国视图 fit() 之后，视口恰好等于全国外接框，
       中心点被死死钳在 [bb+5%, bb-5%] 这一条几乎长度为 0 的区间里 ——
       横向拖 176px 之后 tx 竟完全没变（实测 -666 → -666）。
       用户报障："地图移动或变大变小，底层地理图片也要跟着变化啊，不能不动"，
       实际是第一步【业务面本身就动不了】。

       正确做法：按视口尺寸动态计算可拖动余量 ——
       当数据框比视口还小（即全国这类"一屏装下"的情形）时，
       允许中心在数据框外继续移动，最多让数据框移出视口一半。
       这样既能自由平移，又不会把地图拖丢（仍能看到主体）。
       语义：可拖动半宽 = max(0, 数据框半宽 - 视口半宽) + 视口半宽 × 0.5。*/
    var halfVw = this._vw / 2, halfVh = this._vh / 2;
    /* 允许中心越出数据框的范围：视口半宽的一半（留一半数据在视野内） */
    var slackX = halfVw * 0.5, slackY = halfVh * 0.5;
    var loX = bb[0] - slackX, hiX = bb[2] + slackX;
    var loY = bb[1] - slackY, hiY = bb[3] + slackY;
    /* 视口比数据框大（全国视图）时，中心至少要保证数据框有一部分可见：
       把范围收紧到"数据框中心 ± (数据框半宽 + 视口半宽×0.5)"，
       效果等价于允许拖到数据框边缘再往外半个视口。*/
    var dataCx = (bb[0] + bb[2]) / 2, dataCy = (bb[1] + bb[3]) / 2;
    var limX = bw / 2 + halfVw * 0.5, limY = bh / 2 + halfVh * 0.5;
    loX = dataCx - limX; hiX = dataCx + limX;
    loY = dataCy - limY; hiY = dataCy + limY;

    var vx = (halfVw - this.tx) / this.scale;
    var vy = (this.ty - halfVh) / this.scale;   // Y 轴已翻转
    var nvx = Math.min(hiX, Math.max(loX, vx));
    var nvy = Math.min(hiY, Math.max(loY, vy));
    if (nvx !== vx) this.tx = halfVw - nvx * this.scale;
    if (nvy !== vy) this.ty = halfVh + nvy * this.scale;
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

  /* 面内标签锚点：保证返回的点【落在本面内部】。
     ⚠️ 为什么不能用 polyCentroid：北京/天津这类被邻省环抱的面，
        几何质心（面积最大外环的形心）会跑到邻省里去 ——
        实测「北京」的质心落在河北省境内、「天津」落在渤海里，
        用户看到的就是「北京」两个字印在河北的位置上。
     做法：先把多边形用「竖直扫描线」切成若干条水平带，
     取每条带的中间点做候选，再用射线法筛出真正在面内的，
     最后选「离形心最近」的那个 —— 既在面内，又尽量居中。
     退化时（面很小或顶点太稀）回落到形心。 */
  /* 螺旋搜索（世界坐标版）：找离 (px,py) 最近、且在面内的点。
     labelAnchor 的扫描线在【狭长形】上会整批落空（内蒙古是典型：
     15 条扫描线全部落在两段之间的空白处），此时若无兜底就回退到质心 ——
     而狭长形的质心常常落在境外或邻省（内蒙古质心在蒙古国境内）。
     结果就是「内蒙古」三个字印在吉林脚下，与本省完全对不上号。*/
  function spiralInRings(px, py, rings, span, ok) {
    ok = ok || function (x, y) { return inRingsWorld(x, y, rings); };
    if (ok(px, py)) return [px, py];
    /* ⚠️ 圈数与每圈点数必须封顶。这里曾是 step=span/240（288 圈）× 220 点
       × 每次 4 次射线法采样 —— 南海诸岛一个省就要 3613ms，
       32 个省合计 10.1 秒，占 renderCountry 的 69%（实测 PerformanceObserver
       抓到单个 9.9s 的 longtask，整个页面冻结）。
       现在 48 圈 × 120 点 = 最多 5760 次判定，并设总预算硬闸。*/
    var step = Math.max(1, span / 48);
    var budget = 6000;
    for (var r = step; r <= span * 1.2 && budget > 0; r += step) {
      var n = Math.max(12, Math.round(r / step));
      if (n > 120) n = 120;
      for (var i = 0; i < n && budget > 0; i++, budget--) {
        var a = i / n * Math.PI * 2;
        var x = px + Math.cos(a) * r, y = py + Math.sin(a) * r;
        if (ok(x, y)) return [x, y];
      }
    }
    return null;
  }

  /* 标签锚点：必须真正落在本行政区面内，且【周围要容得下整个标签】。
     ⚠️ 只要求"锚点本身在面内"是不够的 —— 用户看到的错位多数是这种：
        「内蒙古」三个字骑在国界上，一半压在蒙古国境内，
        「河北」压在嵌在它中间北京的坑里，都属于"锚点在境内、
        标签有一截在境外"。所以锚点必须让开半个标签的余量。
     ⚠️ 选点策略也从"离质心最近"改为"面内最宽处优先"：
        狭长形（内蒙古的新月形）靠质心的位置往往很窄，
        标签根本放不下；真正的空间在南北两端那几条"腿"。
     流程：扫描线求各切片的宽度 → 取最宽且容得下标签的那条中点
           → 失败则螺旋搜索 → 再失败才用质心。
     pad：需要在锚点四周留出的余量（世界坐标），由调用方按标签宽高换算。*/
  var _laCache = new WeakMap();
  function labelAnchor(rings, pad) {
    pad = pad || 0;
    /* 缓存：同一 rings 数组 + 同一 pad，锚点结果完全相同。
       abs(p) 会把绝对坐标缓存到 p._abs，数组引用跨次渲染稳定，
       所以 WeakMap 能命中；而切视图/换缩放时 pad 变化会自然失效。
       实测重绘一次 renderCountry 里 32 个省要算 591ms（占标注耗时 46%），
       缓存后重复渲染近乎免费。*/
    var _hit = _laCache.get(rings);
    if (_hit && _hit.pad === pad) return _hit.pt;
    if (!rings || !rings.length) return [0, 0];
    var ct = polyCentroid(rings);
    var x0 = 1e18, x1 = -1e18, y0 = 1e18, y1 = -1e18;
    for (var i = 0; i < rings.length; i++) {
      var r = rings[i];
      for (var j = 0; j < r.length; j++) {
        if (r[j][0] < x0) x0 = r[j][0]; if (r[j][0] > x1) x1 = r[j][0];
        if (r[j][1] < y0) y0 = r[j][1]; if (r[j][1] > y1) y1 = r[j][1];
      }
    }
    var w = x1 - x0, h = y1 - y0;
    if (!(w > 0) || !(h > 0)) { _laCache.set(rings, { pad: pad, pt: ct }); return ct; }

    /* 扫描线求「面内最长水平切片的中点」：
       对每一批扫描线，取该线上落在面内的最宽区间，其中点即候选。
       全部候选里选离形心最近的 —— 既保证在面内，又尽量居中。
       ⚠️ 早期版本用「竖直扫描 + 交点两两配对」，在多环嵌套面上
       配对会错位（北京是多环，标签被算到河北境内）。现在改为
       用射线法直接判定每个交点是否真在面内，不依赖配对顺序。
       ⚠️ 扫描线数从 15 提到 41：15 条对狭长形（如内蒙古 359x284 的
       新月形）会整批落空，命中率太低。 */
    var NB = 25;                       // 扫描线数（41→25：首次渲染也快一倍，精度无损）
    var best = null, bestD = Infinity, bestW = -1;
    /* ⚠️ pad 自适应：标签比面还大时（直辖市/特别行政区/南海诸岛示意面），
       要求「四周留出 pad」注定一条扫描线都过不了 → 全部落空 →
       只能走螺旋兜底，那才是卡死的真正来源。
       面短边不足 pad 的 2 倍时，退化为「锚点在面内即可」，
       标签放不下的问题交给 fixLabelHome 与引线标注（callout）处理。*/
    var padOK = pad > 0 && pad <= w * 0.45 && pad <= h * 0.45;
    var fits = padOK
      ? function (x, y) {
          if (!inRingsWorld(x, y, rings)) return false;
          return inRingsWorld(x - pad, y, rings) && inRingsWorld(x + pad, y, rings)
            && inRingsWorld(x, y - pad * 0.7, rings) && inRingsWorld(x, y + pad * 0.7, rings);
        }
      : function (x, y) { return inRingsWorld(x, y, rings); };
    for (var k = 1; k < NB; k++) {
      var sy = y0 + h * k / NB;
      var xs = [];
      for (var m = 0; m < rings.length; m++) {
        var rr = rings[m];
        for (var j2 = 0, k2 = rr.length - 1; j2 < rr.length; k2 = j2++) {
          var ay = rr[k2][1], by = rr[j2][1];
          if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) {
            xs.push(rr[k2][0] + (sy - ay) / (by - ay) * (rr[j2][0] - rr[k2][0]));
          }
        }
      }
      if (xs.length < 2) continue;
      xs.sort(function (a, b) { return a - b; });
      // 逐个交点判断"向右 infinitesimal 是否有面"→ 交点即为区间边界
      var prev = null;
      for (var s = 0; s < xs.length; s++) {
        var xIn = inRingsWorld(xs[s] + 1e-6 * Math.max(1, w), sy, rings);
        if (xIn && prev === null) prev = xs[s];
        else if (!xIn && prev !== null) {
          var mid = (prev + xs[s]) / 2;
          var segW = xs[s] - prev;
          var d = (mid - ct[0]) * (mid - ct[0]) + (sy - ct[1]) * (sy - ct[1]);
          /* 宽度优先；同宽再比离质心的距离 */
          if (segW > bestW + 1e-6 || (segW > bestW - 1e-6 && d < bestD)) {
            if (fits(mid, sy)) { bestW = segW; bestD = d; best = [mid, sy]; }
          }
          prev = null;
        }
      }
      if (prev !== null && xs.length) {
        // 区间一直开到边界外：用最右交点收尾
        var mid2 = (prev + xs[xs.length - 1]) / 2;
        if (fits(mid2, sy)) {
          var segW2 = xs[xs.length - 1] - prev;
          var d2 = (mid2 - ct[0]) * (mid2 - ct[0]) + (sy - ct[1]) * (sy - ct[1]);
          if (segW2 > bestW + 1e-6 || (segW2 > bestW - 1e-6 && d2 < bestD)) {
            bestW = segW2; bestD = d2; best = [mid2, sy];
          }
        }
      }
    }
    /* 校验：候选必须真在面内（防御扫描线退化）
       ⚠️ 关键：北京的面在屏幕上只有 19×19px，而它与河北的面心相距很近，
          扫描线稍偏就落到邻省去了。必须用射线法复核。*/
    if (best && fits(best[0], best[1])) { _laCache.set(rings, { pad: pad, pt: best }); return best; }
    /* 扫描线全灭（狭长形）→ 从质心螺旋搜索最近的内部点，
       绝不把质心直接当锚点 —— 狭长形的质心常落在境外。*/
    var sp = spiralInRings(ct[0], ct[1], rings, Math.max(w, h), fits);
    if (!sp) sp = spiralInRings((x0 + x1) / 2, (y0 + y1) / 2, rings, Math.max(w, h), fits);
    sp = sp || ct;
    _laCache.set(rings, { pad: pad, pt: sp });
    return sp;
  }

  /* 单环射线法：点是否在这个环的多边形内（even-odd）。 */
  function inRing(px, py, r) {
    var inside = false;
    for (var j = 0, k = r.length - 1; j < r.length; k = j++) {
      var yi = r[j][1], yk = r[k][1];
      if ((yi > py) !== (yk > py)) {
        var xc = r[k][0] + (py - yk) / (yi - yk) * (r[j][0] - r[k][0]);
        if (px < xc) inside = !inside;
      }
    }
    return inside;
  }

  /* 点是否在多边形集合内。
     ⚠️ 纯 even-odd（所有环一起数穿越次数）在"外环 + 洞 + 飞地"的数据上会错：
        飞地与外环同向，却也被当成洞抵消掉。
     实测河北省是 4 个环（北京嵌在河北里 = 洞，渤海小岛/无棣 = 飞地），
     纯 even-odd 把「河北」的标签锚点算进了北京的坑里 ——
     屏幕上"河北"两个字正印在北京的位置上，随后 _syncPx 把它固化。

     正确做法（与浏览器 isPointInFill 一致）：
       ① 面积最大的环 = 外环，点必须在其中；
       ② 其余环若落在外环内 → 是"洞"，抵消；
          其余环若在外环外 → 是"飞地"，命中即为真（同类多个洞用奇偶抵消）。
     判据以浏览器原生 isPointInFill 为准（fixLabelHome 就是这么做的）。*/
  function inRingsWorld(px, py, rings) {
    if (!rings || !rings.length) return false;
    if (rings.length === 1) return inRing(px, py, rings[0]);
    var bi = 0, ba = -1;
    for (var i = 0; i < rings.length; i++) {
      var a = Math.abs(polyArea(rings[i]));
      if (a > ba) { ba = a; bi = i; }
    }
    var inBase = inRing(px, py, rings[bi]);
    if (!inBase) {
      // 飞地：在外环之外，但自己内部也算本行政区的一部分
      for (var j2 = 0; j2 < rings.length; j2++) {
        if (j2 === bi) continue;
        if (inRing(px, py, rings[j2])) return true;
      }
      return false;
    }
    // 在外环内：减去嵌在外环里的洞（同类多个洞用奇偶抵消）
    var holes = 0;
    for (var k2 = 0; k2 < rings.length; k2++) {
      if (k2 === bi) continue;
      if (inRing(px, py, rings[k2])) holes++;
    }
    return (holes % 2) === 0;
  }

  global.GeoCanvas = GeoCanvas;
  global.G = {
    mercY: mercY, lngToX: lngToX, xToLng: xToLng, yToLat: yToLat,
    mulberry32: mulberry32, pointInRings: pointInRings, ringsBBox: ringsBBox,
    polyCentroid: polyCentroid, polyArea: polyArea, labelAnchor: labelAnchor,
    /* 世界坐标版的点在多边形内判定 —— 标签归属约束要用它 */
    inRingsWorld: inRingsWorld, searchNear: searchNear, spiralInRings: spiralInRings
  };
})(window);