import { parseAgentFromMarkdown, findPrimaryAgent } from '../tools/AgentTool/mergeAgents.js'
import { AGENT_TOOL_NAME } from '../constants/tool_names.js'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

const smart = parseAgentFromMarkdown({
  filePath: 'x/smartest.md',
  baseDir: 'x',
  source: 'project',
  frontmatter: {
    name: 'smartest',
    label: 'SmarTest Agent',
    description: 'Write SmarTest programs',
    mode: 'primary',
    disallowedTools: 'search-memory_*',
  },
  body: 'You are SmarTest.',
})
assert(!!smart.agent, smart.error || 'no agent')
assert(smart.agent!.mode === 'primary', 'mode primary')
assert(
  smart.agent!.disallowedTools?.includes('search-memory_*') === true,
  'keeps glob',
)
assert(
  !smart.agent!.disallowedTools?.includes(AGENT_TOOL_NAME),
  'primary does not auto-deny Agent tool',
)

const reserved = parseAgentFromMarkdown({
  filePath: 'x/plan.md',
  baseDir: 'x',
  source: 'project',
  frontmatter: { name: 'Plan', description: 'bad', mode: 'primary' },
  body: 'nope',
})
assert(!!reserved.error, 'expected reserved primary name error')

const sub = parseAgentFromMarkdown({
  filePath: 'x/helper.md',
  baseDir: 'x',
  source: 'project',
  frontmatter: {
    name: 'helper',
    description: 'A helper',
  },
  body: 'Help.',
})
assert(sub.agent?.mode === 'subagent', 'default subagent')
assert(
  sub.agent!.disallowedTools?.includes(AGENT_TOOL_NAME) === true,
  'subagent auto-denies Agent',
)

assert(!!findPrimaryAgent([smart.agent!], 'smartest'), 'findPrimary')
assert(findPrimaryAgent([sub.agent!], 'helper') === null, 'sub not primary')

console.log('primary agent parse checks passed')
