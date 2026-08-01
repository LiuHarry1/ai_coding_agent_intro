import React, { useMemo } from 'react'
import ExploredGroup from './ExploredGroup.jsx'
import { pickCard } from './pickToolCard.js'
import { expandToolGroup } from '../lib/timeline.js'

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
    const weight = run.type === 'explored_run' ? run.items.length : 1
    if (shown >= flatLimit) {
      hidden += weight
      continue
    }
    shown += weight
    if (run.type === 'explored_run') {
      nodes.push(
        <ExploredGroup
          key={run.items[0]?.id ?? `ex-${i}`}
          items={run.items}
        />,
      )
    } else {
      const Card = pickCard(run.part, { nested: true })
      nodes.push(
        <div className='subagent-nested-step' key={run.part.id ?? i}>
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
