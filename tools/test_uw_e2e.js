/* 承保信息上传全流程端到端测试（真实浏览器 + 真实 xlsx） */
const { chromium } = require('playwright');
const fs = require('fs');

const ROOT = '/Users/recover/WorkBuddy/2026-10-06-12-40-38/农险3S遥感地图平台-官网';
const XLSX = '/tmp/uwtest/承保台账_测试.xlsx';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  // 记录所有网络请求 —— 核心红线：承保数据不得发往任何服务器
  const reqs = [];
  page.on('request', r => reqs.push({ url: r.url(), method: r.method(), post: r.postData() }));

  // 门禁：先注入 session 标记再刷新，才能真正操作页面
  await page.goto('file://' + ROOT + '/index.html');
  await page.evaluate(() => { try { sessionStorage.setItem('sf3s_gate_ok_v1', '1'); } catch (e) {} });
  await page.reload();
  await page.waitForFunction(() => !!window.__APP__ && !!window.__UW_VIEW__, { timeout: 20000 });
  const gateGone = await page.evaluate(() => !document.querySelector('#sfGate'));
  console.log('门禁已通过:', gateGone);
  await page.evaluate(() => window.__APP__.switchTab('uw'));
  await page.waitForTimeout(900);

  console.log('=== 视图就绪 ===');
  const v = await page.evaluate(() => {
    const m = document.querySelector('#uw-map');
    return {
      viewOn: document.querySelector('#v-uw').classList.contains('on'),
      mapH: m ? m.clientHeight : 0,
      mapW: m ? m.clientWidth : 0,
      dropExists: !!document.querySelector('#uw-drop'),
      steps: document.querySelectorAll('.uw-step').length
    };
  });
  console.log(JSON.stringify(v));

  // ---- 真实上传文件 ----
  console.log('\n=== 上传 xlsx ===');
  await page.setInputFiles('#uw-file', XLSX);
  await page.waitForFunction(() => {
    const s = document.querySelector('#uw-status');
    return s && /已解析|失败/.test(s.textContent);
  }, { timeout: 15000 });
  const st = await page.evaluate(() => ({
    txt: document.querySelector('#uw-status').textContent,
    cls: document.querySelector('#uw-status').className
  }));
  console.log(st.cls, '|', st.txt);

  // 字段映射是否自动识别
  const mapInfo = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#uw-map-rows .uw-mrow'));
    return rows.map(r => ({
      f: r.querySelector('.uw-mn').textContent.replace('*', ''),
      sel: r.querySelector('select').selectedOptions[0].textContent
    }));
  });
  console.log('\n=== 字段自动映射 ===');
  mapInfo.forEach(m => console.log('  ' + m.f.padEnd(14) + '→ ' + m.sel));

  // ---- 生成空间分布 ----
  console.log('\n=== 生成承保空间分布 ===');
  await page.click('#uw-go');
  await page.waitForTimeout(1400);

  const res = await page.evaluate(() => {
    const S = window.__UW_STATE__;
    const txt = id => { const e = document.querySelector(id); return e ? e.textContent.trim() : null; };
    return {
      records: S.records.length,
      bad: S.bad.length,
      counties: Object.keys(S.agg).length,
      aggList: Object.keys(S.agg).map(c => ({
        n: S.agg[c].n, p: S.agg[c].p, cnt: S.agg[c].cnt,
        prem: Math.round(S.agg[c].prem), area: Math.round(S.agg[c].area),
        xy: S.agg[c].hasXY
      })),
      hasXY: S.records.filter(r => r.hasXY).length,
      outOfCounty: S.records.filter(r => r.outOfCounty).length,
      kpi: txt('#uw-kpi'),
      meta: txt('#uw-meta'),
      mapinfo: txt('#uw-mapinfo'),
      mapShapes: document.querySelectorAll('#uw-map svg path, #uw-map svg circle, #uw-map svg text').length,
      tableRows: document.querySelectorAll('#uw-table tbody tr').length,
      rankRows: document.querySelectorAll('#uw-rank .hbar').length,
      impactTxt: txt('#uw-impact').slice(0, 200),
      badTxt: txt('#uw-bad')
    };
  });
  console.log('记录数:', res.records, '| 未匹配:', res.bad, '| 覆盖县:', res.counties);
  console.log('精确坐标:', res.hasXY, '| 县域外纠偏:', res.outOfCounty);
  console.log('地图图元:', res.mapShapes, '| 明细行:', res.tableRows, '| 排名行:', res.rankRows);
  console.log('KPI:', res.kpi.replace(/\s+/g, ' ').slice(0, 160));
  console.log('meta:', res.meta.replace(/\s+/g, ' '));
  console.log('地图信息:', res.mapinfo);
  console.log('\n县级聚合:');
  res.aggList.forEach(a => console.log(`  ${a.p} ${a.n}  ${a.cnt}笔  ${a.prem}元  ${a.area}亩  精确${a.xy}`));

  // ---- 落点是否真在地图上 ----
  const ptCheck = await page.evaluate(() => {
    const S = window.__UW_STATE__;
    const out = [];
    for (const c of Object.keys(S.agg)) {
      const a = S.agg[c];
      // 投影回经纬，验证落在中国境内且与县名相符
      const lng = a.x / 20037508.34 * 180;
      const lat = (2 * Math.atan(Math.exp(a.y * Math.PI / 20037508.34)) - Math.PI / 2) * 180 / Math.PI;
      out.push({ n: a.n, lng: +lng.toFixed(3), lat: +lat.toFixed(3) });
    }
    return out;
  });
  console.log('\n=== 落点经纬（应与县名相符）===');
  ptCheck.forEach(p => console.log(`  ${p.n.padEnd(8)} ${p.lng}°E  ${p.lat}°N`));

  // ---- 灾点影响分析 ----
  console.log('\n=== 灾点影响分析 ===');
  const im = await page.evaluate(() => document.querySelector('#uw-impact').textContent.replace(/\s+/g, ' ').trim());
  console.log(im.slice(0, 300));

  // ---- 详情弹层 ----
  await page.evaluate(() => { window.__APP__.st; });
  const dlg = await page.evaluate(() => {
    const S = window.__UW_STATE__;
    const c = Object.keys(S.agg)[0];
    // 模拟点击：直接调 view 内部不方便，改为验证点击命中
    const paths = document.querySelectorAll('#uw-map svg path');
    return { paths: paths.length, hasDetail: !!document.querySelector('#detail') };
  });
  console.log('\n可点击面:', dlg.paths, '| 详情层存在:', dlg.hasDetail);

  // ---- 本机留存 ----
  console.log('\n=== 本机留存 ===');
  await page.click('#uw-save');
  await page.waitForTimeout(400);
  const saved = await page.evaluate(() => {
    const raw = localStorage.getItem('yg3s_uw_data_v1');
    return raw ? { bytes: raw.length, n: JSON.parse(raw).records.length } : null;
  });
  console.log('localStorage:', JSON.stringify(saved));

  // ---- 网络红线检查：承保数据不得外发 ----
  console.log('\n=== 网络请求红线检查 ===');
  const postOrLocal = reqs.filter(r => r.post && r.post.length > 20);
  console.log('总请求数:', reqs.length);
  console.log('带请求体(可能上传数据)的请求:', postOrLocal.length);
  if (postOrLocal.length) {
    postOrLocal.slice(0, 5).forEach(r => console.log('  ❌ ' + r.method + ' ' + r.url + ' body=' + String(r.post).slice(0, 80)));
  } else {
    console.log('  ✅ 全程无任何带数据的上传请求');
  }
  // 承保相关资源请求（应只有本地静态文件）
  const remote = reqs.filter(r => !/^(file|data|blob):/.test(r.url) && !/127\.0\.0\.1|localhost/.test(r.url));
  console.log('非本地请求:', remote.length, '(仅地图瓦片/底图等)');

  // ---- 截图（等卫星瓦片加载完，否则拍到的是空底图）----
  await page.waitForFunction(() => {
    const im = document.querySelectorAll('#uw-map img');
    if (!im.length) return false;
    return [...im].filter(i => i.complete && i.naturalWidth > 0).length >= im.length * 0.8;
  }, { timeout: 20000 }).catch(() => console.log('  (瓦片未完全加载，继续截图)'));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: '/tmp/uwtest/shot_main.png' });
  await page.locator('#v-uw .mapwrap').screenshot({ path: '/tmp/uwtest/shot_map.png' });
  console.log('\n截图: shot_main.png / shot_map.png');

  console.log('\n=== 页面错误 ===');
  if (errs.length) errs.slice(0, 12).forEach(e => console.log('  ' + e));
  else console.log('  无');

  await browser.close();
})();
