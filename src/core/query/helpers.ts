import { ensureMessageUuid } from '../../services/session-memory/index.js'
import type {
  AgentOptions,
  AnyTool,
  Message,
  TodoItem,
  TodoStatus,
  UserContentPart,
  UserMessage,
} from '../types.js'
import { isRoleMessage } from '../types.js'
import type { WireEmitter } from '../wire-emitter.js'
import { emitTodoUpdate } from '../wire-internal.js'
import { TOOL_SEARCH_TOOL_NAME, TODO_WRITE_TOOL_NAME } from '../../constants/tool_names.js'
import type { StreamResult } from '../agent/streamConsumer.js'
import {
  mediaTypeForExt,
  parseChatUploadUrl,
  parseDataUrl,
} from '../../utils/chat-uploads.js'

export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384
export const MAX_TRANSIENT_RETRIES = 2

/** Default / resolve console tag: `[agent:main]` or `[agent:session_memory]`. */
export function agentLogTag(logLabel?: string): string {
  return `agent:${logLabel ?? 'main'}`
}

export function getMaxOutputTokens(): number {
  const parsed = parseInt(process.env.AGENT_MAX_OUTPUT_TOKENS ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_OUTPUT_TOKENS
}

/** Providers reject when prompt tokens + max_tokens exceed the model window. */
export function capMaxOutputTokens(
  promptTokens: number,
  contextWindow?: number,
): number {
  const wanted = getMaxOutputTokens()
  const window = contextWindow && contextWindow > 0 ? contextWindow : 200_000
  const remaining = window - promptTokens - 1_024
  return Math.max(1_024, Math.min(wanted, remaining))
}

/**
 * Build a user message. Image refs should already be durable upload URLs
 * (`/sessions/{id}/uploads/{file}`) from `offloadChatImageRefs`. Legacy data
 * URLs are accepted as a last resort (prefer offload so session JSONL never
 * embeds megabyte base64).
 *
 * Parts store short string refs — bytes are hydrated in `projectMessagesForApi`.
 */
export function buildUserMessage(text: string, images?: string[]): UserMessage {
  if (!images || images.length === 0) {
    return ensureMessageUuid({ role: 'user', content: text })
  }
  const parts: UserContentPart[] = [{ type: 'text', text }]
  for (const ref of images) {
    const upload = parseChatUploadUrl(ref)
    if (upload) {
      const ext = upload.fileName.split('.').pop() || 'png'
      parts.push({
        type: 'image',
        image: ref,
        mediaType: mediaTypeForExt(ext),
      })
      continue
    }
    if (ref.startsWith('data:')) {
      const { mediaType } = parseDataUrl(ref)
      parts.push({ type: 'image', image: ref, mediaType })
      continue
    }
    throw new Error('Unsupported image ref in buildUserMessage')
  }
  return ensureMessageUuid({ role: 'user', content: parts })
}

export function autoCompleteTodos(
  todos: TodoItem[],
  eventBus: AgentOptions['eventBus'],
  wire: WireEmitter,
): void {
  const hasIncomplete = todos.some(
    t => t.status === 'pending' || t.status === 'in_progress',
  )
  if (!hasIncomplete) return
  const updated = todos.map(t =>
    t.status === 'pending' || t.status === 'in_progress'
      ? { ...t, status: 'completed' as TodoStatus }
      : t,
  )
  emitTodoUpdate(wire, eventBus, updated)
}

function formatTodoReminder(todos: TodoItem[]): string {
  const lines = todos.map(t => `- [${t.status}] ${t.id}: ${t.content}`)
  return `[Active todo list -- update via ${TODO_WRITE_TOOL_NAME}(merge=true) as you complete items]\n${lines.join('\n')}`
}

export function attachTodoReminderAfterCompaction(
  messages: Message[],
  todos: TodoItem[],
): void {
  if (todos.length === 0) return
  const last = messages[messages.length - 1]
  if (
    !last ||
    !isRoleMessage(last) ||
    last.role !== 'assistant' ||
    !Array.isArray(last.content)
  )
    return
  const existing = last.content.find(p => p.type === 'text')
  const reminder = '\n\n' + formatTodoReminder(todos)
  if (existing && 'text' in existing) {
    existing.text += reminder
  } else {
    last.content.push({ type: 'text', text: reminder })
  }
}

export function activateDeferredTools(
  toolCalls: StreamResult['toolCalls'],
  pool: Record<string, AnyTool>,
  active: Record<string, AnyTool>,
  discovered: Set<string>,
): void {
  for (const tc of toolCalls) {
    if (tc.toolName !== TOOL_SEARCH_TOOL_NAME) continue
    const query = (tc.input as { query?: string }).query
    if (!query) continue

    const trimmed = query.trim()
    let names: string[] = []

    const prefixed = trimmed.toLowerCase().startsWith('select:')
    const rest = prefixed ? trimmed.slice(7) : trimmed
    const commaParts = rest
      .split(',')
      .map(n => n.trim())
      .filter(Boolean)
    if (
      prefixed ||
      (commaParts.length > 1 && commaParts.some(n => n in pool))
    ) {
      names = commaParts
    } else {
      const kw = trimmed.toLowerCase().split(/\s+/).filter(Boolean)
      for (const name of Object.keys(pool)) {
        if (kw.some(k => name.toLowerCase().includes(k))) {
          names.push(name)
        }
      }
    }

    for (const name of names) {
      if (pool[name] && !active[name]) {
        active[name] = pool[name]
        delete pool[name]
        discovered.add(name)
        console.log(`[agent] activated deferred tool: ${name}`)
      }
    }
  }
}

export function syncToolSet(
  target: Record<string, AnyTool>,
  source: Record<string, AnyTool>,
): void {
  for (const key of Object.keys(target)) {
    if (!(key in source)) delete target[key]
  }
  Object.assign(target, source)
}
