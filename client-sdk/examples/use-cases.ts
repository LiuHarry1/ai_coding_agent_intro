/**
 * Three end-to-end use cases + CLI against a live agent backend.
 *
 *   npm run example              # all three
 *   npm run example -- skills    # list all skills
 *   npm run example -- chat      # same-session multi-turn chat
 *   npm run example -- wetrack   # wetrack skill (streaming)
 *
 * Env: AGENT_BASE_URL, AGENT_JWT_SECRET, AGENT_EMAIL
 */

import {
  AgentClient,
  AgentClientError,
  collectText,
  type AgentEvent,
  type SkillSummary,
} from '../src/index.js'

export const DEFAULT_WETRACK_QUERY =
  'Get summary, status, and assignee for WeTrack issue DZ-149.'

export function createClient(): AgentClient {
  return new AgentClient({
    baseURL: process.env.AGENT_BASE_URL ?? 'http://10.150.115.69:4567',
    jwtSecret:
      process.env.AGENT_JWT_SECRET ??
      '9afd313591dc5a84dcf3022cb9f9bea05023672ca24716d1d7d9743d9be5d95d',
    email: process.env.AGENT_EMAIL ?? 'harry.liu@advantest.com',
  })
}

async function getSkill(
  client: AgentClient,
  name: string,
): Promise<SkillSummary> {
  const skill = (await client.listSkills()).skills.find(s => s.name === name)
  if (!skill) throw new Error(`${name} skill not found in workspace`)
  return skill
}

/** Build the SSE stream for wetrack (fork → invokeSkillStream, inline → /wetrack chat). */
export async function wetrackEvents(
  client: AgentClient,
  query = DEFAULT_WETRACK_QUERY,
): Promise<AsyncIterable<AgentEvent>> {
  const skill = await getSkill(client, 'wetrack')
  if (skill.context === 'fork') {
    return client.invokeSkillStream('wetrack', { arguments: query })
  }
  return client.chat({ message: `/wetrack ${query}` })
}

/** Print SSE events as they arrive; return final text. */
export async function printStream(
  events: AsyncIterable<AgentEvent>,
): Promise<string> {
  const deltas: string[] = []
  let final: string | undefined

  for await (const ev of events) {
    switch (ev.type) {
      case 'stream_event': {
        const delta = ev.delta as { kind?: string; text?: string } | undefined
        if (delta?.kind === 'text' && typeof delta.text === 'string') {
          deltas.push(delta.text)
          process.stdout.write(delta.text)
        }
        break
      }
      case 'tool_call':
        console.log(`\n[tool_call] ${ev.name}`)
        break
      case 'tool_result':
        console.log(`\n[tool_result] ${String(ev.result).slice(0, 400)}`)
        break
      case 'result':
        if (ev.subtype === 'success') {
          if (typeof ev.text === 'string') final = ev.text
          console.log(`\n[result] reason=${ev.reason}`)
        } else if (ev.subtype === 'error') {
          throw new AgentClientError(String(ev.error ?? 'stream error'), 0, ev)
        }
        break
    }
  }
  console.log()
  return final ?? deltas.join('')
}

// ── use case 3: list skills ───────────────────────────────────────────────

export async function listAllSkills(
  agent?: AgentClient,
): Promise<SkillSummary[]> {
  return (await (agent ?? createClient()).listSkills()).skills
}

export function printSkills(skills: SkillSummary[]): void {
  console.log('\n== skills ==')
  if (skills.length === 0) {
    console.log('(no skills found in this workspace)')
    return
  }
  for (const s of skills) {
    const desc =
      s.description.length > 60
        ? s.description.slice(0, 57) + '...'
        : s.description
    console.log(`  - ${s.name.padEnd(30)} [${s.context}] ${desc}`)
  }
}

// ── use case 1: same-session chat ───────────────────────────────────────────

export async function chatSameSession(agent?: AgentClient): Promise<string> {
  const { turn2Text } = await chatSameSessionTurns(agent)
  return turn2Text
}

export async function chatSameSessionTurns(agent?: AgentClient): Promise<{
  sessionId: string
  turn1Text: string
  turn2Text: string
}> {
  const client = agent ?? createClient()
  const turn1 = await client.chatComplete({
    message: 'My name is Harry. Please remember it for this conversation.',
  })
  if (!turn1.session_id) {
    throw new Error('server did not return session_id on first turn')
  }

  const turn2 = await client.chatComplete({
    message: 'What is my name? Answer in one short sentence.',
    session_id: turn1.session_id,
  })
  if (turn2.session_id !== turn1.session_id) {
    throw new Error(
      `session_id changed: ${turn1.session_id} -> ${turn2.session_id ?? 'undefined'}`,
    )
  }
  return {
    sessionId: turn1.session_id,
    turn1Text: turn1.text,
    turn2Text: turn2.text,
  }
}

export async function printChatSameSession(agent?: AgentClient): Promise<void> {
  console.log('\n== chat same-session ==')
  const { sessionId, turn1Text, turn2Text } = await chatSameSessionTurns(agent)
  console.log('\n--- turn 1 ---')
  console.log(turn1Text)
  console.log('session_id:', sessionId)
  console.log('\n--- turn 2 (same session) ---')
  console.log(turn2Text)
  console.log('session_id:', sessionId)
}

// ── use case 2: wetrack skill ───────────────────────────────────────────────

export async function invokeWetrack(
  agent?: AgentClient,
  query = DEFAULT_WETRACK_QUERY,
): Promise<string> {
  const client = agent ?? createClient()
  return collectText(await wetrackEvents(client, query))
}

export async function printWetrack(
  agent?: AgentClient,
  query = DEFAULT_WETRACK_QUERY,
): Promise<void> {
  const client = agent ?? createClient()
  const skill = await getSkill(client, 'wetrack')
  console.log(`\n== wetrack (context=${skill.context}) ==`)
  console.log('query:', query)
  if (skill.context !== 'fork') {
    console.log('slash message:', `/wetrack ${query}`)
  }
  await printStream(await wetrackEvents(client, query))
}

export async function runAllUseCases(agent?: AgentClient): Promise<void> {
  const client = agent ?? createClient()
  printSkills(await listAllSkills(client))
  await printChatSameSession(client)
  await printWetrack(client)
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const agent = createClient()
  const cmd = process.argv[2] ?? ''

  switch (cmd) {
    case 'skills':
      printSkills(await listAllSkills(agent))
      break
    case 'chat':
      await printChatSameSession(agent)
      break
    case 'wetrack':
      await printWetrack(agent)
      break
    case '':
      await runAllUseCases(agent)
      break
    default:
      console.error(`Unknown command: ${cmd}`)
      console.error('Usage: use-cases [skills|chat|wetrack]')
      process.exit(1)
  }
}

const entry = process.argv[1]?.replace(/\\/g, '/') ?? ''
if (
  entry.endsWith('/examples/use-cases.ts') ||
  entry.endsWith('/use-cases.ts')
) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
