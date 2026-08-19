import { parseAgentFromMarkdown, findPrimaryAgent } from '../tools/AgentTool/mergeAgents.js'
import { AGENT_TOOL_NAME } from '../constants/tool_names.js'
import { browserAgentSessionSection } from '../prompts/browser-agent-session.js'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

const smart = parseAgentFromMarkdown({
  filePath: 'x/reviewer.md',
  baseDir: 'x',
  source: 'project',
  frontmatter: {
    name: 'reviewer',
    label: 'Code Reviewer',
    description: 'Review code before merge',
    mode: 'primary',
    disallowedTools: 'search-memory_*',
  },
  body: 'You are the code reviewer.',
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

assert(!!findPrimaryAgent([smart.agent!], 'reviewer'), 'findPrimary')
assert(findPrimaryAgent([sub.agent!], 'helper') === null, 'sub not primary')

const isolated = browserAgentSessionSection('isolated')
assert(isolated.includes('agent-only Chrome'), 'isolated names the profile')
assert(isolated.includes('browser_navigate'), 'isolated starts with navigate')
const extension = browserAgentSessionSection('extension')
assert(extension.includes('browser_tabs'), 'extension lists tabs first')
assert(
  extension.includes("user's signed-in Chrome"),
  'extension names user Chrome',
)

const handoff = browserAgentSessionSection('isolated', {
  url: 'http://localhost:5173/login',
  title: 'Login',
  targetId: 'tab-9',
})
assert(handoff.includes('localhost:5173/login'), 'handoff names the open URL')
assert(handoff.includes('tab-9'), 'handoff names the tab')
assert(handoff.includes('Reuse'), 'handoff tells the model to reuse')

console.log('primary agent parse checks passed')
