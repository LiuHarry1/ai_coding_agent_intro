import { parseAgentFromMarkdown, findPrimaryAgent } from '../tools/AgentTool/mergeAgents.js'
import { AGENT_TOOL_NAME } from '../constants/tool_names.js'
import { browserAgentSessionSection } from '../prompts/browser-agent-session.js'
import { getSystemPromptForAgentProfile } from '../prompts/agent-profile.js'
import { computeSimpleEnvInfo } from '../constants/prompts.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  CDP_DESCRIPTION,
  CDP_SUMMARY,
  CLICK_DESCRIPTION,
  FILL_FORM_DESCRIPTION,
  LOCK_DESCRIPTION,
  SNAPSHOT_DESCRIPTION,
  TYPE_DESCRIPTION,
  WAIT_FOR_DESCRIPTION,
} from '../tools/BrowserTool/prompt.js'

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
assert(!isolated.includes('Electron'), 'session is not Cursor-host CDP copy')
assert(
  !isolated.includes('Runtime.evaluate'),
  'CDP usage lives on the tool, not the session',
)
const extension = browserAgentSessionSection('extension')
assert(extension.includes('browser_tabs'), 'extension lists tabs first')
assert(
  extension.includes("user's signed-in Chrome"),
  'extension names user Chrome',
)
assert(
  extension.includes('browser_lock'),
  'extension names lock for captcha',
)
assert(!extension.includes('Electron'), 'extension session is not Cursor-host copy')
assert(
  !extension.includes('browser.mode'),
  'extension session does not tell the model to switch Chrome product',
)

const handoff = browserAgentSessionSection('isolated', {
  url: 'http://localhost:5173/login',
  title: 'Login',
  targetId: 'tab-9',
})
assert(handoff.includes('localhost:5173/login'), 'handoff names the open URL')
assert(handoff.includes('tab-9'), 'handoff names the tab')
assert(handoff.includes('Reuse'), 'handoff tells the model to reuse')

assert(
  CDP_SUMMARY.includes('Runtime.evaluate'),
  'CDP summary is findable via ToolSearch',
)
assert(
  CDP_DESCRIPTION.includes('Runtime.evaluate'),
  'CDP description names evaluate',
)
assert(
  !CDP_DESCRIPTION.includes('Electron'),
  'CDP description is not Cursor-host copy',
)
assert(LOCK_DESCRIPTION.includes('unlock'), 'lock prompt names unlock')
assert(LOCK_DESCRIPTION.includes('lock'), 'lock prompt names lock')
assert(
  FILL_FORM_DESCRIPTION.includes('Runtime.evaluate'),
  'fill_form points unlabeled fields at CDP',
)
assert(
  CLICK_DESCRIPTION.includes('stale ref fails'),
  'click matches fail-then-one-recovery',
)
assert(
  !TYPE_DESCRIPTION.includes('do not reuse old refs'),
  'type does not repeat the snapshot primer',
)
assert(
  !WAIT_FOR_DESCRIPTION.includes('e12'),
  'wait_for does not repeat the snapshot primer',
)
assert(
  SNAPSHOT_DESCRIPTION.includes('maxDepth 20'),
  'snapshot defaults match Cursor maxDepth 20',
)
assert(
  SNAPSHOT_DESCRIPTION.includes('mode=full'),
  'snapshot default mode is full',
)
assert(
  SNAPSHOT_DESCRIPTION.includes('Passing `[ref=eN]` is rejected'),
  'snapshot rejects [ref=eN] as CSS selector',
)
assert(
  !SNAPSHOT_DESCRIPTION.includes('never full'),
  'snapshot does not forbid repeated full captures',
)
assert(
  !SNAPSHOT_DESCRIPTION.includes('at most once'),
  'snapshot does not cap full at once',
)

const browserMd = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../.ai-agent/agents/browser.md',
  ),
  'utf8',
)
assert(
  /^omitProjectRules:\s*true\s*$/m.test(browserMd),
  'browser.md omits AGENTS.md / project rules',
)
assert(
  browserMd.includes('maxDepth 20'),
  'browser.md matches Cursor snapshot depth',
)
assert(
  !browserMd.includes('never full'),
  'browser.md does not forbid repeated snapshots',
)

const browserProfile = parseAgentFromMarkdown({
  filePath: 'x/browser.md',
  baseDir: 'x',
  source: 'project',
  frontmatter: {
    name: 'browser',
    description: 'Drive a browser',
    mode: 'primary',
    omitProjectRules: true,
    tools: 'Bash',
  },
  body: 'You are a Browser Automation specialist.',
})
assert(!!browserProfile.agent, browserProfile.error || 'no browser agent')
assert(
  browserProfile.agent!.omitProjectRules === true,
  'omitProjectRules parsed',
)

const withRules = await getSystemPromptForAgentProfile(
  browserProfile.agent!,
  process.cwd(),
  '# Agent instructions\nDo not commit secrets.',
  undefined,
  'test-model',
)
assert(
  !withRules.includes('Do not commit secrets'),
  'browser profile must not append AGENTS.md',
)
assert(
  !withRules.includes('# Agent instructions'),
  'browser profile must not append project rules heading',
)

const env = await computeSimpleEnvInfo('')
if (process.platform === 'win32') {
  assert(!env.includes('Shell: unknown'), 'Windows env must not say Shell: unknown')
  assert(env.includes('Git Bash') || env.includes('bash'), 'Windows env names the Bash tool shell')
}

console.log('primary agent parse checks passed')
