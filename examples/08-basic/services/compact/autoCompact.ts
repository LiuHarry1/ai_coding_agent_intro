/**
 * Auto-compact orchestrator: dynamic threshold, circuit breaker, config,
 * and the main compactIfNeeded entry point.
 */
import { configManager } from "../../core/config-manager.js";
import type { IEventBus, Message, TodoItem } from "../../core/types.js";
import { tokenCountWithEstimation, estimateConversationTokens } from "./tokens.js";
import { microCompact } from "./microCompact.js";
import { compactConversation } from "./compact.js";
import type { CompactContext } from "./compact.js";

// ── Threshold constants ─────────────────────────────────

const RESERVED_FOR_OUTPUT = 20_000;
const AUTOCOMPACT_BUFFER = 13_000;
const MICRO_COMPACT_HEADSTART = 27_000;
const WARNING_BUFFER = 20_000;

// ── Config ──────────────────────────────────────────────

function parseEnvInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function getCompactionConfig() {
  const c = configManager.get("compaction");
  return {
    enabled:
      process.env.DISABLE_AUTO_COMPACT === "1" ? false :
      process.env.DISABLE_COMPACT === "1" ? false :
      c.enabled,
    contextWindow: parseEnvInt("COMPACT_CONTEXT_WINDOW", c.contextWindow),
    microCompactKeepRecent: parseEnvInt("COMPACT_MICRO_KEEP", c.microCompactKeepRecent),
    maxFilesToRestore: c.maxFilesToRestore,
    maxTokensPerFile: c.maxTokensPerFile,
    fileBudget: c.fileBudget,
  };
}

/**
 * Compute the auto-compact threshold dynamically from the context window.
 * Formula: contextWindow - reservedForOutput - buffer
 * For 200K: 200K - 20K - 13K = 167K
 */
function getAutoCompactThreshold(contextWindow: number): number {
  return contextWindow - RESERVED_FOR_OUTPUT - AUTOCOMPACT_BUFFER;
}

function getMicroCompactThreshold(autoCompactThreshold: number): number {
  return autoCompactThreshold - MICRO_COMPACT_HEADSTART;
}

// ── Circuit breaker ─────────────────────────────────────

const MAX_CONSECUTIVE_FAILURES = 3;
let consecutiveFailures = 0;

export function resetCompactionFailures(): void {
  consecutiveFailures = 0;
}

// ── Public entry ────────────────────────────────────────

export interface CompactOptions {
  force?: boolean;
  aggressive?: boolean;
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
): Promise<Message[]> {
  const cfg = getCompactionConfig();
  const force = !!opts.force;
  const aggressive = !!opts.aggressive;

  if (messages.length === 0) return messages;

  if (!force && !aggressive && !cfg.enabled) {
    return messages;
  }

  if (!force && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return messages;
  }

  const threshold = getAutoCompactThreshold(cfg.contextWindow);
  const microThreshold = getMicroCompactThreshold(threshold);
  let tokens = tokenCountWithEstimation(messages).total;

  // Emit warning when approaching threshold
  if (tokens >= threshold - WARNING_BUFFER && tokens < threshold && !force && !aggressive) {
    eventBus.emit("compaction_warning", {
      currentTokens: tokens,
      threshold,
      percentLeft: Math.max(0, Math.round(((threshold - tokens) / threshold) * 100)),
    });
  }

  // STEP 1 — micro-compaction (pre-pass to reduce summarizer input)
  let working = messages;
  const microKeep = aggressive ? 1 : cfg.microCompactKeepRecent;
  const shouldMicro = aggressive || force || tokens >= microThreshold;
  if (shouldMicro) {
    console.log(
      `[compact] micro-compact START — msgs=${working.length}, tokens≈${tokens.toLocaleString()}, ` +
        `microThreshold=${microThreshold.toLocaleString()}, keepRecent=${microKeep}` +
        (aggressive ? ", aggressive" : "") +
        (force ? ", force" : ""),
    );
    const tokensBeforeMicro = tokens;
    const r = microCompact(working, microKeep);
    tokens = estimateConversationTokens(r.messages);
    if (r.cleared > 0) {
      eventBus.emit("compaction_micro", { cleared: r.cleared, tokensFreed: r.tokensFreed });
      working = r.messages;
    }
    console.log(
      `[compact] micro-compact DONE — cleared=${r.cleared}, freed≈${r.tokensFreed.toLocaleString()} tokens, ` +
        `tokens ${tokensBeforeMicro.toLocaleString()} → ${tokens.toLocaleString()}, msgs=${working.length}`,
    );
  }

  // STEP 2 — full LLM summarization (summarize ALL, no tail)
  if (!force && !aggressive && tokens < threshold) {
    return working;
  }

  const msgsBeforeFull = working.length;
  const tokensBeforeFull = tokens;
  console.log(
    `[compact] full-compact START — msgs=${msgsBeforeFull}, tokens≈${tokensBeforeFull.toLocaleString()}, ` +
      `fullThreshold=${threshold.toLocaleString()}` +
      (aggressive ? ", aggressive" : "") +
      (force ? ", force" : ""),
  );

  eventBus.emit("compaction_start", {
    totalMessages: working.length,
    estimatedTokens: tokens,
    aggressive,
  });

  const ctx: CompactContext = {
    cwd,
    todos: currentTodos,
    fileRestore: {
      maxFiles: cfg.maxFilesToRestore,
      maxTokensPerFile: cfg.maxTokensPerFile,
      totalBudget: cfg.fileBudget,
    },
  };

  try {
    const result = await compactConversation(working, mainModel, ctx);
    if (!result) {
      console.log(
        `[compact] full-compact DONE — no change (summarizer returned empty), ` +
          `msgs=${msgsBeforeFull}, tokens≈${tokensBeforeFull.toLocaleString()}`,
      );
      return working;
    }

    consecutiveFailures = 0;
    eventBus.emit("compaction_done", {
      summaryLength: result.summaryLength,
      estimatedTokensAfter: result.estimatedTokensAfter,
    });
    console.log(
      `[compact] full-compact DONE — msgs ${msgsBeforeFull} → ${result.messages.length}, ` +
        `tokens≈${tokensBeforeFull.toLocaleString()} → ${result.estimatedTokensAfter.toLocaleString()}, ` +
        `summaryChars=${result.summaryLength.toLocaleString()}`,
    );
    return result.messages;
  } catch (error) {
    consecutiveFailures++;
    const msg = error instanceof Error ? error.message : String(error);
    console.error(
      `[compact] full-compact FAILED — msgs=${msgsBeforeFull}, tokens≈${tokensBeforeFull.toLocaleString()}: ${msg}`,
    );
    eventBus.emit("compaction_error", { error: msg });
    return working;
  }
}
