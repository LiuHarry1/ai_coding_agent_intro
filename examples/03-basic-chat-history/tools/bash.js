import { tool } from "ai";
import { z } from "zod";
import { spawn } from "child_process";

export function createBashTool(cwd, { truncate }) {
  return tool({
    description:
      "Run a bash command. Write files with heredoc (cat > f << 'EOF'). " +
      "Non-interactive — use `stdin` param or pipe for input. " +
      "Long-running cmds: background with & and sleep. " +
      "Output truncated at ~30KB.",
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
  });
}
