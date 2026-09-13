#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vitepressBin = path.join(
  repoRoot,
  'node_modules',
  'vitepress',
  'bin',
  'vitepress.js',
)

execFileSync(process.execPath, [vitepressBin, 'build', 'docs'], {
  cwd: repoRoot,
  stdio: 'inherit',
})

console.log('Documentation site built successfully.')
