import { tool } from 'ai'
import { z } from 'zod'
import { spawn, type ChildProcess } from 'child_process'
import { truncate } from './utils.js'
import { killChild, forceKillChild } from '../core/platform.js'
import type {
  DualChannelToolResult,
  ToolDefinition,
  ToolContext,
} from '../core/types.js'
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
 *
 * Dual-channel (CC-style): execute returns `{ data: ShellToolOutput }` directly;
 * mapper builds model text and may set `is_error` (timeout / interrupted).
 */

export type ShellToolOutput = {
  /** Model + UI narrative (formatted stdout/stderr/status). */
  text: string
  stdout?: string
  stderr?: string
  exitCode?: number | null
  pid?: number
  backgrounded?: boolean
  /** Timed out or kill-interrupted before natural exit. */
  interrupted?: boolean
}

function shellOk(
  data: ShellToolOutput,
): DualChannelToolResult<ShellToolOutput> {
  return { data }
}

function formatProcText(proc: TrackedProcess): string {
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

function fromProc(
  proc: TrackedProcess,
  extra?: Partial<ShellToolOutput>,
): ShellToolOutput {
  const text = truncate(formatProcText(proc))
  return {
    text,
    stdout: proc.stdout,
    stderr: proc.stderr,
    exitCode: proc.exitCode,
    pid: proc.pid,
    ...extra,
  }
}

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

function checkProcess(
  pid: number,
): DualChannelToolResult<ShellToolOutput> | string {
  const proc = bgProcs.get(pid)
  if (!proc) return `Error: no background process with pid ${pid}`
  const status = proc.done
    ? `[pid ${pid}] finished (exit ${proc.exitCode}, ${elapsedSec(proc.startTime)}s)`
    : `[pid ${pid}] running (${elapsedSec(proc.startTime)}s)`
  const body = truncate(`${status}\n\n${formatProcText(proc)}`)
  if (proc.done) bgProcs.delete(pid)
  return shellOk({
    text: body,
    stdout: proc.stdout,
    stderr: proc.stderr,
    exitCode: proc.exitCode,
    pid,
  })
}

function killProcess(
  pid: number,
): DualChannelToolResult<ShellToolOutput> | string {
  const proc = bgProcs.get(pid)
  if (!proc) return `Error: no background process with pid ${pid}`
  if (proc.done) {
    bgProcs.delete(pid)
    return shellOk({
      text: `Process ${pid} already finished.`,
      exitCode: proc.exitCode,
      pid,
    })
  }
  proc.killed = true
  killChild(proc.child)
  return shellOk({
    text: `Sent kill signal to process ${pid}`,
    pid,
    interrupted: true,
  })
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
    mapToolResultToToolResultBlockParam(output, toolUseID) {
      const o = output as ShellToolOutput
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: o.text,
        // Match CC: aborted / timed-out commands are tool errors for the model.
        ...(o.interrupted ? { is_error: true } : {}),
      }
    },
    create(cwd: string, context: ToolContext) {
      const wire = context?.wire
      // Mutable per-tool-instance cwd. Updated after each foreground command
      // by reading the cwd-tracking tmpfile written by the wrapped command.
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
        ): Promise<DualChannelToolResult<ShellToolOutput> | string> => {
          const toolUseId = options?.toolCallId ?? ''
          // Prefer `command` if provided. Some providers may pass `pid: 0`
          // even when the model wants to run a command.
          if (!args.command && args.pid != null) {
            return args.kill ? killProcess(args.pid) : checkProcess(args.pid)
          }
          if (!args.command) {
            return 'Error: provide `command` to run or `pid` to check a background process.'
          }

          const { command, background = false, stdin, timeout = 120_000 } = args

          // ── Remote SSH execution ──
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
              const text = truncate(final)
              if (wire && toolUseId) {
                wire.processOutput(toolUseId, name, text)
              }
              return shellOk({
                text,
                stdout: result.stdout || '',
                stderr: result.stderr || '',
                exitCode: result.code,
              })
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              return shellOk({
                text: truncate(`[error: ${msg}]`),
                interrupted: true,
              })
            }
          }

          let prepared
          try {
            prepared = prepareShellSpawn({
              shell,
              userCommand: command,
              cwdFilePrefix: 'agent-shell-cwd',
            })
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return shellOk({
              text: truncate(`[error: ${msg}]`),
              interrupted: true,
            })
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

          // ── Background mode ──
          if (background) {
            bgProcs.set(proc.pid, proc)
            child.on('close', (code: number | null) => {
              proc.exitCode = code
              proc.done = true
              cleanupCwdFile(prepared.cwdFileNative)
            })
            child.on('error', () => {
              proc.done = true
              cleanupCwdFile(prepared.cwdFileNative)
            })
            const text = `[backgrounded — pid: ${proc.pid}]\nUse ${name}({ pid: ${proc.pid} }) to check, ${name}({ pid: ${proc.pid}, kill: true }) to stop.`
            return shellOk({
              text,
              pid: proc.pid,
              backgrounded: true,
            })
          }

          // ── Foreground: block until done ──
          return new Promise(resolve => {
            let progressTimer: ReturnType<typeof setInterval> | null = null
            let lastOutputLen = 0

            if (wire && toolUseId) {
              progressTimer = setInterval(() => {
                if (proc.done) return
                const out = formatProcText(proc)
                if (out.length !== lastOutputLen) {
                  lastOutputLen = out.length
                  wire.processOutput(toolUseId, name, out)
                }
              }, PROGRESS_INTERVAL_MS)
            }

            const finish = (data: ShellToolOutput) => {
              if (progressTimer) clearInterval(progressTimer)
              resolve(shellOk(data))
            }

            const hardTimer = setTimeout(() => {
              proc.killed = true
              killChild(child)
              setTimeout(() => {
                forceKillChild(child)
                proc.done = true
                cleanupCwdFile(prepared.cwdFileNative)
                const text =
                  truncate(
                    formatProcText(proc) +
                      `\n[timed out after ${timeout / 1000}s]`,
                  )
                if (wire && toolUseId) {
                  wire.processOutput(toolUseId, name, text)
                }
                finish({
                  ...fromProc(proc, { interrupted: true }),
                  text,
                })
              }, 3000)
            }, timeout)

            child.on('close', (code: number | null) => {
              clearTimeout(hardTimer)
              proc.exitCode = code
              proc.done = true
              updateCwdFromFile()
              const data = fromProc(proc, {
                interrupted: proc.killed || undefined,
              })
              if (wire && toolUseId) {
                wire.processOutput(toolUseId, name, data.text)
              }
              finish(data)
            })

            child.on('error', (err: Error) => {
              clearTimeout(hardTimer)
              proc.done = true
              cleanupCwdFile(prepared.cwdFileNative)
              finish({
                text: truncate(`[error: ${err.message}]`),
                interrupted: true,
              })
            })
          })
        },
      })
    },
  }
}
