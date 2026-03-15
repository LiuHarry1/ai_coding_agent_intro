import { tool } from "ai";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execSync, spawn } from "child_process";

export function createTools(cwd) {
  return {
    read_file: tool({
      description: "Read the contents of a file at the given path (relative to cwd).",
      inputSchema: z.object({
        path: z.string().describe("File path to read"),
      }),
      execute: async ({ path: filePath }) => {
        const abs = path.resolve(cwd, filePath);
        if (!fs.existsSync(abs)) return `Error: file not found: ${filePath}`;
        return fs.readFileSync(abs, "utf-8");
      },
    }),

    write_file: tool({
      description: "Write content to a file. Creates parent directories if needed.",
      inputSchema: z.object({
        path: z.string().describe("File path to write"),
        content: z.string().describe("Content to write"),
      }),
      execute: async ({ path: filePath, content }) => {
        const abs = path.resolve(cwd, filePath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf-8");
        return `Wrote ${content.length} chars to ${filePath}`;
      },
    }),

    list_files: tool({
      description: "List files and directories at the given path.",
      inputSchema: z.object({
        directory: z.string().optional().describe("Directory to list (default: cwd)"),
      }),
      execute: async ({ directory = "." }) => {
        const abs = path.resolve(cwd, directory);
        if (!fs.existsSync(abs)) return `Error: directory not found: ${directory}`;
        const entries = fs.readdirSync(abs, { withFileTypes: true });
        return entries
          .map((e) => `${e.isDirectory() ? "[dir]" : "[file]"} ${e.name}`)
          .join("\n");
      },
    }),

    run_command: tool({
      description: "Run a shell command and return its output",
      inputSchema: z.object({
        command: z.string().describe("The shell command to run"),
      }),
      execute: async ({ command }) => {
        try {
          return execSync(command, { encoding: "utf-8", timeout: 30000, cwd });
        } catch (e) {
          return `Exit code ${e.status}\n${e.stdout || ""}${e.stderr || ""}`;
        }
      },
    }),

    run_bash: tool({
      description:
        "Run a shell command with optional stdin input. " +
        "Use this when a program needs interactive input (e.g. input(), readline). " +
        "Provide the stdin content and the program will read from it line by line.",
      inputSchema: z.object({
        command: z.string().describe("The shell command to run"),
        stdin: z
          .string()
          .optional()
          .describe("Text to feed to the process stdin, e.g. 'hello\\nexit\\n'"),
        timeout: z
          .number()
          .optional()
          .describe("Timeout in ms (default 30000)"),
      }),
      execute: async ({ command, stdin, timeout = 30000 }) => {
        return new Promise((resolve) => {
          const child = spawn("bash", ["-c", command], {
            cwd,
            env: { ...process.env },
          });

          let stdout = "";
          let stderr = "";
          let killed = false;

          const timer = setTimeout(() => {
            killed = true;
            child.kill("SIGKILL");
          }, timeout);

          child.stdout.on("data", (d) => { stdout += d; });
          child.stderr.on("data", (d) => { stderr += d; });

          child.on("close", (code) => {
            clearTimeout(timer);
            const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
            if (killed) {
              resolve(`[timeout after ${timeout}ms]\n${output}`);
            } else {
              resolve(code === 0 ? output : `Exit code ${code}\n${output}`);
            }
          });

          child.on("error", (err) => {
            clearTimeout(timer);
            resolve(`[error] ${err.message}`);
          });

          if (stdin) {
            child.stdin.write(stdin);
            child.stdin.end();
          } else {
            child.stdin.end();
          }
        });
      },
    }),
  };
}
