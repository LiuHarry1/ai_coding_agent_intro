/**
 * Smoke test: empty file + offset-beyond-EOF → short system-reminders on LLM path.
 * Run: conda activate python3_11 && npx tsx src/scripts/test-read-boundary-reminders.ts
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readTextFile } from '../utils/read/read-text.js'
import { formatReadOutputAsToolString } from '../utils/read/index.js'
import {
  EMPTY_FILE_READ_REMINDER,
  offsetBeyondEofReminder,
} from '../utils/read/boundary-reminders.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-boundary-'))

try {
  const emptyPath = path.join(dir, 'empty.txt')
  fs.writeFileSync(emptyPath, '')
  const emptyOut = readTextFile(emptyPath, 'empty.txt')
  assert.equal(emptyOut.file.content, '')
  assert.equal(emptyOut.file.totalLines, 0)
  assert.equal(emptyOut.file.numLines, 0)
  const emptyMapped = formatReadOutputAsToolString(emptyOut)
  assert.ok(emptyMapped.includes(EMPTY_FILE_READ_REMINDER))
  assert.ok(emptyMapped.includes('<system-reminder>'))
  console.log('[ok] empty file → system-reminder')

  const shortPath = path.join(dir, 'short.txt')
  fs.writeFileSync(shortPath, 'line1\nline2\nline3\n')
  const oobOut = readTextFile(shortPath, 'short.txt', { offset: 50, limit: 10 })
  assert.equal(oobOut.file.content, '')
  assert.equal(oobOut.file.numLines, 0)
  assert.equal(oobOut.file.totalLines, 4) // trailing newline → 4 split parts
  assert.equal(oobOut.file.startLine, 50)
  const oobMapped = formatReadOutputAsToolString(oobOut)
  assert.ok(
    oobMapped.includes(offsetBeyondEofReminder(50, oobOut.file.totalLines)),
  )
  assert.ok(oobMapped.includes('<system-reminder>'))
  console.log('[ok] offset beyond EOF → system-reminder')

  const okOut = readTextFile(shortPath, 'short.txt', { offset: 1, limit: 2 })
  assert.equal(okOut.file.content, 'line1\nline2')
  const mappedOk = formatReadOutputAsToolString(okOut)
  assert.ok(mappedOk.includes('   1│line1'))
  assert.ok(!mappedOk.includes('<system-reminder>'))
  console.log('[ok] normal read has no boundary reminder')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('[PASS] read boundary reminders')
