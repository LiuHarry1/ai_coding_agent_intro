/**
 * Unit smoke for CC-aligned dump-prompts (no live LLM required).
 * Run: DUMP_PROMPTS=1 npx tsx src/scripts/test-dump-prompts.ts
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  clearAllDumpState,
  createDumpPromptsRecorder,
  isDumpPromptsEnabled,
} from '../services/api/dumpPrompts.js'

async function sleep(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms))
}

async function main(): Promise<void> {
  process.env.DUMP_PROMPTS = '1'
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dump-prompts-test-'))
  process.env.DUMP_PROMPTS_DIR = dir

  clearAllDumpState()
  assert.equal(isDumpPromptsEnabled(), true)

  const key = 'unit-test-session'
  const rec = createDumpPromptsRecorder(key)
  assert.equal(rec.path, path.join(dir, `${key}.jsonl`))

  const ts1 = rec.dumpRequest({
    model: 'test-model',
    system: 'You are a test agent.',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'Bash', description: 'run shell' }],
    provider: 'unit',
    step: 0,
  })

  await sleep(50)

  rec.dumpResponse(ts1, {
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }],
    usage: { inputTokens: 10, outputTokens: 2 },
    toolCalls: [],
    step: 0,
  })

  // Step 2: only new user/tool messages should append.
  const ts2 = rec.dumpRequest({
    model: 'test-model',
    system: 'You are a test agent.',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'tool', content: 'tool-out', toolCallId: 't1' },
      { role: 'user', content: 'again' },
    ],
    tools: [{ name: 'Bash', description: 'run shell' }],
    provider: 'unit',
    step: 1,
  })
  await sleep(50)
  rec.dumpResponse(ts2, {
    messages: [{ role: 'assistant', content: 'done' }],
    usage: { inputTokens: 20, outputTokens: 1 },
    step: 1,
  })
  await sleep(80)

  const raw = await fs.readFile(rec.path, 'utf8')
  const lines = raw
    .trim()
    .split('\n')
    .map(l => JSON.parse(l) as { type: string; data?: unknown })

  const types = lines.map(l => l.type)
  console.log('record types:', types.join(' → '))
  assert.ok(types.includes('init'), 'missing init')
  assert.ok(types.includes('message'), 'missing message')
  assert.ok(types.filter(t => t === 'response').length >= 2, 'need 2 responses')

  // First message should be the initial user turn.
  const firstMsg = lines.find(l => l.type === 'message')
  assert.ok(firstMsg)
  assert.equal((firstMsg!.data as { role: string }).role, 'user')

  // Second request should emit tool + new user (not re-dump first user).
  const msgs = lines.filter(l => l.type === 'message')
  const roles = msgs.map(m => (m.data as { role: string }).role)
  assert.deepEqual(roles, ['user', 'tool', 'user'])

  // system_update only if fingerprint changes — same model/tools/system → none
  assert.equal(types.includes('system_update'), false)

  // Change tool set → system_update
  clearAllDumpState()
  const rec2 = createDumpPromptsRecorder('unit-test-session-2')
  rec2.dumpRequest({
    model: 'test-model',
    system: 'sys',
    messages: [{ role: 'user', content: 'a' }],
    tools: [{ name: 'A' }],
  })
  await sleep(40)
  rec2.dumpRequest({
    model: 'test-model',
    system: 'sys',
    messages: [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ],
    tools: [{ name: 'A' }, { name: 'B' }],
  })
  await sleep(80)
  const raw2 = await fs.readFile(rec2.path, 'utf8')
  const types2 = raw2
    .trim()
    .split('\n')
    .map(l => (JSON.parse(l) as { type: string }).type)
  assert.ok(types2.includes('init'))
  assert.ok(types2.includes('system_update'), `expected system_update, got ${types2}`)

  console.log('OK dump-prompts unit smoke')
  console.log('wrote:', rec.path)
  console.log('sample first line:', raw.split('\n')[0]!.slice(0, 180) + '…')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
