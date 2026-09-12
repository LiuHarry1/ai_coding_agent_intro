/**
 * Full-compact cache-safe fork unit tests (no live LLM).
 * Run: npx tsx src/scripts/test-full-compact-cache-safe.ts
 */
import assert from 'node:assert/strict'
import type { LanguageModel } from 'ai'
import { compactConversation } from '../services/compact/compact.js'
import { createCacheSafeParams } from '../core/forked-agent.js'
import type {
  AgentOptions,
  AnyTool,
  IProvider,
  Message,
  RunAgentFn,
} from '../core/types.js'

const messages: Message[] = [
  { role: 'user', content: 'first request', uuid: 'u1' },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'first response' }],
    id: 'round-1',
    uuid: 'a1',
  },
  { role: 'user', content: 'second request', uuid: 'u2' },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'second response' }],
    id: 'round-2',
    uuid: 'a2',
  },
]

function fakeModel(generate: () => string | never): LanguageModel {
  return {
    specificationVersion: 'v3',
    provider: 'compact-test',
    modelId: 'main-model',
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: 'text', text: generate() }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: {
          total: 1,
          noCache: 1,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
    doStream: async () => {
      throw new Error('not used')
    },
  } as unknown as LanguageModel
}

function providerFor(model: LanguageModel): IProvider {
  return {
    chatModel: () => model,
    streamTextExtras: () => ({}),
    defaultModelId: () => 'main-model',
    describe: () => 'compact-test',
  }
}

function context(
  provider: IProvider,
  runAgent?: RunAgentFn,
  tools: Record<string, AnyTool> = {},
) {
  return {
    cwd: process.cwd(),
    todos: [],
    fileRestore: { maxFiles: 0, maxTokensPerFile: 0, totalBudget: 0 },
    provider,
    runAgent,
    cacheSafeParams: runAgent
      ? createCacheSafeParams({
          systemPrompt: 'main-system',
          tools,
          provider,
          model: 'main-model',
          messages,
        })
      : undefined,
  }
}

async function testCacheSafeFork(): Promise<void> {
  const originalExecute = async () => 'must not run'
  const tools = {
    Bash: { execute: originalExecute },
  } as unknown as Record<string, AnyTool>
  let seen:
    { prompt: string; options: AgentOptions; denied: unknown } | undefined
  const runAgent: RunAgentFn = async (prompt, options) => {
    const denied = await (
      options.tools.Bash as unknown as {
        execute: (input: unknown) => Promise<unknown>
      }
    ).execute({ command: 'echo forbidden' })
    seen = { prompt, options, denied }
    return '<analysis>scratch</analysis><summary>fork summary</summary>'
  }

  const result = await compactConversation(
    messages,
    'main-model',
    context(providerFor(fakeModel(() => 'unused')), runAgent, tools),
  )

  assert(result)
  assert.equal(result.summary, 'fork summary')
  assert.deepEqual(result.messagesToKeep, [])
  assert.equal(
    result.appendMessages.some(message =>
      messages.some(original => original.uuid === message.uuid),
    ),
    false,
    'ordinary Full compact appends no verbatim tail',
  )
  assert(seen)
  assert.deepEqual(seen.options.messages, messages)
  assert.equal(seen.options.systemPrompt, 'main-system')
  assert.equal(seen.options.provider.describe(), 'compact-test')
  assert.equal(seen.options.model, 'main-model')
  assert.deepEqual(Object.keys(seen.options.tools), ['Bash'])
  assert.equal(seen.options.maxSteps, 1)
  assert.equal(seen.options.compaction?.enabled, false)
  assert.equal(seen.options.sessionMemory, undefined)
  assert.equal((await seen.options.canUseTool?.('Bash', {}))?.behavior, 'deny')
  assert.match(String(seen.denied), /disabled/)
  assert.match(seen.prompt, /compacting an AI coding agent/)
}

async function testPtlPrefixRetry(): Promise<void> {
  const prefixes: string[][] = []
  const prompts: string[] = []
  let forkCalls = 0
  const runAgent: RunAgentFn = async (prompt, options) => {
    prompts.push(prompt)
    prefixes.push((options.messages ?? []).map(m => m.uuid ?? ''))
    forkCalls++
    if (forkCalls === 1) throw new Error('context length exceeded')
    return '<summary>retry summary</summary>'
  }
  const fallbackModel = fakeModel(() => {
    throw new Error('context length exceeded')
  })
  const tools = { Bash: {} as AnyTool }

  const result = await compactConversation(
    messages,
    'main-model',
    context(providerFor(fallbackModel), runAgent, tools),
  )

  assert(result)
  assert.equal(result.summary, 'retry summary')
  assert.equal(prefixes.length, 2)
  assert.deepEqual(prefixes[0], ['u1', 'a1', 'u2', 'a2'])
  assert.deepEqual(prefixes[1], ['u2', 'a2'])
  assert.equal(prompts[0], prompts[1])
}

async function testFallbacks(): Promise<void> {
  let fallbackCalls = 0
  const provider = providerFor(
    fakeModel(() => {
      fallbackCalls++
      return '<analysis>drop</analysis><summary>fallback summary</summary>'
    }),
  )
  const failingRunner: RunAgentFn = async () => {
    throw new Error('fork unavailable')
  }
  const tools = { Bash: {} as AnyTool }

  const failedFork = await compactConversation(
    messages,
    'main-model',
    context(provider, failingRunner, tools),
  )
  const missingRunner = await compactConversation(
    messages,
    'main-model',
    context(provider),
  )

  assert.equal(failedFork?.summary, 'fallback summary')
  assert.equal(missingRunner?.summary, 'fallback summary')
  assert.equal(fallbackCalls, 2)
}

await testCacheSafeFork()
await testPtlPrefixRetry()
await testFallbacks()
console.log('[ok] full compact cache-safe fork, PTL retry, and fallbacks')
