/**
 * Public API for the compaction module.
 * External code imports from here — internal files are implementation details.
 */
export {
  attachTokenUsage,
  readTokenUsage,
  clearTokenUsages,
  tokenCountWithEstimation,
  estimateMessageTokens,
  estimateConversationTokens,
} from "./tokens.js";
export type { AttachedTokenUsage } from "./tokens.js";

export { microCompact } from "./microCompact.js";
export type { MicroCompactResult } from "./microCompact.js";

export { compactConversation } from "./compact.js";
export type { CompactResult, CompactContext, FileRestoreConfig } from "./compact.js";

export { compactIfNeeded, resetCompactionFailures } from "./autoCompact.js";
export type { CompactOptions } from "./autoCompact.js";
