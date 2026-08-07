import React, { useMemo } from 'react'
import ToolCallLine from './ToolCallLine.jsx'
import { pickCard } from './pickToolCard.js'
import { useStreamingExpanded } from '../lib/use-streaming-expanded.js'
import {
  liveToolSubtitle,
  pickLiveMember,
  summarizeToolSteps,
  detectToolError,
} from '../lib/tool-density.js'
import { toolPartKey } from '../lib/timeline.js'
import { toolActionLabel } from '../lib/tool-action-labels.js'

/**
 * Cursor-style "Explored N tools" group for consecutive built-in explore calls.
 * Compact one-line header by default (even while running); expand to inspect.
 * Auto-expands once when any member errors.
 */
export default function ExploredGroup({ items }) {
  const n = items.length
  const anyRunning = items.some(p => p.status !== 'done')
  const anyError = items.some(detectToolError)
  const allDone = !anyRunning

  const [expanded, toggle] = useStreamingExpanded(false, {
    expandOnceWhen: anyError,
  })

  const live = useMemo(() => pickLiveMember(items), [items])
  const summary = useMemo(() => summarizeToolSteps(items), [items])

  const subtitle = anyRunning ? liveToolSubtitle(live) : summary

  const duration = useMemo(() => {
    if (!allDone) return undefined
    let sum = 0
    let any = false
    for (const p of items) {
      if (typeof p.duration === 'number') {
        sum += p.duration
        any = true
      }
    }
    return any ? sum : undefined
  }, [items, allDone])

  const title = `${n} tool${n === 1 ? '' : 's'}`
  const action = toolActionLabel('explore', {
    loading: anyRunning,
    hasError: anyError,
  })

  return (
    <div
      className={`tool-row explored-group ${anyError ? 'has-error' : ''}`}
    >
      <ToolCallLine
        expanded={expanded}
        onToggle={toggle}
        label={action}
        title={title}
        subtitle={subtitle || undefined}
        duration={duration}
        isDone={allDone}
        isError={anyError}
        showSuccess={allDone && !anyError}
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
