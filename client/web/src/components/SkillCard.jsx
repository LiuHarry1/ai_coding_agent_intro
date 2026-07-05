import React, { useState, useMemo, useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { mdComponents } from '../lib/markdown-components.jsx'
import CopyButton from './CopyButton.jsx'
import ToolRowHeader from './ToolRowHeader.jsx'
import { detectError, formatBytes } from '../lib/utils.js'
import {
  pickCard,
  SUPPRESSED_TOOL_CARDS,
  SUBAGENT_SUPPRESSED,
} from './pickToolCard.js'

/**
 * Unified Skill row:
 *
 *   - The headline (skill name) comes straight from the tool input, so it's
 *     present from the first frame regardless of inline/fork — no `…` and no
 *     component swap when fork steps start arriving.
 *   - Collapsed by default. Body never auto-expands.
 *   - inline skill → expanded body is the returned procedure text (<pre>).
 *   - fork skill   → nested steps (live, like a subagent) + final report
 *     (markdown) appear beneath the header when expanded.
 */
function skillArgsHint(args) {
  const raw = args?.arguments
  if (typeof raw !== 'string' || !raw.trim()) return null
  const t = raw.trim()
  return t.length > 72 ? `${t.slice(0, 72)}\u2026` : t
}

const STEP_PREVIEW_LIMIT = 6

export default function SkillCard({ part, nested = false }) {
  const args = part.args || {}
  const result = part.result
  const isDone = part.status === 'done'
  const isError = isDone && detectError('Skill', result)
  const skillName = args.skill_name || args.skill || ''
  const hint = skillArgsHint(args)
  const hasBody = typeof result === 'string' && result.length > 0

  // Fork skills accumulate nested tool-call steps on the part (routed in the
  // store via the server-side isSubagent flag). Their presence is the only
  // reliable "fork" signal — note inline skills are ALSO flagged isSubagent
  // server-side, so part.isSubagent can't discriminate. A fork that hasn't
  // emitted its first step yet simply renders like an inline skill until the
  // step arrives — same component, no swap.
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

  const [expanded, setExpanded] = useState(false)
  const [stepsOpen, setStepsOpen] = useState(() => !isDone)
  const [showAllSteps, setShowAllSteps] = useState(false)
  const wasDone = useRef(isDone)

  // Collapse the step list once the fork completes (live while
  // running, tidy when done).
  useEffect(() => {
    if (isDone && !wasDone.current) setStepsOpen(false)
    wasDone.current = isDone
  }, [isDone])

  const sizeLabel =
    isDone && !isError && hasBody && !isFork ? formatBytes(result.length) : null

  const visibleSteps = showAllSteps ? steps : steps.slice(0, STEP_PREVIEW_LIMIT)
  const hiddenCount = steps.length - visibleSteps.length

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

  const hasReport = isDone && hasBody
  const showChevron = isFork
    ? hasReport || steps.length > 0
    : Boolean(isDone && hasBody)

  return (
    <div
      className={`tool-row skill-card ${nested ? 'tool-row--nested' : ''} ${isError ? 'has-error' : ''}`}
    >
      <ToolRowHeader
        expanded={expanded}
        onToggle={() => setExpanded(v => !v)}
        showChevron={showChevron}
        icon={'\u2699'}
        label='Skill'
        title={skillName || '\u2026'}
        titleTooltip={[skillName, hint].filter(Boolean).join('\n') || undefined}
        subtitle={hint}
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
        showSuccess={!nested}
        actions={
          isDone && !isError && hasBody && !isFork ? (
            <CopyButton text={result} label='Copy' inline />
          ) : null
        }
      />

      {expanded && (
        <div className='subagent-expanded'>
          {steps.length > 0 && stepsOpen && (
            <div className='subagent-steps'>
              {visibleSteps.map((s, i) => {
                const Card = pickCard(s, { nested: true })
                return (
                  <div className='subagent-nested-step' key={s.id ?? i}>
                    <Card part={s} nested />
                  </div>
                )
              })}
              {hiddenCount > 0 && (
                <button
                  type='button'
                  className='subagent-more'
                  onClick={e => {
                    e.stopPropagation()
                    setShowAllSteps(true)
                  }}
                >
                  Show {hiddenCount} more step{hiddenCount === 1 ? '' : 's'}
                </button>
              )}
            </div>
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
