import React, { useMemo } from 'react'
import ToolCallLine from './ToolCallLine.jsx'
import { pickCard } from './pickToolCard.js'
import { useToolDensityExpand } from '../lib/use-tool-density-expand.js'
import {
  liveToolSubtitle,
  pickLiveMember,
  summarizeExploredDetails,
  detectToolError,
} from '../lib/tool-density.js'
import { toolPartKey } from '../lib/timeline.js'
import { toolActionLabel } from '../lib/tool-action-labels.js'

/**
 * Cursor explore density:
 *   collapsed → muted "Explored N files"
 *   expanded  → nested tool rows (bodies still collapsed)
 */
export default function ExploredGroup({ items }) {
  const n = items.length
  const anyRunning = items.some(p => p.status !== 'done')
  const anyError = items.some(detectToolError)
  const allDone = !anyRunning
  const hasBody = true

  const [expanded, toggle, chevron] = useToolDensityExpand('explore-group', {
    isDone: allDone,
    isError: anyError,
    isRunning: anyRunning,
    hasBody,
  })

  const live = useMemo(() => pickLiveMember(items), [items])
  const details = useMemo(() => summarizeExploredDetails(items), [items])

  const action = toolActionLabel('explore', {
    loading: anyRunning,
    hasError: anyError,
  })

  const title = anyRunning
    ? liveToolSubtitle(live) || '…'
    : details || `${n} tool${n === 1 ? '' : 's'}`

  return (
    <div
      className={`tool-row explored-group ${anyError ? 'has-error' : ''} ${expanded ? 'is-open' : ''}`}
    >
      <ToolCallLine
        expanded={expanded}
        onToggle={toggle}
        showChevron={chevron.showChevron}
        chevronSlot={chevron.chevronSlot}
        label={action}
        title={title}
        titlePlain
        isDone={allDone}
        isError={anyError}
        showSuccess={false}
      />

      {expanded && (
        <div className='explored-group-body'>
          {items.map((item, i) => {
            const Card = pickCard(item, { nested: true })
            return (
              <div
                className='explored-group-step'
                key={toolPartKey(item, `step-${i}`)}
              >
                <Card part={item} nested />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
