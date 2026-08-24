# 技术分享 PPT

Reveal.js 幻灯片，介绍 Coding Agent 架构与 Browser Automation。

## 目录结构

```
docs/presentation/
  index.html          ← 构建产物（双击即可播放）
  build.mjs           ← 合并 slides → index.html
  css/theme.css       ← 共享样式
  assets/             ← SVG 架构图
  slides/             ← 每页 slide 源码（改这里）
    01-architecture.html
    02-agent-loop.html
    …
    09-browser-arch.html
    10-browser-demo.html
    99-end.html
```

## 工作流

**改内容：** 编辑 `slides/*.html` 或 `assets/*.svg`，然后重新构建：

```bash
npm run presentation:build
# 或
node docs/presentation/build.mjs
```

**播放：** 浏览器打开 `docs/presentation/index.html`（构建后可直接 file:// 打开，无需本地服务器）。

**开发预览（可选）：** 若想在改 slide 时热刷新，可用静态服务器：

```bash
npm run presentation
# → http://localhost:3456
```

## 是否需要拆分 slide？

**建议拆分。** 当前 700+ 行的单文件难以维护；拆分后：

| 文件 | 职责 |
|---|---|
| `slides/NN-*.html` | 每页内容，独立编辑 |
| `assets/*.svg` | 架构图、流程图 |
| `css/theme.css` | 视觉样式 |
| `build.mjs` | 合并为单个 `index.html` |

合并后的 `index.html` 仍可离线播放；源码保持模块化。

## 新增一页

1. 在 `slides/` 新建 `11-xxx.html`（`<section>...</section>`）
2. 运行 `npm run presentation:build`
3. 刷新浏览器

命名用数字前缀控制顺序（`99-end.html` 放最后）。
