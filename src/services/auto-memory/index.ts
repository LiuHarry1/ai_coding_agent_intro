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
} from './types.js'
export type { MemoryType } from './types.js'

export {
  scanMemoryFiles,
  formatMemoryManifest,
  truncateEntrypointContent,
  readEntrypointRaw,
  ensureIndexEntry,
  rebuildIndex,
  readFileCapped,
} from './scan.js'
export type { MemoryFileMeta } from './scan.js'

export {
  memoryAgeDays,
  memoryAge,
  memoryFreshnessText,
  memoryHeader,
} from './memoryAge.js'

export {
  findRelevantMemories,
  createSelectRelevantMemories,
  readMemoriesForSurfacing,
  MAX_MEMORY_LINES,
  MAX_MEMORY_BYTES,
  MAX_SESSION_BYTES,
} from './findRelevant.js'
export type {
  RelevantMemory,
  SurfacedMemory,
  FindRelevantOpts,
  SelectRelevantFn,
} from './findRelevant.js'

export {
  startRelevantMemoryPrefetch,
  consumeMemoryPrefetchIfReady,
  collectSurfacedMemories,
  collectRecentSuccessfulTools,
  RELEVANT_MEMORIES_CONFIG,
} from './prefetch.js'
export type { MemoryPrefetch, StartPrefetchOpts } from './prefetch.js'

export {
  sideQueryJson,
  parseJsonFromModelText,
  selectedMemoriesJsonSchema,
} from './sideQuery.js'
export type { SelectedMemoriesResult } from './sideQuery.js'

export {
  loadAutoMemoryPrompt,
  buildExtractAutoMemoryPrompt,
} from './prompts.js'

export {
  buildAutoMemorySystemAppend,
  buildExistingMemoriesManifest,
} from './inject.js'

export {
  extractAutoMemories,
  extractAutoMemoriesInBackground,
  hasMemoryWritesSince,
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
