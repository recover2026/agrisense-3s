/* ============================================================
   承保信息视图 · 我司承保数据上传与空间化
   ------------------------------------------------------------
   合规红线（不可更改）：
   承保明细含被保险人身份与保单信息，属敏感数据。本模块
   全程在浏览器内存中完成解析、匹配、聚合与渲染，
   不发起任何网络请求、不写入任何服务器。
   用户关闭页面后数据即消失（如开启本地留存则仅存于本机
   localStorage，可一键清除）。

   数据流：文件 → 本地解析 → 字段映射 → 县名匹配 adcode
           → 县/乡镇聚合 → 地图着色 + 明细 + 灾点圈影响分析
   ============================================================ */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var fmt = function (n, d) { return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); };
  var P = function () { return window.__UW_PARSE__; };
  var REF = function () { return window.__COUNTY_REF__ || {}; };

  /* ---------- 县级参照索引按需加载 ----------
     geo-county-ref.js 约 240KB，只有「承保信息」视图用得到，
     不进首屏（首屏资源已从 68 压到 19，不能再往回加）。
     首次进入该视图时再拉，命中后复用。 */
  var refReady = null;
  function loadRef() {
    if (window.__COUNTY_REF__) return Promise.resolve(true);
    if (refReady) return refReady;
    refReady = new Promise(function (res) {
      var s = document.createElement('script');
      s.src = 'assets/data/geo-county-ref.js';
      s.onload = function () { res(!!window.__COUNTY_REF__); };
      s.onerror = function () {
        console.error('[uw] 县级参照索引加载失败');
        res(false);
      };
      document.head.appendChild(s);
    });
    return refReady;
  }

  var STORE_KEY = 'yg3s_uw_data_v1';

  var S = {
    fileName: '', fileSize: 0, enc: '', kind: '',
    sheets: [], sheetIdx: 0, headerIdx: -1, header: [], rows: [],
    map: {},          // 字段映射：逻辑字段 -> 列下标
    records: [],      // 归一化后的承保记录
    bad: [],          // 未匹配到县的记录
    agg: {},          // adcode -> 聚合
    loaded: false
  };
  window.__UW_STATE__ = S;

  /* ---------- 字段别名表 ----------
     承保台账各公司表头差异很大，这里按「包含匹配 + 优先级」识别。
     顺序即优先级：越靠前越具体。 */
  var FIELDS = [
    { k: 'policy', n: '保单号', req: false, al: ['保单号', '保单编号', '保险单号', '投保单号', '批单号', '保单号编码', 'policy', 'policyno', '保单'] },
    { k: 'holder', n: '被保险人', req: false, al: ['被保险人', '投保人', '农户', '农户名称', '被保险人名称', '投保人名称', '客户名称', '姓名', '被保人', '户主', 'holder', 'name'] },
    { k: 'idcard', n: '证件号', req: false, al: ['证件号', '身份证号', '身份证号码', '证件号码', '身份证', '客户号', '保户号', '农户编号', 'idcard', 'idno'] },
    { k: 'crop', n: '作物/标的', req: false, al: ['作物', '标的', '标的物', '保险标的', '承保标的', '品种', '作物名称', '险种标的', '标的名称', '养殖品种', 'crop'] },
    { k: 'area', n: '承保面积(亩)', req: false, al: ['承保面积', '面积', '投保面积', '保额面积', '承保亩数', '种植面积', '面积(亩)', '面积亩', '承保面积(亩)', '承保数量', '数量', '头数', 'area'] },
    { k: 'amount', n: '保额(元)', req: false, al: ['保额', '保险金额', '保险责任金额', '责任限额', '承保金额', '保额(元)', '保额元', '保额（元）', 'amount', '保险金额(元)'] },
    { k: 'prem', n: '保费(元)', req: false, al: ['保费', '保险费', '应收保费', '实收保费', '保费收入', '保费(元)', '保费元', '保费（元）', 'prem', 'premium'] },
    { k: 'town', n: '乡镇', req: false, al: ['乡镇', '所属乡镇', '乡镇名称', '乡', '镇', 'town'] },
    { k: 'vill', n: '行政村', req: false, al: ['行政村', '村', '村名称', '所属村', '行政村名称', 'village', '村组'] },
    { k: 'county', n: '县/区', req: true, al: ['县', '区县', '县区', '所属县', '县名称', '区县名称', '承保县', 'county', '县市', '县(区)'] },
    { k: 'lng', n: '经度', req: false, al: ['经度', 'lng', 'longitude', 'lon', '中心点经度', 'x坐标', '地块经度'] },
    { k: 'lat', n: '纬度', req: false, al: ['纬度', 'lat', 'latitude', '中心点纬度', 'y坐标', '地块纬度'] },
    { k: 'date', n: '起保日期', req: false, al: ['起保日期', '承保日期', '投保日期', '保险起期', '生效日期', '起期', 'date'] }
  ];

  function autoMap(header) {
    var map = {}, used = {};
    FIELDS.forEach(function (f) {
      var hit = -1;
      for (var a = 0; a < f.al.length && hit < 0; a++) {
        var al = f.al[a].toLowerCase().replace(/[（）()\s]/g, '');
        for (var i = 0; i < header.length; i++) {
          if (used[i]) continue;
          var h = String(header[i] || '').toLowerCase().replace(/[（）()\s]/g, '');
          if (!h) continue;
          if (h === al || h.indexOf(al) >= 0) { hit = i; break; }
        }
      }
      if (hit >= 0) { map[f.k] = hit; used[hit] = true; }
    });
    return map;
  }

  /* ---------- 行政区名称归一化 + 匹配 ----------
     承保表里写「黄梅县」「黄梅」「黄梅区」都要能落到同一个 adcode。
     重名县（如 通州区/新城区/铁西区）必须靠省份消歧。 */
  var NAME_TRIM = /(省|市|县|区|自治县|自治州|地区|盟|旗|林区|新区|开发区|管委会|特别行政区)/g;

  function normCounty(s) {
    return String(s || '').trim()
      .replace(/\s+/g, '')
      .replace(/[（）()]/g, '')
      .replace(NAME_TRIM, '');
  }

  // 历史名称别名（撤县设市/撤县设区）。承保台账常年沿用旧名，
  // 例如「监利县」在现行区划中是「监利市(421023)」。
  var ALIAS = function () { return window.__COUNTY_ALIAS__ || {}; };
  // 省级名称归一（「湖北省」→ 42）
  var PROV_CODE = {};
  (function () {
    var gp = window.__GEO_PROV__;
    if (gp && gp.provinces) {
      gp.provinces.forEach(function (p) { PROV_CODE[normCounty(p.n)] = String(p.c).slice(0, 2); });
    }
    ['北京', '天津', '上海', '重庆'].forEach(function (n, i) {
      PROV_CODE[n] = ['11', '12', '31', '50'][i];
    });
  })();

  var nameIndex = null, nameIndexProv = null;
  function buildNameIndex() {
    var R = REF(), m = {}, byProv = {};
    Object.keys(R).forEach(function (code) {
      var v = R[code];
      var key = normCounty(v.n);
      if (!key) return;
      (m[key] = m[key] || []).push(code);
      var pk = v.p;
      (byProv[pk] = byProv[pk] || {})[key] = code;
    });
    nameIndex = m; nameIndexProv = byProv;
  }

  // 返回 adcode 或 null；provHint 为省份名/adcode 前两位，用于重名消歧
  function matchCounty(rawName, provHint) {
    if (!nameIndex) buildNameIndex();
    var orig = String(rawName || '').trim();
    if (!orig) return null;
    // 先按原名找，找不到再走历史别名（如 监利县 → 监利市）
    var keys = [normCounty(orig)];
    var al = ALIAS();
    var hit = lookup(keys[0], provHint);
    if (hit) return hit;
    var alKey = al[orig] || al[keys[0]];
    if (alKey) {
      var k2 = normCounty(alKey);
      if (k2 && k2 !== keys[0]) {
        var h2 = lookup(k2, provHint);
        if (h2) return h2;
      }
    }
    return null;
  }

  function lookup(key, provHint) {
    if (!key) return null;
    var hint = null;
    if (provHint != null && provHint !== '') {
      var h = String(provHint).trim();
      hint = /^\d{2}$/.test(h) ? h : (PROV_CODE[normCounty(h)] || null);
      if (!hint && /^\d{6}$/.test(h)) hint = h.slice(0, 2);
    }
    var cand = nameIndex[key];
    if (!cand) {
      // 退一步：包含关系匹配（"黄梅" 命中 "黄梅县"），但必须唯一
      var acc = [];
      Object.keys(nameIndex).forEach(function (k) {
        if (k.length >= 2 && (k.indexOf(key) >= 0 || key.indexOf(k) >= 0)) {
          acc = acc.concat(nameIndex[k]);
        }
      });
      if (!acc.length) return null;
      cand = acc.filter(function (c, i, a) { return a.indexOf(c) === i; });
    }
    if (cand.length === 1) return cand[0];
    if (hint) {
      var f = cand.filter(function (c) { return c.slice(0, 2) === hint; });
      if (f.length) return f[0];
    }
    // 仍无法唯一确定：不猜，交给用户手动指定，避免错配到邻县
    return null;
  }

  /* ---------- 归一化：一行原始数据 → 一条承保记录 ---------- */
  function normalize() {
    var m = S.map, R = REF();
    var out = [], bad = [];
    var dataRows = S.rows.slice(S.headerIdx + 1);
    dataRows.forEach(function (r, i) {
      var get = function (k) {
        var i2 = m[k];
        return (i2 == null || i2 < 0) ? '' : (r[i2] == null ? '' : String(r[i2]).trim());
      };
      var countyRaw = get('county');
      var provGuess = '';
      // 乡镇/村名里常含县名（如「黄梅县小池镇」），先剥出县名
      var full = [get('county'), get('town'), get('vill')].join('');
      if (!countyRaw) {
        var m2 = String(full).match(/([一-龥]{2,8}?(?:县|区|市|旗|自治县|自治州))/);
        if (m2) countyRaw = m2[1];
      }
      var code = matchCounty(countyRaw, provGuess);
      var rec = {
        i: i + S.headerIdx + 2,        // 原始 Excel 行号（1 基，含表头偏移）
        policy: get('policy'), holder: get('holder'), idcard: get('idcard'),
        crop: get('crop'), town: get('town'), vill: get('vill'),
        area: P().num(get('area')), amount: P().num(get('amount')), prem: P().num(get('prem')),
        lng: P().num(get('lng')), lat: P().num(get('lat')),
        date: get('date'), countyRaw: countyRaw, code: code
      };
      if (!code) {
        if (countyRaw) bad.push(rec);
        else return; // 该行连县名都没有，整行跳过
        return;
      }
      var rv = R[code];
      rec.prov = rv.p; rec.countyName = rv.n;
      rec.cx = rv.x; rec.cy = rv.y;
      // 有经纬度就用真实坐标，否则用县中心点
      if (rec.lng && rec.lat && rec.lng > 70 && rec.lng < 140 && rec.lat > 3 && rec.lat < 55) {
        var xy = G.lngToX(rec.lng);
        var yy = G.mercY(rec.lat);
        rec.x = Math.round(xy); rec.y = Math.round(yy);
        rec.hasXY = true;
      } else {
        rec.x = rec.cx; rec.y = rec.cy; rec.hasXY = false;
        rec.lng = null; rec.lat = null;
      }
      // 落在县域内则保留真实点，否则回退到县中心（防止经纬度写错导致飞到别的省）
      var bb = rv.b;
      if (rec.hasXY && (rec.x < bb[0] || rec.x > bb[2] || rec.y < bb[1] || rec.y > bb[3])) {
        rec.outOfCounty = true;
        rec.x = rec.cx; rec.y = rec.cy; rec.hasXY = false;
      }
      out.push(rec);
    });
    S.records = out; S.bad = bad;
    aggregate();
  }

  function aggregate() {
    var agg = {};
    S.records.forEach(function (r) {
      var a = agg[r.code];
      if (!a) {
        a = agg[r.code] = {
          code: r.code, n: r.countyName, p: r.prov, x: r.cx, y: r.cy, b: REF()[r.code].b,
          cnt: 0, prem: 0, amount: 0, area: 0, holders: {}, crops: {}, towns: {},
          hasXY: 0, list: []
        };
      }
      a.cnt++;
      a.prem += r.prem || 0;
      a.amount += r.amount || 0;
      a.area += r.area || 0;
      if (r.holder) a.holders[r.holder] = 1;
      if (r.crop) a.crops[r.crop] = (a.crops[r.crop] || 0) + 1;
      if (r.town) a.towns[r.town] = (a.towns[r.town] || 0) + 1;
      if (r.hasXY) a.hasXY++;
      if (a.list.length < 400) a.list.push(r);
    });
    S.agg = agg;
  }

  /* ---------- 在监灾点影响分析 ----------
     ⚠️ 口径说明：平台在监灾点的真实数据结构是「影响省份列表」
        （DISASTERS[].provinces 为省级 adcode），既没有县级落区，
        也没有经纬度与影响半径。因此这里只能在【省级粒度】求交，
        不能假装能算出县级受灾保单 —— 那属于编造数据。
        结论口径：某在监灾点所涉省份中，我司有多少承保。            */
  function impact() {
    var DIS = (window.NAT && window.NAT.DISASTERS) || [];
    if (!S.records.length) return [];
    return DIS.map(function (d) {
      var provs = d.provinces || [];
      // 县 adcode 前 2 位是省码，补成 6 位与 provinces 里的省级 adcode 对齐
      var hit = Object.keys(S.agg).filter(function (c) {
        return provs.indexOf(S.agg[c].code.slice(0, 2) + '0000') >= 0;
      });
      var cnt = 0, prem = 0, area = 0, holders = {}, provSet = {};
      hit.forEach(function (c) {
        var a = S.agg[c];
        cnt += a.cnt; prem += a.prem; area += a.area;
        provSet[a.p] = 1;
        Object.keys(a.holders).forEach(function (h) { holders[h] = 1; });
      });
      return {
        d: d, codes: hit, provs: Object.keys(provSet),
        cnt: cnt, prem: prem, area: area, holders: Object.keys(holders).length
      };
    }).filter(function (x) { return x.cnt > 0; });
  }

  /* ============================================================
     界面渲染
     ============================================================ */

  function setStep(n) {
    $$('.uw-step').forEach(function (e) {
      e.classList.toggle('on', +e.dataset.step <= n);
      e.classList.toggle('cur', +e.dataset.step === n);
    });
  }

  function renderEmpty() {
    $('#uw-empty').style.display = '';
    $('#uw-main').style.display = 'none';
    // 汇总区是"生成之后"才有的内容，隐藏态要一并复位
    ['#uw-sumsec', '#uw-ranksec', '#uw-cropsec', '#uw-imps2', '#uw-tblsec'].forEach(function (s) {
      var e = $(s); if (e) e.style.display = 'none';
    });
  }
  function renderMain() {
    $('#uw-empty').style.display = 'none';
    $('#uw-main').style.display = '';
  }
  // 文件解析完成后：显示操作区（生成按钮在这里），汇总区仍隐藏
  function renderParsed() {
    $('#uw-empty').style.display = 'none';
    $('#uw-main').style.display = '';
  }

  /* ---- 上传区 ---- */
  function bindUpload() {
    var zone = $('#uw-drop');
    var input = $('#uw-file');
    if (!zone) return;

    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('over'); });
    });
    zone.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });
    zone.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
      if (input.files && input.files[0]) handleFile(input.files[0]);
      input.value = '';   // 允许重复选同一文件
    });
  }

  function handleFile(file) {
    var st = $('#uw-status');
    st.className = 'uw-status loading';
    st.textContent = '正在本地解析「' + file.name + '」…（文件不离开本机）';
    S.fileName = file.name; S.fileSize = file.size;
    // 先确保县级索引就位（首次进入该视图时才拉这 240KB）
    loadRef().then(function () {
      return P().readFile(file);
    }).then(function (res) {
      S.sheets = res.sheets; S.kind = res.kind; S.enc = res.enc || '';
      if (!res.sheets.length || !res.sheets.some(function (s) { return s.rows.length; })) {
        throw new Error('文件里没有读到任何数据行');
      }
      // 默认选数据行最多的表
      var bi = 0;
      res.sheets.forEach(function (s, i) { if (s.rows.length > res.sheets[bi].rows.length) bi = i; });
      S.sheetIdx = bi;
      onSheetChange();
      renderParsed();
      /* 校验这一步是否真的解析出了可用的承保数据。
         ⚠️ 之前无论内容是什么都显示绿色 ✅「已解析 N 行」——
         上传一段普通文字也会显示"成功"，但实际记录数为 0，
         用户以为上传好了，看不到任何后续结果，无从判断问题在哪。
         真实结构：S.map = { 字段key: 列索引 }，值 -1 表示未匹配。 */
      var dataRows = (res.sheets[bi].rows || []).length;
      var mapped = S.map ? Object.keys(S.map).filter(function (k) {
        return Number(S.map[k]) >= 0;
      }).length : 0;
      if (!dataRows) {
        st.className = 'uw-status err';
        st.textContent = '❌ 未读到任何数据行：文件可能是空的，或缺少表头行。请核对文件后重传。';
        renderMapPanel();
        return;
      }
      if (!mapped) {
        st.className = 'uw-status err';
        st.textContent = '❌ 已读到 ' + dataRows + ' 行，但没匹配到任何字段。' +
          '请确认表头含「保单号 / 被保险人 / 作物 / 承保面积 / 保费 / 乡镇 / 行政村 / 县」等列名。';
        renderMapPanel();
        return;
      }
      st.className = 'uw-status ok';
      st.textContent = '✅ 已解析 ' + res.sheets.length + ' 个工作表 · 编码 ' + (res.enc || 'XLSX') +
        ' · 选中「' + res.sheets[bi].name + '」共 ' + dataRows + ' 行' +
        ' · 匹配到 ' + mapped + ' 个字段';
      renderMapPanel();
    }).catch(function (e) {
      console.error(e);
      st.className = 'uw-status err';
      st.textContent = '❌ 解析失败：' + (e && e.message ? e.message : e);
    });
  }

  function onSheetChange() {
    var sh = S.sheets[S.sheetIdx];
    // ⚠️ 必须把数据行落到 S.rows：normalize() 只读 S.rows，
    //    漏掉这行会导致表头/映射都对，但记录数恒为 0（实测踩过）。
    S.rows = sh.rows || [];
    var hd = P().findHeader(S.rows);
    S.headerIdx = hd.index; S.header = hd.header;
    S.map = autoMap(S.header);
    setStep(2);
    renderMapPanel();
  }

  /* ---- 字段映射面板 ---- */
  function renderMapPanel() {
    var sh = S.sheets[S.sheetIdx];
    // 每个字段单独生成一份 options：不能复用同一个字符串再 replace，
    // 否则第二次 replace 时会命中上一份已改过的内容（曾导致所有映射都变成"未使用"）。
    function optionsFor(cur) {
      var out = ['<option value="-1"' + (cur == null ? ' selected' : '') + '>— 未使用 —</option>'];
      S.header.forEach(function (h, i) {
        out.push('<option value="' + i + '"' + (cur === i ? ' selected' : '') + '>' +
          String.fromCharCode(65 + (i % 26)) + ' · ' + esc(h || '(空列)') + '</option>');
      });
      return out.join('');
    }
    var rows = FIELDS.map(function (f) {
      return '<div class="uw-mrow' + (f.req ? ' req' : '') + '">' +
        '<div class="uw-mn">' + f.n + (f.req ? '<i>*</i>' : '') + '</div>' +
        '<select class="uw-ms" data-k="' + f.k + '">' + optionsFor(S.map[f.k]) + '</select></div>';
    }).join('');

    $('#uw-map-rows').innerHTML = rows;
    $$('#uw-map-rows .uw-ms').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var k = sel.dataset.k;
        if (+sel.value < 0) delete S.map[k];
        else S.map[k] = +sel.value;
      });
    });

    // 预览前 8 行原始数据
    var hd = S.headerIdx;
    var pr = [];
    for (var i = hd; i < Math.min(hd + 9, sh.rows.length); i++) {
      var r = sh.rows[i] || [];
      pr.push('<tr>' + S.header.map(function (_, ci) {
        return '<td>' + esc(r[ci] || '') + '</td>';
      }).join('') + '</tr>');
    }
    $('#uw-preview').innerHTML =
      '<table class="uw-pv"><thead><tr>' +
      S.header.map(function (h, i) {
        var tag = '';
        Object.keys(S.map).forEach(function (k) { if (S.map[k] === i) tag = ' mapped'; });
        return '<th class="' + tag.trim() + '">' + String.fromCharCode(65 + (i % 26)) + '<br>' + esc(h || '') + '</th>';
      }).join('') + '</tr></thead><tbody>' + pr.join('') + '</tbody></table>';

    // 表头选择（多工作表）
    var so = S.sheets.map(function (s, i) {
      return '<option value="' + i + '"' + (i === S.sheetIdx ? ' selected' : '') + '>' +
        esc(s.name) + '（' + s.rows.length + ' 行）</option>';
    }).join('');
    var sel = $('#uw-sheet');
    if (sel) {
      sel.innerHTML = so;
      sel.onchange = function () { S.sheetIdx = +sel.value; onSheetChange(); };
      sel.style.display = S.sheets.length > 1 ? '' : 'none';
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ---- 生成承保记录 ---- */
  function buildRecords() {
    if (S.map.county == null || S.map.county < 0) {
      var st = $('#uw-status');
      st.className = 'uw-status err';
      st.textContent = '❌ 必须指定「县/区」列，否则无法上图。请在字段映射中选择县名列后重试。';
      return;
    }
    normalize();
    setStep(3);
    renderMain();
    // 汇总 / 排名 / 作物 / 灾点影响 / 明细 —— HTML 里默认隐藏，生成后统一显示
    ['#uw-sumsec', '#uw-ranksec', '#uw-cropsec', '#uw-imps2', '#uw-tblsec'].forEach(function (s) {
      var e = $(s); if (e) e.style.display = '';
    });
    renderSummary();
    // __UW_MAP__ 是 GeoCanvas 实例（无 draw 方法），绘制入口是本模块的 drawMap
    drawMap();
  }

  /* ---- 汇总面板 ---- */
  function renderSummary() {
    var n = S.records.length, badN = S.bad.length;
    var tot = { prem: 0, area: 0, amount: 0 };
    var holders = {}, crops = {}, provs = {};
    S.records.forEach(function (r) {
      tot.prem += r.prem || 0; tot.area += r.area || 0; tot.amount += r.amount || 0;
      if (r.holder) holders[r.holder] = 1;
      if (r.crop) crops[r.crop] = 1;
      provs[r.prov] = (provs[r.prov] || 0) + 1;
    });
    var xy = S.records.filter(function (r) { return r.hasXY; }).length;
    var oob = S.records.filter(function (r) { return r.outOfCounty; }).length;

    $('#uw-kpi').innerHTML = [
      kcard('承保记录', fmt(n, 0), '条', '已匹配到县', '#3b82f6'),
      kcard('承保保费', (tot.prem / 1e4).toFixed(1), '万元', S.fileName ? '来自本地文件' : '', '#34d399'),
      kcard('承保面积', (tot.area / 1e4).toFixed(2), '万亩', Object.keys(crops).length + ' 类作物', '#ffd35a'),
      kcard('覆盖县域', String(Object.keys(S.agg).length), '个', Object.keys(provs).length + ' 个省域', '#fb923c')
    ].join('');

    var info = [];
    info.push('被保险人 <b>' + fmt(Object.keys(holders).length, 0) + '</b> 人户');
    info.push('精确坐标 <b>' + xy + '</b> 条（其余按县中心落点）');
    if (oob) info.push('<span style="color:#fb923c">经纬度落在县域外已回退县中心 <b>' + oob + '</b> 条</span>');
    if (badN) info.push('<span style="color:#f87171">未匹配到县 <b>' + badN + '</b> 条</span>');
    else info.push('全部记录均已匹配到县');
    $('#uw-meta').innerHTML = info.join(' · ');

    // 县聚合排名
    var arr = Object.keys(S.agg).map(function (c) { return S.agg[c]; });
    arr.sort(function (a, b) { return b.prem - a.prem; });
    var mx = arr.length ? arr[0].prem : 1;
    $('#uw-rank').innerHTML = arr.slice(0, 30).map(function (a) {
      return '<div class="hbar"><div class="hbar-n">' + esc(a.n) + '<i>' + esc(a.p) + '</i></div>' +
        '<div class="hbar-t"><i style="width:' + (a.prem / mx * 100).toFixed(1) + '%;background:linear-gradient(90deg,#34d399,#22d3ee)"></i></div>' +
        '<div class="hbar-v">' + (a.prem / 1e4).toFixed(1) + '万</div></div>';
    }).join('') || '<div class="uw-empty-tip">无数据</div>';

    // 作物构成
    var cropArr = Object.keys(crops).map(function (c) { return [c, crops[c]]; })
      .sort(function (a, b) { return b[1] - a[1]; });
    var cs = cropArr.reduce(function (a, b) { return a + b[1]; }, 0) || 1;
    $('#uw-crop').innerHTML = cropArr.map(function (c) {
      return '<div class="hbar"><div class="hbar-n">' + esc(c[0]) + '</div>' +
        '<div class="hbar-t"><i style="width:' + (c[1] / cs * 100).toFixed(1) + '%;background:linear-gradient(90deg,#a78bfa,#3b82f6)"></i></div>' +
        '<div class="hbar-v">' + c[1] + '</div></div>';
    }).join('') || '<div class="uw-empty-tip">无数据</div>';

    // 灾点影响
    var im = impact();
    $('#uw-impact').innerHTML = im.length ? im.map(function (x) {
      return '<div class="row"><div class="row-h"><div class="row-t">' + esc(x.d.name) + '</div>' +
        '<span class="tag tag-red">' + esc(x.d.level) + '</span></div>' +
        '<div class="row-m"><span>涉及我司承保县 <b>' + x.codes.length + '</b> 个</span>' +
        '<span>保单 <b>' + fmt(x.cnt, 0) + '</b> 笔</span>' +
        '<span>农户 <b>' + fmt(x.holders, 0) + '</b> 户</span>' +
        '<span>保费 <b>' + (x.prem / 1e4).toFixed(1) + '</b> 万元</span></div>' +
        '<div class="row-m"><span class="ell">' + esc(x.provs.join('、')) + '</span></div></div>';
    }).join('') : '<div class="uw-empty-tip">当前在监灾点所涉省份未覆盖已上传的承保县域</div>';

    // 明细表
    var head = ['保单号', '被保险人', '作物', '面积(亩)', '保额(元)', '保费(元)', '县', '乡镇', '落点'];
    $('#uw-table thead').innerHTML = '<tr>' + head.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr>';
    $('#uw-table tbody').innerHTML = S.records.slice(0, 300).map(function (r) {
      return '<tr><td>' + esc(r.policy || '—') + '</td><td>' + esc(maskName(r.holder)) + '</td>' +
        '<td>' + esc(r.crop || '—') + '</td><td>' + fmt(r.area || 0, 2) + '</td>' +
        '<td>' + fmt(r.amount || 0, 0) + '</td><td>' + fmt(r.prem || 0, 0) + '</td>' +
        '<td>' + esc(r.countyName) + '</td><td>' + esc(r.town || '—') + '</td>' +
        '<td>' + (r.hasXY ? '<span class="tag tag-green">坐标</span>' : '<span class="tag tag-grey">县中心</span>') +
        (r.outOfCounty ? ' <span class="tag tag-orange">已纠偏</span>' : '') + '</td></tr>';
    }).join('');
    if (S.records.length > 300) {
      $('#uw-table tbody').innerHTML += '<tr><td colspan="9" style="text-align:center;color:var(--txt-3)">' +
        '仅显示前 300 条，共 ' + fmt(S.records.length, 0) + ' 条</td></tr>';
    }

    // 未匹配清单
    if (S.bad.length) {
      var uniq = {};
      S.bad.forEach(function (r) { uniq[r.countyRaw] = (uniq[r.countyRaw] || 0) + 1; });
      $('#uw-bad').innerHTML = '<div class="uw-badtip">以下 ' + S.bad.length + ' 条记录的县名未能匹配到全国行政区划' +
        '（重名或写法差异会导致无法自动判定）：</div><div class="uw-badlist">' +
        Object.keys(uniq).map(function (k) {
          return '<span class="tag tag-grey">' + esc(k) + ' × ' + uniq[k] + '</span>';
        }).join('') + '</div>';
      $('#uw-bad').style.display = '';
    } else {
      $('#uw-bad').style.display = 'none';
    }

    // 文件信息
    $('#uw-fileinfo').innerHTML = '<b>' + esc(S.fileName) + '</b> · ' +
      (S.fileSize / 1024).toFixed(1) + ' KB · ' + (S.kind === 'xlsx' ? 'Excel 工作簿' : 'CSV/文本') +
      (S.enc ? ' · 编码 ' + esc(S.enc) : '') + ' · 表头在第 ' + (S.headerIdx + 1) + ' 行';
  }

  // 姓名脱敏（默认只显示姓）
  function maskName(s) {
    if (!s) return '—';
    s = String(s);
    return s.length <= 1 ? s : s.charAt(0) + '*'.repeat(Math.min(s.length - 1, 3));
  }

  function kcard(l, v, u, d, c) {
    return '<div class="kpi" style="--c:' + c + '"><div class="kpi-l">' + l + '</div>' +
      '<div class="kpi-v">' + v + '<small>' + u + '</small></div>' +
      '<div class="kpi-d">' + d + '</div></div>';
  }

  /* ---- 导出（把解析结果导出为标准模板 CSV，便于核对） ---- */
  function exportCSV() {
    if (!S.records.length) return;
    var head = ['保单号', '被保险人', '作物', '承保面积(亩)', '保额(元)', '保费(元)', '省', '县', '乡镇', '行政村', '经度', '纬度', '起保日期'];
    var lines = [head.join(',')];
    S.records.forEach(function (r) {
      lines.push([
        r.policy || '', r.holder || '', r.crop || '', r.area == null ? '' : r.area,
        r.amount == null ? '' : r.amount, r.prem == null ? '' : r.prem,
        r.prov || '', r.countyName || '', r.town || '', r.vill || '',
        r.lng == null ? '' : r.lng, r.lat == null ? '' : r.lat, r.date || ''
      ].map(function (v) {
        var s = String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(','));
    });
    // BOM 让 Excel 正确识别 UTF-8
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '承保信息_标准化_' + (S.fileName || '').replace(/\.[^.]+$/, '') + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /* ---- 本地留存 ---- */
  function saveLocal() {
    try {
      var payload = {
        v: 1, fileName: S.fileName, header: S.header, map: S.map,
        records: S.records.map(function (r) {
          return [r.policy, r.holder, r.crop, r.area, r.amount, r.prem,
                  r.prov, r.countyName, r.town, r.vill, r.lng, r.lat, r.date, r.code];
        })
      };
      localStorage.setItem(STORE_KEY, JSON.stringify(payload));
      return true;
    } catch (e) {
      return false;
    }
  }
  function hasLocal() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      var p = JSON.parse(raw);
      return !!(p && p.records && p.records.length);
    } catch (e) { return false; }
  }

  function loadLocal() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      var p = JSON.parse(raw);
      if (!p || !p.records || !p.records.length) return false;
      S.fileName = p.fileName; S.header = p.header || []; S.map = p.map || {};
      S.kind = 'local';
      S.records = p.records.map(function (a) {
        var R = REF();
        var rv = R[a[13]] || {};
        return {
          policy: a[0], holder: a[1], crop: a[2], area: a[3], amount: a[4], prem: a[5],
          prov: a[6], countyName: a[7], town: a[8], vill: a[9], lng: a[10], lat: a[11],
          date: a[12], code: a[13], countyRaw: a[7],
          cx: rv.x, cy: rv.y,
          x: (a[10] != null && a[11] != null) ? Math.round(G.lngToX(a[10])) : rv.x,
          y: (a[10] != null && a[11] != null) ? Math.round(G.mercY(a[11])) : rv.y,
          hasXY: (a[10] != null && a[11] != null)
        };
      });
      S.loaded = true;
      aggregate();
      setStep(3);
      renderMain();
      ['#uw-sumsec', '#uw-ranksec', '#uw-cropsec', '#uw-imps2', '#uw-tblsec'].forEach(function (s) {
        var e = $(s); if (e) e.style.display = '';
      });
      renderSummary();
      return true;
    } catch (e) { return false; }
  }
  function clearLocal() {
    localStorage.removeItem(STORE_KEY);
  }

  /* ---- 地图（独立 SVG 图层，直接用 GeoCanvas） ---- */
  function initMap() {
    var host = $('#uw-map');
    if (!host) return null;
    if (window.__UW_MAP__) { window.__UW_MAP__.resize(); return window.__UW_MAP__; }
    var m = new GeoCanvas(host, {
      onPick: function (p) {
        if (p.kind === 'uw-county' || p.kind === 'uw-point') {
          var a = S.agg[p.id];
          if (a) showCounty(a);
        }
      },
      onView: function (v) {
        $('#uw-coord').textContent = v.lng.toFixed(2) + '°E  ' + v.lat.toFixed(2) + '°N';
        // ⚠️ 这里不要重建底图瓦片。build() 内部有 _sig 去重，
        //    而 fit() 之前的一帧视图同样会触发 onView —— 那一帧的
        //    变换尚未生效，build() 会把 50 多张瓦片全算到同一位置并
        //    写入 _sig，之后真正的 fit 完成也不再重建（实测全叠在一点）。
        //    底图统一在 paintMap() 里 fit 完成后重建一次。
      }
    });
    m.layer('base', 1); m.layer('uw', 2); m.pxLayer('lab', 3);
    // ⚠️ 必须显式 resize：GeoCanvas 构造时不会测量容器，
    //    _vw/_vh 为空时 fit() 会静默 return，导致图元以世界坐标
    //    原样写进 path（d="M12573167,3477641"），画面全空白。
    m.resize();
    // 真实卫星底图（与全国遥感地图同一数据源，免 KEY）
    // ⚠️ 两个必须照做的地方（都是实测踩出来的）：
    //   ① kind 传 'satellite'，EsriImagery 内部按 kind 查 URL 表；
    //   ② 瓦片要挂到【独立的 esriHost 容器】里，不能直接 append 到
    //      地图宿主 —— GeoCanvas 每次 _build/resize 都会重写宿主 innerHTML，
    //      直接挂在宿主里的 <img> 会被一起清掉。
    if (window.EsriImagery && !window.__UW_ESRI__) {
      try {
        var ehost = document.createElement('div');
        ehost.className = 'esri-imagery';
        ehost.style.cssText = 'position:absolute;inset:0;z-index:0;' +
          'pointer-events:none;overflow:hidden';
        host.insertBefore(ehost, host.firstChild);
        window.__UW_ESRI_HOST__ = ehost;
        window.__UW_ESRI__ = window.EsriImagery.create(ehost, 'satellite');
        host.classList.add('has-basemap');
        // 用户主动缩放 / 复位后重建底图。
        // 必须在事件触发时（而不是 onView 里）做：onView 在 fit() 的
        // 中间帧也会触发，那时变换还没生效，会把瓦片全部算到同一点。
        var ctl = host.querySelector('.gs-ctl');
        if (ctl) ctl.addEventListener('click', function () {
          setTimeout(function () {
            if (window.__UW_ESRI__ && window.__UW_MAP__) {
              try { window.__UW_ESRI__.build(window.__UW_MAP__); } catch (e) { }
            }
          }, 60);
        });
      } catch (e) { }
    }
    window.__UW_MAP__ = m;
    return m;
  }

  /* ---------- 真实县界加载（按省懒加载） ----------
     geo-county-<省>.js 里是相对 bbox 坐标（b=[x0,y0,x1,y1]，r 为相对米），
     使用时必须加回原点。文件按省切分，这里只为「已上传承保数据涉及的省」加载，
     不预加载全部 34 省，避免为几百 KB 数据拖慢首屏。 */
  var KBI = window.__KBI__ || [];
  var KB = {};                 // adcode -> 县界要素（已还原为绝对坐标）
  var kbLoading = {}, kbTried = {};

  function loadCountyProv(pc, cb) {
    if (KB[pc]) return cb(KB[pc]);
    if (kbLoading[pc]) { kbLoading[pc].push(cb); return; }
    var meta = null;
    for (var i = 0; i < KBI.length; i++) if (KBI[i].p === pc) { meta = KBI[i]; break; }
    if (!meta) { kbTried[pc] = true; return cb(null); }
    kbLoading[pc] = [cb];
    var s = document.createElement('script');
    s.src = 'assets/data/' + meta.f;
    s.onload = function () {
      var d = window.__KBP__;
      try { delete window.__KBP__; } catch (e) { window.__KBP__ = null; }
      var store = {};
      if (d) {
        Object.keys(d).forEach(function (code) {
          var o = d[code];
          if (!o || !o.r || !o.b) return;
          var b = o.b;
          if (b.length === 2) b = [b[0], b[1], b[0] + (o.w || 0), b[1] + (o.h || 0)];
          // 还原为绝对世界坐标，b 置 [0,0,..] 以便引擎直接使用
          store[code] = {
            n: o.n, c: code,
            r: o.r.map(function (ring) {
              return ring.map(function (p) { return [p[0] + b[0], p[1] + b[1]]; });
            }),
            b: [0, 0, b[2] - b[0], b[3] - b[1]]
          };
        });
        KB[pc] = store;
      }
      var list = kbLoading[pc] || []; kbLoading[pc] = null;
      list.forEach(function (f) { f(KB[pc] || null); });
    };
    s.onerror = function () {
      var list = kbLoading[pc] || []; kbLoading[pc] = null;
      list.forEach(function (f) { f(null); });
    };
    document.head.appendChild(s);
  }

  // 取某县边界要素；没有就用索引里自带的 _r（省直辖县）
  function countyGeom(code) {
    var pc = code.slice(0, 2);
    var store = KB[pc];
    if (store && store[code]) return store[code];
    var v = REF()[code];
    if (v && v._r && v._r.length) {
      var b = v.b;
      return {
        n: v.n, c: code,
        r: v._r.map(function (ring) {
          return ring.map(function (p) { return [p[0] - b[0], p[1] - b[1]]; });
        }),
        b: [0, 0, b[2] - b[0], b[3] - b[1]]
      };
    }
    return null;
  }

  // 确保所有承保县的边界就绪（按省分组并发加载），完成后回调
  function ensureBoundaries(codes, done) {
    var provs = {};
    codes.forEach(function (c) { provs[c.slice(0, 2)] = 1; });
    var ps = Object.keys(provs);
    if (!ps.length) return done();
    var left = ps.length;
    ps.forEach(function (pc) {
      loadCountyProv(pc, function () { if (--left <= 0) done(); });
    });
  }

  function drawMap() {
    var m = window.__UW_MAP__;
    if (!m) { m = initMap(); }
    if (!m) return;

    var codes = Object.keys(S.agg);
    if (!codes.length) {
      m.clear('base'); m.clear('uw'); m.clear('lab');
      $('#uw-mapinfo').textContent = '尚未上传数据';
      /* 空状态：地图无内容时，隐藏图例与坐标读数，改显示引导说明。
         此前图例（保费低/中/较高/最高 + 有精确坐标的保单）始终悬在
         空图左下角，坐标读数显示「—」，让人以为漏了数据或功能坏了。 */
      var lg = document.getElementById('uw-legend-box');
      var eh = document.getElementById('uw-empty-hint');
      if (lg) lg.hidden = true;
      if (eh) eh.hidden = false;
      var cd = document.querySelector('#v-uw .gs-coord');
      if (cd) cd.style.display = 'none';
      return;
    }
    /* 有数据：恢复图例、坐标读数，隐藏引导 */
    var lg2 = document.getElementById('uw-legend-box');
    var eh2 = document.getElementById('uw-empty-hint');
    if (lg2) lg2.hidden = false;
    if (eh2) eh2.hidden = true;
    var cd2 = document.querySelector('#v-uw .gs-coord');
    if (cd2) cd2.style.display = '';
    // 容器必须已有真实尺寸，否则 fit() 静默失效（画面空白）
    m.resize();
    if (!m._vw || !m._vh) {
      setTimeout(function () {
        if (window.__UW_MAP__) { window.__UW_MAP__.resize(); drawMap(); }
      }, 260);
      return;
    }
    // 真实县界是异步按省加载的：先确保边界到位，再画。
    // 否则首帧只有占位方块县界，加载完也不会自动重绘。
    ensureBoundaries(codes, function () { paintMap(m, codes); });
  }

  function paintMap(m, codes) {
    m.clear('base'); m.clear('uw'); m.clear('lab');

    // 视图范围：所有承保县的并集 bbox
    var B = [Infinity, Infinity, -Infinity, -Infinity];
    codes.forEach(function (c) {
      var b = S.agg[c].b;
      B[0] = Math.min(B[0], b[0]); B[1] = Math.min(B[1], b[1]);
      B[2] = Math.max(B[2], b[2]); B[3] = Math.max(B[3], b[3]);
    });
    // 留边，避免贴边
    var padX = (B[2] - B[0]) * 0.08, padY = (B[3] - B[1]) * 0.08;
    var VB = [B[0] - padX, B[1] - padY, B[2] + padX, B[3] + padY];

    // 省界（若有省界数据则画，否则只画县点）
    var GP = window.__GEO_PROV__;
    if (GP && GP.provinces) {
      var provs = {};
      codes.forEach(function (c) { provs[S.agg[c].p] = 1; });
      GP.provinces.forEach(function (p) {
        if (!provs[p.n]) return;
        m.area('base', p, {
          fill: 'rgba(120,160,220,.05)',
          stroke: 'rgba(200,220,255,.35)', strokeWidth: 1.4
        });
      });
    }

    // 县：真实县界若已加载则填色，否则画落点方块
    var maxPrem = 0;
    codes.forEach(function (c) { maxPrem = Math.max(maxPrem, S.agg[c].prem); });

    var drawn = 0;
    codes.forEach(function (c) {
      var a = S.agg[c];
      var t = maxPrem ? Math.sqrt(a.prem / maxPrem) : 0;
      var col = rampColor(t);
      var feat = countyGeom(c);
      if (feat) {
        // ⚠️ area() 的拾取属性（c / kind）取自【要素对象】，
        //    不是 style —— 放错位置会导致面画得出来但点不动。
        feat.c = c; feat.kind = 'uw-county';
        m.area('uw', feat, {
          fill: 'rgba(' + col + ',' + (0.22 + t * 0.5).toFixed(2) + ')',
          stroke: 'rgba(12,22,38,.85)', strokeWidth: 1.2
        });
        drawn++;
      } else {
        m.area('uw', { n: a.n, c: c, kind: 'uw-county', r: [[
          [a.x - 6000, a.y - 6000], [a.x + 6000, a.y - 6000],
          [a.x + 6000, a.y + 6000], [a.x - 6000, a.y + 6000], [a.x - 6000, a.y - 6000]
        ]], b: [0, 0] }, {
          fill: 'rgba(' + col + ',' + (0.35 + t * 0.45).toFixed(2) + ')',
          stroke: 'rgba(12,22,38,.8)', strokeWidth: 1
        });
        drawn++;
      }
      // 县名 + 保费标签
      var p = m.toPx(a.x, a.y);
      var lb = m.pxLabel('lab', p.x, p.y - 16, a.n, {
        fill: '#ffffff', size: 12, halo: 'rgba(4,10,20,.95)', weight: 700
      });
      m.anchor(lb, a.x, a.y, -16);
      var pv = m.pxLabel('lab', p.x, p.y + 12, (a.prem / 1e4).toFixed(1) + '万', {
        fill: '#a5f3fc', size: 11, halo: 'rgba(4,10,20,.95)'
      });
      m.anchor(pv, a.x, a.y, 12);
    });

    // 有精确坐标的保单点
    var pts = S.records.filter(function (r) { return r.hasXY; });
    if (pts.length && pts.length <= 3000) {
      pts.forEach(function (r) {
        m.dot('uw', r.x, r.y, 2.6, {
          fill: '#fde68a', stroke: 'rgba(8,14,26,.9)', sw: 1
        }, { kind: 'uw-point', id: r.code, title: r.holder });
      });
    }

    m.fit(VB);
    // 底图瓦片要在 fit 之后再建，否则用的是 fit 之前的视图位置
    if (window.__UW_ESRI__) { try { window.__UW_ESRI__.build(m); } catch (e) { } }
    $('#uw-mapinfo').textContent = '承保 ' + fmt(S.records.length, 0) + ' 笔 · ' +
      codes.length + ' 县 · 县界已绘 ' + drawn + ' · 精确点 ' + pts.length;
  }

  function rampColor(t) {
    t = Math.max(0, Math.min(1, t));
    var stops = [[56, 189, 248], [45, 212, 191], [250, 204, 21], [251, 113, 133]];
    var i = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
    var f = t * (stops.length - 1) - i;
    var a = stops[i], b = stops[i + 1];
    return [
      Math.round(a[0] + (b[0] - a[0]) * f),
      Math.round(a[1] + (b[1] - a[1]) * f),
      Math.round(a[2] + (b[2] - a[2]) * f)
    ].join(',');
  }

  function showCounty(a) {
    var top = Object.keys(a.crops).sort(function (x, y) { return a.crops[y] - a.crops[x]; }).slice(0, 8);
    var towns = Object.keys(a.towns).sort(function (x, y) { return a.towns[y] - a.towns[x]; }).slice(0, 10);
    var d = $('#detail');
    $('#dt-title').textContent = a.n;
    $('#dt-sub').textContent = a.p + ' · 我司承保';
    $('#dt-body').innerHTML =
      '<div class="kpis" style="grid-template-columns:repeat(2,1fr);margin-bottom:12px">' +
      kcard('保单数', fmt(a.cnt, 0), '笔', '', '#3b82f6') +
      kcard('保费', (a.prem / 1e4).toFixed(2), '万元', '', '#34d399') +
      kcard('承保面积', (a.area / 1e4).toFixed(3), '万亩', '', '#ffd35a') +
      kcard('保额', (a.amount / 1e4).toFixed(1), '万元', '', '#fb923c') +
      '</div>' +
      (top.length ? '<div class="sec" style="padding:0 0 8px;border:none"><div class="sec-h"><div class="sec-t">作物构成</div></div>' +
        top.map(function (c) { return '<div class="row-m" style="padding:3px 0"><span>' + esc(c) + '</span><b>' + a.crops[c] + ' 笔</b></div>'; }).join('') + '</div>' : '') +
      (towns.length ? '<div class="sec" style="padding:0;border:none"><div class="sec-h"><div class="sec-t">乡镇分布 Top 10</div></div>' +
        towns.map(function (t) {
          return '<div class="hbar"><div class="hbar-n">' + esc(t) + '</div>' +
            '<div class="hbar-t"><i style="width:' + (a.towns[t] / a.towns[towns[0]] * 100).toFixed(0) +
            '%;background:linear-gradient(90deg,#34d399,#22d3ee)"></i></div>' +
            '<div class="hbar-v">' + a.towns[t] + '</div></div>';
        }).join('') + '</div>' : '');
    d.classList.add('on');
  }

  /* ============================================================
     初始化
     ============================================================ */
  function init() {
    // 进入视图即预取县级索引（约 240KB），让用户拖入文件后能立即出图，
    // 而不是等解析完成再等索引。首屏不加载，不影响打开速度。
    loadRef();
    if (S.inited) { drawMap(); return; }
    S.inited = true;
    bindUpload();

    var btn = $('#uw-go');
    if (btn) btn.addEventListener('click', function () { S.loaded = true; buildRecords(); });

    var ex = $('#uw-export');
    if (ex) ex.addEventListener('click', exportCSV);

    var sv = $('#uw-save');
    if (sv) sv.addEventListener('click', function () {
      if (!S.records.length) return;
      var ok = saveLocal();
      sv.textContent = ok ? '✅ 已留存本机' : '❌ 留存失败';
      setTimeout(function () { sv.textContent = '留存到本机'; }, 2200);
    });

    var cl = $('#uw-clear');
    if (cl) cl.addEventListener('click', function () {
      clearLocal();
      S.records = []; S.agg = {}; S.bad = []; S.loaded = false;
      renderEmpty(); setStep(1);
      if (window.__UW_MAP__) { window.__UW_MAP__.clear('base'); window.__UW_MAP__.clear('uw'); window.__UW_MAP__.clear('lab'); }
      var st = $('#uw-status');
      st.className = 'uw-status'; st.textContent = '已清除本机留存数据';
    });

    // 恢复本机留存：依赖县级索引做落点，故等索引到位后再恢复
    if (hasLocal()) {
      loadRef().then(function () {
        if (!loadLocal()) return;
        var st2 = $('#uw-status');
        st2.className = 'uw-status ok';
        st2.textContent = '已从本机恢复上次上传的承保数据（' + fmt(S.records.length, 0) + ' 条）';
        setStep(3);
        drawMap();
      });
    }

    initMap();
    setTimeout(drawMap, 60);
  }

  window.addEventListener('resize', function () {
    if (window.__UW_MAP__) {
      window.__UW_MAP__.resize();
      if (window.__UW_ESRI__) { try { window.__UW_ESRI__.build(window.__UW_MAP__); } catch (e) { } }
    }
  });

  window.__UW_VIEW__ = { init: init, draw: drawMap, state: S, exportCSV: exportCSV };
})();
