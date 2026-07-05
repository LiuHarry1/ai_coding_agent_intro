/**
 * Verify auto-compaction writes a `compacted` JSONL checkpoint and reload works.
 *
 * Prereq: server running with COMPACT_THRESHOLD_OVERRIDE=8000 (or session already
 * over threshold). Uses session 9f94986d which has a long history.
 *
 * Run:
 *   COMPACT_THRESHOLD_OVERRIDE=8000 npx tsx examples/08-basic/scripts/test-compaction-checkpoint-persist.ts
 */
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../..')
const SESSION_DIR = path.join(REPO_ROOT, '.sessions')
const SESSION_ID = '9f94986d-2d38-47ef-bfe7-f8826447af9c'
const SERVER = process.env.SERVER_URL ?? 'http://localhost:4567'
const WORKSPACE = '/Users/harry/cursor_workspace/test9'

function countJsonlLines(sessionId: string): number {
  const p = path.join(SESSION_DIR, `${sessionId}.jsonl`)
  return fs.readFileSync(p, 'utf8').trim().split('\n').length
}

function hasCompactedCheckpoint(sessionId: string): boolean {
  const p = path.join(SESSION_DIR, `${sessionId}.jsonl`)
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n')
  return lines.some(
    l => (JSON.parse(l) as { type?: string }).type === 'compacted',
  )
}

function reloadedMessageCount(sessionId: string): number {
  const p = path.join(SESSION_DIR, `${sessionId}.jsonl`)
  const lines = fs
    .readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l) as Record<string, unknown>)
  let count = 0
  for (const line of lines) {
    if (line.type === 'compacted') {
      count = Array.isArray(line.messages) ? line.messages.length : 0
      continue
    }
    if (line.type === 'message' || line.type === 'attachment') count++
  }
  return count
}

async function chat(message: string): Promise<void> {
  const res = await fetch(`${SERVER}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      message,
      workspace: WORKSPACE,
      session_id: SESSION_ID,
      stream: true,
    }),
  })
  if (!res.ok) {
    throw new Error(`chat failed: ${res.status} ${await res.text()}`)
  }
  const body = await res.text()
  if (!body.includes('"done"') && !body.includes('done')) {
    console.warn('stream may not have finished cleanly')
  }
}

async function main(): Promise<void> {
  const linesBefore = countJsonlLines(SESSION_ID)
  const hadCheckpointBefore = hasCompactedCheckpoint(SESSION_ID)
  const msgsBeforeReload = reloadedMessageCount(SESSION_ID)

  console.log(
    `before: ${linesBefore} jsonl lines, compacted_checkpoint=${hadCheckpointBefore}, replayed_msgs≈${msgsBeforeReload}`,
  )

  await chat('回复 OK 两个字即可')

  const hadCheckpointAfter = hasCompactedCheckpoint(SESSION_ID)
  const msgsAfterReload = reloadedMessageCount(SESSION_ID)
  const linesAfter = countJsonlLines(SESSION_ID)

  console.log(
    `after:  ${linesAfter} jsonl lines, compacted_checkpoint=${hadCheckpointAfter}, replayed_msgs≈${msgsAfterReload}`,
  )

  if (!hadCheckpointAfter) {
    console.error(
      '[FAIL] JSONL missing type=compacted checkpoint after auto-compact',
    )
    process.exit(1)
  }
  console.log('[PASS] compacted checkpoint written to JSONL')

  if (msgsAfterReload > 20) {
    console.error(
      `[FAIL] reload still replays too many messages (${msgsAfterReload}); checkpoint not applied`,
    )
    process.exit(1)
  }
  console.log(`[PASS] reload message count collapsed (${msgsAfterReload} msgs)`)

  console.log('\nAll checkpoint persistence tests passed.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
