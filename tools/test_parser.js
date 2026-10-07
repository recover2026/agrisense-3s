/* 解析引擎单测：在真实浏览器里跑，覆盖 xlsx/CSV、编码、表头定位、日期 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = '/Users/recover/WorkBuddy/2026-10-06-12-40-38/农险3S遥感地图平台-官网';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await page.goto('file://' + ROOT + '/index.html');
  await page.waitForFunction(() => !!window.__UW_PARSE__, { timeout: 15000 });

  // ---- 1. xlsx 解析 ----
  const xlsxB64 = fs.readFileSync('/tmp/uwtest/承保台账_测试.xlsx').toString('base64');
  const r = await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const buf = u8.buffer;
    const out = await window.__UW_PARSE__.parseXLSX(buf);
    const sh = out[0];
    const hd = window.__UW_PARSE__.findHeader(sh.rows);
    return {
      sheetNames: out.map(s => s.name),
      rowCount: sh.rows.length,
      headerIndex: hd.index,
      header: hd.header,
      firstData: sh.rows[hd.index + 1],
      secondData: sh.rows[hd.index + 2],
      commaRow: sh.rows.filter(x => (x[1] || '').indexOf(',') >= 0)[0],
      lastNonEmpty: sh.rows.filter(x => x.some(c => c !== '')).length
    };
  }, xlsxB64);

  console.log('=== 1. XLSX 解析 ===');
  console.log('工作表:', r.sheetNames.join(','));
  console.log('行数(含表头前导):', r.rowCount, '| 表头行索引:', r.headerIndex, '(应为 3)');
  console.log('表头:', r.header.join(' | '));
  console.log('首条数据:', JSON.stringify(r.firstData));
  console.log('含逗号姓名行:', JSON.stringify(r.commaRow));
  console.log('非空行数:', r.lastNonEmpty, '(应为 3 前导 + 1 表头 + 16 数据 = 20)');

  const checks = [];
  checks.push(['表头定位跳过前导说明行', r.headerIndex === 3]);
  checks.push(['表头首列=保单号', r.header[0] === '保单号']);
  checks.push(['中文共享字符串还原', r.header[3] === '作物']);
  checks.push(['内联字符串还原(保单号)', r.firstData[0] === 'PD20264200001']);
  checks.push(['数字未带 .0', r.firstData[4] === '850.5' && String(r.firstData[5]) === '680000']);
  checks.push(['日期序列→YYYY-MM-DD', r.firstData[12] === '2026-01-05']);
  checks.push(['含逗号/引号字段未被切断', (r.commaRow[1] || '').indexOf('张,建国') >= 0]);
  checks.push(['尾部空行已过滤', r.lastNonEmpty === 20]);

  // ---- 2. CSV 编码 ----
  const csvGbk = Buffer.from(
    '保单号,被保险人,县,承保面积(亩),保费(元),起保日期\n' +
    'PD001,张三,黄梅县,"1,200",5678,2026-01-05\n' +
    'PD002,李四,英山县,1.2万,8900,2026-02-15\n', 'latin1');
  // 用 iconv 手工转 GBK 不可得，这里改测 UTF-8 + BOM + 分隔符识别
  const csvU8 = Buffer.from(
    '保单号,被保险人,县,承保面积(亩)\nPD001,张三,黄梅县,"1,200"\nPD002,李四,英山县,300\n', 'utf8');
  const csvBom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), csvU8]);

  const cr = await page.evaluate(async (pair) => {
    function toBuf(u8) { return u8.buffer; }
    const a = window.__UW_PARSE__.parseCSV(toBuf(new Uint8Array(pair[0])));
    const b = window.__UW_PARSE__.parseCSV(toBuf(new Uint8Array(pair[1])));
    return {
      a: { enc: a.enc, delim: a.delim, rows: a.sheets[0].rows },
      b: { enc: b.enc, delim: b.delim, rows: b.sheets[0].rows }
    };
  }, [Array.from(csvU8), Array.from(csvBom)]);

  console.log('\n=== 2. CSV 解析 ===');
  console.log('UTF-8 无BOM:', cr.a.enc, '分隔符', JSON.stringify(cr.a.delim), '行数', cr.a.rows.length);
  console.log('  含千分位行:', JSON.stringify(cr.a.rows[1]));
  console.log('UTF-8 BOM:', cr.b.enc, '首格', JSON.stringify(cr.b.rows[0][0]));

  checks.push(['CSV 千分位引号字段完整', cr.a.rows[1][3] === '1,200']);
  checks.push(['CSV "1.2万" 保留原文', cr.a.rows[2][3] === '1.2万']);
  checks.push(['CSV BOM 已剥离', cr.b.rows[0][0] === '保单号' && cr.b.enc.indexOf('BOM') >= 0]);

  // ---- 3. 数字解析器 ----
  const nr = await page.evaluate(() => {
    const p = window.__UW_PARSE__;
    return {
      wan: p.num('1.2万'), thou: p.num('1,200'), yuan: p.num('￥680000'),
      mu: p.num('850.5亩'), empty: p.num(''), bad: p.num('abc'),
      ser: p.serial2date('46027')
    };
  });
  console.log('\n=== 3. 数值解析 ===');
  console.log(JSON.stringify(nr));
  checks.push(['"1.2万"→12000', nr.wan === 12000]);
  checks.push(['"1,200"→1200', nr.thou === 1200]);
  checks.push(['"￥680000"→680000', nr.yuan === 680000]);
  checks.push(['空值→null', nr.empty === null && nr.bad === null]);

  // ---- 4. 县名索引可用性 ----
  const cr2 = await page.evaluate(() => {
    const R = window.__COUNTY_REF__ || {};
    const keys = Object.keys(R);
    const hm = R['420222'], yx = R['420623'], jl = R['420223'];
    return {
      n: keys.length,
      黄梅: hm && hm.n, 黄梅x: hm && hm.x, 黄梅p: hm && hm.p,
      英山: yx && yx.n, 监利: jl && jl.n,
      坐标合理: hm && yx && jl && [hm, yx, jl].every(v => v.x > 11e6 && v.x < 13.6e6 && v.y > 1.8e6 && v.y < 6e6)
    };
  });
  console.log('\n=== 4. 县级参照索引 ===');
  console.log(JSON.stringify(cr2));
  checks.push(['索引已加载且有 1700+ 县', cr2.n > 1700]);
  checks.push(['黄梅县/英山县/监利县均可查到', cr2.黄梅 === '黄梅县' && cr2.英山 === '英山县' && cr2.监利 === '监利县']);
  checks.push(['落点坐标在中国境内', cr2.坐标合理 === true]);

  console.log('\n=== 断言结果 ===');
  let pass = 0;
  checks.forEach(([name, ok]) => { console.log((ok ? '  ✅ ' : '  ❌ ') + name); if (ok) pass++; });
  console.log('\n通过 ' + pass + '/' + checks.length);
  if (errs.length) { console.log('\n页面错误:'); errs.slice(0, 10).forEach(e => console.log('  ' + e)); }

  await browser.close();
  process.exit(pass === checks.length && errs.length === 0 ? 0 : 1);
})();
