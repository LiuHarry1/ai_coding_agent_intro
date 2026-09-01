import React, { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { useChatStore } from '../../stores/chat-store.js'
import { expandFoldableSegment } from '../../lib/bubbles/flat-elements.js'
import WorkGroup from '../WorkGroup.jsx'
import BubbleRow from './BubbleRow.jsx'
import ToolGroupRow from './ToolGroupRow.jsx'

/**
 * Cursor "Worked for …" disclosure — body rows subscribe by bubble/group id.
 */
function WorkGroupRow({
  memberIds,
  durationMs,
  state = 'completed',
  defaultOpen = false,
}) {
  const [open, setOpen] = useState(defaultOpen)

  // Cursor: last turn stays open only while it is last. A new user message
  // makes this group not-last (defaultOpen false) and it collapses.
  useEffect(() => {
    if (!defaultOpen) setOpen(false)
  }, [defaultOpen])

  const runningTaskCount = useChatStore(s => {
    let n = 0
    for (const id of memberIds) {
      const b = s.bubblesById[id]
      if (b?.kind === 'tool' && b.status !== 'done') n++
    }
    return n
  })

  const childElements = useMemo(() => {
    const byId = useChatStore.getState().bubblesById
    return expandFoldableSegment(memberIds, byId)
  }, [memberIds])

  const onOpenChange = useCallback(next => setOpen(next), [])

  return (
    <div className='msg msg-assistant'>
      <WorkGroup
        durationMs={durationMs}
        runningTaskCount={runningTaskCount}
        open={open}
        onOpenChange={onOpenChange}
      >
        {childElements.map(el => {
          if (el.type === 'tool_group') {
            return (
              <ToolGroupRow
                key={el.id}
                memberIds={el.memberIds}
                groupKind={el.groupKind}
                embedded
              />
            )
          }
          return (
            <BubbleRow key={el.id} bubbleId={el.bubbleId} embedded />
          )
        })}
      </WorkGroup>
    </div>
  )
}

function memberIdsEqual(a, b) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((id, i) => id === b[i])
}

export default memo(WorkGroupRow, (prev, next) => {
  return (
    prev.durationMs === next.durationMs &&
    prev.state === next.state &&
    prev.defaultOpen === next.defaultOpen &&
    memberIdsEqual(prev.memberIds, next.memberIds)
  )
})
