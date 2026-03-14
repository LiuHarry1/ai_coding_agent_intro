import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export function createProvider({
  name = "copilot-proxy",
  baseURL = "http://localhost:4141/v1",
  apiKey = "not-needed",
} = {}) {
  return createOpenAICompatible({ name, baseURL, apiKey });
}
