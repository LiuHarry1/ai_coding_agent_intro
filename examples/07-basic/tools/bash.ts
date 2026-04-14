import { tool } from "ai";
import { z } from "zod";
import { spawn, type ChildProcess } from "child_process";
import { truncate } from "./utils.js";
import { shell, killChild, forceKillChild } from "../core/platform.js";
import type { ToolDefinition, ToolContext, IEventBus } from "../core/types.js";

// ── Background process tracking (dev servers only) ──

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

// ── Tool definition ──────────────────────────────

export const definition: ToolDefinition = {
  name: "bash",
  description: `Run shell commands in the workspace (${shell.name})`,
  create(cwd: string, context: ToolContext) {
    const eventBus: IEventBus | undefined = context?.eventBus;

    return tool({
      description:
        `Run a shell command (${shell.name}). Blocks until completion with live output streaming.\n\n` +
        "Modes:\n" +
        "1. Run command: provide `command`. Blocks until done, streaming output to UI.\n" +
        "2. Background mode: set `background: true` for dev servers or commands that never exit. Returns PID immediately.\n" +
        "3. Check background process: provide `pid`.\n" +
        "4. Kill background process: provide `pid` + `kill: true`.\n\n" +
        "Tips:\n" +
        "- Dev servers (never exit): set `background: true`.\n" +
        "- Non-interactive only. Output truncated at ~30KB.",
      inputSchema: z.object({
        command: z.string().optional()
          .describe(`The ${shell.name} command to execute.`),
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
        if (args.pid != null) {
          return args.kill ? killProcess(args.pid) : checkProcess(args.pid);
        }
        if (!args.command) {
          return "Error: provide `command` to run or `pid` to check a background process.";
        }

        const { command, background = false, stdin, timeout = 120_000 } = args;

        const child = spawn(shell.command, shell.buildArgs(command), {
          cwd,
          env: shell.spawnEnv(),
        });

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
          child.on("close", (code: number | null) => { proc.exitCode = code; proc.done = true; });
          child.on("error", () => { proc.done = true; });
          return `[backgrounded — pid: ${proc.pid}]\nUse bash({ pid: ${proc.pid} }) to check, bash({ pid: ${proc.pid}, kill: true }) to stop.`;
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
              const out = formatOutput(proc) + `\n[timed out after ${timeout / 1000}s]`;
              eventBus?.emit("process_output", { pid: proc.pid, output: out, elapsed: elapsedSec(proc.startTime), done: true });
              finish(out);
            }, 3000);
          }, timeout);

          child.on("close", (code: number | null) => {
            clearTimeout(hardTimer);
            proc.exitCode = code;
            proc.done = true;
            const out = formatOutput(proc);
            eventBus?.emit("process_output", { pid: proc.pid, output: out, elapsed: elapsedSec(proc.startTime), done: true });
            finish(out);
          });

          child.on("error", (err: Error) => {
            clearTimeout(hardTimer);
            proc.done = true;
            finish(`[error: ${err.message}]`);
          });
        });
      },
    });
  },
};
