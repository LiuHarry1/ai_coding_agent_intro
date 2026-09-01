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

/** Max nested tool rows when expanded (older steps stay behind a count chip). */
const NESTED_RENDER_CAP = 40

/**
 * Cursor explore / browser density:
 *   collapsed → muted "Explored N files" / "Ran N browser actions"
 *   expanded  → nested tool rows (bodies still collapsed)
 *
 * @param {{ items: object[], kind?: 'explore' | 'browser' }} props
 */
export default function ExploredGroup({ items, kind = 'explore' }) {
  const n = items.length
  const anyRunning = items.some(p => p.status !== 'done')
  const anyError = items.some(detectToolError)
  const allDone = !anyRunning
  const hasBody = true
  const densityKind = kind === 'browser' ? 'browser-group' : 'explore-group'

  const [expanded, toggle, chevron] = useToolDensityExpand(densityKind, {
    isDone: allDone,
    isError: anyError,
    isRunning: anyRunning,
    hasBody,
  })

  const live = useMemo(() => pickLiveMember(items), [items])
  const details = useMemo(() => summarizeExploredDetails(items), [items])

  const action = toolActionLabel(kind === 'browser' ? 'browser' : 'explore', {
    loading: anyRunning,
    hasError: anyError,
  })

  const title = anyRunning
    ? liveToolSubtitle(live) || '…'
    : details || `${n} tool${n === 1 ? '' : 's'}`

  const nestedItems = useMemo(() => {
    if (items.length <= NESTED_RENDER_CAP) return items
    return items.slice(-NESTED_RENDER_CAP)
  }, [items])
  const hiddenNested = items.length - nestedItems.length

  return (
    <div
      className={`tool-row explored-group ${kind === 'browser' ? 'explored-group--browser' : ''} ${anyError ? 'has-error' : ''} ${expanded ? 'is-open' : ''}`}
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
          {hiddenNested > 0 && (
            <div className='explored-group-earlier' aria-hidden='true'>
              {hiddenNested} earlier step{hiddenNested === 1 ? '' : 's'}
            </div>
          )}
          {nestedItems.map((item, i) => {
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
