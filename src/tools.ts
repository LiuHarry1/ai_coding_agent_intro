import { defaultRegistry } from './core/tool-registry.js'
import { isPreviewEnabled } from './core/preview.js'
import { isPowerShellToolEnabled } from './core/shell/shell-utils.js'
import { definition as bash } from './tools/BashTool/BashTool.js'
import { definition as powershell } from './tools/PowerShellTool/PowerShellTool.js'
import { definition as readFile } from './tools/FileReadTool/FileReadTool.js'
import { definition as writeFile } from './tools/FileWriteTool/FileWriteTool.js'
import { definition as editFile } from './tools/FileEditTool/FileEditTool.js'
import { definition as todoWrite } from './tools/TodoWriteTool/TodoWriteTool.js'
import { definition as webSearch } from './tools/WebSearchTool/WebSearchTool.js'
import { definition as webFetch } from './tools/WebFetchTool/WebFetchTool.js'
import { definition as globTool } from './tools/GlobTool/GlobTool.js'
import { definition as grepTool } from './tools/GrepTool/GrepTool.js'
import { definition as lspTool } from './tools/LSPTool/LSPTool.js'
import { definition as askUserQuestion } from './tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { definition as publishPreview } from './tools/PublishPreviewTool/PublishPreviewTool.js'

// Default: bash always; powershell additionally on Windows.
const shellTools = [bash, ...(isPowerShellToolEnabled() ? [powershell] : [])]

;[
  ...shellTools,
  readFile,
  writeFile,
  editFile,
  globTool,
  grepTool,
  lspTool,
  todoWrite,
  webSearch,
  webFetch,
  askUserQuestion,
  ...(isPreviewEnabled() ? [publishPreview] : []),
].forEach(def => defaultRegistry.register(def))

export { defaultRegistry }
export { assembleToolPool } from './tools/assembleToolPool.js'
