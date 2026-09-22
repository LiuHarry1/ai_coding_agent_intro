"""Build the two-section Coding Agent deck, in Chinese and English.

Section 01 covers what the agent can do; section 02 covers architecture and the
implementation details behind it. Both are also real PowerPoint sections, so the
split shows up in the slide navigator.

Content is sourced from docs/architecture/, docs/features/, docs/readme/ and
src/. Layout lives in the helpers and slide builders; all copy lives in CONTENT.
"""

from pathlib import Path
from uuid import uuid4
from xml.sax.saxutils import escape

from lxml import etree
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.dml import MSO_LINE_DASH_STYLE
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Inches, Pt

ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "presentation"
OUTPUTS = {
    "zh": OUTPUT_DIR / "Coding_Agent_Overview_And_Architecture.pptx",
    "en": OUTPUT_DIR / "Coding_Agent_Overview_And_Architecture_EN.pptx",
}

# Latin face for code/labels, East-Asian face for the Chinese body text.
FONT = "Segoe UI"
FONT_EA = "Microsoft YaHei"
FONT_MONO = "Consolas"

NAVY = RGBColor(15, 36, 69)
WHITE = RGBColor(255, 255, 255)
CANVAS = RGBColor(246, 248, 252)
SURFACE = RGBColor(236, 241, 250)
SHADOW = RGBColor(226, 232, 243)
LINE = RGBColor(216, 224, 238)
MUTED = RGBColor(95, 112, 140)
FAINT = RGBColor(146, 160, 184)
BLUE = RGBColor(39, 87, 232)
CYAN = RGBColor(18, 181, 196)
PURPLE = RGBColor(122, 87, 222)
GREEN = RGBColor(23, 166, 115)
AMBER = RGBColor(214, 138, 34)
ROSE = RGBColor(214, 69, 96)

W = 13.333
H = 7.5
M = 0.72
CW = W - 2 * M
BODY_TOP = 2.46
BODY_BOTTOM = 6.74

P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
P14_NS = "http://schemas.microsoft.com/office/powerpoint/2010/main"
SECTION_EXT_URI = "{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"


# ── text and shape helpers ────────────────────────────────────────────────

def _apply_font(run, size, color, bold, face):
    run.font.name = face
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color
    rpr = run._r.get_or_add_rPr()
    ea = rpr.find(qn("a:ea"))
    if ea is None:
        ea = etree.SubElement(rpr, qn("a:ea"))
        latin = rpr.find(qn("a:latin"))
        if latin is not None:
            latin.addnext(ea)
    ea.set("typeface", FONT_MONO if face == FONT_MONO else FONT_EA)


def add_text(slide, text, x, y, w, h, size=12, color=NAVY, bold=False,
             align=PP_ALIGN.LEFT, spacing=1.22, anchor=MSO_ANCHOR.MIDDLE,
             face=FONT, space_after=0):
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    frame = box.text_frame
    frame.clear()
    frame.word_wrap = True
    frame.margin_left = frame.margin_right = 0
    frame.margin_top = frame.margin_bottom = 0
    frame.vertical_anchor = anchor
    for index, line in enumerate(text.split("\n")):
        paragraph = frame.paragraphs[0] if index == 0 else frame.add_paragraph()
        paragraph.alignment = align
        paragraph.line_spacing = spacing
        paragraph.space_after = Pt(space_after)
        run = paragraph.add_run()
        run.text = line
        _apply_font(run, size, color, bold, face)
    return box


def add_body(slide, lines, x, y, w, h, size=10, color=MUTED, bullet="· ",
             spacing=1.3, space_after=3.5, anchor=MSO_ANCHOR.TOP):
    text = "\n".join(f"{bullet}{line}" for line in lines)
    return add_text(slide, text, x, y, w, h, size, color, spacing=spacing,
                    anchor=anchor, space_after=space_after)


def add_shape(slide, kind, x, y, w, h, fill, line=None):
    shape = slide.shapes.add_shape(kind, Inches(x), Inches(y), Inches(w),
                                   Inches(h))
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill
    shape.line.color.rgb = line or fill
    shape.line.width = Pt(1)
    shape.shadow.inherit = False
    return shape


def add_rect(slide, x, y, w, h, fill, line=None):
    return add_shape(slide, MSO_SHAPE.RECTANGLE, x, y, w, h, fill, line)


def add_card(slide, x, y, w, h, fill=WHITE, line=LINE, shadow=True):
    if shadow:
        add_shape(slide, MSO_SHAPE.ROUNDED_RECTANGLE, x + 0.045, y + 0.06, w, h,
                  SHADOW)
    return add_shape(slide, MSO_SHAPE.ROUNDED_RECTANGLE, x, y, w, h, fill, line)


def add_dot(slide, label, x, y, diameter, fill, size=12, color=WHITE):
    add_shape(slide, MSO_SHAPE.OVAL, x, y, diameter, diameter, fill)
    add_text(slide, label, x, y, diameter, diameter, size, color, True,
             PP_ALIGN.CENTER)


def add_pill(slide, label, x, y, w, h, fill, color=WHITE, size=10):
    add_shape(slide, MSO_SHAPE.ROUNDED_RECTANGLE, x, y, w, h, fill, fill)
    add_text(slide, label, x, y, w, h, size, color, True, PP_ALIGN.CENTER)


def add_arrow(slide, x, y, size, color=LINE):
    tri = add_shape(slide, MSO_SHAPE.ISOSCELES_TRIANGLE, x, y, size, size,
                    color)
    tri.rotation = 90
    return tri


# ── diagram helpers ───────────────────────────────────────────────────────

def tint(color, amount):
    """Mix a palette color toward white, for zone fills and soft bars."""
    hex_value = str(color)
    channels = (int(hex_value[index:index + 2], 16) for index in (0, 2, 4))
    return RGBColor(*(round(v + (255 - v) * amount) for v in channels))


def add_line(slide, start, end, color=FAINT, width=1.25, arrow=True,
             dashed=False):
    connector = slide.shapes.add_connector(
        MSO_CONNECTOR.STRAIGHT, Inches(start[0]), Inches(start[1]),
        Inches(end[0]), Inches(end[1]))
    connector._element.spPr.get_or_add_effectLst()
    connector.line.color.rgb = color
    connector.line.width = Pt(width)
    if dashed:
        connector.line.dash_style = MSO_LINE_DASH_STYLE.DASH
    if arrow:
        line = connector.line._get_or_add_ln()
        head = line.find(qn("a:tailEnd"))
        if head is None:
            head = etree.SubElement(line, qn("a:tailEnd"))
        head.set("type", "triangle")
        head.set("w", "med")
        head.set("len", "med")
    return connector


def add_path(slide, points, color=FAINT, width=1.25, arrow=True, dashed=False):
    """Draw an elbow path; only the final segment carries the arrow head."""
    for index in range(len(points) - 1):
        add_line(slide, points[index], points[index + 1], color, width,
                 arrow and index == len(points) - 2, dashed)


def add_node(slide, title, caption, x, y, w, h, accent, size=11.5,
             caption_size=8.8, shadow=False):
    if shadow:
        add_shape(slide, MSO_SHAPE.ROUNDED_RECTANGLE, x + 0.04, y + 0.05, w, h,
                  SHADOW)
    shape = add_shape(slide, MSO_SHAPE.ROUNDED_RECTANGLE, x, y, w, h, WHITE,
                      accent)
    shape.line.width = Pt(1.25)
    if caption:
        add_text(slide, title, x + 0.12, y + 0.14, w - 0.24, 0.28, size, NAVY,
                 True, PP_ALIGN.CENTER)
        add_text(slide, caption, x + 0.14, y + 0.44, w - 0.28, h - 0.56,
                 caption_size, MUTED, align=PP_ALIGN.CENTER, spacing=1.22,
                 anchor=MSO_ANCHOR.TOP)
    else:
        add_text(slide, title, x + 0.1, y, w - 0.2, h, size, NAVY, True,
                 PP_ALIGN.CENTER)
    return shape


def add_diamond(slide, label, x, y, w, h, accent, size=10):
    shape = add_shape(slide, MSO_SHAPE.DIAMOND, x, y, w, h, WHITE, accent)
    shape.line.width = Pt(1.25)
    add_text(slide, label, x + w * 0.17, y, w * 0.66, h, size, NAVY, True,
             PP_ALIGN.CENTER)
    return shape


def add_edge_label(slide, label, cx, cy, w=1.1, size=9, color=MUTED):
    """Caption that sits on a connector, masked so the line reads cleanly."""
    add_rect(slide, cx - w / 2, cy - 0.13, w, 0.26, CANVAS, CANVAS)
    add_text(slide, label, cx - w / 2, cy - 0.13, w, 0.26, size, color, True,
             PP_ALIGN.CENTER)


def add_zone(slide, label, x, y, w, h, accent, size=12):
    shape = add_shape(slide, MSO_SHAPE.ROUNDED_RECTANGLE, x, y, w, h,
                      tint(accent, 0.94), accent)
    shape.line.width = Pt(1.25)
    shape.line.dash_style = MSO_LINE_DASH_STYLE.DASH
    add_text(slide, label, x + 0.3, y + 0.14, w - 0.6, 0.3, size, accent, True)
    return shape


def add_chip(slide, label, x, y, w, h, accent, size=9.5, solid=False):
    add_shape(slide, MSO_SHAPE.ROUNDED_RECTANGLE, x, y, w, h,
              accent if solid else WHITE, accent if solid else LINE)
    add_text(slide, label, x + 0.1, y, w - 0.2, h, size,
             WHITE if solid else NAVY, True, PP_ALIGN.CENTER)


def add_span(slide, label, x, y, w, h, accent, size=9.2, soft=False):
    """Horizontal span bar; the memory chart uses these as lifetime tracks."""
    add_shape(slide, MSO_SHAPE.ROUNDED_RECTANGLE, x, y, w, h,
              tint(accent, 0.78) if soft else accent, tint(accent, 0.6))
    add_text(slide, label, x + 0.12, y, w - 0.24, h, size,
             NAVY if soft else WHITE, True, PP_ALIGN.CENTER)


def add_segments(slide, segments, x, y, w, h, accent, gap=0.05, size=8):
    """Proportional bar showing what a compaction level keeps and drops.

    `segments` is a list of (label, weight, solid); solid segments are what
    survives compaction, soft ones are what gets rewritten or dropped.
    """
    total = sum(weight for _, weight, _ in segments)
    span = w - gap * (len(segments) - 1)
    cursor = x
    for label, weight, solid in segments:
        seg_w = span * weight / total
        add_shape(slide, MSO_SHAPE.ROUNDED_RECTANGLE, cursor, y, seg_w, h,
                  accent if solid else tint(accent, 0.84),
                  accent if solid else tint(accent, 0.62))
        add_text(slide, label, cursor + 0.05, y, seg_w - 0.1, h, size,
                 WHITE if solid else NAVY, True, PP_ALIGN.CENTER)
        cursor += seg_w + gap


def add_chrome(slide, number, brand, tag=None):
    slide.background.fill.solid()
    slide.background.fill.fore_color.rgb = CANVAS
    add_dot(slide, "C", M, 0.40, 0.36, BLUE, 12)
    add_text(slide, brand, M + 0.48, 0.41, 2.4, 0.34, 10.5, NAVY, True)
    if tag:
        add_text(slide, tag, W - M - 5.6, 0.41, 5.0, 0.34, 10, MUTED,
                 align=PP_ALIGN.RIGHT)
    add_text(slide, f"{number:02d}", W - M - 0.5, 0.41, 0.5, 0.34, 10, FAINT,
             True, PP_ALIGN.RIGHT)
    add_rect(slide, M, 6.98, CW, 0.012, LINE)


def add_page_title(slide, eyebrow, title, subtitle, accent):
    add_text(slide, eyebrow.upper(), M, 1.00, CW, 0.26, 10.5, accent, True)
    add_rect(slide, M, 1.31, 0.44, 0.045, accent)
    add_text(slide, title, M, 1.44, CW, 0.5, 25, NAVY, True)
    add_text(slide, subtitle, M, 1.99, CW, 0.32, 12, MUTED)


def add_info_card(slide, x, y, w, h, accent, tag, title, lines,
                  title_size=14.5, body_size=10):
    add_card(slide, x, y, w, h)
    add_rect(slide, x, y + 0.2, 0.07, h - 0.4, accent)
    pad = x + 0.3
    inner = w - 0.56
    add_text(slide, tag, pad, y + 0.16, inner, 0.24, 9.5, accent, True)
    add_text(slide, title, pad, y + 0.42, inner, 0.32, title_size, NAVY, True)
    add_body(slide, lines, pad, y + 0.82, inner, h - 0.98, body_size)


def add_grid(slide, cards, colors, cols=3, x=M, y=BODY_TOP, w=CW, h=None,
             gap=0.28, title_size=14.5, body_size=10):
    rows = (len(cards) + cols - 1) // cols
    cw = (w - (cols - 1) * gap) / cols
    if h is None:
        h = BODY_BOTTOM - y
    ch = (h - (rows - 1) * gap) / rows
    for index, (tag, title, lines) in enumerate(cards):
        cx = x + (index % cols) * (cw + gap)
        cy = y + (index // cols) * (ch + gap)
        add_info_card(slide, cx, cy, cw, ch, colors[index], tag, title, lines,
                      title_size, body_size)


def add_flow(slide, steps, x, y, w, h, accent, gap=0.3, title_size=11.5,
             body_size=9):
    count = len(steps)
    bw = (w - (count - 1) * gap) / count
    for index, (title, caption) in enumerate(steps):
        bx = x + index * (bw + gap)
        add_card(slide, bx, y, bw, h)
        add_rect(slide, bx, y + 0.16, 0.06, h - 0.32, accent)
        add_text(slide, title, bx + 0.24, y + 0.14, bw - 0.44, 0.3, title_size,
                 NAVY, True)
        add_text(slide, caption, bx + 0.24, y + 0.46, bw - 0.44, h - 0.6,
                 body_size, MUTED, spacing=1.25, anchor=MSO_ANCHOR.TOP)
        if index < count - 1:
            add_arrow(slide, bx + bw + gap / 2 - 0.07, y + h / 2 - 0.07, 0.14)


def add_rows(slide, rows, x, y, w, accent, col1, row_h=0.44, size=10.5,
             zebra=True):
    for index, (left, right) in enumerate(rows):
        ry = y + index * row_h
        if zebra and index % 2 == 0:
            add_rect(slide, x, ry, w, row_h - 0.05, SURFACE, SURFACE)
        add_rect(slide, x, ry + 0.09, 0.05, row_h - 0.23, accent)
        add_text(slide, left, x + 0.2, ry, col1, row_h - 0.05, size, NAVY, True)
        add_text(slide, right, x + 0.24 + col1, ry, w - col1 - 0.44,
                 row_h - 0.05, size - 0.5, MUTED)


def add_code(slide, lines, x, y, w, h, title=None, accent=CYAN):
    add_card(slide, x, y, w, h, NAVY, NAVY)
    top = y + 0.2
    if title:
        add_text(slide, title, x + 0.3, top, w - 0.6, 0.24, 9.5, accent, True)
        top += 0.34
    add_text(slide, "\n".join(lines), x + 0.3, top, w - 0.6, h - (top - y) - 0.2,
             9.5, RGBColor(214, 225, 245), spacing=1.4,
             anchor=MSO_ANCHOR.TOP, face=FONT_MONO)


def add_note(slide, text, x, y, w, h, accent, size=10.5):
    add_card(slide, x, y, w, h, SURFACE, LINE, shadow=False)
    add_rect(slide, x, y + 0.14, 0.06, h - 0.28, accent)
    add_text(slide, text, x + 0.26, y, w - 0.5, h, size, NAVY, spacing=1.3)


def add_section_divider(slide, number, accent, title, subtitle, chips):
    top = 2.5
    text_x = 4.55
    add_text(slide, f"SECTION {number}", M + 0.1, top, 4.0, 0.28, 11, MUTED,
             True)
    add_text(slide, number, M, top + 0.30, 3.0, 1.9, 96, accent, True)
    add_rect(slide, M + 0.06, top + 2.30, 1.4, 0.05, accent)
    add_text(slide, title, text_x, top + 0.86, 8.2, 0.78, 38, NAVY, True)
    add_text(slide, subtitle, text_x + 0.03, top + 1.70, 8.2, 0.36, 14, MUTED)

    gap = 0.2
    avail = W - M - text_x
    chip_w = (avail - (len(chips) - 1) * gap) / len(chips)
    for index, chip in enumerate(chips):
        cx = text_x + index * (chip_w + gap)
        add_shape(slide, MSO_SHAPE.ROUNDED_RECTANGLE, cx, top + 2.22, chip_w,
                  0.46, WHITE, LINE)
        add_text(slide, chip, cx, top + 2.22, chip_w, 0.46, 10.5, NAVY, True,
                 PP_ALIGN.CENTER)


def add_powerpoint_sections(prs, sections):
    """Write real PowerPoint sections so the split shows in the navigator.

    `sections` is a list of (name, slide_count) in slide order; python-pptx has
    no API for this, so the p14:sectionLst extension is written directly.
    """
    slide_ids = [element.get("id") for element in prs.slides._sldIdLst]
    if sum(count for _, count in sections) != len(slide_ids):
        raise ValueError("section slide counts must cover every slide")

    blocks = []
    cursor = 0
    for name, count in sections:
        entries = "".join(f'<p14:sldId id="{slide_id}"/>'
                          for slide_id in slide_ids[cursor:cursor + count])
        cursor += count
        blocks.append(
            f'<p14:section name="{escape(name)}" '
            f'id="{{{str(uuid4()).upper()}}}">'
            f"<p14:sldIdLst>{entries}</p14:sldIdLst>"
            f"</p14:section>")

    xml = (f'<p:extLst xmlns:p="{P_NS}">'
           f'<p:ext uri="{SECTION_EXT_URI}">'
           f'<p14:sectionLst xmlns:p14="{P14_NS}">{"".join(blocks)}'
           f"</p14:sectionLst></p:ext></p:extLst>")
    prs._element.append(etree.fromstring(xml))


# ── copy ──────────────────────────────────────────────────────────────────

CONTENT = {
    "zh": {
        "brand": "CODING AGENT",
        "tags": {
            "agenda": "AGENDA",
            "s1": "SECTION 01",
            "s1_page": "SECTION 01 · 能力全景",
            "s2": "SECTION 02",
            "s2_page": "SECTION 02 · 架构与实现",
            "closing": "总结",
        },
        "sections": [
            ("开场", 2),
            ("Section 01 · 能力全景", 9),
            ("Section 02 · 架构与关键实现", 10),
            ("收尾", 1),
        ],
        "style": {"grid_body": 10},
        "cover": {
            "eyebrow": "产品与架构介绍",
            "title": "Coding Agent\n能力全景与架构实现",
            "subtitle": "桌面端、Web、IDE 与 API 共用同一个 Agent 引擎。",
            "pill": "本地可运行 · 可私有部署",
            "footer": "自有模型  ·  自有数据  ·  源码级可扩展",
            "cards": [
                ("SECTION 01", "能力全景",
                 "Agent 能做什么：编码、浏览器自动化、扩展体系、\n多端接入与 ACP、记忆与上下文、工程化保障。"),
                ("SECTION 02", "架构与关键实现",
                 "一次对话如何跑完：Turn Host、Query Loop、\n工具流水线、执行平面、协议层与 ACP 实现。"),
            ],
        },
        "agenda": {
            "eyebrow": "Agenda",
            "title": "两个 Section，一条主线",
            "subtitle": "先讲清楚能力边界，再回答这些能力是怎么实现的。",
            "columns": [
                ("SECTION 01 · 能力全景", [
                    ("04", "能力总览"),
                    ("05", "编码核心能力"),
                    ("06", "浏览器自动化"),
                    ("07", "扩展体系：子代理 / 技能 / MCP"),
                    ("08", "记忆与上下文"),
                    ("09", "多端接入：一套引擎四种入口"),
                    ("10", "ACP：在 IDE 里直接用"),
                    ("11", "工程化与安全能力"),
                ]),
                ("SECTION 02 · 架构与关键实现", [
                    ("13", "系统总览：分层与边界"),
                    ("14", "一条消息的端到端路径"),
                    ("15", "Agent Loop 的职责划分"),
                    ("16", "工具流水线"),
                    ("17", "执行平面：控制面与执行面分离"),
                    ("18", "协议层与关联 ID"),
                    ("19", "ACP 实现细节"),
                    ("20", "记忆与压缩的实现"),
                    ("21", "失败边界与可靠性"),
                ]),
            ],
        },
        "s1_divider": {
            "title": "能力全景",
            "subtitle": "Agent 能做什么",
            "chips": ["编码 · 浏览器", "扩展 · MCP", "多端 · ACP", "记忆 · 权限"],
        },
        "capability": {
            "eyebrow": "能力总览",
            "title": "六块能力，构成一个能干活的 Agent",
            "subtitle": "每一块都能单独使用，也能在一次对话里串起来。",
            "cards": [
                ("01", "编码助手", [
                    "读写与精确编辑文件，按片段改而不是整文件覆盖",
                    "ripgrep 级检索 + LSP 结构化代码智能",
                    "跨平台执行命令，长任务自动转后台",
                ]),
                ("02", "浏览器自动化", [
                    "快照式操作真实网页：导航、点击、填表、截图",
                    "可复用本机 Chrome 的 cookie 与登录态",
                    "能看网络请求，识别页面没报错的隐性失败",
                ]),
                ("03", "扩展体系", [
                    "Skills、Slash Commands、子代理、MCP、插件",
                    "全部是 Markdown 或配置，不用改核心循环",
                    "按插件 / 用户 / 项目 / 托管四级优先级合并",
                ]),
                ("04", "多端接入", [
                    "Electron 桌面端、Web UI、CLI stdio",
                    "ACP 接入 VS Code / Cursor / IntelliJ 侧栏",
                    "HTTP API 与 TypeScript / Python SDK",
                ]),
                ("05", "记忆与上下文", [
                    "项目规则常驻，跨会话记忆按需召回",
                    "会话摘要记录本次进度",
                    "上下文自动压缩，完整历史永不丢失",
                ]),
                ("06", "工程化保障", [
                    "文件系统权限边界与部署模式收敛",
                    "定时任务、后台任务、大输出外置存储",
                    "所有失败都被收敛在工具边界上",
                ]),
            ],
        },
        "coding": {
            "eyebrow": "编码核心能力",
            "title": "从看懂代码到改完验证",
            "subtitle": "工具不是一堆 API，而是一条「检索 → 理解 → 修改 → 验证」的链路。",
            "cards": [
                ("文件", "Read / Write / Edit", [
                    "按行区间读取，避免整文件灌进上下文",
                    "精确字符串替换，冲突会直接失败而不是猜",
                    "写入后自动回灌 LSP 诊断到下一步",
                ]),
                ("检索", "Glob / Grep", [
                    "ripgrep 后端，支持正则、文件类型、上下文行",
                    "在 worker 侧就近执行，远端工作区同样适用",
                    "结果可只回文件名，控制上下文开销",
                ]),
                ("执行", "Bash / PowerShell", [
                    "跨平台 shell，保留 cwd 与会话状态",
                    "长命令转后台任务，不阻塞 Agent 主路径",
                    "失败会取消同一并行组里的兄弟调用",
                ]),
                ("代码智能", "LSP", [
                    "定义、引用、实现、符号、悬停信息",
                    "语言服务器跑在工作区旁边，不在控制机",
                    "Write / Edit 之后被动诊断自动附加",
                ]),
                ("并行", "子代理 Agent", [
                    "Explore：只读并行检索，结构化汇报",
                    "Plan：只读架构规划",
                    "general-purpose：读写 + shell + web 的开放任务",
                ]),
                ("过程可见", "计划与澄清", [
                    "TodoWrite 把多步任务显式列出来",
                    "AskUserQuestion 在真正需要决策时才打断",
                    "Plan 模式先出方案，批准后才动手改代码",
                ]),
            ],
        },
        "browser": {
            "eyebrow": "浏览器自动化",
            "title": "看快照，选元素，做动作，再看一次",
            "subtitle": "Agent 不靠像素点坐标，而是靠带 ref 的元素快照来操作页面。",
            "modes_title": "两种模式，同一套工具",
            "modes": [
                ("Isolated 模式",
                 "Agent 独占的 Chrome profile，零配置开箱即用，适合本地服务与公开站点"),
                ("Extension 模式",
                 "通过扩展接管你自己的 Chrome，带上已有 cookie 与登录态，适合内网后台"),
            ],
            "lock_note": "browser_lock 在用户与 Agent 之间显式切换控制权：需要人工登录或验证码时把页面交给用户，"
                         "完成之后再把控制权交还给 Agent，同一个会话继续往下跑。",
            "flow": [
                ("① navigate", "打开页面并返回第一份快照"),
                ("② snapshot", "带 ref 的元素树，不是像素"),
                ("③ act", "fill_form / click 按 ref 定位"),
                ("④ verify", "用新快照与网络记录判断"),
            ],
            "loop_label": "ref 会失效 → 重新快照",
            "verify_title": "验证的三种结果",
            "verify": [
                ("成功", "新快照里出现预期内容，例如 heading \"Welcome back\""),
                ("可见失败", "快照里直接出现错误提示"),
                ("隐性失败", "页面不报错，但 browser_network 显示 POST /api/login 失败"),
            ],
            "note": "快照给的是可操作元素，截图只给像素。超大快照落盘，只回传有界预览；原始 browser_cdp 被限制使用。",
        },
        "extensions": {
            "eyebrow": "扩展体系",
            "title": "五种扩展方式，都不需要动核心循环",
            "subtitle": "绝大多数扩展在每一个 user turn 重新组装，改完即时生效。",
            "top": [
                ("延伸上下文", "Subagents 子代理", [
                    "独立的 prompt、模型档位与工具集",
                    "不继承父对话，派发提示必须自包含",
                    "结果投影回父级的那一次工具调用",
                ]),
                ("复用指令", "Skills 技能", [
                    "Markdown 定义，懒加载 SKILL.md",
                    "inline 展开进当前对话，或 fork 独立运行",
                    "原始参数会被追加，不会丢用户请求",
                ]),
                ("统一入口", "Slash Commands", [
                    "内置命令、Markdown 模板与技能共用一套注册表",
                    "支持 $ARGUMENTS、位置参数与命名参数",
                    "! 执行 shell、@ 引入文件，在展开阶段完成",
                ]),
            ],
            "bottom": [
                ("外部能力", "MCP", [
                    "外部服务器的工具进入同一个工具注册表，默认延迟加载",
                    "按「工作目录 + 配置哈希」池化复用，空闲 30 分钟后关闭",
                ]),
                ("打包分发", "Plugins 插件", [
                    "声明式插件：一个目录打包 agents / commands / skills / MCP 配置",
                    "代码插件：进程启动时注册工具、中间件与事件监听，改动需重启",
                ]),
            ],
            "note": "命名与优先级：插件 < 用户 < 项目 < 托管；内置命令名不可被覆盖，同名冲突时技能优先于命令，"
                    "重复的子代理类型会直接报错。",
        },
        "memory_feature": {
            "eyebrow": "记忆与上下文",
            "title": "四种机制，四种生命周期",
            "subtitle": "它们解决的是不同问题，不能互相替代。",
            "chart_label_w": 1.95,
            "sessions": ["会话 1", "会话 2（当前）", "会话 3"],
            "tracks": [
                ("Project Rules", "常驻系统提示，跨所有会话生效", 0, 3, False),
                ("Auto Memory", "项目级主题文件，跨会话共享，按需召回", 0, 3, True),
                ("Session Memory", "只属于这一场会话", 1, 2, False),
                ("Compaction", "只作用于本轮上下文", 1, 2, True),
            ],
            "rail": [
                ("项目规则", "人工维护的常驻指令；带 paths: 的规则命中路径后才附加"),
                ("自动记忆", "存偏好与非代码事实，不存能从源码直接读到的东西"),
                ("会话记忆", "进度台账 summary.md，主要消费者是压缩，不是知识库"),
                ("压缩", "只裁剪送模型的投影；它读会话记忆，从不拿自动记忆当摘要"),
            ],
            "turn_marks": [
                ("进入 turn", "规则塑造行为，自动记忆按需附加主题文件"),
                ("对话进行中", "会话记忆持续记录当前进度"),
                ("每个模型步之前", "活跃上下文放不下就压缩"),
                ("turn 成功结束", "抽取长期知识写回自动记忆"),
            ],
        },
        "interfaces": {
            "eyebrow": "多端接入",
            "title": "四种入口，同一个 runChatTurn()",
            "subtitle": "换入口不换能力：会话、工具与协议类型在所有入口上保持一致。",
            "cards": [
                ("桌面", "Electron", "开箱即用的本地应用，浏览器自动化默认落点"),
                ("浏览器", "Web UI", "SSE 流式输出，Docker 私有化部署"),
                ("IDE", "ACP", "VS Code / Cursor / IntelliJ 侧栏"),
                ("自动化", "HTTP API", "REST + SSE，TypeScript 与 Python SDK"),
                ("脚本", "CLI stdio", "每行一条 NDJSON，适合管道与 CI"),
            ],
            "engine": "runChatTurn()",
            "engine_caption": "同一个 Agent 引擎：同一套会话、工具与协议类型",
            "shared": [
                ("一致的会话模型", [
                    "会话、工具与 wire 类型复用同一套定义",
                    "任意入口创建的会话都能在别处继续",
                ]),
                ("按工作区解析配置", [
                    "设置按当前 cwd 解析，项目之间可以不同",
                    "用户级与项目级合并，项目级优先",
                ]),
                ("适配器只做翻译", [
                    "HTTP / stdio / ACP 不实现 Agent 逻辑",
                    "新增一种客户端 = 新增一个适配器",
                ]),
            ],
        },
        "acp_feature": {
            "eyebrow": "ACP",
            "title": "在 VS Code / Cursor / IntelliJ 里直接用",
            "subtitle": "Agent Client Protocol：写一次适配，接入所有支持 ACP 的编辑器。",
            "code_title": "VS Code / Cursor 用户设置",
            "bullets": [
                "args 必须以 tsx 开头，后跟 start.js 的绝对路径",
                "缺了 tsx 侧栏会显示 Failed to load sessions",
                "追加 \"--workspace\", \"<path>\" 固定默认工作区",
                "终端自检：npm run acp -- --workspace <path>",
                "IntelliJ 侧同样走 ACP，配置形态完全一致",
            ],
            "rows_title": "侧栏里你会得到什么",
            "rows": [
                ("流式回答", "文本增量实时渲染，不用等整段生成完"),
                ("思考过程", "推理内容单独成流，与正式回答区分开"),
                ("工具卡片", "调用、进行中、成功或失败三态，带参数与文件位置"),
                ("任务计划", "TodoWrite 直接映射成编辑器里的 plan 面板"),
                ("权限询问", "越界操作弹窗确认，决定回传后才继续执行"),
                ("模式切换", "Agent / Ask / Plan 三种模式在侧栏直接切"),
                ("图片输入", "支持图片与嵌入式上下文块"),
            ],
            "note": "ACP 适配器不只是换封帧格式，它把引擎的内部消息翻译成编辑器能直接渲染的 session update 结构。",
            "rows_col1": 1.5,
        },
        "engineering": {
            "eyebrow": "工程化与安全",
            "title": "让 Agent 敢在真项目里跑",
            "subtitle": "能力越强，边界越要显式。",
            "cards": [
                ("边界", "文件系统权限", [
                    "Read / Grep / Glob / LSP / Edit / Write 统一过闸",
                    "词法路径与真实路径双重校验，软链接也要查",
                    "deny 规则最先执行，永远赢",
                ]),
                ("模式", "三种默认行为", [
                    "default：越界时询问，可选 Allow / Always allow / Reject",
                    "dontAsk：无法确认的一律拒绝",
                    "bypassPermissions：放行外部路径，deny 仍然生效",
                ]),
                ("部署", "SSO 场景收敛", [
                    "AUTH_ENABLED=true 时强制 dontAsk",
                    "allow 与附加目录失效，deny 保留",
                    "注意：这是应用层边界，不是操作系统沙箱",
                ]),
                ("调度", "定时任务", [
                    "一次性时间点，或五段 cron 按本地时间求值",
                    "进程内最多 50 个任务，同会话串行执行",
                    "周期任务带确定性抖动，创建七天后过期",
                ]),
                ("长任务", "后台任务", [
                    "长命令移出阻塞的 Agent 路径",
                    "需要显式轮询或终止，worker 退出时强杀残留子进程",
                ]),
                ("上下文", "大输出外置", [
                    "claim-check：模型只看有界预览与一个引用",
                    "完整结果写入会话级工具存储，需要时再读回",
                    "保住 prompt cache 前缀，一条啰嗦命令不污染后续每步",
                ]),
            ],
        },
        "s2_divider": {
            "title": "架构与关键实现",
            "subtitle": "一次对话是怎么跑完的",
            "chips": ["Turn · Query", "Tools · 权限", "执行平面", "协议 · ACP"],
        },
        "overview": {
            "eyebrow": "系统总览",
            "title": "六层结构，每层只做一件事",
            "subtitle": "所有入口向下收敛到同一个 turn host 与 query 循环。",
            "layers": [
                ("接入层 Clients",
                 "Electron 桌面端   ·   Web UI   ·   VS Code / Cursor   ·   IntelliJ   ·   CLI   ·   SDK"),
                ("适配器 Adapters",
                 "HTTP + SSE   ·   stdio NDJSON   ·   ACP   ·   worker —— 只做翻译，不实现 Agent 逻辑"),
                ("Turn Host  runChatTurn()",
                 "turn 级设置与中间件   ·   中止传播   ·   记忆旁路   ·   传输收尾   ·   消息持久化"),
                ("Query Loop  query()",
                 "preTurn → runStep → postTurn   ·   拥有循环计数、活跃工具集与停止原因"),
                ("工具层 Tools",
                 "assembleToolPool   ·   canUseTool 权限闸   ·   StreamingToolExecutor 并发执行"),
                ("执行平面 Execution",
                 "本地 worker 或 SSH worker —— 文件系统、Shell、ripgrep、后台进程、LSP"),
            ],
            "rail_title": "横切关注点",
            "rail": [
                "Models：多 Provider 策略可插拔",
                "Sessions：追加式 transcript，持久化与回放",
                "Protocol：protocol/src 的 Zod schema 定义引擎与客户端契约",
                "Permissions：文件系统闸门与会话交互模式",
                "Extensions：技能、命令、子代理、MCP、插件",
            ],
            "label_w": 2.95,
        },
        "end_to_end": {
            "eyebrow": "端到端",
            "title": "一条消息从进来到落库",
            "subtitle": "五个阶段，职责不重叠。",
            "flow": [
                ("① 入口选择", "src/entrypoints/cli.ts 判定 HTTP、stdio、ACP 还是 worker 模式"),
                ("② 适配器归一", "把客户端输入归一成一次 turn 并调用与传输无关的 runChatTurn()"),
                ("③ 准备上下文", "prepareChatTurn() 解析 slash、规则、插件、技能、MCP、权限与执行后端，拼出工具池"),
                ("④ 循环推进", "query() 让模型步与工具步交替，直到模型不再请求工具"),
                ("⑤ 收尾落库", "runChatTurn() 持久化新会话消息，发出完成事件并释放后端"),
            ],
            "notes": [
                ("Wire 事件不是持久化层",
                 "客户端看到的流式事件是「实时视图」。真正的会话消息在循环更新完历史之后，由 turn host 统一落库。"),
                ("一个会话只有一个活跃 turn",
                 "同一份 transcript 不允许被并发修改。第二个请求要么排队，要么被拒绝，避免历史交错。"),
                ("远端解析 fail-closed",
                 "远端工作区不可用时，准备阶段直接抛错中止，绝不把文件与 shell 操作回落到控制机执行。"),
            ],
        },
        "agent_loop": {
            "eyebrow": "Agent Loop",
            "title": "Agent 不是一次模型调用",
            "subtitle": "模型只负责「提议」，是否继续由循环决定。",
            "nodes": [
                ("preTurn", "从最近压缩边界取消息，按需压缩"),
                ("runStep", "投影给 Provider，流式消费，并发跑安全工具"),
                ("postTurn", "挂记忆附件，发快照，激活新工具"),
            ],
            "decision": "这一步有工具调用？",
            "yes": "有 → 回到 preTurn",
            "no": "没有",
            "done": "turn 完成",
            "done_caption": "落库并发出完成事件",
            "levels": [
                ("runChatTurn()", [
                    "turn 级设置、中间件与中止传播",
                    "记忆召回在前，抽取在后",
                ]),
                ("query()", [
                    "拥有循环计数与活跃工具集",
                    "到 maxSteps 关闭工具，强制最终回答",
                ]),
                ("runStep()", [
                    "规范化 → streamText() → 流式消费",
                    "tool_use 块一到就排队，不等整段响应",
                ]),
            ],
            "note": "一个细节：计划被批准之后，如果模型回了一条不带任何工具调用的响应，会被提醒覆盖一次，强制它真正进入实现步骤。",
        },
        "tool_pipeline": {
            "eyebrow": "工具流水线",
            "title": "从注册表到模型结果的六道关口",
            "subtitle": "运行时决定哪些工具可见、哪次调用被允许、怎么执行、各方看到什么。",
            "flow": [
                ("来源", "内置注册表、每轮的技能与子代理工具、MCP 外部工具"),
                ("组装", "assembleToolPool() 拆成 active 与 deferred 两组"),
                ("收窄", "启用开关、主代理 allow/deny、浏览器策略与当前模式"),
                ("排队", "StreamingToolExecutor 判定串行还是并行"),
                ("鉴权", "canUseTool 在执行前一刻放行、拒绝或等用户回答"),
                ("双投影", "模型拿有界文本或图片块，Wire 额外拿 tool_use_result"),
            ],
            "cards": [
                ("延迟加载与 ToolSearch", [
                    "MCP 工具默认 deferred，不占提示词空间",
                    "搜到只是「发现」，激活在下一步，同批先搜再用必失败",
                ]),
                ("并发策略", [
                    "只有判定输入安全才并行，未知的一律串行",
                    "Bash 失败会取消同一并行组的兄弟调用",
                ]),
                ("失败留在工具边界", [
                    "未知、拒绝、异常、超时都变成 isError 结果",
                    "循环不被打断，两路投影共享同一个 tool_use_id",
                ]),
            ],
        },
        "execution": {
            "eyebrow": "执行平面",
            "title": "编排留在控制机，操作贴着工作区",
            "subtitle": "工具只面对一个 ExecutionBackend；本地与 SSH 暴露完全相同的契约。",
            "control_title": "控制面 Control plane",
            "control": [
                ("会话与模型", "编排与 provider 策略"),
                ("权限判定", "环境选择也在这里"),
                ("worker 生命周期", "启动、健康检查、回收"),
                ("RuntimeBroker", "按 environmentId::cwd 复用"),
            ],
            "exec_title": "执行面 Execution plane",
            "exec": [
                ("文件系统", "读写与路径校验"),
                ("Shell 与 ripgrep", "命令与检索就近执行"),
                ("后台进程", "长任务在这一侧托管"),
                ("语言服务器", "LSP 就近跑在文件旁边"),
            ],
            "rpc_title": "RPC",
            "rpc_out": "操作 + request ID",
            "rpc_back": "结果按同一个 ID 回关联",
            "boundary": "进程 / 机器边界",
            "code_title": "Workspace handle = 环境 ID + 环境内路径",
            "rows": [
                ("绑定超时", "本地 15 秒，SSH 90 秒；切不到目标目录就算绑定失败"),
                ("路径护栏", "发出文件操作前就拒掉工作区之外的路径"),
                ("fail-closed", "SSH 探测、部署或绑定失败直接中止，不回落本地执行"),
                ("远端边界", "插件与技能仍从控制机加载；项目规则与自动记忆不读远端"),
            ],
            "rows_col1": 1.3,
        },
        "protocol": {
            "eyebrow": "协议层",
            "title": "引擎与客户端之间的类型化边界",
            "subtitle": "protocol/src 里的 Zod schema 定义进出两个方向的消息联合类型。",
            "transports_title": "三种传输，一个出口",
            "transports": [
                ("HTTP", "SSE 事件名 + 同一组出站消息的 JSON 序列化"),
                ("stdio", "每行一条 NDJSON，turn 之间保持 stdout 打开"),
                ("ACP", "不只换封帧：把引擎消息翻译成 ACP session update"),
            ],
            "wire_note": "WireEmitter 是引擎唯一的传输中立输出口：打上关联上下文之后，统一发出流、工具、进度、控制与结果事件。"
                         "worker stdio 是另一套控制面到 worker 的 RPC 协议，与客户端协议分开演进。",
            "ids_title": "关联 ID：并发场景下唯一可靠的拼接方式",
            "ids": [
                ("session_id", "把所有事件归属到一次会话"),
                ("tool_use_id", "关联调用、进度、耗时与结果，并发工具必须靠它"),
                ("request_id", "关联一个控制请求与它的响应或取消"),
                ("parent_tool_use_id", "标记嵌套工作，例如子代理内部的调用"),
                ("system/init", "握手时宣告协议版本、权限模式与工作目录"),
            ],
            "notes": [
                "stdout 上任何非协议输出都会破坏 NDJSON 与 ACP 的 JSON-RPC 封帧 —— 启动日志、worker 日志与诊断信息一律走 stderr。",
                "不要按工具名去关联工具活动：并发调用时只有 tool_use_id 是唯一的。破坏性契约变更必须提升 protocol version。",
            ],
            "ids_col1": 1.8,
            "name_w": 0.9,
        },
        "acp_impl": {
            "eyebrow": "ACP 实现",
            "title": "一个适配器，把引擎讲给编辑器听",
            "subtitle": "src/acp/ 下的实现：会话管理、汇流到共享 turn host、出站翻译与权限桥。",
            "comp_title": "组件职责",
            "comps": [
                ("BaizeAcpAgent", "initialize / newSession / prompt / setSessionMode / cancel"),
                ("AcpSessionRegistry", "按 sessionId 记录会话与 cwd，负责取消"),
                ("runAcpPromptTurn", "把 ACP prompt 汇流到共享的 turn host"),
                ("AcpTurnSink", "实现 ProtocolSink，把出站 wire 消息翻译成通知"),
                ("permission-bridge", "control_request → 客户端权限请求 → 决定回写引擎"),
                ("tool-kind", "把工具名与参数映射成标题、kind 与文件位置"),
                ("prompt-input", "把 ACP 的内容块拆成文本与图片输入"),
            ],
            "comp_note": "能力声明：loadSession=false，图片输入与嵌入式上下文开启，MCP 支持 http 与 sse；"
                         "模式集合固定为 Agent / Ask / Plan。",
            "map_title": "出站消息映射",
            "maps": [
                ("stream_event · text", "agent_message_chunk"),
                ("stream_event · reasoning", "agent_thought_chunk"),
                ("tool_call", "tool_call（pending，带 locations 与 rawInput）"),
                ("tool_progress", "tool_call_update（in_progress）"),
                ("tool_result", "tool_call_update（completed / failed + rawOutput）"),
                ("system · todo_update", "plan（过滤掉 cancelled 项）"),
                ("system · mode_changed", "current_mode_update"),
                ("result · error", "作为一条 agent_message_chunk 呈现给用户"),
                ("同一 tool_use_id 再次出现", "发 tool_call_update，而不是新建一张卡片"),
            ],
            "comp_col1": 1.72,
            "map_col1": 2.2,
        },
        "memory_impl": {
            "eyebrow": "记忆与压缩的实现",
            "title": "召回走两条通道，压缩分三级",
            "subtitle": "两者都以「不影响主 turn」为前提设计。",
            "recall_title": "Auto Memory 召回：两条通道，从不合并",
            "start": "召回请求",
            "fast": ("Fast Lane", "对文件名与元数据打分，不调模型"),
            "decision": "强命中？",
            "yes": "是",
            "no": "否",
            "lanes": [
                ("Fast Lane 命中", "精确命中或 ≥0.82 且领先 0.12，最多 3 个文件"),
                ("Semantic Lane", "小模型排序，最多 5 个；查询 <10 字符直接跳过"),
            ],
            "out": ("挂进上下文", "命中的主题文件作为附件挂到本轮"),
            "recall_notes": [
                "普通 turn 不等待召回；显式召回最多等 4 秒",
                "本次会话已出现或已被读过的文件会被过滤",
                "结果要么全 Fast Lane，要么全 Semantic Lane",
            ],
            "compact_title": "压缩三级：能少做就少做",
            "compaction": [
                ("Micro compact",
                 [("旧工具负载清空", 4, False), ("配对保留", 3, True)],
                 "只动进程内投影，不写边界"),
                ("Session compact",
                 [("summary.md", 3, True), ("配对安全的近期尾部", 4, False)],
                 "复用会话记忆，追加 compact_boundary"),
                ("Full compact",
                 [("模型摘要", 3, True), ("boundary + 尾部", 4, False)],
                 "notes 缺失或过期时才让模型总结"),
            ],
        },
        "failure": {
            "eyebrow": "失败边界",
            "title": "出问题时，系统退到哪里",
            "subtitle": "这些边界是设计出来的，不是兜底补的。",
            "rows": [
                ("用户中断", "已产生的可用输出会被提交并记录中断，turn 以 aborted 结束，不是丢弃整轮"),
                ("工具出错", "未知工具、拒绝、异常与超时都变成 isError 结果；Bash 失败额外取消并行兄弟调用"),
                ("上下文超限", "获得一次反应式压缩重试；已经压过一次还失败才向上报错"),
                ("步数到顶", "关闭工具，强制模型给一次最终回答；再失败则由 wire 报告步数上限"),
                ("远端不可用", "fail-closed：中止远端 turn 准备，绝不把文件与 shell 操作落回控制机"),
                ("并发写入", "一个会话只允许一个活跃 turn，避免同一份 transcript 被并发改写"),
                ("扩展异常", "畸形的插件清单、技能或 MCP JSON 只报告自身来源，其他有效扩展继续加载"),
                ("MCP 掉线", "该服务器的工具缺席；配置变更是替换池化管理器，而不是改活连接"),
                ("协议不兼容", "适配器边界上拒绝或忽略非法消息；破坏性契约变更必须提升 protocol version"),
            ],
            "rows_col1": 1.9,
        },
        "closing": {
            "eyebrow": "WRAP UP",
            "title": "三句话记住这套系统",
            "cards": [
                ("01", "一套引擎",
                 "桌面端、Web、IDE 与 API 全部汇流到同一个 turn host 与 query 循环，换入口不换行为。"),
                ("02", "边界显式",
                 "权限闸、执行平面与协议 schema 三道边界，把「能做什么」和「可能出什么事」分开管理。"),
                ("03", "可扩展",
                 "加工具、技能、子代理与 MCP 都不需要改核心循环，绝大多数扩展每一轮重新组装。"),
            ],
            "demo_title": "现场演示",
            "demos": [
                "在 IDE 侧栏用 ACP 跑一个真实改动",
                "浏览器自动化验证一次登录流程",
                "SSH 远端工作区上的检索与编辑",
            ],
            "footer": "Questions  ·  Coding Agent",
        },
    },

    "en": {
        "brand": "CODING AGENT",
        "tags": {
            "agenda": "AGENDA",
            "s1": "SECTION 01",
            "s1_page": "SECTION 01 · CAPABILITIES",
            "s2": "SECTION 02",
            "s2_page": "SECTION 02 · ARCHITECTURE",
            "closing": "WRAP UP",
        },
        "sections": [
            ("Opening", 2),
            ("Section 01 · Capabilities", 9),
            ("Section 02 · Architecture & Implementation", 10),
            ("Closing", 1),
        ],
        "style": {"grid_body": 9.5},
        "cover": {
            "eyebrow": "Product & architecture",
            "title": "Coding Agent\nCapabilities and architecture",
            "subtitle": "Desktop, Web, IDE, and API all share one agent engine.",
            "pill": "Runs locally · Private deployment",
            "footer": "Your models  ·  Your data  ·  Extensible at the source",
            "cards": [
                ("SECTION 01", "Capabilities",
                 "What the agent can do: coding, browser automation,\nextensions, clients and ACP, memory, and safeguards."),
                ("SECTION 02", "Architecture & implementation",
                 "How one conversation runs: turn host, query loop,\ntool pipeline, execution plane, protocol, and ACP."),
            ],
        },
        "agenda": {
            "eyebrow": "Agenda",
            "title": "Two sections, one storyline",
            "subtitle": "First what the agent can do, then how those capabilities are built.",
            "columns": [
                ("SECTION 01 · CAPABILITIES", [
                    ("04", "Capability map"),
                    ("05", "Core coding capabilities"),
                    ("06", "Browser automation"),
                    ("07", "Extensions: subagents, skills, MCP"),
                    ("08", "Memory and context"),
                    ("09", "Clients: one engine, four entry points"),
                    ("10", "ACP: use it inside your IDE"),
                    ("11", "Safeguards for real projects"),
                ]),
                ("SECTION 02 · ARCHITECTURE", [
                    ("13", "System overview: layers and boundaries"),
                    ("14", "One message, end to end"),
                    ("15", "How the agent loop divides work"),
                    ("16", "The tool pipeline"),
                    ("17", "Execution plane: control vs. execution"),
                    ("18", "Protocol and correlation IDs"),
                    ("19", "Inside the ACP adapter"),
                    ("20", "How memory and compaction work"),
                    ("21", "Failure boundaries"),
                ]),
            ],
        },
        "s1_divider": {
            "title": "Capabilities",
            "subtitle": "What the agent can do",
            "chips": ["Coding · Browser", "Extensions · MCP", "Clients · ACP",
                      "Memory · Limits"],
        },
        "capability": {
            "eyebrow": "Capability map",
            "title": "Six capabilities that add up to a working agent",
            "subtitle": "Each one stands alone, and they chain together in a single conversation.",
            "cards": [
                ("01", "Coding assistant", [
                    "Edits files by fragment instead of rewriting them",
                    "ripgrep-class search plus structured LSP intelligence",
                    "Cross-platform commands; long ones move to background",
                ]),
                ("02", "Browser automation", [
                    "Drives real pages: navigate, click, fill, screenshot",
                    "Can reuse your own Chrome cookies and sessions",
                    "Reads network traffic to catch silent failures",
                ]),
                ("03", "Extensions", [
                    "Skills, slash commands, subagents, MCP, plugins",
                    "All Markdown or config; the core loop stays untouched",
                    "Merged across plugin, user, project, managed scopes",
                ]),
                ("04", "Clients", [
                    "Electron desktop, Web UI, and CLI stdio",
                    "ACP brings it into VS Code, Cursor, and IntelliJ",
                    "HTTP API plus TypeScript and Python SDKs",
                ]),
                ("05", "Memory and context", [
                    "Project rules stay resident; memory is recalled on demand",
                    "Session notes track progress for the current chat",
                    "Context compacts automatically; full history is kept",
                ]),
                ("06", "Safeguards", [
                    "Filesystem permission boundaries and deployment lockdown",
                    "Scheduled tasks, background tasks, offloaded outputs",
                    "Every failure is contained at the tool boundary",
                ]),
            ],
        },
        "coding": {
            "eyebrow": "Core coding",
            "title": "From reading the code to verifying the change",
            "subtitle": "The tools are not a pile of APIs — they form a search → understand → edit → verify chain.",
            "cards": [
                ("Files", "Read / Write / Edit", [
                    "Line-range reads keep whole files out of context",
                    "Exact replacement fails loudly instead of guessing",
                    "LSP diagnostics flow back after every write",
                ]),
                ("Search", "Glob / Grep", [
                    "ripgrep backend: regex, file types, context lines",
                    "Runs next to the workspace, remote included",
                    "Can return names only to control context cost",
                ]),
                ("Shell", "Bash / PowerShell", [
                    "Cross-platform shell that keeps cwd and state",
                    "Long commands move off the blocking agent path",
                    "A failure cancels siblings in the same group",
                ]),
                ("Code intelligence", "LSP", [
                    "Definitions, references, implementations, symbols, hover",
                    "Servers run beside the workspace, not on the control host",
                    "Passive diagnostics attach after Write and Edit",
                ]),
                ("Parallelism", "Subagents", [
                    "Explore: read-only parallel search, structured report",
                    "Plan: read-only architectural planning",
                    "general-purpose: open-ended read/write, shell, and web",
                ]),
                ("Visibility", "Plans and questions", [
                    "TodoWrite makes multi-step work explicit",
                    "AskUserQuestion interrupts only for real decisions",
                    "Plan mode designs first, implements after approval",
                ]),
            ],
        },
        "browser": {
            "eyebrow": "Browser automation",
            "title": "Snapshot, pick, act, then look again",
            "subtitle": "The agent works from a ref-tagged element snapshot, not from pixel coordinates.",
            "modes_title": "Two modes, one set of tools",
            "modes": [
                ("Isolated mode",
                 "A Chrome profile the agent owns. Zero config, right for local services and public sites."),
                ("Extension mode",
                 "Takes over your own Chrome through an extension, with existing cookies and signed-in sessions."),
            ],
            "lock_note": "browser_lock hands control back and forth explicitly: give the page to the user for a "
                         "login or a captcha, then take it back and keep the same session going.",
            "flow": [
                ("① navigate", "Opens the page, returns a first snapshot"),
                ("② snapshot", "A ref-tagged element tree, not pixels"),
                ("③ act", "fill_form and click elements by ref"),
                ("④ verify", "Judge from a fresh snapshot and network"),
            ],
            "loop_label": "Refs go stale → snapshot again",
            "verify_title": "Three possible outcomes",
            "verify": [
                ("Success", "The new snapshot contains heading \"Welcome back\""),
                ("Visible failure", "The snapshot shows an error message"),
                ("Hidden failure", "The page looks fine, but browser_network shows POST /api/login failed"),
            ],
            "note": "Snapshots give actionable elements; screenshots only give pixels. Oversized snapshots are "
                    "stored as files behind a bounded preview, and raw browser_cdp is restricted.",
        },
        "extensions": {
            "eyebrow": "Extensions",
            "title": "Five ways to extend, none of them touch the core loop",
            "subtitle": "Most extensions are rebuilt for every user turn, so edits take effect immediately.",
            "top": [
                ("Extra context", "Subagents", [
                    "Their own prompt, model tier, and tool set",
                    "No parent transcript, so the dispatch prompt must be self-contained",
                    "Results project back into that one parent tool call",
                ]),
                ("Reusable instructions", "Skills", [
                    "Defined in Markdown; SKILL.md is read lazily",
                    "Expand inline into the chat, or fork into a separate run",
                    "Raw arguments are appended so the request can't be dropped",
                ]),
                ("One entry point", "Slash commands", [
                    "Built-ins, Markdown templates, and skills share one registry",
                    "Supports $ARGUMENTS plus positional and named arguments",
                    "! runs shell and @ pulls in files during expansion",
                ]),
            ],
            "bottom": [
                ("External capability", "MCP", [
                    "External server tools join the same registry, deferred by default",
                    "Pooled by working directory plus config hash, closed after 30 idle minutes",
                ]),
                ("Packaging", "Plugins", [
                    "Declarative: one folder bundles agents, commands, skills, and MCP config",
                    "Code plugins register tools, middleware, and listeners at boot; changes need a restart",
                ]),
            ],
            "note": "Naming and precedence: plugin < user < project < managed. Built-in command names cannot be "
                    "shadowed, skills win over commands on a collision, and duplicate subagent types fail outright.",
        },
        "memory_feature": {
            "eyebrow": "Memory and context",
            "title": "Four mechanisms, four lifetimes",
            "subtitle": "They solve different problems and cannot substitute for each other.",
            "chart_label_w": 1.85,
            "sessions": ["Session 1", "Session 2 (current)", "Session 3"],
            "tracks": [
                ("Project rules", "Resident in the system prompt, every session", 0, 3, False),
                ("Auto memory", "Project-wide topic files, recalled on demand", 0, 3, True),
                ("Session memory", "This chat only", 1, 2, False),
                ("Compaction", "This turn's context", 1, 2, True),
            ],
            "rail": [
                ("Project rules", "Hand-maintained; paths: rules attach once a path is touched"),
                ("Auto memory", "Preferences and non-code facts, not what the source says"),
                ("Session memory", "summary.md progress ledger; compaction reads it, not retrieval"),
                ("Compaction", "Trims the model's projection; never uses auto memory as a summary"),
            ],
            "turn_marks": [
                ("Entering a turn", "Rules shape behavior; auto memory attaches topic files"),
                ("During the chat", "Session memory records current progress"),
                ("Before each model step", "Compact if the active context no longer fits"),
                ("After a successful turn", "Durable knowledge goes back to auto memory"),
            ],
        },
        "interfaces": {
            "eyebrow": "Clients",
            "title": "Four entry points, one runChatTurn()",
            "subtitle": "Changing the entry point does not change behavior: sessions, tools, and protocol types stay identical.",
            "cards": [
                ("Desktop", "Electron", "Local app; home for browser work"),
                ("Browser", "Web UI", "SSE streaming, private Docker deploy"),
                ("IDE", "ACP", "Native sidebar in VS Code and IntelliJ"),
                ("Automation", "HTTP API", "REST + SSE, TypeScript and Python SDKs"),
                ("Scripting", "CLI stdio", "One NDJSON line per message; CI friendly"),
            ],
            "engine": "runChatTurn()",
            "engine_caption": "One agent engine: the same sessions, tools, and protocol types",
            "shared": [
                ("One session model", [
                    "Sessions, tools, and wire types share definitions",
                    "A session from any client resumes in another",
                ]),
                ("Config resolved per workspace", [
                    "Settings resolve against the current cwd",
                    "User and project settings merge, project wins",
                ]),
                ("Adapters only translate", [
                    "HTTP, stdio, and ACP hold no agent logic",
                    "A new client means a new adapter, nothing more",
                ]),
            ],
        },
        "acp_feature": {
            "eyebrow": "ACP",
            "title": "Use it straight from VS Code, Cursor, or IntelliJ",
            "subtitle": "Agent Client Protocol: write the adapter once, plug into every ACP-capable editor.",
            "code_title": "VS Code / Cursor user settings",
            "bullets": [
                "args must start with tsx, then the absolute path to start.js",
                "Without tsx the sidebar shows Failed to load sessions",
                "Append \"--workspace\", \"<path>\" to pin a default workspace",
                "Terminal check: npm run acp -- --workspace <path>",
                "IntelliJ uses ACP too, with the same configuration shape",
            ],
            "rows_title": "What you get in the sidebar",
            "rows": [
                ("Streaming answers", "Text arrives incrementally; no waiting for the full response"),
                ("Thinking", "Reasoning streams separately from the final answer"),
                ("Tool cards", "Pending, running, completed or failed, with args and file locations"),
                ("Task plans", "TodoWrite maps straight onto the editor's plan panel"),
                ("Permission prompts", "Out-of-bounds actions ask first and run only after you answer"),
                ("Mode switching", "Agent, Ask, and Plan are switchable in the sidebar"),
                ("Image input", "Images and embedded context blocks are supported"),
            ],
            "note": "The ACP adapter does more than reframe messages — it translates engine internals into "
                    "session updates the editor can render directly.",
            "rows_col1": 1.85,
        },
        "engineering": {
            "eyebrow": "Safeguards",
            "title": "What makes it safe to run on a real project",
            "subtitle": "The more the agent can do, the more explicit its boundaries have to be.",
            "cards": [
                ("Boundary", "Filesystem permissions", [
                    "Read, Grep, Glob, LSP, Edit, and Write share one gate",
                    "Lexical and real paths are both checked, symlinks included",
                    "Deny rules run first and always win",
                ]),
                ("Modes", "Three default behaviors", [
                    "default: ask, with Allow / Always allow / Reject",
                    "dontAsk: anything unresolved becomes a denial",
                    "bypassPermissions: outside paths run, deny still applies",
                ]),
                ("Deployment", "SSO lockdown", [
                    "AUTH_ENABLED=true forces dontAsk",
                    "allow rules and extra directories drop out; deny stays",
                    "Note: an application boundary, not an OS sandbox",
                ]),
                ("Scheduling", "Scheduled tasks", [
                    "A one-shot timestamp, or five-field cron in local time",
                    "At most 50 per process, serialized within a session",
                    "Recurring tasks get jitter and expire after seven days",
                ]),
                ("Long work", "Background tasks", [
                    "Long commands leave the blocking agent path",
                    "They need explicit polling or termination; the worker kills leftovers on exit",
                ]),
                ("Context", "Offloaded large outputs", [
                    "Claim-check: the model sees a preview and a reference",
                    "The full payload lands in session tool storage",
                    "Keeps the prompt-cache prefix stable across later steps",
                ]),
            ],
        },
        "s2_divider": {
            "title": "Architecture & implementation",
            "subtitle": "How one conversation actually runs",
            "chips": ["Turn · Query", "Tools · Permissions", "Execution plane",
                      "Protocol · ACP"],
        },
        "overview": {
            "eyebrow": "System overview",
            "title": "Six layers, each with one job",
            "subtitle": "Every entry point converges on the same turn host and query loop.",
            "layers": [
                ("Clients",
                 "Electron desktop   ·   Web UI   ·   VS Code / Cursor   ·   IntelliJ   ·   CLI   ·   SDK"),
                ("Adapters",
                 "HTTP + SSE   ·   stdio NDJSON   ·   ACP   ·   worker — translation only, no agent logic"),
                ("Turn host  runChatTurn()",
                 "Turn settings   ·   abort propagation   ·   memory side paths   ·   completion   ·   persistence"),
                ("Query loop  query()",
                 "preTurn → runStep → postTurn   ·   owns loop counter, active tool set, stop reason"),
                ("Tools",
                 "assembleToolPool   ·   canUseTool permission gate   ·   StreamingToolExecutor"),
                ("Execution plane",
                 "A local or SSH worker — filesystem, shell, ripgrep, background processes, LSP"),
            ],
            "rail_title": "Cross-cutting",
            "rail": [
                "Models: pluggable provider strategies",
                "Sessions: append-only transcript, persistence and replay",
                "Protocol: Zod schemas in protocol/src define the contract",
                "Permissions: the filesystem gate and session modes",
                "Extensions: skills, commands, subagents, MCP, plugins",
            ],
            "label_w": 2.6,
        },
        "end_to_end": {
            "eyebrow": "End to end",
            "title": "One message, from arrival to storage",
            "subtitle": "Five stages with no overlapping responsibility.",
            "flow": [
                ("① Entry selection", "src/entrypoints/cli.ts picks HTTP, stdio, ACP, or worker mode"),
                ("② Adapter", "Turns client input into one turn and calls the transport-independent runChatTurn()"),
                ("③ Prepare context", "prepareChatTurn() resolves slash commands, rules, plugins, skills, MCP, permissions, and the backend, then builds the tool pool"),
                ("④ Run the loop", "query() alternates model steps and tool steps until no tools are requested"),
                ("⑤ Finish and persist", "runChatTurn() saves new session messages, emits completion, releases the backend"),
            ],
            "notes": [
                ("Wire events are not the persistence layer",
                 "What the client sees is a live view. The real session messages are written by the turn host after the loop has updated history."),
                ("One active turn per session",
                 "The same transcript is never mutated concurrently. A second request queues or is rejected, so history cannot interleave."),
                ("Remote resolution fails closed",
                 "When the requested remote workspace is unavailable, preparation throws instead of running file and shell work on the control machine."),
            ],
        },
        "agent_loop": {
            "eyebrow": "Agent loop",
            "title": "The agent is not one model call",
            "subtitle": "The model only proposes; the loop decides whether to continue.",
            "nodes": [
                ("preTurn", "Trim to the latest compact boundary"),
                ("runStep", "Stream the model, run safe tools"),
                ("postTurn", "Attach memory, activate new tools"),
            ],
            "decision": "Any tool calls?",
            "yes": "Yes → back to preTurn",
            "no": "No",
            "done": "Turn complete",
            "done_caption": "Persist, emit completion",
            "levels": [
                ("runChatTurn()", [
                    "Turn-scoped settings, middleware, aborts",
                    "Memory recall before, extraction after",
                ]),
                ("query()", [
                    "Owns the loop counter and active tool set",
                    "At maxSteps, tools off and one final answer",
                ]),
                ("runStep()", [
                    "Normalize → streamText() → consume",
                    "Tool calls queue as blocks arrive",
                ]),
            ],
            "note": "One detail: after an approved plan, a response with no tool calls can be overridden once with "
                    "a reminder that forces a real implementation step.",
        },
        "tool_pipeline": {
            "eyebrow": "Tool pipeline",
            "title": "Six gates between the registry and the model's result",
            "subtitle": "The runtime decides what is visible, what is allowed, how it runs, and what each audience sees.",
            "flow": [
                ("Sources", "Built-in registry, per-turn skill and subagent tools, external MCP tools"),
                ("Assembly", "assembleToolPool() splits everything into active and deferred"),
                ("Narrowing", "Enablement, primary-agent allow/deny, browser policy, current mode"),
                ("Queueing", "StreamingToolExecutor decides serial or parallel"),
                ("Permission", "canUseTool allows, denies, or waits right before execution"),
                ("Projections", "The model gets bounded text; the wire also gets tool_use_result"),
            ],
            "cards": [
                ("Deferred loading and ToolSearch", [
                    "MCP tools are deferred and cost no prompt space",
                    "Search is discovery only; using it in the same batch fails",
                ]),
                ("Concurrency policy", [
                    "Parallel only when the input is known to be safe",
                    "A failed Bash cancels siblings in the same group",
                ]),
                ("Failures stay at the tool boundary", [
                    "Unknown, denied, thrown, and timed out all become isError",
                    "The loop survives; both projections share one tool_use_id",
                ]),
            ],
        },
        "execution": {
            "eyebrow": "Execution plane",
            "title": "Orchestration stays central, operations sit next to the files",
            "subtitle": "Tools face a single ExecutionBackend; local and SSH expose exactly the same contract.",
            "control_title": "Control plane",
            "control": [
                ("Sessions & models", "Orchestration and provider strategy"),
                ("Permissions", "Environment selection too"),
                ("Worker lifecycle", "Start, health check, disposal"),
                ("RuntimeBroker", "Reuse by environmentId::cwd"),
            ],
            "exec_title": "Execution plane",
            "exec": [
                ("Filesystem", "Reads, writes, path checks"),
                ("Shell & ripgrep", "Commands run next to the files"),
                ("Background work", "Long processes are hosted here"),
                ("Language servers", "LSP runs beside the workspace"),
            ],
            "rpc_title": "RPC",
            "rpc_out": "Operation + request ID",
            "rpc_back": "Results correlate back by ID",
            "boundary": "Process / machine boundary",
            "code_title": "Workspace handle = environment ID + path inside it",
            "rows": [
                ("Bind timeout", "15 seconds locally, 90 over SSH; a failed chdir fails the bind"),
                ("Path guard", "Paths outside the workspace are rejected before sending"),
                ("Fail-closed", "A failed SSH probe, deploy, or bind aborts — no local substitute"),
                ("Remote scope", "Plugins and skills load centrally; rules and memory skip the remote tree"),
            ],
            "rows_col1": 1.35,
        },
        "protocol": {
            "eyebrow": "Protocol",
            "title": "A typed boundary between the engine and its clients",
            "subtitle": "Zod schemas in protocol/src define separate incoming and outgoing message unions.",
            "transports_title": "Three transports, one exit",
            "transports": [
                ("HTTP", "SSE event names plus the same outgoing messages as JSON"),
                ("stdio", "One NDJSON message per line; stdout stays open between turns"),
                ("ACP", "Not just reframing: engine messages become ACP session updates"),
            ],
            "wire_note": "WireEmitter is the engine's one transport-neutral output: it stamps correlation context, "
                         "then emits stream, tool, progress, control, and result events. Worker stdio is a separate "
                         "control-plane-to-worker contract that evolves independently.",
            "ids_title": "Correlation IDs: the only reliable way to stitch concurrent work",
            "ids": [
                ("session_id", "Associates every event with one conversation"),
                ("tool_use_id", "Joins calls, progress, timing, and results under concurrency"),
                ("request_id", "Joins a control request to its response or cancellation"),
                ("parent_tool_use_id", "Marks nested work, such as calls inside a subagent"),
                ("system/init", "Announces protocol version, permission mode, working directory"),
            ],
            "notes": [
                "Any non-protocol output on stdout corrupts NDJSON and ACP JSON-RPC framing — startup, worker, "
                "and diagnostic logs all belong on stderr.",
                "Never join tool activity by tool name: only tool_use_id is unique under concurrency. Breaking "
                "contract changes require a protocol version bump.",
            ],
            "ids_col1": 1.85,
            "name_w": 0.75,
        },
        "acp_impl": {
            "eyebrow": "ACP implementation",
            "title": "One adapter that explains the engine to the editor",
            "subtitle": "Inside src/acp/: session management, convergence on the shared turn host, outbound translation, permission bridge.",
            "comp_title": "Component responsibilities",
            "comps": [
                ("BaizeAcpAgent", "initialize / newSession / prompt / setSessionMode / cancel"),
                ("AcpSessionRegistry", "Tracks sessions and cwd by sessionId, handles cancellation"),
                ("runAcpPromptTurn", "Converges an ACP prompt onto the shared turn host"),
                ("AcpTurnSink", "Implements ProtocolSink, translates outbound wire messages"),
                ("permission-bridge", "control_request → client prompt → decision back to the engine"),
                ("tool-kind", "Maps tool names and args to a title, kind, and file locations"),
                ("prompt-input", "Splits ACP content blocks into text and image input"),
            ],
            "comp_note": "Capabilities declared: loadSession=false, image input and embedded context enabled, "
                         "MCP over http and sse; the mode set is fixed to Agent, Ask, and Plan.",
            "map_title": "Outbound message mapping",
            "maps": [
                ("stream_event · text", "agent_message_chunk"),
                ("stream_event · reasoning", "agent_thought_chunk"),
                ("tool_call", "tool_call (pending, with locations and rawInput)"),
                ("tool_progress", "tool_call_update (in_progress)"),
                ("tool_result", "tool_call_update (completed / failed + rawOutput)"),
                ("system · todo_update", "plan (cancelled entries filtered out)"),
                ("system · mode_changed", "current_mode_update"),
                ("result · error", "Surfaced to the user as an agent_message_chunk"),
                ("Repeated tool_use_id", "Emits tool_call_update instead of a new card"),
            ],
            "comp_col1": 1.85,
            "map_col1": 2.25,
        },
        "memory_impl": {
            "eyebrow": "Memory and compaction",
            "title": "Recall takes two lanes; compaction has three levels",
            "subtitle": "Both are designed so they never block the main turn.",
            "recall_title": "Auto memory recall: two lanes that never merge",
            "start": "Recall request",
            "fast": ("Fast Lane", "Scores filename and metadata, no model call"),
            "decision": "Strong hit?",
            "yes": "Yes",
            "no": "No",
            "lanes": [
                ("Fast Lane hit", "Exact match or ≥0.82 leading by 0.12; up to 3 files"),
                ("Semantic Lane", "Small model ranks, up to 5; queries under 10 chars skip it"),
            ],
            "out": ("Attach to context", "Selected topic files ride along this turn"),
            "recall_notes": [
                "Normal turns never wait; explicit recall waits 4s",
                "Files already surfaced this session are filtered out",
                "All Fast Lane or all Semantic Lane, never a mix",
            ],
            "compact_title": "Three levels of compaction: do as little as possible",
            "compaction": [
                ("Micro compact",
                 [("Old payloads cleared", 4, False), ("Pairs kept", 3, True)],
                 "In-process projection only, no boundary"),
                ("Session compact",
                 [("summary.md", 3, True), ("Pairing-safe tail", 4, False)],
                 "Reuses session memory, appends a boundary"),
                ("Full compact",
                 [("Model summary", 3, True), ("boundary + tail", 4, False)],
                 "Only when notes are missing or stale"),
            ],
        },
        "failure": {
            "eyebrow": "Failure boundaries",
            "title": "Where the system falls back when things break",
            "subtitle": "These boundaries are designed in, not patched on afterwards.",
            "rows": [
                ("User interrupt", "Usable partial output is committed and the interruption recorded; the turn ends as aborted"),
                ("Tool errors", "Unknown tools, denials, exceptions, and timeouts become isError results; a failed Bash also cancels siblings"),
                ("Context overflow", "One reactive compaction retry; only a second failure propagates as an error"),
                ("Step limit", "Tools are disabled and one final answer is forced; if that fails the wire reports the limit"),
                ("Remote unavailable", "Fail-closed: remote preparation aborts rather than running file and shell work locally"),
                ("Concurrent writes", "One active turn per session, so a transcript is never rewritten concurrently"),
                ("Extension errors", "Malformed plugin manifests, skills, or MCP JSON report their source; other extensions keep loading"),
                ("MCP offline", "That server's tools go missing; config changes replace the pooled manager, not a live connection"),
                ("Protocol mismatch", "Adapters reject invalid messages; breaking contract changes require a protocol version bump"),
            ],
            "rows_col1": 2.0,
        },
        "closing": {
            "eyebrow": "WRAP UP",
            "title": "Three sentences to remember",
            "cards": [
                ("01", "One engine",
                 "Desktop, Web, IDE, and API all converge on the same turn host and query loop. The entry point never changes behavior."),
                ("02", "Explicit boundaries",
                 "The permission gate, the execution plane, and the protocol schema keep capability and risk separately managed."),
                ("03", "Extensible",
                 "Tools, skills, subagents, and MCP plug in without touching the core loop, and most are rebuilt every turn."),
            ],
            "demo_title": "Live demos",
            "demos": [
                "Run a real change from the IDE sidebar over ACP",
                "Verify a login flow with browser automation",
                "Search and edit inside an SSH remote workspace",
            ],
            "footer": "Questions  ·  Coding Agent",
        },
    },
}

CARD_COLORS = [BLUE, CYAN, PURPLE, GREEN, AMBER, ROSE]


# ── slides ────────────────────────────────────────────────────────────────

def slide_cover(prs, blank, c):
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 1, c["brand"])
    t = c["cover"]
    add_text(slide, t["eyebrow"], M, 1.5, 5.4, 0.3, 11, CYAN, True)
    add_rect(slide, M, 1.86, 0.52, 0.05, CYAN)
    add_text(slide, t["title"], M, 2.14, 5.7, 1.5, 33, NAVY, True, spacing=1.12)
    add_text(slide, t["subtitle"], M, 3.86, 5.5, 0.4, 14, MUTED)
    add_pill(slide, t["pill"], M, 4.5, 3.4, 0.52, BLUE, WHITE, 11)
    add_rect(slide, M, 5.74, 5.4, 0.012, LINE)
    add_text(slide, t["footer"], M, 6.0, 5.4, 0.34, 11, MUTED)

    card_x = 6.55
    card_w = W - M - card_x
    for index, (tag, title, caption) in enumerate(t["cards"]):
        color = (BLUE, PURPLE)[index]
        y = 1.5 + index * 2.6
        add_card(slide, card_x, y, card_w, 2.3)
        add_rect(slide, card_x, y + 0.3, 0.09, 1.7, color)
        add_text(slide, tag, card_x + 0.46, y + 0.34, 3.0, 0.28, 11, color, True)
        add_text(slide, title, card_x + 0.46, y + 0.76, card_w - 0.9, 0.46, 24,
                 NAVY, True)
        add_text(slide, caption, card_x + 0.46, y + 1.34, card_w - 0.9, 0.7,
                 11.5, MUTED, spacing=1.35, anchor=MSO_ANCHOR.TOP)


def slide_agenda(prs, blank, c):
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 2, c["brand"], c["tags"]["agenda"])
    t = c["agenda"]
    add_page_title(slide, t["eyebrow"], t["title"], t["subtitle"], BLUE)

    col_w = (CW - 0.34) / 2
    for index, (heading, items) in enumerate(t["columns"]):
        accent = (BLUE, PURPLE)[index]
        x = M + index * (col_w + 0.34)
        h = BODY_BOTTOM - BODY_TOP
        add_card(slide, x, BODY_TOP, col_w, h)
        add_rect(slide, x, BODY_TOP, col_w, 0.06, accent)
        add_text(slide, heading, x + 0.36, BODY_TOP + 0.3, col_w - 0.7, 0.32,
                 13, NAVY, True)
        row_h = (h - 0.98) / len(items)
        for row, (number, label) in enumerate(items):
            ry = BODY_TOP + 0.82 + row * row_h
            add_text(slide, number, x + 0.36, ry, 0.5, row_h, 11, accent, True)
            add_text(slide, label, x + 0.92, ry, col_w - 1.3, row_h, 11.5, NAVY)
            if row:
                add_rect(slide, x + 0.36, ry, col_w - 0.72, 0.008, LINE)


def slide_section_one(prs, blank, c):
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 3, c["brand"], c["tags"]["s1"])
    t = c["s1_divider"]
    add_section_divider(slide, "01", BLUE, t["title"], t["subtitle"], t["chips"])


def slide_capability_map(prs, blank, c):
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 4, c["brand"], c["tags"]["s1_page"])
    t = c["capability"]
    add_page_title(slide, t["eyebrow"], t["title"], t["subtitle"], BLUE)
    add_grid(slide, t["cards"], CARD_COLORS,
             body_size=c["style"]["grid_body"])


def slide_coding(prs, blank, c):
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 5, c["brand"], c["tags"]["s1_page"])
    t = c["coding"]
    add_page_title(slide, t["eyebrow"], t["title"], t["subtitle"], BLUE)
    add_grid(slide, t["cards"], [BLUE, CYAN, GREEN, PURPLE, AMBER, ROSE],
             body_size=c["style"]["grid_body"])


def slide_browser(prs, blank, c):
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 6, c["brand"], c["tags"]["s1_page"])
    t = c["browser"]
    add_page_title(slide, t["eyebrow"], t["title"], t["subtitle"], CYAN)

    # The four steps across the top, closed by an explicit re-snapshot edge.
    node_w = (CW - 3 * 0.52) / 4
    node_h = 0.98
    node_y = BODY_TOP + 0.14
    centers = []
    for index, (title, caption) in enumerate(t["flow"]):
        x = M + index * (node_w + 0.52)
        add_node(slide, title, caption, x, node_y, node_w, node_h,
                 [BLUE, CYAN, PURPLE, GREEN][index], 12, 9, shadow=True)
        centers.append(x + node_w / 2)
        if index:
            add_line(slide, (x - 0.46, node_y + node_h / 2),
                     (x - 0.08, node_y + node_h / 2), FAINT, 1.5)

    loop_y = node_y + node_h + 0.42
    add_path(slide, [(centers[3], node_y + node_h), (centers[3], loop_y),
                     (centers[1], loop_y), (centers[1], node_y + node_h)],
             CYAN, 1.5)
    add_edge_label(slide, t["loop_label"], (centers[1] + centers[3]) / 2,
                   loop_y, 2.7, 9.5, CYAN)

    lower_y = loop_y + 0.3
    lower_h = BODY_BOTTOM - lower_y
    col_w = (CW - 2 * 0.3) / 3

    add_card(slide, M, lower_y, col_w, lower_h)
    add_text(slide, t["modes_title"], M + 0.28, lower_y + 0.2, col_w - 0.56,
             0.3, 12.5, NAVY, True)
    for index, (name, caption) in enumerate(t["modes"]):
        y = lower_y + 0.64 + index * 0.9
        add_rect(slide, M + 0.28, y + 0.04, 0.06, 0.7, (CYAN, PURPLE)[index])
        add_text(slide, name, M + 0.48, y, col_w - 0.86, 0.26, 11, NAVY, True)
        add_text(slide, caption, M + 0.48, y + 0.28, col_w - 0.86, 0.5, 9.2,
                 MUTED, spacing=1.26, anchor=MSO_ANCHOR.TOP)

    mid_x = M + col_w + 0.3
    add_card(slide, mid_x, lower_y, col_w, lower_h)
    add_text(slide, t["verify_title"], mid_x + 0.28, lower_y + 0.2,
             col_w - 0.56, 0.3, 12.5, NAVY, True)
    for index, (state, caption) in enumerate(t["verify"]):
        color = (GREEN, AMBER, ROSE)[index]
        y = lower_y + 0.64 + index * 0.6
        add_dot(slide, str(index + 1), mid_x + 0.28, y + 0.02, 0.24, color, 8.5)
        add_text(slide, state, mid_x + 0.62, y, col_w - 0.94, 0.26, 10, color,
                 True)
        add_text(slide, caption, mid_x + 0.62, y + 0.24, col_w - 0.94, 0.32,
                 8.8, MUTED, spacing=1.22, anchor=MSO_ANCHOR.TOP)

    right_x = mid_x + col_w + 0.3
    note_h = (lower_h - 0.22) / 2
    add_note(slide, t["lock_note"], right_x, lower_y, col_w, note_h, GREEN, 9.5)
    add_note(slide, t["note"], right_x, lower_y + note_h + 0.22, col_w, note_h,
             AMBER, 9.5)


def slide_extensions(prs, blank, c):
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 7, c["brand"], c["tags"]["s1_page"])
    t = c["extensions"]
    add_page_title(slide, t["eyebrow"], t["title"], t["subtitle"], PURPLE)

    top_h = 2.16
    add_grid(slide, t["top"], [PURPLE, BLUE, CYAN], cols=3, y=BODY_TOP, h=top_h,
             body_size=c["style"]["grid_body"])

    bottom_y = BODY_TOP + top_h + 0.28
    bottom_h = 1.34
    add_grid(slide, t["bottom"], [GREEN, AMBER], cols=2, y=bottom_y, h=bottom_h,
             title_size=13.5, body_size=c["style"]["grid_body"])

    add_note(slide, t["note"], M, bottom_y + bottom_h + 0.24, CW, 0.62, ROSE,
             10.5)


def slide_memory_feature(prs, blank, c):
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 8, c["brand"], c["tags"]["s1_page"])
    t = c["memory_feature"]
    add_page_title(slide, t["eyebrow"], t["title"], t["subtitle"], AMBER)

    # Lifetime chart: how far each mechanism reaches across sessions.
    colors = [BLUE, PURPLE, CYAN, GREEN]
    chart_w = 7.9
    label_w = t["chart_label_w"]
    track_x = M + label_w + 0.12
    span = (chart_w - label_w - 0.12) / len(t["sessions"])

    head_y = BODY_TOP + 0.02
    rows_y = head_y + 0.46
    rows_h = len(t["tracks"]) * 0.68
    for index, name in enumerate(t["sessions"]):
        x = track_x + index * span
        add_text(slide, name, x, head_y, span, 0.28, 9.5, FAINT, True,
                 PP_ALIGN.CENTER)
        if index:
            add_rect(slide, x, head_y + 0.34, 0.01, rows_h + 0.12, LINE)

    for index, (name, label, start, end, soft) in enumerate(t["tracks"]):
        y = rows_y + index * 0.68
        add_text(slide, name, M, y, label_w, 0.56, 10.5, NAVY, True)
        add_span(slide, label, track_x + start * span + 0.05, y + 0.1,
                 (end - start) * span - 0.1, 0.36, colors[index], 9.2, soft)

    rail_x = M + chart_w + 0.3
    rail_w = W - M - rail_x
    rail_h = (rows_y + rows_h - BODY_TOP - 3 * 0.14) / 4
    for index, (title, caption) in enumerate(t["rail"]):
        y = BODY_TOP + index * (rail_h + 0.14)
        add_card(slide, rail_x, y, rail_w, rail_h, WHITE, LINE, shadow=False)
        add_rect(slide, rail_x, y + 0.12, 0.06, rail_h - 0.24, colors[index])
        add_text(slide, title, rail_x + 0.26, y + 0.08, rail_w - 0.48, 0.24,
                 10.5, NAVY, True)
        add_text(slide, caption, rail_x + 0.26, y + 0.34, rail_w - 0.48, 0.32,
                 9, MUTED, spacing=1.22, anchor=MSO_ANCHOR.TOP)

    # One turn on a timeline: when each mechanism actually fires.
    line_y = 5.98
    add_line(slide, (M + 0.1, line_y), (M + CW - 0.1, line_y), LINE, 2)
    for index, (title, caption) in enumerate(t["turn_marks"]):
        cx = M + (index + 0.5) * CW / len(t["turn_marks"])
        add_shape(slide, MSO_SHAPE.OVAL, cx - 0.075, line_y - 0.075, 0.15, 0.15,
                  AMBER)
        add_text(slide, title, cx - 1.42, line_y + 0.16, 2.84, 0.24, 9.5, NAVY,
                 True, PP_ALIGN.CENTER)
        add_text(slide, caption, cx - 1.42, line_y + 0.42, 2.84, 0.3, 8.8,
                 MUTED, align=PP_ALIGN.CENTER, spacing=1.2,
                 anchor=MSO_ANCHOR.TOP)


def slide_interfaces(prs, blank, c):
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 9, c["brand"], c["tags"]["s1_page"])
    t = c["interfaces"]
    add_page_title(slide, t["eyebrow"], t["title"], t["subtitle"], GREEN)

    # Five clients fanning into one engine box.
    gap = 0.24
    cw = (CW - 4 * gap) / 5
    card_h = 1.12
    centers = []
    for index, (tag, title, caption) in enumerate(t["cards"]):
        color = [BLUE, CYAN, PURPLE, GREEN, AMBER][index]
        x = M + index * (cw + gap)
        add_card(slide, x, BODY_TOP, cw, card_h)
        add_rect(slide, x, BODY_TOP, cw, 0.06, color)
        add_text(slide, tag, x + 0.16, BODY_TOP + 0.18, cw - 0.32, 0.22, 9,
                 color, True, PP_ALIGN.CENTER)
        add_text(slide, title, x + 0.14, BODY_TOP + 0.44, cw - 0.28, 0.3, 14.5,
                 NAVY, True, PP_ALIGN.CENTER)
        add_text(slide, caption, x + 0.14, BODY_TOP + 0.76, cw - 0.28, 0.32,
                 8.8, MUTED, align=PP_ALIGN.CENTER, spacing=1.22,
                 anchor=MSO_ANCHOR.TOP)
        centers.append(x + cw / 2)

    bus_y = BODY_TOP + card_h + 0.38
    for cx in centers:
        add_line(slide, (cx, BODY_TOP + card_h), (cx, bus_y), LINE, 1.25,
                 arrow=False)
    add_line(slide, (centers[0], bus_y), (centers[-1], bus_y), LINE, 1.25,
             arrow=False)

    engine_w = 6.4
    engine_x = (W - engine_w) / 2
    engine_y = bus_y + 0.34
    engine_h = 0.94
    add_line(slide, (W / 2, bus_y), (W / 2, engine_y), GREEN, 1.75)
    add_card(slide, engine_x, engine_y, engine_w, engine_h, NAVY, NAVY)
    add_text(slide, t["engine"], engine_x + 0.2, engine_y + 0.16,
             engine_w - 0.4, 0.34, 15.5, WHITE, True, PP_ALIGN.CENTER)
    add_text(slide, t["engine_caption"], engine_x + 0.3, engine_y + 0.54,
             engine_w - 0.6, 0.3, 9.5, RGBColor(176, 196, 230),
             align=PP_ALIGN.CENTER)

    shared_y = engine_y + engine_h + 0.3
    shared_h = BODY_BOTTOM - shared_y
    inner_w = (CW - 2 * 0.3) / 3
    for index, (title, lines) in enumerate(t["shared"]):
        x = M + index * (inner_w + 0.3)
        add_card(slide, x, shared_y, inner_w, shared_h, SURFACE, LINE,
                 shadow=False)
        add_text(slide, title, x + 0.26, shared_y + 0.16, inner_w - 0.52, 0.26,
                 11, NAVY, True)
        add_body(slide, lines, x + 0.26, shared_y + 0.48, inner_w - 0.52,
                 shared_h - 0.6, 9.2, spacing=1.26, space_after=3)


def slide_acp_feature(prs, blank, c):
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 10, c["brand"], c["tags"]["s1_page"])
    t = c["acp_feature"]
    add_page_title(slide, t["eyebrow"], t["title"], t["subtitle"], PURPLE)

    left_w = 5.1
    add_code(slide, [
        '"acp.agents": {',
        '  "Coding Agent": {',
        '    "command": "npx",',
        '    "args": ["tsx", "<repo>/start.js", "--acp"],',
        '    "env": {}',
        '  }',
        '}',
    ], M, BODY_TOP, left_w, 2.1, t["code_title"], CYAN)

    add_body(slide, t["bullets"], M + 0.04, BODY_TOP + 2.34, left_w - 0.08,
             BODY_BOTTOM - BODY_TOP - 2.34, 10.5, spacing=1.35, space_after=6)

    right_x = M + left_w + 0.36
    right_w = CW - left_w - 0.36
    add_text(slide, t["rows_title"], right_x, BODY_TOP - 0.02, right_w, 0.3, 13,
             NAVY, True)
    add_rows(slide, t["rows"], right_x, BODY_TOP + 0.36, right_w, PURPLE,
             col1=t["rows_col1"], row_h=0.46, size=11)
    add_note(slide, t["note"], right_x, BODY_TOP + 3.72, right_w, 0.56, PURPLE,
             10.5)


def slide_engineering(prs, blank, c):
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 11, c["brand"], c["tags"]["s1_page"])
    t = c["engineering"]
    add_page_title(slide, t["eyebrow"], t["title"], t["subtitle"], ROSE)
    add_grid(slide, t["cards"], [ROSE, BLUE, PURPLE, GREEN, CYAN, AMBER],
             body_size=c["style"]["grid_body"])


def slide_section_two(prs, blank, c):
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 12, c["brand"], c["tags"]["s2"])
    t = c["s2_divider"]
    add_section_divider(slide, "02", PURPLE, t["title"], t["subtitle"],
                        t["chips"])


def slide_overview(prs, blank, c):
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 13, c["brand"], c["tags"]["s2_page"])
    t = c["overview"]
    add_page_title(slide, t["eyebrow"], t["title"], t["subtitle"], PURPLE)

    rail_w = 2.5
    stack_w = CW - rail_w - 0.32
    colors = [BLUE, CYAN, PURPLE, GREEN, AMBER, ROSE]
    total_h = BODY_BOTTOM - BODY_TOP
    gap = 0.12
    lh = (total_h - (len(t["layers"]) - 1) * gap) / len(t["layers"])
    label_w = t["label_w"]
    for index, (name, items) in enumerate(t["layers"]):
        y = BODY_TOP + index * (lh + gap)
        add_card(slide, M, y, stack_w, lh, WHITE, LINE, shadow=False)
        add_rect(slide, M, y, 0.08, lh, colors[index])
        add_text(slide, name, M + 0.3, y, label_w, lh, 11.5, NAVY, True)
        add_text(slide, items, M + label_w + 0.4, y,
                 stack_w - label_w - 0.65, lh, 10, MUTED)

    rail_x = M + stack_w + 0.32
    add_card(slide, rail_x, BODY_TOP, rail_w, total_h, SURFACE, LINE,
             shadow=False)
    add_text(slide, t["rail_title"], rail_x + 0.26, BODY_TOP + 0.24,
             rail_w - 0.52, 0.3, 12, NAVY, True)
    add_body(slide, t["rail"], rail_x + 0.26, BODY_TOP + 0.66, rail_w - 0.52,
             total_h - 0.9, 9.5, spacing=1.35, space_after=6)


def slide_end_to_end(prs, blank, c):
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 14, c["brand"], c["tags"]["s2_page"])
    t = c["end_to_end"]
    add_page_title(slide, t["eyebrow"], t["title"], t["subtitle"], BLUE)

    add_flow(slide, t["flow"], M, BODY_TOP, CW, 2.22, BLUE, gap=0.24,
             title_size=12.5, body_size=9.5)

    note_y = BODY_TOP + 2.5
    note_h = BODY_BOTTOM - note_y
    gap = 0.28
    nw = (CW - 2 * gap) / 3
    for index, (title, text) in enumerate(t["notes"]):
        color = [PURPLE, GREEN, ROSE][index]
        x = M + index * (nw + gap)
        add_card(slide, x, note_y, nw, note_h)
        add_rect(slide, x, note_y, nw, 0.06, color)
        add_text(slide, title, x + 0.3, note_y + 0.3, nw - 0.6, 0.3, 12.5, NAVY,
                 True)
        add_text(slide, text, x + 0.3, note_y + 0.72, nw - 0.6, note_h - 0.98,
                 10, MUTED, spacing=1.35, anchor=MSO_ANCHOR.TOP)


def slide_agent_loop(prs, blank, c):
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 15, c["brand"], c["tags"]["s2_page"])
    t = c["agent_loop"]
    add_page_title(slide, t["eyebrow"], t["title"], t["subtitle"], GREEN)

    diagram_w = 8.0
    node_w, node_h = 2.24, 0.94
    top_y = BODY_TOP + 0.26
    gap = (diagram_w - 3 * node_w) / 2
    centers = []
    for index, (title, caption) in enumerate(t["nodes"]):
        x = M + index * (node_w + gap)
        add_node(slide, title, caption, x, top_y, node_w, node_h,
                 [PURPLE, BLUE, GREEN][index], 12, 8.8, shadow=True)
        centers.append(x + node_w / 2)
        if index:
            add_line(slide, (x - gap + 0.06, top_y + node_h / 2),
                     (x - 0.08, top_y + node_h / 2), FAINT, 1.5)

    dia_w, dia_h = 2.5, 0.96
    dia_y = top_y + node_h + 0.36
    add_line(slide, (centers[2], top_y + node_h), (centers[2], dia_y), FAINT,
             1.5)
    add_diamond(slide, t["decision"], centers[2] - dia_w / 2, dia_y, dia_w,
                dia_h, AMBER, 9.5)

    # "Yes" folds back to preTurn; that edge is what makes this a loop.
    back_y = dia_y + dia_h / 2
    add_path(slide, [(centers[2] - dia_w / 2, back_y), (centers[0], back_y),
                     (centers[0], top_y + node_h)], GREEN, 1.5)
    add_edge_label(slide, t["yes"], (centers[2] - dia_w / 2 + centers[0]) / 2,
                   back_y, 1.9, 9.5, GREEN)

    done_y = dia_y + dia_h + 0.24
    add_line(slide, (centers[2], dia_y + dia_h), (centers[2], done_y), FAINT,
             1.5)
    add_text(slide, t["no"], centers[2] + 0.1, dia_y + dia_h - 0.02, 0.7, 0.24,
             9, MUTED, True)
    add_node(slide, t["done"], t["done_caption"], centers[2] - node_w / 2,
             done_y, node_w, 0.8, ROSE, 11.5, 8.8)

    rail_x = M + diagram_w + 0.26
    rail_w = W - M - rail_x
    rail_h = (done_y + 0.8 - BODY_TOP - 2 * 0.18) / 3
    for index, (name, lines) in enumerate(t["levels"]):
        y = BODY_TOP + index * (rail_h + 0.18)
        add_card(slide, rail_x, y, rail_w, rail_h)
        add_rect(slide, rail_x, y + 0.14, 0.06, rail_h - 0.28,
                 [PURPLE, BLUE, GREEN][index])
        add_text(slide, name, rail_x + 0.26, y + 0.12, rail_w - 0.5, 0.28, 12,
                 NAVY, True)
        add_body(slide, lines, rail_x + 0.26, y + 0.46, rail_w - 0.5,
                 rail_h - 0.58, 9, spacing=1.26, space_after=2.5)

    note_y = done_y + 0.8 + 0.2
    add_note(slide, t["note"], M, note_y, CW, BODY_BOTTOM - note_y, AMBER, 10)


def slide_tool_pipeline(prs, blank, c):
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 16, c["brand"], c["tags"]["s2_page"])
    t = c["tool_pipeline"]
    add_page_title(slide, t["eyebrow"], t["title"], t["subtitle"], AMBER)

    # Each gate is drawn shorter than the last, so the funnel is the message.
    gap = 0.2
    count = len(t["flow"])
    bw = (CW - (count - 1) * gap) / count
    tall, short = 1.62, 0.92
    axis = BODY_TOP + 0.12 + tall / 2
    colors = [BLUE, CYAN, GREEN, AMBER, ROSE, PURPLE]
    for index, (title, caption) in enumerate(t["flow"]):
        x = M + index * (bw + gap)
        h = tall - (tall - short) * index / (count - 1)
        y = axis - h / 2
        add_card(slide, x, y, bw, h)
        add_rect(slide, x, y, bw, 0.06, colors[index])
        add_text(slide, f"{index + 1:02d}", x + 0.12, y + 0.18, bw - 0.24, 0.2,
                 8.5, colors[index], True, PP_ALIGN.CENTER)
        add_text(slide, title, x + 0.12, y + 0.38, bw - 0.24, h - 0.5, 12,
                 NAVY, True, PP_ALIGN.CENTER)
        add_text(slide, caption, x + 0.12, axis + tall / 2 + 0.18, bw - 0.24,
                 0.86, 8.8, MUTED, align=PP_ALIGN.CENTER, spacing=1.25,
                 anchor=MSO_ANCHOR.TOP)
        if index:
            add_line(slide, (x - gap + 0.02, axis), (x - 0.03, axis), FAINT,
                     1.25)

    card_y = axis + tall / 2 + 1.22
    card_h = BODY_BOTTOM - card_y
    cgap = 0.28
    cw = (CW - 2 * cgap) / 3
    for index, (title, lines) in enumerate(t["cards"]):
        x = M + index * (cw + cgap)
        add_card(slide, x, card_y, cw, card_h)
        add_rect(slide, x, card_y + 0.16, 0.06, card_h - 0.32,
                 [BLUE, GREEN, ROSE][index])
        add_text(slide, title, x + 0.28, card_y + 0.14, cw - 0.52, 0.28, 11.5,
                 NAVY, True)
        add_body(slide, lines, x + 0.28, card_y + 0.48, cw - 0.52,
                 card_h - 0.62, 9, spacing=1.26, space_after=3)


def slide_execution(prs, blank, c):
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 17, c["brand"], c["tags"]["s2_page"])
    t = c["execution"]
    add_page_title(slide, t["eyebrow"], t["title"], t["subtitle"], ROSE)

    zone_w = 4.55
    zone_y = BODY_TOP + 0.08
    zone_h = 2.34
    right_x = M + CW - zone_w
    add_zone(slide, t["control_title"], M, zone_y, zone_w, zone_h, BLUE)
    add_zone(slide, t["exec_title"], right_x, zone_y, zone_w, zone_h, GREEN)

    chip_w = (zone_w - 0.76) / 2
    for zone_x, items in ((M, t["control"]), (right_x, t["exec"])):
        for index, (name, caption) in enumerate(items):
            x = zone_x + 0.28 + (index % 2) * (chip_w + 0.2)
            y = zone_y + 0.56 + (index // 2) * 0.8
            add_card(slide, x, y, chip_w, 0.64, WHITE, LINE, shadow=False)
            add_text(slide, name, x + 0.1, y + 0.06, chip_w - 0.2, 0.24, 9.8,
                     NAVY, True, PP_ALIGN.CENTER)
            add_text(slide, caption, x + 0.08, y + 0.3, chip_w - 0.16, 0.28,
                     8.2, MUTED, align=PP_ALIGN.CENTER, spacing=1.2,
                     anchor=MSO_ANCHOR.TOP)

    # The dashed line is the process boundary; both arrows cross it.
    mid_x = M + zone_w
    mid_w = right_x - mid_x
    center = mid_x + mid_w / 2
    add_line(slide, (center, zone_y - 0.2), (center, zone_y + zone_h + 0.18),
             FAINT, 1.25, arrow=False, dashed=True)
    add_edge_label(slide, t["rpc_title"], center, zone_y + 0.28, 1.0, 11.5,
                   ROSE)

    out_y = zone_y + 1.06
    back_y = zone_y + 1.76
    add_text(slide, t["rpc_out"], mid_x, out_y - 0.32, mid_w, 0.26, 8.8, BLUE,
             True, PP_ALIGN.CENTER)
    add_line(slide, (mid_x + 0.14, out_y), (right_x - 0.14, out_y), BLUE, 1.5)
    add_line(slide, (right_x - 0.14, back_y), (mid_x + 0.14, back_y), GREEN,
             1.5)
    add_text(slide, t["rpc_back"], mid_x, back_y + 0.08, mid_w, 0.26, 8.8,
             GREEN, True, PP_ALIGN.CENTER)
    add_edge_label(slide, t["boundary"], center, zone_y + zone_h + 0.06, 2.3,
                   8.5, FAINT)

    lower_y = zone_y + zone_h + 0.26
    add_code(slide, [
        "{",
        "  environmentId: 'local' | 'ssh:<host>',",
        "  cwd: '/path/inside/that/environment'",
        "}",
    ], M, lower_y, 4.32, BODY_BOTTOM - lower_y, t["code_title"], CYAN)

    add_rows(slide, t["rows"], M + 4.6, lower_y, CW - 4.6, ROSE,
             col1=t["rows_col1"], row_h=(BODY_BOTTOM - lower_y) / 4, size=10)


def slide_protocol(prs, blank, c):
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 18, c["brand"], c["tags"]["s2_page"])
    t = c["protocol"]
    add_page_title(slide, t["eyebrow"], t["title"], t["subtitle"], CYAN)

    left_w = 5.3
    card_h = 2.82
    add_card(slide, M, BODY_TOP, left_w, card_h)
    add_text(slide, t["transports_title"], M + 0.32, BODY_TOP + 0.26,
             left_w - 0.64, 0.3, 13, NAVY, True)
    name_w = t["name_w"]
    for index, (name, caption) in enumerate(t["transports"]):
        color = [BLUE, GREEN, PURPLE][index]
        y = BODY_TOP + 0.74 + index * 0.66
        add_rect(slide, M + 0.32, y + 0.08, 0.06, 0.5, color)
        add_text(slide, name, M + 0.52, y, name_w, 0.66, 11.5, NAVY, True)
        add_text(slide, caption, M + 0.56 + name_w, y,
                 left_w - name_w - 0.98, 0.66, 9.8, MUTED)
    add_note(slide, t["wire_note"], M, BODY_TOP + card_h + 0.22, left_w,
             BODY_BOTTOM - BODY_TOP - card_h - 0.22, CYAN, 10)

    right_x = M + left_w + 0.34
    right_w = CW - left_w - 0.34
    add_text(slide, t["ids_title"], right_x, BODY_TOP - 0.02, right_w, 0.3, 13,
             NAVY, True)
    add_rows(slide, t["ids"], right_x, BODY_TOP + 0.36, right_w, CYAN,
             col1=t["ids_col1"], row_h=0.5, size=11)
    add_note(slide, t["notes"][0], right_x, BODY_TOP + 2.96, right_w, 0.7, ROSE,
             10.5)
    add_note(slide, t["notes"][1], right_x, BODY_TOP + 3.8, right_w, 0.72,
             AMBER, 10.5)


def slide_acp_impl(prs, blank, c):
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 19, c["brand"], c["tags"]["s2_page"])
    t = c["acp_impl"]
    add_page_title(slide, t["eyebrow"], t["title"], t["subtitle"], PURPLE)

    left_w = 5.5
    add_text(slide, t["comp_title"], M, BODY_TOP - 0.02, left_w, 0.3, 13, NAVY,
             True)
    add_rows(slide, t["comps"], M, BODY_TOP + 0.36, left_w, PURPLE,
             col1=t["comp_col1"], row_h=0.46, size=10.5)
    add_note(slide, t["comp_note"], M, BODY_TOP + 3.72, left_w,
             BODY_BOTTOM - BODY_TOP - 3.72, PURPLE, 10)

    right_x = M + left_w + 0.34
    right_w = CW - left_w - 0.34
    add_text(slide, t["map_title"], right_x, BODY_TOP - 0.02, right_w, 0.3, 13,
             NAVY, True)
    add_rows(slide, t["maps"], right_x, BODY_TOP + 0.36, right_w, CYAN,
             col1=t["map_col1"], row_h=0.46, size=10.5)


def slide_memory_impl(prs, blank, c):
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 20, c["brand"], c["tags"]["s2_page"])
    t = c["memory_impl"]
    add_page_title(slide, t["eyebrow"], t["title"], t["subtitle"], AMBER)

    add_text(slide, t["recall_title"], M, BODY_TOP - 0.04, CW, 0.28, 12.5,
             NAVY, True)

    # Recall as a branch-and-merge flow: the lanes never mix.
    axis = 3.78
    start_w, fast_w, dia_w, lane_w, out_w = 1.35, 2.35, 2.05, 2.5, 2.25
    start_x = M
    fast_x = start_x + start_w + 0.26
    dia_x = fast_x + fast_w + 0.3
    riser = dia_x + dia_w + 0.26
    lane_x = riser + 0.26
    out_x = lane_x + lane_w + 0.3
    yes_y, no_y = axis - 1.0, axis + 0.08

    add_node(slide, t["start"], None, start_x, axis - 0.3, start_w, 0.6, CYAN,
             10.5)
    add_node(slide, t["fast"][0], t["fast"][1], fast_x, axis - 0.46, fast_w,
             0.92, BLUE, 12, 8.8, shadow=True)
    add_diamond(slide, t["decision"], dia_x, axis - 0.55, dia_w, 1.1, AMBER,
                9.5)
    add_line(slide, (start_x + start_w, axis), (fast_x - 0.04, axis))
    add_line(slide, (fast_x + fast_w, axis), (dia_x - 0.04, axis))

    for lane_y, (title, caption), color, label in (
            (yes_y, t["lanes"][0], GREEN, t["yes"]),
            (no_y, t["lanes"][1], PURPLE, t["no"])):
        add_node(slide, title, caption, lane_x, lane_y, lane_w, 0.92, color,
                 11.5, 8.8, shadow=True)
        add_path(slide, [(dia_x + dia_w, axis), (riser, axis),
                         (riser, lane_y + 0.46), (lane_x - 0.04, lane_y + 0.46)],
                 color, 1.4)
        add_path(slide, [(lane_x + lane_w, lane_y + 0.46),
                         (out_x - 0.26, lane_y + 0.46), (out_x - 0.26, axis),
                         (out_x - 0.04, axis)], FAINT, 1.25)
        add_edge_label(slide, label, riser, (axis + lane_y + 0.46) / 2, 0.44,
                       8.5, color)

    add_node(slide, t["out"][0], t["out"][1], out_x, axis - 0.46, out_w, 0.92,
             ROSE, 11.5, 8.8, shadow=True)

    chip_y = 4.94
    chip_w = (CW - 2 * 0.2) / 3
    for index, label in enumerate(t["recall_notes"]):
        add_chip(slide, label, M + index * (chip_w + 0.2), chip_y, chip_w, 0.42,
                 AMBER, 9)

    add_text(slide, t["compact_title"], M, 5.42, CW, 0.28, 12.5, NAVY, True)
    card_y = 5.72
    card_h = BODY_BOTTOM - card_y
    cw = (CW - 2 * 0.3) / 3
    for index, (name, segments, caption) in enumerate(t["compaction"]):
        x = M + index * (cw + 0.3)
        add_card(slide, x, card_y, cw, card_h)
        add_text(slide, name, x + 0.26, card_y + 0.1, cw - 0.52, 0.24, 10.5,
                 NAVY, True)
        add_segments(slide, segments, x + 0.26, card_y + 0.38, cw - 0.52, 0.26,
                     [CYAN, BLUE, PURPLE][index])
        add_text(slide, caption, x + 0.26, card_y + 0.7, cw - 0.52, 0.24, 8.8,
                 MUTED)


def slide_failure(prs, blank, c):
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 21, c["brand"], c["tags"]["s2_page"])
    t = c["failure"]
    add_page_title(slide, t["eyebrow"], t["title"], t["subtitle"], ROSE)
    add_rows(slide, t["rows"], M, BODY_TOP + 0.06, CW, ROSE,
             col1=t["rows_col1"], row_h=0.5, size=11.5)


def slide_closing(prs, blank, c):
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 22, c["brand"], c["tags"]["closing"])
    t = c["closing"]
    add_text(slide, t["eyebrow"], M, 1.32, CW, 0.3, 11, CYAN, True,
             PP_ALIGN.CENTER)
    add_rect(slide, W / 2 - 0.26, 1.66, 0.52, 0.05, CYAN)
    add_text(slide, t["title"], M, 1.94, CW, 0.62, 32, NAVY, True,
             PP_ALIGN.CENTER)

    gap = 0.3
    cw = (CW - 2 * gap) / 3
    for index, (number, title, text) in enumerate(t["cards"]):
        color = [BLUE, PURPLE, GREEN][index]
        x = M + index * (cw + gap)
        y = 2.86
        add_card(slide, x, y, cw, 1.62)
        add_rect(slide, x, y + 0.26, 0.08, 1.1, color)
        add_text(slide, number, x + 0.42, y + 0.26, 0.6, 0.28, 11, color, True)
        add_text(slide, title, x + 0.42, y + 0.6, cw - 0.8, 0.34, 17, NAVY, True)
        add_text(slide, text, x + 0.42, y + 1.0, cw - 0.8, 0.52, 10, MUTED,
                 spacing=1.3, anchor=MSO_ANCHOR.TOP)

    demo_y = 4.78
    add_text(slide, t["demo_title"], M, demo_y, CW, 0.3, 11, MUTED, True,
             PP_ALIGN.CENTER)
    dw = (CW - 2 * 0.3) / 3
    for index, label in enumerate(t["demos"]):
        x = M + index * (dw + 0.3)
        add_shape(slide, MSO_SHAPE.ROUNDED_RECTANGLE, x, demo_y + 0.38, dw, 0.52,
                  SURFACE, LINE)
        add_text(slide, f"DEMO 0{index + 1}   {label}", x, demo_y + 0.38, dw,
                 0.52, 10.5, NAVY, True, PP_ALIGN.CENTER)

    add_rect(slide, M, 6.18, CW, 0.012, LINE)
    add_text(slide, t["footer"], M, 6.4, CW, 0.34, 11, MUTED,
             align=PP_ALIGN.CENTER)


BUILDERS = [
    slide_cover,
    slide_agenda,
    slide_section_one,
    slide_capability_map,
    slide_coding,
    slide_browser,
    slide_extensions,
    slide_memory_feature,
    slide_interfaces,
    slide_acp_feature,
    slide_engineering,
    slide_section_two,
    slide_overview,
    slide_end_to_end,
    slide_agent_loop,
    slide_tool_pipeline,
    slide_execution,
    slide_protocol,
    slide_acp_impl,
    slide_memory_impl,
    slide_failure,
    slide_closing,
]


def build_deck(lang):
    content = CONTENT[lang]
    prs = Presentation()
    prs.slide_width = Inches(W)
    prs.slide_height = Inches(H)
    blank = prs.slide_layouts[6]

    for builder in BUILDERS:
        builder(prs, blank, content)

    add_powerpoint_sections(prs, content["sections"])

    output = OUTPUTS[lang]
    output.parent.mkdir(parents=True, exist_ok=True)
    prs.save(output)
    return output


if __name__ == "__main__":
    for language in OUTPUTS:
        print(build_deck(language))
