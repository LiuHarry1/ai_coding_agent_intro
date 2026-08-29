/**
 * Browser main-thread enablement (CC-style opt-in).
 * Run: npx tsx src/scripts/test-browser-enablement.ts
 */
import assert from 'node:assert/strict'
import { defaultRegistry } from '../tools.js'
import { assembleToolPool } from '../tools/assembleToolPool.js'
import {
  BROWSER_AGENT_TOOLS,
  BROWSER_AGENT_TYPE,
  BROWSER_TOOLS_DENY_GLOB,
  browserDenyGlobsForMainThread,
  isBrowserEnabledForMainThread,
} from '../browser/enablement.js'
import {
  ASK_USER_QUESTION_TOOL_NAME,
  BROWSER_CDP_TOOL_NAME,
  BROWSER_DRAG_TOOL_NAME,
  BROWSER_GET_BOUNDING_BOX_TOOL_NAME,
  BROWSER_HIGHLIGHT_TOOL_NAME,
  BROWSER_CLICK_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  LSP_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from '../constants/tool_names.js'
import type { Session, ToolContext } from '../core/types.js'

function minimalSession(agentType: string | null): Session {
  return {
    id: 't',
    cwd: process.cwd(),
    agentType,
    permissionMode: { mode: 'agent' },
    messages: [],
    discoveredTools: new Set(),
  } as Session
}

function minimalToolContext(): ToolContext {
  return {
    eventBus: { emit() {}, on() {}, off() {} } as ToolContext['eventBus'],
    wire: { emit() {} } as ToolContext['wire'],
    cwd: process.cwd(),
  }
}

function poolFor(agentType: string | null, browser?: { enabled?: boolean }) {
  return assembleToolPool({
    registry: defaultRegistry,
    cwd: process.cwd(),
    session: minimalSession(agentType),
    toolContext: minimalToolContext(),
    mcpTools: {},
    activeAgents: [
      {
        agentType: BROWSER_AGENT_TYPE,
        whenToUse: 'browser',
        description: 'browser',
        systemPrompt: 'browser',
        mode: 'primary',
        tools: [...BROWSER_AGENT_TOOLS],
      },
    ],
    toolEnablement: {},
    browserConfig: browser,
  })
}

assert.equal(isBrowserEnabledForMainThread(null, {}), false)
assert.equal(isBrowserEnabledForMainThread('reviewer', {}), false)
assert.equal(isBrowserEnabledForMainThread(BROWSER_AGENT_TYPE, {}), true)
assert.equal(isBrowserEnabledForMainThread(null, { enabled: true }), true)
console.log('ok enablement helpers')

assert.deepEqual(browserDenyGlobsForMainThread(null, {}), [BROWSER_TOOLS_DENY_GLOB])
assert.deepEqual(browserDenyGlobsForMainThread(BROWSER_AGENT_TYPE, {}), [])
console.log('ok deny globs')

const defaultPool = poolFor(null)
assert.ok(!(BROWSER_CLICK_TOOL_NAME in defaultPool.tools))
assert.ok(!(BROWSER_CLICK_TOOL_NAME in (defaultPool.deferredToolPool ?? {})))
assert.ok(!defaultPool.deferredDefs.some(d => d.name.startsWith('browser_')))
console.log('ok default agent has no browser tools')

const browserPool = poolFor(BROWSER_AGENT_TYPE)
assert.ok(BROWSER_CLICK_TOOL_NAME in browserPool.tools)
assert.ok(BROWSER_DRAG_TOOL_NAME in browserPool.tools)
assert.ok(BROWSER_HIGHLIGHT_TOOL_NAME in browserPool.tools)
assert.ok(BROWSER_GET_BOUNDING_BOX_TOOL_NAME in browserPool.tools)
assert.ok(BROWSER_CDP_TOOL_NAME in browserPool.tools)
assert.ok(!(LSP_TOOL_NAME in browserPool.tools))
assert.ok(!(WEB_SEARCH_TOOL_NAME in browserPool.tools))
assert.ok(!(TOOL_SEARCH_TOOL_NAME in browserPool.tools))
assert.ok(!(ASK_USER_QUESTION_TOOL_NAME in browserPool.tools))
assert.ok(!(ENTER_PLAN_MODE_TOOL_NAME in browserPool.tools))
console.log('ok browser primary loads curated tool set')

const optedIn = poolFor(null, { enabled: true })
assert.ok(!(BROWSER_CLICK_TOOL_NAME in optedIn.tools))
assert.ok(BROWSER_CLICK_TOOL_NAME in (optedIn.deferredToolPool ?? {}))
assert.ok(TOOL_SEARCH_TOOL_NAME in optedIn.tools)
console.log('ok browser.enabled keeps deferred browser tools')

console.log('\nall browser enablement tests passed')
