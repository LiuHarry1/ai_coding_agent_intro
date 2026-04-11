import { tool } from "ai";
import { z } from "zod";
import { spawn } from "child_process";
import { truncate } from "./utils.js";
import type { ToolDefinition } from "../core/types.js";

export const definition: ToolDefinition = {
  name: "bash",
  description: "Run shell commands in the workspace",
  create(cwd) {
    return tool({
      description:
        "Run a shell command in the working directory. " +
        "Use for: running scripts, installing packages, git, grep, find, ls, testing. " +
        "Combine commands with && to reduce tool calls. " +
        "Non-interactive only (no vim, no prompts). Output truncated at ~30KB.",
      inputSchema: z.object({
        command: z.string().describe("The bash command to execute"),
        stdin: z.string().optional().describe("Optional text to feed to stdin"),
        timeout: z.number().optional().describe("Timeout in ms, default 120000 (2 min)"),
      }),
      execute: async ({ command, stdin, timeout = 120000 }: { command: string; stdin?: string; timeout?: number }) => {
        return new Promise<string>((resolve) => {
          let resolved = false;
          const done = (output: string) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            resolve(truncate(output));
          };

          const child = spawn("bash", ["-c", command], {
            cwd,
            env: {
              ...process.env,
              HOME: process.env.HOME,
              PATH: process.env.PATH,
              TERM: "dumb",
            },
          });

          let stdout = "";
          let stderr = "";
          let killed = false;

          const timer = setTimeout(() => {
            killed = true;
            child.kill("SIGTERM");
            setTimeout(() => {
              try { child.kill("SIGKILL"); } catch {}
              buildAndResolve(null);
            }, 3000);
          }, timeout);

          child.stdout.on("data", (d: Buffer) => { stdout += d; });
          child.stderr.on("data", (d: Buffer) => { stderr += d; });

          function buildAndResolve(code: number | null) {
            setTimeout(() => {
              let output = "";
              if (stdout) output += stdout;
              if (stderr) output += (output ? "\n" : "") + `<stderr>\n${stderr}</stderr>`;
              if (killed) output += `\n[timed out after ${timeout / 1000}s]`;
              if (!output) output = code === 0 ? "(no output)" : `(no output, exit code ${code})`;
              else if (code !== 0 && code !== null && !killed) output += `\n[exit code: ${code}]`;
              done(output);
            }, 100);
          }

          child.on("exit", (code: number | null) => buildAndResolve(code));
          child.on("error", (err: Error) => done(`[error: ${err.message}]`));

          if (stdin != null) child.stdin.write(stdin);
          child.stdin.end();
        });
      },
    });
  },
};
