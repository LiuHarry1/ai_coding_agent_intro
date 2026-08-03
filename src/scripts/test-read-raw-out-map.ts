/**
 * Smoke: Out stores raw lines; map adds header + line numbers for the model.
 * Run: npx tsx src/scripts/test-read-raw-out-map.ts
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  formatReadOutputAsToolString,
  formatTextReadForModel,
} from '../utils/read/index.js'
import { readTextFile } from '../utils/read/read-text.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-raw-'))
const file = path.join(dir, 'sample.ts')
fs.writeFileSync(file, 'line1\nline2\nline3\n')

try {
  const out = readTextFile(file, 'sample.ts', { offset: 1, limit: 2 })
  assert.equal(out.file.content, 'line1\nline2')
  assert.ok(!out.file.content.includes('│'), 'Out must not bake line numbers')
  assert.ok(
    !out.file.content.includes('(lines '),
    'Out must not bake range header',
  )
  assert.equal(out.file.numLines, 2)
  assert.equal(out.file.startLine, 1)

  const mapped = formatReadOutputAsToolString(out)
  assert.ok(mapped.includes('sample.ts (lines 1-2 of'))
  assert.ok(mapped.includes('   1│line1'))
  assert.ok(mapped.includes('   2│line2'))
  assert.ok(!mapped.includes('line3'))

  const viaHelper = formatTextReadForModel(out.file)
  assert.equal(mapped, viaHelper)
  console.log('[ok] raw Out + numbered map')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('[PASS] read raw out / map line numbers')
