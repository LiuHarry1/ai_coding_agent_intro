# Examples (echarts-chart skill)

## Example 1 — City sales bar chart

**User:** 画一张城市销量对比柱状图

**Normalized input:**

```json
{
  "title": "城市销量对比",
  "goal": "compare",
  "chartType": "bar",
  "data": [
    { "city": "北京", "sales": 120 },
    { "city": "上海", "sales": 200 },
    { "city": "广州", "sales": 150 }
  ],
  "fields": { "x": "city", "y": "sales" }
}
```

**Output file:** `charts/city-sales.html`

**Delivery (final reply):**

```markdown
图表已生成。

- 文件：`/workspace/charts/city-sales.html`
- 预览：[打开交互图表](http://AGENT_HOST/workspace/preview?path=...)

点击链接在新标签页查看（支持 tooltip、类型切换 bar/line/pie、配色调整）。
```

---

## Example 2 — Monthly trend (line)

**User:** 展示 2025 各月营收趋势

```json
{
  "title": "2025 月度营收",
  "goal": "trend",
  "data": [
    { "month": "2025-01", "revenue": 120 },
    { "month": "2025-02", "revenue": 132 },
    { "month": "2025-03", "revenue": 148 }
  ],
  "fields": { "x": "month", "y": "revenue" }
}
```

`defaultType` → `line`, `defaultPalette` → `default`.

---

## Example 3 — Composition (pie)

**User:** 流量来源占比

```json
{
  "title": "流量来源占比",
  "goal": "composition",
  "data": [
    { "source": "Organic", "sessions": 4200 },
    { "source": "Paid", "sessions": 2100 },
    { "source": "Referral", "sessions": 1100 }
  ],
  "fields": { "x": "source", "y": "sessions", "category": "source" }
}
```

Use single series in `seriesList`; `defaultType` → `pie`.

---

## Example 4 — Patch existing chart

**User:** 把标题改成「Q1 销量」并把默认类型改成折线图

Do not regenerate from scratch. Update only:

- `D.title`
- `D.defaultType = "line"`

Rewrite the same HTML file path.

---

## Example 5 — Incompatible data → table fallback

If user asks for scatter but only one numeric column exists, write `charts/{slug}.html` as a plain HTML table listing rows (echarts-chartpage `table` fallback).
