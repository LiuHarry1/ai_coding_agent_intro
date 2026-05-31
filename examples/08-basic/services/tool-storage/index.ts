/**
 * Persist large tool outputs to disk. Execute time: write + return full text.
 * Micro-compact time: replace cleared payloads with a re-readable path reference.
 */
import * as fs from "fs";
import * as path from "path";
import { getToolResultFilePath } from "../../server/session.js";
import {
  BASH_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "../../tools/tool-names.js";

export const PERSISTED_OUTPUT_OPEN = "<persisted-output";
export const PERSISTED_OUTPUT_CLOSE = "</persisted-output>";

const PERSISTABLE_TOOLS = new Set([
  READ_FILE_TOOL_NAME,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  BASH_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
]);

function parseEnvInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Min output size (chars) before we write a sidecar file on tool execute. */
export function getPersistThresholdChars(): number {
  return parseEnvInt("TOOL_PERSIST_THRESHOLD_CHARS", 32_768);
}

export function isPersistableTool(toolName: string): boolean {
  return PERSISTABLE_TOOLS.has(toolName);
}

export function isPersistedReference(text: string): boolean {
  return text.includes(PERSISTED_OUTPUT_OPEN);
}

function formatBytes(chars: number): string {
  if (chars >= 1024 * 1024) return `${(chars / (1024 * 1024)).toFixed(1)} MB`;
  if (chars >= 1024) return `${(chars / 1024).toFixed(1)} KB`;
  return `${chars} chars`;
}

/**
 * Write full output to `.sessions/{id}/tool-results/{toolCallId}.txt`.
 * Returns absolute path, or null on failure / below threshold.
 */
export function persistToolResult(
  sessionId: string | undefined,
  toolCallId: string,
  toolName: string,
  content: string,
): string | null {
  if (!sessionId || !isPersistableTool(toolName)) return null;
  const threshold = getPersistThresholdChars();
  if (content.length <= threshold) return null;

  const filePath = getToolResultFilePath(sessionId, toolCallId);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
    console.log(
      `[tool-storage] PERSIST ${toolName} ${toolCallId.slice(0, 12)}… — ` +
        `${formatBytes(content.length)} → ${filePath} (full content still in tool_result)`,
    );
    return filePath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[tool-storage] persist failed for ${toolCallId}: ${msg}`);
    return null;
  }
}

/** Short message replacing cleared tool payload during micro-compact. */
export function buildPersistedReference(
  filePath: string,
  toolName: string,
  originalChars: number,
): string {
  return (
    `${PERSISTED_OUTPUT_OPEN} path="${filePath}" tool="${toolName}" chars="${originalChars}">\n` +
    `[Previous ${toolName} output (${formatBytes(originalChars)}) offloaded to disk to save context. ` +
    `Use read_file on this path to retrieve the full content if needed.\n` +
    `${PERSISTED_OUTPUT_CLOSE}`
  );
}

/**
 * After tool execute: persist sidecar if large; always return original content
 * unchanged so the model sees the full output on this turn.
 */
export function maybePersistAfterExecute(
  sessionId: string | undefined,
  toolCallId: string,
  toolName: string,
  result: string,
): string {
  persistToolResult(sessionId, toolCallId, toolName, result);
  return result;
}

/**
 * Micro-compact helper: ensure sidecar exists, return reference text.
 * Falls back to generic cleared marker when session/path unavailable.
 */
export function offloadReferenceForCompact(
  sessionId: string | undefined,
  toolCallId: string,
  toolName: string,
  content: string,
  fallbackMarker: string,
): string {
  if (isPersistedReference(content)) return content;

  if (sessionId && isPersistableTool(toolName)) {
    let filePath = getToolResultFilePath(sessionId, toolCallId);
    if (!fs.existsSync(filePath) && content.length > 0) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, "utf-8");
        console.log(
          `[tool-storage] PERSIST (on compact) ${toolName} ${toolCallId.slice(0, 12)}… → ${filePath}`,
        );
      } catch {
        return fallbackMarker;
      }
    }
    if (fs.existsSync(filePath)) {
      return buildPersistedReference(filePath, toolName, content.length);
    }
  }

  return fallbackMarker;
}
