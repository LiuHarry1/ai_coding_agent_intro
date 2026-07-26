/**
 * Quick smoke test for recursive agent loading + agent_listing_delta.
 * Run: npx tsx src/scripts/test-agent-loading.ts
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { loadMarkdownConfigs } from '../utils/markdownConfigLoader.js'
import { mergeAgents } from '../tools/AgentTool/mergeAgents.js'
import { BUILTIN_AGENTS } from '../tools/AgentTool/index.js'
import {
  getAgentListingDeltaAttachments,
  shouldInjectAgentListInMessages,
} from '../tools/AgentTool/agentListing.js'
import { expandAttachmentMessagesForAPI } from '../utils/messages.js'
import type { ToolUseContext } from '../core/types.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)

async function testRecursiveTmp(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-load-'))
  const agentsDir = path.join(tmp, '.ai-agent', 'agents')
  fs.mkdirSync(path.join(agentsDir, 'nested'), { recursive: true })
  fs.writeFileSync(
    path.join(agentsDir, 'nested', 'nested-agent.md'),
    '---\nname: nested-agent\ndescription: nested test\n---\nNested body\n',
  )
  fs.writeFileSync(
    path.join(agentsDir, 'root-agent.md'),
    '---\nname: root-agent\ndescription: root test\n---\nRoot body\n',
  )

  const files = await loadMarkdownConfigs('agents', tmp)
  const rel = files.map(f => path.relative(tmp, f.filePath).replace(/\\/g, '/'))
  if (!rel.includes('.ai-agent/agents/nested/nested-agent.md')) {
    throw new Error(`nested agent not found in scan: ${rel.join(', ')}`)
  }
  const { agents } = mergeAgents(BUILTIN_AGENTS, files)
  if (!agents.some(a => a.agentType === 'nested-agent')) {
    throw new Error('nested-agent not in active agents')
  }
  console.log('[ok] recursive tmp scan')
}

async function testRepoDbMigrator(): Promise<void> {
  const files = await loadMarkdownConfigs('agents', repoRoot)
  const { agents } = mergeAgents(BUILTIN_AGENTS, files)
  if (!agents.some(a => a.agentType === 'db-migrator')) {
    console.log(
      '[skip] db-migrator not in repo (optional):',
      agents.map(a => a.agentType).join(', '),
    )
    return
  }
  console.log('[ok] repo db-migrator loaded')
}

function testAgentListingDelta(): void {
  const agents = [
    ...BUILTIN_AGENTS.map(b => ({ ...b, source: 'built-in' as const })),
    {
      agentType: 'demo-custom',
      whenToUse: 'Demo',
      description: 'Demo',
      systemPrompt: 'Demo',
      source: 'project' as const,
      filePath: '/tmp/demo.md',
    },
  ]
  const ctx: ToolUseContext = {
    cwd: repoRoot,
    session: { id: 't', permissionMode: { mode: 'agent' } } as ToolUseContext['session'],
    readFileState: new Map(),
    agentDefinitions: { activeAgents: agents },
    options: { tools: { Agent: {} as ToolUseContext['options']['tools'][string] } },
  }
  const deltas = getAgentListingDeltaAttachments(ctx, [])
  if (!shouldInjectAgentListInMessages()) {
    console.log('[skip] agent list injection disabled via env')
    return
  }
  if (deltas.length !== 1 || !deltas[0]!.isInitial) {
    throw new Error('expected initial agent_listing_delta')
  }
  const apiMsgs = expandAttachmentMessagesForAPI([
    {
      type: 'attachment',
      attachment: deltas[0]!,
      uuid: '1',
      timestamp: new Date().toISOString(),
      isMeta: true,
    },
  ])
  const text = JSON.stringify(apiMsgs)
  if (!text.includes('demo-custom') || !text.includes('system-reminder')) {
    throw new Error('agent listing not expanded to system-reminder')
  }
  console.log('[ok] agent_listing_delta → system-reminder')
}

async function main(): Promise<void> {
  await testRecursiveTmp()
  await testRepoDbMigrator()
  testAgentListingDelta()
  console.log('All agent loading smoke tests passed.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
