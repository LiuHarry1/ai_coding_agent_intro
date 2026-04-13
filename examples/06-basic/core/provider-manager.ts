import { createOpenAI } from "@ai-sdk/openai";
import { configManager } from "./config-manager.js";
import type { IProvider } from "./types.js";

function createProviderFromConfig(): IProvider {
  const { name, baseURL, apiKey } = configManager.get("provider");
  const openai = createOpenAI({ name, baseURL, apiKey });
  return {
    chatModel: (modelId) => openai.chat(modelId),
  };
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
