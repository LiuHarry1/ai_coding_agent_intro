export {
  AUTO_MEM_DIRNAME,
  AUTO_MEM_ENTRYPOINT,
  ensureAutoMemDir,
  findCanonicalGitRoot,
  getAutoMemEntrypoint,
  getAutoMemPath,
  isAutoMemPath,
  isAutoMemoryDisabledByEnv,
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
} from './scan.js'
export type { MemoryFileMeta } from './scan.js'

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
