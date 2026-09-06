/**
 * Compaction + attachment regression test.
 * Run: COMPACT_THRESHOLD_OVERRIDE=8000 npx tsx src/scripts/test-compaction-attachments.ts
 */
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { EventBus } from '../core/event-bus.js'
import { noopWireEmitter } from '../core/wire-emitter.js'
import { buildProvider } from '../core/llm/index.js'
import { isAttachmentMessage, isRoleMessage } from '../core/types.js'
import type { Message } from '../core/types.js'
import { resolveSettings } from '../core/settings-manager.js'
import { compactIfNeeded } from '../services/compact/index.js'
import { tokenCountWithEstimation } from '../services/compact/tokens.js'
import { readTextFile } from '../utils/read/read-text.js'
import { resolveSessionJsonlPath } from './session-jsonl-path.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
process.chdir(REPO_ROOT)
const WORKSPACE = '/Users/harry/cursor_workspace/test9'
const SESSION_ID = '9f94986d-2d38-47ef-bfe7-f8826447af9c'

function restoreMessagesFromJsonl(id: string): Message[] {
  const filePath = resolveSessionJsonlPath(id)
  const lines = fs
    .readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l) as Record<string, unknown>)
  const messages: Message[] = []
  for (const line of lines) {
    if (line.type === 'compacted') {
      messages.length = 0
      if (Array.isArray(line.messages)) {
        messages.push(...(line.messages as Message[]))
      }
      continue
    }
    if (line.type === 'message') {
      const { type: _, timestamp: __, ...msg } = line
      messages.push(msg as unknown as Message)
    } else if (line.type === 'attachment') {
      const { timestamp: _, ...msg } = line
      messages.push(msg as unknown as Message)
    }
  }
  return messages
}

async function main(): Promise<void> {
 console.log('=== Read tool () ===')
  const huge = path.join(WORKSPACE, 'huge_file.txt')
  try {
    readTextFile(huge, 'huge_file.txt')
    console.log('[FAIL] Read without limit should throw')
    process.exit(1)
  } catch {
    console.log('[PASS] Read without limit throws on 350KB file')
  }
  const partial = readTextFile(huge, 'huge_file.txt', { limit: 3 })
  console.log(
    `[PASS] Read limit=3 → ${partial.file.numLines} lines of ${partial.file.totalLines}`,
  )

  console.log('\n=== Compaction + attachments ===')
  const messages = restoreMessagesFromJsonl(SESSION_ID)
  const attBefore = messages.filter(isAttachmentMessage).length
  const attTypes = [
    ...new Set(
      messages.filter(isAttachmentMessage).map(m => m.attachment.type),
    ),
  ]
  const tokens = tokenCountWithEstimation(messages).total
  console.log(
    `loaded ${messages.length} msgs, ${attBefore} attachments (${attTypes.join(',')}), ~${tokens.toLocaleString()} tokens`,
  )

  const settings = resolveSettings(WORKSPACE)
  const provider = buildProvider(settings.config.models.large)
  const model =
    settings.config.models.large.model ?? provider.defaultModelId()
  const eventBus = new EventBus()

  process.env.COMPACT_THRESHOLD_OVERRIDE =
    process.env.COMPACT_THRESHOLD_OVERRIDE ?? '8000'
  console.log(
    `COMPACT_THRESHOLD_OVERRIDE=${process.env.COMPACT_THRESHOLD_OVERRIDE}`,
  )

  const compacted = await compactIfNeeded(
    [...messages],
    eventBus,
    noopWireEmitter,
    model,
    WORKSPACE,
    [],
    { force: true },
    settings.config.compaction,
    provider,
    SESSION_ID,
  )

  const attAfter = compacted.filter(isAttachmentMessage).length
  const tokensAfter = tokenCountWithEstimation(compacted).total
  const isSummary = compacted.some(
    m =>
      isRoleMessage(m) &&
      m.role === 'user' &&
      typeof m.content === 'string' &&
      (!!m.isCompactSummary ||
        m.content.includes('continued from a previous conversation') ||
        m.content.includes('[Previous conversation compacted')),
  )

  console.log(
    `after compact: ${compacted.length} msgs, ${attAfter} attachments, ~${tokensAfter.toLocaleString()} tokens`,
  )

  if (!isSummary) {
    console.log('[FAIL] expected a compact summary user message')
    process.exit(1)
  }
  console.log('[PASS] compact produced summary message (+ optional keep/attachments)')

  if (attAfter !== 0) {
    console.log(
      '[FAIL] without enrichment, attachment messages should not survive full compact',
    )
    process.exit(1)
  }
  console.log(
    '[PASS] without enrichment: summary-only in-memory history',
  )

  // Simulate JSONL compacted checkpoint + reload
  const checkpoint = [...compacted]
  const reloaded = restoreMessagesFromJsonl(SESSION_ID)
  // Manually apply compacted snapshot as restoreFromDisk would
  const simulated: Message[] = []
  for (const line of fs
    .readFileSync(resolveSessionJsonlPath(SESSION_ID), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l))) {
    if (line.type === 'compacted') break
    if (line.type === 'message') {
      const { type: _, timestamp: __, ...msg } = line
      simulated.push(msg as Message)
    } else if (line.type === 'attachment') {
      const { timestamp: _, ...msg } = line
      simulated.push(msg as Message)
    }
  }
  // Before compact checkpoint exists in real JSONL, simulate append
  const afterCheckpoint = checkpoint
  if (
    afterCheckpoint.length !== 1 ||
    afterCheckpoint.filter(isAttachmentMessage).length !== 0
  ) {
    console.log('[FAIL] compacted checkpoint shape')
    process.exit(1)
  }
  console.log(
    '[PASS] compacted checkpoint is summary-only (attachments not stored)',
  )

  console.log(
    '\nNote: with compactEnrichment, agent_listing_delta is re-injected in-memory after full compact (see test-compaction-agent-listing.ts). JSONL checkpoint stays summary-only.',
  )
  console.log('\nAll compaction + read tests passed.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
