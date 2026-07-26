/**
 * End-to-end compact test on a brand-new session.
 *
 * Run: COMPACT_THRESHOLD_OVERRIDE=8000 npx tsx src/scripts/test-compaction-new-session.ts
 */
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
const SESSION_DIR = path.join(REPO_ROOT, '.sessions')
const SERVER = process.env.SERVER_URL ?? 'http://localhost:4567'
const WORKSPACE = '/Users/harry/cursor_workspace/test9'

type UiMessage = Record<string, unknown>

async function chat(
  message: string,
  sessionId?: string,
): Promise<{ sessionId: string; body: string }> {
  const res = await fetch(`${SERVER}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      message,
      workspace: WORKSPACE,
      session_id: sessionId,
      stream: true,
    }),
  })
  if (!res.ok) {
    throw new Error(`chat failed: ${res.status} ${await res.text()}`)
  }
  const sessionIdOut = res.headers.get('x-session-id') ?? sessionId ?? ''
  const body = await res.text()
  return { sessionId: sessionIdOut, body }
}

async function getUiMessages(sessionId: string): Promise<UiMessage[]> {
  const res = await fetch(`${SERVER}/sessions/${sessionId}/messages`)
  if (!res.ok) throw new Error(`messages failed: ${res.status}`)
  const data = (await res.json()) as { messages?: UiMessage[] }
  return data.messages ?? []
}

function replayCount(sessionId: string): number {
  const p = path.join(SESSION_DIR, `${sessionId}.jsonl`)
  if (!fs.existsSync(p)) return 0
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
  let count = 0
  for (const line of lines) {
    const row = JSON.parse(line) as Record<string, unknown>
    if (row.type === 'compacted') {
      count = Array.isArray(row.messages) ? row.messages.length : 0
      continue
    }
    if (row.type === 'message' || row.type === 'attachment') count++
  }
  return count
}

function hasCompactedLine(sessionId: string): boolean {
  const p = path.join(SESSION_DIR, `${sessionId}.jsonl`)
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .some(l => {
      try {
        return (JSON.parse(l) as { type?: string }).type === 'compacted'
      } catch {
        return false
      }
    })
}

async function main(): Promise<void> {
  console.log('=== New session compaction E2E ===')
  console.log(`SERVER=${SERVER} WORKSPACE=${WORKSPACE}`)
  console.log(
    `COMPACT_THRESHOLD_OVERRIDE=${process.env.COMPACT_THRESHOLD_OVERRIDE ?? '(server default)'}`,
  )

  // Turn 1 — create session
  const t1 = await chat('列出 test9 目录下所有文件名，简短回复')
  const sessionId = t1.sessionId
  if (!sessionId) {
    console.error('[FAIL] no session id from turn 1')
    process.exit(1)
  }
  console.log(`[PASS] created session ${sessionId}`)

  // Turn 2 — @mention builds file attachment + more tokens
  await chat('读一下 @huge_file.txt 的前5行，用一句话总结', sessionId)
  console.log('[PASS] turn 2 done')

  // Turn 3 — syntax error file for diagnostics attachment
  await chat('看一下 @syntax_error.py 有什么问题', sessionId)
  console.log('[PASS] turn 3 done')

  // Turn 4 — trigger auto-compact (session should be over threshold)
  await chat('只回复两个字：完成', sessionId)
  console.log('[PASS] turn 4 done (auto-compact may have run)')

  const ui = await getUiMessages(sessionId)
  const types = ui.map(m => m.type)
  const hasBoundary = types.includes('compact_boundary')
  const hasAssistant = types.includes('assistant')
  const hasRawCompactUser = ui.some(
    m =>
      m.type === 'user' &&
      String(m.content ?? '').includes('[Previous conversation compacted'),
  )

  console.log(`\nUI messages (${ui.length}): ${types.join(', ')}`)
  console.log(`JSONL compacted line: ${hasCompactedLine(sessionId)}`)
  console.log(`JSONL replay count: ${replayCount(sessionId)}`)

  if (!hasCompactedLine(sessionId)) {
    console.error('[FAIL] JSONL missing compacted checkpoint')
    process.exit(1)
  }
  console.log('[PASS] compacted checkpoint in JSONL')

  if (!hasBoundary) {
    console.error('[FAIL] UI missing compact_boundary')
    process.exit(1)
  }
  console.log('[PASS] UI shows compact_boundary (not raw summary user bubble)')

  if (hasRawCompactUser) {
    console.error('[FAIL] UI still shows raw compact summary as user message')
    process.exit(1)
  }
  console.log('[PASS] no raw compact summary user bubble')

  if (!hasAssistant) {
    console.error('[FAIL] UI missing post-compact assistant message')
    process.exit(1)
  }
  console.log('[PASS] post-compact assistant visible')

  const userMsgs = ui.filter(m => m.type === 'user').map(m => String(m.content))
  if (!userMsgs.some(c => c.includes('huge_file'))) {
    console.error(
      '[FAIL] missing user bubble for turn that triggered compact:',
      userMsgs,
    )
    process.exit(1)
  }
  console.log('[PASS] in-flight user turn preserved after compact')

  if (replayCount(sessionId) > 15) {
    console.error(
      `[FAIL] reload replay count too high (${replayCount(sessionId)})`,
    )
    process.exit(1)
  }
  console.log(`[PASS] reload collapsed (${replayCount(sessionId)} msgs)`)

  console.log(`\nSession ${sessionId} — all checks passed.`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
