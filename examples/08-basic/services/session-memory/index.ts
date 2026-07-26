export { getSessionMemoryDir, getSessionMemoryPath } from './paths.js'
export {
  DEFAULT_SESSION_MEMORY_TEMPLATE,
  isEmptySessionMemoryTemplate,
  validateSessionMemoryStructure,
} from './template.js'
export {
  getSessionMemoryState,
  resetSessionMemoryState,
  clearLastSummarizedMessageId,
  waitForSessionMemoryExtraction,
  beginExtraction,
  endExtraction,
  bumpNotesGeneration,
} from './state.js'
export type { WaitExtractionResult } from './state.js'
export {
  ensureMessageUuid,
  ensureMessageUuids,
  getMessageUuid,
  findMessageIndexByUuid,
} from './messageUuid.js'
export {
  calculateMessagesToKeepIndex,
  sliceMessagesToKeep,
  adjustIndexToPreserveToolPairs,
  hasTextBlocks,
} from './keepIndex.js'
export {
  formatCompactSummaryMessage,
  truncateSessionMemoryForCompact,
  buildSessionMemoryUpdatePrompt,
  loadSessionMemoryTemplate,
  SESSION_MEMORY_FORK_SYSTEM_PROMPT,
} from './prompts.js'
export {
  extractSessionMemory,
  extractSessionMemoryInBackground,
  shouldExtractSessionMemory,
} from './extract.js'
export { trySessionMemoryCompaction } from './compact.js'
export type { SessionMemoryCompactResult } from './compact.js'
export { createMemoryFileEditTool } from './memoryEditTool.js'
