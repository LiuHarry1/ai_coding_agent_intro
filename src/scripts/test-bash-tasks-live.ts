/**
 * Live HTTP e2e against running server (npm start on :4567).
 * Covers session tasks API + chat-driven shell cases via /chat SSE.
 *
 * Run: npx tsx src/scripts/test-bash-tasks-live.ts
 */
import assert from 'assert'

const BASE = process.env.AGENT_URL || 'http://localhost:4567'

async function createSession(): Promise<string> {
  const res = await fetch(`${BASE}/sessions`, { method: 'POST' })
  assert.equal(res.status, 200)
  const j = (await res.json()) as { session_id: string }
  assert.ok(j.session_id)
  return j.session_id
}

async function listTasks(sessionId: string) {
  const res = await fetch(`${BASE}/sessions/${sessionId}/tasks`)
  const text = await res.text()
  assert.equal(res.status, 200, text)
  return JSON.parse(text) as {
    tasks: Array<{
      id: string
      status: string
      description: string
      command?: string
    }>
  }
}

async function stopTaskHttp(sessionId: string, taskId: string) {
  const res = await fetch(
    `${BASE}/sessions/${sessionId}/tasks/${taskId}/stop`,
    { method: 'POST' },
  )
  const body = await res.json()
  return { status: res.status, body }
}

type SseEvent = { type: string; [k: string]: unknown }

async function chatCollect(
  sessionId: string,
  message: string,
  timeoutMs = 120_000,
): Promise<SseEvent[]> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const res = await fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      message,
      workspace: process.cwd(),
    }),
    signal: ac.signal,
  })
  assert.ok(res.ok, `chat status ${res.status}`)
  assert.ok(res.body)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const events: SseEvent[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const parts = buf.split('\n')
      buf = parts.pop() || ''
      for (const line of parts) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const raw = t.slice(5).trim()
        if (!raw || raw === '[DONE]') continue
        try {
          events.push(JSON.parse(raw) as SseEvent)
        } catch {
          /* ignore partial */
        }
      }
    }
  } finally {
    clearTimeout(timer)
  }
  return events
}

function toolResults(events: SseEvent[]) {
  return events.filter(e => e.type === 'tool_result')
}

function findToolResult(
  events: SseEvent[],
  name: string,
): SseEvent | undefined {
  return [...events]
    .reverse()
    .find(
      e =>
        e.type === 'tool_result' &&
        (e.name === name ||
          (typeof e.tool_name === 'string' && e.tool_name === name)),
    )
}

function resultText(ev: SseEvent | undefined): string {
  if (!ev) return ''
  const tur = ev.tool_use_result as { text?: string; backgroundTaskId?: string } | undefined
  if (tur?.text) return tur.text
  if (typeof ev.result === 'string') return ev.result
  if (typeof ev.content === 'string') return ev.content
  return JSON.stringify(ev)
}

async function main() {
  const health = await fetch(`${BASE}/health`)
  assert.equal(health.status, 200)

  console.log('1) empty tasks list')
  const sid = await createSession()
  let listed = await listTasks(sid)
  assert.equal(listed.tasks.length, 0)

  console.log('2) foreground Bash (echo)')
  {
    const events = await chatCollect(
      sid,
      'Call Bash exactly once with command: echo foreground-ok. description="fg echo". Do not use run_in_background. Reply with only the output.',
    )
    const tr = toolResults(events)
    assert.ok(tr.length >= 1, 'expected tool_result')
    const text = events.map(e => JSON.stringify(e)).join('\n')
    assert.ok(
      text.includes('foreground-ok') ||
        resultText(findToolResult(events, 'Bash')).includes('foreground-ok'),
      'foreground output missing',
    )
  }

  console.log('3) background finite + TaskOutput(block=true)')
  {
    const events = await chatCollect(
      sid,
      '1) Bash with run_in_background=true, command: for i in 1 2 3; do echo tick-$i; sleep 0.4; done, description="count three". 2) Then TaskOutput with that task_id and block=true. Do not ask questions.',
      90_000,
    )
    const blob = events.map(e => JSON.stringify(e)).join('\n')
    assert.ok(
      /background with ID:|backgroundTaskId|task_id/i.test(blob),
      'expected background task id in stream',
    )
    assert.ok(/tick-1/.test(blob) && /tick-3/.test(blob), 'expected ticks')
  }

  console.log('4) long-lived bg: do not block-await; tasks API + stop')
  {
    const t0 = Date.now()
    const events = await chatCollect(
      sid,
      'Use Bash run_in_background=true to run: sleep 120. description="long sleep". Do NOT call TaskOutput with block=true. Optionally TaskOutput block=false once, then tell the user the task_id and end. Do not wait for sleep to finish.',
      90_000,
    )
    const elapsed = Date.now() - t0
    assert.ok(
      elapsed < 60_000,
      `turn took too long (${elapsed}ms) — likely blocked on sleep`,
    )
    listed = await listTasks(sid)
    const running = listed.tasks.filter(
      t => t.status === 'running' || t.status === 'pending',
    )
    assert.ok(running.length >= 1, `expected running task, got ${JSON.stringify(listed)}`)
    const taskId = running[0]!.id
    const stop = await stopTaskHttp(sid, taskId)
    assert.equal(stop.status, 200, JSON.stringify(stop.body))
    listed = await listTasks(sid)
    const still = listed.tasks.find(t => t.id === taskId)
    assert.ok(
      !still || still.status === 'killed' || still.status === 'completed' || still.status === 'failed',
      JSON.stringify(still),
    )
  }

  console.log('5) TaskStop via model (optional short bg)')
  {
    const events = await chatCollect(
      sid,
      'Bash run_in_background=true command: sleep 60 description="to-stop". Immediately call TaskStop with that task_id. Confirm stopped. Do not TaskOutput block=true.',
      90_000,
    )
    const blob = events.map(e => JSON.stringify(e)).join('\n')
    assert.ok(
      /stopped|TaskStop|killed/i.test(blob),
      'expected stop confirmation',
    )
  }

  console.log('All live bash-task use cases passed.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
