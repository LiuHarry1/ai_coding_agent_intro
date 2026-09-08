import {
  compactIfNeeded,
  isSummarizingCompactSource,
  tokenCountWithEstimation,
} from '../../services/compact/index.js'
import type {
  CompactEnrichment,
  CompactOutcome,
} from '../../services/compact/index.js'
import type { AgentOptions, Message, TodoItem } from '../types.js'
import type { IProvider } from '../llm/types.js'
import type { WireEmitter } from '../wire-emitter.js'
import type { CompactionConfig, SessionMemoryConfig } from '../types.js'
import {
  agentLogTag,
  attachTodoReminderAfterCompaction,
} from './helpers.js'

function replaceMessages(target: Message[], next: Message[]): void {
  if (target === next) return
  target.length = 0
  target.push(...next)
}

export function applyFullCompaction(
  messages: Message[],
  managed: Message[],
  currentTodos: TodoItem[],
  onFullCompaction?: AgentOptions['onFullCompaction'],
): void {
  replaceMessages(messages, managed)
  attachTodoReminderAfterCompaction(messages, currentTodos)
  onFullCompaction?.(messages)
}

/**
 * Apply compactIfNeeded's outcome. Microcompact only swaps in-memory tool
 * payloads (no checkpoint). Session-memory / full compact replace history
 * and fire onFullCompaction for JSONL persist.
 */
export function applyCompactOutcome(
  messages: Message[],
  outcome: CompactOutcome,
  currentTodos: TodoItem[],
  onFullCompaction?: AgentOptions['onFullCompaction'],
): void {
  if (outcome.source === 'none') return
  if (outcome.source === 'micro') {
    replaceMessages(messages, outcome.messages)
    return
  }
  applyFullCompaction(
    messages,
    outcome.messages,
    currentTodos,
    onFullCompaction,
  )
}

export async function preTurn(input: {
  messages: Message[]
  eventBus: AgentOptions['eventBus']
  wire: WireEmitter
  step: number
  resolvedModel: string
  provider: IProvider
  currentTodos: TodoItem[]
  cwd?: string
  compaction?: CompactionConfig
  sessionMemory?: SessionMemoryConfig
  sessionId?: string
  onFullCompaction?: AgentOptions['onFullCompaction']
  compactEnrichment?: CompactEnrichment
  logLabel?: string
  readFileState?: import('../../utils/read/types.js').ReadFileState
}): Promise<void> {
  const compactStart = Date.now()
  const outcome = await compactIfNeeded(
    input.messages,
    input.eventBus,
    input.wire,
    input.resolvedModel,
    input.cwd ?? process.cwd(),
    input.currentTodos,
    {
      enrichment: input.compactEnrichment,
      sessionMemory: input.sessionMemory,
      readFileState: input.readFileState,
    },
    input.compaction,
    input.provider,
    input.sessionId,
  )
  applyCompactOutcome(
    input.messages,
    outcome,
    input.currentTodos,
    input.onFullCompaction,
  )
  const compactMs = Date.now() - compactStart

  const counted = tokenCountWithEstimation(input.messages)
  const tokenLabel =
    counted.source === 'real+est'
      ? `${counted.total.toLocaleString()} tokens ` +
        `(${counted.realBaseline?.toLocaleString()} real + ${counted.estimatedDelta?.toLocaleString()} est)`
      : `~${counted.total.toLocaleString()} tokens (est, no usage cached yet)`
  const tag = agentLogTag(input.logLabel)
  const compactNote =
    outcome.source === 'none'
      ? ''
      : isSummarizingCompactSource(outcome.source)
        ? `, compaction=${compactMs}ms source=${outcome.source}`
        : `, microcompact=${compactMs}ms`
  console.log(
    `[${tag}] step ${input.step} start -- ${input.messages.length} msgs, ${tokenLabel}, ` +
      `model=${input.resolvedModel}, llm=${input.provider.describe()}` +
      (compactMs > 50 || outcome.source !== 'none' ? compactNote : ''),
  )
}
