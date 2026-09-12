import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  EDIT_FILE_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../constants/tool_names.js'
import { parseAgentFromMarkdown } from '../tools/AgentTool/mergeAgents.js'
import {
  getAgentMemoryDir,
  loadAgentMemoryPrompt,
} from '../tools/AgentTool/agentMemory.js'
import { runWithRequestScope } from '../utils/request-scope.js'

const parsed = parseAgentFromMarkdown({
  filePath: '/project/.ai-agent/agents/reviewer.md',
  baseDir: '/project/.ai-agent/agents',
  source: 'project',
  frontmatter: {
    name: 'reviewer',
    description: 'Review changes',
    tools: ['Grep'],
    memory: 'project',
  },
  body: 'Review carefully.',
})
assert.ok(parsed.agent)
assert.equal(parsed.agent.memory, 'project')
for (const toolName of [
  FILE_READ_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
]) {
  assert.ok(parsed.agent.tools?.includes(toolName))
}

const invalid = parseAgentFromMarkdown({
  filePath: '/project/.ai-agent/agents/bad.md',
  baseDir: '/project/.ai-agent/agents',
  source: 'project',
  frontmatter: {
    name: 'bad',
    description: 'Bad scope',
    memory: 'shared',
  },
  body: 'test',
})
assert.ok(!invalid.agent)
assert.match(invalid.error ?? '', /invalid 'memory' scope/)
console.log('ok: agent memory frontmatter and required tools')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-'))
const home = path.join(tmp, 'alice')
const cwd = path.join(home, 'project')
fs.mkdirSync(cwd, { recursive: true })
const previousAuth = process.env.AUTH_ENABLED
process.env.AUTH_ENABLED = 'true'
try {
  runWithRequestScope({ agentHome: home, cwd }, () => {
    const userDir = getAgentMemoryDir('plugin:reviewer', 'user', cwd)
    const projectDir = getAgentMemoryDir('plugin:reviewer', 'project', cwd)
    const localDir = getAgentMemoryDir('plugin:reviewer', 'local', cwd)
    assert.ok(userDir.startsWith(path.join(home, '.ai-agent')))
    assert.ok(projectDir.startsWith(path.join(cwd, '.ai-agent')))
    assert.ok(localDir.startsWith(path.join(cwd, '.ai-agent')))
    assert.ok(!userDir.includes(':'))

    fs.mkdirSync(userDir, { recursive: true })
    fs.writeFileSync(
      path.join(userDir, 'MEMORY.md'),
      'Prefer concise review findings.\n',
    )
    const loaded = loadAgentMemoryPrompt('plugin:reviewer', 'user', cwd)
    assert.equal(loaded.memoryDir, userDir)
    assert.ok(loaded.prompt.includes('Prefer concise review findings.'))

    if (process.platform !== 'win32') {
      const escaped = path.join(tmp, 'escaped')
      fs.mkdirSync(escaped)
      const projectMemoryBase = path.join(cwd, '.ai-agent', 'agent-memory')
      fs.mkdirSync(path.dirname(projectMemoryBase), { recursive: true })
      fs.symlinkSync(escaped, projectMemoryBase, 'dir')
      assert.throws(
        () => loadAgentMemoryPrompt('unsafe', 'project', cwd),
        /escapes its project scope/,
      )
    }
  })
  console.log(
    'ok: agent memory scopes stay inside SSO tenant paths and symlinks',
  )
} finally {
  if (previousAuth === undefined) delete process.env.AUTH_ENABLED
  else process.env.AUTH_ENABLED = previousAuth
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('All agent-memory checks passed.')
