import { tool } from "ai";
import { z } from "zod";
import { spawn } from "child_process";

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_IDLE_TIMEOUT = 5_000;

export function createBashTool(cwd, { truncate }) {
  return tool({
    description:
      "Run a bash command. " +
      "Non-interactive — use `stdin` param or pipe for input. " +
      "For long-running commands (dev servers, watchers), set `idle_timeout` — " +
      "the tool returns collected output once stdout/stderr is idle for that many ms, " +
      "and the process keeps running in the background. " +
      "Output truncated at ~30KB. For write, read, edit file, prefer edit_file, read_file, write_file instead.",
    inputSchema: z.object({
      command: z.string().describe("The bash command to execute"),
      stdin: z
        .string()
        .optional()
        .describe("Optional text to feed to stdin of the process"),
      timeout: z
        .number()
        .optional()
        .describe("Hard timeout in ms (kills process). Default 120000 (2 min)"),
      idle_timeout: z
        .number()
        .optional()
        .describe(
          "If set, return output once stdout/stderr has been idle for this many ms, " +
          "leaving the process running in the background. " +
          "Useful for dev servers — e.g. 5000 means return after 5s of no new output."
        ),
    }),
    execute: async ({ command, stdin, timeout = DEFAULT_TIMEOUT, idle_timeout }) => {
      return new Promise((resolve) => {
        let resolved = false;
        const done = (output) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(hardTimer);
          if (idleTimer) clearTimeout(idleTimer);
          resolve(truncate(output));
        };

        const child = spawn("bash", ["-c", command], {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            HOME: process.env.HOME,
            PATH: process.env.PATH,
            TERM: "dumb",
          },
          detached: !!idle_timeout,
        });

        let stdout = "";
        let stderr = "";
        let killed = false;
        let backgrounded = false;
        let idleTimer = null;

        const hardTimer = setTimeout(() => {
          if (backgrounded) return;
          killed = true;
          child.kill("SIGTERM");
          setTimeout(() => {
            try { child.kill("SIGKILL"); } catch {}
            buildOutput(null, "timed_out");
          }, 3000);
        }, timeout);

        function resetIdleTimer() {
          if (!idle_timeout || resolved) return;
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            backgrounded = true;
            try { child.unref(); } catch {}
            buildOutput(null, "idle");
          }, idle_timeout);
        }

        child.stdout.on("data", (d) => {
          stdout += d;
          resetIdleTimer();
        });
        child.stderr.on("data", (d) => {
          stderr += d;
          resetIdleTimer();
        });

        if (idle_timeout) resetIdleTimer();

        function buildOutput(code, reason) {
          setTimeout(() => {
            let output = "";
            if (stdout) output += stdout;
            if (stderr) output += (output ? "\n" : "") + `<stderr>\n${stderr}</stderr>`;
            if (reason === "timed_out") {
              output += `\n[timed out after ${timeout / 1000}s]`;
            } else if (reason === "idle") {
              output += `\n[process still running in background — returned after ${idle_timeout / 1000}s idle]`;
            }
            if (!output) {
              output = code === 0 ? "(no output)" : `(no output, exit code ${code})`;
            } else if (code !== 0 && code !== null && reason === "exited") {
              output += `\n[exit code: ${code}]`;
            }
            done(output);
          }, 100);
        }

        child.on("exit", (code) => {
          buildOutput(code, "exited");
        });

        child.on("error", (err) => {
          done(`[error: ${err.message}]`);
        });

        if (stdin != null) {
          child.stdin.write(stdin);
        }
        child.stdin.end();
      });
    },
  });
}
