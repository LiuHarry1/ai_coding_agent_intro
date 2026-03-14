import { tool } from "ai";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

export function createBasicTools(cwd) {
  return {
    read_file: tool({
      description: "Read the contents of a file at the given path",
      inputSchema: z.object({
        path: z.string().describe("The file path to read"),
      }),
      execute: async ({ path: filePath }) => {
        try {
          return fs.readFileSync(path.resolve(cwd, filePath), "utf-8");
        } catch (e) {
          return `Error reading file: ${e.message}`;
        }
      },
    }),

    write_file: tool({
      description: "Write content to a file. Creates the file if it doesn't exist.",
      inputSchema: z.object({
        path: z.string().describe("The file path to write to"),
        content: z.string().describe("The content to write"),
      }),
      execute: async ({ path: filePath, content }) => {
        try {
          const full = path.resolve(cwd, filePath);
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, content);
          return `Successfully wrote to ${filePath}`;
        } catch (e) {
          return `Error writing file: ${e.message}`;
        }
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
  };
}

export function createRefactorTools(projectDir) {
  function resolvePath(filePath) {
    if (path.isAbsolute(filePath)) return filePath;
    return path.resolve(projectDir, filePath);
  }

  return {
    list_files: tool({
      description: "List files in a directory recursively. Returns file paths relative to the project root.",
      inputSchema: z.object({
        directory: z.string().optional().describe("Directory to list, relative to project root. Defaults to '.'"),
        pattern: z.string().optional().describe("Glob-like filter, e.g. '*.ts' or '*.js'"),
        maxDepth: z.number().optional().describe("Max directory depth. Defaults to 4"),
      }),
      execute: async ({ directory = ".", pattern, maxDepth = 4 }) => {
        const target = resolvePath(directory);
        try {
          let cmd = `find "${target}" -maxdepth ${maxDepth} -type f`;
          if (pattern) cmd += ` -name "${pattern}"`;
          cmd += ` | head -200`;
          const output = execSync(cmd, { encoding: "utf-8", timeout: 10000 });
          const relative = output
            .split("\n")
            .filter(Boolean)
            .map((f) => path.relative(projectDir, f))
            .join("\n");
          return relative || "(no files found)";
        } catch (e) {
          return `Error: ${e.message}`;
        }
      },
    }),

    read_file: tool({
      description: "Read the contents of a file. Path is relative to project root.",
      inputSchema: z.object({
        path: z.string().describe("File path relative to project root"),
      }),
      execute: async ({ path: filePath }) => {
        try {
          const content = fs.readFileSync(resolvePath(filePath), "utf-8");
          const lines = content.split("\n");
          return lines.map((line, i) => `${String(i + 1).padStart(4)} | ${line}`).join("\n");
        } catch (e) {
          return `Error reading file: ${e.message}`;
        }
      },
    }),

    write_file: tool({
      description: "Write content to a file (overwrites). Path is relative to project root.",
      inputSchema: z.object({
        path: z.string().describe("File path relative to project root"),
        content: z.string().describe("The full file content to write"),
      }),
      execute: async ({ path: filePath, content }) => {
        try {
          const fullPath = resolvePath(filePath);
          const dir = path.dirname(fullPath);
          if (!dir.startsWith(projectDir)) {
            return "Error: cannot write outside the project directory";
          }
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(fullPath, content);
          return `Successfully wrote to ${filePath}`;
        } catch (e) {
          return `Error writing file: ${e.message}`;
        }
      },
    }),

    search_code: tool({
      description: "Search for a text pattern across all files in the project (like grep).",
      inputSchema: z.object({
        pattern: z.string().describe("The text or regex pattern to search for"),
        filePattern: z.string().optional().describe("File extension filter, e.g. '*.ts'"),
      }),
      execute: async ({ pattern, filePattern }) => {
        try {
          let cmd = `grep -rn "${pattern}" "${projectDir}"`;
          if (filePattern) cmd += ` --include="${filePattern}"`;
          cmd += " | head -100";
          const output = execSync(cmd, { encoding: "utf-8", timeout: 15000 });
          const relative = output.replace(new RegExp(projectDir + "/", "g"), "");
          return relative || "(no matches found)";
        } catch (e) {
          if (e.status === 1) return "(no matches found)";
          return `Error: ${e.message}`;
        }
      },
    }),

    run_command: tool({
      description: "Run a shell command in the project directory.",
      inputSchema: z.object({
        command: z.string().describe("The shell command to run"),
      }),
      execute: async ({ command }) => {
        try {
          return execSync(command, { encoding: "utf-8", timeout: 60000, cwd: projectDir });
        } catch (e) {
          return `Exit code ${e.status}\n${e.stdout || ""}${e.stderr || ""}`;
        }
      },
    }),
  };
}
