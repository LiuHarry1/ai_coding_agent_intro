import { tool } from 'ai'
import { z } from 'zod'
import { spawn } from 'child_process'
import { truncate } from './utils.js'
import { killChild } from '../core/platform.js'
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
import { spawnShellTask } from '../tasks/LocalShellTask/LocalShellTask.js'
import {
  getTaskOutputPath,
  setTaskSessionId,
} from '../utils/task/diskOutput.js'

/**
 * Shared execution for Bash / PowerShell.
 * Background uses CC-style task_id via spawnShellTask (not OS pid on the tool).
 */

export type ShellToolOutput = {
  text: string
  stdout?: string
  stderr?: string
  exitCode?: number | null
  backgroundTaskId?: string
  backgrounded?: boolean
  interrupted?: boolean
}

export const ShellToolOutputSchema = z.object({
  text: z.string(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  backgroundTaskId: z.string().optional(),
  backgrounded: z.boolean().optional(),
  interrupted: z.boolean().optional(),
})

function shellOk(
  data: ShellToolOutput,
): DualChannelToolResult<ShellToolOutput> {
  return { data }
}

const PROGRESS_INTERVAL_MS = 2_000
const MAX_BUFFER = 100_000

function cappedAppend(buf: string, chunk: string): string {
  const combined = buf + chunk
  if (combined.length <= MAX_BUFFER) return combined
  return '...[earlier output truncated]\n' + combined.slice(-MAX_BUFFER)
}

export interface ShellToolOptions {
  name: string
  description: string
  commandFieldDesc: string
  shell: ShellKind
}

export function createShellTool(opts: ShellToolOptions): ToolDefinition {
  const { name, description, commandFieldDesc, shell } = opts
  const briefDescription = description.split(/\.\s/)[0] + '.'

  return {
    name,
    description: briefDescription,
    isConcurrencySafe: isShellInputConcurrencySafe,
    interruptBehavior: () => 'block' as const,
    // Mode C — model may get wrappers in `text`; UI uses stdout/stderr
    outputSchema: ShellToolOutputSchema,
    mapToolResultToToolResultBlockParam(output, toolUseID) {
      const o = output as ShellToolOutput
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: o.text,
        ...(o.interrupted ? { is_error: true } : {}),
      }
    },
    create(cwd: string, context: ToolContext) {
      const wire = context?.wire
      const cwdRef = { current: cwd }

      return tool({
        description,
        inputSchema: z.object({
          command: z.string().describe(commandFieldDesc),
          description: z
            .string()
            .optional()
            .describe(
              'Clear, concise description of what this command does in 5-10 words.',
            ),
          timeout: z
            .number()
            .optional()
            .describe(
              'Max time in ms before killing. Default 120000 (2 min). Ignored when run_in_background is true.',
            ),
          // Claude Code BashTool: "Use Read to read the output later."
          run_in_background: z
            .boolean()
            .optional()
            .describe(
              'Set to true to run this command in the background. Use Read to read the output later.',
            ),
          stdin: z.string().optional().describe('Text to feed to stdin.'),
        }),
        execute: async (
          args: {
            command: string
            description?: string
            timeout?: number
            run_in_background?: boolean
            stdin?: string
          },
          options?: { toolCallId?: string; abortSignal?: AbortSignal },
        ): Promise<DualChannelToolResult<ShellToolOutput> | string> => {
          const toolUseId = options?.toolCallId ?? ''
          const abortSignal = options?.abortSignal
          if (abortSignal?.aborted) {
            return shellOk({
              text: truncate('[interrupted by user]'),
              interrupted: true,
            })
          }
          const {
            command,
            run_in_background = false,
            stdin,
            timeout = 120_000,
            description: cmdDesc,
          } = args

          if (!command?.trim()) {
            return 'Error: provide `command` to run.'
          }

          const sessionId = context.sessionId ?? 'default'
          setTaskSessionId(sessionId)

          // ── Background (CC: run_in_background → spawnShellTask) ──
          if (run_in_background) {
            if (stdin != null && stdin.length > 0) {
              return 'Error: stdin piping is not supported with run_in_background.'
            }
            try {
              const handle = await spawnShellTask(
                {
                  command,
                  description: cmdDesc ?? command,
                  toolUseId: toolUseId || undefined,
                  sessionId,
                  shell,
                  cwd: cwdRef.current,
                },
                { execution: context.execution },
              )
              // Claude Code BashTool.mapToolResultToToolResultBlockParam:
              // "Command running in background with ID: …. Output is being written to: …"
              const outPath = getTaskOutputPath(handle.taskId)
              const text = `Command running in background with ID: ${handle.taskId}. Output is being written to: ${outPath}`
              return shellOk({
                text,
                backgroundTaskId: handle.taskId,
                backgrounded: true,
                exitCode: 0,
              })
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              return shellOk({
                text: truncate(`[error starting background task: ${msg}]`),
                interrupted: true,
              })
            }
          }

          // ── Foreground via Worker ──
          const execution = context.execution
          if (execution) {
            if (stdin != null && stdin.length > 0) {
              return 'Error: stdin piping is not supported over Worker execution yet.'
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
                stdout: '',
                stderr: msg,
                exitCode: 1,
                interrupted: true,
              })
            }
          }

          // Remote sessions must never run shell on the Control Plane host
          // (Windows path.resolve turns /home/... into C:\home\... → /c/home/...).
          const envId =
            context.session?.workspace?.environmentId ??
            context.execution?.environmentId
          if (envId && envId !== 'local') {
            return shellOk({
              text: truncate(
                `[error: no Worker execution backend for remote environment ${envId}; refusing local shell fallback]`,
              ),
              stdout: '',
              stderr: `Remote shell requires Worker execution (env=${envId})`,
              exitCode: 1,
              interrupted: true,
            })
          }

          // ── In-process foreground (tests / no Worker) ──
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

          let stdout = ''
          let stderr = ''
          let interrupted = false
          const start = Date.now()
          let lastProgress = 0

          if (stdin != null) {
            child.stdin?.write(stdin)
            child.stdin?.end()
          } else {
            child.stdin?.end()
          }

          child.stdout?.on('data', (chunk: Buffer) => {
            stdout = cappedAppend(stdout, chunk.toString('utf8'))
            const now = Date.now()
            if (wire && toolUseId && now - lastProgress >= PROGRESS_INTERVAL_MS) {
              lastProgress = now
              wire.processOutput(
                toolUseId,
                name,
                truncate(stdout + (stderr ? `\n<stderr>\n${stderr}</stderr>` : '')),
              )
            }
          })
          child.stderr?.on('data', (chunk: Buffer) => {
            stderr = cappedAppend(stderr, chunk.toString('utf8'))
          })

          const exitCode = await new Promise<number | null>(resolve => {
            const timer = setTimeout(() => {
              interrupted = true
              killChild(child)
            }, timeout)
            const onAbort = () => {
              interrupted = true
              killChild(child)
            }
            abortSignal?.addEventListener('abort', onAbort, { once: true })
            if (abortSignal?.aborted) onAbort()
            child.on('close', code => {
              clearTimeout(timer)
              abortSignal?.removeEventListener('abort', onAbort)
              resolve(code)
            })
            child.on('error', () => {
              clearTimeout(timer)
              abortSignal?.removeEventListener('abort', onAbort)
              interrupted = true
              resolve(1)
            })
          })

          updateCwdFromFile()

          let out = stdout || ''
          if (stderr) out += (out ? '\n' : '') + `<stderr>\n${stderr}</stderr>`
          if (exitCode !== 0 && exitCode !== null) {
            out += `\n[exit code: ${exitCode}]`
          }
          if (interrupted) {
            out += `\n[interrupted after ${((Date.now() - start) / 1000).toFixed(1)}s]`
          }
          const final =
            out ||
            (exitCode === 0
              ? '(no output)'
              : `(no output, exit code ${exitCode})`)
          const text = truncate(final)
          if (wire && toolUseId) {
            wire.processOutput(toolUseId, name, text)
          }
          return shellOk({
            text,
            stdout,
            stderr,
            exitCode,
            interrupted,
          })
        },
      })
    },
  }
}
