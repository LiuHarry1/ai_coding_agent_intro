/**
 * Non-blocking relevant-memory prefetch (CC startRelevantMemoryPrefetch).
 */
import type {
  AttachmentMessage,
  Message,
  ToolUseContext,
} from '../../core/types.js'
import { isAttachmentMessage, isRoleMessage } from '../../core/types.js'
import type { IProvider } from '../../core/llm/types.js'
import type { AutoMemoryConfig } from '../../core/types.js'
import type { Attachment } from '../../utils/attachments/types.js'
import type { ReadFileState } from '../../utils/read/types.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import {
  findRelevantMemories,
  MAX_SESSION_BYTES,
  readMemoriesForSurfacing,
  type SelectRelevantFn,
} from './findRelevant.js'

export type MemoryPrefetch = {
  promise: Promise<Attachment[]>
  settledAt: number | null
  /** -1 until consumed. */
  consumedOnIteration: number
  dispose: () => void
}

export const RELEVANT_MEMORIES_CONFIG = {
  MAX_SESSION_BYTES,
} as const

/**
 * Scan transcript for past relevant_memories attachments.
 * Compact that drops attachments naturally resets both counters.
 */
export function collectSurfacedMemories(messages: ReadonlyArray<Message>): {
  paths: Set<string>
  totalBytes: number
} {
  const paths = new Set<string>()
  let totalBytes = 0
  for (const m of messages) {
    if (
      isAttachmentMessage(m) &&
      m.attachment.type === 'relevant_memories'
    ) {
      for (const mem of m.attachment.memories) {
        paths.add(mem.path)
        totalBytes += mem.content.length
      }
    }
  }
  return { paths, totalBytes }
}

function getUserMessageText(msg: Message): string | undefined {
  if (!isRoleMessage(msg) || msg.role !== 'user') return undefined
  if (typeof msg.content === 'string') return msg.content
  return msg.content
    .filter(p => p.type === 'text')
    .map(p => (p.type === 'text' ? p.text : ''))
    .join('\n')
}

/**
 * Tools that succeeded (never errored) since the previous real user turn.
 */
export function collectRecentSuccessfulTools(
  messages: ReadonlyArray<Message>,
  lastUserMessage: Message,
): string[] {
  const lastUserIdx = messages.lastIndexOf(lastUserMessage)
  if (lastUserIdx < 0) return []

  const errored = new Set<string>()
  const succeeded = new Set<string>()
  const toolNameById = new Map<string, string>()

  for (let i = lastUserIdx + 1; i < messages.length; i++) {
    const m = messages[i]
    if (!isRoleMessage(m)) continue
    if (m.role === 'assistant') {
      for (const part of m.content) {
        if (part.type === 'tool-call') {
          toolNameById.set(part.toolCallId, part.toolName)
        }
      }
    }
    if (m.role === 'tool') {
      for (const part of m.content) {
        const name = part.toolName || toolNameById.get(part.toolCallId)
        if (!name) continue
        const isErr =
          part.isError === true ||
          (typeof part.output?.value === 'string' &&
            /error|failed/i.test(part.output.value.slice(0, 200)))
        if (isErr) {
          errored.add(name)
          succeeded.delete(name)
        } else if (!errored.has(name)) {
          succeeded.add(name)
        }
      }
    }
  }
  return [...succeeded]
}

export type StartPrefetchOpts = {
  config: AutoMemoryConfig
  memPath: string
  provider: IProvider
  modelId: string
  readFileState?: ReadFileState
  abortSignal?: AbortSignal
  /** Optional test inject. */
  selectFn?: SelectRelevantFn
  /** Override query text (defaults to last non-meta user message). */
  queryText?: string
}

/**
 * Start relevance search; never blocks the main turn.
 */
export function startRelevantMemoryPrefetch(
  messages: ReadonlyArray<Message>,
  opts: StartPrefetchOpts,
): MemoryPrefetch | undefined {
  if (!opts.config.enabled || opts.config.prefetchEnabled === false) {
    return undefined
  }

  let input = opts.queryText
  let lastUser: Message | undefined
  if (!input) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (
        isRoleMessage(m) &&
        m.role === 'user' &&
        !m.isMeta &&
        !m.isCompactSummary
      ) {
        lastUser = m
        input = getUserMessageText(m)
        break
      }
    }
  } else {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (
        isRoleMessage(m) &&
        m.role === 'user' &&
        !m.isMeta &&
        !m.isCompactSummary
      ) {
        lastUser = m
        break
      }
    }
  }

  if (!input?.trim()) {
    return undefined
  }
  const trimmed = input.trim()
  // CC skips single-word prompts; CJK often has no spaces — use length threshold.
  if (!/\s/.test(trimmed) && trimmed.length < 10) {
    return undefined
  }

  const surfaced = collectSurfacedMemories(messages)
  if (surfaced.totalBytes >= MAX_SESSION_BYTES) {
    return undefined
  }

  const controller = new AbortController()
  const onParentAbort = () => controller.abort()
  opts.abortSignal?.addEventListener('abort', onParentAbort, { once: true })

  const recentTools = lastUser
    ? collectRecentSuccessfulTools(messages, lastUser)
    : []
  const readFileState = opts.readFileState

  const promise = (async (): Promise<Attachment[]> => {
    try {
      const selected = await findRelevantMemories(
        input!,
        opts.memPath,
        {
          provider: opts.provider,
          modelId: opts.modelId,
          signal: controller.signal,
          selectFn: opts.selectFn,
        },
        recentTools,
        surfaced.paths,
      )
      const filtered = selected
        .filter(
          m =>
            !surfaced.paths.has(m.path) &&
            !(readFileState && readFileState.has(m.path)),
        )
        .slice(0, 5)
      const memories = await readMemoriesForSurfacing(
        filtered,
        controller.signal,
      )
      if (memories.length === 0) return []
      return [{ type: 'relevant_memories' as const, memories }]
    } catch (e) {
      if (controller.signal.aborted) return []
      console.warn(
        `[auto-memory] prefetch failed: ${e instanceof Error ? e.message : e}`,
      )
      return []
    }
  })()

  const handle: MemoryPrefetch = {
    promise,
    settledAt: null,
    consumedOnIteration: -1,
    dispose() {
      controller.abort()
      opts.abortSignal?.removeEventListener('abort', onParentAbort)
    },
  }
  void promise.finally(() => {
    handle.settledAt = Date.now()
  })
  return handle
}

/** Consume settled prefetch into attachment messages (zero-wait if settled). */
export async function consumeMemoryPrefetchIfReady(
  prefetch: MemoryPrefetch | undefined,
  readFileState: ReadFileState | undefined,
  iterationIndex: number,
): Promise<AttachmentMessage[]> {
  if (
    !prefetch ||
    prefetch.settledAt === null ||
    prefetch.consumedOnIteration !== -1
  ) {
    return []
  }
  const attachments = await prefetch.promise
  prefetch.consumedOnIteration = iterationIndex
  const out: AttachmentMessage[] = []
  for (const a of attachments) {
    if (a.type !== 'relevant_memories') continue
    const memories = a.memories.filter(
      m => !(readFileState && readFileState.has(m.path)),
    )
    if (memories.length === 0) continue
    out.push(
      createAttachmentMessage({
        type: 'relevant_memories',
        memories,
      }),
    )
  }
  return out
}

/** Helper for tests / ToolUseContext typing. */
export type PrefetchToolUseContext = ToolUseContext & {
  memoryPrefetch?: MemoryPrefetch
}
