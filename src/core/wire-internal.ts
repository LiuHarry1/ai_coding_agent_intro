import type { IEventBus, TodoItem } from './types.js'
import type { WireEmitter } from './wire-emitter.js'

/** Wire + internal bus for events consumed by both GUI and agent state. */
export function emitTodoUpdate(
  wire: WireEmitter,
  bus: IEventBus,
  todos: TodoItem[],
): void {
  wire.todoUpdate(todos)
  bus.emit('todo_update', { todos })
}

export function emitModeChanged(
  wire: WireEmitter,
  bus: IEventBus,
  mode: string,
): void {
  wire.modeChanged(mode)
  bus.emit('mode_changed', { mode })
}

export function emitPlanReady(
  wire: WireEmitter,
  bus: IEventBus,
  data: { plan: string; filePath: string; approved?: boolean },
): void {
  wire.planReady({
    plan: data.plan,
    file_path: data.filePath,
    approved: data.approved,
  })
  bus.emit('plan_ready', data)
}
