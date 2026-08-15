/**
 * LLM summarization engine for full compaction.
 * Summarizes messages BEFORE keepStartIndex, then builds:
 *   summaryMsg + messagesToKeep + attachments
 * (same shape as session-memory compact).
 */
import { generateText } from 'ai'
import type { IProvider, Message, TodoItem } from '../../core/types.js'
import { isAttachmentMessage, isRoleMessage } from '../../core/types.js'
import { estimateConversationTokens, clearTokenUsages } from './tokens.js'
import {
  buildPostCompactAttachmentMessages,
  type CompactEnrichment,
} from './post-compact-attachments.js'
import {
  extractRecentlyReadFiles,
  restoreRecentFiles,
} from './fileRestore.js'
import { ensureMessageUuid } from '../session-memory/messageUuid.js'
import { sliceMessagesToKeep } from '../session-memory/keepIndex.js'
import { formatCompactSummaryMessage } from '../session-memory/prompts.js'
import { toolResultOutputToText } from '../../utils/tool-result-content.js'

export type { CompactEnrichment } from './post-compact-attachments.js'

// ── Prompt (analysis + summary) ─────────────────────────

// aggressive no-tools preamble FIRST. On adaptive-thinking models
// the summarizer sometimes attempts a tool call despite a weak instruction;
// being explicit about rejection consequences up front prevents a wasted turn.
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn -- you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`

// weaker reminder repeated at the very end as a trailer.
const NO_TOOLS_TRAILER =
  '\n\nREMINDER: Do NOT call any tools. Respond with plain text only -- ' +
  'an <analysis> block followed by a <summary> block. ' +
  'Tool calls will be rejected and you will fail the task.'

const BASE_COMPACT_PROMPT = `You are compacting an AI coding agent's conversation to save context space.

Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:
    - [Detailed non tool use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.`

/**
 * Assemble the summarizer system prompt:
 *   preamble + base + (optional "Additional Instructions") + trailer.
 *
 * `customInstructions` come from a manual `/compact <instructions>` invocation
 * (or a future PreCompact hook); when present they steer what the summary
 * focuses on (e.g. "focus on the test failures and the API changes").
 */
export function buildSummarySystem(customInstructions?: string): string {
  let prompt = NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT
  if (customInstructions && customInstructions.trim() !== '') {
    prompt += `\n\nAdditional Instructions:\n${customInstructions.trim()}`
  }
  prompt += NO_TOOLS_TRAILER
  return prompt
}

// ── File restoration config ─────────────────────────────

export interface FileRestoreConfig {
  maxFiles: number
  maxTokensPerFile: number
  totalBudget: number
}

// ── Public API ──────────────────────────────────────────

export interface CompactResult {
  messages: Message[]
  /** Raw summary text (without restored files/todos) -- for UI display. */
  summary: string
  summaryLength: number
  estimatedTokensAfter: number
  source: 'full'
  messagesToKeep: Message[]
}

export interface CompactContext {
  cwd: string
  todos: TodoItem[]
  fileRestore: FileRestoreConfig
  /** Optional steering text from a manual `/compact <instructions>` call. */
  instructions?: string
  /** Request-scoped provider; falls back to default provider when absent. */
  provider?: IProvider
  /** Re-inject agent/skill listings after full compact. */
  enrichment?: CompactEnrichment
  /**
   * Skip re-injecting recently-read file contents (aggressive/reactive
   * compaction -- the context just overflowed; don't re-inflate it).
   */
  skipFileRestore?: boolean
}

// MAX_PTL_RETRIES = 3. If the summarizer call itself overflows,
// drop the oldest API round and retry, up to this many times.
const MAX_SUMMARIZE_RETRIES = 3

/**
 * Drop the oldest "API round" from the message list for prompt-too-long recovery.
 *
 * Primary strategy: group by the assistant round `id` (the
 * provider's response id). The first round is everything up to and including
 * the messages sharing the first assistant id; we drop it and keep the rest.
 * This stays correct for long single-user-turn agentic sessions (where
 * user-boundary grouping would collapse to one round) AND never splits
 * parallel tool calls, since they share the same round id.
 *
 * Fallbacks when ids are unavailable (older sessions / non-streaming):
 *   - split on the next user-message boundary, else
 *   - drop the oldest ~30% of messages.
 */
function dropOldestApiRound(messages: Message[]): Message[] {
  // 1) id-based: find the first assistant id, then the first index whose round
  //    differs from it. Everything before that index is the oldest round.
  const firstId = firstAssistantRoundId(messages)
  if (firstId !== undefined) {
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      if (
        isRoleMessage(m) &&
        m.role === 'assistant' &&
        m.id !== undefined &&
        m.id !== firstId
      ) {
        return messages.slice(i)
      }
    }
    // Only one round carries an id -- fall through to coarser strategies.
  }

  // 2) user-boundary: drop up to the second user message.
  let firstUser = -1
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (isRoleMessage(m) && m.role === 'user') {
      firstUser = i
      break
    }
  }
  for (let i = firstUser + 1; i < messages.length; i++) {
    const m = messages[i]
    if (isRoleMessage(m) && m.role === 'user') {
      return messages.slice(i)
    }
  }

  // 3) blunt fallback: drop oldest ~30%.
  const at = Math.max(1, Math.floor(messages.length * 0.3))
  return messages.slice(at)
}

/** First assistant message's round id, or undefined if none carry one. */
function firstAssistantRoundId(messages: Message[]): string | undefined {
  for (const m of messages) {
    if (isRoleMessage(m) && m.role === 'assistant' && m.id !== undefined)
      return m.id
  }
  return undefined
}

/**
 * Summarize messages BEFORE keepStartIndex via LLM, then build:
 *   summaryMsg + messages[keepStartIndex…] + attachments
 *
 * When keepStartIndex is 0, summarizes nothing useful — caller should avoid that.
 * Returns null if summarization fails.
 */
export async function compactConversation(
  messages: Message[],
  model: string,
  ctx: CompactContext,
  keepStartIndex?: number,
): Promise<CompactResult | null> {
  if (messages.length < 2) return null

  const start =
    keepStartIndex === undefined
      ? messages.length
      : Math.max(0, Math.min(keepStartIndex, messages.length))

  // Head to summarize; tail to keep verbatim.
  let pending = messages.slice(0, start)
  const messagesToKeep = sliceMessagesToKeep(messages, start)

  // Need something to summarize; if head is tiny, summarize everything except keep.
  if (pending.length < 2 && messagesToKeep.length === 0) {
    pending = messages
  } else if (pending.length < 1) {
    // Nothing older than keep — still produce a minimal continue marker + keep.
    const summary =
      'Session compacted; recent messages preserved. Continue the current task.'
    clearTokenUsages(messages)
    const recentFiles = ctx.skipFileRestore
      ? []
      : extractRecentlyReadFiles(messages)
    const fileSection = restoreRecentFiles(recentFiles, ctx.cwd, ctx.fileRestore)
    const summaryMessages = buildPostCompactMessages(
      summary,
      fileSection,
      ctx.todos,
      true,
    )
    const attachmentMessages = ctx.enrichment
      ? await buildPostCompactAttachmentMessages(ctx.cwd, ctx.enrichment)
      : []
    const built = [
      ...summaryMessages,
      ...messagesToKeep,
      ...attachmentMessages,
    ]
    return {
      messages: built,
      summary,
      summaryLength: summary.length,
      estimatedTokensAfter: estimateConversationTokens(built),
      source: 'full',
      messagesToKeep,
    }
  }

  let summary: string | undefined

  for (let attempt = 0; attempt <= MAX_SUMMARIZE_RETRIES; attempt++) {
    const formatted = pending.map(formatForSummary).join('\n\n---\n\n')
    try {
      if (!ctx.provider) {
        throw new Error(
          'compactConversation requires a request-scoped provider',
        )
      }
      const provider = ctx.provider
      const result = await generateText({
        model: provider.chatModel(model),
        system: buildSummarySystem(ctx.instructions),
        messages: [
          {
            role: 'user',
            content: `Compact the following agent conversation into a structured summary:\n\n${formatted}`,
          },
        ],
      })
      summary = formatCompactSummary(result.text)
      break
    } catch (error) {
      if (attempt < MAX_SUMMARIZE_RETRIES && isLikelyTooLong(error)) {
        const before = pending.length
        pending = dropOldestApiRound(pending)
        if (pending.length === before || pending.length < 1) {
          throw error
        }
        console.warn(
          `[compact] PTL recovery: dropped oldest API round (${before} -> ${pending.length} msgs), retrying`,
        )
        continue
      }
      throw error
    }
  }

  if (!summary) return null

  clearTokenUsages(messages)

  const recentFiles = ctx.skipFileRestore
    ? []
    : extractRecentlyReadFiles(messages)
  const fileSection = restoreRecentFiles(recentFiles, ctx.cwd, ctx.fileRestore)
  const summaryMessages = buildPostCompactMessages(
    summary,
    fileSection,
    ctx.todos,
    messagesToKeep.length > 0,
  )
  const attachmentMessages = ctx.enrichment
    ? await buildPostCompactAttachmentMessages(ctx.cwd, ctx.enrichment)
    : []
  const built = [
    ...summaryMessages,
    ...messagesToKeep,
    ...attachmentMessages,
  ]

  return {
    messages: built,
    summary,
    summaryLength: summary.length,
    estimatedTokensAfter: estimateConversationTokens(built),
    source: 'full',
    messagesToKeep,
  }
}

// ── Post-compact message construction ───────────────────

function buildPostCompactMessages(
  summary: string,
  fileSection: string,
  todos: TodoItem[],
  recentMessagesPreserved: boolean,
): Message[] {
  let body = summary
  if (fileSection) {
    body += `\n\n${fileSection}`
  }
  if (todos.length > 0) {
    const todoLines = todos.map(t => `- [${t.status}] ${t.id}: ${t.content}`)
    body += `\n\n## Active Todo List\nUpdate via todo_write(merge=true) as you complete items:\n${todoLines.join('\n')}`
  }
  const content = formatCompactSummaryMessage(body, {
    recentMessagesPreserved,
  })
  return [
    ensureMessageUuid({
      role: 'user',
      content,
      isCompactSummary: true,
    }),
  ]
}

// ── Format compact summary (strip analysis scratchpad) ──

function formatCompactSummary(raw: string): string {
  let result = raw
  result = result.replace(/<analysis>[\s\S]*?<\/analysis>/, '')
  const summaryMatch = result.match(/<summary>([\s\S]*?)<\/summary>/)
  if (summaryMatch) {
    result = summaryMatch[1]!.trim()
  }
  result = result.replace(/\n\n\n+/g, '\n\n')
  return result.trim()
}

// ── Formatting helpers ──────────────────────────────────

function formatForSummary(msg: Message): string {
  if (isAttachmentMessage(msg)) {
    return `ATTACHMENT: ${msg.attachment.type}`
  }
  if (msg.role === 'user') {
    if (typeof msg.content === 'string') return `USER: ${msg.content}`
    const text = msg.content
      .map(p => (p.type === 'text' ? p.text : '[image]'))
      .filter(Boolean)
      .join('\n')
    return `USER: ${text}`
  }

  if (msg.role === 'assistant') {
    const formatted = msg.content
      .map(p => {
        if (p.type === 'text') return p.text
        if (p.type === 'reasoning') return ''
        if (p.type === 'tool-call') {
          const args = JSON.stringify(p.input || {})
          const short = args.length > 300 ? args.slice(0, 300) + '...' : args
          return `[Called ${p.toolName}(${short})]`
        }
        return ''
      })
      .filter(Boolean)
    return `ASSISTANT: ${formatted.join('\n')}`
  }

  return msg.content
    .map(p => {
      const text = toolResultOutputToText(p.output)
      const short = text.length > 500 ? text.slice(0, 500) + '...' : text
      return `[${p.toolName} result]: ${short}`
    })
    .join('\n')
}

function isLikelyTooLong(err: unknown): boolean {
  if (!err) return false
  const e = err as { statusCode?: number; status?: number; message?: string }
  const status = e.statusCode ?? e.status
  if (status === 413) return true
  const msg = (e.message ?? '').toLowerCase()
  return (
    msg.includes('context length') ||
    msg.includes('too long') ||
    msg.includes('token')
  )
}
