#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { globSync } from 'glob'

const repoRoot = process.cwd()
const docsRoot = path.join(repoRoot, 'docs')
const markdownFiles = globSync('**/*.md', {
  cwd: docsRoot,
  ignore: ['.vitepress/**', 'to_be_delete/**'],
})

const failures = []
const linkPattern = /!?\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g

function candidatesFor(target) {
  const out = [target]
  if (!path.extname(target)) {
    out.push(`${target}.md`, path.join(target, 'index.md'), path.join(target, 'README.md'))
  }
  if (target.endsWith('/')) {
    out.push(path.join(target, 'index.md'), path.join(target, 'README.md'), path.join(target, 'index.html'))
  }
  return out
}

for (const relativeFile of markdownFiles) {
  const filePath = path.join(docsRoot, relativeFile)
  const text = fs.readFileSync(filePath, 'utf8')
  for (const match of text.matchAll(linkPattern)) {
    const raw = match[1]
    if (
      !raw ||
      raw.startsWith('#') ||
      /^(?:https?:|mailto:|data:|javascript:)/i.test(raw)
    ) {
      continue
    }

    const pathname = decodeURIComponent(raw.split('#')[0].split('?')[0])
    if (!pathname) continue
    const resolved = pathname.startsWith('/')
      ? path.join(docsRoot, pathname)
      : path.resolve(path.dirname(filePath), pathname)

    if (!candidatesFor(resolved).some(candidate => fs.existsSync(candidate))) {
      failures.push(`${relativeFile}: ${raw}`)
    }
  }
}

const requiredAssets = [
  'index.md',
  'architecture/index.md',
  'architecture/agent-loop.md',
  'architecture/tools.md',
  'architecture/memory.md',
  'architecture/protocol.md',
  'architecture/execution.md',
  'architecture/extensions.md',
  'architecture/browser.md',
  'architecture/memory-guide.md',
  'architecture/assets/architecture-diagram.svg',
  'architecture/assets/architecture-diagram-v2.svg',
  'architecture/assets/agent-loop.svg',
  'architecture/assets/browser-architecture.svg',
  'architecture/assets/browser-login-demo.svg',
  'architecture/assets/lsp-architecture.svg',
  'architecture/assets/memory-flow-simplified.svg',
  'features/index.md',
  'features/scheduled-tasks.md',
  'features/permissions.md',
  'features/attachments.md',
  'features/primary-agents.md',
  'features/slash-commands.md',
]
for (const asset of requiredAssets) {
  if (!fs.existsSync(path.join(docsRoot, asset))) {
    failures.push(`missing required asset: ${asset}`)
  }
}

if (failures.length > 0) {
  console.error(`Documentation link check failed (${failures.length}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(
  `Documentation links OK (${markdownFiles.length} Markdown files, ${requiredAssets.length} required pages/assets).`,
)
