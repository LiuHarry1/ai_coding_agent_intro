/**
 * Quick unit checks for toolGlob matching used by primary agent MCP isolation.
 */
import {
  matchToolGlob,
  isToolNameDisallowed,
  filterToolsRecordByDisallowedGlobs,
  filterDeferredDefsByDisallowedGlobs,
} from '../tools/AgentTool/toolGlob.js'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

assert(matchToolGlob('search-memory_foo', 'search-memory_*'), 'prefix glob')
assert(!matchToolGlob('tdc-docs_bar', 'search-memory_*'), 'non-match')
assert(matchToolGlob('Read', 'Read'), 'exact')
assert(
  isToolNameDisallowed('SMT8_test_method_best_practice_x', [
    'tdc-docs_*',
    'SMT8_test_method_best_practice_*',
  ]),
  'multi pattern',
)

const filtered = filterToolsRecordByDisallowedGlobs(
  {
    Read: 1,
    'search-memory_a': 2,
    'tdc-docs_b': 3,
  },
  ['search-memory_*'],
)
assert(filtered.Read === 1, 'keep Read')
assert(filtered['search-memory_a'] === undefined, 'drop memory')
assert(filtered['tdc-docs_b'] === 3, 'keep tdc')

const defs = filterDeferredDefsByDisallowedGlobs(
  [
    { name: 'search-memory_a', description: 'x' },
    { name: 'tdc-docs_b', description: 'y' },
  ],
  ['search-memory_*'],
)
assert(defs.length === 1 && defs[0]!.name === 'tdc-docs_b', 'deferred filter')

console.log('toolGlob checks passed')
