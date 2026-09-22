"""Export the generated decks to PNGs so the layout can be reviewed as images.

Also prints the PowerPoint sections it finds, which is the quickest check that
the section metadata written by the generator is valid.

Requires PowerPoint on Windows (uses COM automation via pywin32).
"""

import sys
from pathlib import Path

import win32com.client

ROOT = Path(__file__).resolve().parents[1]
DECKS = {
    "zh": ROOT / "presentation" / "Coding_Agent_Overview_And_Architecture.pptx",
    "en": ROOT / "presentation" / "Coding_Agent_Overview_And_Architecture_EN.pptx",
}


def export(lang, deck, width=1600, height=900):
    out = ROOT / "presentation" / f"_preview_{lang}"
    out.mkdir(parents=True, exist_ok=True)
    app = win32com.client.dynamic.Dispatch("PowerPoint.Application")
    pres = app.Presentations.Open(str(deck), ReadOnly=True, WithWindow=False)
    try:
        for index, slide in enumerate(pres.Slides, start=1):
            slide.Export(str(out / f"slide{index:02d}.png"), "PNG", width,
                         height)
        props = pres.SectionProperties
        sections = [(props.Name(i), props.SlidesCount(i))
                    for i in range(1, props.Count + 1)]
        count = pres.Slides.Count
    finally:
        pres.Close()
        app.Quit()
    return count, sections, out


if __name__ == "__main__":
    wanted = sys.argv[1:] or list(DECKS)
    for language in wanted:
        slides, sections, folder = export(language, DECKS[language])
        print(f"[{language}] {slides} slides -> {folder}")
        for name, size in sections:
            print(f"    section {name!r}: {size} slides")
