import React, { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { pickCard, SUPPRESSED_TOOL_CARDS } from './pickToolCard.js'
import { isPlanFileWrite } from '../lib/plan-utils.js'
import { coalesceToolRuns, hasRunningSubagent } from '../lib/tool-density.js'
import AskUserQuestionCard from './AskUserQuestionCard.jsx'
import PlanApprovalCard from './PlanApprovalCard.jsx'
import ExploredGroup from './ExploredGroup.jsx'
import WorkGroup from './WorkGroup.jsx'
import ToolRowHeader from './ToolRowHeader.jsx'
import CopyButton from './CopyButton.jsx'
import { getMdComponents } from '../lib/markdown-components.jsx'

function ThinkingDots() {
  return (
    <div className='thinking-indicator'>
      <div className='dot' />
      <div className='dot' />
      <div className='dot' />
      <span>Thinking...</span>
    </div>
  )
}

function ReasoningBlock({ part }) {
  const [open, setOpen] = useState(false)
  const isStreaming = part.status === 'streaming'
  const mdComponents = getMdComponents({ streaming: isStreaming })

  const label = isStreaming
    ? 'Thinking...'
    : `Thought for ${part.duration ?? 0}s`

  return (
    <div className={`reasoning-block ${isStreaming ? 'streaming' : 'done'}`}>
      <button className='reasoning-toggle' onClick={() => setOpen(v => !v)}>
        <svg
          className={`reasoning-arrow ${open ? 'open' : ''}`}
          width='12'
          height='12'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='2.5'
          strokeLinecap='round'
          strokeLinejoin='round'
        >
          <polyline points='9 6 15 12 9 18' />
        </svg>
        <span className='reasoning-label'>
          {isStreaming && <span className='reasoning-pulse' />}
          {label}
        </span>
      </button>
      {(open || isStreaming) && part.content && (
        <div className='reasoning-content'>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={mdComponents}
          >
            {part.content}
          </ReactMarkdown>
        </div>
      )}
    </div>
  )
}

/**
 * Single timeline row for full compaction. Rides on ToolRowHeader so it
 * shares the exact visual language of the tool rows around it
 * (mono font, spinner while running, chevron when expandable).
 * state: 'running' | 'done' | 'error'.
 */
function CompactionRow({ state, summary }) {
  const [expanded, setExpanded] = useState(false)
  const expandable = state === 'done' && !!summary

  if (state === 'running') {
    return (
      <div className='tool-row compaction-row'>
        <ToolRowHeader
          showChevron={false}
          label={'Summarizing chat context\u2026'}
          isDone={false}
        />
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className='tool-row compaction-row has-error'>
        <ToolRowHeader
          showChevron={false}
          label='Chat context summarization failed'
          isDone
          isError
        />
      </div>
    )
  }

  return (
    <div className='tool-row compaction-row'>
      <ToolRowHeader
        expanded={expanded}
        onToggle={expandable ? () => setExpanded(v => !v) : undefined}
        showChevron={expandable}
        label='Chat context summarized'
        isDone
        actions={
          summary ? <CopyButton text={summary} label='Copy' inline /> : null
        }
      />
      {expanded && expandable && (
        <pre className='compaction-summary'>{summary}</pre>
      )}
    </div>
  )
}

function TodoListIcon() {
  return (
    <svg
      width='14'
      height='14'
      viewBox='0 0 14 14'
      fill='none'
      aria-hidden='true'
    >
      <circle cx='2' cy='3' r='1.25' stroke='currentColor' strokeWidth='1' />
      <line
        x1='5'
        y1='3'
        x2='13'
        y2='3'
        stroke='currentColor'
        strokeWidth='1'
        strokeLinecap='round'
      />
      <circle cx='2' cy='7' r='1.25' stroke='currentColor' strokeWidth='1' />
      <line
        x1='5'
        y1='7'
        x2='13'
        y2='7'
        stroke='currentColor'
        strokeWidth='1'
        strokeLinecap='round'
      />
      <circle cx='2' cy='11' r='1.25' stroke='currentColor' strokeWidth='1' />
      <line
        x1='5'
        y1='11'
        x2='13'
        y2='11'
        stroke='currentColor'
        strokeWidth='1'
        strokeLinecap='round'
      />
    </svg>
  )
}

function TodoStatusIcon({ status }) {
  if (status === 'completed') {
    return (
      <svg
        width='14'
        height='14'
        viewBox='0 0 14 14'
        fill='none'
        aria-hidden='true'
      >
        <circle cx='7' cy='7' r='6' stroke='currentColor' strokeWidth='1' />
        <path
          d='M4.25 7L6.25 9L9.75 5'
          stroke='currentColor'
          strokeWidth='1.2'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
      </svg>
    )
  }
  if (status === 'cancelled') {
    return (
      <svg
        width='14'
        height='14'
        viewBox='0 0 14 14'
        fill='none'
        aria-hidden='true'
      >
        <circle cx='7' cy='7' r='6' stroke='currentColor' strokeWidth='1' />
        <path
          d='M5 5L9 9M9 5L5 9'
          stroke='currentColor'
          strokeWidth='1.2'
          strokeLinecap='round'
        />
      </svg>
    )
  }
  if (status === 'in_progress') {
    return (
      <svg
        width='14'
        height='14'
        viewBox='0 0 14 14'
        fill='none'
        aria-hidden='true'
      >
        <circle cx='7' cy='7' r='6' stroke='currentColor' strokeWidth='1' />
        <circle cx='7' cy='7' r='2.5' fill='currentColor' />
      </svg>
    )
  }
  return (
    <svg
      width='14'
      height='14'
      viewBox='0 0 14 14'
      fill='none'
      aria-hidden='true'
    >
      <circle cx='7' cy='7' r='6' stroke='currentColor' strokeWidth='1' />
    </svg>
  )
}

function TodoListCard({ part }) {
  const { todos = [] } = part
  if (todos.length === 0) return null

  const total = todos.length

  const [manualToggle, setManualToggle] = useState(null)
  const open = manualToggle !== null ? manualToggle : true

  return (
    <div className='todo-card'>
      <button
        className='todo-header'
        onClick={() => setManualToggle(v => (v === null ? !open : !v))}
        aria-expanded={open}
      >
        <TodoListIcon />
        <span className='todo-title'>
          To-dos <span className='todo-count'>{total}</span>
        </span>
        <svg
          className={`todo-arrow ${open ? 'open' : ''}`}
          width='12'
          height='12'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
          aria-hidden='true'
        >
          <polyline points='6 9 12 15 18 9' />
        </svg>
      </button>
      {open && (
        <ul className='todo-list'>
          {todos.map(t => (
            <li key={t.id} className={`todo-item todo-${t.status}`}>
              <span className={`todo-icon todo-icon-${t.status}`}>
                <TodoStatusIcon status={t.status} />
              </span>
              <span className='todo-content'>{t.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ErrorBlock({ message }) {
  return <p className='error-text'>Error: {message}</p>
}

/** Part types allowed inside a collapsed turn work group. */
const WORK_GROUP_CHILD_TYPES = new Set([
  'reasoning',
  'thinking',
  'tool_group',
  'todo_list',
  'compaction_start',
  'compaction_done',
])

/**
 * Turn-level work fold, mirroring Cursor's `workGroup` split: once the turn is
 * done, every row before the final assistant message collapses behind one
 * header. Bails out entirely when the prefix holds a row that must stay
 * visible (questions, plan approval, errors) — same as its `every` guard.
 */
function computeWorkFold(rows, streaming) {
  if (streaming) return null

  let lastText = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].type === 'text' && rows[i].content?.trim()) {
      lastText = i
      break
    }
  }
  if (lastText <= 0) return null

  const prefix = rows.slice(0, lastText)
  if (!prefix.every(p => WORK_GROUP_CHILD_TYPES.has(p.type))) return null

  let start = Infinity
  let end = -Infinity
  let runningTaskCount = 0
  for (const p of prefix) {
    if (p.type !== 'tool_group') continue
    for (const it of p.items) {
      if (typeof it.startTime === 'number') start = Math.min(start, it.startTime)
      if (typeof it.endTime === 'number') end = Math.max(end, it.endTime)
      if (it.isSubagent && it.status !== 'done') runningTaskCount++
    }
  }

  return {
    split: lastText,
    runningTaskCount,
    durationMs: end > start ? end - start : undefined,
  }
}

export default function MessageBubble({ message, isLast = false }) {
  const [lightbox, setLightbox] = useState(null)

  if (message.type === 'compact_boundary') {
    return (
      <div className='msg msg-compact-boundary'>
        <CompactionRow state='done' summary={message.summary} />
      </div>
    )
  }

  if (message.type === 'user') {
    return (
      <div className='msg msg-user'>
        {message.images && message.images.length > 0 && (
          <div className='msg-user-images'>
            {message.images.map((src, i) => (
              <img
                key={i}
                src={src}
                alt={`Attachment ${i + 1}`}
                className='msg-user-img'
                onClick={() => setLightbox(src)}
              />
            ))}
          </div>
        )}
        {message.content}
        {lightbox && (
          <div className='lightbox' onClick={() => setLightbox(null)}>
            <img src={lightbox} alt='Preview' />
          </div>
        )}
      </div>
    )
  }

  if (message.type !== 'assistant') return null

  const { parts = [] } = message
  const messageStreaming = message.status === 'streaming'

  // Plan approval card pinned to bottom of the turn (after tools / questions).
  const groupedParts = []
  const planParts = []
  let currentToolGroup = null

  for (const part of parts) {
    if (part.type === 'plan_approval') {
      currentToolGroup = null
      planParts.push(part)
      continue
    }
    if (part.type === 'tool_call') {
      if (!currentToolGroup) {
        currentToolGroup = { type: 'tool_group', items: [] }
        groupedParts.push(currentToolGroup)
      }
      currentToolGroup.items.push(part)
    } else {
      currentToolGroup = null
      groupedParts.push(part)
    }
  }
  groupedParts.push(...planParts)

  const renderPart = (part, i) => {
    switch (part.type) {
      case 'text': {
        if (!part.content?.trim()) return null
        const partStreaming = messageStreaming && i === groupedParts.length - 1
        const mdComponents = getMdComponents({ streaming: partStreaming })
        return (
          <div className='content' key={i}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={mdComponents}
            >
              {part.content}
            </ReactMarkdown>
          </div>
        )
      }
      case 'reasoning':
        // Skip short, content-less reasoning blocks — they're pure noise
        // ("Thought for 1s" rows with nothing inside). We still render
        // them while they're streaming so the user gets the live
        // "Thinking…" indicator, and we still render any block that has
        // actual content regardless of duration.
        if (
          part.status !== 'streaming' &&
          (!part.content || part.content.trim() === '') &&
          (!part.duration || part.duration <= 2)
        )
          return null
        return <ReasoningBlock key={i} part={part} />
      case 'thinking':
        return <ThinkingDots key={i} step={part.step} />
      case 'tool_group': {
        const visibleItems = part.items.filter(
          it =>
            it.type === 'tool_call' &&
            !SUPPRESSED_TOOL_CARDS.has(it.name) &&
            !isPlanFileWrite(it),
        )
        if (visibleItems.length === 0) return null
        const runs = coalesceToolRuns(visibleItems)
        const waiting = hasRunningSubagent(visibleItems)
        return (
          <div className='tool-group' key={i}>
            {runs.map((run, j) => {
              if (run.type === 'explored_run') {
                return (
                  <ExploredGroup
                    key={run.items[0]?.id ?? `explored-${j}`}
                    items={run.items}
                  />
                )
              }
              const Card = pickCard(run.part)
              return (
                <Card
                  key={run.part.toolCallId ?? run.part.id ?? j}
                  part={run.part}
                />
              )
            })}
            {waiting && (
              <div className='waiting-for-subagent'>Waiting for subagent</div>
            )}
          </div>
        )
      }
      case 'ask_user_question':
        return <AskUserQuestionCard key={i} part={part} />
      case 'plan_approval':
        return <PlanApprovalCard key={i} part={part} />
      case 'todo_list':
        return <TodoListCard key={i} part={part} />
      case 'compaction_start':
        return <CompactionRow key={i} state='running' />
      case 'compaction_done':
        return (
          <CompactionRow
            key={i}
            state={part.status === 'error' ? 'error' : 'done'}
          />
        )
      case 'error':
        return <ErrorBlock key={i} message={part.message} />
      default:
        return null
    }
  }

  const nodes = groupedParts.map(renderPart)
  const fold = computeWorkFold(groupedParts, messageStreaming)
  const foldedNodes = fold ? nodes.slice(0, fold.split) : null
  const showFold = !!fold && foldedNodes.some(n => n != null)

  return (
    <div className='msg msg-assistant'>
      {showFold ? (
        <>
          <WorkGroup
            durationMs={fold.durationMs}
            runningTaskCount={fold.runningTaskCount}
            defaultOpen={isLast}
          >
            {foldedNodes}
          </WorkGroup>
          {nodes.slice(fold.split)}
        </>
      ) : (
        nodes
      )}
    </div>
  )
}
