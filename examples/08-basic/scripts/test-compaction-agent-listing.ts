/**
 * Post-compact agent_listing_delta re-announce (CC-aligned).
 * Run: npx tsx examples/08-basic/scripts/test-compaction-agent-listing.ts
 */
import * as path from 'path'
import { fileURLToPath } from 'url'
import { AGENT_TOOL_NAME } from '../constants/tool_names.js'
import { isAttachmentMessage } from '../core/types.js'
import {
  buildPostCompactAttachmentMessages,
  countPostCompactAgentListing,
} from '../services/compact/post-compact-attachments.js'
import { loadAgentDefinitionsForWorkspace } from '../tools/AgentTool/loadAgents.js'
import { defaultRegistry } from '../tools/index.js'
import { registerSubagents } from '../tools/AgentTool/index.js'
import { expandAttachmentMessagesForAPI } from '../utils/messages.js'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
)

async function testReadOnlyLoad(): Promise<void> {
  const before = defaultRegistry.get(AGENT_TOOL_NAME)?.description ?? ''
  const defs = await loadAgentDefinitionsForWorkspace(repoRoot)
  const after = defaultRegistry.get(AGENT_TOOL_NAME)?.description ?? ''
  if (before !== after) {
    throw new Error('loadAgentDefinitionsForWorkspace mutated defaultRegistry')
  }
  if (!defs.activeAgents.some(a => a.agentType === 'db-migrator')) {
    console.log('[skip] db-migrator not in repo')
  } else {
    console.log('[ok] read-only load does not mutate registry')
  }
}

async function testRegisterStillWorks(): Promise<void> {
  const { activeAgents } = await registerSubagents(defaultRegistry, repoRoot)
  const tool = defaultRegistry.get(AGENT_TOOL_NAME)
  if (!tool) throw new Error('Agent tool missing after registerSubagents')
  if (!activeAgents.some(a => a.agentType === 'Explore')) {
    throw new Error('Explore missing from activeAgents')
  }
  console.log('[ok] registerSubagents still registers Agent tool')
}

async function testPostCompactAttachments(): Promise<void> {
  const msgs = await buildPostCompactAttachmentMessages(repoRoot, {
    toolNames: [AGENT_TOOL_NAME, 'Read'],
  })
  if (countPostCompactAgentListing(msgs) !== 1) {
    throw new Error(`expected 1 agent_listing_delta, got ${msgs.length}`)
  }
  const att = msgs[0]!
  if (!isAttachmentMessage(att) || att.attachment.type !== 'agent_listing_delta') {
    throw new Error('expected agent_listing_delta attachment')
  }
  if (!att.attachment.isInitial) {
    throw new Error('post-compact should be initial announce (messages=[])')
  }
  const api = expandAttachmentMessagesForAPI([att])
  const text = JSON.stringify(api)
  if (!text.includes('system-reminder') || !text.includes('Explore')) {
    throw new Error('agent listing not expanded to system-reminder with Explore')
  }
  console.log('[ok] post-compact agent_listing_delta → system-reminder')

  const noAgent = await buildPostCompactAttachmentMessages(repoRoot, {
    toolNames: ['Read'],
  })
  if (noAgent.length !== 0) {
    throw new Error('should skip agent delta when Agent tool absent')
  }
  console.log('[ok] skips agent delta when Agent tool not in enrichment')
}

async function main(): Promise<void> {
  await testReadOnlyLoad()
  await testRegisterStillWorks()
  await testPostCompactAttachments()
  console.log('\nAll compaction agent-listing tests passed.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
