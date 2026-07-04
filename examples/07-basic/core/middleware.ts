import type {
  IMiddleware,
  IEventBus,
  MiddlewareHook,
  MiddlewareHandler,
  MiddlewareContext,
} from './types.js'

export class Middleware implements IMiddleware {
  #hooks = new Map<MiddlewareHook, MiddlewareHandler[]>()

  use(hook: MiddlewareHook, handler: MiddlewareHandler): void {
    if (!this.#hooks.has(hook)) this.#hooks.set(hook, [])
    this.#hooks.get(hook)!.push(handler)
  }

  async #run(hook: MiddlewareHook, ctx: MiddlewareContext): Promise<void> {
    const handlers = this.#hooks.get(hook)
    if (!handlers) return
    for (const handler of handlers) {
      await handler(ctx)
    }
  }

  wrap(
    name: string,
    executeFn: (args: unknown) => Promise<unknown>,
  ): (args: unknown) => Promise<unknown> {
    const self = this
    return async (args: unknown) => {
      const ctx: MiddlewareContext = { name, args, startTime: Date.now() }
      await self.#run('beforeTool', ctx)
      try {
        const result = await executeFn(args)
        ctx.result = result
        ctx.duration = Date.now() - ctx.startTime
        await self.#run('afterTool', ctx)
        return result
      } catch (error) {
        ctx.error = error
        ctx.duration = Date.now() - ctx.startTime
        await self.#run('onError', ctx)
        throw error
      }
    }
  }
}

export function createTimingMiddleware(eventBus: IEventBus) {
  return {
    afterTool(ctx: MiddlewareContext): void {
      console.log('tool_timing', ctx.name, ctx.duration)
      eventBus.emit('tool_timing', { name: ctx.name, duration: ctx.duration })
    },
  }
}
