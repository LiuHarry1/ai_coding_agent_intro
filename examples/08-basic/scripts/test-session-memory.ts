/**
 * Unit tests for session-memory keep-index + SM compact (no live LLM).
 * Run: npx tsx examples/08-basic/scripts/test-session-memory.ts
 */
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import type { Message } from '../core/types.js'
import { isRoleMessage } from '../core/types.js'
import {
  adjustIndexToPreserveToolPairs,
  calculateMessagesToKeepIndex,
  ensureMessageUuid,
  getSessionMemoryPath,
  trySessionMemoryCompaction,
  DEFAULT_SESSION_MEMORY_TEMPLATE,
} from '../services/session-memory/index.js'
import { getSessionMemoryState } from '../services/session-memory/state.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SESSION_ID = `sm-test-${randomUUID()}`

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`[FAIL] ${msg}`)
    process.exit(1)
  }
  console.log(`[PASS] ${msg}`)
}

function user(text: string): Message {
  return ensureMessageUuid({ role: 'user', content: text })
}

function assistantText(text: string): Message {
  return ensureMessageUuid({
    role: 'assistant',
    content: [{ type: 'text', text }],
  })
}

function assistantTool(id: string, name = 'Bash'): Message {
  return ensureMessageUuid({
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: id,
        toolName: name,
        input: {},
      },
    ],
  })
}

function toolResult(id: string, name = 'Bash'): Message {
  return ensureMessageUuid({
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: id,
        toolName: name,
        output: { type: 'text', value: 'ok' },
      },
    ],
  })
}

async function main(): Promise<void> {
  // Tool-pair preservation: keep must not start mid tool-result without call.
  const msgs: Message[] = [
    user('hi'),
    assistantTool('t1'),
    toolResult('t1'),
    user('next'),
    assistantText('done'),
  ]
  const adjusted = adjustIndexToPreserveToolPairs(msgs, 2)
  assert(adjusted === 1, `adjustIndex pulls back to tool-call (got ${adjusted})`)

  const keepCfg = {
    minTokens: 1,
    maxTokens: 100_000,
    minTextMessages: 1,
  }
  const last = msgs[msgs.length - 1]!
  const lastUuid = (last as { uuid?: string }).uuid!
  const start = calculateMessagesToKeepIndex(msgs, lastUuid, keepCfg)
  // Cursor at last → initially keep empty, then expand back for minTokens/minText.
  assert(
    start >= 0 && start < msgs.length,
    `cursor at last msg → expand keep into recent history (got ${start})`,
  )

  // Missing cursor → -1
  const missing = calculateMessagesToKeepIndex(msgs, 'no-such-id', keepCfg)
  assert(missing === -1, 'missing cursor returns -1')

  // Forward-trim when tail exceeds maxTokens
  const fat: Message[] = []
  for (let i = 0; i < 20; i++) {
    fat.push(
      ensureMessageUuid({
        role: 'user',
        content: 'x'.repeat(4000), // ~1000 tokens each by chars/4
      }),
    )
  }
  const trimmed = calculateMessagesToKeepIndex(fat, undefined, {
    minTokens: 1,
    maxTokens: 2500,
    minTextMessages: 1,
  })
  assert(
    trimmed > 0 && trimmed < fat.length,
    `forward-trim keep index under maxTokens (got ${trimmed})`,
  )

  // SM compact with filled notes
  const memPath = getSessionMemoryPath(SESSION_ID)
  fs.mkdirSync(path.dirname(memPath), { recursive: true })
  const filled = DEFAULT_SESSION_MEMORY_TEMPLATE.replace(
    '# Current State\n_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._\n',
    '# Current State\n_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._\nWorking on session-memory tests.\n',
  )
  fs.writeFileSync(memPath, filled)

  const state = getSessionMemoryState(SESSION_ID)
  state.lastSummarizedMessageId = (msgs[2] as { uuid?: string }).uuid

  const sm = await trySessionMemoryCompaction({
    messages: msgs,
    sessionId: SESSION_ID,
    config: {
      enabled: true,
      minimumTokensToInit: 1,
      minimumTokensBetweenUpdate: 1,
      toolCallsBetweenUpdates: 1,
      cacheSafe: true,
      modelTier: 'medium',
      compactMinTokens: 1,
      compactMaxTokens: 100_000,
      compactMinTextMessages: 1,
    },
    estimateTokens: () => 100,
  })
  assert(!!sm, 'SM compact succeeds with notes file')
  assert(sm!.source === 'session_memory', 'source is session_memory')
  assert(
    sm!.messages.some(
      m =>
        isRoleMessage(m) &&
        m.role === 'user' &&
        typeof m.content === 'string' &&
        !!m.isCompactSummary,
    ),
    'includes compact summary message',
  )
  assert(sm!.messagesToKeep.length > 0, 'preserves messagesToKeep')

  // Memory Edit tool path lock
  const { createMemoryFileEditTool } = await import(
    '../services/session-memory/memoryEditTool.js'
  )
  const edit = createMemoryFileEditTool(memPath)
  const denied = await (
    edit as unknown as { execute: (a: unknown) => Promise<string> }
  ).execute({
    file_path: '/tmp/not-allowed.md',
    old_string: 'a',
    new_string: 'b',
  })
  assert(
    typeof denied === 'string' && denied.includes('only'),
    'Edit tool denies other paths',
  )
  const allowed = await (
    edit as unknown as { execute: (a: unknown) => Promise<string> }
  ).execute({
    file_path: memPath,
    old_string: 'Working on session-memory tests.',
    new_string: 'Working on session-memory tests (edited).',
  })
  assert(
    typeof allowed === 'string' && allowed.startsWith('Edited'),
    'Edit tool allows memory path',
  )
  const afterEdit = fs.readFileSync(memPath, 'utf-8')
  assert(
    afterEdit.includes('Working on session-memory tests (edited).'),
    'Edit tool wrote memory file',
  )

  // Extract queue: sequential + latest-wins coalesce
  const { enqueueSessionExtract, resetExtractQueues } = await import(
    '../services/session-memory/extractQueue.js'
  )
  resetExtractQueues()
  const order: string[] = []
  let release!: () => void
  const gate = new Promise<void>(r => {
    release = r
  })
  type TagArgs = { sessionId: string; tag: string }
  const runTagged = async (args: TagArgs) => {
    if (args.tag === 'a') {
      order.push(`start:${args.tag}`)
      await gate
      order.push(`end:${args.tag}`)
    } else {
      order.push(`run:${args.tag}`)
    }
    return { ok: true }
  }
  const slow = enqueueSessionExtract(
    { sessionId: SESSION_ID, tag: 'a' },
    false,
    runTagged,
  )
  await new Promise(r => setTimeout(r, 10))
  const mid = enqueueSessionExtract(
    { sessionId: SESSION_ID, tag: 'b' },
    false,
    runTagged,
  )
  const late = enqueueSessionExtract(
    { sessionId: SESSION_ID, tag: 'c' },
    false,
    runTagged,
  )
  release()
  const [ra, rb, rc] = await Promise.all([slow, mid, late])
  assert(ra.ok === true, 'first extract runs')
  assert(rb.error === 'coalesced', 'middle auto extract coalesced')
  assert(rc.ok === true, 'latest auto extract runs after first')
  assert(
    order.includes('run:c') && !order.includes('run:b'),
    `latest-wins ran c not b (order=${order.join(',')})`,
  )
  resetExtractQueues()

  // Cleanup
  try {
    fs.rmSync(path.join(path.dirname(memPath), '..'), {
      recursive: true,
      force: true,
    })
  } catch {
    // ignore
  }
  console.log('\nAll session-memory unit checks passed.')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
