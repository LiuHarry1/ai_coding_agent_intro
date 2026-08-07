import React, { useState, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { mdComponents } from '../lib/markdown-components.jsx'
import CopyButton from './CopyButton.jsx'
import ToolCallLine from './ToolCallLine.jsx'
import NestedToolRuns from './NestedToolRuns.jsx'
import { detectError, formatBytes } from '../lib/utils.js'
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
import { toolActionLabel, toolErrorDetails } from '../lib/tool-action-labels.js'

/**
 * Unified Skill row — inline stays collapsed; fork is one-line with live
 * subtitle (same density as SubagentCard).
 */
function skillArgsHint(args) {
  const raw = args?.arguments
  if (typeof raw !== 'string' || !raw.trim()) return null
  const t = raw.trim()
  return t.length > 72 ? `${t.slice(0, 72)}\u2026` : t
}

export default function SkillCard({ part, nested = false }) {
  const args = part.args || {}
  const result = part.result
  const isDone = part.status === 'done'
  const isError = isDone && detectError('Skill', result)
  const skillName = args.skill_name || args.skill || ''
  const hint = skillArgsHint(args)
  const hasBody = typeof result === 'string' && result.length > 0

  const steps = useMemo(() => {
    const raw = Array.isArray(part.subagentParts) ? part.subagentParts : []
    return raw.filter(
      s =>
        s.type === 'tool_call' &&
        !SUPPRESSED_TOOL_CARDS.has(s.name) &&
        !SUBAGENT_SUPPRESSED.has(s.name),
    )
  }, [part.subagentParts])
  const isFork = steps.length > 0

  const [expanded, toggleExpanded, setExpanded] = useStreamingExpanded(false, {
    expandOnceWhen: isError,
  })
  const [stepsOpen, setStepsOpen] = useState(false)
  const [showAllSteps, setShowAllSteps] = useState(false)

  const sizeLabel =
    isDone && !isError && hasBody && !isFork ? formatBytes(result.length) : null

  const summary = useMemo(() => summarizeToolSteps(steps), [steps])
  const liveStep = useMemo(() => pickLiveMember(steps), [steps])
  const subtitle = isFork
    ? !isDone
      ? liveToolSubtitle(liveStep) || hint || summary
      : hint || summary
    : hint

  const hasReport = isDone && hasBody

  const handleHeaderToggle = () => {
    if (!expanded && isFork && steps.length > 0 && !hasReport) {
      setStepsOpen(true)
    }
    toggleExpanded()
  }

  const stepsToggle =
    steps.length > 0 ? (
      <button
        type='button'
        className={`subagent-step-toggle ${stepsOpen && expanded ? 'open' : ''}`}
        onClick={e => {
          e.stopPropagation()
          if (!expanded) {
            setExpanded(true)
            setStepsOpen(true)
            return
          }
          setStepsOpen(v => !v)
        }}
        aria-expanded={expanded && stepsOpen}
        aria-label={stepsOpen && expanded ? 'Hide steps' : 'Show steps'}
      >
        {steps.length} step{steps.length === 1 ? '' : 's'}
      </button>
    ) : null

  const showChevron = isFork
    ? hasReport || steps.length > 0
    : Boolean(isDone && hasBody)

  const action = toolActionLabel('skill', {
    loading: !isDone,
    hasError: isError,
  })
  const title = isError
    ? toolErrorDetails(skillName || '\u2026', true)
    : skillName || '\u2026'

  return (
    <div
      className={`tool-row skill-card ${nested ? 'tool-row--nested' : ''} ${isError ? 'has-error' : ''}`}
    >
      <ToolCallLine
        expanded={expanded}
        onToggle={handleHeaderToggle}
        showChevron={showChevron}
        icon={'\u2699'}
        label={action}
        title={title}
        titleTooltip={[skillName, hint].filter(Boolean).join('\n') || undefined}
        subtitle={subtitle || undefined}
        meta={
          stepsToggle ||
          (sizeLabel ? (
            <span className='tool-row-meta-badge' title='Result size'>
              {sizeLabel}
            </span>
          ) : null)
        }
        duration={nested ? undefined : part.duration}
        isDone={isDone}
        isError={isError}
        showSuccess={isDone && !isError}
        actions={
          isDone && !isError && hasBody && !isFork ? (
            <CopyButton text={result} label='Copy' inline />
          ) : null
        }
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

          {isError && (
            <div className='tool-row-body tool-row-body--error'>{result}</div>
          )}
          {!isError && hasReport && isFork && (
            <div className='subagent-result'>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={mdComponents}
              >
                {result}
              </ReactMarkdown>
            </div>
          )}
          {!isError && hasBody && !isFork && (
            <pre className='tool-row-body'>{result}</pre>
          )}
        </div>
      )}
    </div>
  )
}
