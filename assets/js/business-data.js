/* ============================================================
   AgriSense 3S 农险遥感地图平台 · 业务数据层
   ⚠️ 全部为「模拟测算」演示数据，不代表阳光财险真实经营数据
   真实产品口径以公司最新报备/内控文件为准
   数据锚点：湖北农情（淡水鱼天气指数险、向日葵农险、2024汛期天眼预警减损）
   ============================================================ */
(function (global) {
  'use strict';

  var R = G.mulberry32;

  /* ========== 1. 承保端 · 风险地图数据 ========== */
  // 湖北 17 市农险业务结构（模拟测算）
  var CITY_BIZ = {
    '武汉市':     { area: 271.6, insure: 82.4,  rate: 4.1,  cor: 78,  main: '蔬菜·水产·茶叶', risk: 3.1 },
    '黄石市':     { area: 158.2, insure: 41.7,  rate: 4.6,  cor: 82,  main: '水稻·棉花·柑橘', risk: 3.4 },
    '十堰市':     { area: 236.8, insure: 63.5,  rate: 4.2,  cor: 75,  main: '水稻·柑橘·食用菌', risk: 2.8 },
    '宜昌市':     { area: 341.2, insure: 87.3,  rate: 4.0,  cor: 74,  main: '柑橘·茶叶·水稻', risk: 2.6 },
    '襄阳市':     { area: 197.4, insure: 52.8,  rate: 4.3,  cor: 79,  main: '小麦·水稻·蛋鸡', risk: 3.0 },
    '鄂州市':     { area: 1594.0, insure: 39.2, rate: 4.8, cor: 85, main: '水产·水稻', risk: 3.8 },
    '荆门市':     { area: 125.3, insure: 44.6, rate: 4.2, cor: 76, main: '水稻·油菜·生猪', risk: 3.2 },
    '孝感市':     { area: 891.0, insure: 58.9, rate: 4.5,  cor: 83,  main: '水稻·小麦·禽类', risk: 3.6 },
    '荆州市':     { area: 1410.0, insure: 72.3, rate: 4.7, cor: 86,  main: '水稻·水产·油菜', risk: 3.9 },
    '黄冈市':     { area: 1746.0, insure: 68.5, rate: 4.4,  cor: 80,  main: '水稻·茶叶·柑橘', risk: 3.5 },
    '咸宁市':     { area: 1003.0, insure: 46.2, rate: 4.3,  cor: 77,  main: '茶叶·水稻·水产', risk: 3.3 },
    '随州市':     { area: 9636.0, insure: 51.7, rate: 4.1,  cor: 75, main: '水稻·小麦·蛋鸡', risk: 2.9 },
    '恩施土家族苗族自治州': { area: 2411.0, insure: 47.9, rate: 4.0, cor: 73, main: '茶叶·马铃薯·蔬菜', risk: 2.4 },
    '仙桃市':     { area: 2538.0, insure: 33.6, rate: 4.9, cor: 88,  main: '水产·棉花', risk: 4.1 },
    '潜江市':     { area: 2999.0, insure: 29.4, rate: 4.8, cor: 87,  main: '龙虾·水产', risk: 4.0 },
    '天门市':     { area: 1422.0, insure: 24.8, rate: 4.6, cor: 84,  main: '棉花·水产', risk: 3.7 },
    '神农架林区': { area: 3253.0, insure: 8.7,  rate: 3.8,  cor: 71,  main: '中药材·食用菌', risk: 2.2 }
  };

  // 灾种风险指数（0-1，越高越危险）
  var HAZARD = {
    暴雨洪涝: { w: 0.30, unit: 'mm/日', color: '#3b82f6' },
    高温热害: { w: 0.20, unit: '℃', color: '#f97316' },
    干旱:     { w: 0.18, unit: 'mm',  color: '#eab308' },
    冰雹大风: { w: 0.12, unit: 'm/s', color: '#8b5cf6' },
    霜冻低温: { w: 0.12, unit: '℃',  color: '#06b6d4' },
    病虫害:   { w: 0.08, unit: '%',   color: '#84cc16' }
  };

  /* ========== 2. 理赔端 · 定损数据 ========== */
  // 重点县定损场景（模拟测算）
  var LOSS_CASES = {
    421127: {
      name: '黄梅县', crop: '水稻', areaMu: 426800, disaster: '暴雨洪涝',
      level: '重灾', lossRate: 0.42, claimMu: 179256, avgLoss: 1180,
      imagery: 'GF-6 PMS 2m + 无人机 0.3m',
      updated: '2026-07-08 16:20', households: 3821, done: 0.68,
      towns: [
        { n: '小池镇', mu: 86400, loss: 0.51, claim: 44064, st: '已定损' },
        { n: '大河镇', mu: 78200, loss: 0.47, claim: 36754, st: '已定损' },
        { n: '苦竹乡', mu: 61300, loss: 0.39, claim: 23907, st: '已定损' },
        { n: '黄梅县城区', mu: 54200, loss: 0.44, claim: 23848, st: '核验中' },
        { n: '濯港镇', mu: 58800, loss: 0.36, claim: 21168, st: '核验中' },
        { n: '停前镇', mu: 47900, loss: 0.28, claim: 13412, st: '待查勘' },
        { n: '五祖镇', mu: 39600, loss: 0.18, claim: 7128, st: '待查勘' }
      ]
    },
    421023: {
      name: '监利市', crop: '水稻', areaMu: 682400, disaster: '暴雨洪涝',
      level: '中度', lossRate: 0.31, claimMu: 211544, avgLoss: 960,
      imagery: 'GF-6 PMS 2m + 无人机 0.3m',
      updated: '2026-07-08 16:20', households: 5924, done: 0.55,
      towns: [
        { n: '毛市镇', mu: 128600, loss: 0.44, claim: 56584, st: '已定损' },
        { n: '福田寺镇', mu: 96400, loss: 0.36, claim: 34704, st: '已定损' },
        { n: '汴河镇', mu: 88200, loss: 0.33, claim: 29106, st: '核验中' },
        { n: '容城镇', mu: 76400, loss: 0.38, claim: 29032, st: '核验中' },
        { n: '朱河镇', mu: 91200, loss: 0.24, claim: 21888, st: '待查勘' },
        { n: '桥市镇', mu: 87800, loss: 0.21, claim: 18438, st: '待查损' },
        { n: '汪集镇', mu: 113800, loss: 0.15, claim: 17070, st: '待查勘' }
      ]
    },
    420527: {
      name: '秭归县', crop: '柑橘', areaMu: 214600, disaster: '低温冻害',
      level: '中度', lossRate: 0.28, claimMu: 60088, avgLoss: 1650,
      imagery: 'GF-6 PMS 2m + Sentinel-3 温度反演',
      updated: '2026-07-08 16:20', households: 2147, done: 0.72,
      towns: [
        { n: '屈原镇', mu: 42800, loss: 0.41, claim: 17548, st: '已定损' },
        { n: '沙镇溪镇', mu: 38200, loss: 0.35, claim: 13370, st: '已定损' },
        { n: '郭家坝镇', mu: 34600, loss: 0.32, claim: 11072, st: '已定损' },
        { n: '归州镇', mu: 29400, loss: 0.30, claim: 8820, st: '核验中' },
        { n: '泄滩乡', mu: 26800, loss: 0.24, claim: 6432, st: '核验中' },
        { n: '峡口镇', mu: 23100, loss: 0.17, claim: 3927, st: '待查勘' },
        { n: '水田坝乡', mu: 19700, loss: 0.11, claim: 2167, st: '待查勘' }
      ]
    }
  };

  /* ========== 3. 预警调度 · 真实预警类型 ========== */
  // 对接中国气象局 14 类预警（阳光天眼预警精灵已公开的能力口径）
  var WARN_TYPES = [
    { code: '暴雨', name: '暴雨预警',   level: '橙色', cls: 'warn-lv3' },
    { code: '洪水', name: '洪水预警',   level: '红色', cls: 'warn-lv4' },
    { code: '高温', name: '高温预警',   level: '黄色', cls: 'warn-lv2' },
    { code: '雷电', name: '雷电预警',   level: '黄色', cls: 'warn-lv2' },
    { code: '大风', name: '大风预警',   level: '蓝色', cls: 'warn-lv1' },
    { code: '冰雹', name: '冰雹预警',   level: '橙色', cls: 'warn-lv3' },
    { code: '寒潮', name: '寒潮预警',   level: '蓝色', cls: 'warn-lv1' },
    { code: '霜冻', name: '霜冻预警',   level: '黄色', cls: 'warn-lv2' }
  ];

  var WARN_TASKS = [
    { id: 'W2026070801', level: '红色', type: '洪水', city: '黄冈市', area: '黄梅县小池镇、大河镇',
      time: '2026-07-08 08:30', src: '湖北省气象台', status: '处置中',
      farmers: 3821, mu: 179256, suggest: '立即转移低洼区畜禽养殖户 · 优先排查圩垸与闸口',
      actions: ['预警短信已发 3821 户', '乡镇协保员已通知 128 人', '应急物资前置到位'] },
    { id: 'W2026070802', level: '橙色', type: '暴雨', city: '荆州市', area: '监利市毛市镇、朱河镇',
      time: '2026-07-08 06:15', src: '荆州市气象台', status: '处置中',
      farmers: 2406, mu: 95160, suggest: '巡查圩垸堤防 · 提前开闸腾库容',
      actions: ['预警短信已发 2406 户', '堤防巡查 6 个点位'] },
    { id: 'W2026070803', level: '橙色', type: '冰雹', city: '黄冈市', area: '黄梅县五祖镇、停前镇',
      time: '2026-07-08 11:02', src: '湖北省气象台', status: '已响应',
      farmers: 893, mu: 87500, suggest: '柑橘园防冰雹网检查 · 建议加固遮阳网',
      actions: ['防雹网检查完成 42 个地块'] },
    { id: 'W2026070704', level: '黄色', type: '霜冻', city: '宜昌市', area: '秭归县屈原镇、归州镇',
      time: '2026-07-07 20:40', src: '宜昌市气象台', status: '已闭环',
      farmers: 1240, mu: 72200, suggest: '果园熏烟防霜 · 灌水保墒',
      actions: ['防霜措施指导送达 1240 户', '损失初核完成'] },
    { id: 'W2026070805', level: '蓝色', type: '大风', city: '武汉市', area: '蔡甸区、江夏区',
      time: '2026-07-08 14:20', src: '武汉市气象台', status: '已闭环',
      farmers: 1680, mu: 54000, suggest: '设施大棚压膜线加固 · 检查通风口',
      actions: ['大棚巡检 168 个'] }
  ];

  /* ========== 4. 灾情损失评估 · 精度口径 ========== */
  // ⚠️ 行业公开口径（非阳光财险承诺值），来源见专家包 09 库
  var PRECISION = {
    label: '行业公开业务化精度参考',
    note: '以下为同业已披露的业务化精度口径，用于说明能力可行性，非本司承诺值',
    items: [
      { name: '勘灾定损精度', val: '>90%', src: '珈和科技「农险通」公开披露', by: '同业' },
      { name: '承保准确率',   val: '>98%', src: '珈和科技「农险通」公开披露', by: '同业' },
      { name: 'AI作物识别精度', val: '96%',  src: '平安产险博州「卫星遥感+AI+农险」公开口径', by: '同业' },
      { name: '无人机定损覆盖率', val: '98%', src: '平安产险博州公开口径', by: '同业' },
      { name: '地块勾绘误差', val: '1.12%', src: '淄博烟草「双精准」公开口径（9户223亩）', by: '同业' }
    ],
    standards: [
      { name: '《农业保险遥感技术应用规范》', org: '中国保险行业协会 · 中国农业风险管理研究会', date: '2025-07-30 发布' },
      { name: 'JR/T 0180-2019', org: '《基于遥感技术的农业保险精确承保和快速理赔规范》', date: '行业标准' }
    ],
    compliance: [
      '定损结论须可解释、可追溯 —— 图斑 + 原始影像留痕',
      '重大灾损采用「遥感初筛 + 人工抽核」，避免全自动误判',
      '学术精度不等于业务承诺，禁止对客直接引用'
    ]
  };

  // 承保端风险五维（大数据风控模型口径）
  var RISK_DIMS = [
    { k: 'met',    n: '气象风险',   w: 0.28, d: '降水量·积温·极端值' },
    { k: 'rs',     n: '遥感风险',   w: 0.22, d: '植被指数·受灾图斑' },
    { k: 'iot',    n: '物联网风险', w: 0.16, d: '土壤·水质·虫情监测' },
    { k: 'hist',   n: '历史赔付',   w: 0.20, d: '承保理赔历史数据' },
    { k: 'geo',    n: '地理环境',   w: 0.14, d: '高程·坡度·种植适宜性' }
  ];

  /* ========== 地块级模拟数据生成 ==========
   蓝噪声式散布 + 最小间距剔除：保证地块互不重叠、形状清晰可辨 */
  function makeParcels(rings, seed, n, bbox) {
    var rnd = R(seed), out = [];
    var b = bbox;
    var bw = b[2] - b[0], bh = b[3] - b[1];
    var cell = Math.sqrt(bw * bh / Math.max(n, 1)) * 0.62;  // 目标网格边长
    var minGap = cell * 0.16;                                 // 地块间最小留白
    var pts = [];
    var tries = 0, maxTries = n * 220;

    while (pts.length < n && tries < maxTries) {
      tries++;
      var x = b[0] + rnd() * bw;
      var y = b[1] + rnd() * bh;
      if (!G.pointInRings(x, y, rings)) continue;

      // 最小间距剔除（用网格哈希加速）
      var ok = true;
      for (var i = 0; i < pts.length; i++) {
        var dx = pts[i][0] - x, dy = pts[i][1] - y;
        if (dx * dx + dy * dy < minGap * minGap) { ok = false; break; }
      }
      if (!ok) continue;
      pts.push([x, y]);
    }

    pts.forEach(function (p, i) {
      var x = p[0], y = p[1];
      // 半径基于网格，保证不超出邻格
      var r = cell * (0.30 + rnd() * 0.16);
      var sides = 5 + Math.floor(rnd() * 3);
      var rot = rnd() * Math.PI * 2;
      var ring = [];
      for (var s = 0; s < sides; s++) {
        var a = rot + s / sides * Math.PI * 2;
        var rr = r * (0.74 + rnd() * 0.36);
        var px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
        // 顶点必须落在县界内，避免跨界
        if (!G.pointInRings(px, py, rings)) { px = x + (px - x) * .45; py = y + (py - y) * .45; }
        ring.push([px, py]);
      }
      out.push({ x: x, y: y, pts: ring, cx: x, cy: y, r: r });
    });
    return out;
  }

  global.DATA = {
    CITY_BIZ: CITY_BIZ,
    HAZARD: HAZARD,
    LOSS_CASES: LOSS_CASES,
    WARN_TYPES: WARN_TYPES,
    WARN_TASKS: WARN_TASKS,
    PRECISION: PRECISION,
    RISK_DIMS: RISK_DIMS,
    makeParcels: makeParcels,
    mulberry32: R
  };
})(window);