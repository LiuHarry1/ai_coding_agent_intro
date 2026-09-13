/**
 * Regression: forked agents must not leak readFileState into the parent
 * session, and post-compact file restore must not duplicate files the model
 * still sees in the preserved tail.
 *
 * Both behaviours are what keeps Auto Memory recall alive across a session:
 * the turn-end extract fork reads memory files with the real Read tool, and
 * prefetch treats anything in readFileState as already-in-context.
 *
 * Isolation is an AsyncLocalStorage scope, not a snapshot/restore, so it also
 * holds while the (un-awaited) extract fork overlaps the next turn.
 *
 * Run: npx tsx src/scripts/test-fork-read-isolation.ts
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AnyTool, Message } from '../core/types.js'
import type { ReadFileState } from '../utils/read/types.js'
import { runForkedAgent } from '../core/forked-agent.js'
import { activeReadFileState } from '../utils/read/read-file-state.js'
import {
  extractRecentlyReadFiles,
  restoreRecentFiles,
} from '../services/compact/fileRestore.js'
import { microCompact } from '../services/compact/microCompact.js'
import { FILE_READ_TOOL_NAME } from '../constants/tool_names.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-isolation-'))

function entry(content: string) {
  return { content, timestamp: Date.now() }
}

function readCall(toolCallId: string, filePath: string): Message {
  return {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId,
        toolName: FILE_READ_TOOL_NAME,
        input: { file_path: filePath },
      },
    ],
  } as Message
}

const stubTools = { [FILE_READ_TOOL_NAME]: {} as AnyTool }
const stubProvider = {} as never

try {
  // ── 1. Fork read isolation ────────────────────────────
  const parentState: ReadFileState = new Map([
    ['/repo/src/index.ts', entry('main')],
  ])

  await runForkedAgent({
    prompt: 'extract',
    // Stands in for a cache-safe extract fork: it reuses the parent's bound
    // tool instances, so it resolves the map exactly like the file tools do.
    runAgent: async () => {
      const state = activeReadFileState(parentState)!
      assert.notEqual(
        state,
        parentState,
        'inside a fork the accessor must resolve to the fork-local map',
      )
      state.set('/memdir/reference_observability.md', entry('memory'))
      state.set('/memdir/user_role.md', entry('memory'))
      return 'done'
    },
    systemPrompt: 'test',
    tools: stubTools,
    provider: stubProvider,
    model: 'test-model',
    forkContextMessages: [],
    forkLabel: 'test_extract',
  })

  assert.equal(
    parentState.size,
    1,
    'fork reads must not survive in the parent session',
  )
  assert.ok(
    parentState.has('/repo/src/index.ts'),
    'pre-existing parent entries must be preserved',
  )
  assert.equal(
    parentState.has('/memdir/reference_observability.md'),
    false,
    'memory files read by the extract fork must not block later recall',
  )
  console.log('[ok] fork reads stay inside the fork scope')

  // A fork that throws must leave the session map untouched too.
  const throwingState: ReadFileState = new Map()
  await assert.rejects(
    runForkedAgent({
      prompt: 'extract',
      runAgent: async () => {
        activeReadFileState(throwingState)!.set('/memdir/leaked.md', entry('memory'))
        throw new Error('fork blew up')
      },
      systemPrompt: 'test',
      tools: stubTools,
      provider: stubProvider,
      model: 'test-model',
      forkContextMessages: [],
      forkLabel: 'test_extract_failure',
    }),
  )
  assert.equal(throwingState.size, 0, 'failed forks must not leak either')
  console.log('[ok] failed fork leaks no read state')

  // Turn-end extracts are fire-and-forget, so the next turn can start while a
  // fork is still running. Main-thread reads during that window must survive.
  const concurrentState: ReadFileState = new Map()
  let forkStarted: () => void = () => {}
  const started = new Promise<void>(resolve => (forkStarted = resolve))
  let releaseFork: () => void = () => {}
  const held = new Promise<void>(resolve => (releaseFork = resolve))

  const forkRun = runForkedAgent({
    prompt: 'extract',
    runAgent: async () => {
      activeReadFileState(concurrentState)!.set('/memdir/scanned.md', entry('m'))
      forkStarted()
      await held
      return 'done'
    },
    systemPrompt: 'test',
    tools: stubTools,
    provider: stubProvider,
    model: 'test-model',
    forkContextMessages: [],
    forkLabel: 'test_extract_concurrent',
  })

  await started
  // Main loop, outside the fork's async scope — resolves to the session map.
  activeReadFileState(concurrentState)!.set('/repo/src/next-turn.ts', entry('t2'))
  releaseFork()
  await forkRun

  assert.ok(
    concurrentState.has('/repo/src/next-turn.ts'),
    'a read the main loop made while the fork ran must not be discarded',
  )
  assert.equal(
    concurrentState.has('/memdir/scanned.md'),
    false,
    'the fork still leaks nothing into the session map',
  )
  console.log('[ok] concurrent main-loop reads survive an in-flight fork')

  // ── 2. File restore skips the preserved tail ──────────
  const kept = path.join(dir, 'kept.ts')
  const dropped = path.join(dir, 'dropped.ts')
  fs.writeFileSync(kept, 'export const kept = 1\n')
  fs.writeFileSync(dropped, 'export const dropped = 2\n')

  const budget = { maxFiles: 5, maxTokensPerFile: 5_000, totalBudget: 50_000 }
  const recent = [kept, dropped]

  const withoutTail = restoreRecentFiles(recent, dir, budget)
  assert.ok(withoutTail.includes('kept.ts'), 'no tail → restore everything')
  assert.ok(withoutTail.includes('dropped.ts'))

  const preserved: Message[] = [readCall('t1', kept)]
  const withTail = restoreRecentFiles(recent, dir, budget, preserved)
  assert.equal(
    withTail.includes('kept.ts'),
    false,
    'a file the model still sees in the preserved tail must not be re-injected',
  )
  assert.ok(
    withTail.includes('dropped.ts'),
    'files outside the preserved tail are still restored',
  )
  assert.ok(
    withTail.length < withoutTail.length,
    'tail diffing must shrink the restored section',
  )
  console.log('[ok] file restore diffs against the preserved tail')

  // Relative paths in the tail must match absolute recents and vice versa.
  const relPreserved: Message[] = [readCall('t2', 'kept.ts')]
  assert.equal(
    restoreRecentFiles(recent, dir, budget, relPreserved).includes('kept.ts'),
    false,
    'tail paths must be resolved against cwd before diffing',
  )
  console.log('[ok] tail diffing resolves relative paths')

  // A tail that covers every recent file collapses the section entirely.
  const allPreserved: Message[] = [readCall('t3', kept), readCall('t4', dropped)]
  assert.equal(
    restoreRecentFiles(recent, dir, budget, allPreserved),
    '',
    'fully covered restore must emit nothing',
  )
  console.log('[ok] fully covered restore emits nothing')

  // ── 3. Budget clamp ───────────────────────────────────
  const tiny = { maxFiles: 5, maxTokensPerFile: 5_000, totalBudget: 0 }
  assert.equal(
    restoreRecentFiles(recent, dir, tiny),
    '',
    'a clamped-to-zero budget must restore nothing',
  )
  console.log('[ok] zero budget restores nothing')

  assert.deepEqual(
    extractRecentlyReadFiles([readCall('t5', kept), readCall('t6', kept)]),
    [kept],
    'recent file list must be de-duplicated',
  )

  // ── 4. Micro compact counts tool results, not tool messages ──
  // A step issuing parallel Reads produces one `tool` message holding every
  // result, so message-granular counting would treat the whole batch as a
  // single recent item and clear nothing.
  const batched: Message[] = [
    { role: 'user', content: 'read them', uuid: 'u1' },
    {
      role: 'assistant',
      uuid: 'a1',
      content: ['c1', 'c2', 'c3', 'c4'].map(id => ({
        type: 'tool-call' as const,
        toolCallId: id,
        toolName: FILE_READ_TOOL_NAME,
        input: { file_path: `${id}.ts` },
      })),
    },
    {
      role: 'tool',
      uuid: 't1',
      content: ['c1', 'c2', 'c3', 'c4'].map(id => ({
        type: 'tool-result' as const,
        toolCallId: id,
        toolName: FILE_READ_TOOL_NAME,
        output: { type: 'text' as const, value: 'x'.repeat(4_000) },
      })),
    },
  ] as Message[]

  const micro = microCompact(batched, 1)
  assert.equal(
    micro.cleared,
    3,
    'a four-read batch in one tool message must clear all but the most recent',
  )
  assert.ok(micro.tokensFreed > 0, 'clearing must free tokens')
  const survivors = (micro.messages[2] as { content: { output: { value: string } }[] }).content
  assert.equal(
    survivors[3].output.value.length,
    4_000,
    'the most recent result stays intact',
  )
  assert.ok(
    survivors[0].output.value.length < 200,
    'older results in the same message are cleared',
  )
  console.log('[ok] micro compact clears per tool result, not per tool message')

  assert.equal(
    microCompact(batched, 4).cleared,
    0,
    'keepRecent covering every result clears nothing',
  )
  assert.equal(
    microCompact(batched, 0).cleared,
    4,
    'keepRecent 0 still means clear everything',
  )

  // ── 5. No tool may bypass the fork scope ──────────────
  // Fork isolation is an AsyncLocalStorage scope, so it is invisible in the
  // type signature: a tool that reaches `context.session.readFileState`
  // directly still compiles and still leaks. Guard the convention instead.
  const toolsRoot = path.resolve('src/tools')
  const sourceFiles: string[] = []
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.ts')) sourceFiles.push(full)
    }
  }
  walk(toolsRoot)
  assert.ok(sourceFiles.length > 0, 'tool sources must be discoverable')

  // `activeReadFileState` is camel-cased, so `\breadFileState\b` never matches
  // the accessor's own name — only real property access and destructuring.
  const directAccess = /session\s*\??\s*\.\s*readFileState\b/g
  const guardedAccess =
    /activeReadFileState\(\s*\(?\s*(?:[\w.]*\.)?session\s*\??\s*\.\s*readFileState\b/g
  const destructured = /\{[^}]*\breadFileState\b[^}]*\}\s*=[^=]/g

  const offenders: string[] = []
  let accessorUsers = 0
  for (const file of sourceFiles) {
    const src = fs.readFileSync(file, 'utf-8').replace(/\s+/g, ' ')
    const rel = path.relative(toolsRoot, file).split(path.sep).join('/')
    const direct = src.match(directAccess)?.length ?? 0
    const guarded = src.match(guardedAccess)?.length ?? 0
    if (direct > guarded) {
      offenders.push(`${rel} (${direct - guarded} unguarded access)`)
    }
    if (destructured.test(src)) offenders.push(`${rel} (destructured)`)
    destructured.lastIndex = 0
    if (guarded > 0) accessorUsers++
  }

  assert.deepEqual(
    offenders,
    [],
    'tools must read the session map through activeReadFileState() so forks stay isolated',
  )
  // Sentinel: the check above passes vacuously if the accessor is ever dropped.
  assert.ok(
    accessorUsers >= 3,
    `Read/Edit/Write must all go through activeReadFileState (found ${accessorUsers})`,
  )
  console.log('[ok] no tool bypasses the fork readFileState scope')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('[PASS] fork read isolation + preserved-tail file restore')
