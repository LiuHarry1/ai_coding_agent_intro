import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/** Plain OpenAI-compatible transport; always sends SDK default `max_tokens` when set. */
export function createProvider({
  name = "copilot-proxy",
  baseURL = "http://localhost:4141/v1",
  apiKey = "not-needed",
} = {}) {
  return createOpenAICompatible({ name, baseURL, apiKey });
}
