#!/usr/bin/env node
/**
 * Merge slides/*.html + css into a single index.html for offline Reveal.js.
 * Edit slides in slides/, then: node docs/presentation/build.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const slidesDir = path.join(__dirname, 'slides')
const cssPath = path.join(__dirname, 'css', 'theme.css')
const outPath = path.join(__dirname, 'index.html')

const slideFiles = fs
  .readdirSync(slidesDir)
  .filter((f) => f.endsWith('.html'))
  .sort()

const slidesHtml = slideFiles
  .map((f) => fs.readFileSync(path.join(slidesDir, f), 'utf8').trim())
  .join('\n\n')

const css = fs.readFileSync(cssPath, 'utf8')

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Coding Agent 怎么做 — 技术分享</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.css" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/white.css" />
  <style>
${css}
  </style>
</head>
<body>
  <div class="reveal">
    <div class="slides">

${slidesHtml}

    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.js"></script>
  <script>
    Reveal.initialize({
      hash: true,
      slideNumber: 'c/t',
      width: 1280,
      height: 720,
      margin: 0.02,
      minScale: 0.5,
      maxScale: 2.0,
      transition: 'slide',
      backgroundTransition: 'fade',
    });
  </script>
</body>
</html>
`

fs.writeFileSync(outPath, html, 'utf8')
console.log(`Built ${outPath} from ${slideFiles.length} slides:`)
slideFiles.forEach((f) => console.log(`  · ${f}`))
