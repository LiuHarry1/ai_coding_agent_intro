/**
 * Smoke: line/token dual gates + similar-path suggestions.
 * Run: npx tsx src/scripts/test-read-gates-and-path-suggest.ts
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { MAX_LINES_TO_READ } from '../constants/api_limits.js'
import { readTextFile } from '../utils/read/read-text.js'
import {
  MaxFileReadLinesExceededError,
  MaxFileReadTokenExceededError,
} from '../utils/read/types.js'
import {
  findSimilarFile,
  formatFileNotFoundMessage,
  suggestPathUnderCwd,
} from '../utils/read/path-suggest.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-gates-'))

try {
  // Line gate: many short lines, under byte cap
  const manyLines = path.join(dir, 'many.txt')
  const n = MAX_LINES_TO_READ + 50
  fs.writeFileSync(manyLines, Array.from({ length: n }, (_, i) => `L${i}`).join('\n'))
  assert.throws(
    () => readTextFile(manyLines, 'many.txt'),
    (e: unknown) => e instanceof MaxFileReadLinesExceededError,
  )
  const windowed = readTextFile(manyLines, 'many.txt', {
    offset: 1,
    limit: 10,
  })
  assert.equal(windowed.file.numLines, 10)
  console.log('[ok] line gate blocks whole-file; offset/limit works')

  // Token gate: few lines but huge content (under line cap, under default byte if we stay small enough)
  // 25_000 tokens * 4 ≈ 100KB — keep under 256KB byte gate
  const fat = path.join(dir, 'fat.txt')
  const fatBody = 'x'.repeat(120_000) // ~30k tokens
  fs.writeFileSync(fat, fatBody)
  assert.throws(
    () => readTextFile(fat, 'fat.txt'),
    (e: unknown) => e instanceof MaxFileReadTokenExceededError,
  )
  console.log('[ok] token gate blocks sparse/huge content')

  // Similar extension
  fs.writeFileSync(path.join(dir, 'auth.js'), 'exports.x=1')
  assert.equal(findSimilarFile(path.join(dir, 'auth.ts')), 'auth.js')
  console.log('[ok] findSimilarFile')

  // Dropped repo folder suggestion
  const parent = path.join(dir, 'parent')
  const repo = path.join(parent, 'repo')
  const wrong = path.join(parent, 'lib', 'util.ts')
  const right = path.join(repo, 'lib', 'util.ts')
  fs.mkdirSync(path.dirname(right), { recursive: true })
  fs.writeFileSync(right, 'ok')
  const suggested = suggestPathUnderCwd(repo, wrong)
  assert.equal(suggested, right)
  const msg = formatFileNotFoundMessage(repo, wrong, 'lib/util.ts')
  assert.ok(msg.includes('Did you mean'))
  console.log('[ok] suggestPathUnderCwd + not-found message')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('[PASS] read gates + path suggest')
