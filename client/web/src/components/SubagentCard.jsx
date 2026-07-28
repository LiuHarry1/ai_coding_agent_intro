import React, { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { mdComponents } from '../lib/markdown-components.jsx'
import ToolRowHeader from './ToolRowHeader.jsx'
import NestedToolRuns from './NestedToolRuns.jsx'
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
 * Subagent row: one-line parent card with live subtitle; steps/report on expand.
 */

const TYPE_LABELS = {
  Explore: 'Explore',
  explore: 'Explore',
  Plan: 'Plan',
  plan: 'Plan',
  'general-purpose': 'Agent',
  general_purpose: 'Agent',
}

function labelFor(subagentType) {
  if (TYPE_LABELS[subagentType]) return TYPE_LABELS[subagentType]
  if (!subagentType) return 'Agent'
  return subagentType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export default function SubagentCard({ part }) {
  const args = part.args || {}
  const subagentType = args.subagent_type || part.name || 'subagent'
  const result = part.result
  const headline =
    args.description ||
    args.task ||
    (typeof args.prompt === 'string' ? args.prompt.slice(0, 120) : '')
  const fullPrompt = args.prompt || args.task || ''
  const isDone = part.status === 'done'
  const isError =
    isDone && typeof result === 'string' && result.startsWith('Error:')
  const label = labelFor(subagentType)

  const steps = useMemo(() => {
    const raw = Array.isArray(part.subagentParts) ? part.subagentParts : []
    return raw.filter(
      s =>
        s.type === 'tool_call' &&
        !SUPPRESSED_TOOL_CARDS.has(s.name) &&
        !SUBAGENT_SUPPRESSED.has(s.name),
    )
  }, [part.subagentParts])

  const [expanded, toggleExpanded, setExpanded] = useStreamingExpanded(false, {
    expandOnceWhen: isError,
  })
  const [stepsOpen, setStepsOpen] = useState(false)
  const [showAllSteps, setShowAllSteps] = useState(false)

  const summary = useMemo(() => summarizeToolSteps(steps), [steps])
  const liveStep = useMemo(() => pickLiveMember(steps), [steps])
  const subtitle = !isDone
    ? liveToolSubtitle(liveStep) || summary
    : summary

  const hasReport = isDone && typeof result === 'string' && result.length > 0

  const handleHeaderToggle = () => {
    if (!expanded && steps.length > 0 && !hasReport) {
      setStepsOpen(true)
    }
    toggleExpanded()
  }

  const handleStepToggle = e => {
    e.stopPropagation()
    if (!expanded) {
      setExpanded(true)
      setStepsOpen(true)
      return
    }
    setStepsOpen(v => !v)
  }

  const stepsToggle =
    steps.length > 0 ? (
      <button
        type='button'
        className={`subagent-step-toggle ${stepsOpen && expanded ? 'open' : ''}`}
        onClick={handleStepToggle}
        aria-expanded={expanded && stepsOpen}
        aria-label={stepsOpen && expanded ? 'Hide steps' : 'Show steps'}
      >
        {steps.length} step{steps.length === 1 ? '' : 's'}
      </button>
    ) : null

  return (
    <div className={`tool-row subagent-row ${isError ? 'has-error' : ''}`}>
      <ToolRowHeader
        expanded={expanded}
        onToggle={handleHeaderToggle}
        label={label}
        title={headline || '\u2026'}
        titleTooltip={fullPrompt || headline || undefined}
        subtitle={subtitle || undefined}
        meta={stepsToggle}
        duration={part.duration}
        isDone={isDone}
        isError={isError}
        showSuccess
      />

      {expanded && (
        <div className='subagent-expanded'>
          {steps.length > 0 && stepsOpen && (
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
                <pre className='subagent-result-error'>{result}</pre>
              ) : (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={mdComponents}
                >
                  {result}
                </ReactMarkdown>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
