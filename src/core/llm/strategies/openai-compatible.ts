import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ProviderStrategy } from '../types.js'

/**
 * Generic OpenAI-compatible chat endpoint (copilot-proxy, Ollama, vLLM, …).
 * No reasoning/thinking knobs — `thinking` from the profile is intentionally ignored.
 */
export const openaiCompatibleStrategy: ProviderStrategy = {
  id: 'openai-compatible',
  build(p) {
    const client = createOpenAICompatible({
      name: p.name ?? 'openai-compatible',
      baseURL: p.baseURL,
      apiKey: p.apiKey,
    })
    return {
      chatModel: id => client.chatModel(id),
      streamTextExtras: () => ({}),
      defaultModelId: () => p.model,
      // chat/completions JSON.stringifies content arrays — images must be
      // relocated to a user message instead.
      supportsToolResultContentBlocks: () => false,
      describe: () => `openai-compatible model=${p.model}`,
    }
  },
}
