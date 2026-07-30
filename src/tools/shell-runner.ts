import { tool } from 'ai'
import { z } from 'zod'
import { spawn, type ChildProcess } from 'child_process'
import { truncate } from './utils.js'
import { killChild, forceKillChild } from '../core/platform.js'
import type { ToolDefinition, ToolContext } from '../core/types.js'
import { isShellInputConcurrencySafe } from '../core/shell/shell-readonly.js'
import {
  prepareShellSpawn,
  readCwdAfter,
  cleanupCwdFile,
  type ShellKind,
} from '../core/shell/spawn-shell.js'

/**
 * Shared execution machinery for Bash / PowerShell tools.
 * Spawn argv/env/cwd tracking: `core/shell/spawn-shell.ts` (same as Worker).
 * This file owns background PIDs, output capping, progress, timeout/kill.
 */

// ── Background process tracking ──

const MAX_BUFFER = 100_000
const PROGRESS_INTERVAL_MS = 2_000

interface TrackedProcess {
  pid: number
  command: string
  child: ChildProcess
  stdout: string
  stderr: string
  exitCode: number | null
  done: boolean
  killed: boolean
  startTime: number
}

const bgProcs = new Map<number, TrackedProcess>()

process.on('exit', () => {
  for (const p of bgProcs.values()) {
    if (!p.done)
      try {
        forceKillChild(p.child)
      } catch {}
  }
})

function cappedAppend(buf: string, chunk: string): string {
  const combined = buf + chunk
  if (combined.length <= MAX_BUFFER) return combined
  return '...[earlier output truncated]\n' + combined.slice(-MAX_BUFFER)
}

function elapsedSec(start: number): string {
  return ((Date.now() - start) / 1000).toFixed(1)
}

function formatOutput(proc: TrackedProcess): string {
  let out = proc.stdout || ''
  if (proc.stderr)
    out += (out ? '\n' : '') + `<stderr>\n${proc.stderr}</stderr>`
  if (proc.done && proc.exitCode !== 0 && proc.exitCode !== null)
    out += `\n[exit code: ${proc.exitCode}]`
  return (
    out ||
    (proc.done
      ? proc.exitCode === 0
        ? '(no output)'
        : `(no output, exit code ${proc.exitCode})`
      : '(no output yet)')
  )
}

function checkProcess(pid: number): string {
  const proc = bgProcs.get(pid)
  if (!proc) return `Error: no background process with pid ${pid}`
  const status = proc.done
    ? `[pid ${pid}] finished (exit ${proc.exitCode}, ${elapsedSec(proc.startTime)}s)`
    : `[pid ${pid}] running (${elapsedSec(proc.startTime)}s)`
  const result = truncate(`${status}\n\n${formatOutput(proc)}`)
  if (proc.done) bgProcs.delete(pid)
  return result
}

function killProcess(pid: number): string {
  const proc = bgProcs.get(pid)
  if (!proc) return `Error: no background process with pid ${pid}`
  if (proc.done) {
    bgProcs.delete(pid)
    return `Process ${pid} already finished.`
  }
  proc.killed = true
  killChild(proc.child)
  return `Sent kill signal to process ${pid}`
}

// ── Factory ──────────────────────────────

export interface ShellToolOptions {
  /** Tool name registered with the model (e.g. `Bash`, `PowerShell`). */
  name: string
  /** Long-form description shown to the model. */
  description: string
  /** Description for the `command` schema field. */
  commandFieldDesc: string
  /** Which shell backend to spawn (shared with Worker via prepareShellSpawn). */
  shell: ShellKind
}

export function createShellTool(opts: ShellToolOptions): ToolDefinition {
  const { name, description, commandFieldDesc, shell } = opts
  // Registry-list summary takes the first sentence to keep the listing tidy.
  const briefDescription = description.split(/\.\s/)[0] + '.'

  return {
    name,
    description: briefDescription,
    isConcurrencySafe: isShellInputConcurrencySafe,
    create(cwd: string, context: ToolContext) {
      const wire = context?.wire
      // Mutable per-tool-instance cwd. Updated after each foreground command
      // by reading the cwd-tracking tmpfile written by the wrapped command.
      // Lets the model `cd subdir` and have subsequent commands run from
      // there, matching how a real interactive shell works. Background and
      // pid-mode calls don't update this (background may still be writing).
      const cwdRef = { current: cwd }

      return tool({
        description,
        inputSchema: z.object({
          command: z.string().optional().describe(commandFieldDesc),
          background: z
            .boolean()
            .optional()
            .describe(
              'Run in background and return PID immediately. Only for dev servers or commands that never exit.',
            ),
          pid: z
            .number()
            .optional()
            .describe('PID of a background process to check or kill.'),
          kill: z
            .boolean()
            .optional()
            .describe('If true with pid, send kill signal to the process.'),
          stdin: z.string().optional().describe('Text to feed to stdin.'),
          timeout: z
            .number()
            .optional()
            .describe(
              'Max time in ms before killing. Default 120000 (2 min). Ignored in background mode.',
            ),
        }),
        execute: async (
          args: {
            command?: string
            background?: boolean
            pid?: number
            kill?: boolean
            stdin?: string
            timeout?: number
          },
          options?: { toolCallId?: string },
        ) => {
          const toolUseId = options?.toolCallId ?? ''
          // ── Check / kill a background process ──
          // Prefer `command` if provided. Some providers (OpenAI Responses API
          // with strict tools) may pass `pid: 0` even when the model wants to
          // run a command, so we only enter pid-mode when no command is given.
          if (!args.command && args.pid != null) {
            return args.kill ? killProcess(args.pid) : checkProcess(args.pid)
          }
          if (!args.command) {
            return 'Error: provide `command` to run or `pid` to check a background process.'
          }

          const { command, background = false, stdin, timeout = 120_000 } = args

          // ── Remote SSH execution (Control-plane LLM, tools on remote) ──
          const execution = context.execution
          if (execution) {
            if (background) {
              return 'Error: background mode is not supported over SSH yet. Run foreground commands only.'
            }
            if (stdin != null && stdin.length > 0) {
              return 'Error: stdin piping is not supported over SSH yet.'
            }
            try {
              const result = await execution.exec(command, {
                cwd: cwdRef.current,
                timeoutMs: timeout,
                shell,
              })
              if (result.cwdAfter) cwdRef.current = result.cwdAfter
              let out = result.stdout || ''
              if (result.stderr) {
                out += (out ? '\n' : '') + `<stderr>\n${result.stderr}</stderr>`
              }
              if (result.code !== 0 && result.code !== null) {
                out += `\n[exit code: ${result.code}]`
              }
              const final =
                out ||
                (result.code === 0
                  ? '(no output)'
                  : `(no output, exit code ${result.code})`)
              if (wire && toolUseId) {
                wire.processOutput(toolUseId, name, final)
              }
              return truncate(final)
            } catch (err) {
              return `[error: ${err instanceof Error ? err.message : String(err)}]`
            }
          }

          // Shared spawn config (same as Worker) — dual cwd paths on Windows.
          let prepared
          try {
            prepared = prepareShellSpawn({
              shell,
              userCommand: command,
              cwdFilePrefix: 'agent-shell-cwd',
            })
          } catch (err) {
            return `[error: ${err instanceof Error ? err.message : String(err)}]`
          }

          const child = spawn(prepared.command, prepared.args, {
            cwd: cwdRef.current,
            env: prepared.env,
            windowsHide: true,
          })

          const updateCwdFromFile = () => {
            const tracked = readCwdAfter(
              prepared.cwdFileNative,
              prepared.shellKind,
            )
            if (tracked) cwdRef.current = tracked
            cleanupCwdFile(prepared.cwdFileNative)
          }

          const proc: TrackedProcess = {
            pid: child.pid!,
            command,
            child,
            stdout: '',
            stderr: '',
            exitCode: null,
            done: false,
            killed: false,
            startTime: Date.now(),
          }

          child.stdout.on('data', (d: Buffer) => {
            proc.stdout = cappedAppend(proc.stdout, d.toString())
          })
          child.stderr.on('data', (d: Buffer) => {
            proc.stderr = cappedAppend(proc.stderr, d.toString())
          })
          if (stdin != null) child.stdin.write(stdin)
          child.stdin.end()

          // ── Background mode: return PID immediately ──
          if (background) {
            bgProcs.set(proc.pid, proc)
            // Don't update cwdRef from a background process: the bg cmd may
            // run for hours and its `cd` shouldn't pollute the foreground
            // working directory. Unlink the unread tmpfile when it eventually
            // closes so we don't leak files.
            child.on('close', (code: number | null) => {
              proc.exitCode = code
              proc.done = true
              cleanupCwdFile(prepared.cwdFileNative)
            })
            child.on('error', () => {
              proc.done = true
              cleanupCwdFile(prepared.cwdFileNative)
            })
            return `[backgrounded — pid: ${proc.pid}]\nUse ${name}({ pid: ${proc.pid} }) to check, ${name}({ pid: ${proc.pid}, kill: true }) to stop.`
          }

          // ── Default: block until done, stream live output ──
          return new Promise<string>(resolve => {
            let progressTimer: ReturnType<typeof setInterval> | null = null
            let lastOutputLen = 0

            if (wire && toolUseId) {
              progressTimer = setInterval(() => {
                if (proc.done) return
                const out = formatOutput(proc)
                if (out.length !== lastOutputLen) {
                  lastOutputLen = out.length
                  wire.processOutput(toolUseId, name, out)
                }
              }, PROGRESS_INTERVAL_MS)
            }

            const finish = (output: string) => {
              if (progressTimer) clearInterval(progressTimer)
              resolve(truncate(output))
            }

            const hardTimer = setTimeout(() => {
              proc.killed = true
              killChild(child)
              setTimeout(() => {
                forceKillChild(child)
                proc.done = true
                // Killed mid-flight — trailer didn't run; don't update cwdRef.
                cleanupCwdFile(prepared.cwdFileNative)
                const out =
                  formatOutput(proc) + `\n[timed out after ${timeout / 1000}s]`
                if (wire && toolUseId) {
                  wire.processOutput(toolUseId, name, out)
                }
                finish(out)
              }, 3000)
            }, timeout)

            child.on('close', (code: number | null) => {
              clearTimeout(hardTimer)
              proc.exitCode = code
              proc.done = true
              updateCwdFromFile()
              const out = formatOutput(proc)
              if (wire && toolUseId) {
                wire.processOutput(toolUseId, name, out)
              }
              finish(out)
            })

            child.on('error', (err: Error) => {
              clearTimeout(hardTimer)
              proc.done = true
              cleanupCwdFile(prepared.cwdFileNative)
              finish(`[error: ${err.message}]`)
            })
          })
        },
      })
    },
  }
}
