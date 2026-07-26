/**
 * Verify UI transcript replays full JSONL (pre-compact messages + boundary + post).
 *
 * Run:
 *   npx tsx src/scripts/test-session-transcript-ui.ts [sessionId]
 */
import * as path from 'path'
import { fileURLToPath } from 'url'

// SESSION_DIR is cwd-relative in session.ts; server runs from repo root.
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)
process.chdir(REPO_ROOT)

const SESSION_ID = process.argv[2] ?? '907f6a20-692d-4182-af7d-ce75d15b9400'

async function main(): Promise<void> {
  const { sessionJsonlToUIMessages } = await import('../server/session-ui.js')
  const ui = sessionJsonlToUIMessages(SESSION_ID)
  const types = ui.map(m => (m as { type?: string }).type)
  const users = ui
    .filter(m => (m as { type?: string }).type === 'user')
    .map(m => String((m as { content?: string }).content ?? '').slice(0, 60))

  console.log(`session ${SESSION_ID}`)
  console.log(`UI count: ${ui.length}, types: ${types.join(' → ')}`)
  console.log('User bubbles:')
  for (const u of users) console.log(`  - ${u}`)

  const hasFirstTurn = users.some(
    c => c.includes('列出 test9') || c.includes('test9'),
  )
  const hasBoundary = types.includes('compact_boundary')

  if (!hasFirstTurn) {
    console.error('[FAIL] missing pre-compact user turn (列出 test9)')
    process.exit(1)
  }
  if (!hasBoundary) {
    console.error('[FAIL] missing compact_boundary')
    process.exit(1)
  }

  console.log(
    '[PASS] full JSONL transcript UI replay (pre-compact + boundary + post-compact)',
  )
}

void main()
