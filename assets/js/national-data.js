/* ============================================================
   AgriSense 3S · 全国农业与遥感专题数据层
   ⚠️ 全部为「模拟测算」演示数据，不代表阳光财险真实经营数据
   农业结构基础值参考公开统计口径；保赔/风险为演示测算
   ============================================================ */
(function (global) {
  'use strict';

  /* ============ 省级农业结构（模拟测算，仅用于演示配色与下钻） ============
     key = 行政区划代码；字段：耕地(**万亩**)/保费(亿)/综合成本率(%)/主导作物/风险指数/灾种
     ⚠️ 口径修订 2026-10-13：farm 原标注"千亩"但实际填的是万亩值，
        全国汇总被再次除以 10000，导致显示 41.7 万亩（实应约 14 亿亩）。已统一为万亩。 */
  var PROV = {
    110000: { n: '北京', farm: 380,   prem: null,   cor: 88, crop: '蔬菜·水果',        risk: 2.6, haz: '干旱', growth: -18 },
    120000: { n: '天津', farm: 520,   prem: null,   cor: 86, crop: '小麦·水稻',        risk: 2.8, haz: '干旱', growth: -15 },
    130000: { n: '河北', farm: 9200, prem: 53.61, cor: 81, crop: '小麦·玉米·蔬菜', risk: 3.2, haz: '干旱', growth: 12,
       src: '2024年全省政策性农业保险保费规模53.61亿元，四级财政补贴42.57亿元，保障1449.67亿元 · 河北省财政厅冀财办提字〔2025〕462号' },
    140000: { n: '山西', farm: 3900, prem: 25.52, cor: 82, crop: '玉米·谷子', risk: 3.0, haz: '干旱', growth: 27,
       src: '2024年全省政策性农业保险保费规模25.52亿元，同比+21.93%（全口径34.15亿） · 山西省财政厅' },
    150000: { n: '内蒙古', farm: 7200, prem: 70.67, cor: 79, crop: '玉米·马铃薯·奶业', risk: 3.4, haz: '干旱', growth: 0,
       src: '2024年政策性农业保险保费收入70.67亿元，183.62万户次农户 · 内蒙古自治区财政厅' },
    210000: { n: '辽宁', farm: 4900, prem: 38.0, cor: 80, crop: '水稻·玉米·生猪', risk: 3.1, haz: '低温', growth: 17,
       src: '2024年全省（不含大连）政策性农业保险保费总规模38亿元，保障997亿元 · 辽宁省财政厅' },
    220000: { n: '吉林', farm: 6600,  prem: null,  cor: 79, crop: '玉米·水稻',        risk: 3.3, haz: '低温', growth: -1 },
    230000: { n: '黑龙江', farm: 14200, prem: 96.0, cor: 77, crop: '水稻·玉米·大豆', risk: 3.2, haz: '低温', growth: 19,
       src: '2024年全省农业保险保费收入96亿元，同比+18.96% · 国家金融监督管理总局黑龙江监管局' },
    310000: { n: '上海', farm: 210,   prem: null,   cor: 89, crop: '蔬菜·水稻',        risk: 3.0, haz: '台风', growth: 7 },
    320000: { n: '江苏', farm: 7100, prem: 83.56, cor: 82, crop: '水稻·小麦·水产', risk: 3.3, haz: '洪涝', growth: 9,
       src: '2024年农业保险保费收入83.56亿元，同比+12.44% · 江苏省财政厅' },
    330000: { n: '浙江', farm: 1950, prem: 20.65, cor: 84, crop: '水稻·茶叶·水产', risk: 3.5, haz: '台风', growth: 7,
       src: '2024年政策性农业保险保费20.65亿元（不含宁波），同比+6% · 浙江省农业农村厅' },
    340000: { n: '安徽', farm: 8600, prem: 76.09, cor: 82, crop: '水稻·小麦', risk: 3.2, haz: '洪涝', growth: 6,
       src: '2024年农业保险保费规模76.09亿元，同比+7.78%，综合绩效评价连续三年全国第一 · 安徽省财政厅' },
    350000: { n: '福建', farm: 1450,  prem: null,  cor: 85, crop: '水稻·茶叶·水产',   risk: 3.9, haz: '台风', growth: 11 },
    360000: { n: '江西', farm: 3900, prem: 46.85, cor: 81, crop: '水稻·柑橘', risk: 3.4, haz: '洪涝', growth: 8,
       src: '2024年政策性农业保险保费规模46.85亿元（2020-2024年均增22.29%） · 江西省财政厅' },
    370000: { n: '山东', farm: 11800, prem: 83.3, cor: 83, crop: '小麦·玉米·花生', risk: 3.1, haz: '干旱', growth: 13,
       src: '2024年农业保险原保险保费收入83.3亿元，增长12.7% · 山东省统计局《2024年山东省国民经济和社会发展统计公报》' },
    410000: { n: '河南', farm: 12600, prem: 104.6, cor: 80, crop: '小麦·玉米', risk: 3.3, haz: '干旱', growth: 10,
       src: '2024年末全省农业保险保费收入104.6亿元、保额2366.4亿元，排名全国第一 · 河南省农业农村厅' },
    420000: { n: '湖北', farm: 7152.88, prem: 43.87, cor: 80, crop: '水稻·水产·油菜', risk: 3.4, haz: '洪涝', growth: 5.8,
       src: '2024年保费规模43.87亿元（同比+5.8%）、中省两级财政补贴30.79亿元、447万户次、保障1448亿元 · 湖北省财政厅《关于省十四届人大三次会议第20250583号建议的答复》；耕地7152.88万亩 · 湖北省第三次国土调查主要数据公报' },
    430000: { n: '湖南', farm: 4600, prem: 94.0, cor: 79, crop: '水稻·油菜·柑橘', risk: 3.3, haz: '洪涝', growth: 23,
       src: '2024年农险保费收入94亿元，同比+23.8%，规模全国第3 · 国家金融监督管理总局湖南监管局' },
    440000: { n: '广东', farm: 3600,  prem: null,  cor: 87, crop: '水稻·水产·水果',   risk: 4.1, haz: '台风', growth: -9 },
    450000: { n: '广西', farm: 3900, prem: 59.03, cor: 82, crop: '水稻·甘蔗·水果', risk: 3.8, haz: '台风', growth: 0,
       src: '2024年全区农业保险保费收入59.03亿元，规模全国第13位 · 广西壮族自治区农业农村厅' },
    460000: { n: '海南', farm: 1500,  prem: null,  cor: 90, crop: '橡胶·椰子·水产',   risk: 4.3, haz: '台风', growth: 1 },
    500000: { n: '重庆', farm: 2200, prem: 17.5, cor: 82, crop: '水稻·柑橘·生猪', risk: 3.3, haz: '洪涝', growth: 20,
       src: '2024年农险保费收入17.5亿元，同比+17.71%，保障676.86亿元 · 重庆金融监管局' },
    510000: { n: '四川', farm: 6200,  prem: null,  cor: 81, crop: '水稻·小麦·生猪',   risk: 3.0, haz: '干旱', growth: 8 },
    520000: { n: '贵州', farm: 2100, prem: 28.1, cor: 83, crop: '水稻·玉米·茶叶', risk: 3.2, haz: '凝冻', growth: 14,
       src: '2024年全省农业保险保费收入28.1亿元，800.51万户次 · 国家金融监督管理总局贵州监管局' },
    530000: { n: '云南', farm: 3400,  prem: null,  cor: 85, crop: '水稻·烟草·水果',   risk: 3.1, haz: '干旱', growth: 2 },
    540000: { n: '西藏', farm: 380,   prem: null,   cor: 88, crop: '青稞·牧业',        risk: 2.4, haz: '霜冻', growth: 3 },
    610000: { n: '陕西', farm: 4100, prem: 30.0, cor: 80, crop: '小麦·苹果·玉米', risk: 3.2, haz: '干旱', growth: 6,
       src: '2024年全省农业保险保费总规模接近30亿元 · 陕西省财政厅' },
    620000: { n: '甘肃', farm: 2800, prem: null, cor: 79, crop: '小麦·马铃薯', risk: 3.5, haz: '干旱', growth: 5,
       src: '甘肃省2024年农险保费收入未取得省级公开口径（待补）' },
    630000: { n: '青海', farm: 900, prem: null, cor: 81, crop: '青稞·油菜', risk: 3.0, haz: '雪灾', growth: 4,
       src: '青海省2024年农险保费收入未取得省级公开口径（待补）' },
    640000: { n: '宁夏', farm: 1150,  prem: null,  cor: 82, crop: '小麦·枸杞·牛羊',   risk: 3.6, haz: '干旱', growth: 8 },
    650000: { n: '新疆', farm: 4800,  prem: null,  cor: 84, crop: '棉花·小麦·果业',   risk: 3.7, haz: '干旱', growth: -12 },
    710000: { n: '台湾', farm: 1200,  prem: null,  cor: 86, crop: '水稻·水果·茶叶',   risk: 3.9, haz: '台风' },
    810000: { n: '香港', farm: 20,    prem: null,   cor: 92, crop: '蔬菜',            risk: 3.5, haz: '台风' },
    820000: { n: '澳门', farm: 10,    prem: null,   cor: 93, crop: '—',               risk: 3.2, haz: '台风' }
  };

  /* growth = 2024年各地区农业保险保费同比增速（%）
     来源：2024年各地区农业保险保费同比增速 · 行业研报《2025农业保险发展》整理
     可用于判断各省市农险业务景气度（负增长=市场收缩，需关注）。 */
  var GROWTH_SRC = '2024年各地区农业保险保费同比增速 · 行业研报《2025农业保险发展》整理';

  /* ============ 遥感专题图层定义 ============ */
  var LAYERS = {
    ndvi: {
      key: 'ndvi', name: '植被长势指数 NDVI', brief: '看作物长得好不好', unit: '', range: [0, 1],
      desc: '归一化植被指数 NDVI =(ρNIR−ρRed)/(ρNIR+ρRed)，取值 −1~1。数值越高长势越好。',
      source: 'NASA MODIS Terra NDVI（GIBS 真实数据 · 2026-10-14 起）',
      /* PPT 第2页要求：低值黄/橙，高值逐渐加深为绿 */
      legend: [
        { t: '0.1–0.2', c: '#a16207', d: '裸土/休耕/收获后' },
        { t: '0.2–0.3', c: '#ca8a04', d: '稀疏出苗' },
        { t: '0.3–0.4', c: '#eab308', d: '长势较差' },
        { t: '0.4–0.5', c: '#a3ca10', d: '中等' },
        { t: '0.5–0.6', c: '#7ab317', d: '长势良好' },
        { t: '0.6–0.7', c: '#4a9a20', d: '较好' },
        { t: '0.7–0.9', c: '#1a6b2e', d: '长势旺盛' }
      ],
      /* PPT 第2页：低值可能与裸地、休耕或收获有关；
         水体/云/无数据另设符号（见 legendExtra） */
      note: '低值可能与裸地、休耕或收获有关，不必然是受灾。水体、云与无数据区单独标识。',
      legendExtra: [
        { t: '水体/不透水面', c: '#2a3548', d: '无 NDVI 数据' },
        { t: '云覆盖', c: '#8a94a6', d: '无有效观测' }
      ],
      warn: [0.32, 0.45]
    },
    drought: {
      key: 'drought', name: '干旱指数', brief: '看缺水有多严重', unit: 'mm', range: [0, 1],
      desc: '基于降水距平与土壤墒情的综合干旱指数，黄至红表示旱情加重。',
      source: 'NASA GPM IMERG V07 降水（GIBS 真实数据 · 2026-10-14 起）',
      legend: [
        { t: '无明显干旱', c: '#34d399' },
        { t: '轻旱', c: '#facc15' },
        { t: '中旱', c: '#fb923c' },
        { t: '重旱', c: '#ef4444' }
      ],
      warn: [0.5, 0.75]
    },
    /* PPT 第3/4/6页新增：TVDI 温度植被干燥指数
       公式见第6页附录；五级分级与配色见第4页表格（需本地验证）。*/
    tvdi: {
      key: 'tvdi', name: '温度植被干燥指数 TVDI', brief: '综合温度与植被的干湿（需本地验证）', unit: '', range: [0, 1],
      desc: 'TVDI =(LST − LSTwet)/(LSTdry − LSTwet)。由 NDVI 与地表温度构建特征空间、拟合干边湿边后计算。取值 0~1，越大越干。',
      source: 'NASA MODIS（NDVI + LST 特征空间拟合 · 2026-10-15）',
      legend: [
        { t: '(0, 0.2]', c: '#228b54', d: '无旱' },
        { t: '(0.2, 0.4]', c: '#9acd5c', d: '轻旱' },
        { t: '(0.4, 0.6]', c: '#ebd658', d: '中旱' },
        { t: '(0.6, 0.8]', c: '#e28f3e', d: '重旱' },
        { t: '(0.8, 1]', c: '#8d5a3a', d: '特旱' }
      ],
      note: '干湿边为经验拟合值，随区域、作物与生长期变化，使用前需用本地实测土壤水分验证。',
      warn: [0.4, 0.6]
    },
    flood: {
      key: 'flood', name: '洪涝淹没指数', brief: '看哪里被水淹了', unit: '', range: [0, 1],
      desc: '基于合成孔径雷达（SAR）的水体提取，蓝色深浅表示淹没程度。',
      source: 'NASA VIIRS+Sentinel-1 融合淹没（GIBS 真实数据 · 2026-10-14 起）',
      legend: [
        { t: '未淹没', c: '#1e3a5f' },
        { t: '轻度积水', c: '#3b82f6' },
        { t: '中度淹没', c: '#1d4ed8' },
        { t: '重度淹没', c: '#1e3a8a' }
      ],
      warn: [0.4, 0.7]
    },
    hail: {
      key: 'hail', name: '冰雹大风影响场', brief: '强对流风险落区（仅供调度）', unit: 'm/s', range: [0, 1],
      desc: '基于雷达回波与地面风速的影响场评估，标识冰雹大风风险区域。',
      source: 'NASA MODIS 地表温度骤降（强对流前兆 · 非冰雹实况）',
      legend: [
        { t: '无影响', c: '#334155' },
        { t: '轻度', c: '#a78bfa' },
        { t: '中度', c: '#8b5cf6' },
        { t: '重度', c: '#6d28d9' }
      ],
      warn: [0.45, 0.7]
    },

    /* ============ 以下为农险核验场景的核心遥感专题 ============ */

    biomass: {
      key: 'biomass', name: '地上生物量', brief: '看能打多少粮', unit: 'g/m²', range: [0, 1],
      desc: '单位地表面积上的干物质总量，反映作物长势与产量形成潜力，用于长势分级与产量预估。',
      source: 'NASA MODIS Terra NDVI（GIBS 真实数据 · 2026-10-14 起）',
      legend: [
        { t: '<150 g/m²', c: '#ceb092' },
        { t: '150–300', c: '#aaba6c' },
        { t: '300–450', c: '#7aa854' },
        { t: '450–600', c: '#468442' },
        { t: '>600 g/m²', c: '#205c34' }
      ],
      warn: [0.35, 0.52]
    },
    gdd: {
      key: 'gdd', name: '有效积温（≥10℃）', brief: '看热量够不够熟', unit: '℃·d', range: [0, 1],
      desc: '作物生育期内日均温累积至 10℃ 以上的热量，判定热量条件是否满足成熟与霜冻风险。',
      source: 'NASA POWER / MERRA-2 逐日气温（真实数值 · 2026-10-14 起）',
      legend: [
        { t: '<1600 ℃·d', c: '#3b82f6' },
        { t: '1600–2400', c: '#67c7b8' },
        { t: '2400–3200', c: '#a3d977' },
        { t: '3200–4200', c: '#e6b74a' },
        { t: '>4200 ℃·d', c: '#dd6b3d' }
      ],
      warn: [0.28, 0.42]
    },
    soilMoisture: {
      key: 'soilMoisture', name: '土壤墒情', brief: '看土壤水分够不够', unit: '%VWC', range: [0, 1],
      desc: '根区土壤体积含水量，刻画作物水分供给；持续偏低将触发干旱定损，洼地偏高需警惕渍涝。',
      source: 'NASA SMAP L4 土壤水分（GIBS 真实数据 · 分辨率 36km，仅区域用）',
      legend: [
        { t: '<10% 极干', c: '#b45309' },
        { t: '10–18%', c: '#d97706' },
        { t: '18–28%', c: '#eab308' },
        { t: '28–38%', c: '#65a30d' },
        { t: '>38% 饱和', c: '#15803d' }
      ],
      warn: [0.22, 0.34]
    },
    lst: {
      key: 'lst', name: '地表温度 LST', brief: '看高温热害风险', unit: '℃', range: [0, 1],
      desc: '地表热红外温度，用于高温热害与积温胁迫预警；持续偏高对生育期作物造成减产。',
      source: 'NASA MODIS Terra 地表温度 LST 日/夜双层（GIBS 真实数据 · 2026-10-14 起）',
      legend: [
        { t: '偏低 <18℃', c: '#0f4c81' },
        { t: '18–24℃', c: '#3fa7d6' },
        { t: '24–30℃', c: '#8fd694' },
        { t: '30–36℃', c: '#f4b942' },
        { t: '>36℃ 高温', c: '#e8503a' }
      ],
      warn: [0.62, 0.82]
    }
  };

  /* ============ 灾种分布（全国模拟测算） ============ */
  var DISASTERS = [
    { code: 'W01', name: '暴雨洪涝', level: '橙色', region: '江淮·长江中下游', provinces: ['320000','340000','420000','430000','360000','330000'], farmers: 48200, mu: 2860000, loss: 12.4 },
    { code: 'W02', name: '高温干旱', level: '黄色', region: '黄淮·西北东部',   provinces: ['410000','370000','410000','610000','520000'],       farmers: 31500, mu: 1940000, loss: 8.7 },
    { code: 'W03', name: '台风影响', level: '红色', region: '东南沿海',       provinces: ['350000','440000','350000','460000'],                farmers: 12800, mu: 620000,  loss: 15.2 },
    { code: 'W04', name: '低温冻害', level: '橙色', region: '东北·西北',     provinces: ['230000','220000','210000','150000','650000'],       farmers: 18600, mu: 890000,  loss: 6.4 },
    { code: 'W05', name: '冰雹大风', level: '黄色', region: '华北·西南山区', provinces: ['130000','140000','140000','510000','530000'],       farmers: 9400,  mu: 410000,  loss: 3.8 },
    { code: 'W06', name: '病虫害',   level: '蓝色', region: '南方稻区',       provinces: ['420000','430000','340000','360000'],                farmers: 6700,  mu: 280000,  loss: 2.1 }
  ];

  /* ============ 承保热力（模拟测算，全国分布） ============ */
  // 与 PROV 表一致的保费规模，用于热力渲染

  /* ============ 工具 ============ */
  function provInfo(code) { return PROV[code] || null; }

  function provSummary() {
    var s = { farm: 0, prem: 0, cor: 0, n: 0 };
    for (var k in PROV) {
      var p = PROV[k];
      if (!p || !p.farm) continue;
      s.farm += p.farm; s.prem += p.prem; s.cor += p.cor; s.n++;
    }
    s.cor = s.cor / s.n;
    return s;
  }

  // 按省adcode生成稳定的专题值（0~1），保证每次打开一致
  function topicValue(layerKey, code, salt) {
    var h = 0, str = String(code) + layerKey + (salt || '');
    for (var i = 0; i < str.length; i++) {
      h = (h * 31 + str.charCodeAt(i)) >>> 0;
    }
    return (h % 10000) / 10000;
  }

  // 依据灾种影响省份集合，生成灾情分布场
  function disasterField(code) {
    for (var i = 0; i < DISASTERS.length; i++) {
      var d = DISASTERS[i];
      if (d.provinces.indexOf(String(code)) >= 0) return d;
    }
    return null;
  }

  global.NAT = {
    GROWTH_SRC: GROWTH_SRC,
    PROV: PROV,
    LAYERS: LAYERS,
    DISASTERS: DISASTERS,
    provInfo: provInfo,
    provSummary: provSummary,
    topicValue: topicValue,
    disasterField: disasterField
  };
})(window);