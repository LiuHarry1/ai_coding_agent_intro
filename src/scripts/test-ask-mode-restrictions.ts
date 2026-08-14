/**
 * Ask mode must not expose ToolSearch / deferred mutating tools.
 */
import { applyModeRestrictions } from '../core/mode-restrictions.js'
import {
  BASH_TOOL_NAME,
  READ_ONLY_TOOLS,
  TOOL_SEARCH_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../constants/tool_names.js'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

const fake = (name: string) => ({ name, description: name }) as never

const tools = {
  [READ_ONLY_TOOLS[0]!]: fake(READ_ONLY_TOOLS[0]!),
  [WRITE_FILE_TOOL_NAME]: fake(WRITE_FILE_TOOL_NAME),
  [BASH_TOOL_NAME]: fake(BASH_TOOL_NAME),
  [TOOL_SEARCH_TOOL_NAME]: fake(TOOL_SEARCH_TOOL_NAME),
}

const ask = applyModeRestrictions('ask', tools)
assert(!ask[WRITE_FILE_TOOL_NAME], 'ask drops Write')
assert(!ask[BASH_TOOL_NAME], 'ask drops Bash')
assert(!ask[TOOL_SEARCH_TOOL_NAME], 'ask drops ToolSearch')
for (const name of READ_ONLY_TOOLS) {
  if (tools[name]) assert(ask[name], `ask keeps ${name}`)
}

const agent = applyModeRestrictions('agent', tools)
assert(agent[WRITE_FILE_TOOL_NAME], 'agent keeps Write')
assert(agent[TOOL_SEARCH_TOOL_NAME], 'agent keeps ToolSearch')

console.log('ask-mode restriction tests OK')
