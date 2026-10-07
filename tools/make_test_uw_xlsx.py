#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成测试用承保台账 xlsx（手写 OOXML，不依赖 openpyxl/LibreOffice）

刻意覆盖解析器的各个难点：
  · 前导标题行 + 真正的表头不在第 1 行
  · 中文共享字符串（含特殊字符、逗号、引号）
  · 日期列（Excel 序列值 + 日期 numFmt）
  · 千分位数字、"1.2万" 这类写法
  · 缺经纬度、只有县名的行
  · 尾部空行与全空行
"""
import zipfile, os, sys

OUT = sys.argv[1] if len(sys.argv) > 1 else '承保台账_测试.xlsx'

# 共享字符串表
SST = [
    '阳光财产保险股份有限公司',
    '2026年种植业保险承保明细台账（内部测试样本）',
    '保单号', '被保险人', '身份证号', '作物',     '承保面积(亩)', '保额(元)', '保费(元)',
    '乡镇', '行政村', '县', '经度', '纬度', '起保日期', '备注', '承保方式',
    '张建国', '李桂兰', '王志强', '陈美华', '刘德胜', '赵春香', '孙国平', '周淑珍',
    '水稻', '小麦', '玉米', '油菜', '棉花', '大豆',
    '黄梅县', '小池镇', '下新镇', '大河镇', '蔡山镇', '苦竹乡', '濯港镇',
    '英山县', '温泉镇', '东久草镇',
    '监利县', '容城镇', '红城乡', '汪集镇',
    '一季水稻',
    '政策性种植险', '商业性种植险',
    '联���共保体', '完全自营', '政府委托',
    '2026-01-05', '2026-02-15', '2026-03-01', '2026-04-10',
    '张,建国', '备注：含"引号"与逗号的测试',
    '单位：亩 / 元    制表：业务部    导出日期：2026-10-01',
]
S_INDEX = {s: i for i, s in enumerate(SST)}

def esc(s):
    return (s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))

def col_letter(i):
    s = ''
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s

# 行数据：(值, 类型, 日期格式)
# 类型: 's'=共享字符串 'n'=数字 'd'=日期(序列号)
def S(v): return (v, 's', False)
def N(v): return (v, 'n', False)
def D(v): return (v, 'd', True)

ROWS = [
    # 前导说明行（只有一两个单元格，表头定位应跳过）
    [S('阳光财产保险股份有限公司'), None, None, None, None, None],
    [S('2026年种植业保险承保明细台账（内部测试样本）'), None, None, None, None, None],
    [S('单位：亩 / 元    制表：业务部    导出日期：2026-10-01'), None, None, None, None, None],
    # 真正的表头（第 4 行）
    [S('保单号'), S('被保险人'), S('身份证号'), S('作物'), S('承保面积(亩)'), S('保额(元)'),
     S('保费(元)'), S('乡镇'), S('行政村'), S('县'), S('经度'), S('纬度'), S('起保日期'),
     S('备注'), S('承保方式')],
]

DATA = [
    ['PD20264200001', '张建国', '420106196203151234', '水稻', 850.5, 680000, 47600, '小池镇', '小池村', '黄梅县', 115.869, 29.956, '2026-01-05', '一季水稻', '政策性种植险'],
    ['PD20264200002', '李桂兰', '420106195811206022', '水稻', 620, 496000, 34720, '小池镇', '刘家村', '黄梅县', 115.951, 30.014, '2026-01-05', '一季水稻', '政策性种植险'],
    ['PD20264200003', '王志强', '420106197507024455', '小麦', 430.8, 215000, 12900, '下新镇', '张塘村', '黄梅县', 116.012, 30.073, '2026-01-05', '完全自营', '商业性种植险'],
    ['PD20264200004', '陈美华', '420106198303128877', '油菜', 1.2, 312000, 21840, '大河镇', '大河村', '黄梅县', 115.91, 30.132, '2026-02-15', '', '完全自营'],
    ['PD20264200005', '刘德胜', '420106196609304488', '水稻', 1560, 1248000, 87360, '蔡山镇', '蔡山村', '黄梅县', 115.869, 29.956, '2026-01-05', '一季水稻', '政府委托'],
    ['PD20264200006', '赵春香', '420106197211156611', '棉花', 275, 330000, 24750, '苦竹乡', '苦竹村', '黄梅县', 115.951, 30.014, '2026-03-01', '', '政策性种植险'],
    ['PD20264200007', '孙国平', '420106199001017799', '玉米', 88, 52800, 3696, '濯港镇', '濯港村', '黄梅县', 116.012, 30.073, '2026-01-05', '', '完全自营'],
    ['PD20264200008', '周淑珍', '420106196904193344', '水稻', 2030.6, 1624480, 113713, '小池镇', '新港村', '黄梅县', 115.91, 30.132, '2026-01-05', '一季水稻', '政府委托'],
    # 英山县
    ['PD20264210009', '张建国', '420623196203151234', '水稻', 640, 512000, 35840, '温泉镇', '温泉村', '英山县', 115.727, 30.768, '2026-01-05', '一季水稻', '政策性种植险'],
    ['PD20264210010', '李桂兰', '420623195811206022', '小麦', 380, 190000, 11400, '东久草镇', '东久草村', '英山县', 115.833, 30.832, '2026-01-05', '', '完全自营'],
    # 监利县
    ['PD20264220011', '王志强', '420623197507024455', '水稻', 1180, 944000, 66080, '容城镇', '容城村', '监利市', 112.851, 29.737, '2026-01-05', '一季水稻', '政策性种植险'],
    ['PD20264220012', '陈美华', '420623198303128877', '大豆', 420, 210000, 12600, '红城乡', '红城村', '监利市', 112.995, 29.813, '2026-01-05', '', '完全自营'],
    ['PD20264220013', '刘德胜', '420623196609304488', '水稻', 760, 608000, 42560, '汪集镇', '汪集村', '监利市', 113.103, 29.89, '2026-01-05', '一季水稻', '政府委托'],
    # 特殊字符行：含逗号与引号
    ['PD20264200014', '张,建国', '420106196203159876', '水稻', 300, 240000, 16800, '小池镇', '刘家村', '黄梅县', 115.91, 30.132, '2026-01-05', '备注：含"引号"与逗号的测试', '完全自营'],
    # 缺经纬度（应有经纬度的县名仍可落图）
    ['PD20264200015', '赵春香', '420106197211151234', '小麦', 210, 105000, 6300, '蔡山镇', '大岭村', '黄梅县', '', '', '2026-01-05', '', '政策性种植险'],
    # 千分位写法
    ['PD20264200016', '孙国平', '420106199001017222', '油菜', 520, 260000, 18200, '大河镇', '金关村', '黄梅县', 115.951, 30.014, '2026-02-15', '', '完全自营'],
]

# Excel 日期序列号（1900 系统，基准 1899-12-30）
def serial(iso):
    y, m, d = [int(x) for x in iso.split('-')]
    # 简化：用 datetime 计算天数
    import datetime
    dt = datetime.date(y, m, d)
    base = datetime.date(1899, 12, 30)
    return (dt - base).days

sheet_rows_xml = []
# 数字样式表：style 1 = 日期，style 2 = 普通
for ri, row in enumerate(ROWS):
    cells = []
    for ci, cell in enumerate(row):
        if cell is None:
            continue
        ref = col_letter(ci) + str(ri + 1)
        val, typ, isdate = cell
        if typ == 's':
            cells.append('<c r="%s" t="s"><v>%d</v></c>' % (ref, S_INDEX[val]))
        elif isdate:
            cells.append('<c r="%s" s="1"><v>%d</v></c>' % (ref, serial(val)))
        else:
            cells.append('<c r="%s" s="2"><v>%s</v></c>' % (ref, val))
    sheet_rows_xml.append('<row r="%d">%s</row>' % (ri + 1, ''.join(cells)))

# 数据行
for di, row in enumerate(DATA):
    cells = []
    for ci, v in enumerate(row):
        ref = col_letter(ci) + str(len(ROWS) + di + 1)
        if v == '' or v is None:
            cells.append('<c r="%s"/>' % ref)
        elif isinstance(v, (int, float)):
            cells.append('<c r="%s" s="2"><v>%s</v></c>' % (ref, v))
        elif v in S_INDEX:
            cells.append('<c r="%s" t="s"><v>%d</v></c>' % (ref, S_INDEX[v]))
        else:
            # 保单号这类不该进共享字符串表的，直接用内联字符串
            cells.append('<c r="%s" t="inlineStr"><is><t>%s</t></is></c>' % (ref, esc(v)))
    sheet_rows_xml.append('<row r="%d">%s</row>' % (len(ROWS) + di + 1, ''.join(cells)))

# 尾部空行 + 全空行（验证过滤）
sheet_rows_xml.append('<row r="%d"><c r="A%d"/></row>' % (len(ROWS) + len(DATA) + 1, len(ROWS) + len(DATA) + 1))
sheet_rows_xml.append('<row r="%d"><c r="A%d"/><c r="B%d"/></row>' % (
    len(ROWS) + len(DATA) + 2, len(ROWS) + len(DATA) + 2, len(ROWS) + len(DATA) + 2))

ncols = 15
nrows = len(ROWS) + len(DATA) + 2
sheet = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    '<dimension ref="A1:%s%d"/>'
    '<sheetData>%s</sheetData>'
    '</worksheet>'
) % (col_letter(ncols - 1), nrows, ''.join(sheet_rows_xml))

shared = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="%d" uniqueCount="%d">'
    '%s</sst>'
) % (len(SST), len(SST), ''.join('<si><t xml:space="preserve">%s</t></si>' % esc(s) for s in SST))

# styles：xf#0 默认，xf#1 日期(numFmtId 14)，xf#2 常规
styles = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    '<numFmts count="0"/>'
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
    '<borders count="1"><border/></borders>'
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    '<cellXfs count="3">'
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    '</cellXfs>'
    '</styleSheet>'
)

workbook = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    '<sheets><sheet name="承保明细" sheetId="1" r:id="rId1"/></sheets>'
    '</workbook>'
)

wb_rels = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    '</Relationships>'
)

root_rels = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    '</Relationships>'
)

ct = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    '</Types>'
)

with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', ct)
    z.writestr('_rels/.rels', root_rels)
    z.writestr('xl/workbook.xml', workbook)
    z.writestr('xl/_rels/workbook.xml.rels', wb_rels)
    z.writestr('xl/styles.xml', styles)
    z.writestr('xl/sharedStrings.xml', shared)
    z.writestr('xl/worksheets/sheet1.xml', sheet)

print('✅ 已生成 %s（%d 行数据 / %d 列表头）' % (OUT, len(DATA), len(ROWS[3])))
