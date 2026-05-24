/**
 * Micro-compaction: cheap, no-LLM pass that clears old tool payloads.
 *
 * For read-oriented tools (bash, grep, read_file, ...) clears the OUTPUT.
 * For write-oriented tools (write_file, edit_file, ...) clears the INPUT.
 * Tool blocks are preserved (only payloads replaced) so tool_call ↔
 * tool_result pairing stays intact.
 */
import type { AssistantMessage, Message, ToolMessage } from "../types.js";
import { estimateMessageTokens } from "./tokens.js";

const MICRO_COMPACT_MARKER = "[Old tool result content cleared to save context]";

const MICRO_COMPACT_INPUT_MARKER = { _cleared: true, note: "Old tool input cleared to save context" };

const CLEARABLE_TOOL_RESULTS = new Set<string>([
  "bash",
  "shell",
  "powershell",
  "glob",
  "grep",
  "read_file",
  "web_fetch",
  "web_search",
]);

const CLEARABLE_TOOL_INPUTS = new Set<string>([
  "write_file",
  "edit_file",
  "create_file",
  "apply_patch",
  "notebook_edit",
]);

function estStr(s: string): number {
  return Math.ceil(s.length / 4);
}

const MARKER_RESULT_COST = estStr(MICRO_COMPACT_MARKER);
const MARKER_INPUT_JSON = JSON.stringify(MICRO_COMPACT_INPUT_MARKER);
const MARKER_INPUT_COST = estStr(MARKER_INPUT_JSON);

export interface MicroCompactResult {
  messages: Message[];
  tokensFreed: number;
  cleared: number;
}

export function microCompact(messages: Message[], keepRecent: number): MicroCompactResult {
  const toolMsgIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool") toolMsgIdx.push(i);
  }
  if (toolMsgIdx.length <= Math.max(0, keepRecent)) {
    return { messages, tokensFreed: 0, cleared: 0 };
  }

  const clearUpToExclusive = toolMsgIdx[toolMsgIdx.length - keepRecent - 1] + 1;

  let tokensFreed = 0;
  let cleared = 0;

  const out = messages.map((m, i) => {
    if (i >= clearUpToExclusive) return m;
    if (m.role === "tool") return clearToolResults(m, () => cleared++, (n) => (tokensFreed += n));
    if (m.role === "assistant") return clearToolInputs(m, () => cleared++, (n) => (tokensFreed += n));
    return m;
  });
  return { messages: out, tokensFreed, cleared };
}

/**
 * Re-estimate token count after micro-compaction. Avoids full
 * re-estimation if we know how many tokens were freed.
 */
export function estimateAfterMicroCompact(
  messages: Message[],
  priorTotal: number,
  freed: number,
): number {
  if (freed > 0) return priorTotal - freed;
  let t = 0;
  for (const m of messages) t += estimateMessageTokens(m);
  return t;
}

// ── Internals ───────────────────────────────────────────

function clearToolResults(
  m: ToolMessage,
  bumpCleared: () => void,
  addFreed: (n: number) => void,
): ToolMessage {
  let touched = false;
  const newContent = m.content.map((part) => {
    if (!CLEARABLE_TOOL_RESULTS.has(part.toolName)) return part;
    const v = part.output?.value ?? "";
    const text = typeof v === "string" ? v : JSON.stringify(v);
    if (text === MICRO_COMPACT_MARKER) return part;
    addFreed(Math.max(0, estStr(text) - MARKER_RESULT_COST));
    bumpCleared();
    touched = true;
    return { ...part, output: { type: "text" as const, value: MICRO_COMPACT_MARKER } };
  });
  return touched ? ({ ...m, content: newContent } as ToolMessage) : m;
}

function clearToolInputs(
  m: AssistantMessage,
  bumpCleared: () => void,
  addFreed: (n: number) => void,
): AssistantMessage {
  let touched = false;
  const newContent = m.content.map((part) => {
    if (part.type !== "tool-call") return part;
    if (!CLEARABLE_TOOL_INPUTS.has(part.toolName)) return part;
    const argsJson = JSON.stringify(part.input ?? {});
    if (argsJson === MARKER_INPUT_JSON) return part;
    addFreed(Math.max(0, estStr(argsJson) - MARKER_INPUT_COST));
    bumpCleared();
    touched = true;
    return { ...part, input: { ...MICRO_COMPACT_INPUT_MARKER } };
  });
  return touched ? ({ ...m, content: newContent } as AssistantMessage) : m;
}
