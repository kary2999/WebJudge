"""
build_manual.py — 生成 Judge 扩展的"用户手册"PDF。
跑法:
  /tmp/judge-pdf-venv/bin/python docs/build_manual.py
或在虚拟环境里:
  python -m venv .venv && source .venv/bin/activate && pip install reportlab
  python docs/build_manual.py
产物:docs/Judge使用手册.pdf
"""
from __future__ import annotations
import os
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, PageBreak,
    Table, TableStyle, Image, KeepTogether, NextPageTemplate,
    ListFlowable, ListItem,
)
from reportlab.platypus.flowables import HRFlowable

# ---------- 字体 ----------
# CID 字体内置在 reportlab,不用打包额外文件,绝大多数 PDF 阅读器都能正常渲染中文
# reportlab 内置 CID 字体,跨平台稳定。只用宋体一种 —— 用字号/颜色做层级
pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
ZH_BODY = 'STSong-Light'
ZH_BOLD = 'STSong-Light'  # 同字体,通过字号区分标题

# ---------- 颜色 ----------
PRIMARY = HexColor('#1f883d')
ACCENT  = HexColor('#0969da')
WARN    = HexColor('#bf8700')
ERROR   = HexColor('#cf222e')
TEXT    = HexColor('#1f2328')
MUTED   = HexColor('#57606a')
BG_SOFT = HexColor('#f6f8fa')
BORDER  = HexColor('#d0d7de')

# ---------- 样式 ----------
def make_styles():
    styles = getSampleStyleSheet()
    # 覆盖默认
    styles.add(ParagraphStyle(
        'ZH-Title', fontName=ZH_BOLD, fontSize=26, leading=34,
        textColor=TEXT, alignment=TA_LEFT, spaceAfter=8,
    ))
    styles.add(ParagraphStyle(
        'ZH-Subtitle', fontName=ZH_BODY, fontSize=12, leading=18,
        textColor=MUTED, alignment=TA_LEFT, spaceAfter=20,
    ))
    styles.add(ParagraphStyle(
        'ZH-H1', fontName=ZH_BOLD, fontSize=18, leading=26,
        textColor=TEXT, alignment=TA_LEFT, spaceBefore=16, spaceAfter=8,
    ))
    styles.add(ParagraphStyle(
        'ZH-H2', fontName=ZH_BOLD, fontSize=14, leading=20,
        textColor=TEXT, alignment=TA_LEFT, spaceBefore=10, spaceAfter=4,
    ))
    styles.add(ParagraphStyle(
        'ZH-Body', fontName=ZH_BODY, fontSize=10.5, leading=18,
        textColor=TEXT, alignment=TA_LEFT, spaceAfter=4,
    ))
    styles.add(ParagraphStyle(
        'ZH-BodyMuted', fontName=ZH_BODY, fontSize=10, leading=16,
        textColor=MUTED, alignment=TA_LEFT, spaceAfter=4,
    ))
    styles.add(ParagraphStyle(
        'ZH-Bullet', fontName=ZH_BODY, fontSize=10.5, leading=18,
        textColor=TEXT, alignment=TA_LEFT, leftIndent=14, bulletIndent=2,
    ))
    styles.add(ParagraphStyle(
        'ZH-Step', fontName=ZH_BODY, fontSize=11, leading=20,
        textColor=TEXT, alignment=TA_LEFT, leftIndent=22, spaceAfter=2,
    ))
    styles.add(ParagraphStyle(
        'ZH-Footer', fontName=ZH_BODY, fontSize=8.5, leading=12,
        textColor=MUTED, alignment=TA_CENTER,
    ))
    styles.add(ParagraphStyle(
        'ZH-Code', fontName='Courier', fontSize=10, leading=14,
        textColor=TEXT, backColor=BG_SOFT, borderColor=BORDER,
        borderPadding=4, borderWidth=0.5, leftIndent=4, spaceAfter=6,
    ))
    return styles

# ---------- 页面模板:页眉 + 页脚 ----------
def header_footer(canvas, doc):
    canvas.saveState()
    # 页眉:左小标 + 右版本(去掉 emoji,改用色块标识)
    canvas.setFillColor(PRIMARY)
    canvas.rect(20 * mm, A4[1] - 12.5 * mm, 3, 4 * mm, fill=1, stroke=0)
    canvas.setFont(ZH_BODY, 8.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(24 * mm, A4[1] - 12 * mm, 'Judge  |  页面性能体检  |  用户手册')
    canvas.drawRightString(A4[0] - 20 * mm, A4[1] - 12 * mm, 'v0.9.x')
    # 页眉底部细线
    canvas.setStrokeColor(BORDER)
    canvas.setLineWidth(0.4)
    canvas.line(20 * mm, A4[1] - 14 * mm, A4[0] - 20 * mm, A4[1] - 14 * mm)
    # 页脚页码
    canvas.drawCentredString(A4[0] / 2, 10 * mm, f'— {doc.page} —')
    canvas.restoreState()

def cover_decorations(canvas, doc):
    """封面页不绘页眉,只绘装饰"""
    canvas.saveState()
    # 顶部色块
    canvas.setFillColor(PRIMARY)
    canvas.rect(0, A4[1] - 50 * mm, A4[0], 50 * mm, fill=1, stroke=0)
    canvas.setFillColor(HexColor('#ffffff'))
    canvas.setFont(ZH_BOLD, 36)
    canvas.drawString(25 * mm, A4[1] - 30 * mm, 'Judge 使用手册')
    canvas.setFont(ZH_BODY, 13)
    canvas.drawString(25 * mm, A4[1] - 40 * mm, '页面性能体检  |  大白话版')
    # 底部小信息
    canvas.setFillColor(MUTED)
    canvas.setFont(ZH_BODY, 9)
    canvas.drawString(25 * mm, 18 * mm, '本手册写给非技术同事 / 不需要看懂代码')
    canvas.drawRightString(A4[0] - 25 * mm, 18 * mm, '装一次,长期用')
    canvas.restoreState()

# ---------- 工具:做漂亮的标题块 ----------
def section_title(text, style):
    """左侧带绿色色条的 H1"""
    tbl = Table(
        [[Paragraph(text, style)]],
        colWidths=[170 * mm],
        rowHeights=[None],
    )
    tbl.setStyle(TableStyle([
        ('LEFTPADDING', (0, 0), (-1, -1), 10),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LINEBEFORE', (0, 0), (0, -1), 4, PRIMARY),
    ]))
    return tbl

def callout(text, level='info', styles=None):
    """提示框:info / warn / error 三种"""
    color_map = {
        'info':  (HexColor('#ddf4ff'), ACCENT),
        'warn':  (HexColor('#fff8c5'), WARN),
        'error': (HexColor('#ffebe9'), ERROR),
        'good':  (HexColor('#dafbe1'), PRIMARY),
    }
    bg, fg = color_map.get(level, color_map['info'])
    p = Paragraph(text, styles['ZH-Body'])
    tbl = Table([[p]], colWidths=[170 * mm])
    tbl.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), bg),
        ('LEFTPADDING', (0, 0), (-1, -1), 10),
        ('RIGHTPADDING', (0, 0), (-1, -1), 10),
        ('TOPPADDING', (0, 0), (-1, -1), 8),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
        ('LINEBEFORE', (0, 0), (0, -1), 3, fg),
    ]))
    return tbl

def kv_table(rows, col_widths=(50 * mm, 120 * mm), styles=None):
    """两列键值表"""
    cells = []
    for k, v in rows:
        cells.append([
            Paragraph(k, styles['ZH-BodyMuted']),
            Paragraph(v, styles['ZH-Body']),
        ])
    tbl = Table(cells, colWidths=list(col_widths))
    tbl.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 4),
        ('RIGHTPADDING', (0, 0), (-1, -1), 4),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LINEBELOW', (0, 0), (-1, -2), 0.3, BORDER),
    ]))
    return tbl

def step_box(num, title, body_paras, styles):
    """步骤块:左上角圆形数字"""
    num_para = Paragraph(
        f'<font name="{ZH_BOLD}" color="#ffffff" size="14">{num}</font>',
        styles['ZH-Body'],
    )
    num_cell = Table([[num_para]], colWidths=[10 * mm], rowHeights=[10 * mm])
    num_cell.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (0, 0), PRIMARY),
        ('VALIGN', (0, 0), (0, 0), 'MIDDLE'),
        ('ALIGN', (0, 0), (0, 0), 'CENTER'),
        ('LEFTPADDING', (0, 0), (0, 0), 0),
        ('RIGHTPADDING', (0, 0), (0, 0), 0),
        ('TOPPADDING', (0, 0), (0, 0), 0),
        ('BOTTOMPADDING', (0, 0), (0, 0), 0),
        ('ROUNDEDCORNERS', [5, 5, 5, 5]),
    ]))
    title_para = Paragraph(f'<font size="13">{title}</font>', styles['ZH-H2'])
    body = []
    for p in body_paras:
        body.append(Paragraph(p, styles['ZH-Step']))
    head = Table([[num_cell, title_para]], colWidths=[14 * mm, 156 * mm])
    head.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('TOPPADDING', (0, 0), (-1, -1), 0),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
    ]))
    flow = [head]
    for b in body:
        flow.append(b)
    flow.append(Spacer(1, 6))
    return KeepTogether(flow)

# ---------- 文档构建 ----------
def build(out_path):
    doc = BaseDocTemplate(
        out_path, pagesize=A4,
        leftMargin=20 * mm, rightMargin=20 * mm,
        topMargin=22 * mm, bottomMargin=18 * mm,
        title='Judge 使用手册',
        author='Judge 扩展开发团队',
    )
    frame_normal = Frame(
        doc.leftMargin, doc.bottomMargin,
        doc.width, doc.height,
        leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0,
    )
    frame_cover = Frame(
        25 * mm, 30 * mm, A4[0] - 50 * mm, A4[1] - 90 * mm,
        leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0,
    )
    doc.addPageTemplates([
        PageTemplate(id='cover',  frames=frame_cover,  onPage=cover_decorations),
        PageTemplate(id='normal', frames=frame_normal, onPage=header_footer),
    ])

    styles = make_styles()
    story = []

    # ============ 封面页 ============
    story.append(Spacer(1, 30 * mm))
    story.append(Paragraph(
        '<font size="13">一句话:</font><br/><br/>'
        '<font size="14" color="#1f2328">当后台系统卡的时候,装这个扩展,点一下,'
        '就能告诉开发同学<font color="#1f883d">具体哪里慢</font>。</font>',
        styles['ZH-Body']
    ))
    story.append(Spacer(1, 10 * mm))
    story.append(callout(
        '<font size="12" color="#1a7f37">不需要懂技术。</font>'
        '你只需要做三件事:打开扩展、点一下、把生成的 PDF 发给开发。剩下的让 Judge 帮你说话。',
        level='good', styles=styles
    ))
    story.append(Spacer(1, 14 * mm))
    story.append(Paragraph('<font size="14">这本手册讲什么?</font>', styles['ZH-H2']))
    toc_rows = [
        ('1', '为什么要装这个 — 它替你解决什么麻烦'),
        ('2', '怎么装 — 三步搞定,不需要管理员权限'),
        ('3', '怎么用 — 每次提 bug 时该按什么'),
        ('4', '看报告 — 几个数字怎么读'),
        ('5', '常见问题 — 装不上 / 没数据 / 弹窗空白'),
        ('6', '隐私和安全 — 这个东西会上传我的数据吗'),
    ]
    toc_data = [[Paragraph(f'<font color="#1f883d" size="12">{n}</font>', styles['ZH-Body']),
                 Paragraph(t, styles['ZH-Body'])] for n, t in toc_rows]
    toc = Table(toc_data, colWidths=[10 * mm, 150 * mm])
    toc.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]))
    story.append(toc)

    story.append(NextPageTemplate('normal'))
    story.append(PageBreak())

    # ============ 1. 它替你解决什么麻烦 ============
    story.append(section_title('1. 为什么要装这个', styles['ZH-H1']))
    story.append(Paragraph('你有没有遇到过这种情况:', styles['ZH-Body']))
    story.append(Spacer(1, 4))
    bullets = [
        '"系统好慢啊!"—— 但具体哪个页面、哪个按钮、慢在哪一步,自己说不清',
        '开发问"什么时候慢?网络情况?浏览器?你打开了多少标签?",一连串问题答不上来',
        '截屏发过去,开发说"看不出问题",最后不了了之',
        '同事 A 说快、同事 B 说慢,搞不清是不是真的慢,还是个别人的网不好',
    ]
    for b in bullets:
        story.append(Paragraph(f'<font color="#1f883d">●</font>  {b}', styles['ZH-Bullet']))
    story.append(Spacer(1, 8))
    story.append(callout(
        '<font size="12" color="#0969da">Judge 就是来解决这个的。</font>'
        '它在你浏览器里默默看每个接口请求多慢、什么原因慢,等你点一下,'
        '就生成一份"开发能直接拿去查问题"的报告。'
        '你不用懂任何技术词汇 —— 报告里写的是大白话,加上原始数据。',
        level='info', styles=styles
    ))
    story.append(Spacer(1, 8))
    story.append(Paragraph('<font size="14">它能告诉你:</font>', styles['ZH-H2']))
    capabilities = [
        ('哪些接口最慢',     '按耗时倒序排队,一眼看到 Top'),
        ('为什么慢',         '后端慢、网络慢、还是浏览器自己的问题,自动判断'),
        ('网络环境如何',     '0-100 给你网络打分,差到一定程度直接告诉你"是你网慢"'),
        ('哪些接口出错了',  'HTTP 返回码异常 + 响应里业务 status 异常,都抓出来'),
        ('一份完整报告',    'PDF / 网页两种格式,直接发开发或贴工单'),
    ]
    story.append(kv_table(capabilities, styles=styles))

    story.append(PageBreak())

    # ============ 2. 怎么装 ============
    story.append(section_title('2. 怎么装(只装一次,大约 1 分钟)', styles['ZH-H1']))
    story.append(callout(
        '装之前先确认:你用的是 <font color="#0969da" size="12">Chrome 浏览器</font>'
        '(或基于 Chromium 的 Edge / Brave / Arc 也行),不需要管理员权限,不需要联网下载。',
        level='info', styles=styles
    ))
    story.append(Spacer(1, 8))

    story.append(step_box(1, '解压', [
        '收到的是一个 zip 文件,文件名形如 <font color="#0969da">judge-vX.Y.Z.zip</font>。',
        '右键 → 解压,会得到一个同名文件夹。',
        '<font color="#1f883d" size="12">建议:</font> 解压到 <font name="Courier">~/Documents/Judge/</font> 这种你不会误删的位置。'
        '<font color="#cf222e">删了文件夹扩展就失效了。</font>',
    ], styles))

    story.append(step_box(2, '打开扩展管理页', [
        '在 Chrome 地址栏粘贴下面这一行,回车:',
        '<font name="Courier" color="#0969da" size="12">chrome://extensions/</font>',
    ], styles))

    story.append(step_box(3, '开启"开发者模式"', [
        '页面<font color="#1f883d" size="12">右上角</font>有个开关叫"开发者模式"(Developer mode),点亮它。',
        '亮了之后,页面左上角会出现 3 个新按钮。',
    ], styles))

    story.append(step_box(4, '加载扩展', [
        '点 <font color="#1f883d" size="12">"加载已解压的扩展程序"</font>(英文 Load unpacked),'
        '在弹出的文件夹选择器里,选刚才解压出来的文件夹 → 确定。',
        '加载成功后,扩展列表里会出现一张名为 <font color="#0969da" size="12">"Judge 页面性能体检"</font> '
        '的卡片,带一个圆形放大镜图标。',
    ], styles))

    story.append(step_box(5, '固定到工具栏(强烈建议)', [
        '点 Chrome 右上角的 拼图图标(扩展菜单)→ 找到 Judge → 点旁边的图钉图标。',
        '搞定!以后这个放大镜图标就一直在工具栏上,点一下就能用。',
    ], styles))

    story.append(callout(
        '装完后第一次打开 Chrome 可能会弹"关闭开发者模式扩展"的红色提醒 —— 这是 Chrome 的正常机制,'
        '点取消 / 关闭即可,不影响使用。',
        level='warn', styles=styles
    ))

    story.append(PageBreak())

    # ============ 3. 怎么用 ============
    story.append(section_title('3. 怎么用(每次提 bug 大约 30 秒)', styles['ZH-H1']))
    story.append(Paragraph('典型场景:某个后台页面打开慢、查询慢、列表加载半天 —— 这时候:', styles['ZH-Body']))
    story.append(Spacer(1, 6))

    story.append(step_box(1, '先刷新一下页面', [
        '按 F5 或者 Cmd+R 刷新一次。',
        '<font color="#bf8700" size="12">为什么要刷新?</font> Judge 需要在页面打开'
        '<font color="#cf222e">之前</font>就开始监听才能抓到完整数据。'
        '如果你先打开页面、再装扩展或才想到要用,先前的请求 Judge 没看到,数据就不全。',
    ], styles))

    story.append(step_box(2, '正常做你觉得慢的操作', [
        '该点按钮就点按钮,该切 tab 就切 tab,该等就等。',
        'Judge 在背后默默记录,不会影响速度。',
    ], styles))

    story.append(step_box(3, '点扩展图标', [
        '工具栏右上角那个圆形放大镜,点它。',
        '弹出一个小窗,里面有<font color="#0969da" size="12">三块信息</font>:'
        '网络评分(给你的网络打分)、Web Vitals(用户体验指标)、最慢接口 Top 5。',
    ], styles))

    story.append(step_box(4, '决定怎么交给开发', [
        '<font color="#1f883d" size="12">方法 A · 最省事:</font> 点底部 '
        '<font color="#0969da">"复制摘要"</font> → 粘贴到工单 / 群聊。',
        '<font color="#1f883d" size="12">方法 B · 完整数据:</font> 点底部 '
        '<font color="#0969da">"下载 PDF 报告"</font> → 文件存到下载文件夹 → 上传到工单或发给开发。',
        '<font color="#1f883d" size="12">方法 C · 互动查看:</font> 点 '
        '<font color="#0969da">"查看完整报告"</font> 会打开新标签页,'
        '里面有所有接口的详情、响应体、可点击展开。问题定位时开发会喜欢这个。',
    ], styles))

    story.append(Spacer(1, 8))
    story.append(callout(
        '<font color="#0969da" size="12">什么时候点"实测 RTT"按钮?</font>'
        ' 当你怀疑"是不是我网慢"的时候。它会真实地对当前网站发 6 个小请求,'
        '量出你的网络到这个网站的延迟。结果会写进网络评分里。',
        level='info', styles=styles
    ))
    story.append(Spacer(1, 4))
    story.append(callout(
        '<font color="#0969da" size="12">什么时候点"实测各域名"?</font>'
        ' 当报告里出现"网络拥塞"标签,你想知道是哪个 API 域名慢的时候。'
        '它会逐个 ping 页面用到的所有后端域名,给每个打个 GOOD/FAIR/POOR 标签。',
        level='info', styles=styles
    ))

    story.append(PageBreak())

    # ============ 4. 看报告 ============
    story.append(section_title('4. 报告里的字怎么读', styles['ZH-H1']))
    story.append(Paragraph('打开 Judge 的弹窗或下载的 PDF,会看到几个区块。每个的意思如下:', styles['ZH-Body']))
    story.append(Spacer(1, 6))

    story.append(Paragraph('<font size="14">网络评分 0-100 分</font>', styles['ZH-H2']))
    score_rows = [
        ('<font color="#1a7f37" size="12">80-100</font>',  '网络好,慢锅不在你这'),
        ('<font color="#1a7f37" size="12">65-79</font>',   '良好,小问题不至于卡'),
        ('<font color="#bf8700" size="12">50-64</font>',   '一般,可能影响体验'),
        ('<font color="#cf222e" size="12">0-49</font>',    '差,八成是你的网卡 —— 优先排查 WiFi / 切有线 / 换网络环境'),
    ]
    story.append(kv_table(score_rows, col_widths=(28 * mm, 142 * mm), styles=styles))

    story.append(Spacer(1, 8))
    story.append(Paragraph('<font size="14">体验指标(用户能感知的)</font>', styles['ZH-H2']))
    vitals_rows = [
        ('首屏主内容出现',   '从打开页面到看到主要东西,一般 &lt; 2.5 秒算正常'),
        ('页面开始出内容',   '浏览器第一次画出任何东西的时间'),
        ('页面抖动',         '页面元素是否乱跳(比如图片加载完把按钮挤下去)'),
        ('点击反应速度',     '点按钮到界面真正响应的时间'),
        ('服务器响应速度',   '浏览器发请求到服务器返回第一个字节的时间'),
        ('主线程卡顿',      'JS 长任务次数,&gt; 5 次说明明显卡顿'),
    ]
    story.append(kv_table(vitals_rows, col_widths=(40 * mm, 130 * mm), styles=styles))

    story.append(Spacer(1, 8))
    story.append(Paragraph('<font size="14">慢接口标签(看到这些就知道谁的锅)</font>', styles['ZH-H2']))
    label_rows = [
        ('后端慢',         '<font color="#cf222e">真后端慢。</font>找后端同事查 SQL/缓存/索引'),
        ('网络拥塞',       '<font color="#e16100">网络问题。</font>跨地域、运营商、机房带宽,运维处理'),
        ('首次连接慢',     '<font color="#b35900">DNS 或建连慢。</font>多刷一次通常会缓解'),
        ('被浏览器排队',   '<font color="#9a6700">前端并发太多。</font>找前端同事调'),
        ('响应过大',       '<font color="#0969da">数据传太大。</font>让后端瘦身或前端分页'),
        ('混合',           '没有单一原因占主导,综合表现差'),
    ]
    story.append(kv_table(label_rows, col_widths=(35 * mm, 135 * mm), styles=styles))

    story.append(Spacer(1, 8))
    story.append(callout(
        '<font color="#cf222e" size="12">看到"业务层失败"区块要警惕!</font> '
        '这是 HTTP 返回 200(看着正常)但响应里业务 status 不为 0(实际挂了)的接口。'
        '日常 HTTP 监控最容易漏报这种。把这块发给开发是最高优先级。',
        level='error', styles=styles
    ))

    story.append(PageBreak())

    # ============ 5. 常见问题 ============
    story.append(section_title('5. 常见问题 FAQ', styles['ZH-H1']))

    faqs = [
        ('Q1', '点扩展图标,弹窗是空的 / 提示"无法注入脚本"',
         '当前页可能是 chrome:// 内置页 / 扩展商店页 / 新标签页 —— 这些受保护,扩展不能进去。'
         '换一个普通业务页面再试。'),
        ('Q2', '弹窗显示"捕获响应体: 0 个"',
         '说明你打开页面之后才装的扩展,Judge 没赶上之前的请求。'
         '<font color="#1f883d" size="12">刷新一次页面</font>就好。'),
        ('Q3', '"查看完整报告"打开后是空白 / 报错',
         '0.8.1 之前的版本有竞态 bug,需要点 4-5 次。0.8.1+ 已修复。'
         '如果还遇到,刷新报告页或重新点扩展弹窗的"查看完整报告"。'),
        ('Q4', '"下载 PDF 报告" 卡住 / 报"PDF 生成失败"',
         '可能是页面有非常多的请求(几千个),生成会慢一点 —— 等 5-10 秒。'
         '如果失败,试一下"复制摘要"或"查看完整报告",这两个数据是一样的。'),
        ('Q5', 'Chrome 一打开就弹红色"关闭开发者模式扩展"',
         '这是 Chrome 自己的提醒,不是 Judge 的问题。每次开 Chrome 弹一次,'
         '点"取消"忽略即可。如果太烦,让公司 IT 帮你通过企业策略白名单预装。'),
        ('Q6', '后台是 iframe 架构,Judge 显示的接口很少 / 不全',
         'v0.9.0 已经修了 —— 默认会捕获所有 iframe 里的接口。'
         '如果你用的是更早的版本,升级一下 zip。'),
        ('Q7', '怎么更新到新版?',
         '收到新 zip → 解压覆盖原文件夹 → 在 chrome://extensions/ 找到 Judge 卡片点刷新按钮即可。'
         '<font color="#1f883d" size="12">不需要</font>移除再重装。'),
        ('Q8', '能装在工作电脑上吗?会被 IT 拦吗?',
         'Judge 是本地扩展,不连任何外部服务器,不会被 IT 阻拦('
         '除非你公司 IT 全局禁止"开发者模式扩展",这种情况联系 IT 申请白名单)。'),
        ('Q9', '同一个慢页面,我和同事看到的报告差异很大?',
         '正常的 —— 你们两个的网络环境、浏览器、缓存状态、操作顺序都不同。'
         '<font color="#0969da" size="12">互相比较的关键</font>'
         '是看"网络评分"和"主要慢标签",而不是绝对时间。'),
        ('Q10', '能批量分析多个页面吗?',
         '目前一次只分析当前标签页。如果需要长期监控,联系开发同学定制。'),
    ]
    for q, title, ans in faqs:
        block = [
            Paragraph(f'<font color="#1f883d" size="12">{q}.</font> '
                      f'<font size="13" color="#1f2328">{title}</font>',
                      styles['ZH-H2']),
            Paragraph(ans, styles['ZH-Body']),
            Spacer(1, 4),
        ]
        story.append(KeepTogether(block))

    story.append(PageBreak())

    # ============ 6. 隐私和安全 ============
    story.append(section_title('6. 隐私和安全', styles['ZH-H1']))
    story.append(Paragraph('这一定是公司同事最关心的问题。直接回答:', styles['ZH-Body']))
    story.append(Spacer(1, 6))

    privacy_rows = [
        ('数据发到哪里去?',   '<font color="#1a7f37" size="12">不发任何地方。</font>所有分析在你浏览器本地完成。'
                              '关闭标签数据就释放,关掉浏览器全部清空。'),
        ('需要联网吗?',       '<font color="#1a7f37" size="12">除了公网 IP 查询(用于 PDF 水印,可选),其它全离线。</font>'
                              '断网也能用 —— 只是没法在 PDF 上盖你的 IP 而已。'),
        ('需要登录吗?',       '<font color="#1a7f37" size="12">不需要登录任何账号。</font>装上即用。'),
        ('我点"复制摘要"后呢?', '内容进了你的剪贴板,你<font color="#cf222e" size="12">主动</font>'
                              '粘贴到哪里它就在哪里。你不粘贴就什么都没发生。'),
        ('请求的权限多吗?',    '6 个最小权限:读当前标签 / 注入脚本 / 读存储 / 写剪贴板 / 触发下载 / 匹配所有网址。'
                              '没有"读历史"、没有"读 cookie"、没有"修改请求"。'),
        ('看不到我的密码吗?',   '<font color="#1a7f37" size="12">看不到。</font>Judge 不读 form 表单,不解析 cookie,'
                              '不接触你输入的任何敏感信息。它只看请求的 URL、状态码、耗时、响应体。'),
        ('响应体会不会泄露公司数据?',
            'PDF 里包含"业务层失败"接口的响应体(为了让开发定位 bug)。'
            '<font color="#cf222e" size="12">你下载的 PDF 在你电脑上 —— 你决定发给谁。</font>'
            '如果某个接口响应敏感,你可以选"复制摘要"路径,摘要里不含响应体。'),
        ('代码可审计吗?',     '<font color="#1a7f37" size="12">可以。</font>Judge 是 Chrome 扩展,'
                              '解压后所有代码都是明文 .js 文件,你或公司安全团队可以随时审。'),
    ]
    story.append(kv_table(privacy_rows, col_widths=(50 * mm, 120 * mm), styles=styles))

    story.append(Spacer(1, 12))
    story.append(callout(
        '<font color="#1a7f37" size="12">一句话总结:</font>Judge 是一个本地工具,不会偷你的数据,'
        '所有信息只有你<font color="#cf222e" size="12">主动复制 / 下载</font>后才离开你的电脑。',
        level='good', styles=styles
    ))

    story.append(Spacer(1, 16))
    story.append(HRFlowable(width='100%', color=BORDER, thickness=0.5))
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        '<font color="#1f883d" size="11">需要帮助?</font> 直接联系给你 zip 文件的开发同学。'
        '文档版本会跟扩展版本一起更新,建议每次拿新版 zip 时同时拿新版手册。',
        styles['ZH-BodyMuted']
    ))

    doc.build(story)

if __name__ == '__main__':
    repo = Path(__file__).resolve().parent.parent
    out = repo / 'docs' / 'Judge使用手册.pdf'
    build(str(out))
    print(f'OK: {out}  ({out.stat().st_size // 1024} KB)')
