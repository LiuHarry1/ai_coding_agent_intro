/**
 * Single-shot side query for memory relevance selection (no tool loop).
 */
import { generateText } from 'ai'
import type { IProvider } from '../../core/llm/types.js'

export type SideQueryJsonOpts = {
  provider: IProvider
  modelId: string
  system: string
  user: string
  maxOutputTokens?: number
  signal?: AbortSignal
}

/**
 * Run a small completion and parse JSON from the response text.
 * Strips optional ```json fences. Returns null on failure/abort.
 */
export async function sideQueryJson<T>(
  opts: SideQueryJsonOpts,
): Promise<T | null> {
  try {
    const result = await generateText({
      model: opts.provider.chatModel(opts.modelId),
      system: opts.system,
      prompt: opts.user,
      maxOutputTokens: opts.maxOutputTokens ?? 256,
      abortSignal: opts.signal,
      ...opts.provider.streamTextExtras(),
    })
    const text = result.text?.trim() ?? ''
    if (!text) return null
    const parsed = parseJsonFromModelText<T>(text)
    if (parsed === null) {
      console.warn(
        `[auto-memory] sideQueryJson failed: no JSON object in response`,
      )
    }
    return parsed
  } catch (e) {
    if (opts.signal?.aborted) return null
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[auto-memory] sideQueryJson failed: ${msg}`)
    return null
  }
}

/** Parse JSON from model text: raw, fenced, or first {...} substring. */
export function parseJsonFromModelText<T>(text: string): T | null {
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  try {
    return JSON.parse(unfenced) as T
  } catch {
    // fall through
  }
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(unfenced.slice(start, end + 1)) as T
    } catch {
      return null
    }
  }
  return null
}
