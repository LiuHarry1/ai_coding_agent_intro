/**
 * Tool execution orchestration — Claude Code-style batching:
 * consecutive concurrency-safe calls run in parallel; mutating / interactive
 * tools run serially.
 */
import type { AnyTool, IEventBus, ToolMessage } from "../types.js";
import type { ConcurrencyPolicyFn } from "../concurrency-policy.js";
import { formatToolError } from "./toolErrors.js";

export interface ToolCallRef {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ExecutedToolResult {
  toolCallId: string;
  toolName: string;
  result: string;
}

type Batch = { isConcurrencySafe: boolean; calls: ToolCallRef[] };

function getMaxToolUseConcurrency(): number {
  const parsed = parseInt(process.env.AGENT_MAX_TOOL_CONCURRENCY ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

function isConcurrencySafe(
  policy: ConcurrencyPolicyFn,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  try {
    return policy(toolName, input);
  } catch {
    return false;
  }
}

/**
 * Partition tool calls into batches where each batch is either:
 * 1. A single non-concurrency-safe tool, or
 * 2. Multiple consecutive concurrency-safe tools
 */
export function partitionToolCalls(
  calls: readonly ToolCallRef[],
  policy: ConcurrencyPolicyFn,
): Batch[] {
  return calls.reduce((acc: Batch[], tc) => {
    const safe = isConcurrencySafe(policy, tc.toolName, tc.input);
    const last = acc[acc.length - 1];
    if (safe && last?.isConcurrencySafe) {
      last.calls.push(tc);
    } else {
      acc.push({ isConcurrencySafe: safe, calls: [tc] });
    }
    return acc;
  }, []);
}

async function executeOne(
  tc: ToolCallRef,
  tools: Record<string, AnyTool>,
  eventBus: IEventBus,
): Promise<ExecutedToolResult> {
  const tool = tools[tc.toolName] as AnyTool & {
    execute?: (input: unknown, options?: unknown) => Promise<unknown>;
  };

  if (!tool?.execute) {
    const result = `Error: Unknown tool: ${tc.toolName}`;
    eventBus.emit("tool_result", {
      name: tc.toolName,
      result,
      toolCallId: tc.toolCallId,
    });
    return { toolCallId: tc.toolCallId, toolName: tc.toolName, result };
  }

  try {
    const raw = await tool.execute(tc.input, {
      toolCallId: tc.toolCallId,
      messages: [],
    });
    const result = typeof raw === "string" ? raw : JSON.stringify(raw);
    eventBus.emit("tool_result", {
      name: tc.toolName,
      result,
      toolCallId: tc.toolCallId,
    });
    return { toolCallId: tc.toolCallId, toolName: tc.toolName, result };
  } catch (err) {
    const result = `Error: ${formatToolError(tc.toolName, err)}`;
    eventBus.emit("tool_result", {
      name: tc.toolName,
      result,
      toolCallId: tc.toolCallId,
    });
    return { toolCallId: tc.toolCallId, toolName: tc.toolName, result };
  }
}

async function executeBatchParallel(
  calls: readonly ToolCallRef[],
  tools: Record<string, AnyTool>,
  eventBus: IEventBus,
  maxConcurrency: number,
): Promise<ExecutedToolResult[]> {
  const results: ExecutedToolResult[] = new Array(calls.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= calls.length) return;
      results[i] = await executeOne(calls[i]!, tools, eventBus);
    }
  }

  const workerCount = Math.min(maxConcurrency, calls.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export interface RunToolCallsOptions {
  toolCalls: readonly ToolCallRef[];
  tools: Record<string, AnyTool>;
  eventBus: IEventBus;
  concurrencyPolicy: ConcurrencyPolicyFn;
}

export async function runToolCalls(
  opts: RunToolCallsOptions,
): Promise<ExecutedToolResult[]> {
  const batches = partitionToolCalls(opts.toolCalls, opts.concurrencyPolicy);
  const allResults: ExecutedToolResult[] = [];

  for (const batch of batches) {
    if (batch.isConcurrencySafe && batch.calls.length > 1) {
      console.log(
        `[agent] tool batch: parallel ×${batch.calls.length} (${batch.calls.map((c) => c.toolName).join(", ")})`,
      );
      allResults.push(
        ...(await executeBatchParallel(
          batch.calls,
          opts.tools,
          opts.eventBus,
          getMaxToolUseConcurrency(),
        )),
      );
    } else if (batch.isConcurrencySafe) {
      allResults.push(await executeOne(batch.calls[0]!, opts.tools, opts.eventBus));
    } else {
      for (const tc of batch.calls) {
        allResults.push(await executeOne(tc, opts.tools, opts.eventBus));
      }
    }
  }

  return allResults;
}

export function buildToolMessage(
  results: readonly ExecutedToolResult[],
): ToolMessage {
  return {
    role: "tool",
    content: results.map((tr) => ({
      type: "tool-result" as const,
      toolCallId: tr.toolCallId,
      toolName: tr.toolName,
      output: { type: "text" as const, value: tr.result },
    })),
  };
}
