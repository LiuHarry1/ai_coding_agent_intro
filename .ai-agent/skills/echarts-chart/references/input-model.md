# Chart input model

`generate-chart.mjs` accepts one JSON object. The generator validates and
normalizes it before producing artifacts; do not inject JavaScript or hand-edit
the generated HTML.

## Required fields

| Field | Type | Description |
|---|---|---|
| `title` | string | Concise chart title |
| `goal` | enum | `trend`, `compare`, `composition`, `distribution`, `ranking`, or `correlation` |
| `data` | object[] | Source records; values must be strings, numbers, booleans, or null |
| `fields.x` | string | Category/time/X-value field |
| `fields.y` | string or string[] | Numeric value field(s) |

Every mapped field must exist on every record. Numeric fields accept finite
numbers or numeric strings; the normalized `data.json` contains numbers.

## Analysis metadata

| Field | Type | Default | Purpose |
|---|---|---|---|
| `source` | string or string[] | omitted | Human-readable data source(s) |
| `unit` | string or object | omitted | Shared unit or units keyed by series |
| `timeRange` | `{start,end,timezone?}` | omitted | Coverage of the analysis |
| `missingValuePolicy` | `error`, `zero`, `gap`, `drop` | `error` | Explicit null/blank handling |
| `incompletePeriod` | boolean or `{label?,note?}` | `false` | Mark YTD/current partial period |
| `sort` | `none`, `asc`, `desc`, `chronological` | goal-dependent | Stable record ordering |
| `topN` | integer 1–100 | omitted | Keep the largest N categories |
| `includeOther` | boolean | `true` | Aggregate excluded Top-N rows as `Other` |
| `annotations` | `{x,label}[]` | `[]` | Event markers on category/time axes |
| `description` | string | omitted | Short subtitle/caption |
| `theme` | `light` or `dark` | `light` | Accessible display theme |

For YTD or partial periods, `incompletePeriod` must be set rather than implying a
complete year in the title. Ratios and percentages must be calculated from
explicit numerator/denominator columns before chart generation.

## Chart selection and field rules

| chartType | Appropriate data | Additional fields/rules |
|---|---|---|
| `line`, `area` | ordered trend | chronological X; gaps stay null |
| `bar` | category comparison/ranking | ranking is horizontal and sorted descending |
| `stacked_bar` | part-to-whole over categories | at least two Y series with the same unit |
| `pie`, `donut` | composition | exactly one Y series; at most 6 slices after Top-N |
| `scatter` | correlation | numeric `fields.x`; one or more numeric Y fields |
| `histogram` | pre-binned distribution | X is bucket label; exactly one Y count field |
| `heatmap` | two-dimensional matrix | `fields.x`, categorical `fields.y`, and numeric `fields.value` |
| `boxplot` | five-number summaries | `fields.y` is exactly `[min,q1,median,q3,max]` |
| `pareto` | ranked causes plus cumulative share | exactly one non-negative Y series |
| `table` | fallback | used only when visual mapping is not meaningful |

Whitelist:

`line` | `bar` | `stacked_bar` | `area` | `pie` | `donut` |
`scatter` | `histogram` | `heatmap` | `boxplot` | `pareto` | `table`

Never use 3D charts. Avoid dual axes except the fixed Pareto cumulative-percent
axis. Reject incompatible mappings instead of silently inventing data.

## Goal defaults

| goal | Default chartType |
|---|---|
| `trend` | `line` |
| `compare` | `bar` |
| `composition` | `donut` |
| `distribution` | `histogram` |
| `ranking` | `bar` |
| `correlation` | `scatter` |

## Generator invocation and outputs

```bash
node .ai-agent/skills/echarts-chart/scripts/generate-chart.mjs \
  --input chart-input.json --output-dir charts
```

Outputs:

- `charts/<slug>.spec.json` — normalized display/analysis contract
- `charts/<slug>.data.json` — cleaned records used for analysis/download
- `charts/<slug>.html` — offline single-file interactive chart
- `charts/<slug>.png` — only when `--png` is passed and headless Chrome exists

JSON embedded in HTML escapes `<`, U+2028, and U+2029. The generated page never
loads scripts, fonts, or data from the network.
