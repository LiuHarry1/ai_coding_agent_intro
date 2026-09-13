# Architecture Presentation

A Reveal.js deck introducing Coding Agent architecture and Browser Automation.

## Structure

```
docs/presentation/
  index.html          <- generated deck
  build.mjs           <- merges slides into index.html
  css/theme.css       <- shared styles
  assets/             <- SVG architecture diagrams
  slides/             <- one source file per slide
    01-architecture.html
    02-agent-loop.html
    …
    09-browser-arch.html
    10-browser-demo.html
    99-end.html
```

## Workflow

Edit `slides/*.html` or `assets/*.svg`, then rebuild:

```bash
npm run presentation:build
# or
node docs/presentation/build.mjs
```

Open `docs/presentation/index.html` in a browser. The generated deck works
from `file://` and does not require a local server.

For a local development server:

```bash
npm run presentation
# → http://localhost:3456
```

## Source policy

Slides are a concise presentation derived from the canonical Markdown
documentation. Keep implementation detail in the documentation site and use
slides for the talk track.

| File | Purpose |
|---|---|
| `slides/NN-*.html` | One independently editable slide |
| `assets/*.svg` | Architecture and flow diagrams |
| `css/theme.css` | Presentation styling |
| `build.mjs` | Merge sources into one `index.html` |

The merged file remains playable offline while the sources stay modular.

## Add a slide

1. Add `slides/11-topic.html` containing one `<section>`.
2. Run `npm run presentation:build`.
3. Refresh the browser.

Numeric prefixes control ordering; `99-end.html` stays last.
