/**
 * Auto-compact orchestrator: dynamic threshold, circuit breaker, config,
 * and the main compactIfNeeded entry point.
 *
 * Order after micro: wait session-memory extraction → try SM compact →
 * else full LLM compact. Both produce summary + messagesToKeep + attachments.
 */
import type {
  CompactionConfig,
  IEventBus,
  IProvider,
  Message,
  SessionMemoryConfig,
  TodoItem,
} from '../../core/types.js'
import type { WireEmitter } from '../../core/wire-emitter.js'
import { isRoleMessage } from '../../core/types.js'
import { DEFAULTS } from '../../core/settings-manager.js'
import type { ReadFileState } from '../../utils/attachments/types.js'
import { clearReadFileState } from '../../utils/read/read-file-state.js'
import { tokenCountWithEstimation } from './tokens.js'
import { microCompact } from './microCompact.js'
import {
  compactConversation,
  type CompactContext,
  type CompactEnrichment,
} from './compact.js'
import { buildPostCompactAttachmentMessages } from './post-compact-attachments.js'
import {
  extractRecentlyReadFiles,
  restoreRecentFiles,
} from './fileRestore.js'
import {
  calculateMessagesToKeepIndex,
  clearLastSummarizedMessageId,
  ensureMessageUuids,
  trySessionMemoryCompaction,
} from '../session-memory/index.js'

// ── Threshold constants ─────────────────────────────────

const RESERVED_FOR_OUTPUT = 20_000
const AUTOCOMPACT_BUFFER = 13_000
const MICRO_COMPACT_HEADSTART = 27_000
const WARNING_BUFFER = 20_000
const MANUAL_COMPACT_BUFFER = 3_000

// ── Config ──────────────────────────────────────────────

function parseEnvInt(name: string, fallback: number): number {
  const v = process.env[name]
  if (v == null || v === '') return fallback
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

function getCompactionConfig(base?: CompactionConfig) {
  const c = base ?? DEFAULTS.compaction
  return {
    enabled:
      process.env.DISABLE_AUTO_COMPACT === '1'
        ? false
        : process.env.DISABLE_COMPACT === '1'
          ? false
          : c.enabled,
    contextWindow: parseEnvInt('COMPACT_CONTEXT_WINDOW', c.contextWindow),
    microCompactKeepRecent: parseEnvInt(
      'COMPACT_MICRO_KEEP',
      c.microCompactKeepRecent,
    ),
    maxFilesToRestore: c.maxFilesToRestore,
    maxTokensPerFile: c.maxTokensPerFile,
    fileBudget: c.fileBudget,
    maxOutputTokens: c.maxOutputTokens,
    timeBasedMicroEnabled:
      process.env.DISABLE_TIME_BASED_MICRO === '1'
        ? false
        : !!c.timeBasedMicroEnabled,
    timeBasedMicroGapMinutes: parseEnvInt(
      'COMPACT_TIME_GAP_MIN',
      c.timeBasedMicroGapMinutes ?? 5,
    ),
  }
}

function shouldTimeBasedMicro(
  messages: Message[],
  enabled: boolean,
  gapMinutes: number,
): boolean {
  if (!enabled) return false
  let lastTs: number | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (
      isRoleMessage(m) &&
      m.role === 'assistant' &&
      typeof m.timestamp === 'number'
    ) {
      lastTs = m.timestamp
      break
    }
  }
  if (lastTs === undefined) return false
  const gap = (Date.now() - lastTs) / 60_000
  return Number.isFinite(gap) && gap >= gapMinutes
}

function getReservedForOutput(maxOutputTokens?: number): number {
  if (typeof maxOutputTokens === 'number' && maxOutputTokens > 0) {
    return Math.min(maxOutputTokens, RESERVED_FOR_OUTPUT)
  }
  return RESERVED_FOR_OUTPUT
}

function getEffectiveContextWindow(
  contextWindow: number,
  maxOutputTokens?: number,
): number {
  return contextWindow - getReservedForOutput(maxOutputTokens)
}

function getAutoCompactThreshold(
  contextWindow: number,
  maxOutputTokens?: number,
): number {
  const override = parseEnvInt('COMPACT_THRESHOLD_OVERRIDE', -1)
  if (override > 0) return override
  return (
    getEffectiveContextWindow(contextWindow, maxOutputTokens) -
    AUTOCOMPACT_BUFFER
  )
}

function getMicroCompactThreshold(autoCompactThreshold: number): number {
  return autoCompactThreshold - MICRO_COMPACT_HEADSTART
}

function getBlockingLimit(
  contextWindow: number,
  maxOutputTokens?: number,
): number {
  return (
    getEffectiveContextWindow(contextWindow, maxOutputTokens) -
    MANUAL_COMPACT_BUFFER
  )
}

// ── Circuit breaker ─────────────────────────────────────

const MAX_CONSECUTIVE_FAILURES = 3
let consecutiveFailures = 0

export function resetCompactionFailures(): void {
  consecutiveFailures = 0
}

// ── Public entry ────────────────────────────────────────

export interface CompactOptions {
  force?: boolean
  aggressive?: boolean
  /** Steering text for a manual `/compact <instructions>` summarization. */
  instructions?: string
  /** Re-announce agent/skill listings after full compact. */
  enrichment?: CompactEnrichment
  /** Session-memory config; when set, prefer SM compact before full LLM. */
  sessionMemory?: SessionMemoryConfig
  /** Session Read cache — invalidated when Read tool_results are micro-cleared / full-compacted. */
  readFileState?: ReadFileState
}

/**
 * Main compaction entry point. Called before each agent step.
 *
 * Flow:
 *   1. Check enabled + circuit breaker
 *   2. Emit warning if approaching threshold
 *   3. Micro-compact (clear old tool payloads, no LLM)
 *   4. If still over threshold -> session-memory compact, else full LLM
 *   5. Post-compact: re-inject files, todos, skill refs (both paths)
 */
export async function compactIfNeeded(
  messages: Message[],
  eventBus: IEventBus,
  wire: WireEmitter,
  mainModel: string,
  cwd: string,
  currentTodos: TodoItem[],
  opts: CompactOptions = {},
  compaction?: CompactionConfig,
  provider?: IProvider,
  sessionId?: string,
): Promise<Message[]> {
  const cfg = getCompactionConfig(compaction)
  const force = !!opts.force
  const aggressive = !!opts.aggressive
  const smConfig = opts.sessionMemory ?? DEFAULTS.sessionMemory

  if (messages.length === 0) return messages
  ensureMessageUuids(messages)

  if (!force && !aggressive && !cfg.enabled) {
    return messages
  }

  if (!force && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return messages
  }

  const threshold = getAutoCompactThreshold(
    cfg.contextWindow,
    cfg.maxOutputTokens,
  )
  const microThreshold = getMicroCompactThreshold(threshold)
  const blockingLimit = getBlockingLimit(cfg.contextWindow, cfg.maxOutputTokens)
  let tokens = tokenCountWithEstimation(messages).total

  if (
    tokens >= threshold - WARNING_BUFFER &&
    tokens < threshold &&
    !force &&
    !aggressive
  ) {
    eventBus.emit('compaction_warning', {
      currentTokens: tokens,
      threshold,
      percentLeft: Math.max(
        0,
        Math.round(((threshold - tokens) / threshold) * 100),
      ),
    })
  }

  if (tokens >= blockingLimit) {
    eventBus.emit('compaction_blocking', {
      currentTokens: tokens,
      blockingLimit,
    })
  }

  // STEP 1 -- micro-compaction
  let working = messages
  const microKeep = aggressive ? 1 : cfg.microCompactKeepRecent
  const timeBased =
    !aggressive &&
    !force &&
    shouldTimeBasedMicro(
      messages,
      cfg.timeBasedMicroEnabled,
      cfg.timeBasedMicroGapMinutes,
    )
  const shouldMicro =
    aggressive || force || tokens >= microThreshold || timeBased
  if (shouldMicro) {
    console.log(
      `[compact] micro-compact START -- msgs=${working.length}, tokens~${tokens.toLocaleString()}, ` +
        `microThreshold=${microThreshold.toLocaleString()}, keepRecent=${microKeep}` +
        (aggressive ? ', aggressive' : '') +
        (force ? ', force' : '') +
        (timeBased
          ? `, time-based(gap>${cfg.timeBasedMicroGapMinutes}min)`
          : ''),
    )
    const tokensBeforeMicro = tokens
    const r = microCompact(working, microKeep, sessionId, {
      cwd,
      readFileState: opts.readFileState,
    })
    tokens = Math.max(0, tokensBeforeMicro - r.tokensFreed)
    if (r.cleared > 0) {
      eventBus.emit('compaction_micro', {
        cleared: r.cleared,
        tokensFreed: r.tokensFreed,
      })
      working = r.messages
    }
    console.log(
      `[compact] micro-compact DONE -- cleared=${r.cleared}, freed~${r.tokensFreed.toLocaleString()} tokens, ` +
        `tokens ${tokensBeforeMicro.toLocaleString()} -> ${tokens.toLocaleString()}, msgs=${working.length}`,
    )
  }

  // STEP 2 -- SM or full summarization
  if (!force && !aggressive && tokens < threshold) {
    return working
  }

  const msgsBeforeFull = working.length
  const tokensBeforeFull = tokens
  console.log(
    `[compact] compact START -- msgs=${msgsBeforeFull}, tokens~${tokensBeforeFull.toLocaleString()}, ` +
      `fullThreshold=${threshold.toLocaleString()}` +
      (aggressive ? ', aggressive' : '') +
      (force ? ', force' : ''),
  )

  eventBus.emit('compaction_start', {
    totalMessages: working.length,
    keeping: 1,
    estimatedTokens: tokens,
    aggressive,
  })
  wire.compactionStart({
    messages_before: working.length,
    tokens_before: tokens,
  })

  const fileRestore = {
    maxFiles: cfg.maxFilesToRestore,
    maxTokensPerFile: cfg.maxTokensPerFile,
    totalBudget: cfg.fileBudget,
  }
  const skipFileRestore = aggressive
  const fileSection = skipFileRestore
    ? ''
    : restoreRecentFiles(
        extractRecentlyReadFiles(working),
        cwd,
        fileRestore,
      )

  const attachmentMessages = opts.enrichment
    ? await buildPostCompactAttachmentMessages(cwd, opts.enrichment)
    : []

  // Prefer session-memory notes unless the user steered summarization.
  const preferSm =
    !!sessionId && smConfig.enabled && !opts.instructions?.trim()

  if (preferSm) {
    try {
      const sm = await trySessionMemoryCompaction({
        messages: working,
        sessionId,
        config: smConfig,
        autoCompactThreshold: force || aggressive ? undefined : threshold,
        attachmentMessages,
        todos: currentTodos,
        fileSection,
        estimateTokens: msgs => tokenCountWithEstimation(msgs).total,
      })
      if (sm) {
        consecutiveFailures = 0
        clearLastSummarizedMessageId(sessionId)
        clearReadFileState(opts.readFileState)
        eventBus.emit('compaction_done', {
          summary: sm.summaryText,
          summaryLength: sm.summaryText.length,
          estimatedTokensAfter: tokenCountWithEstimation(sm.messages).total,
          messagesBefore: msgsBeforeFull,
          source: 'session_memory',
        })
        const tokensAfter = tokenCountWithEstimation(sm.messages).total
        wire.compactionDone({
          status: 'ok',
          messages_after: sm.messages.length,
          tokens_after: tokensAfter,
        })
        console.log(
          `[compact] session-memory compact DONE -- msgs ${msgsBeforeFull} -> ${sm.messages.length}, ` +
            `tokens~${tokensBeforeFull.toLocaleString()} -> ${tokensAfter.toLocaleString()}, ` +
            `kept=${sm.messagesToKeep.length}`,
        )
        return sm.messages
      }
      console.log(
        `[compact] session-memory compact skipped -- falling back to full LLM`,
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[compact] session-memory compact error: ${msg}`)
    }
  }

  const ctx: CompactContext = {
    cwd,
    todos: currentTodos,
    fileRestore,
    instructions: opts.instructions,
    provider,
    enrichment: opts.enrichment,
    skipFileRestore,
  }

  // Compute keep boundary from end (SM miss / no cursor — expand for mins).
  let keepStart = calculateMessagesToKeepIndex(working, undefined, {
    minTokens: smConfig.compactMinTokens,
    maxTokens: smConfig.compactMaxTokens,
    minTextMessages: smConfig.compactMinTextMessages,
  })
  if (keepStart < 0) keepStart = 0

  try {
    const result = await compactConversation(
      working,
      mainModel,
      ctx,
      keepStart,
    )
    if (!result) {
      console.log(
        `[compact] full-compact DONE -- no change (summarizer returned empty), ` +
          `msgs=${msgsBeforeFull}, tokens~${tokensBeforeFull.toLocaleString()}`,
      )
      wire.compactionDone({ status: 'noop' })
      return working
    }

    consecutiveFailures = 0
    if (sessionId) clearLastSummarizedMessageId(sessionId)
    clearReadFileState(opts.readFileState)
    eventBus.emit('compaction_done', {
      summary: result.summary,
      summaryLength: result.summaryLength,
      estimatedTokensAfter: result.estimatedTokensAfter,
      messagesBefore: msgsBeforeFull,
      source: 'full',
    })
    wire.compactionDone({
      status: 'ok',
      messages_after: result.messages.length,
      tokens_after: result.estimatedTokensAfter,
    })
    const willRetriggerNextTurn = result.estimatedTokensAfter >= threshold
    if (willRetriggerNextTurn) {
      console.warn(
        `[compact] WARNING: post-compact context (~${result.estimatedTokensAfter.toLocaleString()} tokens) ` +
          `still >= threshold (${threshold.toLocaleString()}) -- compaction will re-trigger next turn. ` +
          `Check contextWindow config, file restore budget, and oversized tool results.`,
      )
      eventBus.emit('compaction_will_retrigger', {
        tokensAfter: result.estimatedTokensAfter,
        threshold,
      })
    }
    console.log(
      `[compact] full-compact DONE -- msgs ${msgsBeforeFull} -> ${result.messages.length}, ` +
        `tokens~${tokensBeforeFull.toLocaleString()} -> ${result.estimatedTokensAfter.toLocaleString()}, ` +
        `summaryChars=${result.summaryLength.toLocaleString()}, kept=${result.messagesToKeep.length}` +
        (willRetriggerNextTurn ? ', WILL-RETRIGGER' : ''),
    )
    return result.messages
  } catch (error) {
    consecutiveFailures++
    const msg = error instanceof Error ? error.message : String(error)
    console.error(
      `[compact] full-compact FAILED -- msgs=${msgsBeforeFull}, tokens~${tokensBeforeFull.toLocaleString()}: ${msg}`,
    )
    eventBus.emit('compaction_error', { error: msg })
    wire.compactionDone({ status: 'error' })
    return working
  }
}
