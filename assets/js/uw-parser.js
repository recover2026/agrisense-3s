/* ============================================================
   承保信息本地解析引擎（承保信息视图依赖）
   ------------------------------------------------------------
   设计红线：承保信息含被保险人身份与保单明细，属敏感数据。
   本模块全部在浏览器内存中完成解析 —— 不发起任何网络请求、
   不写入任何服务器。文件不离开使用者本机。

   支持格式：
     · .xlsx  —— ZIP + XML，用浏览器原生 DecompressionStream 解压，零第三方库
     · .csv   —— 自动识别 UTF-8 / GBK(GB18030) 编码
     · .txt   —— 同 CSV（制表符分隔也一并支持）

   导出：window.__UW_PARSE__ = { readFile, parseCSV, parseXLSX, detect, SHEETS }
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 通用工具 ---------- */
  function isNum(v) {
    if (v === '' || v === null || v === undefined) return false;
    return /^-?\d+(\.\d+)?$/.test(String(v).replace(/[,\s￥¥]/g, ''));
  }
  function num(v) {
    if (v === '' || v === null || v === undefined) return null;
    var s = String(v).replace(/[,\s￥¥]/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(s)) {
      // 允许 "1.2万" "3亩" 这类写法
      var m = s.match(/^(-?\d+(?:\.\d+)?)\s*(万|千|百)?/);
      if (!m) return null;
      var mul = m[2] === '万' ? 1e4 : m[2] === '千' ? 1e3 : m[2] === '百' ? 1e2 : 1;
      return parseFloat(m[1]) * mul;
    }
    return parseFloat(s);
  }
  // Excel 序列日期 → 'YYYY-MM-DD'
  function serial2date(s) {
    var n = Number(s);
    if (!isFinite(n) || n < 20000 || n > 60000) return String(s == null ? '' : s);
    // Excel 起点 1899-12-30（兼容 1900 闰年 bug）
    var ms = Math.round((n - 25569) * 86400 * 1000);
    var d = new Date(ms);
    if (isNaN(d.getTime())) return String(s);
    var p = function (x) { return x < 10 ? '0' + x : '' + x; };
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
  }

  /* ---------- ZIP 读取（xlsx 容器） ----------
     xlsx = ZIP。ZIP 记录顺序可能与中央目录顺序不同，且使用相对偏移，
     所以必须解析「中央目录」拿到每个条目的真实偏移，不能顺序扫。      */
  function readZip(buf) {
    var dv = new DataView(buf), u8 = new Uint8Array(buf);
    // 找 EOCD（End of Central Directory），从尾部反向搜签名 0x06054b50
    var eocd = -1;
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 xlsx（未找到 ZIP 结束标记）');

    var count = dv.getUint16(eocd + 10, true);
    var cdOff = dv.getUint32(eocd + 16, true);

    // ZIP64：条目数或偏移为 0xFFFF/0xFFFFFFFF 时读 ZIP64 记录
    if (count === 0xFFFF || cdOff === 0xFFFFFFFF) {
      for (var j = eocd - 20; j >= 0; j--) {
        if (dv.getUint32(j, true) === 0x07064b50) {
          var z64 = Number(dv.getBigUint64(j + 8, true));
          if (dv.getUint32(z64, true) === 0x06064b50) {
            count = Number(dv.getBigUint64(z64 + 32, true));
            cdOff = Number(dv.getBigUint64(z64 + 48, true));
          }
          break;
        }
      }
    }

    var files = {}, p = cdOff;
    var dec = new TextDecoder('utf-8');
    for (var k = 0; k < count; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      var method = dv.getUint16(p + 10, true);
      var csize = dv.getUint32(p + 20, true);
      var usize = dv.getUint32(p + 24, true);
      var nlen = dv.getUint16(p + 28, true);
      var elen = dv.getUint16(p + 30, true);
      var clen = dv.getUint16(p + 32, true);
      var lho = dv.getUint32(p + 42, true);
      var name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      if (csize === 0xFFFFFFFF || usize === 0xFFFFFFFF || lho === 0xFFFFFFFF) {
        // ZIP64 扩展字段（0x0001）
        var ep = p + 46 + nlen, eEnd = ep + elen;
        while (ep + 4 <= eEnd) {
          var hid = dv.getUint16(ep, true), hsz = dv.getUint16(ep + 2, true);
          if (hid === 0x0001) {
            var q = ep + 4;
            if (usize === 0xFFFFFFFF) { usize = Number(dv.getBigUint64(q, true)); q += 8; }
            if (csize === 0xFFFFFFFF) { csize = Number(dv.getBigUint64(q, true)); q += 8; }
            if (lho === 0xFFFFFFFF) { lho = Number(dv.getBigUint64(q, true)); q += 8; }
            break;
          }
          ep += 4 + hsz;
        }
      }
      files[name] = { method: method, csize: csize, usize: usize, lho: lho };
      p += 46 + nlen + elen + clen;
    }
    return { dv: dv, u8: u8, files: files };
  }

  function zipText(zip, name) {
    var e = zip.files[name];
    if (!e) return null;
    var dv = zip.dv, u8 = zip.u8;
    if (dv.getUint32(e.lho, true) !== 0x04034b50) throw new Error('ZIP 局部头损坏: ' + name);
    var nlen = dv.getUint16(e.lho + 26, true);
    var elen = dv.getUint16(e.lho + 28, true);
    var start = e.lho + 30 + nlen + elen;
    var raw = u8.subarray(start, start + e.csize);
    if (e.method === 0) return new TextDecoder('utf-8').decode(raw);
    if (e.method !== 8) throw new Error('不支持的压缩方式 ' + e.method + '（' + name + '）');
    // DEFLATE：浏览器原生解压器
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([raw]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (ab) {
      return new TextDecoder('utf-8').decode(ab);
    });
  }

  function zipAll(zip, name) {
    var e = zip.files[name];
    if (!e) return Promise.resolve(null);
    var dv = zip.dv, u8 = zip.u8;
    if (dv.getUint32(e.lho, true) !== 0x04034b50) return Promise.resolve(null);
    var nlen = dv.getUint16(e.lho + 26, true);
    var elen = dv.getUint16(e.lho + 28, true);
    var start = e.lho + 30 + nlen + elen;
    var raw = u8.subarray(start, start + e.csize);
    if (e.method === 0) return Promise.resolve(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    var ds = new DecompressionStream('deflate-raw');
    return new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer();
  }

  /* ---------- XML 工具 ---------- */
  function parseXML(text) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    var err = doc.querySelector('parsererror');
    if (err) throw new Error('XML 解析失败: ' + (err.textContent || '').slice(0, 120));
    return doc;
  }
  // 取第一个匹配标签的文本（含富文本 run 拼接）
  function txt(node) {
    if (!node) return '';
    var ts = node.getElementsByTagName('t');
    if (ts.length) {
      var s = '';
      for (var i = 0; i < ts.length; i++) s += ts[i].textContent;
      return s;
    }
    return node.textContent || '';
  }
  // "BC12" → 索引；无列字母则按出现顺序
  function colIdx(ref) {
    var m = String(ref).match(/^([A-Z]+)/);
    if (!m) return -1;
    var s = m[1], n = 0;
    for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n - 1;
  }

  /* ---------- 解析 xlsx ---------- */
  function parseXLSX(buf) {
    var zip = readZip(buf);
    return Promise.all([
      zipText(zip, 'xl/sharedStrings.xml'),
      zipText(zip, 'xl/workbook.xml'),
      zipText(zip, 'xl/styles.xml')
    ]).then(function (r) {
      var sstTxt = r[0], wbTxt = r[1], stTxt = r[2];

      // 共享字符串表
      var sst = [];
      if (sstTxt) {
        var sd = parseXML(sstTxt);
        var sis = sd.getElementsByTagName('si');
        for (var i = 0; i < sis.length; i++) sst.push(txt(sis[i]));
      }

      // 日期格式：读 styles.xml 的 numFmt / cellXfs，标记哪些样式是日期
      var dateStyles = {};
      if (stTxt) {
        try {
          var st = parseXML(stTxt);
          var custom = {};
          var nfs = st.getElementsByTagName('numFmt');
          for (var a = 0; a < nfs.length; a++) {
            custom[nfs[a].getAttribute('numFmtId')] = nfs[a].getAttribute('formatCode') || '';
          }
          var xfsNode = st.getElementsByTagName('cellXfs')[0];
          if (xfsNode) {
            var xfs = xfsNode.getElementsByTagName('xf');
            for (var b = 0; b < xfs.length; b++) {
              var id = xfs[b].getAttribute('numFmtId') || '0';
              var code = custom[id];
              var builtin = /^1[4-9]$|^2[0-2]$|^4[5-7]$/.test(id); // 内置日期格式
              if (builtin || (code && /[ymdhs]/i.test(code) && !/[#0]/.test(code.replace(/[^ymdhs]/gi, '')))) {
                dateStyles[b] = true;
              }
            }
          }
        } catch (e) { /* 样式解析失败则日期按原样输出，不影响主流程 */ }
      }

      // 工作表清单：workbook.xml 给出顺序与 rId，rels 给出 rId -> 实际路径
      if (!wbTxt) return [];
      var wb = parseXML(wbTxt);
      return zipText(zip, 'xl/_rels/workbook.xml.rels').then(function (relTxt) {
        var relMap = {};
        if (relTxt) {
          var rd = parseXML(relTxt);
          var rs = rd.getElementsByTagName('Relationship');
          for (var i = 0; i < rs.length; i++) {
            relMap[rs[i].getAttribute('Id')] = rs[i].getAttribute('Target');
          }
        }
        var shs = wb.getElementsByTagName('sheet');
        var jobs = [];
        for (var s = 0; s < shs.length; s++) {
          var sh = shs[s];
          // r:id 带命名空间前缀，部分生成器写成 id
          var rid = sh.getAttribute('r:id') || sh.getAttribute('id');
          var name = sh.getAttribute('name') || ('Sheet' + (s + 1));
          var tgt = relMap[rid] || ('worksheets/sheet' + (s + 1) + '.xml');
          // Target 可能是 /xl/worksheets/… 或 worksheets/… 或 ../worksheets/…
          var path = 'xl/' + String(tgt).replace(/^\/?xl\//, '').replace(/^\//, '').replace(/^\.\.\//, '');
          jobs.push(zipText(zip, path).then(function (t) {
            return { name: name, text: t };
          }, function () {
            return { name: name, text: null };
          }));
        }
        return Promise.all(jobs).then(function (list) {
          return list.map(function (it) {
            return { name: it.name, rows: it.text ? sheetRows(it.text, sst, dateStyles) : [] };
          });
        });
      });
    });
  }

  // 单个工作表 → 二维数组（已把共享字符串、日期、内联字符串都转成文本）
  function sheetRows(text, sst, dateStyles) {
    var doc = parseXML(text);
    var rows = [];
    var rowNodes = doc.getElementsByTagName('row');
    for (var i = 0; i < rowNodes.length; i++) {
      var rn = rowNodes[i];
      var arr = [];
      var cells = rn.getElementsByTagName('c');
      var auto = 0;
      for (var j = 0; j < cells.length; j++) {
        var c = cells[j];
        var ci = colIdx(c.getAttribute('r') || '');
        if (ci < 0) ci = auto;
        auto = ci + 1;
        var t = c.getAttribute('t') || 'n';
        var v = '';
        var sIdx = c.getAttribute('s');
        var isDate = sIdx != null && dateStyles[+sIdx];
        if (t === 's') {
          var vn = c.getElementsByTagName('v')[0];
          var idx = vn ? parseInt(vn.textContent, 10) : -1;
          v = (idx >= 0 && idx < sst.length) ? sst[idx] : '';
        } else if (t === 'inlineStr') {
          v = txt(c.getElementsByTagName('is')[0]);
        } else {
          var vv = c.getElementsByTagName('v')[0];
          var raw = vv ? vv.textContent : '';
          if (raw === '') {
            // 公式单元格可能只有 <f>，取缓存值缺失时留空
            v = '';
          } else if (isDate) {
            v = serial2date(raw);
          } else {
            v = raw;
            // 纯数字去掉多余的 .0
            if (/^-?\d+\.0+$/.test(v)) v = v.replace(/\.0+$/, '');
          }
        }
        arr[ci] = v == null ? '' : String(v).trim();
      }
      rows.push(arr);
    }
    return rows;
  }

  /* ---------- 编码识别 + CSV 解析 ----------
     ⚠️ 实战坑：Excel 导出的 CSV 常见「开头是 UTF-8 BOM，正文却是 GBK」
        （BOM 是模板带的，没跟着编码一起改）。若一见 BOM 就无脑按 UTF-8
        解，整张表全是乱码，且肉眼看不出来。
        因此 BOM 只作为「候选」：仍要用 fatal 模式验证正文能否按 UTF-8 解，
        解不了再回退 GBK。 */
  function decodeSmart(buf) {
    var u8 = new Uint8Array(buf);
    var bomLen = 0, bomEnc = '';
    if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) { bomLen = 3; bomEnc = 'UTF-8'; }
    else if (u8[0] === 0xFF && u8[1] === 0xFE) { bomLen = 2; bomEnc = 'UTF-16LE'; return { text: new TextDecoder('utf-16le').decode(u8.subarray(2)), enc: 'UTF-16LE' }; }
    else if (u8[0] === 0xFE && u8[1] === 0xFF) { bomLen = 2; bomEnc = 'UTF-16BE'; return { text: new TextDecoder('utf-16be').decode(u8.subarray(2)), enc: 'UTF-16BE' }; }

    var body = u8.subarray(bomLen);
    // 先严格试 UTF-8（含 BOM 情形）：解得下就是 UTF-8
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), enc: bomEnc ? bomEnc + ' BOM' : 'UTF-8' };
    } catch (e) { /* 继续尝试 GBK */ }
    // 回退 GBK（GB18030 兼容 superset，能多解生僻字）
    try {
      return { text: new TextDecoder('gbk').decode(body), enc: bomEnc ? 'GBK（含 UTF-8 BOM）' : 'GBK' };
    } catch (e2) {
      return { text: new TextDecoder('utf-8').decode(body), enc: 'UTF-8(宽松)' };
    }
  }

  // 支持引号包裹、转义双引号、字段内换行
  function splitCSV(text, delim) {
    var rows = [], row = [], cur = '', q = false, i = 0;
    while (i < text.length) {
      var ch = text[i];
      if (q) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cur += '"'; i += 2; continue; }
          q = false; i++; continue;
        }
        cur += ch; i++; continue;
      }
      if (ch === '"') { q = true; i++; continue; }
      if (ch === delim) { row.push(cur); cur = ''; i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; i++; continue; }
      cur += ch; i++;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.map(function (r) {
      return r.map(function (c) { return c.trim(); });
    }).filter(function (r) {
      return r.some(function (c) { return c !== ''; });
    });
  }

  function parseCSV(buf) {
    var d = decodeSmart(buf);
    // 分隔符自动判断：统计首行各候选符号出现次数
    var firstLine = (d.text.split(/\r?\n/)[0] || '');
    var cands = [',', '\t', ';', '|'];
    var best = ',', bestN = -1;
    cands.forEach(function (c) {
      var n = firstLine.split(c).length - 1;
      if (n > bestN) { bestN = n; best = c; }
    });
    var rows = splitCSV(d.text, best);
    return { sheets: [{ name: 'CSV', rows: rows }], enc: d.enc, delim: best };
  }

  /* ---------- 表头定位：跳过前导说明行 ----------
     承保台账常带「XX分公司2026年承保明细」这类标题行，
     真正的表头在第 2~5 行。策略：取前 8 行，找"非空单元格最多且像表头"的那行。*/
  function findHeader(rows) {
    var bestI = 0, bestScore = -1;
    var lim = Math.min(rows.length, 8);
    for (var i = 0; i < lim; i++) {
      var r = rows[i] || [];
      var fill = r.filter(function (c) { return c !== ''; }).length;
      if (fill < 2) continue;
      // 表头特征：无长数字、单元格短、含文字
      var textish = r.filter(function (c) {
        return c !== '' && c.length <= 20 && !/^-?\d{4,}(\.\d+)?$/.test(c);
      }).length;
      var score = fill * 2 + textish;
      if (score > bestScore) { bestScore = score; bestI = i; }
    }
    return { index: bestI, header: rows[bestI] || [] };
  }

  /* ---------- 读取文件（总入口） ---------- */
  function readFile(file) {
    return file.arrayBuffer().then(function (buf) {
      var name = (file.name || '').toLowerCase();
      if (/\.xlsx$/.test(name) || (buf[0] === 0x50 && buf[1] === 0x4B)) {
        return parseXLSX(buf).then(function (sheets) {
          return { kind: 'xlsx', sheets: sheets, buf: buf };
        });
      }
      if (/\.xls$/.test(name)) {
        throw new Error('旧版 .xls 格式暂不支持，请在 Excel 中另存为 .xlsx 或 CSV 后再上传');
      }
      var r = parseCSV(buf);
      return { kind: 'csv', sheets: r.sheets, enc: r.enc, delim: r.delim, buf: buf };
    });
  }

  global.__UW_PARSE__ = {
    readFile: readFile,
    parseXLSX: parseXLSX,
    parseCSV: parseCSV,
    decodeSmart: decodeSmart,
    findHeader: findHeader,
    num: num,
    isNum: isNum,
    serial2date: serial2date,
    _zipText: zipText
  };
})(window);
