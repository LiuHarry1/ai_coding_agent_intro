import React, { useMemo } from 'react'
import ExploredGroup from './ExploredGroup.jsx'
import { pickCard } from './pickToolCard.js'
import { expandToolGroup } from '../lib/tool-density.js'
import { toolPartKey } from '../lib/timeline.js'

const STEP_PREVIEW_LIMIT = 6

/**
 * Render nested tool_call steps with Cursor-style Explored coalescing.
 */
export default function NestedToolRuns({
  steps,
  showAllSteps = false,
  onShowAll,
  previewLimit = STEP_PREVIEW_LIMIT,
}) {
  const runs = useMemo(() => expandToolGroup(steps).runs, [steps])
  const flatLimit = showAllSteps ? Infinity : previewLimit

  let shown = 0
  const nodes = []
  let hidden = 0

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]
    const isGroup = run.type === 'explored_run' || run.type === 'browser_run'
    const weight = isGroup ? run.items.length : 1
    if (shown >= flatLimit) {
      hidden += weight
      continue
    }
    shown += weight
    if (isGroup) {
      const first = toolPartKey(run.items[0], `nex-a-${i}`)
      const last = toolPartKey(
        run.items[run.items.length - 1],
        `nex-b-${i}`,
      )
      nodes.push(
        <ExploredGroup
          key={`${run.type}-${first}-${last}`}
          items={run.items}
          kind={run.type === 'browser_run' ? 'browser' : 'explore'}
        />,
      )
    } else {
      const Card = pickCard(run.part, { nested: true })
      nodes.push(
        <div
          className='subagent-nested-step'
          key={toolPartKey(run.part, `nstep-${i}`)}
        >
          <Card part={run.part} nested />
        </div>,
      )
    }
  }

  return (
    <div className='subagent-steps'>
      {nodes}
      {hidden > 0 && typeof onShowAll === 'function' && (
        <button
          type='button'
          className='subagent-more'
          onClick={e => {
            e.stopPropagation()
            onShowAll()
          }}
        >
          Show {hidden} more step{hidden === 1 ? '' : 's'}
        </button>
      )}
    </div>
  )
}
