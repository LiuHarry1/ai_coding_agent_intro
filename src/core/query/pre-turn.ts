import {
  compactIfNeeded,
  tokenCountWithEstimation,
} from '../../services/compact/index.js'
import type { CompactEnrichment } from '../../services/compact/index.js'
import type { AgentOptions, Message, TodoItem } from '../types.js'
import type { IProvider } from '../llm/types.js'
import type { WireEmitter } from '../wire-emitter.js'
import type { CompactionConfig, SessionMemoryConfig } from '../types.js'
import {
  agentLogTag,
  attachTodoReminderAfterCompaction,
} from './helpers.js'

export function applyFullCompaction(
  messages: Message[],
  managed: Message[],
  currentTodos: TodoItem[],
  onFullCompaction?: AgentOptions['onFullCompaction'],
): void {
  messages.length = 0
  messages.push(...managed)
  attachTodoReminderAfterCompaction(messages, currentTodos)
  onFullCompaction?.(messages)
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
  readFileState?: import('../../utils/attachments/types.js').ReadFileState
}): Promise<void> {
  const compactStart = Date.now()
  const managed = await compactIfNeeded(
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
  const compactMs = Date.now() - compactStart

  const counted = tokenCountWithEstimation(input.messages)
  const tokenLabel =
    counted.source === 'real+est'
      ? `${counted.total.toLocaleString()} tokens ` +
        `(${counted.realBaseline?.toLocaleString()} real + ${counted.estimatedDelta?.toLocaleString()} est)`
      : `~${counted.total.toLocaleString()} tokens (est, no usage cached yet)`
  const tag = agentLogTag(input.logLabel)
  console.log(
    `[${tag}] step ${input.step} start -- ${input.messages.length} msgs, ${tokenLabel}, ` +
      `model=${input.resolvedModel}, llm=${input.provider.describe()}` +
      (compactMs > 50 ? `, compaction=${compactMs}ms` : ''),
  )

  if (managed !== input.messages) {
    applyFullCompaction(
      input.messages,
      managed,
      input.currentTodos,
      input.onFullCompaction,
    )
  }
}
