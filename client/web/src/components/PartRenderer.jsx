import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { pickCard } from './pickToolCard.js'
import {
  expandToolGroup,
  splitSettledToolRuns,
} from '../lib/timeline.js'
import { getMdComponents } from '../lib/markdown-components.jsx'
import AskUserQuestionCard from './AskUserQuestionCard.jsx'
import PlanApprovalCard from './PlanApprovalCard.jsx'
import ExploredGroup from './ExploredGroup.jsx'
import ReasoningBlock from './ReasoningBlock.jsx'
import ThinkingDots from './ThinkingDots.jsx'
import CompactionRow from './CompactionRow.jsx'
import TodoListCard from './TodoListCard.jsx'
import WorkGroup from './WorkGroup.jsx'

function settledPrefixDurationMs(runs) {
  let start = Infinity
  let end = -Infinity
  for (const run of runs) {
    const items = run.type === 'explored_run' ? run.items : [run.part]
    for (const it of items) {
      if (typeof it?.startTime === 'number') start = Math.min(start, it.startTime)
      if (typeof it?.endTime === 'number') end = Math.max(end, it.endTime)
    }
  }
  return end > start ? end - start : undefined
}

function renderToolRuns(runs) {
  return runs.map((run, j) => {
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
  })
}

/**
 * Render one timeline row (grouped assistant part).
 * MessageBubble owns timeline fold; this owns part-type routing
 * (≈ Cursor ToolFormer per-entry render).
 */
export default function PartRenderer({
  part,
  index,
  rowCount,
  messageStreaming,
}) {
  switch (part.type) {
    case 'text': {
      if (!part.content?.trim()) return null
      const partStreaming = messageStreaming && index === rowCount - 1
      const mdComponents = getMdComponents({ streaming: partStreaming })
      return (
        <div className='content'>
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
      // Skip short, content-less reasoning blocks — pure noise when done.
      // Still show while streaming, and always show when there is content.
      if (
        part.status !== 'streaming' &&
        (!part.content || part.content.trim() === '') &&
        (!part.duration || part.duration <= 2)
      )
        return null
      return <ReasoningBlock part={part} />
    case 'thinking':
      return <ThinkingDots />
    case 'tool_group': {
      const { runs } = expandToolGroup(part.items)
      if (runs.length === 0) return null

      // While the turn is live, fold finished tools in this group so the
      // in-flight Shell / Task / edit stays on screen (Cursor progressive fold).
      const { settled, rest } = splitSettledToolRuns(runs)
      const intraFold =
        messageStreaming && settled.length > 0 && rest.length > 0

      return (
        <div className='tool-group'>
          {intraFold ? (
            <>
              <WorkGroup
                durationMs={settledPrefixDurationMs(settled)}
                defaultOpen={false}
              >
                {renderToolRuns(settled)}
              </WorkGroup>
              {renderToolRuns(rest)}
            </>
          ) : (
            renderToolRuns(runs)
          )}
        </div>
      )
    }
    case 'ask_user_question':
      return <AskUserQuestionCard part={part} />
    case 'plan_approval':
      return <PlanApprovalCard part={part} />
    case 'todo_list':
      return <TodoListCard part={part} />
    case 'compaction_start':
      return <CompactionRow state='running' />
    case 'compaction_done':
      return (
        <CompactionRow state={part.status === 'error' ? 'error' : 'done'} />
      )
    case 'error':
      return <p className='error-text'>Error: {part.message}</p>
    default:
      return null
  }
}
