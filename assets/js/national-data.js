/* ============================================================
   AgriSense 3S · 全国农业与遥感专题数据层
   ⚠️ 全部为「模拟测算」演示数据，不代表阳光财险真实经营数据
   农业结构基础值参考公开统计口径；保赔/风险为演示测算
   ============================================================ */
(function (global) {
  'use strict';

  /* ============ 省级农业结构（模拟测算，仅用于演示配色与下钻） ============
     key = 行政区划代码；字段：耕地(千亩)/保费(亿)/综合成本率(%)/主导作物/风险指数/灾种 */
  var PROV = {
    110000: { n: '北京', farm: 380,   prem: 8.2,   cor: 88, crop: '蔬菜·水果',        risk: 2.6, haz: '干旱' },
    120000: { n: '天津', farm: 520,   prem: 9.6,   cor: 86, crop: '小麦·水稻',        risk: 2.8, haz: '干旱' },
    130000: { n: '河北', farm: 9200,  prem: 128.5, cor: 81, crop: '小麦·玉米·蔬菜',   risk: 3.2, haz: '干旱' },
    140000: { n: '山西', farm: 3900,  prem: 42.7,  cor: 82, crop: '玉米·谷子',        risk: 3.0, haz: '干旱' },
    150000: { n: '内蒙古', farm: 7200, prem: 76.3,  cor: 79, crop: '玉米·马铃薯·奶业', risk: 3.4, haz: '干旱' },
    210000: { n: '辽宁', farm: 4900,  prem: 61.2,  cor: 80, crop: '水稻·玉米·生猪',   risk: 3.1, haz: '低温' },
    220000: { n: '吉林', farm: 6600,  prem: 52.8,  cor: 79, crop: '玉米·水稻',        risk: 3.3, haz: '低温' },
    230000: { n: '黑龙江', farm: 14200, prem: 158.4, cor: 77, crop: '水稻·玉米·大豆',  risk: 3.2, haz: '低温' },
    310000: { n: '上海', farm: 210,   prem: 6.4,   cor: 89, crop: '蔬菜·水稻',        risk: 3.0, haz: '台风' },
    320000: { n: '江苏', farm: 7100,  prem: 112.6, cor: 82, crop: '水稻·小麦·水产',   risk: 3.3, haz: '洪涝' },
    330000: { n: '浙江', farm: 1950,  prem: 48.2,  cor: 84, crop: '水稻·茶叶·水产',   risk: 3.5, haz: '台风' },
    340000: { n: '安徽', farm: 8600,  prem: 96.4,  cor: 82, crop: '水稻·小麦',        risk: 3.2, haz: '洪涝' },
    350000: { n: '福建', farm: 1450,  prem: 32.6,  cor: 85, crop: '水稻·茶叶·水产',   risk: 3.9, haz: '台风' },
    360000: { n: '江西', farm: 3900,  prem: 44.8,  cor: 81, crop: '水稻·柑橘',        risk: 3.4, haz: '洪涝' },
    370000: { n: '山东', farm: 11800, prem: 138.7, cor: 83, crop: '小麦·玉米·花生',   risk: 3.1, haz: '干旱' },
    410000: { n: '河南', farm: 12600, prem: 142.3, cor: 80, crop: '小麦·玉米',        risk: 3.3, haz: '干旱' },
    420000: { n: '湖北', farm: 5200,  prem: 85.3,  cor: 80, crop: '水稻·水产·油菜',   risk: 3.4, haz: '洪涝' },
    430000: { n: '湖南', farm: 4600,  prem: 68.9,  cor: 79, crop: '水稻·油菜·柑橘',   risk: 3.3, haz: '洪涝' },
    440000: { n: '广东', farm: 3600,  prem: 72.5,  cor: 87, crop: '水稻·水产·水果',   risk: 4.1, haz: '台风' },
    450000: { n: '广西', farm: 3900,  prem: 54.2,  cor: 82, crop: '水稻·甘蔗·水果',   risk: 3.8, haz: '台风' },
    460000: { n: '海南', farm: 1500,  prem: 28.4,  cor: 90, crop: '橡胶·椰子·水产',   risk: 4.3, haz: '台风' },
    500000: { n: '重庆', farm: 2200,  prem: 32.7,  cor: 82, crop: '水稻·柑橘·生猪',   risk: 3.3, haz: '洪涝' },
    510000: { n: '四川', farm: 6200,  prem: 82.4,  cor: 81, crop: '水稻·小麦·生猪',   risk: 3.0, haz: '干旱' },
    520000: { n: '贵州', farm: 2100,  prem: 29.6,  cor: 83, crop: '水稻·玉米·茶叶',   risk: 3.2, haz: '凝冻' },
    530000: { n: '云南', farm: 3400,  prem: 38.5,  cor: 85, crop: '水稻·烟草·水果',   risk: 3.1, haz: '干旱' },
    540000: { n: '西藏', farm: 380,   prem: 6.8,   cor: 88, crop: '青稞·牧业',        risk: 2.4, haz: '霜冻' },
    610000: { n: '陕西', farm: 4100,  prem: 48.2,  cor: 80, crop: '小麦·苹果·玉米',   risk: 3.2, haz: '干旱' },
    620000: { n: '甘肃', farm: 2800,  prem: 26.4,  cor: 79, crop: '小麦·马铃薯',       risk: 3.5, haz: '干旱' },
    630000: { n: '青海', farm: 900,   prem: 12.6,  cor: 81, crop: '青稞·油菜',        risk: 3.0, haz: '雪灾' },
    640000: { n: '宁夏', farm: 1150,  prem: 14.2,  cor: 82, crop: '小麦·枸杞·牛羊',   risk: 3.6, haz: '干旱' },
    650000: { n: '新疆', farm: 4800,  prem: 62.8,  cor: 84, crop: '棉花·小麦·果业',   risk: 3.7, haz: '干旱' },
    710000: { n: '台湾', farm: 1200,  prem: 16.4,  cor: 86, crop: '水稻·水果·茶叶',   risk: 3.9, haz: '台风' },
    810000: { n: '香港', farm: 20,    prem: 0.8,   cor: 92, crop: '蔬菜',            risk: 3.5, haz: '台风' },
    820000: { n: '澳门', farm: 10,    prem: 0.3,   cor: 93, crop: '—',               risk: 3.2, haz: '台风' }
  };

  /* ============ 遥感专题图层定义 ============ */
  var LAYERS = {
    ndvi: {
      key: 'ndvi', name: '植被长势指数 NDVI', unit: '', range: [0.1, 0.9],
      desc: '归一化植被指数，反映作物长势与生物量。数值越高长势越好。',
      source: 'GF-6 PMS · Sentinel-2 · 模拟测算',
      legend: [
        { t: '0.1–0.3', c: '#a16207', d: '裸土·稀疏' },
        { t: '0.3–0.5', c: '#eab308', d: '长势较差' },
        { t: '0.5–0.7', c: '#84cc16', d: '长势良好' },
        { t: '0.7–0.9', c: '#15803d', d: '长势旺盛' }
      ],
      warn: [0.32, 0.45]
    },
    drought: {
      key: 'drought', name: '干旱指数', unit: 'mm', range: [0, 1],
      desc: '基于降水距平与土壤墒情的综合干旱指数，黄至红表示旱情加重。',
      source: '气象站数据 + 遥感反演 · 模拟测算',
      legend: [
        { t: '无明显干旱', c: '#34d399' },
        { t: '轻旱', c: '#facc15' },
        { t: '中旱', c: '#fb923c' },
        { t: '重旱', c: '#ef4444' }
      ],
      warn: [0.5, 0.75]
    },
    flood: {
      key: 'flood', name: '洪涝淹没指数', unit: '', range: [0, 1],
      desc: '基于合成孔径雷达（SAR）的水体提取，蓝色深浅表示淹没程度。',
      source: 'Sentinel-1 SAR · 模拟测算',
      legend: [
        { t: '未淹没', c: '#1e3a5f' },
        { t: '轻度积水', c: '#3b82f6' },
        { t: '中度淹没', c: '#1d4ed8' },
        { t: '重度淹没', c: '#1e3a8a' }
      ],
      warn: [0.4, 0.7]
    },
    hail: {
      key: 'hail', name: '冰雹大风影响场', unit: 'm/s', range: [0, 1],
      desc: '基于雷达回波与地面风速的影响场评估，标识冰雹大风风险区域。',
      source: '天气雷达 + 地面站 · 模拟测算',
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
      key: 'biomass', name: '地上生物量', unit: 'g/m²', range: [0, 1],
      desc: '单位地表面积上的干物质总量，反映作物长势与产量形成潜力，用于长势分级与产量预估。',
      source: 'GF-6 PMS · Sentinel-2 · 模拟测算',
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
      key: 'gdd', name: '有效积温（≥10℃）', unit: '℃·d', range: [0, 1],
      desc: '作物生育期内日均温累积至 10℃ 以上的热量，判定热量条件是否满足成熟与霜冻风险。',
      source: '气象站日温 + 空间插值 · 模拟测算',
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
      key: 'soilMoisture', name: '土壤墒情', unit: '%VWC', range: [0, 1],
      desc: '根区土壤体积含水量，刻画作物水分供给；持续偏低将触发干旱定损，洼地偏高需警惕渍涝。',
      source: 'SMAP L-band 土壤水分 + 气象站 · 模拟测算',
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
      key: 'lst', name: '地表温度 LST', unit: '℃', range: [0, 1],
      desc: '地表热红外温度，用于高温热害与积温胁迫预警；持续偏高对生育期作物造成减产。',
      source: 'FY-4B AGRI · MODIS LST · 模拟测算',
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
    PROV: PROV,
    LAYERS: LAYERS,
    DISASTERS: DISASTERS,
    provInfo: provInfo,
    provSummary: provSummary,
    topicValue: topicValue,
    disasterField: disasterField
  };
})(window);