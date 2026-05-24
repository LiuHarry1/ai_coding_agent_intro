/**
 * Tool-error formatting helpers.
 *
 * The generic-error path (`formatError`) and the Zod-validation path
 * (`formatZodValidationError`) are kept as separate exports — callers
 * pick the right one depending on what produced the error. We keep that
 * split because (a) Zod errors don't have `.stderr` / `.stdout` and the
 * truncation logic doesn't really apply, and (b) the call site
 * (stream-consumer's `tool-error` handler) does pick the right one based
 * on shape.
 *
 * `formatToolError` remains as the single entry point used by the
 * stream consumer — it tries Zod first, then falls through to
 * `formatError`. Each layer stays small and independently testable.
 */

// ── Truncation ─────────────────────────────────────
//
// child_process / shell errors can spit out megabytes of stderr; if we
// pass the whole thing back to the model it inflates the next request by
// 10x and we hit context limits within a turn or two. Cap at
// 10k cap with a head/tail split + middle elision so the model still sees
// both the failure summary AND the final lines (where the actual error
// usually lives for shell tools).

const MAX_ERROR_CHARS = 10_000;
const HALF_LENGTH = 5_000;

function truncateMiddle(text: string): string {
  if (text.length <= MAX_ERROR_CHARS) return text;
  const start = text.slice(0, HALF_LENGTH);
  const end = text.slice(-HALF_LENGTH);
  const elided = text.length - 2 * HALF_LENGTH;
  return `${start}\n\n... [${elided} characters truncated] ...\n\n${end}`;
}

// ── Generic error → string ─────────────────────────

/**
 * Best-effort textual rendering of an arbitrary thrown value. Used by
 * `execute()` failures that aren't Zod validation errors.
 *
 * Pulls `.message` plus `.stderr` / `.stdout` when present (child_process
 * errors carry those), joins them, and middle-truncates anything over 10k
 * chars.
 */
export function formatError(err: unknown): string {
  if (!(err instanceof Error)) return String(err ?? "tool execution failed");

  const parts: string[] = [err.message];
  // child_process.ExecException carries stderr/stdout on the Error itself,
  // but `Error` doesn't declare them. Read them via an `unknown`-cast view.
  const augmented = err as unknown as { stderr?: unknown; stdout?: unknown };
  if (typeof augmented.stderr === "string") parts.push(augmented.stderr);
  if (typeof augmented.stdout === "string") parts.push(augmented.stdout);
  const full = parts.filter(Boolean).join("\n").trim() || "Command failed with no output";
  return truncateMiddle(full);
}

// ── Zod validation error → string ──────────────────

/**
 * Render a Zod `path` array (e.g. `["todos", 0, "activeForm"]`) as the
 * dotted/bracketed string the model already knows from its tool schema:
 * `todos[0].activeForm`.
 */
export function formatZodPath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return "(root)";
  let out = "";
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!;
    if (typeof seg === "number") {
      out += `[${seg}]`;
    } else {
      out += i === 0 ? String(seg) : `.${String(seg)}`;
    }
  }
  return out;
}

interface ZodIssue {
  code?: string;
  path?: PropertyKey[];
  message?: string;
  expected?: string;
  received?: string;
  keys?: string[];
}

interface ZodErrorShape {
  issues?: ZodIssue[];
  message?: string;
}

/**
 * Build a model-friendly explanation of a Zod validation failure. Returns
 * null when the error doesn't have the Zod issue shape (caller should
 * fall through to `formatError`). The most common production cause of
 * "Missing tool result" is a missing required field — surfacing it as
 * "The required parameter `file_path` is missing" gives the model a
 * concrete recovery path.
 */
export function formatZodValidationError(
  toolName: string,
  err: unknown,
): string | null {
  const e = err as ZodErrorShape | undefined;
  if (!e || !Array.isArray(e.issues) || e.issues.length === 0) return null;

  const missing: string[] = [];
  const unexpected: string[] = [];
  const typeMismatch: { param: string; expected: string; received: string }[] = [];

  for (const iss of e.issues) {
    const path = formatZodPath(iss.path ?? []);
    const msg = iss.message ?? "";
    if (iss.code === "invalid_type" && /received undefined|Required/i.test(msg)) {
      missing.push(path);
    } else if (iss.code === "unrecognized_keys" && Array.isArray(iss.keys)) {
      unexpected.push(...iss.keys);
    } else if (iss.code === "invalid_type") {
      const recvMatch = msg.match(/received (\w+)/);
      typeMismatch.push({
        param: path,
        expected: iss.expected ?? "unknown",
        received: iss.received ?? recvMatch?.[1] ?? "unknown",
      });
    } else {
      // Unknown issue code: surface the raw message so the model at least
      // sees the constraint name (e.g. "String must contain at least 1
      // character(s)").
      typeMismatch.push({ param: path, expected: msg, received: "?" });
    }
  }

  const parts: string[] = [];
  for (const p of missing) parts.push(`The required parameter \`${p}\` is missing`);
  for (const p of unexpected) parts.push(`An unexpected parameter \`${p}\` was provided`);
  for (const t of typeMismatch) {
    parts.push(
      `The parameter \`${t.param}\` type is expected as \`${t.expected}\` but provided as \`${t.received}\``,
    );
  }

  if (parts.length === 0) return null;
  const word = parts.length > 1 ? "issues" : "issue";
  return `${toolName} failed due to the following ${word}:\n${parts.join("\n")}`;
}

// ── Single entry point ────────────────────────────

/**
 * Try Zod-validation formatting first (covers the dominant failure mode,
 * `inputSchema.parse()` rejection), fall back to generic formatError for
 * everything else. Used by `stream-consumer.consumeStream` to synthesize
 * the tool_result string from a `tool-error` SDK event.
 */
export function formatToolError(toolName: string, err: unknown): string {
  return formatZodValidationError(toolName, err) ?? formatError(err);
}
