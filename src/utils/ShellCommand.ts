/**
 * In-process background shell — lean stand-in for CC `utils/ShellCommand.ts`
 * when ExecutionBackend / Worker is absent (tests, scripts).
 */
import { spawn, type ChildProcess } from 'child_process'
import { forceKillChild } from '../core/platform.js'
import {
  prepareShellSpawn,
  type ShellKind,
} from '../core/shell/spawn-shell.js'
import { appendTaskOutput, initTaskOutput } from './task/diskOutput.js'

type InProcessBg = {
  taskId: string
  child: ChildProcess
  done: boolean
  exitCode: number | null
  killed: boolean
  result: Promise<{ code: number | null; interrupted: boolean }>
}

const byTaskId = new Map<string, InProcessBg>()

process.on('exit', () => {
  for (const p of byTaskId.values()) {
    if (!p.done) {
      try {
        forceKillChild(p.child)
      } catch {
        /* ignore */
      }
    }
  }
})

export function killInProcessBackground(taskId: string): void {
  const p = byTaskId.get(taskId)
  if (!p || p.done) return
  p.killed = true
  forceKillChild(p.child)
}

export function spawnInProcessBackground(opts: {
  taskId: string
  command: string
  cwd: string
  shell: ShellKind
}): InProcessBg {
  initTaskOutput(opts.taskId)
  const prepared = prepareShellSpawn({
    shell: opts.shell,
    userCommand: opts.command,
    cwdFilePrefix: 'agent-bg-cwd',
  })
  const child = spawn(prepared.command, prepared.args, {
    cwd: opts.cwd,
    env: prepared.env,
    windowsHide: true,
    detached: process.platform !== 'win32',
  })

  const entry: InProcessBg = {
    taskId: opts.taskId,
    child,
    done: false,
    exitCode: null,
    killed: false,
    result: Promise.resolve({ code: null, interrupted: false }),
  }

  entry.result = new Promise(resolve => {
    child.stdout?.on('data', (chunk: Buffer) => {
      appendTaskOutput(opts.taskId, chunk.toString('utf8'))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      appendTaskOutput(opts.taskId, chunk.toString('utf8'))
    })
    child.on('close', code => {
      entry.done = true
      entry.exitCode = code
      resolve({
        code,
        interrupted: entry.killed,
      })
      setTimeout(() => byTaskId.delete(opts.taskId), 60_000).unref?.()
    })
    child.on('error', () => {
      entry.done = true
      entry.exitCode = 1
      resolve({ code: 1, interrupted: entry.killed })
    })
  })

  byTaskId.set(opts.taskId, entry)
  return entry
}

export function pollInProcessBackground(taskId: string): {
  done: boolean
  exitCode: number | null
  killed?: boolean
} | null {
  const p = byTaskId.get(taskId)
  if (!p) return null
  return { done: p.done, exitCode: p.exitCode, killed: p.killed }
}
