import { tool } from "ai";
import { z } from "zod";
import { spawn } from "child_process";

const MAX_OUTPUT = 30000;

function truncate(text, max = MAX_OUTPUT) {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return (
    text.slice(0, half) +
    `\n\n... [${text.length - max} chars truncated] ...\n\n` +
    text.slice(-half)
  );
}

export function createTools(cwd) {
  return {
    bash: tool({
      description:
        "Execute a bash command and return its output. " +
        "This is the primary tool for interacting with the system. Use it to: " +
        "run shell commands, write/read files (cat, heredoc), install packages, " +
        "search code (grep/find), manage git, run tests, start processes, etc.\n\n" +
        "Guidelines:\n" +
        "- For file writes, prefer heredoc: cat > file.py << 'EOF'\\n...\\nEOF\n" +
        "- Commands run non-interactively. For programs requiring stdin, " +
        "provide input via the `stdin` parameter or use pipe: echo 'input' | cmd\n" +
        "- Long-running commands (servers, watchers) will be killed after timeout. " +
        "Start them in background with & and use a short sleep to capture initial output.\n" +
        "- Output is truncated if it exceeds ~30KB. Use head/tail/grep to limit output.\n" +
        "- Prefer single compound commands (cmd1 && cmd2) over multiple tool calls when possible.",
      inputSchema: z.object({
        command: z.string().describe("The bash command to execute"),
        stdin: z
          .string()
          .optional()
          .describe("Optional text to feed to stdin of the process"),
        timeout: z
          .number()
          .optional()
          .describe("Timeout in ms, default 120000 (2 min)"),
      }),
      execute: async ({ command, stdin, timeout = 120000 }) => {
        return new Promise((resolve) => {
          let resolved = false;
          const done = (output) => {
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

          child.stdout.on("data", (d) => { stdout += d; });
          child.stderr.on("data", (d) => { stderr += d; });

          function buildAndResolve(code) {
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

          // Use 'exit' instead of 'close' so background processes (cmd &)
          // don't block us — bash exits even if the child's pipes are still open.
          child.on("exit", (code) => {
            buildAndResolve(code);
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
    }),
  };
}
