import React, { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { mdComponents } from '../lib/markdown-components.jsx'
import NestedToolRuns from './NestedToolRuns.jsx'
import { useChatStore } from '../stores/chat-store.js'
import { useStreamingExpanded } from '../lib/use-streaming-expanded.js'
import {
  liveToolSubtitle,
  pickLiveMember,
  summarizeToolSteps,
} from '../lib/tool-density.js'
import {
  SUPPRESSED_TOOL_CARDS,
  SUBAGENT_SUPPRESSED,
} from './pickToolCard.js'

/**
 * Cursor-style Task row in the parent timeline:
 *   title + type badge (Task / Explorer / Plan)
 *     live status
 * Expand for nested tools + final report. Stop cancels this tool only.
 */

const TYPE_BADGES = {
  Explore: 'Explorer',
  explore: 'Explorer',
  Plan: 'Plan',
  plan: 'Plan',
  'general-purpose': 'Task',
  general_purpose: 'Task',
}

function badgeFor(subagentType) {
  if (TYPE_BADGES[subagentType]) return TYPE_BADGES[subagentType]
  if (!subagentType) return 'Task'
  return subagentType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function visibleSteps(part) {
  const raw = Array.isArray(part.subagentParts) ? part.subagentParts : []
  return raw.filter(
    s =>
      s.type === 'tool_call' &&
      !SUPPRESSED_TOOL_CARDS.has(s.name) &&
      !SUBAGENT_SUPPRESSED.has(s.name),
  )
}

function rowSubtitle(part, steps) {
  if (part.stopping) return 'Stopping…'
  if (part.status === 'done') {
    return summarizeToolSteps(steps)
  }
  const live = pickLiveMember(steps)
  const liveText = live && live.status !== 'done' ? liveToolSubtitle(live) : ''
  if (liveText) return liveText
  if (part.liveTask) return part.liveTask
  // Tools finished (or none yet) but report still generating.
  if (steps.length > 0 && steps.every(s => s.status === 'done')) {
    return 'Writing report…'
  }
  return 'Starting…'
}

export default function SubagentCard({ part }) {
  const stopSubagent = useChatStore(s => s.stopSubagent)
  const args = part.args || {}
  const subagentType = args.subagent_type || part.name || 'subagent'
  const headline =
    args.description ||
    args.task ||
    (typeof args.prompt === 'string' ? args.prompt.slice(0, 120) : '') ||
    '…'
  const fullPrompt = args.prompt || args.task || ''
  const isDone = part.status === 'done'
  const isError =
    isDone &&
    typeof part.result === 'string' &&
    part.result.startsWith('Error:')
  const badge = badgeFor(subagentType)

  const steps = useMemo(() => visibleSteps(part), [part.subagentParts])
  const subtitle = rowSubtitle(part, steps)
  // Auto-open nested steps while the task is live (Cursor task chrome).
  const [expanded, toggleExpanded] = useStreamingExpanded(
    !isDone && steps.length > 0,
  )
  const [showAllSteps, setShowAllSteps] = useState(false)
  const hasReport =
    isDone && typeof part.result === 'string' && part.result.length > 0

  const onStop = e => {
    e.stopPropagation()
    if (isDone || part.stopping || !part.toolCallId) return
    void stopSubagent(part.toolCallId)
  }

  return (
    <div
      className={`subagent-timeline-row ${isError ? 'has-error' : ''} ${expanded ? 'open' : ''}`}
    >
      <button
        type='button'
        className='subagent-timeline-header'
        onClick={toggleExpanded}
        aria-expanded={expanded}
      >
        <span className='subagent-timeline-icon' aria-hidden='true'>
          {!isDone ? (
            <span className='spinner spinner-sm' />
          ) : (
            <span className='subagent-timeline-dot' />
          )}
        </span>
        <span className='subagent-timeline-body'>
          <span className='subagent-timeline-title-line'>
            <span
              className='subagent-timeline-title'
              title={fullPrompt || headline}
            >
              {headline}
            </span>
            <span className='subagent-timeline-badge'>{badge}</span>
          </span>
          {subtitle && (
            <span className='subagent-timeline-subtitle'>{subtitle}</span>
          )}
        </span>
        {!isDone && part.toolCallId && (
          <span
            className='subagent-timeline-actions'
            onClick={e => e.stopPropagation()}
          >
            <button
              type='button'
              className='subagent-stop-btn'
              onClick={onStop}
              disabled={!!part.stopping}
            >
              Stop
            </button>
          </span>
        )}
      </button>

      {expanded && (steps.length > 0 || hasReport) && (
        <div className='subagent-timeline-expanded'>
          {steps.length > 0 && (
            <NestedToolRuns
              steps={steps}
              showAllSteps={showAllSteps}
              onShowAll={() => setShowAllSteps(true)}
            />
          )}
          {hasReport && (
            <div
              className={`subagent-result ${isError ? 'subagent-result--error' : ''}`}
            >
              {isError ? (
                <pre className='subagent-result-error'>{part.result}</pre>
              ) : (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={mdComponents}
                >
                  {part.result}
                </ReactMarkdown>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
