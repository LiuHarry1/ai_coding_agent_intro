/**
 * Token estimation and hybrid counting for compaction threshold decisions.
 * Canonical "context size" measurement.
 */
import type { Message } from '../../core/types.js'
import { isAttachmentMessage, isRoleMessage } from '../../core/types.js'
import {
  countOutputImages,
  toolResultOutputToText,
} from '../../utils/tool-result-content.js'

// ── Pure estimation ─────────────────────────────────────

function estStr(s: string): number {
  return Math.ceil(s.length / 4)
}

const IMAGE_TOKEN_ESTIMATE = 1500

export function estimateMessageTokens(msg: Message): number {
  if (isAttachmentMessage(msg)) {
    return Math.ceil(JSON.stringify(msg.attachment).length / 4)
  }
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
    total +=
      estStr(part.toolName) +
      estStr(toolResultOutputToText(part.output)) +
      countOutputImages(part.output) * IMAGE_TOKEN_ESTIMATE
  }
  return total
}

export function estimateConversationTokens(messages: Message[]): number {
  let t = 0
  for (const m of messages) t += estimateMessageTokens(m)
  return t
}

// ── Attached token usage (WeakMap storage) ──────────────

export interface AttachedTokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
  reasoningTokens?: number
}

const tokenUsageMap = new WeakMap<object, AttachedTokenUsage>()

/**
 * Attach usage BOTH to the WeakMap (fast path, identity-keyed) and onto the
 * message record itself so it persists to JSONL and survives
 * session restore / server restart.
 */
export function attachTokenUsage(
  msg: Message,
  usage: AttachedTokenUsage,
): void {
  tokenUsageMap.set(msg, usage)
  if (isRoleMessage(msg) && msg.role === 'assistant') {
    msg.usage = usage
  }
}

export function readTokenUsage(msg: Message): AttachedTokenUsage | undefined {
  const fromMap = tokenUsageMap.get(msg)
  if (fromMap) return fromMap
  // Restored-from-disk messages carry usage on the record itself.
  if (isRoleMessage(msg) && msg.role === 'assistant' && msg.usage) {
    return msg.usage
  }
  return undefined
}

export function clearTokenUsages(messages: Message[]): void {
  for (const m of messages) {
    tokenUsageMap.delete(m)
    if (isRoleMessage(m) && m.role === 'assistant' && m.usage) {
      delete m.usage
    }
  }
}

/**
 * Full context size from usage (input + cache
 * creation/read + output). Provider quirk handled defensively:
 *   - Anthropic-style: inputTokens EXCLUDES cache reads → cached must be added.
 *   - OpenAI-compatible-style: prompt_tokens INCLUDES cached_tokens → adding
 *     would double-count.
 * Heuristic: cached > input can only happen when they're disjoint counters,
 * so add; otherwise assume cached ⊆ input. Also never trust a `totalTokens`
 * smaller than the parts we can see.
 */
function tokenCountFromUsage(u: AttachedTokenUsage): number {
  const input = u.inputTokens ?? 0
  const output = u.outputTokens ?? 0
  const cached = u.cachedInputTokens ?? 0
  const inputWithCache = cached > input ? input + cached : input
  const fromParts = inputWithCache + output
  const total = typeof u.totalTokens === 'number' ? u.totalTokens : 0
  return Math.max(total, fromParts)
}

// ── Hybrid counting (real + estimate) ───────────────────

/**
 * Conservative padding applied to chars/4 estimates in threshold decisions
 * ("Pad estimate by 4/3 to be conservative since we're
 * approximating"). Matters a lot for CJK-heavy conversations where the real
 * ratio is closer to 1 token/char — unpadded chars/4 undercounts ~4x and
 * lets the context blow past the real window before compaction triggers.
 */
const ESTIMATE_PAD = 4 / 3

function padEstimate(tokens: number): number {
  return Math.ceil(tokens * ESTIMATE_PAD)
}

/**
 * Canonical token-count for threshold checks:
 *   1. Walk backward to the most recent assistant with cached usage.
 *   2. Handle parallel tool calls: if multiple assistant messages share
 *      the same step (consecutive assistants before the next user msg),
 *      anchor at the first one so interleaved tool_results are estimated.
 *   3. Use real usage as baseline, add rough estimate for messages after.
 */
export function tokenCountWithEstimation(messages: Message[]): {
  total: number
  source: 'real+est' | 'est'
  realBaseline?: number
  estimatedDelta?: number
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = readTokenUsage(messages[i])
    if (!usage) continue

    // Walk back past sibling assistant messages from the same API round
    // (parallel tool calls produce multiple assistant records with usage
    // on only the last one; interleaved tool_results between them must
    // be included in the estimate).
    //
    // When the usage-bearing assistant carries a round `id`, group
    // only same-id siblings (the true parallel-tool group) and stop at the
    // previous round. Without an id (older sessions), fall back to the
    // heuristic of "all assistants since the last user message".
    const usageMsg = messages[i]
    const usageRoundId =
      isRoleMessage(usageMsg) && usageMsg.role === 'assistant'
        ? usageMsg.id
        : undefined
    let anchor = i
    for (let j = i - 1; j >= 0; j--) {
      const mj = messages[j]
      if (isRoleMessage(mj) && mj.role === 'user') {
        break
      }
      if (isRoleMessage(mj) && mj.role === 'assistant') {
        if (usageRoundId !== undefined) {
          if (mj.id === usageRoundId) anchor = j
          else break // previous API round — don't fold it in
        } else {
          anchor = j
        }
      }
      // tool messages between assistants: keep walking
    }

    const realBaseline = tokenCountFromUsage(usage)
    let estimatedDelta = 0
    for (let j = anchor + 1; j < messages.length; j++) {
      if (j === i) continue // skip the usage-bearing message itself
      estimatedDelta += estimateMessageTokens(messages[j])
    }
    estimatedDelta = padEstimate(estimatedDelta)
    return {
      total: realBaseline + estimatedDelta,
      source: 'real+est',
      realBaseline,
      estimatedDelta,
    }
  }
  return {
    total: padEstimate(estimateConversationTokens(messages)),
    source: 'est',
  }
}
