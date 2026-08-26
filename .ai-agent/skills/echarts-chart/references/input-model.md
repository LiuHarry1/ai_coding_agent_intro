# Chart input model (echarts-chartpage)

Structured input for generating a single-file ECharts HTML chart. The agent normalizes user data into this shape before writing HTML.

## Required fields

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Chart title shown centered above the plot |
| `goal` | enum | Visualization intent (drives default chart type) |
| `data` | array | Records as `{ [field]: string \| number }` |
| `fields.x` | string | Category axis field name (must exist on every record) |
| `fields.y` | string \| string[] | Value field(s); multiple → multi-series |

## Optional fields

| Field | Type | Description |
|-------|------|-------------|
| `chartType` | enum | Force chart type; incompatible mapping → HTML table fallback |
| `theme` | `light` \| `dark` | UI theme hint (template uses light `#fafaf7` background) |
| `fields.category` | string | Alias for pie/donut category when different from `x` |
| `description` | string | Subtitle or caption (optional in HTML) |

## `goal` values

| goal | Default chartType when unspecified |
|------|-----------------------------------|
| `trend` | `line` |
| `compare` | `bar` |
| `composition` | `pie` or `donut` |
| `distribution` | `bar` (histogram-style buckets if pre-binned) |
| `ranking` | `bar` (horizontal bar in template via `defaultType: bar`) |
| `correlation` | `scatter` (fallback `table` if only template bar/line/pie) |

## `chartType` whitelist

`line` | `bar` | `stacked_bar` | `pie` | `donut` | `scatter` | `area` | `table`

If mapping is incompatible, emit a simple HTML `<table>` with the data instead of ECharts.

## Payload embedded in HTML (`const D`)

After normalizing input, embed search2chart-shaped JSON in the HTML template:

```javascript
const D = {
  title: "...",
  categories: ["A", "B", "C"],           // from fields.x
  seriesList: [{ name: "...", data: [...] }],
  palettes: PAL,                           // keep as in template
  defaultType: "bar",                      // from chartType or goal
  defaultPalette: "default",
  width: 720,
  height: 420
};
```

Escape `<` in JSON as `\u003c` if string values contain angle brackets.

## Output path

Write to `charts/{slug}.html` under workspace (slug = kebab-case from title).

## Preview URL

After write:

1. `GET /workspace` → read `previewBaseUrl` (or use deploy `AGENT_PUBLIC_URL`)
2. Link: `{previewBaseUrl}/workspace/preview?path={encodeURIComponent(absPath)}`
