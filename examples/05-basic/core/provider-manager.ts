import type { IProvider, ProviderConfig } from "./types.js";
import { createProvider } from "../../../shared/provider.js";

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
  "copilot-proxy",
  () => createProvider({ name: "copilot-proxy" }) as IProvider,
  { default: true }
);
