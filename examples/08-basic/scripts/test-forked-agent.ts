/**
 * Unit tests for core/forked-agent.ts helpers (no live LLM).
 * Run: npx tsx examples/08-basic/scripts/test-forked-agent.ts
 */
import {
  applyCanUseTool,
  createPathScopedEditCanUseTool,
  createSubagentContext,
  saveCacheSafeParams,
  getLastCacheSafeParams,
  createCacheSafeParams,
} from '../core/forked-agent.js'
import { EventBus } from '../core/event-bus.js'
import { noopWireEmitter } from '../core/wire-emitter.js'
import type { AnyTool } from '../core/types.js'

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`[FAIL] ${msg}`)
    process.exit(1)
  }
  console.log(`[PASS] ${msg}`)
}

async function main(): Promise<void> {
  const parent = {
    eventBus: new EventBus(),
    wire: noopWireEmitter,
    cwd: '/tmp/ws',
    sessionId: 's1',
  }

  const isolated = createSubagentContext(parent)
  assert(isolated.eventBus !== parent.eventBus, 'fork gets fresh eventBus')
  assert(isolated.wire === noopWireEmitter, 'fork defaults to noop wire')
  assert(isolated.sessionMemory === undefined, 'fork omits sessionMemory')
  assert(isolated.compaction?.enabled === false, 'fork compaction disabled')
  assert(isolated.cwd === '/tmp/ws', 'fork inherits cwd')

  const shared = createSubagentContext(parent, { shareEventBus: true })
  assert(shared.eventBus === parent.eventBus, 'shareEventBus works')

  const gate = createPathScopedEditCanUseTool('Edit', '/tmp/notes.md')
  const denyOther = await gate('Bash', { command: 'ls' })
  assert(denyOther.behavior === 'deny', 'canUseTool denies other tools')
  const denyPath = await gate('Edit', { file_path: '/tmp/other.md' })
  assert(denyPath.behavior === 'deny', 'canUseTool denies other paths')
  const allow = await gate('Edit', { file_path: '/tmp/notes.md' })
  assert(allow.behavior === 'allow', 'canUseTool allows exact path')

  let executed = false
  const fakeTool = {
    execute: async () => {
      executed = true
      return 'ok'
    },
  } as unknown as AnyTool
  const wrapped = applyCanUseTool({ Edit: fakeTool, Bash: fakeTool }, gate)
  const bashOut = await (
    wrapped.Bash as unknown as { execute: (a: unknown) => Promise<unknown> }
  ).execute({ command: 'x' })
  assert(
    typeof bashOut === 'string' && String(bashOut).includes('only'),
    'applyCanUseTool blocks Bash',
  )
  assert(!executed, 'blocked tool did not execute')
  await (
    wrapped.Edit as unknown as { execute: (a: unknown) => Promise<unknown> }
  ).execute({ file_path: '/tmp/notes.md', old_string: 'a', new_string: 'b' })
  assert(executed, 'allowed Edit executed')

  const params = createCacheSafeParams({
    systemPrompt: 'sys',
    tools: { Edit: fakeTool },
    provider: {} as never,
    model: 'm',
    messages: [],
  })
  saveCacheSafeParams(params)
  assert(getLastCacheSafeParams() === params, 'cache-safe slot save/get')
  saveCacheSafeParams(null)

  // Stale inFlight must be cleared by wait
  const {
    getSessionMemoryState,
    waitForSessionMemoryExtraction,
  } = await import('../services/session-memory/state.js')
  const sid = 'wait-stale-test'
  const st = getSessionMemoryState(sid)
  st.inFlight = true
  st.extractionStartedAt = Date.now() - 120_000
  const wait = await waitForSessionMemoryExtraction(sid)
  assert(wait.ready && wait.clearedStale, 'stale wait clears inFlight')
  assert(!st.inFlight, 'inFlight false after stale abandon')

  console.log('\nAll forked-agent unit checks passed.')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
