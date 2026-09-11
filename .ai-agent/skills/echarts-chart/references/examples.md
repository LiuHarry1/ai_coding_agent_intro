# Examples

## Example 1 — City sales bar chart

**User:** 画一张城市销量对比柱状图

**Input:**

```json
{
  "title": "城市销量对比",
  "goal": "compare",
  "chartType": "bar",
  "source": "Sales warehouse / daily close",
  "unit": "orders",
  "data": [
    { "city": "北京", "sales": 120 },
    { "city": "上海", "sales": 200 },
    { "city": "广州", "sales": 150 }
  ],
  "fields": { "x": "city", "y": "sales" }
}
```

Run the generator. It writes `city-sales.spec.json`, `city-sales.data.json`,
and `city-sales.html` from the same validated input.

**Delivery (final reply):**

```markdown
图表已生成。

- 文件：`/workspace/charts/city-sales.html`
- 预览：[打开交互图表](http://AGENT_HOST/workspace/preview?path=...)

页面内安全预览支持 tooltip、兼容图形切换、配色调整和清洗数据下载。
```

---

## Example 2 — Monthly trend (line)

**User:** 展示 2025 各月营收趋势

```json
{
  "title": "2025 月度营收",
  "goal": "trend",
  "source": "Finance close v3",
  "unit": "CNY million",
  "timeRange": {"start": "2025-01-01", "end": "2025-03-31", "timezone": "Asia/Shanghai"},
  "missingValuePolicy": "gap",
  "incompletePeriod": {"label": "2025 YTD", "note": "Through March"},
  "sort": "chronological",
  "data": [
    { "month": "2025-01", "revenue": 120 },
    { "month": "2025-02", "revenue": 132 },
    { "month": "2025-03", "revenue": 148 }
  ],
  "fields": { "x": "month", "y": "revenue" }
}
```

The default type is `line`. Null values remain visible gaps rather than being
silently converted to zero.

---

## Example 3 — Composition (pie)

**User:** 流量来源占比

```json
{
  "title": "流量来源占比",
  "goal": "composition",
  "chartType": "donut",
  "topN": 5,
  "includeOther": true,
  "unit": "sessions",
  "data": [
    { "source": "Organic", "sessions": 4200 },
    { "source": "Paid", "sessions": 2100 },
    { "source": "Referral", "sessions": 1100 }
  ],
  "fields": { "x": "source", "y": "sessions", "category": "source" }
}
```

The generator rejects more than six visible slices unless Top-N reduces them.

---

## Example 4 — Patch existing chart

**User:** 把标题改成「Q1 销量」并把默认类型改成折线图

Edit the original input JSON and run the generator again. Do not patch generated
HTML because that would make the spec, data, and chart disagree.

---

## Example 5 — Incompatible data → table fallback

If the user asks for scatter but X is not numeric, stop with the generator's
validation error. Use `"chartType": "table"` only when a table is deliberately
the clearest representation.

---

## Example 6 — Pareto

```json
{
  "title": "Production defect Pareto",
  "goal": "ranking",
  "chartType": "pareto",
  "source": "QMS export 2026-08",
  "unit": "defects",
  "sort": "desc",
  "data": [
    {"cause": "Alignment", "count": 42},
    {"cause": "Contamination", "count": 27},
    {"cause": "Handling", "count": 18}
  ],
  "fields": {"x": "cause", "y": "count"}
}
```

The generated chart uses bars for counts and the one permitted secondary axis
for cumulative percentage.

---

## Example 7 — Heatmap

```json
{
  "title": "Failure density by station and shift",
  "goal": "distribution",
  "chartType": "heatmap",
  "unit": "failures",
  "data": [
    {"station": "S1", "shift": "Day", "failures": 4},
    {"station": "S1", "shift": "Night", "failures": 7},
    {"station": "S2", "shift": "Day", "failures": 2},
    {"station": "S2", "shift": "Night", "failures": 5}
  ],
  "fields": {"x": "station", "y": "shift", "value": "failures"}
}
```
