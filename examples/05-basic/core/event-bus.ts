import type { EventHandler, IEventBus } from "./types.js";

export class EventBus implements IEventBus {
  #listeners = new Map<string, Set<EventHandler>>();

  on(event: string, handler: EventHandler): () => void {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event)!.add(handler);
    return () => this.off(event, handler);
  }

  off(event: string, handler: EventHandler): void {
    this.#listeners.get(event)?.delete(handler);
  }

  emit(event: string, data?: unknown): void {
    this.#listeners.get(event)?.forEach((h) => h(data, event));
    this.#listeners.get("*")?.forEach((h) => h(data, event));
  }

  scoped(prefix: string): IEventBus {
    const parent = this as IEventBus;
    return {
      emit(event: string, data?: unknown) {
        parent.emit(`${prefix}_${event}`, data);
      },
      on(event: string, handler: EventHandler) {
        return parent.on(`${prefix}_${event}`, handler);
      },
      off(event: string, handler: EventHandler) {
        parent.off(`${prefix}_${event}`, handler);
      },
      scoped(childPrefix: string) {
        return (parent as EventBus).scoped(`${prefix}_${childPrefix}`);
      },
      removeAllListeners() {
        (parent as EventBus).removeAllListeners();
      },
    };
  }

  removeAllListeners(): void {
    this.#listeners.clear();
  }
}
