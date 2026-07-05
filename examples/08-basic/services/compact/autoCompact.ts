/**
 * Auto-compact orchestrator: dynamic threshold, circuit breaker, config,
 * and the main compactIfNeeded entry point.
 */
import type {
  CompactionConfig,
  IEventBus,
  IProvider,
  Message,
  TodoItem,
} from '../../core/types.js'
import { isRoleMessage } from '../../core/types.js'
import { DEFAULTS } from '../../core/settings-manager.js'
import {
  tokenCountWithEstimation,
  estimateConversationTokens,
} from './tokens.js'
import { microCompact } from './microCompact.js'
import { compactConversation } from './compact.js'
import type { CompactContext } from './compact.js'

// ── Threshold constants ─────────────────────────────────

const RESERVED_FOR_OUTPUT = 20_000
const AUTOCOMPACT_BUFFER = 13_000
const MICRO_COMPACT_HEADSTART = 27_000
const WARNING_BUFFER = 20_000
// CC parity: hard limit = effectiveWindow - 3_000 (MANUAL_COMPACT_BUFFER).
// Past this point even a manual compact can't reliably fit, so the loop
// should refuse to grow context further. We surface it via an event.
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

/**
 * CC parity (tengu_slate_heron): the prompt cache has almost certainly expired
 * once the gap since the last assistant message exceeds the TTL, so the prefix
 * will be rewritten regardless. Clearing old tool payloads (content-mutating
 * micro) before the next request shrinks what gets rewritten — and only does
 * so when the mutation is "free" (cache already cold).
 *
 * Returns true when the time-based trigger should fire.
 */
function shouldTimeBasedMicro(
  messages: Message[],
  enabled: boolean,
  gapMinutes: number,
): boolean {
  if (!enabled) return false
  let lastTs: number | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (isRoleMessage(m) && m.role === 'assistant' && typeof m.timestamp === 'number') {
      lastTs = m.timestamp
      break
    }
  }
  if (lastTs === undefined) return false
  const gap = (Date.now() - lastTs) / 60_000
  return Number.isFinite(gap) && gap >= gapMinutes
}

/**
 * Tokens reserved for the model's output during compaction.
 * CC parity: `min(model max output, 20_000)`. When the model's max output is
 * unknown (maxOutputTokens unset) we fall back to the full 20_000 reserve.
 */
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

/**
 * Compute the auto-compact threshold dynamically from the context window.
 * Formula: effectiveWindow - buffer  (effectiveWindow = contextWindow - reservedForOutput)
 * For 200K: 200K - 20K - 13K = 167K
 */
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

/**
 * CC parity: the blocking limit is effectiveWindow - 3_000. Crossing it means
 * context is effectively unrecoverable for the next request.
 */
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
}

/**
 * Main compaction entry point. Called before each agent step.
 *
 * Flow:
 *   1. Check enabled + circuit breaker
 *   2. Emit warning if approaching threshold
 *   3. Micro-compact (clear old tool payloads, no LLM)
 *   4. If still over threshold → full LLM summarization of ALL messages
 *   5. Post-compact: re-inject files, todos, skill refs
 */
export async function compactIfNeeded(
  messages: Message[],
  eventBus: IEventBus,
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

  if (messages.length === 0) return messages

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

  // Emit warning when approaching threshold
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

  // CC parity: surface the hard blocking limit. Context past this point can't
  // be reliably recovered by compaction; the host loop should stop growing it.
  if (tokens >= blockingLimit) {
    eventBus.emit('compaction_blocking', {
      currentTokens: tokens,
      blockingLimit,
    })
  }

  // STEP 1 — micro-compaction (pre-pass to reduce summarizer input)
  let working = messages
  const microKeep = aggressive ? 1 : cfg.microCompactKeepRecent
  // Time-based trigger fires regardless of token pressure: when the cache is
  // cold (gap > TTL) the prefix is rewritten anyway, so clear old payloads now.
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
      `[compact] micro-compact START — msgs=${working.length}, tokens≈${tokens.toLocaleString()}, ` +
        `microThreshold=${microThreshold.toLocaleString()}, keepRecent=${microKeep}` +
        (aggressive ? ', aggressive' : '') +
        (force ? ', force' : '') +
        (timeBased
          ? `, time-based(gap>${cfg.timeBasedMicroGapMinutes}min)`
          : ''),
    )
    const tokensBeforeMicro = tokens
    const r = microCompact(working, microKeep, sessionId)
    tokens = estimateConversationTokens(r.messages)
    if (r.cleared > 0) {
      eventBus.emit('compaction_micro', {
        cleared: r.cleared,
        tokensFreed: r.tokensFreed,
      })
      working = r.messages
    }
    console.log(
      `[compact] micro-compact DONE — cleared=${r.cleared}, freed≈${r.tokensFreed.toLocaleString()} tokens, ` +
        `tokens ${tokensBeforeMicro.toLocaleString()} → ${tokens.toLocaleString()}, msgs=${working.length}`,
    )
  }

  // STEP 2 — full LLM summarization (summarize ALL, no tail)
  if (!force && !aggressive && tokens < threshold) {
    return working
  }

  const msgsBeforeFull = working.length
  const tokensBeforeFull = tokens
  console.log(
    `[compact] full-compact START — msgs=${msgsBeforeFull}, tokens≈${tokensBeforeFull.toLocaleString()}, ` +
      `fullThreshold=${threshold.toLocaleString()}` +
      (aggressive ? ', aggressive' : '') +
      (force ? ', force' : ''),
  )

  eventBus.emit('compaction_start', {
    totalMessages: working.length,
    // Full compaction collapses the whole history into a single summary
    // message, so exactly one message remains afterwards.
    keeping: 1,
    estimatedTokens: tokens,
    aggressive,
  })

  const ctx: CompactContext = {
    cwd,
    todos: currentTodos,
    fileRestore: {
      maxFiles: cfg.maxFilesToRestore,
      maxTokensPerFile: cfg.maxTokensPerFile,
      totalBudget: cfg.fileBudget,
    },
    instructions: opts.instructions,
    provider,
  }

  try {
    const result = await compactConversation(working, mainModel, ctx)
    if (!result) {
      console.log(
        `[compact] full-compact DONE — no change (summarizer returned empty), ` +
          `msgs=${msgsBeforeFull}, tokens≈${tokensBeforeFull.toLocaleString()}`,
      )
      return working
    }

    consecutiveFailures = 0
    eventBus.emit('compaction_done', {
      summary: result.summary,
      summaryLength: result.summaryLength,
      estimatedTokensAfter: result.estimatedTokensAfter,
      messagesBefore: msgsBeforeFull,
    })
    console.log(
      `[compact] full-compact DONE — msgs ${msgsBeforeFull} → ${result.messages.length}, ` +
        `tokens≈${tokensBeforeFull.toLocaleString()} → ${result.estimatedTokensAfter.toLocaleString()}, ` +
        `summaryChars=${result.summaryLength.toLocaleString()}`,
    )
    return result.messages
  } catch (error) {
    consecutiveFailures++
    const msg = error instanceof Error ? error.message : String(error)
    console.error(
      `[compact] full-compact FAILED — msgs=${msgsBeforeFull}, tokens≈${tokensBeforeFull.toLocaleString()}: ${msg}`,
    )
    eventBus.emit('compaction_error', { error: msg })
    return working
  }
}
