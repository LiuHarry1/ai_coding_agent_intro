/**
 * Density policy fixture tests (node:test).
 * Run: node --test client/web/src/lib/tool-density-policy.test.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveExpandArgs,
  resolveChevron,
} from './tool-density-policy.js'
import {
  getToolDensityKind,
  listSuppressTranscriptNames,
  EXPLORE_GROUPABLE_NAMES,
} from './tool-registry-meta.js'
import {
  SUPPRESSED_TOOL_CARDS,
  TOOL_SEARCH,
  READ,
  GREP,
  BROWSER_NAVIGATE,
} from './tool-names.js'
import { summarizeExploredDetails, coalesceToolRuns } from './tool-density.js'
import { sanitizeToolUpdatePayload } from './sanitize-tool-ui.js'
import { formatWorkedDuration } from './timeline.js'

describe('resolveExpandArgs', () => {
  it('explore-group opens while running, collapses when done', () => {
    assert.deepEqual(
      resolveExpandArgs('explore-group', { isRunning: true, hasBody: true }),
      { isRunning: true, expandOnceWhen: false },
    )
    assert.deepEqual(
      resolveExpandArgs('explore-group', { isDone: true }),
      { isRunning: false, expandOnceWhen: false },
    )
  })

  it('explore-line never auto-opens on success', () => {
    const a = resolveExpandArgs('explore-line', {
      isDone: true,
      isError: false,
      hasBody: true,
    })
    assert.equal(a.isRunning, false)
    assert.equal(a.expandOnceWhen, false)
  })

  it('explore-line expands once on error', () => {
    const a = resolveExpandArgs('explore-line', {
      isDone: true,
      isError: true,
    })
    assert.equal(a.expandOnceWhen, true)
  })

  it('shell does not auto-open success output', () => {
    const a = resolveExpandArgs('shell', {
      isDone: true,
      isError: false,
      hasLiveOutput: false,
    })
    assert.equal(a.expandOnceWhen, false)
  })

  it('read expands once for images via forceExpandOnce', () => {
    const a = resolveExpandArgs('read', {
      isDone: true,
      forceExpandOnce: true,
    })
    assert.equal(a.expandOnceWhen, true)
  })
})

describe('resolveChevron', () => {
  it('explore-group always shows chevron', () => {
    assert.deepEqual(resolveChevron('explore-group', {}), {
      showChevron: true,
      chevronSlot: false,
    })
  })

  it('read header-only reserves chevron slot when nested', () => {
    assert.deepEqual(
      resolveChevron('read', { nested: true, headerOnly: true }),
      { showChevron: false, chevronSlot: true },
    )
  })

  it('subagent shows chevron when hasBody', () => {
    assert.equal(
      resolveChevron('subagent', { hasBody: true }).showChevron,
      true,
    )
    assert.equal(
      resolveChevron('subagent', { hasBody: false }).showChevron,
      false,
    )
  })
})

describe('TOOL_META density', () => {
  it('maps Read/Grep to density kinds', () => {
    assert.equal(getToolDensityKind(READ), 'read')
    assert.equal(getToolDensityKind(GREP), 'explore-line')
    assert.equal(getToolDensityKind(BROWSER_NAVIGATE), 'explore-line')
  })

  it('keeps ToolSearch suppressed in sync with TOOL_META', () => {
    assert.ok(SUPPRESSED_TOOL_CARDS.has(TOOL_SEARCH))
    assert.ok(listSuppressTranscriptNames().includes(TOOL_SEARCH))
  })

  it('does not explore-group ToolSearch', () => {
    assert.equal(EXPLORE_GROUPABLE_NAMES.has(TOOL_SEARCH), false)
  })
})

describe('summarizeExploredDetails', () => {
  it('formats mixed read+grep like Cursor', () => {
    const s = summarizeExploredDetails([
      { name: READ },
      { name: GREP },
    ])
    assert.equal(s, '1 file, 1 search')
  })

  it('formats pure reads as N files', () => {
    assert.equal(
      summarizeExploredDetails([{ name: READ }, { name: READ }]),
      '2 files',
    )
  })
})

describe('coalesceToolRuns', () => {
  const part = name => ({ type: 'tool_call', name })

  it('keeps two Reads as singles (Cursor Pol ≥ 3)', () => {
    const runs = coalesceToolRuns([part(READ), part(READ)])
    assert.equal(runs.length, 2)
    assert.ok(runs.every(r => r.type === 'tool'))
  })

  it('folds three Reads into explored_run', () => {
    const runs = coalesceToolRuns([part(READ), part(READ), part(READ)])
    assert.equal(runs.length, 1)
    assert.equal(runs[0].type, 'explored_run')
  })

  it('folds two Greps at N ≥ 2', () => {
    const runs = coalesceToolRuns([part(GREP), part(GREP)])
    assert.equal(runs[0].type, 'explored_run')
  })

  it('folds consecutive browser_* at N ≥ 2', () => {
    const runs = coalesceToolRuns([
      part('browser_navigate'),
      part('browser_click'),
    ])
    assert.equal(runs[0].type, 'browser_run')
  })
})

describe('sanitizeToolUpdatePayload', () => {
  it('does not chop long bash output', () => {
    const log = 'ok\n'.repeat(300)
    const out = sanitizeToolUpdatePayload('Bash', { result: log })
    assert.equal(out.result, log)
  })

  it('strips legacy page snapshots from browser results', () => {
    const out = sanitizeToolUpdatePayload('browser_snapshot', {
      result: 'Loaded.\nCurrent page snapshot\n- heading [ref=e1]',
    })
    assert.equal(out.result, 'Loaded.')
  })
})

describe('formatWorkedDuration', () => {
  it('ceils sub-second work to 1s', () => {
    assert.equal(formatWorkedDuration(500), 'for 1s')
  })
})
