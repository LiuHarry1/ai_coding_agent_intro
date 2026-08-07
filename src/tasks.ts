/**
 * Task type registry — Claude Code `src/tasks.ts`.
 */
import type { Task, TaskType } from './Task.js'
import { LocalShellTask } from './tasks/LocalShellTask/LocalShellTask.js'

export function getAllTasks(): Task[] {
  return [LocalShellTask]
}

export function getTaskByType(type: TaskType): Task | undefined {
  return getAllTasks().find(t => t.type === type)
}
