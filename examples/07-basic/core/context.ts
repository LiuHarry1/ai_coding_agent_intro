import { generateText } from 'ai'
import { configManager } from './config-manager.js'
import { defaultManager } from './provider-manager.js'
import type {
  AssistantMessage,
  IEventBus,
  Message,
  ToolMessage,
} from './types.js'

/**
 * Marker we leave in place of an old tool result's text content. The
 * tool_result block itself stays — removing it would orphan the matching
 * tool_call in the preceding assistant message and break API requests.
 */
const MICRO_COMPACT_MARKER = '[Old tool result content cleared to save context]'

/**
 * Marker for cleared tool_call inputs. The tool_call block (id + name)
 * stays so the matching tool_result still has something to pair with;
 * only the bulky `input` payload is replaced.
 */
const MICRO_COMPACT_INPUT_MARKER = {
  _cleared: true,
  note: 'Old tool input cleared to save context',
}

/**
 * Tools whose RESULT (output) is the bulk and is safe to clear once old.
 * The input (a path / query / command) stays — usually tiny and lets the
 * model see "what did I already look at / run".
 *
 *   [SHELL_TOOL_NAMES, GLOB, GREP, FILE_READ, WEB_FETCH, WEB_SEARCH]
 */
const CLEARABLE_TOOL_RESULTS = new Set<string>([
  'bash',
  'shell',
  'list_dir',
  'grep',
  'read_file',
  'web_fetch',
  'web_search',
])

/**
 * Tools whose INPUT (args) is the bulk and is safe to clear once old.
 * The side effect (file written, edit applied) is the durable state, so
 * the model doesn't need the verbatim args back. The result stays since
 * it's tiny ("wrote N bytes").
 *
 *   [FILE_EDIT, FILE_WRITE, NOTEBOOK_EDIT]
 *
 * NOTE: bash/shell are NOT here — their input is the small command, their
 * output is the bulk; they belong in CLEARABLE_TOOL_RESULTS.
 */
const CLEARABLE_TOOL_INPUTS = new Set<string>([
  'write_file',
  'edit_file',
  'create_file',
  'apply_patch',
  'notebook_edit',
])

function parseEnvInt(name: string, fallback: number): number {
  const v = process.env[name]
  if (v == null || v === '') return fallback
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

function getCompactionConfig() {
  const c = configManager.get('compaction')
  return {
    tokenThreshold: parseEnvInt('COMPACT_TOKEN_THRESHOLD', c.tokenThreshold),
    microCompactThreshold: parseEnvInt(
      'COMPACT_MICRO_THRESHOLD',
      c.microCompactThreshold,
    ),
    tailTokenBudget: parseEnvInt('COMPACT_TAIL_BUDGET', c.tailTokenBudget),
    microCompactKeepRecent: parseEnvInt(
      'COMPACT_MICRO_KEEP',
      c.microCompactKeepRecent,
    ),
    model: process.env.COMPACT_MODEL || c.model,
  }
}

const SUMMARY_SYSTEM = `You are compacting an AI coding agent's conversation to save context space.
Analyze the conversation and produce a structured working-state summary.

Required sections:

## Task
What the user asked for. 1-2 sentences.

## Completed Work
Bullet list of actions taken. Include specific file paths, function names, commands run.

## Current State
Is the task done? Tests passing? Errors outstanding? What was the last thing done?

## Key Files
Each file created or modified, with 1-line description of its role/contents.

## Pending Tasks
If a todo list / task checklist was created, list each item with its current status (pending/in_progress/completed/cancelled). Preserve the original IDs exactly.

## Important Decisions
Any non-obvious choices made, resolved errors, or constraints discovered.

Rules:
- Be SPECIFIC: include file paths, line counts, error messages, test results
- Focus on WHAT EXISTS NOW, not the history of how it got there
- Do NOT narrate the conversation ("first the agent did X, then Y")
- Include everything the agent needs to continue working without re-reading files`

// ── Token estimation ────────────────────────────────────

/**
 * Rough token estimate. ~4 chars/token is the canonical heuristic for
 * English; code skews shorter (3-3.5) so this slightly under-counts code,
 * but the conservative 4/3 padding in callers compensates.
 */
function estStr(s: string): number {
  return Math.ceil(s.length / 4)
}

const IMAGE_TOKEN_ESTIMATE = 1500

export function estimateMessageTokens(msg: Message): number {
  let total = 0
  if (msg.role === 'user') {
    if (typeof msg.content === 'string') return estStr(msg.content)
    for (const part of msg.content) {
      if (part.type === 'text') total += estStr(part.text)
      else if (part.type === 'image') total += IMAGE_TOKEN_ESTIMATE
    }
    return total
  }
  if (msg.role === 'assistant') {
    for (const part of msg.content) {
      if (part.type === 'text') total += estStr(part.text)
      else if (part.type === 'reasoning') total += estStr(part.text ?? '')
      else if (part.type === 'tool-call') {
        total +=
          estStr(part.toolName) + estStr(JSON.stringify(part.input ?? {}))
      }
    }
    return total
  }
  for (const part of msg.content) {
    const v = part.output?.value ?? ''
    total +=
      estStr(part.toolName) +
      estStr(typeof v === 'string' ? v : JSON.stringify(v))
  }
  return total
}

export function estimateConversationTokens(messages: Message[]): number {
  let t = 0
  for (const m of messages) t += estimateMessageTokens(m)
  return t
}

// ── Hybrid token counting ─────────────────────────────────

/**
 * Real usage we cache on the assistant message that ended each agent step.
 * Stored in a module-level WeakMap keyed by the message object — no field
 * pollution, automatic GC when the message is dropped, and safe across the
 * shallow message clones in `inlineReasoningAsText` (those clones never end
 * up in token-counting code, only in SDK requests).
 */
export interface AttachedTokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
  reasoningTokens?: number
}

const tokenUsageMap = new WeakMap<object, AttachedTokenUsage>()

export function attachTokenUsage(
  msg: Message,
  usage: AttachedTokenUsage,
): void {
  tokenUsageMap.set(msg, usage)
}

export function readTokenUsage(msg: Message): AttachedTokenUsage | undefined {
  return tokenUsageMap.get(msg)
}

/**
 * Drop cached usage for these messages. Called on the kept tail after a
 * full compaction — the cached baseline describes the pre-compact prefix
 * and would massively overstate the new context size, causing the next
 * step to erroneously trigger compaction again.
 */
function clearTokenUsages(messages: Message[]): void {
  for (const m of messages) tokenUsageMap.delete(m)
}

/**
 * Canonical "context size" from an attached usage record: prefer `totalTokens`
 * when the provider gave us one, otherwise sum the components we have.
 */
function tokenCountFromUsage(u: AttachedTokenUsage): number {
  if (typeof u.totalTokens === 'number' && u.totalTokens > 0)
    return u.totalTokens
  return (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
}

/**
 * The CANONICAL token-count function for threshold checks:
 *   1. Walk backward to the most recent assistant with cached usage.
 *   2. Use that real number as the baseline (it includes tokenizer-precise
 *      counts, tools schema, cache state — things estimation can't capture).
 *   3. Add a rough estimate ONLY for messages added after that point.
 *
 * Falls back to pure estimation when no usage is cached yet (cold start,
 * first turn before any API response has been recorded).
 */
export function tokenCountWithEstimation(messages: Message[]): {
  total: number
  source: 'real+est' | 'est'
  realBaseline?: number
  estimatedDelta?: number
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = readTokenUsage(messages[i])
    if (usage) {
      const realBaseline = tokenCountFromUsage(usage)
      let estimatedDelta = 0
      for (let j = i + 1; j < messages.length; j++) {
        estimatedDelta += estimateMessageTokens(messages[j])
      }
      return {
        total: realBaseline + estimatedDelta,
        source: 'real+est',
        realBaseline,
        estimatedDelta,
      }
    }
  }
  return {
    total: estimateConversationTokens(messages),
    source: 'est',
  }
}

// ── Micro-compaction (no LLM) ───────────────────────────

// Pre-computed once: the marker payloads and their estimated token cost.
// Used in the per-message hot loop in `microCompact` below.
const MARKER_RESULT_COST = estStr(MICRO_COMPACT_MARKER)
const MARKER_INPUT_JSON = JSON.stringify(MICRO_COMPACT_INPUT_MARKER)
const MARKER_INPUT_COST = estStr(MARKER_INPUT_JSON)

/**
 * Cheap, no-LLM compaction pass. For everything older than the most-recent
 * `keepRecent` tool messages:
 *   - clears the OUTPUT of `tool_result` blocks for read-only/scratch tools
 *     (see CLEARABLE_TOOL_RESULTS) — bash output, file reads, web fetches;
 *   - clears the INPUT of `tool-call` blocks for side-effecting tools (see
 *     CLEARABLE_TOOL_INPUTS) — write_file, edit_file, etc., where the args
 *     are the bulk and the side effect is the durable state.
 *
 * Both block types are PRESERVED (only their payloads are replaced) so the
 * tool_call ↔ tool_result pairing stays intact and the API request remains
 * well-formed.
 *
 * For long sessions dominated by big write_file / bash invocations, this
 * is usually enough to drop under the LLM-summarize threshold without
 * spending a model call.
 */
export function microCompact(
  messages: Message[],
  keepRecent: number,
): { messages: Message[]; tokensFreed: number; cleared: number } {
  const toolMsgIdx: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool') toolMsgIdx.push(i)
  }
  if (toolMsgIdx.length <= Math.max(0, keepRecent)) {
    return { messages, tokensFreed: 0, cleared: 0 }
  }

  const clearUpToExclusive = toolMsgIdx[toolMsgIdx.length - keepRecent - 1] + 1

  let tokensFreed = 0
  let cleared = 0

  const out = messages.map((m, i) => {
    if (i >= clearUpToExclusive) return m
    if (m.role === 'tool')
      return clearToolResults(
        m,
        () => cleared++,
        n => (tokensFreed += n),
      )
    if (m.role === 'assistant')
      return clearToolInputs(
        m,
        () => cleared++,
        n => (tokensFreed += n),
      )
    return m
  })
  return { messages: out, tokensFreed, cleared }
}

function clearToolResults(
  m: ToolMessage,
  bumpCleared: () => void,
  addFreed: (n: number) => void,
): ToolMessage {
  let touched = false
  const newContent = m.content.map(part => {
    if (!CLEARABLE_TOOL_RESULTS.has(part.toolName)) return part
    const v = part.output?.value ?? ''
    const text = typeof v === 'string' ? v : JSON.stringify(v)
    if (text === MICRO_COMPACT_MARKER) return part
    addFreed(Math.max(0, estStr(text) - MARKER_RESULT_COST))
    bumpCleared()
    touched = true
    return {
      ...part,
      output: { type: 'text' as const, value: MICRO_COMPACT_MARKER },
    }
  })
  return touched ? ({ ...m, content: newContent } as ToolMessage) : m
}

function clearToolInputs(
  m: AssistantMessage,
  bumpCleared: () => void,
  addFreed: (n: number) => void,
): AssistantMessage {
  let touched = false
  const newContent = m.content.map(part => {
    if (part.type !== 'tool-call') return part
    if (!CLEARABLE_TOOL_INPUTS.has(part.toolName)) return part
    const argsJson = JSON.stringify(part.input ?? {})
    if (argsJson === MARKER_INPUT_JSON) return part
    addFreed(Math.max(0, estStr(argsJson) - MARKER_INPUT_COST))
    bumpCleared()
    touched = true
    return { ...part, input: { ...MICRO_COMPACT_INPUT_MARKER } }
  })
  return touched ? ({ ...m, content: newContent } as AssistantMessage) : m
}

// ── Split-point selection ───────────────────────────────

/**
 * Walk backward from the end accumulating per-message tokens until we hit
 * `tailBudget`. Returns the index of the first message in the tail (i.e.
 * the split point so that `messages.slice(splitPoint)` is the tail).
 *
 * (apiMicrocompact.ts:17): "Keep last 40k tokens like client-side".
 */
function pickTailByTokenBudget(
  messages: Message[],
  tailBudget: number,
): number {
  let acc = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateMessageTokens(messages[i])
    if (acc >= tailBudget) return i
  }
  return 0
}

/**
 * Pick a clean boundary between summarize and keep portions so toKeep
 * doesn't start with an orphan tool_result. Walks BACKWARD from `desired`,
 * skipping any leading `tool` messages (i.e. moving them into toSummarize
 * along with their preceding assistant tool_call). This may make toKeep
 * larger than the desired token budget, but never strands an unmatched
 * tool_call/result pair across the split.
 *
 * An assistant message with a tool_call is fine as toKeep[0] — the
 * matching tool_result is also in toKeep (it follows immediately), so the
 * pair survives intact. The ONLY bad case is a tool message at toKeep[0]
 * because its assistant tool_call would be in toSummarize and gets
 * replaced by the summary.
 *
 * Returns -1 if no usable split exists (e.g. desired collapses to 0).
 */
function pickCleanSplitPoint(messages: Message[], desired: number): number {
  let p = Math.max(1, Math.min(desired, messages.length - 1))
  while (p > 0 && messages[p].role === 'tool') p--
  if (p <= 0) return -1
  return p
}

// ── Main entry ──────────────────────────────────────────

export interface CompactOptions {
  /** Run both passes regardless of the token threshold. */
  force?: boolean
  /**
   * Aggressive mode: keep only the most recent tool result and shrink the
   * preserved tail to ~5K tokens. Used by the reactive 413 fallback path
   * when the model rejected the previous request as too long.
   */
  aggressive?: boolean
}

export async function compactIfNeeded(
  messages: Message[],
  eventBus: IEventBus,
  opts: CompactOptions = {},
): Promise<Message[]> {
  const cfg = getCompactionConfig()
  const force = !!opts.force
  const aggressive = !!opts.aggressive

  if (messages.length === 0) return messages

  let tokens = tokenCountWithEstimation(messages).total

  // STEP 1 — cheap micro-compaction. Clears old tool_result/tool_input
  // *content* (not the blocks). 0 LLM calls.
  //
  // Trigger at min(microCompactThreshold, tokenThreshold): if the user
  // configured a full-summarize threshold *below* the micro threshold,
  // we still want micro to run as a free pre-pass before paying for the
  // LLM call — it might cut enough that summarize becomes unnecessary.
  let working = messages
  const microKeep = aggressive ? 1 : cfg.microCompactKeepRecent
  const microTrigger = Math.min(cfg.microCompactThreshold, cfg.tokenThreshold)
  const microThresholdMet = aggressive || force || tokens >= microTrigger
  if (microThresholdMet) {
    const r = microCompact(working, microKeep)
    // Always log so it's visible micro ran, even if it found nothing
    // clearable (e.g. a session full of mcp_* tools, which aren't on
    // the CLEARABLE_* whitelists).
    console.log(
      `[compaction] micro: cleared ${r.cleared} block(s), ~${r.tokensFreed} tokens freed` +
        (r.cleared === 0
          ? ' (nothing eligible — all tools outside CLEARABLE_* whitelists)'
          : ''),
    )
    if (r.cleared > 0) {
      eventBus.emit('compaction_micro', {
        cleared: r.cleared,
        tokensFreed: r.tokensFreed,
      })
      working = r.messages
      tokens = estimateConversationTokens(working)
    }
  }

  // STEP 2 — only run the expensive LLM summarization if micro wasn't enough.
  if (!force && !aggressive && tokens < cfg.tokenThreshold) {
    return working
  }

  // Aggressive mode preserves only the most recent ~5K tokens (just enough
  // for the model to see the last turn that triggered the 413). Normal
  // mode preserves the full configured tail budget.
  const tailBudget = aggressive ? 5_000 : cfg.tailTokenBudget
  const desired = pickTailByTokenBudget(working, tailBudget)
  const splitPoint = pickCleanSplitPoint(working, desired)
  if (splitPoint <= 1 || splitPoint >= working.length) {
    console.log(`[compaction] no clean split point — skipping LLM summarize`)
    return working
  }

  const toSummarize = working.slice(0, splitPoint)
  const toKeep = working.slice(splitPoint)

  console.log(
    `[compaction] LLM summarize: ${working.length} msgs / ~${tokens} tok → ` +
      `summarizing ${toSummarize.length}, keeping ${toKeep.length}` +
      (aggressive ? ' [aggressive]' : ''),
  )

  eventBus.emit('compaction_start', {
    totalMessages: working.length,
    summarizing: toSummarize.length,
    keeping: toKeep.length,
    estimatedTokens: tokens,
    aggressive,
  })

  const formatted = toSummarize.map(formatForSummary).join('\n\n---\n\n')

  let summary: string
  try {
    const provider = defaultManager.get()
    const result = await generateText({
      model: provider.chatModel(cfg.model),
      system: SUMMARY_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Compact the following agent conversation into a working-state summary:\n\n${formatted}`,
        },
      ],
    })
    summary = result.text
  } catch (error) {
    console.error(
      `[compaction] LLM summarize failed: ${(error as Error).message}`,
    )
    eventBus.emit('compaction_error', {
      error: (error as Error).message,
      message: 'Failed to summarize. Returning micro-compacted messages.',
    })
    // Even if summarize blew up, the micro-compact savings still apply.
    return working
  }

  console.log(`[compaction] summary done — ${summary.length} chars`)

  eventBus.emit('compaction_done', {
    summaryLength: summary.length,
    summary,
    estimatedTokensAfter: estStr(summary) + estimateConversationTokens(toKeep),
  })

  // Cached usages on toKeep describe the PRE-compact prefix and would
  // overstate post-compact context size by 3-4x — strip them so the next
  // step gets a fresh real baseline from the API response.
  clearTokenUsages(toKeep)

  return buildPostCompactMessages(summary, toKeep)
}

/**
 * Stitch [summary, optional ack, ...toKeep]. The ack is only inserted when
 * toKeep[0] is a user message — Anthropic requires strict user/assistant
 * alternation, so summary(user) → user(toKeep[0]) would 400 without it.
 */
function buildPostCompactMessages(
  summary: string,
  toKeep: Message[],
): Message[] {
  const out: Message[] = [
    {
      role: 'user',
      content: `[Previous work summary — refer to this for context]\n\n${summary}`,
    },
  ]
  if (toKeep[0]?.role === 'user') {
    out.push({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: "I have the context from the summary. I'll continue working on the task.",
        },
      ],
    })
  }
  out.push(...toKeep)
  return out
}

// ── Reactive 413 / context-length detection ─────────────

/**
 * Heuristic: did this error come from the model rejecting the prompt as
 * too long? Covers OpenAI (`context_length_exceeded`), Anthropic (413 +
 * "prompt is too long"), Gemini ("token count exceeds"), and a few proxy
 * variants. Cheap pattern match — false positives just waste one extra
 * compaction (cheaper than a hung session).
 */
export function isContextLengthError(err: unknown): boolean {
  if (!err) return false
  const e = err as {
    statusCode?: number
    status?: number
    message?: string
    cause?: { message?: string }
  }
  const status = e.statusCode ?? e.status
  if (status === 413) return true
  const msg = ((e.message ?? '') + ' ' + (e.cause?.message ?? '')).toLowerCase()
  return (
    msg.includes('context length') ||
    msg.includes('context_length') ||
    msg.includes('context window') ||
    msg.includes('prompt is too long') ||
    msg.includes('prompt too long') ||
    msg.includes('maximum context') ||
    msg.includes('too many tokens') ||
    msg.includes('token count exceeds') ||
    msg.includes('token limit')
  )
}

/**
 * Heuristic: did the request fail because the upstream socket was closed
 * mid-flight (proxy timeout, ECONNRESET, undici "terminated", flaky 5xx)?
 * Distinct from context-length errors — for these the right move is just
 * to retry the same request, not to compact.
 */
export function isTransientStreamError(err: unknown): boolean {
  if (!err) return false
  const e = err as {
    statusCode?: number
    status?: number
    code?: string
    message?: string
    cause?: { message?: string; code?: string }
  }
  const status = e.statusCode ?? e.status
  if (status === 502 || status === 503 || status === 504) return true
  const code = e.code ?? e.cause?.code ?? ''
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE' ||
    code === 'UND_ERR_SOCKET'
  ) {
    return true
  }
  const msg = ((e.message ?? '') + ' ' + (e.cause?.message ?? '')).toLowerCase()
  return (
    msg.includes('terminated') ||
    msg.includes('other side closed') ||
    msg.includes('socket hang up') ||
    msg.includes('connection reset') ||
    msg.includes('network error') ||
    msg.includes('fetch failed') ||
    msg.includes('no output generated') // AI SDK: stream closed before any chunk
  )
}

// ── Formatting for summary ──────────────────────────────

function formatForSummary(msg: Message): string {
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
      const v = p.output?.value ?? ''
      const text = typeof v === 'string' ? v : JSON.stringify(v)
      const short = text.length > 500 ? text.slice(0, 500) + '...' : text
      return `[${p.toolName} result]: ${short}`
    })
    .join('\n')
}
