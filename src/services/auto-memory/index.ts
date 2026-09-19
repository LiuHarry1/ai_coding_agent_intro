export {
  AUTO_MEM_DIRNAME,
  AUTO_MEM_ENTRYPOINT,
  ensureAutoMemDir,
  findCanonicalGitRoot,
  getAutoMemEntrypoint,
  getAutoMemPath,
  isAutoMemPath,
  sanitizePath,
} from './paths.js'
export type { AutoMemPathOptions } from './paths.js'

export {
  MEMORY_TYPES,
  parseMemoryType,
  MEMORY_FRONTMATTER_EXAMPLE,
  WHAT_NOT_TO_SAVE_SECTION,
  WHEN_TO_ACCESS_SECTION,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION_INDIVIDUAL,
  TYPES_SECTION_INDIVIDUAL_EXTERNAL,
  WHAT_NOT_TO_SAVE_SECTION_EXTERNAL,
} from './types.js'
export type { MemoryType } from './types.js'

export {
  scanMemoryFiles,
  repairMemoryFrontmatterFiles,
  formatMemoryManifest,
  truncateEntrypointContent,
  readEntrypointRaw,
  ensureIndexEntry,
  rebuildIndex,
  readFileCapped,
} from './scan.js'
export type { MemoryFileMeta, MemoryFrontmatterRepairResult } from './scan.js'

export {
  memoryAgeDays,
  memoryAge,
  memoryFreshnessText,
  memoryHeader,
} from './memoryAge.js'

export {
  findFastRelevantMemories,
  findRelevantMemories,
  createSelectRelevantMemories,
  readMemoriesForSurfacing,
  readMemoriesForSurfacingSync,
  MAX_MEMORY_LINES,
  MAX_MEMORY_BYTES,
  MAX_SESSION_BYTES,
} from './findRelevant.js'
export type {
  FastRelevantMemory,
  FastRelevantResult,
  RelevantMemory,
  SurfacedMemory,
  FindRelevantOpts,
  SelectRelevantFn,
} from './findRelevant.js'

export { resolveMemoryBinding, describeMemoryBinding } from './binding.js'
export type {
  MemoryBinding,
  MemoryPromptKind,
  MemoryPromptPlacement,
  ResolveMemoryBindingOpts,
} from './binding.js'

export {
  startRelevantMemoryPrefetch,
  resolvePrefetchMemoryDirs,
  hasRecallIntent,
  resolveMemoryRecallDecision,
  consumeImmediateMemoryPrefetch,
  consumeMemoryPrefetchWithTimeout,
  consumeMemoryPrefetchIfReady,
  collectSurfacedMemories,
  collectRecentSuccessfulTools,
  RELEVANT_MEMORIES_CONFIG,
  EXPLICIT_RECALL_TIMEOUT_MS,
} from './prefetch.js'
export type {
  MemoryPrefetch,
  MemoryRecallDecision,
  StartPrefetchOpts,
  TimedMemoryPrefetchResult,
} from './prefetch.js'

export {
  sideQueryJson,
  parseJsonFromModelText,
  selectedMemoriesJsonSchema,
} from './sideQuery.js'
export type { SelectedMemoriesResult } from './sideQuery.js'

export {
  loadAutoMemoryPrompt,
  buildExtractAutoMemoryPrompt,
  buildMemoryPrompt,
  buildMemoryLines,
  buildSearchingPastContextSection,
  DIR_EXISTS_GUIDANCE,
} from './prompts.js'

export {
  buildAutoMemorySystemAppend,
  buildMemorySystemAppend,
  buildExistingMemoriesManifest,
} from './inject.js'

export {
  extractAutoMemories,
  extractAutoMemoriesInBackground,
  getSuccessfulMemoryWritePathsSince,
  shouldExtractAutoMemory,
  createAutoMemCanUseTool,
  verifyAndRepairIndex,
} from './extract.js'
export type {
  ExtractAutoMemoryArgs,
  ExtractAutoMemoryResult,
} from './extract.js'

export {
  getAutoMemoryState,
  resetAutoMemoryState,
  clearAllAutoMemoryState,
} from './state.js'
