---
name: echarts-chart
description: >-
  Deterministically turn structured data into an offline ECharts HTML page,
  cleaned data, a chart spec, and an optional PNG.
  Trigger phrases: draw a chart, generate a chart, ECharts, bar chart, line chart,
  pie chart, trend chart, chart from data, visualize data,
  画图表, 生成图表, 柱状图, 折线图, 饼图, 趋势图.
argument-hint: "<title + data description or CSV/table>"
user-invocable: true
---

# ECharts Chart — reproducible data charts

Normalize analysis data, then hand it to the script to produce an offline
single-file HTML page, a spec, cleaned data JSON, and a PNG when needed.
Draw conclusions from the data JSON; use the image only for visual QA.

## When to use

- The user wants to visualize data or build an analysis chart
- The data already exists or can be shaped into a table (title + goal + data + fields)
- Provenance matters: source, unit, time range, or YTD markers
- They need interactive HTML, or a static PNG for a report/deck

Do not use when:

- The user only wants a written analysis, with no chart
- They want to change a React component in the codebase instead of generating HTML artifacts

## Trigger Rules

At minimum you need:

- `title`
- `goal` (see [references/input-model.md](references/input-model.md))
- `data` (array of objects)
- `fields.x` and `fields.y`

## Required Calling Discipline

- Write structured JSON only; no arbitrary JavaScript, formatter functions, HTML, or external scripts
- Do not copy or edit `const D` in the template by hand — always call
  [`scripts/generate-chart.mjs`](scripts/generate-chart.mjs)
- Default output directory is the workspace `charts/` folder
- Conclusions must come from the generated `.data.json`; do not guess values via OCR
- Pass `--png` only for visual QA, reports/decks, or when the user explicitly asks

## Preflight Checklist

Before generating, confirm:

- [ ] `data` is a non-empty array
- [ ] `fields.x` exists on every record
- [ ] every field in `fields.y` exists on every record
- [ ] `goal` is a valid enum value
- [ ] `chartType` (if set) is on the whitelist
- [ ] `source`, `unit`, and `timeRange` are filled in when the data supports it
- [ ] null-handling is explicit; YTD / current periods are marked with `incompletePeriod`
- [ ] for percentages/ratios, numerator, denominator, and definition are confirmed

If fields are unclear, clean up the data first — do not invent column names.

## Standard Workflows

### Workflow A — new chart

1. Write the user input to a temporary JSON file (full model in
   [references/input-model.md](references/input-model.md)).
2. Run:
   `node .ai-agent/skills/echarts-chart/scripts/generate-chart.mjs --input <input.json> --output-dir charts`
3. Read the generated `<slug>.spec.json` and `<slug>.data.json`; check record count,
   units, time range, nulls, and sort order.
4. For visual QA, re-run with `--png` and Read the PNG once. If the environment has
   no Chrome, keep the HTML and say clearly that no PNG was produced.
5. Return all artifacts plus a preview link. The frontend opens the preview with the
   current session so access stays authenticated.

### Workflow B — small edits (patch)

When the user changes the title, type, theme, size, field mapping, or analysis metadata:

- Edit the original input JSON and re-run the generator
- Do not patch the generated HTML (that drifts spec / data / HTML apart)
- If a title change produces a new slug, list the new paths explicitly

### Workflow C — bad data

- Incompatible mappings, missing fields, NaN/Infinity, illegal nulls, or an unreasonable
  number of pie categories: let the generator surface a concrete validation error
- Use `chartType: "table"` only when the data truly does not belong in a chart

## goal → defaultType

| goal | defaultType |
|------|-------------|
| trend | line |
| compare | bar |
| composition | donut |
| distribution | histogram |
| ranking | bar |
| correlation | scatter |

## Delivery format (search2chart-mcp standard)

The final reply lists the artifacts that were actually produced; do not embed base64:

```markdown
Chart ready.

- Interactive chart: `{absoluteHtmlPath}`
- Cleaned data: `{absoluteDataPath}`
- Chart spec: `{absoluteSpecPath}`
- Preview: [Open interactive chart]({previewBaseUrl}/workspace/preview?path={encodedAbsoluteHtmlPath})
- PNG: `{absolutePngPath}` (list only when actually generated)
```

Add 2–4 insights from `.data.json`, and call out source, units, and any incomplete periods.

## References

- [input-model.md](references/input-model.md) — fields and `const D` shape
- [chart-template.html](references/chart-template.html) — search2chart-style HTML template
- [examples.md](references/examples.md) — few-shot examples
- `references/echarts.min.js` — pinned offline ECharts runtime

## Quality rules

- Trends → line/area; category comparisons → bar; rankings → horizontal bar
- For composition with more than 6 categories, use Top-N + Other, or switch to bar
- Stacked bar series must share a unit; no meaningless dual axes or 3D
- Prefer labels that keep units and enough precision; avoid decoration that hides data
- Default PNG is 1600×1000; the Read path compresses it into a separate token budget
