import type {
  IMiddleware,
  IEventBus,
  MiddlewareHook,
  MiddlewareHandler,
  MiddlewareContext,
} from '../types.js'
import type { WireEmitter } from '../wire-emitter.js'

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
    executeFn: (args: unknown, options?: unknown) => Promise<unknown>,
  ): (args: unknown, options?: unknown) => Promise<unknown> {
    const self = this
    return async (args: unknown, options?: unknown) => {
      const toolCallId =
        options &&
        typeof options === 'object' &&
        typeof (options as { toolCallId?: unknown }).toolCallId === 'string'
          ? (options as { toolCallId: string }).toolCallId
          : undefined
      const ctx: MiddlewareContext = {
        name,
        args,
        startTime: Date.now(),
        ...(toolCallId ? { toolCallId } : {}),
      }
      await self.#run('beforeTool', ctx)
      try {
        const result = await executeFn(args, options)
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

export function createTimingMiddleware(
  wire: WireEmitter,
  logLabel = 'main',
) {
  const tag = `agent:${logLabel}`
  return {
    afterTool(ctx: MiddlewareContext): void {
      console.log(
        `[${tag}] tool_timing ${ctx.name} ${ctx.duration}` +
          (ctx.toolCallId ? ` id=${ctx.toolCallId}` : ''),
      )
      wire.toolTiming(ctx.name, ctx.duration ?? 0, ctx.toolCallId)
    },
  }
}
