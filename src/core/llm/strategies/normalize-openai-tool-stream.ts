/**
 * LiteLLM / Qwen / vLLM often stream parallel OpenAI tool_calls out of spec:
 * a new `index` arrives with only `function.arguments` (no `id` / `name`),
 * or later chunks omit `index` entirely.
 *
 * `@ai-sdk/openai-compatible` requires id + function.name on the *first*
 * delta of each index and throws otherwise. This rewrite buffers until that
 * start event can be synthesized — same invariant as Anthropic
 * `content_block_start` (name first, JSON deltas after).
 */

type ToolCallDelta = {
  index?: number
  id?: string
  type?: string
  function?: {
    name?: string
    arguments?: string
  }
}

type ChatChunk = {
  choices?: Array<{
    delta?: {
      content?: unknown
      tool_calls?: ToolCallDelta[]
      [key: string]: unknown
    }
    finish_reason?: unknown
    [key: string]: unknown
  }>
  [key: string]: unknown
}

type OpenedTool = { id: string; name: string }
type PendingTool = { id?: string; name?: string; arguments: string }

function coerceIndex(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    return Number(value)
  }
  return fallback
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export class OpenAIToolCallNormalizer {
  private readonly opened = new Map<number, OpenedTool>()
  private readonly pending = new Map<number, PendingTool>()
  private lastIndex = 0
  private synthSeq = 0

  rewriteChunk(value: unknown): unknown | null {
    if (!value || typeof value !== 'object') return value
    const chunk = value as ChatChunk
    const choice = chunk.choices?.[0]
    if (!choice) return value

    const delta = choice.delta
    const rawCalls = delta?.tool_calls
    const hasCalls = Array.isArray(rawCalls) && rawCalls.length > 0
    const shouldFlush = choice.finish_reason != null && choice.finish_reason !== ''

    const outgoing: ToolCallDelta[] = []
    if (hasCalls && rawCalls) {
      for (const tc of rawCalls) {
        const emitted = this.absorb(tc)
        if (emitted) outgoing.push(emitted)
      }
    }
    if (shouldFlush) {
      outgoing.push(...this.flushNamedPending())
    }

    if (!hasCalls && !shouldFlush) return value

    if (outgoing.length === 0) {
      if (!hasCalls) return value
      if (deltaHasOtherPayload(delta, choice)) {
        const next = cloneChunk(chunk)
        const nextDelta = next.choices?.[0]?.delta
        if (nextDelta) delete nextDelta.tool_calls
        return next
      }
      return null
    }

    const next = cloneChunk(chunk)
    const nextChoice = next.choices?.[0]
    if (!nextChoice) return next
    nextChoice.delta = { ...(nextChoice.delta ?? {}), tool_calls: outgoing }
    return next
  }

  flushNamedPending(): ToolCallDelta[] {
    const outgoing: ToolCallDelta[] = []
    for (const [index, pend] of [...this.pending]) {
      const started = this.emitStart(index, pend)
      if (started) outgoing.push(started)
    }
    return outgoing
  }

  reset(): void {
    this.opened.clear()
    this.pending.clear()
    this.lastIndex = 0
    this.synthSeq = 0
  }

  private absorb(tc: ToolCallDelta): ToolCallDelta | null {
    const index = coerceIndex(tc.index, this.lastIndex)
    this.lastIndex = index

    const id = nonEmptyString(tc.id)
    const name = nonEmptyString(tc.function?.name)
    const args =
      typeof tc.function?.arguments === 'string' ? tc.function.arguments : ''

    const opened = this.opened.get(index)
    if (opened) {
      return {
        index,
        ...(id ? { id } : {}),
        ...(tc.type ? { type: tc.type } : {}),
        function: {
          ...(name ? { name } : {}),
          ...(args ? { arguments: args } : {}),
        },
      }
    }

    const pend = this.pending.get(index) ?? { arguments: '' }
    if (id) pend.id = id
    if (name) pend.name = name
    if (args) pend.arguments += args
    this.pending.set(index, pend)
    return this.emitStart(index, pend)
  }

  private emitStart(index: number, pend: PendingTool): ToolCallDelta | null {
    if (!pend.name) return null
    const id = pend.id ?? `call_norm_${index}_${++this.synthSeq}`
    this.pending.delete(index)
    this.opened.set(index, { id, name: pend.name })
    return {
      index,
      id,
      type: 'function',
      function: {
        name: pend.name,
        arguments: pend.arguments,
      },
    }
  }
}

function deltaHasOtherPayload(
  delta: { [key: string]: unknown } | undefined,
  choice: { finish_reason?: unknown },
): boolean {
  if (choice.finish_reason != null && choice.finish_reason !== '') return true
  if (!delta) return false
  return Object.keys(delta).some(key => key !== 'tool_calls' && delta[key] != null)
}

function cloneChunk(chunk: ChatChunk): ChatChunk {
  return structuredClone(chunk)
}

/** Rewrite a complete SSE document (one or more `data:` events). */
export function normalizeOpenAICompatibleSse(text: string): string {
  const normalizer = new OpenAIToolCallNormalizer()
  return rewriteSseText(text, normalizer)
}

export function rewriteSseText(
  text: string,
  normalizer: OpenAIToolCallNormalizer,
): string {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  for (const line of lines) {
    const rewritten = rewriteSseLine(line, normalizer)
    if (rewritten !== null) out.push(rewritten)
  }
  return out.join('\n')
}

export function rewriteSseLine(
  line: string,
  normalizer: OpenAIToolCallNormalizer,
): string | null {
  if (!line.startsWith('data:')) return line
  const payload = line.slice(5).trimStart()
  if (payload === '[DONE]') {
    const flushed = flushAsSseLines(normalizer)
    return flushed.length > 0 ? `${flushed.join('\n')}\n${line}` : line
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return line
  }
  const rewritten = normalizer.rewriteChunk(parsed)
  if (rewritten == null) return null
  if (rewritten === parsed) return line
  return `data: ${JSON.stringify(rewritten)}`
}

function flushAsSseLines(normalizer: OpenAIToolCallNormalizer): string[] {
  const leftover = normalizer.flushNamedPending()
  if (leftover.length === 0) return []
  return [
    `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: leftover }, finish_reason: null }],
    })}`,
  ]
}

export function createOpenAIToolCallNormalizeTransform(): TransformStream<
  string,
  string
> {
  const normalizer = new OpenAIToolCallNormalizer()
  let carry = ''
  return new TransformStream({
    transform(chunk, controller) {
      carry += chunk
      carry = carry.replace(/\r\n/g, '\n')
      const parts = carry.split('\n')
      carry = parts.pop() ?? ''
      for (const line of parts) {
        const rewritten = rewriteSseLine(line, normalizer)
        if (rewritten !== null) controller.enqueue(`${rewritten}\n`)
      }
    },
    flush(controller) {
      if (carry.length > 0) {
        const rewritten = rewriteSseLine(carry, normalizer)
        if (rewritten !== null) controller.enqueue(`${rewritten}\n`)
        carry = ''
      }
      for (const line of flushAsSseLines(normalizer)) {
        controller.enqueue(`${line}\n`)
      }
    },
  })
}

function requestWantsStream(init?: RequestInit): boolean {
  const body = init?.body
  if (typeof body !== 'string') return false
  try {
    return (JSON.parse(body) as { stream?: unknown }).stream === true
  } catch {
    return false
  }
}

function shouldNormalizeResponse(
  response: Response,
  init?: RequestInit,
): boolean {
  if (!response.body || !response.ok) return false
  const ct = response.headers.get('content-type') ?? ''
  if (ct.includes('text/event-stream')) return true
  if (ct.includes('application/json')) return false
  return requestWantsStream(init)
}

export function createNormalizedOpenAICompatibleFetch(
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init)
    if (!shouldNormalizeResponse(response, init) || !response.body) {
      return response
    }
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    const body = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(createOpenAIToolCallNormalizeTransform())
      .pipeThrough(new TextEncoderStream())
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}
