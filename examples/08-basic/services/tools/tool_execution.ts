/**
 * Tool execution orchestration — CC: services/tools/toolExecution.ts
 * Consecutive concurrency-safe calls run in parallel; mutating tools serially.
 */
import type { AnyTool, IEventBus, Message, ToolMessage } from "../../core/types.js";
import type { ConcurrencyPolicyFn } from "../../core/concurrency-policy.js";
import { formatToolError } from "../../core/agent/toolErrors.js";
import { maybePersistAfterExecute } from "../tool-storage/index.js";

export interface ToolCallRef {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ExecutedToolResult {
  toolCallId: string;
  toolName: string;
  result: string;
  followUpMessages?: Message[];
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
  sessionId?: string,
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
    let result: string;
    let followUpMessages: Message[] | undefined;
    if (typeof raw === "string") {
      result = raw;
    } else if (raw && typeof raw === "object" && "result" in raw) {
      const structured = raw as { result: string; followUpMessages?: Message[] };
      result = structured.result;
      followUpMessages = structured.followUpMessages;
    } else {
      result = JSON.stringify(raw);
    }
    result = maybePersistAfterExecute(sessionId, tc.toolCallId, tc.toolName, result);
    eventBus.emit("tool_result", {
      name: tc.toolName,
      result,
      toolCallId: tc.toolCallId,
    });
    return {
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      result,
      followUpMessages,
    };
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
  sessionId?: string,
): Promise<ExecutedToolResult[]> {
  const results: ExecutedToolResult[] = new Array(calls.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= calls.length) return;
      results[i] = await executeOne(calls[i]!, tools, eventBus, sessionId);
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
  sessionId?: string;
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
          opts.sessionId,
        )),
      );
    } else if (batch.isConcurrencySafe) {
      allResults.push(await executeOne(batch.calls[0]!, opts.tools, opts.eventBus, opts.sessionId));
    } else {
      for (const tc of batch.calls) {
        allResults.push(await executeOne(tc, opts.tools, opts.eventBus, opts.sessionId));
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
