import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { pickCard } from './pickToolCard.js'
import { expandToolGroup, toolPartKey } from '../lib/timeline.js'
import { getMdComponents } from '../lib/markdown-components.jsx'
import AskUserQuestionCard from './AskUserQuestionCard.jsx'
import PlanApprovalCard from './PlanApprovalCard.jsx'
import ExploredGroup from './ExploredGroup.jsx'
import ReasoningBlock from './ReasoningBlock.jsx'
import ThinkingDots from './ThinkingDots.jsx'
import CompactionRow from './CompactionRow.jsx'
import TodoListCard from './TodoListCard.jsx'

function renderToolRuns(runs) {
  return runs.map((run, j) => {
    if (run.type === 'explored_run') {
      const first = toolPartKey(run.items[0], `ex-a-${j}`)
      const last = toolPartKey(
        run.items[run.items.length - 1],
        `ex-b-${j}`,
      )
      return (
        <ExploredGroup
          key={`explored-${first}-${last}`}
          items={run.items}
        />
      )
    }
    const Card = pickCard(run.part)
    return (
      <Card
        key={toolPartKey(run.part, `tool-${j}`)}
        part={run.part}
      />
    )
  })
}

/**
 * Render one timeline row (grouped assistant part).
 * `work_group` rows are owned by MessageBubble (≈ Cursor EIt workGroup case).
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
      return <div className='tool-group'>{renderToolRuns(runs)}</div>
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
