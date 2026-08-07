/**
 * Work-group unit checks — Cursor default-chat `U0m` timing.
 * Run: npx tsx src/scripts/test-work-fold.ts
 */
import assert from 'assert'
import {
  applyWorkGrouping,
  buildAssistantTimeline,
  formatWorkedDuration,
  groupAssistantParts,
} from '../../client/web/src/lib/timeline.js'

function rows(parts) {
  return groupAssistantParts(parts)
}

const doneTool = (id, t0 = 1000, t1 = 2000) => ({
  type: 'tool_call',
  toolCallId: id,
  name: 'Bash',
  status: 'done',
  startTime: t0,
  endTime: t1,
})

const liveTool = id => ({
  type: 'tool_call',
  toolCallId: id,
  name: 'Bash',
  status: 'streaming-input',
  startTime: Date.now(),
})

{
  // Streaming: settled tools — NO work_group (Cursor incomplete turn)
  const out = applyWorkGrouping(rows([doneTool('a'), doneTool('b')]), {
    streaming: true,
    messageId: 'm1',
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].type, 'tool_group')
}

{
  // Streaming: settled + Thinking — still flat, Thinking visible
  const out = applyWorkGrouping(
    rows([doneTool('a'), { type: 'thinking' }]),
    { streaming: true, messageId: 'm1' },
  )
  assert.equal(out.length, 2)
  assert.equal(out[0].type, 'tool_group')
  assert.equal(out[1].type, 'thinking')
}

{
  // Streaming: live tool — no fold
  const out = applyWorkGrouping(rows([doneTool('a'), liveTool('b')]), {
    streaming: true,
    messageId: 'm1',
  })
  assert.ok(out.every(r => r.type !== 'work_group'))
}

{
  // Done turn: fold before final text → Worked for …
  const out = applyWorkGrouping(
    rows([
      doneTool('a', 1000, 8000),
      { type: 'text', content: '项目已启动', id: 't1' },
    ]),
    { streaming: false, messageId: 'm1' },
  )
  assert.equal(out.length, 2)
  assert.equal(out[0].type, 'work_group')
  assert.equal(out[0].state, 'completed')
  assert.equal(out[0].rowId, 'work-group:m1:t1')
  assert.equal(out[1].type, 'text')
  assert.ok(out[0].durationMs > 0)
}

{
  // Done turn: thinking placeholder stripped from fold body
  const out = applyWorkGrouping(
    rows([
      doneTool('a'),
      { type: 'thinking' },
      { type: 'text', content: 'done', id: 't2' },
    ]),
    { streaming: false, messageId: 'm1' },
  )
  assert.equal(out[0].type, 'work_group')
  assert.ok(out[0].children.every(c => c.type !== 'thinking'))
}

{
  // Done turn with no text → no work_group
  const out = applyWorkGrouping(rows([doneTool('a')]), {
    streaming: false,
    messageId: 'm1',
  })
  assert.ok(out.every(r => r.type !== 'work_group'))
}

{
  const { rows: tl } = buildAssistantTimeline(
    [doneTool('a'), { type: 'text', content: 'hi', id: 'x' }],
    { streaming: false, messageId: 'abc' },
  )
  assert.equal(tl[0].rowId, 'work-group:abc:x')
}

{
  assert.equal(formatWorkedDuration(500), 'for 1s')
  assert.equal(formatWorkedDuration(7000), 'for 7s')
  assert.equal(formatWorkedDuration(65000), 'for 1m 5s')
}

console.log('work-fold tests OK')
