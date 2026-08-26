---
name: echarts-chart
description: >-
  将结构化数据转为 workspace 内的交互式 ECharts 单文件 HTML，并返回 HTTP 预览链接。
  设计参考 search2chart-mcp（文件+预览链接）与 echarts-chartpage（结构化输入与工作流）。
  触发短语：画图表、生成图表、ECharts、柱状图、折线图、饼图、趋势图、chart from data、visualize data。
argument-hint: "<标题 + 数据描述或 CSV/表格>"
user-invocable: true
---

# ECharts Chart — 交互图表（search2chart + echarts-chartpage）

将结构化 JSON 数据写成 **单文件 HTML**（ECharts 5 CDN），保存到 workspace `charts/`，并返回 **preview 链接**供浏览器打开。

## 何时使用

- 用户要可视化数据（柱状/折线/饼图等）
- 已有或可整理成表格的数据（title + goal + data + fields）
- 需要 **交互**（tooltip、类型切换），不是静态 PNG

不要使用当：

- 用户只要文字分析、不需要图
- 用户要改代码库里的 React 组件而非生成 HTML 产物

## Trigger Rules

在具备以下字段时触发（可向用户追问缺失项）：

- `title`
- `goal`（见 [references/input-model.md](references/input-model.md)）
- `data`（对象数组）
- `fields.x` 与 `fields.y`

## Required Calling Discipline

- **只使用结构化 JSON** 描述数据与字段映射
- **禁止** arbitrary JavaScript、formatter 函数、外部 script 片段（与 echarts-chartpage SECURITY 一致）
- HTML 基于 [references/chart-template.html](references/chart-template.html)；只替换 `const D = { ... }` 块
- 输出目录固定：`charts/{slug}.html`（slug = 标题 kebab-case）
- `outputMode` 等价于 echarts-chartpage 的 `single_html`

## Preflight Checklist

生成前确认：

- [ ] `data` 为非空数组
- [ ] `fields.x` 存在于每条 record
- [ ] `fields.y` 中每个字段存在于每条 record
- [ ] `goal` 为合法 enum
- [ ] `chartType`（若指定）在 whitelist 内

字段不确定时，先整理 data 再生成，不要猜测列名。

## Standard Workflows

### Workflow A — 新图表

1. 将用户输入规范化为 input model（见 references/input-model.md）
2. 若未指定 `chartType`，按 `goal` 推断默认类型
3. 读取 `references/chart-template.html`，填入 `const D` payload（search2chart `lib/html.js` 形状）
4. 用 **write** 工具写入 `charts/{slug}.html`（必要时先 **mkdir** `charts`）
5. 获取 preview base：
   - 优先：bash `curl -s $AGENT_PUBLIC_URL/workspace` 或已知 `AGENT_PUBLIC_URL` 环境变量
   - 或 `GET /workspace` 响应中的 `previewBaseUrl`
6. 按下方 **交付格式** 回复用户

### Workflow B — 小改动（patch）

用户只改标题、类型、配色、宽高或字段映射时：

- 读取已有 HTML，只改 `const D` 中相关字段
- **write** 覆盖同一路径，不要换文件名（除非用户要求）

### Workflow C — 数据有问题

- mapping 与 chartType 不兼容 → 生成 HTML **表格** fallback（见 examples.md Example 5）
- 或列出 validation 错误，请用户修正 data

## goal → defaultType

| goal | defaultType |
|------|-------------|
| trend | line |
| compare | bar |
| composition | pie |
| distribution | bar |
| ranking | bar |
| correlation | scatter（模板仅 bar/line/pie 时 fallback table） |

## 交付格式（search2chart-mcp 标准）

**最终回复必须包含：**

```markdown
图表已生成。

- 文件：`{absolutePath}`
- 预览：[打开交互图表]({previewBaseUrl}/workspace/preview?path={encodeURIComponent(absolutePath)})

点击链接在新标签页查看（支持 tooltip、类型切换、配色调整）。
```

可选：附带清洗后的 data JSON（≤60 行），便于后续文字分析。

## References

- [input-model.md](references/input-model.md) — 字段与 `const D` 结构
- [chart-template.html](references/chart-template.html) — search2chart 风格 HTML 模板
- [examples.md](references/examples.md) — few-shot 示例

## CDN

默认：`https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js`

内网无法访问外网 CDN 时，将模板中的 script src 换成内网镜像（只改一处）。
