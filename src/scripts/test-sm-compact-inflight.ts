/**
 * Live check: SM compact must still run when a session-memory extract is in
 * flight, using the previous generation of summary.md instead of skipping.
 *
 * The overlap is timing-sensitive — an extract starts at turn end and runs
 * ~15-30s, so turns are fired back-to-back with zero delay and each one reads
 * a large file to push the next pre-turn over the compact threshold.
 *
 * Prereq: server started with a low threshold and a short extract wait, e.g.
 *   $env:COMPACT_THRESHOLD_OVERRIDE="20000"
 *   $env:SM_EXTRACT_WAIT_TIMEOUT_MS="10"
 *   npm start 2>&1 | Tee-Object -FilePath server-smfix.log
 *
 * Run: npx tsx src/scripts/test-sm-compact-inflight.ts
 */
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
process.chdir(REPO_ROOT)

const SERVER = process.env.SERVER_URL ?? 'http://localhost:4567'
const WORKSPACE = process.env.WORKSPACE ?? REPO_ROOT
const LOG_PATH = process.env.SERVER_LOG ?? path.join(REPO_ROOT, 'server-smfix.log')

const IN_FLIGHT_LINE = 'compacting from previous generation'

/** Large files, so each turn pushes the next pre-turn over the threshold. */
const TURNS = [
  '读 docs/architecture/memory-guide.md，用一句话说它分了哪几层记忆。',
  '读 src/services/compact/compact.ts，用一句话概括它做什么。',
  '读 src/services/compact/autoCompact.ts，用一句话概括它做什么。',
  '读 src/services/compact/microCompact.ts，用一句话概括它做什么。',
  '读 src/core/forked-agent.ts，用一句话概括它做什么。',
  '读 src/services/session-memory/state.ts，用一句话概括它做什么。',
]

async function chat(
  message: string,
  sessionId?: string,
): Promise<{ sessionId: string }> {
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
  await res.text()
  return { sessionId: sessionIdOut }
}

/**
 * Decode by BOM: `Tee-Object` on Windows PowerShell writes UTF-16LE, and
 * reading that as UTF-8 yields NUL-interleaved text that matches nothing.
 */
function readLog(): string {
  if (!fs.existsSync(LOG_PATH)) return ''
  const buf = fs.readFileSync(LOG_PATH)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le')
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8')
  }
  return buf.toString('utf8')
}

/**
 * Decoded length, not `statSync().size` — the log is full of CJK, and on
 * Windows PowerShell Tee-Object may write UTF-16, so a byte offset would slice
 * far past the mark and silently yield an empty window.
 */
function logMark(): number {
  return readLog().length
}

async function main(): Promise<void> {
  console.log('=== SM compact with an in-flight extract ===')
  console.log(`SERVER=${SERVER}`)
  console.log(`WORKSPACE=${WORKSPACE}`)
  console.log(`LOG=${LOG_PATH}`)
  if (!fs.existsSync(LOG_PATH)) {
    console.error(`[FAIL] server log not found: ${LOG_PATH}`)
    process.exit(1)
  }

  const startMark = logMark()
  let sessionId: string | undefined

  for (const [i, message] of TURNS.entries()) {
    const t0 = Date.now()
    const out = await chat(message, sessionId)
    sessionId = out.sessionId
    console.log(`turn ${i + 1} done in ${Date.now() - t0}ms (session ${sessionId})`)
    // No delay: the extract that just started must still be running when the
    // next turn's pre-turn compaction check happens.
  }

  // The last turn's extract may still be writing; give it room to finish so the
  // log reflects the full picture.
  await new Promise(r => setTimeout(r, 5_000))

  const lines = readLog().slice(startMark).split('\n')

  const inFlightHits = lines.filter(l => l.includes(IN_FLIGHT_LINE))
  const smDone = lines.filter(l => l.includes('session-memory compact DONE'))
  const smSkipped = lines.filter(l => l.includes('session-memory compact skipped'))
  const fullCompacts = lines.filter(l => l.includes('source=full'))

  console.log('')
  console.log(`session-memory compact DONE:      ${smDone.length}`)
  console.log(`session-memory compact skipped:   ${smSkipped.length}`)
  console.log(`fell back to full compact:        ${fullCompacts.length}`)
  console.log(`compacted from previous gen:      ${inFlightHits.length}`)
  for (const l of inFlightHits) console.log(`  > ${l.trim()}`)
  for (const l of smSkipped) console.log(`  skip reason: ${l.trim()}`)

  if (inFlightHits.length === 0) {
    console.error(
      '\n[INCONCLUSIVE] no compaction overlapped an in-flight extract — ' +
        'the path under test never ran. Retry, or lower COMPACT_THRESHOLD_OVERRIDE.',
    )
    process.exit(2)
  }

  // The whole point of the fix: an in-flight extract must not cost us SM compact.
  if (smDone.length === 0) {
    console.error(
      '\n[FAIL] compaction saw an in-flight extract but no SM compact completed',
    )
    process.exit(1)
  }

  console.log(
    `\n[PASS] ${inFlightHits.length} compaction(s) proceeded from the previous ` +
      `generation while an extract was in flight; ${smDone.length} SM compact(s) completed.`,
  )
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
