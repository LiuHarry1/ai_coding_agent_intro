import { tool } from "ai";
import { z } from "zod";
import { spawn, type ChildProcess } from "child_process";
import { truncate } from "./utils.js";
import type { ToolDefinition } from "../core/types.js";

// ── Background process tracking ──────────────────

const MAX_BUFFER = 100_000;

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
  timeoutMs: number;
  hardTimer: ReturnType<typeof setTimeout> | null;
}

const bgProcs = new Map<number, TrackedProcess>();

process.on("exit", () => {
  for (const p of bgProcs.values()) {
    if (!p.done) try { p.child.kill("SIGKILL"); } catch {}
  }
});

function cappedAppend(buf: string, chunk: string): string {
  const combined = buf + chunk;
  if (combined.length <= MAX_BUFFER) return combined;
  return "...[earlier output truncated]\n" + combined.slice(-MAX_BUFFER);
}

function elapsedSec(proc: TrackedProcess): string {
  return ((Date.now() - proc.startTime) / 1000).toFixed(1);
}

function formatOutput(proc: TrackedProcess): string {
  let out = proc.stdout || "";
  if (proc.stderr) out += (out ? "\n" : "") + `<stderr>\n${proc.stderr}</stderr>`;

  if (proc.killed) out += `\n[timed out after ${proc.timeoutMs / 1000}s]`;
  else if (proc.done && proc.exitCode !== 0 && proc.exitCode !== null) out += `\n[exit code: ${proc.exitCode}]`;

  return out || (proc.done
    ? (proc.exitCode === 0 ? "(no output)" : `(no output, exit code ${proc.exitCode})`)
    : "(no output yet)");
}

function statusHeader(proc: TrackedProcess): string {
  return proc.done
    ? `[pid ${proc.pid}] finished (exit code ${proc.exitCode}, ${elapsedSec(proc)}s)`
    : `[pid ${proc.pid}] still running (${elapsedSec(proc)}s elapsed)`;
}

function checkProcess(pid: number): string {
  const proc = bgProcs.get(pid);
  if (!proc) return `Error: no background process with pid ${pid}`;
  const result = truncate(`${statusHeader(proc)}\n\n${formatOutput(proc)}`);
  if (proc.done) bgProcs.delete(pid);
  return result;
}

function killProcess(pid: number): string {
  const proc = bgProcs.get(pid);
  if (!proc) return `Error: no background process with pid ${pid}`;
  if (proc.done) {
    bgProcs.delete(pid);
    return `Process ${pid} already finished (exit code ${proc.exitCode})`;
  }
  if (proc.hardTimer) clearTimeout(proc.hardTimer);
  proc.killed = true;
  proc.child.kill("SIGTERM");
  setTimeout(() => { try { proc.child.kill("SIGKILL"); } catch {} }, 3000);
  return `Sent SIGTERM to process ${pid}`;
}

// ── Tool definition ──────────────────────────────

export const definition: ToolDefinition = {
  name: "bash",
  description: "Run shell commands in the workspace",
  create(cwd) {
    return tool({
      description:
        "Run a shell command. Supports background execution for long-running commands.\n\n" +
        "Modes:\n" +
        "1. Run command: provide `command`. If it doesn't finish within `block_until_ms`, " +
        "it moves to background and returns partial output + PID.\n" +
        "2. Check background process: provide `pid` to get latest output.\n" +
        "3. Kill background process: provide `pid` + `kill: true`.\n\n" +
        "Tips:\n" +
        "- For quick commands (ls, grep, cat): default block_until_ms (10s) is fine.\n" +
        "- For installs/builds: set block_until_ms to 0 to immediately background.\n" +
        "- For dev servers: set block_until_ms to 0 (they never exit).\n" +
        "- Non-interactive only (no vim, no prompts). Output truncated at ~30KB.",
      inputSchema: z.object({
        command: z.string().optional()
          .describe("The bash command to execute. Omit when checking on a background process."),
        pid: z.number().optional()
          .describe("PID of a background process to check status or kill"),
        kill: z.boolean().optional()
          .describe("If true with pid, send SIGTERM to the background process"),
        stdin: z.string().optional()
          .describe("Optional text to feed to stdin"),
        timeout: z.number().optional()
          .describe("Total timeout in ms before killing the process. Default 120000 (2 min)"),
        block_until_ms: z.number().optional()
          .describe("How long to wait before moving to background. Default 10000 (10s). Set to 0 to immediately background."),
      }),
      execute: async (args: {
        command?: string;
        pid?: number;
        kill?: boolean;
        stdin?: string;
        timeout?: number;
        block_until_ms?: number;
      }) => {
        if (args.pid != null) {
          return args.kill ? killProcess(args.pid) : checkProcess(args.pid);
        }
        if (!args.command) {
          return "Error: provide either `command` to run or `pid` to check a background process";
        }

        const { command, stdin, timeout = 120_000, block_until_ms = 10_000 } = args;

        return new Promise<string>((resolve) => {
          const child = spawn("bash", ["-c", command], {
            cwd,
            env: { ...process.env, TERM: "dumb" },
          });

          const proc: TrackedProcess = {
            pid: child.pid!,
            command,
            child,
            stdout: "",
            stderr: "",
            exitCode: null,
            done: false,
            killed: false,
            startTime: Date.now(),
            timeoutMs: timeout,
            hardTimer: null,
          };

          let settled = false;
          const settle = (output: string) => {
            if (settled) return;
            settled = true;
            resolve(truncate(output));
          };

          proc.hardTimer = setTimeout(() => {
            proc.killed = true;
            child.kill("SIGTERM");
            setTimeout(() => {
              try { child.kill("SIGKILL"); } catch {}
              proc.done = true;
              settle(truncate(`${statusHeader(proc)}\n\n${formatOutput(proc)}`));
            }, 3000);
          }, timeout);

          child.stdout.on("data", (d: Buffer) => { proc.stdout = cappedAppend(proc.stdout, d.toString()); });
          child.stderr.on("data", (d: Buffer) => { proc.stderr = cappedAppend(proc.stderr, d.toString()); });

          // `close` fires after all stdio streams end — no need for setTimeout delay
          child.on("close", (code: number | null) => {
            if (proc.hardTimer) clearTimeout(proc.hardTimer);
            proc.exitCode = code;
            proc.done = true;

            if (!settled) {
              settle(formatOutput(proc));
              bgProcs.delete(proc.pid);
            }
          });

          child.on("error", (err: Error) => {
            proc.done = true;
            settle(`[error: ${err.message}]`);
          });

          if (stdin != null) child.stdin.write(stdin);
          child.stdin.end();

          setTimeout(() => {
            if (settled || proc.done) return;
            bgProcs.set(proc.pid, proc);
            const out = formatOutput(proc)
              + `\n\n[backgrounded after ${elapsedSec(proc)}s — pid: ${proc.pid}]`
              + `\nUse bash({ pid: ${proc.pid} }) to check status.`
              + `\nUse bash({ pid: ${proc.pid}, kill: true }) to stop.`;
            settle(out);
          }, block_until_ms);
        });
      },
    });
  },
};
