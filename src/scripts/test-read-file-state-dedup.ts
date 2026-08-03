/**
 * Smoke: Read dedup stub + Edit invalidates + microcompact drops readFileState.
 * Run: npx tsx src/scripts/test-read-file-state-dedup.ts
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Message } from '../core/types.js'
import type { ReadFileState } from '../utils/read/types.js'
import {
  FILE_UNCHANGED_STUB,
  formatReadOutputAsToolString,
  recordReadInState,
  recordWriteInState,
  shouldDedupRead,
} from '../utils/read/index.js'
import { microCompact } from '../services/compact/microCompact.js'
import { FILE_READ_TOOL_NAME } from '../constants/tool_names.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-dedup-'))
const file = path.join(dir, 'a.ts')
fs.writeFileSync(file, ' const x = 1\nconst y = 2\n')

const state: ReadFileState = new Map()

try {
  assert.equal(shouldDedupRead(state, file, 1, undefined), false)
  recordReadInState(state, file, 'body', 1, undefined)
  assert.equal(shouldDedupRead(state, file, 1, undefined), true)
  assert.equal(shouldDedupRead(state, file, 1, 10), false, 'different limit')
  assert.equal(
    formatReadOutputAsToolString({
      type: 'file_unchanged',
      file: { filePath: 'a.ts' },
    }),
    FILE_UNCHANGED_STUB,
  )
  console.log('[ok] dedup hit same range')

  // Simulate edit → mtime changes + offset cleared
  fs.writeFileSync(file, 'const x = 1\nconst y = 3\n')
  recordWriteInState(state, file, 'edited')
  assert.equal(
    shouldDedupRead(state, file, 1, undefined),
    false,
    'write clears dedup eligibility',
  )
  console.log('[ok] write invalidates dedup')

  // Re-record then microcompact clears Read + state
  recordReadInState(state, file, 'body2', 1, 50)
  assert.equal(shouldDedupRead(state, file, 1, 50), true)

  const messages: Message[] = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 't1',
          toolName: FILE_READ_TOOL_NAME,
          input: { file_path: 'a.ts', offset: 1, limit: 50 },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 't1',
          toolName: FILE_READ_TOOL_NAME,
          output: { type: 'text', value: 'huge '.repeat(500) },
          toolUseResult: {
            type: 'text',
            file: {
              filePath: 'a.ts',
              content: 'x',
              numLines: 1,
              startLine: 1,
              totalLines: 2,
            },
          },
        },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 't2',
          toolName: FILE_READ_TOOL_NAME,
          input: { file_path: 'a.ts' },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 't2',
          toolName: FILE_READ_TOOL_NAME,
          output: { type: 'text', value: 'keep me' },
        },
      ],
    },
  ]

  const r = microCompact(messages, 1, undefined, {
    cwd: dir,
    readFileState: state,
  })
  assert.ok(r.cleared >= 1)
  assert.equal(
    shouldDedupRead(state, file, 1, 50),
    false,
    'microcompact must drop readFileState for cleared Read',
  )
  console.log('[ok] microcompact syncs readFileState')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('[PASS] read file state dedup')
