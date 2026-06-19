import { tool } from "ai";
import { z } from "zod";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { truncate } from "./utils.js";
import { killChild, forceKillChild, type ShellConfig } from "../core/platform.js";
import type { ToolDefinition, ToolContext, IEventBus } from "../core/types.js";
import { isShellInputConcurrencySafe } from "../core/shell/shell-readonly.js";

/**
 * Shared execution machinery for shell-style tools (bash on Unix, powershell
 * on Windows). The two platforms differ only in:
 *   1. The tool name registered with the model (`bash` vs `powershell`)
 *   2. The tool description (syntax / safety guidance varies wildly)
 *   3. The spawn config (`bash -c <cmd>` vs `powershell.exe -Command <cmd>`)
 *
 * Everything else — background-process tracking, output capping, progress
 * streaming, timeout/kill, pid check/kill modes — is identical. Centralizing
 * it here keeps the per-shell wrapper files (~50 lines each) focused on the
 * prompt content, which is what actually differs between shells.
 */

// ── Background process tracking ──

const MAX_BUFFER = 100_000;
const PROGRESS_INTERVAL_MS = 2_000;

interface TrackedProcess {
  pid: number;
  command: string;
  child: ChildProcess;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  done: boolean;
  killed: boolean;
  startTime: number;
}

const bgProcs = new Map<number, TrackedProcess>();

process.on("exit", () => {
  for (const p of bgProcs.values()) {
    if (!p.done) try { forceKillChild(p.child); } catch {}
  }
});

function cappedAppend(buf: string, chunk: string): string {
  const combined = buf + chunk;
  if (combined.length <= MAX_BUFFER) return combined;
  return "...[earlier output truncated]\n" + combined.slice(-MAX_BUFFER);
}

function elapsedSec(start: number): string {
  return ((Date.now() - start) / 1000).toFixed(1);
}

function formatOutput(proc: TrackedProcess): string {
  let out = proc.stdout || "";
  if (proc.stderr) out += (out ? "\n" : "") + `<stderr>\n${proc.stderr}</stderr>`;
  if (proc.done && proc.exitCode !== 0 && proc.exitCode !== null)
    out += `\n[exit code: ${proc.exitCode}]`;
  return out || (proc.done
    ? (proc.exitCode === 0 ? "(no output)" : `(no output, exit code ${proc.exitCode})`)
    : "(no output yet)");
}

function checkProcess(pid: number): string {
  const proc = bgProcs.get(pid);
  if (!proc) return `Error: no background process with pid ${pid}`;
  const status = proc.done
    ? `[pid ${pid}] finished (exit ${proc.exitCode}, ${elapsedSec(proc.startTime)}s)`
    : `[pid ${pid}] running (${elapsedSec(proc.startTime)}s)`;
  const result = truncate(`${status}\n\n${formatOutput(proc)}`);
  if (proc.done) bgProcs.delete(pid);
  return result;
}

function killProcess(pid: number): string {
  const proc = bgProcs.get(pid);
  if (!proc) return `Error: no background process with pid ${pid}`;
  if (proc.done) { bgProcs.delete(pid); return `Process ${pid} already finished.`; }
  proc.killed = true;
  killChild(proc.child);
  return `Sent kill signal to process ${pid}`;
}

// ── Factory ──────────────────────────────

export interface ShellToolOptions {
  /** Tool name registered with the model (e.g. `bash`, `powershell`). */
  name: string;
  /** Long-form description shown to the model — covers usage rules,
   *  syntax warnings, modes. The brief one-line registry summary is
   *  derived from the first sentence of this string. */
  description: string;
  /** Description for the `command` schema field. Vendor the shell name
   *  (e.g. "The bash command to execute") so the model parses it correctly. */
  commandFieldDesc: string;
  /** Spawn configuration: which binary, what args, what env. */
  shellConfig: ShellConfig;
}

export function createShellTool(opts: ShellToolOptions): ToolDefinition {
  const { name, description, commandFieldDesc, shellConfig } = opts;
  // Registry-list summary takes the first sentence to keep the listing tidy.
  const briefDescription = description.split(/\.\s/)[0] + ".";

  return {
    name,
    description: briefDescription,
    isConcurrencySafe: isShellInputConcurrencySafe,
    create(cwd: string, context: ToolContext) {
      const eventBus: IEventBus | undefined = context?.eventBus;
      // Mutable per-tool-instance cwd. Updated after each foreground command
      // by reading the cwd-tracking tmpfile written by the wrapped command.
      // Lets the model `cd subdir` and have subsequent commands run from
      // there, matching how a real interactive shell works. Background and
      // pid-mode calls don't update this (background may still be writing).
      const cwdRef = { current: cwd };

      return tool({
        description,
        inputSchema: z.object({
          command: z.string().optional().describe(commandFieldDesc),
          background: z.boolean().optional()
            .describe("Run in background and return PID immediately. Only for dev servers or commands that never exit."),
          pid: z.number().optional()
            .describe("PID of a background process to check or kill."),
          kill: z.boolean().optional()
            .describe("If true with pid, send kill signal to the process."),
          stdin: z.string().optional()
            .describe("Text to feed to stdin."),
          timeout: z.number().optional()
            .describe("Max time in ms before killing. Default 120000 (2 min). Ignored in background mode."),
        }),
        execute: async (args: {
          command?: string;
          background?: boolean;
          pid?: number;
          kill?: boolean;
          stdin?: string;
          timeout?: number;
        }) => {
          // ── Check / kill a background process ──
          // Prefer `command` if provided. Some providers (OpenAI Responses API
          // with strict tools) may pass `pid: 0` even when the model wants to
          // run a command, so we only enter pid-mode when no command is given.
          if (!args.command && args.pid != null) {
            return args.kill ? killProcess(args.pid) : checkProcess(args.pid);
          }
          if (!args.command) {
            return "Error: provide `command` to run or `pid` to check a background process.";
          }

          const { command, background = false, stdin, timeout = 120_000 } = args;

          // Tmpfile the wrapped command writes its post-execution `pwd` to.
          // Unique per call so parallel invocations don't race on the file.
          // Cleaned up after readback (or on bg child close further down).
          const cwdFile = path.join(
            os.tmpdir(),
            `agent-shell-cwd-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          );
          const wrappedCmd = shellConfig.wrapCommand(command, cwdFile);

          const child = spawn(shellConfig.command, shellConfig.buildArgs(wrappedCmd), {
            cwd: cwdRef.current,
            env: shellConfig.spawnEnv(),
          });

          // Read the tracked pwd and update cwdRef. Best-effort: missing or
          // unreadable file = leave cwdRef alone (e.g. user ran `exec foo`
          // and the trailer never executed). Always unlink afterwards.
          const updateCwdFromFile = () => {
            try {
              const tracked = fs.readFileSync(cwdFile, "utf8").trim();
              if (tracked) cwdRef.current = tracked;
            } catch {
              // No file / read error → keep current cwd unchanged.
            }
            try { fs.unlinkSync(cwdFile); } catch {}
          };

          const proc: TrackedProcess = {
            pid: child.pid!, command, child,
            stdout: "", stderr: "",
            exitCode: null, done: false, killed: false,
            startTime: Date.now(),
          };

          child.stdout.on("data", (d: Buffer) => { proc.stdout = cappedAppend(proc.stdout, d.toString()); });
          child.stderr.on("data", (d: Buffer) => { proc.stderr = cappedAppend(proc.stderr, d.toString()); });
          if (stdin != null) child.stdin.write(stdin);
          child.stdin.end();

          // ── Background mode: return PID immediately ──
          if (background) {
            bgProcs.set(proc.pid, proc);
            // Don't update cwdRef from a background process: the bg cmd may
            // run for hours and its `cd` shouldn't pollute the foreground
            // working directory. Unlink the unread tmpfile when it eventually
            // closes so we don't leak files.
            child.on("close", (code: number | null) => {
              proc.exitCode = code; proc.done = true;
              try { fs.unlinkSync(cwdFile); } catch {}
            });
            child.on("error", () => {
              proc.done = true;
              try { fs.unlinkSync(cwdFile); } catch {}
            });
            return `[backgrounded — pid: ${proc.pid}]\nUse ${name}({ pid: ${proc.pid} }) to check, ${name}({ pid: ${proc.pid}, kill: true }) to stop.`;
          }

          // ── Default: block until done, stream live output ──
          return new Promise<string>((resolve) => {
            let progressTimer: ReturnType<typeof setInterval> | null = null;
            let lastOutputLen = 0;

            if (eventBus) {
              progressTimer = setInterval(() => {
                if (proc.done) return;
                const out = formatOutput(proc);
                if (out.length !== lastOutputLen) {
                  lastOutputLen = out.length;
                  eventBus.emit("process_output", {
                    pid: proc.pid, output: out,
                    elapsed: elapsedSec(proc.startTime), done: false,
                  });
                }
              }, PROGRESS_INTERVAL_MS);
            }

            const finish = (output: string) => {
              if (progressTimer) clearInterval(progressTimer);
              resolve(truncate(output));
            };

            const hardTimer = setTimeout(() => {
              proc.killed = true;
              killChild(child);
              setTimeout(() => {
                forceKillChild(child);
                proc.done = true;
                // Killed mid-flight — trailer didn't run, cwdFile likely
                // missing. Clean up if present and don't update cwdRef.
                try { fs.unlinkSync(cwdFile); } catch {}
                const out = formatOutput(proc) + `\n[timed out after ${timeout / 1000}s]`;
                eventBus?.emit("process_output", { pid: proc.pid, output: out, elapsed: elapsedSec(proc.startTime), done: true });
                finish(out);
              }, 3000);
            }, timeout);

            child.on("close", (code: number | null) => {
              clearTimeout(hardTimer);
              proc.exitCode = code;
              proc.done = true;
              updateCwdFromFile();
              const out = formatOutput(proc);
              eventBus?.emit("process_output", { pid: proc.pid, output: out, elapsed: elapsedSec(proc.startTime), done: true });
              finish(out);
            });

            child.on("error", (err: Error) => {
              clearTimeout(hardTimer);
              proc.done = true;
              try { fs.unlinkSync(cwdFile); } catch {}
              finish(`[error: ${err.message}]`);
            });
          });
        },
      });
    },
  };
}
