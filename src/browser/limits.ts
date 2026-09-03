/**
 * Every bound the browser tools wait on or spend, in one place.
 *
 * Capture follows Cursor: full tree (maxDepth 20), no middle-omit. Over
 * SNAPSHOT_INLINE_MAX_BYTES the complete YAML is spilled to disk and the
 * model sees a short preview + path. `mode=efficient` is the opt-in clip.
 * Wire/UI: WIRE_DETAIL_* caps so SSE/session never carry raw trees.
 */

/** No browser call should outlive a stuck page; the model needs its turn back. */
export const CALL_TIMEOUT_MS = 60_000

/**
 * The observation is bounded on its own, well under CALL_TIMEOUT_MS, so a slow
 * tree cannot turn an action that already succeeded into an error.
 */
export const POST_ACTION_SNAPSHOT_MS = 15_000

/** Snapshot attached to an error path — best effort, so it fails fast. */
export const ERROR_SNAPSHOT_TIMEOUT_MS = 8_000

export const ACTION_TIMEOUT_MS = 8_000
export const SNAPSHOT_TIMEOUT_MS = 8_000

/** Wait after an action so late XHR/DOM can land. */
export const ACTION_SETTLE_MS = 500
export const NETWORK_DRAIN_MS = 3_000

export const WAIT_FOR_TIMEOUT_MS = 20_000
export const WAIT_FOR_TIME_CAP_S = 30

export const NAVIGATE_TIMEOUT_MS = 30_000
/** SPAs paint chrome before the main tree; give widgets a beat to mount. */
export const NAVIGATE_SETTLE_MS = 300
/** Legacy drain constant; navigate no longer waits on network idle. */
export const NAVIGATE_NETWORK_DRAIN_MS = 2_000

/** Ref-bearing nodes in an explicit full `browser_snapshot`. */
export const DEFAULT_MAX_NODES = 1500
/** Ref-bearing nodes in navigate / post-action / efficient snapshot. */
export const POST_ACTION_MAX_NODES = 800

/**
 * Cursor `browser_snapshot` / post-action: keep the complete YAML inline
 * until this many UTF-8 bytes, then write the file and return a line preview.
 */
export const SNAPSHOT_INLINE_MAX_BYTES = 25_600
/** Cursor large-snapshot preview: first N YAML lines. */
export const SNAPSHOT_PREVIEW_LINES = 50
/** Explicit full-tier clip when the caller opts into `mode=efficient`. */
export const DEFAULT_MAX_CHARS = 40_000
/** `mode=efficient` character budget (interactive clip). */
export const EFFICIENT_MAX_CHARS = 8_000
/**
 * Cursor `browser_snapshot` default `maxDepth`. Nested ExtJS / iframe forms
 * (Concur XpresswayTA) sit below depth 6 — clipping there drops comboboxes
 * and reports truncated=false.
 */
export const DEFAULT_SNAPSHOT_DEPTH = 20
/** Compact/efficient depth; same as Cursor maxDepth, not a shallow 6. */
export const EFFICIENT_DEPTH = DEFAULT_SNAPSHOT_DEPTH

/** Screenshots compete with the snapshot for context; cap them hard. */
export const SCREENSHOT_TOKEN_BUDGET = 1500

export const ACT_MAX_VIEWPORT_DIMENSION = 8192

/** Auto-refresh snapshot before ref actions when older than this (Cursor-style). */
export const SNAPSHOT_TTL_MS = 10_000

/**
 * CDP JSON inline cap. Larger responses (and Profiler.stop) spill to a file
 * under `.sessions/{id}/browser/`.
 */
export const CDP_INLINE_MAX_CHARS = 8_000

/** Hard wrap for non-browser tool text. */
export const MODEL_TOOL_RESULT_MAX_CHARS = 16_000
/**
 * Browser tool results must fit a Cursor-sized inline snapshot (25.6KB YAML)
 * plus action/url chrome. Below this, do not wrap or offload.
 */
export const BROWSER_MODEL_RESULT_MAX_CHARS = 32_768

/** Per-string cap inside SSE / session `tool_use_result` details. */
export const WIRE_DETAIL_STRING_MAX = 2_000
/** Whole `tool_use_result` blob budget for browser tools. */
export const WIRE_DETAILS_MAX_BYTES = 8_192

/** Console / network rows kept on the wire (and in observe summaries). */
export const WIRE_CONSOLE_MAX = 8
export const WIRE_NETWORK_MAX = 12
