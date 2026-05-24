/**
 * Error classification for stream/API failures.
 * Separated from compaction — used by the agent retry loop.
 */

/**
 * Heuristic: did this error come from the model rejecting the prompt as
 * too long? Covers OpenAI, Anthropic (413), Gemini, and proxy variants.
 */
export function isContextLengthError(err: unknown): boolean {
  if (!err) return false;
  const e = err as {
    statusCode?: number;
    status?: number;
    message?: string;
    cause?: { message?: string };
  };
  const status = e.statusCode ?? e.status;
  if (status === 413) return true;
  const msg = ((e.message ?? "") + " " + (e.cause?.message ?? "")).toLowerCase();
  return (
    msg.includes("context length") ||
    msg.includes("context_length") ||
    msg.includes("context window") ||
    msg.includes("prompt is too long") ||
    msg.includes("prompt too long") ||
    msg.includes("maximum context") ||
    msg.includes("too many tokens") ||
    msg.includes("token count exceeds") ||
    msg.includes("token limit")
  );
}

/**
 * Heuristic: did the request fail because the upstream socket was closed
 * mid-flight (proxy timeout, ECONNRESET, undici "terminated", flaky 5xx)?
 * For these the right move is to retry the same request, not to compact.
 */
export function isTransientStreamError(err: unknown): boolean {
  if (!err) return false;
  const e = err as {
    statusCode?: number;
    status?: number;
    code?: string;
    message?: string;
    cause?: { message?: string; code?: string };
  };
  const status = e.statusCode ?? e.status;
  if (status === 502 || status === 503 || status === 504) return true;
  const code = e.code ?? e.cause?.code ?? "";
  if (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE" ||
    code === "UND_ERR_SOCKET"
  ) {
    return true;
  }
  const msg = ((e.message ?? "") + " " + (e.cause?.message ?? "")).toLowerCase();
  return (
    msg.includes("terminated") ||
    msg.includes("other side closed") ||
    msg.includes("socket hang up") ||
    msg.includes("connection reset") ||
    msg.includes("network error") ||
    msg.includes("fetch failed") ||
    msg.includes("no output generated")
  );
}
