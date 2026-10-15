from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.util import Inches, Pt

NAVY = RGBColor(0x0B, 0x1F, 0x3A)
ACCENT = RGBColor(0x1E, 0x88, 0xE5)
TEXT = RGBColor(0x33, 0x33, 0x33)
MUTED = RGBColor(0x88, 0x88, 0x88)
LIGHT = RGBColor(0xF3, 0xF6, 0xFA)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)
BLANK = prs.slide_layouts[6]


def add_text(slide, left, top, width, height, text, size, color=TEXT, bold=False, align=PP_ALIGN.LEFT):
    box = slide.shapes.add_textbox(left, top, width, height)
    tf = box.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.alignment = align
    run = p.add_run()
    run.text = text
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color
    run.font.name = "Segoe UI"
    return box


def add_rect(slide, left, top, width, height, fill, shape=MSO_SHAPE.RECTANGLE):
    rect = slide.shapes.add_shape(shape, left, top, width, height)
    rect.fill.solid()
    rect.fill.fore_color.rgb = fill
    rect.line.fill.background()
    return rect


def title_slide():
    s = prs.slides.add_slide(BLANK)
    add_rect(s, 0, 0, prs.slide_width, prs.slide_height, NAVY)
    add_rect(s, Inches(0.8), Inches(3.55), Inches(1.2), Inches(0.08), ACCENT)
    add_text(s, Inches(0.8), Inches(2.2), Inches(11), Inches(1.3), "Baix Series Products", 54, WHITE, bold=True)
    add_text(s, Inches(0.8), Inches(3.9), Inches(11), Inches(0.8),
             "Enterprise AI products for knowledge, productivity and automation", 22, RGBColor(0xC8, 0xD3, 0xE0))


def add_bullets(slide, top, height, items, size=13):
    box = slide.shapes.add_textbox(Inches(0.6), top, Inches(6.4), height)
    tf = box.text_frame
    tf.word_wrap = True
    for i, (head, desc) in enumerate(items):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.space_after = Pt(7)
        bullet = p.add_run()
        bullet.text = "\u25A0  "
        bullet.font.size = Pt(10)
        bullet.font.color.rgb = ACCENT
        h = p.add_run()
        h.text = f"{head}: "
        h.font.bold = True
        h.font.size = Pt(size)
        h.font.color.rgb = NAVY
        h.font.name = "Segoe UI"
        d = p.add_run()
        d.text = desc
        d.font.size = Pt(size)
        d.font.color.rgb = TEXT
        d.font.name = "Segoe UI"


def product_slide(index, name, intro, features, use_cases=None, headings=("Key Features", "Use Cases")):
    s = prs.slides.add_slide(BLANK)
    add_rect(s, 0, 0, prs.slide_width, Inches(0.12), ACCENT)

    add_text(s, Inches(0.6), Inches(0.35), Inches(6), Inches(0.4), f"PRODUCT {index:02d}", 14, ACCENT, bold=True)
    add_text(s, Inches(0.6), Inches(0.7), Inches(6.4), Inches(0.8), name, 36, NAVY, bold=True)

    add_text(s, Inches(0.6), Inches(1.55), Inches(6.4), Inches(1.1), intro, 15, TEXT)

    add_text(s, Inches(0.6), Inches(2.75), Inches(6.4), Inches(0.45), headings[0], 20, NAVY, bold=True)

    if use_cases:
        add_bullets(s, Inches(3.2), Inches(2.0), features, size=12)
        add_text(s, Inches(0.6), Inches(5.2), Inches(6.4), Inches(0.45), headings[1], 20, NAVY, bold=True)
        add_bullets(s, Inches(5.65), Inches(1.6), use_cases, size=12)
    else:
        add_bullets(s, Inches(3.25), Inches(3.9), features)

    # Image placeholder on the right half
    ph = add_rect(s, Inches(7.4), Inches(0.7), Inches(5.4), Inches(6.2), LIGHT, MSO_SHAPE.ROUNDED_RECTANGLE)
    ph.adjustments[0] = 0.04
    ph.line.color.rgb = RGBColor(0xC5, 0xCF, 0xDB)
    ph.line.dash_style = 4
    ph.name = "Image Placeholder"
    tf = ph.text_frame
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    r = p.add_run()
    r.text = "Image placeholder"
    r.font.size = Pt(16)
    r.font.color.rgb = MUTED


title_slide()

product_slide(
    1,
    "Baix ChatBot",
    "Baix ChatBot is one AI chat interface for company knowledge: it searches documents, Jira, "
    "Confluence, code and databases, and gives answers with sources you can check.",
    [
        ("Build Knowledge Bases & Graphs", "Turn documents into a searchable vector index and a knowledge graph"),
        ("Custom Assistants", "Each assistant has its own knowledge, prompt, tools and team access"),
        ("Answers with Citations", "Every answer links back to its source documents"),
        ("Enterprise Integrations", "Jira, Confluence, Bitbucket, Web, SQL databases and MCP plugins"),
        ("Files & Code", "Upload files, run Python, generate reports and charts"),
        ("Evaluation & Analytics", "User feedback, a usage dashboard and monthly reports"),
    ],
)

product_slide(
    2,
    "Cloud Coding Agent",
    "Cloud Coding Agent is an AI coding assistant that reads and edits code and runs commands, "
    "available on the web and inside your IDE.",
    [
        ("Coding Assistance", "Edit code, run commands and search the codebase with parallel subagents"),
        ("Multiple Interfaces", "Web UI, VS Code / Cursor / IntelliJ, API and SDK"),
        ("Extensibility", "Skills, plugins, MCP tools, custom agents and session memory"),
    ],
    use_cases=[
        ("Team-Level Coding Agent", "One person sets up the team's MCP servers, skills and agents; "
         "everyone else gets them out of the box"),
        ("Company Skill Marketplaces", "Easily connect to our company skill marketplaces and reuse shared skills"),
    ],
)

product_slide(
    3,
    "Baix Agent App",
    "Baix Agent App is the desktop edition of our agent, built on the same codebase as Cloud Coding "
    "Agent. It comes with two ready-to-use agents that work on your own computer.",
    [
        ("Expense Claims", "Fill in and submit expense reports in Concur automatically"),
        ("Any Web Task", "Navigate pages, click, fill forms, collect data and take screenshots"),
        ("Your Own Chrome", "Reuses your signed-in sessions, so it works on intranet sites too"),
    ],
    use_cases=[
        ("Files & Folders", "Find, organize, rename and clean up local files in bulk"),
        ("Office Documents", "Read, summarize and convert Excel, Word, PDF; generate reports"),
        ("System Tasks", "Run scripts, set up tools and check system settings"),
    ],
    headings=("Browser Automation Agent", "Desktop Assistant Agent"),
)

prs.save("Baix_Series_Products.pptx")
print("saved")
