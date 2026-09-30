import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

type Metric = { pct: number }
type Summary = {
  lines: Metric
  branches: Metric
  functions: Metric
  statements: Metric
}

const requiredFiles: Record<string, string> = {
  Read: 'src/tools/FileReadTool/FileReadTool.ts',
  Write: 'src/tools/FileWriteTool/FileWriteTool.ts',
  Edit: 'src/tools/FileEditTool/FileEditTool.ts',
  Glob: 'src/tools/GlobTool/GlobTool.ts',
  Grep: 'src/tools/GrepTool/GrepTool.ts',
  LSP: 'src/tools/LSPTool/LSPTool.ts',
  Bash: 'src/tools/BashTool/BashTool.ts',
  PowerShell: 'src/tools/PowerShellTool/PowerShellTool.ts',
  ShellRunner: 'src/tools/shell-runner.ts',
  TaskOutput: 'src/tools/TaskOutputTool/TaskOutputTool.ts',
  TaskStop: 'src/tools/TaskStopTool/TaskStopTool.ts',
  WebSearch: 'src/tools/WebSearchTool/WebSearchTool.ts',
  WebFetch: 'src/tools/WebFetchTool/WebFetchTool.ts',
  TodoWrite: 'src/tools/TodoWriteTool/TodoWriteTool.ts',
  AskUserQuestion: 'src/tools/AskUserQuestionTool/AskUserQuestionTool.ts',
  ToolSearch: 'src/tools/ToolSearchTool/ToolSearchTool.ts',
  Agent: 'src/tools/AgentTool/AgentTool.ts',
  Skill: 'src/tools/SkillTool/SkillTool.ts',
  EnterPlanMode: 'src/tools/EnterPlanModeTool/EnterPlanModeTool.ts',
  ExitPlanMode: 'src/tools/ExitPlanModeTool/ExitPlanModeTool.ts',
  CronCreate: 'src/tools/ScheduleCronTool/CronCreateTool.ts',
  CronList: 'src/tools/ScheduleCronTool/CronListTool.ts',
  CronDelete: 'src/tools/ScheduleCronTool/CronDeleteTool.ts',
}

const report = JSON.parse(
  await readFile('coverage/coverage-summary.json', 'utf8'),
) as Record<string, Summary>
const entries = Object.entries(report).filter(([key]) => key !== 'total')
const failures: string[] = []

for (const [toolName, expectedPath] of Object.entries(requiredFiles)) {
  const normalized = expectedPath.replaceAll('\\', '/').toLowerCase()
  const match = entries.find(([filePath]) =>
    filePath.replaceAll('\\', '/').toLowerCase().endsWith(normalized),
  )
  assert.ok(match, `${toolName}: coverage report missing ${expectedPath}`)
  const summary = match[1]
  if (summary.lines.pct < 75) {
    failures.push(`${toolName}: lines ${summary.lines.pct}% < 75%`)
  }
  if (summary.branches.pct < 50) {
    failures.push(`${toolName}: branches ${summary.branches.pct}% < 50%`)
  }
  if (summary.functions.pct < 50) {
    failures.push(`${toolName}: functions ${summary.functions.pct}% < 50%`)
  }
}

assert.equal(failures.length, 0, failures.join('\n'))
console.log(
  `ok per-tool coverage gate (${Object.keys(requiredFiles).length} implementation files)`,
)

