/**
 * Smoke test for refactored HTTP /chat → runChatTurn().
 * Run: npx tsx examples/08-basic/scripts/test-chat-refactor.ts
 *
 * Set SKIP_LLM=1 to skip agent-turn and fork tests (no API tokens).
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const SERVER = process.env.SERVER_URL ?? 'http://localhost:4567'
const SKIP_LLM = process.env.SKIP_LLM === '1'
const LLM_TIMEOUT_MS = 120_000

type TestResult = { name: string; ok: boolean; detail: string }

const results: TestResult[] = []

function pass(name: string, detail: string) {
  results.push({ name, ok: true, detail })
  console.log(`✓ ${name}: ${detail}`)
}

function fail(name: string, detail: string) {
  results.push({ name, ok: false, detail })
  console.error(`✗ ${name}: ${detail}`)
}

async function waitForServer(maxMs = 15000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${SERVER}/sessions`)
      if (res.ok) return
    } catch {
      /* retry */
    }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`Server not reachable at ${SERVER}`)
}

function parseSSEEvents(body: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = []
  for (const block of body.split('\n\n')) {
    const dataLine = block.split('\n').find(l => l.startsWith('data:'))
    if (!dataLine) continue
    try {
      events.push(
        JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>,
      )
    } catch {
      /* skip */
    }
  }
  return events
}

function collectTextFromProtocol(
  events: Array<Record<string, unknown>>,
): string {
  const parts: string[] = []
  for (const ev of events) {
    if (ev.type === 'stream_event') {
      const delta = ev.delta as { kind?: string; text?: string } | undefined
      if (delta?.kind === 'text' && delta.text) parts.push(delta.text)
    }
    if (ev.type === 'result' && typeof ev.text === 'string') {
      return ev.text
    }
  }
  return parts.join('')
}

async function chatJSON(
  message: string,
  sessionId?: string,
  workspace?: string,
) {
  const res = await fetch(`${SERVER}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      message,
      session_id: sessionId,
      workspace,
      stream: false,
    }),
  })
  const json = (await res.json()) as Record<string, unknown>
  return {
    status: res.status,
    json,
    sessionId: String(json.session_id ?? sessionId ?? ''),
  }
}

async function chatSSE(
  message: string,
  sessionId?: string,
  workspace?: string,
  timeoutMs = 30_000,
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const res = await fetch(`${SERVER}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      message,
      session_id: sessionId,
      workspace,
      stream: true,
    }),
    signal: controller.signal,
  })
  clearTimeout(timer)
  const body = await res.text()
  const sessionIdOut = res.headers.get('x-session-id') ?? sessionId ?? ''
  const protocol = res.headers.get('x-agent-protocol')
  return {
    status: res.status,
    body,
    sessionId: sessionIdOut,
    protocol,
    events: parseSSEEvents(body),
  }
}

function setupForkSkillWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-fork-test-'))
  const skillDir = path.join(dir, '.ai-agent', 'skills', 'pong-fork-test')
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---
name: pong-fork-test
description: E2E fork skill test — reply with fork-pong
context: fork
agent: general-purpose
---
Reply with exactly the word fork-pong and nothing else.
`,
  )
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

async function main() {
  console.log(`Testing ${SERVER}/chat …\n`)
  await waitForServer()

  // 1. JSON slash command
  {
    const { status, json } = await chatJSON('/help')
    const text = String(json.text ?? '')
    if (
      status === 200 &&
      json.reason === 'slash_command' &&
      text.includes('/help')
    ) {
      pass('JSON /help', `reason=${json.reason}, len=${text.length}`)
    } else {
      fail(
        'JSON /help',
        `status=${status} reason=${json.reason} text=${text.slice(0, 80)}`,
      )
    }
  }

  // 2. SSE slash command
  {
    const { status, protocol, events } = await chatSSE('/help')
    const text = collectTextFromProtocol(events)
    const types = [...new Set(events.map(e => `${e.type}.${e.subtype ?? ''}`))]
    if (
      status === 200 &&
      protocol === '1' &&
      text.includes('/help') &&
      events.some(e => e.type === 'system' && e.subtype === 'init')
    ) {
      pass('SSE /help', `protocol=${protocol}, events=${types.join(', ')}`)
    } else {
      fail(
        'SSE /help',
        `status=${status} protocol=${protocol} text=${text.slice(0, 80)} events=${types.join(',')}`,
      )
    }
  }

  // 3. JSON /compact on empty session
  {
    const { status, json } = await chatJSON('/compact')
    const text = String(json.text ?? '')
    if (
      status === 200 &&
      json.reason === 'compact' &&
      text.toLowerCase().includes('compact')
    ) {
      pass('JSON /compact', text.slice(0, 60))
    } else {
      fail(
        'JSON /compact',
        `status=${status} reason=${json.reason} text=${text}`,
      )
    }
  }

  // 4. SSE unknown slash
  {
    const { status, events } = await chatSSE('/not-a-real-command-xyz')
    const text = collectTextFromProtocol(events)
    if (status === 200 && text.includes('Unknown slash command')) {
      pass('SSE unknown slash', text.split('\n')[0] ?? text)
    } else {
      fail('SSE unknown slash', `status=${status} text=${text}`)
    }
  }

  // 5. Shared session: JSON then SSE reuse session_id
  {
    const first = await chatJSON('/help')
    const sid = first.sessionId
    const second = await chatSSE('/compact', sid)
    const text = collectTextFromProtocol(second.events)
    if (
      sid &&
      second.sessionId === sid &&
      text.toLowerCase().includes('compact')
    ) {
      pass('Session reuse', `session=${sid.slice(0, 8)}… compact ok`)
    } else {
      fail(
        'Session reuse',
        `sid=${sid} secondSid=${second.sessionId} text=${text.slice(0, 80)}`,
      )
    }
  }

  if (!SKIP_LLM) {
    console.log('\n--- LLM agent turn (uses API tokens) ---\n')

    // 6. SSE agent turn
    {
      try {
        const { status, events } = await chatSSE(
          'Reply with exactly the single word pong and nothing else.',
          undefined,
          undefined,
          LLM_TIMEOUT_MS,
        )
        const text = collectTextFromProtocol(events).trim().toLowerCase()
        const hasStream = events.some(e => e.type === 'stream_event')
        const hasResult = events.some(
          e => e.type === 'result' && e.subtype === 'success',
        )
        if (status === 200 && hasStream && hasResult && text.includes('pong')) {
          pass('SSE LLM turn', `text=${text.slice(0, 40)}`)
        } else {
          fail(
            'SSE LLM turn',
            `status=${status} text=${text.slice(0, 80)} stream=${hasStream} result=${hasResult}`,
          )
        }
      } catch (e) {
        fail('SSE LLM turn', (e as Error).message)
      }
    }

    // 7. Skill fork (SSE)
    {
      const { dir, cleanup } = setupForkSkillWorkspace()
      try {
        const { status, events } = await chatSSE(
          '/pong-fork-test',
          undefined,
          dir,
          LLM_TIMEOUT_MS,
        )
        const text = collectTextFromProtocol(events).trim().toLowerCase()
        const hasSkillStart = events.some(
          e => e.type === 'system' && e.subtype === 'skill_start',
        )
        if (status === 200 && hasSkillStart && text.includes('fork-pong')) {
          pass('SSE skill fork', `skill_start ok, text=${text.slice(0, 40)}`)
        } else {
          fail(
            'SSE skill fork',
            `status=${status} skill_start=${hasSkillStart} text=${text.slice(0, 80)}`,
          )
        }
      } catch (e) {
        fail('SSE skill fork', (e as Error).message)
      } finally {
        cleanup()
      }
    }

    // 8. Skill fork (JSON)
    {
      const { dir, cleanup } = setupForkSkillWorkspace()
      try {
        const { status, json } = await chatJSON(
          '/pong-fork-test',
          undefined,
          dir,
        )
        const result = String(json.result ?? '').toLowerCase()
        if (
          status === 200 &&
          json.context === 'fork' &&
          result.includes('fork-pong')
        ) {
          pass('JSON skill fork', `context=fork, result=${result.slice(0, 40)}`)
        } else {
          fail(
            'JSON skill fork',
            `status=${status} context=${json.context} result=${result.slice(0, 80)}`,
          )
        }
      } catch (e) {
        fail('JSON skill fork', (e as Error).message)
      } finally {
        cleanup()
      }
    }
  } else {
    console.log('\n(skipping LLM + fork tests — set SKIP_LLM=0 to run)\n')
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
