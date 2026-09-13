from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.util import Inches, Pt


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "presentation" / "BaiX_Enterprise_Agent_Platform.pptx"

# Helvetica Neue ships with macOS and degrades to a clean sans on Windows;
# Aptos/Inter are not guaranteed and fall back to a serif face.
FONT = "Helvetica Neue"

NAVY = RGBColor(15, 36, 69)
WHITE = RGBColor(255, 255, 255)
CANVAS = RGBColor(246, 248, 252)
SURFACE = RGBColor(236, 241, 250)
SHADOW = RGBColor(226, 232, 243)
LINE = RGBColor(216, 224, 238)
MUTED = RGBColor(95, 112, 140)
BLUE = RGBColor(39, 87, 232)
CYAN = RGBColor(18, 181, 196)
PURPLE = RGBColor(122, 87, 222)
GREEN = RGBColor(23, 166, 115)

# Single content grid shared by every slide.
MARGIN_L = 0.72
CONTENT_TOP = 1.5
CONTENT_BOTTOM = 6.42
COL_L_W = 4.35
COL_R_X = 5.56
COL_R_W = 7.06


def add_text(slide, text, x, y, w, h, size=20, color=NAVY, bold=False,
             align=PP_ALIGN.LEFT, spacing=1.0):
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    frame = box.text_frame
    frame.clear()
    frame.word_wrap = True
    frame.margin_left = frame.margin_right = 0
    frame.margin_top = frame.margin_bottom = 0
    frame.vertical_anchor = MSO_ANCHOR.MIDDLE
    for index, line in enumerate(text.split("\n")):
        paragraph = frame.paragraphs[0] if index == 0 else frame.add_paragraph()
        paragraph.alignment = align
        paragraph.line_spacing = spacing
        run = paragraph.add_run()
        run.text = line
        run.font.name = FONT
        run.font.size = Pt(size)
        run.font.bold = bold
        run.font.color.rgb = color
    return box


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


def add_card(slide, x, y, w, h, fill=WHITE, line=LINE):
    add_shape(slide, MSO_SHAPE.ROUNDED_RECTANGLE, x + 0.05, y + 0.07, w, h,
              SHADOW)
    return add_shape(slide, MSO_SHAPE.ROUNDED_RECTANGLE, x, y, w, h, fill, line)


def add_dot(slide, label, x, y, diameter, fill, size=12):
    add_shape(slide, MSO_SHAPE.OVAL, x, y, diameter, diameter, fill)
    add_text(slide, label, x, y, diameter, diameter, size, WHITE, True,
             PP_ALIGN.CENTER)


def add_chrome(slide, number):
    slide.background.fill.solid()
    slide.background.fill.fore_color.rgb = CANVAS
    add_dot(slide, "X", MARGIN_L, 0.42, 0.4, BLUE, 13)
    add_text(slide, "BAIX", MARGIN_L + 0.52, 0.44, 1.4, 0.36, 12, NAVY, True)
    add_text(slide, f"{number:02d}", 11.9, 0.44, 0.72, 0.36, 11, MUTED,
             align=PP_ALIGN.RIGHT)
    add_rect(slide, MARGIN_L, 6.95, 12.18 - MARGIN_L + 0.72, 0.015, LINE)


def add_headline(slide, x, eyebrow, accent, headline, subtitle):
    add_text(slide, eyebrow.upper(), x, CONTENT_TOP, COL_L_W, 0.3, 11, accent,
             True)
    add_rect(slide, x, CONTENT_TOP + 0.42, 0.52, 0.05, accent)
    add_text(slide, headline, x, CONTENT_TOP + 0.68, COL_L_W, 1.32, 29, NAVY,
             True, spacing=1.12)
    add_text(slide, subtitle, x, CONTENT_TOP + 2.12, COL_L_W, 0.7, 15, MUTED,
             spacing=1.25)


def add_feature_rows(slide, x, rows, top=4.68, gap=0.46):
    """One shared list language across slides: accent bar + label + caption."""
    add_rect(slide, x, top - 0.26, COL_L_W, 0.012, LINE)
    for index, (label, caption, color) in enumerate(rows):
        y = top + index * gap
        add_rect(slide, x, y + 0.04, 0.07, 0.3, color)
        add_text(slide, label, x + 0.28, y, 1.85, 0.38, 12, NAVY, True)
        add_text(slide, caption, x + 2.12, y, COL_L_W - 2.12, 0.38, 11, MUTED)


def add_visual_frame(slide, x, label, hint, accent):
    h = CONTENT_BOTTOM - CONTENT_TOP
    add_card(slide, x, CONTENT_TOP, COL_R_W, h, SURFACE, LINE)
    add_dot(slide, "+", x + COL_R_W / 2 - 0.26, CONTENT_TOP + h / 2 - 0.68,
            0.52, accent, 18)
    add_text(slide, label, x + 0.5, CONTENT_TOP + h / 2 - 0.05, COL_R_W - 1.0,
             0.34, 13, NAVY, True, PP_ALIGN.CENTER)
    add_text(slide, hint, x + 0.5, CONTENT_TOP + h / 2 + 0.34, COL_R_W - 1.0,
             0.3, 10, MUTED, align=PP_ALIGN.CENTER)


def build_deck():
    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    blank = prs.slide_layouts[6]

    # ── Slide 1 — cover ────────────────────────────────────────────────
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 1)
    add_text(slide, "ENTERPRISE AGENT PLATFORM", MARGIN_L, CONTENT_TOP,
             COL_L_W + 1.2, 0.3, 11, CYAN, True)
    add_rect(slide, MARGIN_L, CONTENT_TOP + 0.42, 0.52, 0.05, CYAN)
    add_text(slide, "AI that works\nfor your business.", MARGIN_L,
             CONTENT_TOP + 0.72, COL_L_W + 0.9, 1.6, 36, NAVY, True,
             spacing=1.1)
    add_text(slide, "Cloud. Desktop. Fully customized.", MARGIN_L,
             CONTENT_TOP + 2.5, COL_L_W + 0.9, 0.4, 16, MUTED)
    add_shape(slide, MSO_SHAPE.ROUNDED_RECTANGLE, MARGIN_L, CONTENT_TOP + 3.18,
              2.5, 0.52, BLUE)
    add_text(slide, "OWN YOUR AI", MARGIN_L, CONTENT_TOP + 3.18, 2.5, 0.52, 11,
             WHITE, True, PP_ALIGN.CENTER)
    add_rect(slide, MARGIN_L, CONTENT_BOTTOM - 0.62, COL_L_W + 0.9, 0.012, LINE)
    add_text(slide, "Private deployment  ·  Your models  ·  Your data",
             MARGIN_L, CONTENT_BOTTOM - 0.42, COL_L_W + 0.9, 0.34, 11, MUTED)

    card_h = 1.42
    gap = (CONTENT_BOTTOM - CONTENT_TOP - 3 * card_h) / 2
    for index, (label, caption, color) in enumerate([
        ("Cloud Agent", "AI for every employee", BLUE),
        ("Desktop Agent", "Your personal assistant", PURPLE),
        ("Custom Agent", "Built for your domain", GREEN),
    ]):
        y = CONTENT_TOP + index * (card_h + gap)
        add_card(slide, COL_R_X, y, COL_R_W, card_h)
        add_rect(slide, COL_R_X, y + 0.24, 0.08, card_h - 0.48, color)
        add_text(slide, f"0{index + 1}", COL_R_X + 0.42, y + 0.3, 0.6, 0.3, 11,
                 color, True)
        add_text(slide, label, COL_R_X + 0.42, y + 0.62, 3.6, 0.4, 19, NAVY,
                 True)
        add_text(slide, caption, COL_R_X + 0.42, y + 1.02, 4.4, 0.3, 12, MUTED)

    # ── Slide 2 — cloud agent ──────────────────────────────────────────
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 2)
    add_headline(slide, MARGIN_L, "Cloud Agent", BLUE,
                 "Enterprise AI\nfor everyone.",
                 "No IDE. No GitHub.\nJust natural language.")
    add_feature_rows(slide, MARGIN_L, [
        ("Jira", "Query · Analyze · Update", BLUE),
        ("WeShare", "Search · Summarize", PURPLE),
        ("Workflows", "Automate · Schedule", GREEN),
    ], gap=0.56)
    add_visual_frame(slide, COL_R_X, "CLOUD WORKFLOW IMAGE",
                     "Business user  ·  BaiX Cloud  ·  Jira / WeShare / apps",
                     BLUE)

    # ── Slide 3 — desktop agent ────────────────────────────────────────
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 3)
    add_headline(slide, MARGIN_L, "Desktop Agent", PURPLE,
                 "Your personal\nAI assistant.",
                 "Acts in your environment.\nLearns your preferences.")
    add_feature_rows(slide, MARGIN_L, [
        ("Browser", "Automates real websites", BLUE),
        ("Documents", "Local files & data", CYAN),
        ("Workflows", "Repeatable daily tasks", GREEN),
        ("Memory", "Learns what works", PURPLE),
    ])
    add_visual_frame(slide, COL_R_X, "DESKTOP PRODUCT IMAGE",
                     "BaiX Desktop completing a real browser task", PURPLE)

    # ── Slide 4 — custom agent ─────────────────────────────────────────
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 4)
    add_headline(slide, MARGIN_L, "Custom Agent", GREEN,
                 "Built for\nyour business.",
                 "From general AI\nto your domain expert.")
    add_feature_rows(slide, MARGIN_L, [
        ("Models", "Private & on-premise", BLUE),
        ("Skills", "Your domain knowledge", PURPLE),
        ("Tools", "Internal toolchains", CYAN),
        ("Product", "Embed into your app", GREEN),
    ])
    add_visual_frame(slide, COL_R_X, "CUSTOM AGENT CASE STUDY",
                     "Advantest TP: write · test · debug · integrate", GREEN)

    # ── Slide 5 — demo & Q&A (centered closing composition) ────────────
    slide = prs.slides.add_slide(blank)
    add_chrome(slide, 5)
    full_w = 13.333 - 2 * MARGIN_L
    add_text(slide, "LIVE SESSION", MARGIN_L, CONTENT_TOP, full_w, 0.3, 11,
             CYAN, True, PP_ALIGN.CENTER)
    add_rect(slide, 13.333 / 2 - 0.26, CONTENT_TOP + 0.44, 0.52, 0.05, CYAN)
    add_text(slide, "Demo & Questions", MARGIN_L, CONTENT_TOP + 0.72, full_w,
             0.9, 36, NAVY, True, PP_ALIGN.CENTER)
    add_text(slide, "Three short demos, then open discussion.", MARGIN_L,
             CONTENT_TOP + 1.72, full_w, 0.4, 16, MUTED, align=PP_ALIGN.CENTER)

    demo_w = (full_w - 2 * 0.32) / 3
    for index, (label, caption, color) in enumerate([
        ("Cloud Agent", "Analyze & update Jira", BLUE),
        ("Desktop Agent", "Run a real browser task", PURPLE),
        ("Custom Agent", "Debug Advantest TP", GREEN),
    ]):
        x = MARGIN_L + index * (demo_w + 0.32)
        y = CONTENT_TOP + 2.6
        add_card(slide, x, y, demo_w, 1.5)
        add_rect(slide, x, y + 0.26, 0.08, 0.98, color)
        add_text(slide, f"DEMO 0{index + 1}", x + 0.42, y + 0.28, demo_w - 0.7,
                 0.28, 10, color, True)
        add_text(slide, label, x + 0.42, y + 0.6, demo_w - 0.7, 0.36, 17, NAVY,
                 True)
        add_text(slide, caption, x + 0.42, y + 0.98, demo_w - 0.7, 0.3, 11,
                 MUTED)

    add_rect(slide, MARGIN_L, CONTENT_BOTTOM - 0.5, full_w, 0.012, LINE)
    add_text(slide, "Thank you  ·  BaiX Enterprise Agent Platform", MARGIN_L,
             CONTENT_BOTTOM - 0.3, full_w, 0.34, 11, MUTED,
             align=PP_ALIGN.CENTER)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    prs.save(OUTPUT)
    return OUTPUT


if __name__ == "__main__":
    print(build_deck())
