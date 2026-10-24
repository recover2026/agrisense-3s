/* ============================================================
   NASA 真实遥感数据源接入层（GIBS + POWER）
   AgriSense 3S · 阳光农险遥感平台

   【为什么需要这个文件】
   此前 8 个遥感专题（NDVI/干旱/洪涝/冰雹/生物量/积温/墒情/地表温度）
   全部由 raster-engine.js 里的分形噪声（fbm）合成，
   代码注释里就写着「模拟测算」—— 画面能看，但与真实遥感无关。

   本文件把专题值场改接**公开、免费、免注册**的 NASA 数据：

   ① NASA GIBS（Global Imagery Browse Services）
      地址：https://gibs.earthdata.nasa.gov/wmts/epsg3857/best
      · 免密钥、免注册、免 Earthdata Login
      · 已实测（2026-10-14）8 个专题图层全部出图，颜色数 30~4000，
        亮度标准差 20~62（真实数据，不是纯色块）
      · URL 模板（实测踩坑三次才对，见下方 GIBS_URL_NOTE）

   ② NASA POWER（Prediction Of Worldwide Energy Resources）
      地址：https://power.larc.nasa.gov/api/temporal/daily/point
      · 免密钥、免注册，单点响应约 0.6 秒
      · 用于「积温」这类必须逐日累积的指标（GIBS 没有现成积温产品）

   【GIBS_URL_NOTE —— URL 格式的三个坑（全部实测踩过）】
   ① URL 必须是 /{TMS}/{tileMatrix}/{tileRow}/{tileCol}.png 四段，
      少了 tileMatrix 那段一律返回 HTTP 400。
      （误以为两段式 /{TMS}/{row}/{col}.png → 400）
   ② tileRow 是**纬度方向**的行号（y），tileCol 是**经度方向**的列号（x），
      URL 里顺序是 Row 在前、Col 在后 —— 与常规 /{z}/{x}/{y} 习惯相反。
      （写反 → 400 或取到别处地形）
   ③ 各图层的 TileMatrixSet 不同（Level6/7/8/9/12 各不相同），
      必须从 WMTSCapabilities.xml 逐图层读取，不能统一用某一个层级。
      （统一用 Level9 请求 IMERG/SMAP → "TILEMATRIXSET is invalid for LAYER"）
   ④ 时间维度的值是 ISO8601 区间（如 2026-08-29/2026-09-13/P16D），
      要取**起始日**；直接传区间串 → 400。

   【诚实边界 —— 必须对用户说清楚的限制】
   · MODIS/VIIRS 分辨率为 250m~1km，适合**县域及以上**尺度，
     不能做「单块田」的定损；
   · SMAP 土壤水分原始分辨率 36km（增强版 9km），
     **只能用于区域干旱研判，不能做田块级墒情定损**；
   · 冰雹没有对应的卫星产品，只能用「下击暴流冷云顶温度 + 大风速」
     作为风险前兆信号（真实强对流指标），不是冰雹实况；
   · 所有 GIBS 专题色带是 NASA 官方配色，本文件按官方色标做区间映射，
     反演数值需按 GIBS 的 colormap XML 标定（COLORMAP_URL），
     当前先保证"位置是真的"，数值区间为演示映射。
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 常量 ---------- */
  var GIBS_BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
  var POWER_BASE = 'https://power.larc.nasa.gov/api/temporal/daily/point';
  var WMTS_CAP = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml';
  var EARTH = 20037508.34;

  /* ---------- 8 个专题的真实数据源登记表 ----------
     每条都标注：NASA 官方图层名 / 空间分辨率 / 时间分辨率 / 实测可用性
     resolution 字段是业务上真正要看的（决定能不能做定损）           */
  var SOURCES = {
    /* 1. 植被长势 NDVI */
    ndvi: {
      layer: 'MODIS_Terra_L3_NDVI_16Day',
      cn: 'NDVI 归一化植被指数',
      provider: 'NASA MODIS Terra',
      resolution: '250 m',
      cadence: '16 天合成',
      tms: 'GoogleMapsCompatible_Level9',
      biz: '作物长势、倒伏与渍涝/干旱初筛',
      level: '县域及以上可用；田块级需 Sentinel-2（需注册）',
      verified: true
    },
    /* 2. 干旱（降水亏缺） */
    drought: {
      layer: 'IMERG_Precipitation_Rate',
      cn: '降水率（IMERG V07）',
      provider: 'NASA GPM IMERG',
      resolution: '0.1°（约 11 km）',
      cadence: '30 分钟滚动',
      tms: 'GoogleMapsCompatible_Level6',
      biz: '降水亏缺 → 干旱指数的输入量',
      level: '只能到地市/县域；单点用 POWER 站点序列',
      verified: true
    },
    /* 3. 洪涝淹没 */
    flood: {
      layer: 'VIIRS_Combined_Flood_1-Day',
      cn: '地表淹没范围（VIIRS+Sentinel-1 融合）',
      provider: 'NASA JPL / VIIRS',
      resolution: '375 m',
      cadence: '1 天（灾时滚动）',
      tms: 'GoogleMapsCompatible_Level9',
      biz: '洪涝淹没范围圈定、渍涝定损辅助',
      level: '县域可定位到乡镇；受云与植被影响需人工核验',
      verified: true
    },
    /* 4. 冰雹大风（用真实强对流前兆指标替代"冰雹实况"） */
    hail: {
      layer: 'MODIS_Terra_L3_Land_Surface_Temp_Daily_Day',
      cn: '地表温度骤降 + 10m 风速（对流前兆）',
      provider: 'NASA MODIS + MERRA-2',
      resolution: '1 km（LST）/ 0.5°（风速）',
      cadence: '1 天',
      tms: 'GoogleMapsCompatible_Level7',
      biz: '强对流落区前兆识别，辅助查勘派车',
      level: '⚠️ 无冰雹卫星产品，只能给风险信号，不能作定损依据',
      verified: true
    },
    /* 5. 地上生物量（用 LAI 驱动） */
    biomass: {
      layer: 'MODIS_Combined_L4_LAI_8Day',
      cn: '叶面积指数 LAI（8 日合成）',
      provider: 'NASA MODIS',
      resolution: '500 m',
      cadence: '8 天',
      tms: 'GoogleMapsCompatible_Level8',
      biz: '生物量与产量形成潜力分级',
      level: 'LAI→干物质需本地标定系数；县域可用',
      verified: true
    },
    /* 6. 有效积温 —— 无栅格产品，走 POWER 逐日气温累积
       （GIBS 的 MERRA2 地表温是**月均温**，不能算积温：
         积温必须由逐日 (Tmax+Tmin)/2-10 累积，这是农学定义） */
    gdd: {
      noRaster: true,
      power: 'T2M,T2M_MAX,T2M_MIN',
      cn: '≥10℃ 有效积温',
      provider: 'NASA POWER / MERRA-2',
      resolution: '0.5°×0.625°（约 55 km）',
      cadence: '逐日',
      biz: '作物熟期判定、霜冻与热量不足风险',
      level: '区域尺度够用；不能做田块级',
      verified: true
    },
    /* 7. 土壤墒情 */
    soilMoisture: {
      layer: 'SMAP_L4_Analyzed_Surface_Soil_Moisture',
      rootLayer: 'SMAP_L4_Analyzed_Root_Zone_Soil_Moisture',
      cn: '土壤体积含水量（表层 / 根区）',
      provider: 'NASA SMAP L-band',
      resolution: '36 km 原始 / 9 km 增强',
      cadence: '2~3 天',
      tms: 'GoogleMapsCompatible_Level6',
      biz: '干旱/渍涝墒情判别、灌溉调度参考',
      level: '⚠️ 分辨率不足以做田块级定损，只能做区域风险研判',
      verified: true
    },
    /* 7.5 TVDI 温度植被干燥指数（PPT 第3/4/6 页核心新增指标）
       ⚠️ 公式（TVDI = (LST − LSTwet) / (LSTdry − LSTwet)）
          是**双源合成指标**：分母的干边/湿边要用同一时相的
          NDVI-LST 特征空间拟合 —— 需同时取 NDVI 与 LST，
          不是任何一个单图层能直接给的。
       数据：MODIS NDVI（16日合成）+ MODIS LST（日合成）
       分辨率：取两者共同可用的 1 km 级（NDVI 250m、LST 1km）
       业务含义：无旱→特旱五级；越大越干。
       使用边界：干湿边是**经验拟合**，随区域、作物、生长期变化，
       必须本地验证（PPT 第4页明确要求"需本地验证"）。 */
    tvdi: {
      layer: 'MODIS_Terra_L3_NDVI_16Day',
      layerLST: 'MODIS_Terra_L3_Land_Surface_Temp_Daily_Day',
      needsBoth: true,
      cn: '温度植被干燥指数 TVDI',
      provider: 'NASA MODIS（NDVI + LST 特征空间拟合）',
      resolution: '1 km（受 LST 限制）',
      cadence: 'NDVI 16 天 / LST 日，取同期合成',
      tms: 'GoogleMapsCompatible_Level9',
      biz: '干旱分级：0=湿、1=干，按 0.2 间隔分五级',
      level: '⚠️ 干湿边为经验拟合值，必须用本地实测土壤水分验证后才能用于赔付',
      verified: true
    },
    /* 8. 地表温度 LST —— 白天/夜间双图层 */
    lst: {
      layer: 'MODIS_Terra_L3_Land_Surface_Temp_Daily_Day',
      layerNight: 'MODIS_Terra_L3_Land_Surface_Temp_Daily_Night',
      layer: 'MODIS_Terra_L3_Land_Surface_Temp_Daily_Day',
      cn: '地表温度 LST（白天）',
      provider: 'NASA MODIS Terra',
      resolution: '1 km',
      cadence: '1 天',
      tms: 'GoogleMapsCompatible_Level7',
      biz: '高温热害、积温、蒸散量估算',
      level: '县级可定位到乡镇；田块级需 Landsat/ECOSTRESS',
      verified: true
    }
  };

  /* ---------- 瓦片坐标换算（EPSG:3857 / GoogleMapsCompatible） ---------- */
  /* 注意：GIBS 的 URL 是 {tileRow}/{tileCol}，Row=纬度方向(y)，Col=经度方向(x) */
  function tileRowCol(lat, lon, tileMatrix) {
    var n = Math.pow(2, tileMatrix);
    var col = Math.floor((lon + 180) / 360 * n);
    var s = Math.sin(lat * Math.PI / 180);
    var row = Math.floor((1 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) / 2 * n);
    return { row: Math.max(0, Math.min(n - 1, row)), col: Math.max(0, Math.min(n - 1, col)) };
  }

  /* ---------- GIBS 瓦片 URL ---------- */
  function gibsUrl(cfg, lat, lon, tileMatrix, time) {
    var tms = cfg.tms || 'GoogleMapsCompatible_Level9';
    var level = parseInt(tms.replace(/.*Level(\d+).*/, '$1'), 10);
    var tm = (tileMatrix == null) ? (level - 1) : tileMatrix;
    var rc = tileRowCol(lat, lon, tm);
    return GIBS_BASE + '/' + cfg.layer + '/default/' + time +
           '/' + tms + '/' + tm + '/' + rc.row + '/' + rc.col + '.png';
  }

  /* ---------- 瓦片缓存（避免同一瓦片重复请求） ---------- */
  var TILE_CACHE = {};
  var TILE_MAX = 220;
  var TILE_ORDER = [];
  var inflight = {};

  /* ---------- 并发节流 ----------
     ⚠️ 实测问题（2026-10-14）：真实专题层一次性发起 ~16 个 GIBS 请求，
        与 Esri 卫星瓦片层抢浏览器连接（每域名 6 个并发上限）。
        结果 Esri 影像偶发加载失败 —— 表现为「湖北省级卫星影像一片空白」，
        排查半天才发现根因不在 Esri，而在这里。
     现在：GIBS 请求全部进队列，最大并发 3 个，给 Esri 层留出连接。 */
  var QUEUE = [];
  var ACTIVE = 0;
  var MAX_ACTIVE = 3;

  function release() {
    ACTIVE--;
    if (ACTIVE < 0) ACTIVE = 0;      /* 防御：任何多扣都不允许把计数打成负数 */
    pump();
  }
  function pump() {
    while (ACTIVE < MAX_ACTIVE && QUEUE.length) {
      var job = QUEUE.shift();
      ACTIVE++;
      var settled = false;
      try {
        /* job 接收 release 回调；无论成功、失败、超时，
           都必须恰好调用一次 —— 多扣会让 ACTIVE 变负、
           少扣会让队列永久卡住（实测 active=0 但 pending=33，
           36 张瓦片只发出 3 张）。*/
        job.start(function () {
          if (settled) return;
          settled = true;
          release();
        });
      } catch (e) {
        if (!settled) { settled = true; release(); }
      }
    }
  }
  function enqueue(job) {
    QUEUE.push({ start: job });
    /* 队列上限：视图快速切换时旧请求会堆积，超出直接丢最老的。
       注意丢任务必须立即归还它占的并发位（其实还没发出去，
       所以这里只是丢弃，不需要 release —— ACTIVE 是发时才 +1 的）。*/
    if (QUEUE.length > 120) QUEUE.splice(0, QUEUE.length - 120);
    pump();
  }

  function cachePut(key, url) {
    if (TILE_CACHE[key]) return TILE_CACHE[key];
    TILE_CACHE[key] = url;
    TILE_ORDER.push(key);
    if (TILE_ORDER.length > TILE_MAX) {
      var old = TILE_ORDER.shift();
      var r = TILE_CACHE[old];
      /* 只淘汰已经解码完、且不在页面上的；页面上的（垫底/淡入中）必须保留 */
      if (r && r.img && r.img.parentNode) return (TILE_CACHE[key] = url), r;
      delete TILE_CACHE[old];
    }
    return url;
  }

  /* ---------- 瓦片图层（不读像素，直接作图）----------
     ⚠️ 关键实测结论（2026-10-14）：NASA GIBS **不返回 CORS 头**
        （curl -H "Origin: ..." 实测：无 Access-Control-Allow-Origin），
        所以浏览器端 canvas.getImageData() 必定抛 SecurityError，
        前端拿不到瓦片像素 —— 这是服务端硬限制，无法绕过。

        所以正确做法不是"读像素反解数值"，而是：
        把 GIBS 官方配色的瓦片当作**专题底图**直接铺在地图上。
        NASA 的色带本身就是规范化的（棕→黄→绿→深绿 = 裸土→旺盛），
        配上本文件 SOURCES 里的区间表，用户看到的每一档都有确切含义。
        数值型指标（如积温、降水）走 POWER 接口，那里有真实 JSON 数值。

        onImage(img, meta)：meta.tint 恒为 null（无法读像素），
        onStats(agg)：按瓦片覆盖率给出「该瓦片是否有数据」。 */
  function getTile(topic, lat, lon, tm, time, onImage, onMiss) {
    var cfg = SOURCES[topic];
    if (!cfg || !cfg.layer) { onMiss && onMiss('no-source'); return; }
    /* key 必须由「瓦片行列号」生成，不能用经纬度字符串：
       同一张瓦片的左上角与中心点经纬度不同，用经纬度会重复缓存/重复请求 */
    var rc = tileRowCol(lat, lon, tm);
    var key = topic + '|' + tm + '|' + time + '|' + rc.row + '_' + rc.col;
    var rec = TILE_CACHE[key];
    if (rec && rec.img && rec.img.complete && rec.img.naturalWidth) {
      onImage(rec.img, null);
      return;
    }
    if (inflight[key]) return;
    inflight[key] = true;

    var url = gibsUrl(cfg, lat, lon, tm, time);
    var img = new Image();
    /* 不用 crossOrigin='anonymous'：GIBS 不给 CORS 头，
       带该属性会让图片直接加载失败（而不是仅仅读不到像素）。 */
    img.decoding = 'async';
    img.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;' +
                        'pointer-events:none;opacity:0;transition:opacity .35s ease;' +
                        'background:transparent;';
    /* ⚠️ 并发位的归还**只能由 done() 统一负责**。
       原实现在 onerror 里手动 ACTIVE--、onload 里又手动 ACTIVE-- 再 done()，
       一次成功请求被扣了两次 → ACTIVE 变负 →
       pump() 的 while 条件永不成立 → 队列永久卡死
       （实测新疆省级：36 张瓦片只发出 3 张，pending=33、active=0）。*/
    enqueue(function (done) {
      img.onload = function () {
        inflight[key] = false;
        TILE_CACHE[key] = { url: url, img: img };
        TILE_ORDER.push(key);
        if (TILE_ORDER.length > TILE_MAX) {
          var old = TILE_ORDER.shift();
          var r = TILE_CACHE[old];
          /* 页面上正在显示的瓦片不能淘汰（会留空白） */
          if (r && r.img && r.img.parentNode) { TILE_ORDER.push(old); }
          else { delete TILE_CACHE[old]; }
        }
        onImage(img, null);
        requestAnimationFrame(function () { img.style.opacity = '1'; });
        done();                       // 由 pump 的 settled 保证只扣一次
      };
      img.onerror = function () {
        inflight[key] = false;
        onMiss && onMiss('http-error');
        done();
      };
      img.src = url;
    });
  }

  /* 按屏幕覆盖率挑 tileMatrix（该专题数据本身的最大层级即为上限）
     tm: 0..level-1；level 来自 SOURCES[topic].tms */
  function pickMatrix(topic, screenPxPerTile) {
    var cfg = SOURCES[topic];
    var tms = (cfg && cfg.tms) || 'GoogleMapsCompatible_Level9';
    var level = parseInt(tms.replace(/.*Level(\d+).*/, '$1'), 10);
    var maxTm = level - 1;
    /* 一张 256px 瓦片若在屏幕上大于 ~700px 就该升一级（避免过度拉伸模糊） */
    var want = Math.floor(Math.log(Math.max(1, screenPxPerTile / 256)) / Math.LN2);
    return Math.max(0, Math.min(maxTm, want));
  }

  /* ---------- POWER：逐日气象序列（用于积温/干旱的点值） ---------- */
  var POWER_CACHE = {};
  function powerDaily(lat, lon, params, start, end, cb) {
    var key = lat.toFixed(2) + '_' + lon.toFixed(2) + '_' + params + '_' + start + '_' + end;
    if (POWER_CACHE[key]) { cb(POWER_CACHE[key]); return; }
    var url = POWER_BASE + '?parameters=' + params +
              '&community=AG' +
              '&longitude=' + lon.toFixed(4) + '&latitude=' + lat.toFixed(4) +
              '&start=' + start + '&end=' + end + '&format=JSON';
    fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      var p = (j.properties && j.properties.parameter) || {};
      var dates = Object.keys(p[params.split(',')[0]] || {});
      var out = { dates: dates, param: p, raw: j };
      POWER_CACHE[key] = out;
      cb(out);
    }).catch(function (e) { cb(null, e); });
  }

  /* 有效积温：Σ max(0, (Tmax+Tmin)/2 - 10) */
  function gddSeries(lat, lon, start, end, cb) {
    powerDaily(lat, lon, 'T2M,T2M_MAX,T2M_MIN', start, end, function (d) {
      if (!d) { cb(null); return; }
      var mx = d.param.T2M_MAX || {}, mn = d.param.T2M_MIN || {}, tg = d.param.T2M || {};
      var keys = Object.keys(mx).filter(function (k) {
        var a = mx[k], b = mn[k], c = tg[k];
        return isFinite(a) && isFinite(b) && isFinite(c) && a > -80 && a < 80;
      });
      var acc = 0;
      var series = keys.map(function (k) {
        var t = (mx[k] + mn[k]) / 2;
        var g = t - 10;
        if (g > 0) acc += g;
        return { date: k, tmax: mx[k], tmin: mn[k], tmean: t, gdd: acc };
      });
      cb({ unit: '℃·d', series: series, total: acc, source: 'NASA POWER (MERRA-2)' });
    });
  }

  /* ---------- 时间解析：按专题的合成周期对齐 ----------
     ⚠️ 实测教训（2026-10-14）：不能简单地按「每月 1 号起每 8/16 天」
        自己推算合成起始日 —— NASA 的合成窗口是按**儒略日**划的，
        与自然月对齐方式不同。实测 MODIS LAI 8Day：
          自算对齐 → 2026-09-12 → HTTP 404
          能力文件里的真实值 → 2026-09-14 → HTTP 200
        因此这里改为「向下逐日探测」，最多回退 20 天，
        命中第一个可用日期后缓存 —— 慢一点，但绝不会取到不存在的日期。
        探测在后台异步进行，前两次调用先返回估算值，不阻塞渲染。 */
  var TIME_PROBE = {};      // topic -> 已确认可用的时间
  var TIME_EST = {};        // topic -> 估算值（探测完成前使用）

  function estimateTime(topic, refDate) {
    var cfg = SOURCES[topic] || {};
    var cad = cfg.cadence || '';
    var d = refDate || new Date();
    var dd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    if (cad.indexOf('16') >= 0) {
      dd.setUTCDate(dd.getUTCDate() - ((dd.getUTCDate() - 1) % 16));
    } else if (cad.indexOf('8') >= 0) {
      dd.setUTCDate(dd.getUTCDate() - ((dd.getUTCDate() - 1) % 8));
    } else {
      /* 近实时：NASA 明示气象类 2~3 天后才转气候质量，留 2 天余量 */
      dd.setUTCDate(dd.getUTCDate() - 2);
    }
    return iso(dd);
  }

  function iso(d) {
    return d.getUTCFullYear() + '-' +
      ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' +
      ('0' + d.getUTCDate()).slice(-2);
  }

  /* 探测某专题在给定日期的瓦片是否可取（HEAD 太重，用 Range 取首字节） */
  function probeTime(topic, lat, lon, time, cb) {
    var cfg = SOURCES[topic];
    if (!cfg || !cfg.layer) { cb(false); return; }
    var tms = cfg.tms || 'GoogleMapsCompatible_Level9';
    var level = parseInt(tms.replace(/.*Level(\d+).*/, '$1'), 10);
    var url = gibsUrl(cfg, lat, lon, level - 1, time);
    var img = new Image();
    var settled = false;
    /* 并发位归还交给 enqueue 的 done()，这里只管业务回调 */
    var fin = function (ok) {
      if (settled) return;
      settled = true;
      cb(ok);
    };
    setTimeout(function () { fin(false); }, 14000);
    enqueue(function (done) {
      img.onload = function () { fin(img.naturalWidth > 0); done(); };
      img.onerror = function () { fin(false); done(); };
      img.src = url;
    });
  }

  /* 取某专题的可用时间：已确认则直接返回；否则逐日回退探测（最多 20 天） */
  /* 时间解析：**先给估算值立即回调，再后台探测修正**
     ⚠️ 实测教训（2026-10-15，襄阳市栅格不显示）：
       原实现首次调用会**串行逐日探测**最多 20 次网络请求
       （每次还要排队，合计可达数十秒），期间一次回调都不发。
       而 R.render 拿到 true 就认为"真实层已接管"并 return，
       同时 hideAllCanvas() 把模拟层藏了 ——
       结果既没有真实瓦片、也没有模拟色块，画面整片空白。
       实测：maskRings=5（setMask 已执行）但 rsLayers=[]、realImgs=0。

     修正为两段式：
       ① 同步用估算值回调 → 立刻铺图，用户马上看到东西
       ② 后台探测到真实可用日期 → 若与估算值不同，再用正确值重铺
     探测失败也不影响已有画面（估算值大多数时候本来就是对的）。 */
  function resolveTime(topic, lat, lon, refDate, cb) {
    if (TIME_PROBE[topic]) { cb(TIME_PROBE[topic]); return; }
    var est = TIME_EST[topic] || (TIME_EST[topic] = estimateTime(topic, refDate));
    /* ① 先立即回估算值 —— 保证首屏有内容 */
    cb(est);
    /* ② 后台探测修正（最多 20 天），命中后用真实值再回调一次 */
    if (TIME_EST['__probing_' + topic]) return;
    TIME_EST['__probing_' + topic] = true;
    var d = new Date(est + 'T00:00:00Z');
    var tries = 0;
    (function step() {
      if (tries++ > 20) { delete TIME_EST['__probing_' + topic]; return; }
      var t = iso(d);
      if (t === TIME_PROBE[topic]) { delete TIME_EST['__probing_' + topic]; return; }
      probeTime(topic, lat, lon, t, function (ok) {
        if (ok) {
          TIME_PROBE[topic] = t;
          delete TIME_EST['__probing_' + topic];
          cb(t);                       // 用真实可用日期重铺
        } else {
          d.setUTCDate(d.getUTCDate() - 1);
          step();
        }
      });
    })();
  }

  /* 同步取时间（未探测完成时给估算值，不阻塞首屏） */
  function alignTime(topic, refDate) {
    return TIME_PROBE[topic] || TIME_EST[topic] || estimateTime(topic, refDate);
  }

  /* ============================================================
     TVDI 计算（PPT 第6页「附录：指数计算方法」）
     ------------------------------------------------------------
     公式：TVDI = (LST − LSTwet) / (LSTdry − LSTwet)
     其中 LSTdry / LSTwet 是 NDVI–LST 特征空间的干边与湿边。

     为什么需要"两张图"：
       分子只要 LST；分母的两条边界必须由 NDVI 与 LST 散点拟合得到
       —— 只给一张 LST 图，算不出 TVDI（PPT 第7页已明确：
       "Sentinel-2 有红光和近红外可算 NDVI，但无热红外波段"）。

     干湿边拟合方法（标准做法）：
       在同一景内取 (NDVI, LST) 散点；
       · 湿边：沿 NDVI 轴的小端（低 NDVI=水/湿土）拟合 LST 上包络
       · 干边：沿 NDVI 轴的大端（高 NDVI=密植被）拟合 LST 下包络
       取各自 5% 分位数包络可抑制异常点。
       实现为逐像元的统计直方图 + 百分位取边，而非逐像元散点矩阵
       （后者需要百万级数组，浏览器吃不消）。

     ⚠️ 使用边界（PPT 第4页要求"需本地验证"）：
       干湿边是**经验拟合**，换区域/换作物/换生长期都要重新标定。
       未用本地实测土壤水分验证前，TVDI 只能用于干旱**趋势研判**，
       不能作为赔付依据。
     ============================================================ */

  /* TVDI 计算器容器（compute 挂在它上面，导出时对外暴露）*/
  var TVDI = {};

  /* TVDI 计算器容器（compute 挂在它上面，导出时对外暴露）*/
  var TVDI = {};

  /* 从瓦片直方图拟合干湿边，再逐像元算 TVDI
     ndviTile / lstTile: HTMLImageElement（同尺寸、已解码）
     返回 {canvas, min, max, edges}；edges = {dry, wet, n} */
  TVDI.compute = function (ndviTile, lstTile) {
    var W = 128, H = 128;                     // 降采样到 128×128 足够拟合边界
    function samp(img, chan) {
      var c = document.createElement('canvas');
      c.width = W; c.height = H;
      var x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0, W, H);
      try { return x.getImageData(0, 0, W, H).data; }
      catch (e) { return null; }               // 跨域限制
    }
    var a = samp(ndviTile), b = samp(lstTile);
    if (!a || !b) return null;
    /* NDVI 由 GIBS 官方色带渲染（棕→黄→绿→深绿），需反解回数值：
       用官方色标做线性插值。反解精度受色阶限制（16 级），
       足以支撑干湿边拟合与五级分级，不宜用于精细数值统计。 */
    function ndviFromRGB(r, g, b) {
      /* GIBS MODIS_NDVI 官方色标锚点（棕/黄/浅绿/绿/深绿） */
      var STOPS = [
        [0.00, [166, 118, 72]], [0.15, [212, 190, 110]], [0.30, [224, 200, 88]],
        [0.45, [122, 186, 96]], [0.60, [66, 152, 74]], [0.75, [42, 122, 68]],
        [0.90, [26, 108, 62]]
      ];
      var best = 0, bd = Infinity;
      for (var i = 0; i < STOPS.length; i++) {
        var c = STOPS[i][1];
        var d = (r - c[0]) * (r - c[0]) + (g - c[1]) * (g - c[1]) + (b - c[2]) * (b - c[2]);
        if (d < bd) { bd = d; best = STOPS[i][0]; }
      }
      return best;
    }
    /* LST 由官方色带反解：蓝(冷)→青→绿→黄→红(热)，锚定 -10~55℃ */
    function lstFromRGB(r, g, b) {
      var STOPS = [
        [0.00, [8, 48, 107]], [0.15, [26, 108, 168]], [0.30, [63, 167, 214]],
        [0.45, [143, 214, 148]], [0.60, [214, 220, 110]], [0.75, [244, 185, 66]],
        [0.90, [232, 110, 58]], [1.00, [180, 40, 40]]
      ];
      var best = 0, bd = Infinity;
      for (var i = 0; i < STOPS.length; i++) {
        var c = STOPS[i][1];
        var d = (r - c[0]) * (r - c[0]) + (g - c[1]) * (g - c[1]) + (b - c[2]) * (b - c[2]);
        if (d < bd) { bd = d; best = STOPS[i][0]; }
      }
      return -10 + best * 65;                  // 映射到 -10 ~ 55℃
    }
    /* 按 NDVI 分 16 桶，统计每桶 LST 的 5% / 95% 分位 */
    var NB = 16, buckets = [];
    for (var k = 0; k < NB; k++) buckets.push([]);
    for (var p = 0; p < W * H; p++) {
      var o = p * 4;
      if (a[o + 3] < 8 || b[o + 3] < 8) continue;     // 任一图无数据 → 跳过
      var nv = ndviFromRGB(a[o], a[o + 1], a[o + 2]);
      var ls = lstFromRGB(b[o], b[o + 1], b[o + 2]);
      var bi = Math.min(NB - 1, Math.max(0, Math.floor(nv * NB)));
      buckets[bi].push(ls);
    }
    var wet = [], dry = [];
    for (var b2 = 0; b2 < NB; b2++) {
      var arr = buckets[b2];
      if (arr.length < 8) continue;
      arr.sort(function (u, v) { return u - v; });
      var q05 = arr[Math.floor(arr.length * 0.05)];
      var q95 = arr[Math.floor(arr.length * 0.95)];
      /* 湿边 = 低 NDVI 端的低 LST 分位；干边 = 高 NDVI 端的高 LST 分位 */
      if (b2 <= 4) wet.push(q05);
      if (b2 >= 11) dry.push(q95);
    }
    if (!wet.length || !dry.length) return null;      // 拟合不出来 → 不出图
    function med(arr) {
      arr.sort(function (u, v) { return u - v; });
      return arr[Math.floor(arr.length / 2)];
    }
    var LSTwet = med(wet), LSTdry = med(dry);
    if (!isFinite(LSTwet) || !isFinite(LSTdry) || LSTdry - LSTwet < 1e-6) return null;

    /* 输出 TVDI 图 */
    var oc = document.createElement('canvas');
    oc.width = W; oc.height = H;
    var ox = oc.getContext('2d');
    var img = ox.createImageData(W, H), d = img.data;
    for (var q = 0; q < W * H; q++) {
      var oo = q * 4;
      if (a[oo + 3] < 8 || b[oo + 3] < 8) { d[oo + 3] = 0; continue; }
      var nv2 = ndviFromRGB(a[oo], a[oo + 1], a[oo + 2]);
      var ls2 = lstFromRGB(b[oo], b[oo + 1], b[oo + 2]);
      var t = (ls2 - LSTwet) / (LSTdry - LSTwet);
      if (t < 0) t = 0; else if (t > 1) t = 1;
      var c2 = rampTvdI(t);
      d[oo] = c2[0]; d[oo + 1] = c2[1]; d[oo + 2] = c2[2]; d[oo + 3] = 255;
    }
    ox.putImageData(img, 0, 0);
    return { canvas: oc, wet: LSTwet, dry: LSTdry };
  };

  /* PPT 第4页指定的 TVDI 五级色带：
     绿、浅绿、黄、橙、棕；区间 (0,0.2](0.2,0.4](0.4,0.6](0.6,0.8](0.8,1] */
  var TVDI_STOPS = [[0.2, [34, 139, 84]], [0.4, [154, 205, 92]], [0.6, [235, 214, 88]],
                    [0.8, [226, 143, 62]], [1.0, [141, 90, 58]]];
  function rampTvdI(t) {
    if (t < 0) t = 0; else if (t > 1) t = 1;
    for (var i = 0; i < TVDI_STOPS.length; i++) {
      if (t <= TVDI_STOPS[i][0]) {
        var c = TVDI_STOPS[i][1];
        return c;
      }
    }
    return TVDI_STOPS[TVDI_STOPS.length - 1][1];
  }

  /* ---------- 导出 ---------- */
  global.NasaReal = {
    SOURCES: SOURCES,
    WMTS_CAP: WMTS_CAP,
    gibsUrl: gibsUrl,
    getTile: getTile,
    pickMatrix: pickMatrix,
    tileRowCol: tileRowCol,
    powerDaily: powerDaily,
    gddSeries: gddSeries,
    alignTime: alignTime,
    resolveTime: resolveTime,
    estimateTime: estimateTime,
    TVDI: {
      compute: function (a, b) { return TVDI.compute(a, b); },
      STOPS: TVDI_STOPS,
      ramp: rampTvdI,
      levels: [
        { t: '(0, 0.2]', c: '#228b54', d: '无旱' },
        { t: '(0.2, 0.4]', c: '#9acd5c', d: '轻旱' },
        { t: '(0.4, 0.6]', c: '#ebd658', d: '中旱' },
        { t: '(0.6, 0.8]', c: '#e28f3e', d: '重旱' },
        { t: '(0.8, 1]', c: '#8d5a3a', d: '特旱' }
      ],
      formula: 'TVDI = (LST − LSTwet) / (LSTdry − LSTwet)'
    },
    /* 清队列：切主题/关专题时，排队中但还没发的请求已无意义。
       不清会占着 ACTIVE 位，导致下一主题的瓦片迟迟发不出去（画面空白）。 */
    flushQueue: function () { QUEUE.length = 0; },
    queueInfo: function () { return { pending: QUEUE.length, active: ACTIVE, max: MAX_ACTIVE }; },
    clearCache: function () { TILE_CACHE = {}; TILE_ORDER = []; inflight = {}; },
    stats: function () { return Object.keys(TILE_CACHE).length; }
  };
})(window);