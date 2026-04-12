import { createOpenAI } from "@ai-sdk/openai";

/**
 * Uses `@ai-sdk/openai` (not openai-compatible). For GPT-5 / reasoning models the SDK
 * maps `maxOutputTokens` to `max_completion_tokens` and drops `max_tokens` (see getArgs in that package).
 * Point `baseURL` at your OpenAI-compatible proxy (e.g. http://localhost:4141/v1).
 *
 * For a minimal compatible client that only sends `max_tokens`, use `./provider-legacy.js`.
 */
export function createProvider({
  name = "copilot-proxy",
  baseURL = "http://localhost:4141/v1",
  apiKey = "not-needed",
  fetch: fetchImpl,
} = {}) {
  const openai = createOpenAI({
    name,
    baseURL,
    apiKey,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return {
    chatModel: (modelId) => openai.chat(modelId),
  };
}
