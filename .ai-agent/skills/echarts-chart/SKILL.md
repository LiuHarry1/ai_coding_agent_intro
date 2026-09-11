---
name: echarts-chart
description: >-
  将结构化数据确定性地转为离线 ECharts HTML、清洗数据、图表 spec 和可选 PNG。
  触发短语：画图表、生成图表、ECharts、柱状图、折线图、饼图、趋势图、chart from data、visualize data。
argument-hint: "<标题 + 数据描述或 CSV/表格>"
user-invocable: true
---

# ECharts Chart — 可复现的数据图表

把分析数据规范化后交给脚本生成离线单文件 HTML、spec、清洗后的
data JSON，以及按需 PNG。模型从 data JSON 得出结论；图片只用于视觉 QA。

## 何时使用

- 用户要可视化数据或制作数据分析图
- 已有或可整理成表格的数据（title + goal + data + fields）
- 需要可追溯的来源、单位、时间范围或 YTD 标识
- 需要交互 HTML，或报告/PPT 使用的静态 PNG

不要使用当：

- 用户只要文字分析、不需要图
- 用户要改代码库里的 React 组件而非生成 HTML 产物

## Trigger Rules

至少需要：

- `title`
- `goal`（见 [references/input-model.md](references/input-model.md)）
- `data`（对象数组）
- `fields.x` 与 `fields.y`

## Required Calling Discipline

- 只写结构化 JSON；禁止任意 JavaScript、formatter 函数、HTML 或外部 script
- 不直接复制/修改模板中的 `const D`，必须调用
  [`scripts/generate-chart.mjs`](scripts/generate-chart.mjs)
- 默认输出目录固定为 workspace 的 `charts/`
- 结论必须来自生成的 `.data.json`，不能靠 OCR 猜数值
- 只有视觉 QA、报告/PPT或用户明确要求时才传 `--png`

## Preflight Checklist

生成前确认：

- [ ] `data` 为非空数组
- [ ] `fields.x` 存在于每条 record
- [ ] `fields.y` 中每个字段存在于每条 record
- [ ] `goal` 为合法 enum
- [ ] `chartType`（若指定）在 whitelist 内
- [ ] `source`、`unit`、`timeRange` 在数据可得时已填写
- [ ] 空值策略明确；YTD/当前周期已标记 `incompletePeriod`
- [ ] 百分比/比率的分子、分母和口径已经确认

字段不确定时，先整理 data 再生成，不要猜测列名。

## Standard Workflows

### Workflow A — 新图表

1. 将用户输入写到临时 JSON（完整模型见
   [references/input-model.md](references/input-model.md)）。
2. 执行：
   `node .ai-agent/skills/echarts-chart/scripts/generate-chart.mjs --input <input.json> --output-dir charts`
3. 读取生成的 `<slug>.spec.json` 和 `<slug>.data.json`，确认记录数、单位、
   时间范围、空值与排序。
4. 若需要视觉 QA，追加 `--png` 再执行，并只 Read 一次 PNG。若运行环境没有
   Chrome，保留 HTML 并明确说明 PNG 未生成。
5. 返回所有产物与 preview 链接。前端会携带当前登录态安全地打开 preview。

### Workflow B — 小改动（patch）

用户修改标题、类型、主题、尺寸、字段映射或分析元数据时：

- 修改原始 input JSON 后重新运行生成器
- 不 patch 生成的 HTML，避免 spec/data/HTML 漂移
- 标题变更导致 slug 变化时，明确列出新路径

### Workflow C — 数据有问题

- 映射不兼容、字段缺失、NaN/Infinity、非法空值或不合理 pie 分类数：
  让生成器报出具体 validation error
- 只有数据确实不适合图形时才显式使用 `chartType: "table"`

## goal → defaultType

| goal | defaultType |
|------|-------------|
| trend | line |
| compare | bar |
| composition | donut |
| distribution | histogram |
| ranking | bar |
| correlation | scatter |

## 交付格式（search2chart-mcp 标准）

最终回复包含实际生成的产物；不要内嵌 base64：

```markdown
图表已生成。

- 交互图表：`{absoluteHtmlPath}`
- 清洗数据：`{absoluteDataPath}`
- 图表规范：`{absoluteSpecPath}`
- 预览：[打开交互图表]({previewBaseUrl}/workspace/preview?path={encodedAbsoluteHtmlPath})
- PNG：`{absolutePngPath}`（仅实际生成时列出）
```

正文补充 2–4 条从 `.data.json` 得出的洞察，并说明来源、单位和不完整周期。

## References

- [input-model.md](references/input-model.md) — 字段与 `const D` 结构
- [chart-template.html](references/chart-template.html) — search2chart 风格 HTML 模板
- [examples.md](references/examples.md) — few-shot 示例
- `references/echarts.min.js` — 固定版本的离线 ECharts runtime

## 质量规则

- 趋势用 line/area；分类比较用 bar；排名用横向 bar
- composition 超过 6 类必须用 Top-N + Other，或改用 bar
- stacked bar 的各系列必须同单位；禁止无意义双轴和 3D
- 标签优先保留单位和足够精度，避免装饰遮挡数据
- 默认 PNG 为 1600×1000；模型读取时由 Read 链路压缩到独立 token 预算
