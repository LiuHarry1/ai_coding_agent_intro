import { configManager } from "./config-manager.js";
import { buildProvider } from "./llm/index.js";
import type { IProvider } from "./llm/types.js";

/**
 * Runtime LLM wiring is delegated to {@link buildProvider} in `core/llm/`.
 * Each provider has its own strategy (openai / anthropic / openai-compatible);
 * the agent only consumes the unified `IProvider` interface and never branches
 * on provider id.
 */

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
  () => buildProvider(configManager.get("provider")),
  { default: true }
);

configManager.onChange("provider", () => {
  defaultManager.invalidate();
  console.log("[provider] Config changed, provider will be rebuilt on next request.");
});
