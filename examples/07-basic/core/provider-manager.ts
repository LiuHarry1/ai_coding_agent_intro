import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { configManager } from "./config-manager.js";
import type { IProvider } from "./types.js";

/**
 * Picks the right SDK adapter based on whether reasoning control is requested.
 *
 * - reasoningEffort === "none" → `@ai-sdk/openai-compatible` + /chat/completions.
 *   Maximum compatibility with OpenAI-compatible proxies. No strict-tools quirks,
 *   no Responses API event protocol, no reasoning summary plumbing.
 *
 * - reasoningEffort !== "none" → `@ai-sdk/openai` + /v1/responses.
 *   Required for gpt-5 family when combining tools + reasoning_effort, and the
 *   only path that can surface reasoning summary text.
 */
/**
 * Wraps fetch so we can inspect what the OpenAI SDK actually POSTs to
 * /v1/responses. Set `OPENAI_DEBUG_REQUEST=1` to dump the request body of
 * every call, or leave it unset to only dump bodies of failed (>=400)
 * requests. Useful for debugging multi-turn reasoning replay issues where
 * the upstream returns a cryptic 4xx and you need to see which `input`
 * items (especially `{type:"reasoning", id, encrypted_content}`) were sent.
 */
function createDebugFetch(): typeof fetch {
  const dumpAll = process.env.OPENAI_DEBUG_REQUEST === "1";
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body;
    const response = await fetch(input, init);

    const shouldDump = dumpAll || !response.ok;
    if (shouldDump && body && typeof body === "string" && url.includes("/responses")) {
      try {
        const parsed = JSON.parse(body);
        const summary = {
          status: response.status,
          model: parsed.model,
          input_count: Array.isArray(parsed.input) ? parsed.input.length : undefined,
          input_types: Array.isArray(parsed.input)
            ? parsed.input.map((it: { type?: string; role?: string; id?: string }) => ({
                type: it.type ?? `role:${it.role}`,
                id: it.id ? `${it.id.slice(0, 24)}…(${it.id.length})` : undefined,
              }))
            : undefined,
          tool_count: Array.isArray(parsed.tools) ? parsed.tools.length : undefined,
          include: parsed.include,
          reasoning: parsed.reasoning,
        };
        console.error("[openai-debug] /responses request:", JSON.stringify(summary, null, 2));
      } catch {
        console.error("[openai-debug] failed to parse request body");
      }
    }
    return response;
  };
}

function createProviderFromConfig(): IProvider {
  const { name, baseURL, apiKey, reasoningEffort } = configManager.get("provider");

  if (reasoningEffort && reasoningEffort !== "none") {
    const openai = createOpenAI({ name, baseURL, apiKey, fetch: createDebugFetch() });
    return { chatModel: (modelId) => openai.responses(modelId) };
  }

  const compat = createOpenAICompatible({
    name: name ?? "openai-compatible",
    baseURL,
    apiKey,
  });
  return { chatModel: (modelId) => compat.chatModel(modelId) };
}

interface ProviderEntry {
  name: string;
  factory: () => IProvider;
  instance?: IProvider;
}

export class ProviderManager {
  #providers = new Map<string, ProviderEntry>();
  #default: string | null = null;

  register(
    name: string,
    factory: () => IProvider,
    options: { default?: boolean } = {}
  ): void {
    this.#providers.set(name, { name, factory });
    if (options.default || this.#providers.size === 1) {
      this.#default = name;
    }
  }

  /** Drop cached instance so next get() rebuilds with fresh config. */
  invalidate(name?: string): void {
    if (name) {
      const entry = this.#providers.get(name);
      if (entry) entry.instance = undefined;
    } else {
      for (const entry of this.#providers.values()) entry.instance = undefined;
    }
  }

  get(name?: string): IProvider {
    const key = name ?? this.#default;
    if (!key) throw new Error("No providers registered");

    const entry = this.#providers.get(key);
    if (!entry) throw new Error(`Provider "${key}" not found`);

    if (!entry.instance) {
      entry.instance = entry.factory();
    }
    return entry.instance;
  }

  list(): string[] {
    return [...this.#providers.keys()];
  }

  get defaultName(): string | null {
    return this.#default;
  }
}

export const defaultManager = new ProviderManager();

defaultManager.register(
  "default",
  () => createProviderFromConfig(),
  { default: true }
);

configManager.onChange("provider", () => {
  defaultManager.invalidate();
  console.log("[provider] Config changed, provider will be rebuilt on next request.");
});
