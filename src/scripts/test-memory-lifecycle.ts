import assert from 'node:assert/strict'
import type { AgentLifecycleSnapshot } from '../core/types.js'
import { emitTurnEnd } from '../core/query/post-turn.js'

const snapshot = {
  messages: [],
  systemPrompt: 'test',
  tools: {},
  provider: {},
  model: 'test-model',
  sessionId: 'memory-lifecycle-test',
  cwd: process.cwd(),
} as unknown as AgentLifecycleSnapshot

const seen: string[] = []
const onTurnEnd = () => {
  seen.push('finalized')
}

emitTurnEnd(snapshot.sessionId, onTurnEnd, snapshot, 'aborted')
emitTurnEnd(snapshot.sessionId, onTurnEnd, snapshot, 'error')
assert.equal(
  seen.length,
  0,
  'aborted/error turns must stay behind the extraction cursor',
)

emitTurnEnd(snapshot.sessionId, onTurnEnd, snapshot, 'completed')
emitTurnEnd(snapshot.sessionId, onTurnEnd, snapshot, 'max_steps')
assert.equal(
  seen.length,
  2,
  'natural and max_steps finalization must both trigger auto memory',
)

emitTurnEnd(undefined, onTurnEnd, snapshot, 'completed')
assert.equal(seen.length, 2, 'sessionless forks must not trigger host memory')

console.log('All memory lifecycle checks passed.')
