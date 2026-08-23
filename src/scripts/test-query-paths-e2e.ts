/**
 * E2E: skill fork + Agent (Task) subagent paths after query() refactor.
 * Uses gpt-5.4 (project settings or DEFAULT_PROFILE).
 *
 * Run: npx tsx src/scripts/test-query-paths-e2e.ts
 * Requires: npm start on :4567, working LLM proxy.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { runAgent } from '../core/agent.js'
import { runForkedAgent } from '../core/forked-agent.js'
import { EventBus } from '../core/event-bus.js'
import { noopWireEmitter } from '../core/wire-emitter.js'
import { createModelRegistry, resolveModelProfiles } from '../core/llm/index.js'
import { resolveSettings } from '../core/settings-manager.js'
import { defaultRegistry } from '../tools.js'

const SERVER = process.env.SERVER_URL ?? 'http://localhost:4567'
const TIMEOUT_MS = 120_000

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

async function waitForServer(maxMs = 15_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${SERVER}/health`)
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
      events.push(JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>)
    } catch {
      /* skip */
    }
  }
  return events
}

function collectText(events: Array<Record<string, unknown>>): string {
  for (const ev of events) {
    if (ev.type === 'result' && typeof ev.text === 'string') return ev.text
  }
  return events
    .filter(
      e =>
        e.type === 'stream_event' &&
        (e.delta as { kind?: string })?.kind === 'text',
    )
    .map(e => (e.delta as { text?: string }).text ?? '')
    .join('')
}

async function chatSSE(
  message: string,
  sessionId?: string,
  workspace?: string,
): Promise<{
  status: number
  events: Array<Record<string, unknown>>
  text: string
}> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
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
      agentType: null,
      mode: 'agent',
    }),
    signal: controller.signal,
  })
  clearTimeout(timer)
  const body = await res.text()
  const events = parseSSEEvents(body)
  return { status: res.status, events, text: collectText(events) }
}

function setupForkSkillWorkspace(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'query-paths-fork-'))
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

function toolUseEvents(events: Array<Record<string, unknown>>): string[] {
  const names: string[] = []
  for (const ev of events) {
    if (ev.type === 'tool_call' && typeof ev.name === 'string') {
      names.push(ev.name)
      continue
    }
    if (ev.type !== 'stream_event') continue
    const delta = ev.delta as { kind?: string; toolName?: string } | undefined
    if (delta?.kind === 'tool_use' && delta.toolName) {
      names.push(delta.toolName)
    }
  }
  return names
}

async function main(): Promise<void> {
  console.log(`Testing query paths via ${SERVER}/chat (gpt-5.4)…\n`)
  await waitForServer()

  // 1. Skill fork (runSkillFork → runAgent → query)
  {
    const { dir, cleanup } = setupForkSkillWorkspace()
    try {
      const { status, events, text } = await chatSSE('/pong-fork-test', undefined, dir)
      const hasSkillStart = events.some(
        e => e.type === 'system' && e.subtype === 'skill_start',
      )
      if (status === 200 && hasSkillStart && text.toLowerCase().includes('fork-pong')) {
        pass('skill fork', `skill_start ok, text=${text.trim().slice(0, 40)}`)
      } else {
        fail(
          'skill fork',
          `status=${status} skill_start=${hasSkillStart} text=${text.slice(0, 120)}`,
        )
      }
    } catch (e) {
      fail('skill fork', (e as Error).message)
    } finally {
      cleanup()
    }
  }

  // 2. Agent tool / general-purpose subagent (AgentTool → runAgent → query)
  {
    const prompt =
      'You MUST call the Agent tool once with subagent_type "general-purpose" and prompt "Reply with exactly the word general-pong and nothing else." Do not answer yourself — only use the Agent tool.'
    try {
      const { status, events, text } = await chatSSE(
        prompt,
        undefined,
        process.cwd(),
      )
      const tools = toolUseEvents(events)
      const usedAgent = tools.includes('Agent')
      const combined = `${text} ${JSON.stringify(events.filter(e => e.type === 'tool_result'))}`
      const hasPong =
        combined.toLowerCase().includes('general-pong') ||
        text.toLowerCase().includes('general-pong')
      if (status === 200 && usedAgent && hasPong) {
        pass('Agent subagent (general-purpose)', `Agent called, pong found`)
      } else {
        fail(
          'Agent subagent (general-purpose)',
          `status=${status} usedAgent=${usedAgent} tools=${tools.join(',')} text=${text.slice(0, 120)}`,
        )
      }
    } catch (e) {
      fail('Agent subagent (general-purpose)', (e as Error).message)
    }
  }

  // 3. runForkedAgent direct (runForkedAgent → runAgent → query)
  {
    try {
      const cwd = process.cwd()
      const settings = resolveSettings(cwd)
      const models = createModelRegistry(
        resolveModelProfiles({ models: settings.config.models }),
      )
      const profile = models.profile('large')
      const provider = models.provider('large')
      const ctx = {
        eventBus: new EventBus(),
        wire: noopWireEmitter,
        registry: defaultRegistry,
        runAgent,
        provider,
        models,
        cwd,
      }
      const tools = defaultRegistry.createAll(cwd, ctx)
      const { text } = await runForkedAgent({
        prompt: 'Reply with exactly the word fork-direct-pong and nothing else.',
        runAgent,
        systemPrompt:
          'You are a forked side-path agent. Reply briefly in plain text only.',
        tools,
        provider,
        model: profile.model,
        forkLabel: 'e2e_fork',
        cwd,
      })
      if (text.toLowerCase().includes('fork-direct-pong')) {
        pass('runForkedAgent direct', text.trim().slice(0, 40))
      } else {
        fail('runForkedAgent direct', `text=${text.slice(0, 120)}`)
      }
    } catch (e) {
      fail('runForkedAgent direct', (e as Error).message)
    }
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
