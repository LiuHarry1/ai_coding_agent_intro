import { tool } from "ai";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { truncate, resolvePath } from "./utils.js";
import type { ToolDefinition } from "../core/types.js";
import { LIST_DIR_TOOL_NAME } from "./tool-names.js";

const IGNORE_PATTERNS = [
  "node_modules/",
  "__pycache__/",
  ".git/",
  "dist/",
  "build/",
  "target/",
  "vendor/",
  "bin/",
  "obj/",
  ".idea/",
  ".vscode/",
  ".zig-cache/",
  "zig-out/",
  ".coverage/",
  "coverage/",
  "tmp/",
  "temp/",
  ".cache/",
  "cache/",
  "logs/",
  ".venv/",
  "venv/",
  "env/",
  ".next/",
  ".nuxt/",
  ".output/",
  ".turbo/",
  ".parcel-cache/",
];

const MAX_FILES = 200;
const MAX_DEPTH = 5;

function isGitRepo(dir: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd: dir, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function getGitFiles(dir: string): string[] {
  try {
    const tracked = execSync("git ls-files", { cwd: dir, stdio: "pipe", maxBuffer: 5 * 1024 * 1024 })
      .toString().trim().split("\n").filter(Boolean);
    const untracked = execSync("git ls-files --others --exclude-standard", { cwd: dir, stdio: "pipe", maxBuffer: 5 * 1024 * 1024 })
      .toString().trim().split("\n").filter(Boolean);
    return [...tracked, ...untracked];
  } catch {
    return [];
  }
}

function walkDir(dir: string, base: string, depth: number, maxDepth: number, ignore: Set<string>): string[] {
  if (depth > maxDepth) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    const rel = base ? `${base}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const dirKey = entry.name + "/";
      if (ignore.has(dirKey)) continue;
      files.push(...walkDir(path.join(dir, entry.name), rel, depth + 1, maxDepth, ignore));
    } else {
      files.push(rel);
    }

    if (files.length >= MAX_FILES) break;
  }
  return files;
}

interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
  files: string[];
}

function buildTree(files: string[]): TreeNode {
  const root: TreeNode = { name: "", children: new Map(), files: [] };

  for (const file of files) {
    const parts = file.split("/");
    let node = root;

    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts[i];
      if (!node.children.has(dir)) {
        node.children.set(dir, { name: dir, children: new Map(), files: [] });
      }
      node = node.children.get(dir)!;
    }

    node.files.push(parts[parts.length - 1]);
  }
  return root;
}

function renderTree(node: TreeNode, depth: number): string {
  let output = "";
  const indent = "  ".repeat(depth);

  const dirs = [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [, child] of dirs) {
    output += `${indent}${child.name}/\n`;
    output += renderTree(child, depth + 1);
  }

  const sortedFiles = [...node.files].sort();
  for (const file of sortedFiles) {
    output += `${indent}${file}\n`;
  }

  return output;
}

export const definition: ToolDefinition = {
  name: LIST_DIR_TOOL_NAME,
  description: "List files and directories with smart filtering (respects .gitignore, hides noise like node_modules)",
  create(cwd) {
    return tool({
      description:
        "List files and directories at a given path. Returns a tree-style view.\n\n" +
        "Smart filtering:\n" +
        "- In git repos: uses `git ls-files` (automatically respects .gitignore)\n" +
        "- Non-git repos: walks the filesystem, skipping common noise directories " +
        "(node_modules, .git, dist, build, __pycache__, etc.)\n\n" +
        "Use this INSTEAD of `bash ls` for exploring project structure. " +
        "For searching file contents, use bash with grep/ripgrep instead.",
      inputSchema: z.object({
        dir_path: z.string().optional()
          .describe("Directory to list, relative to cwd. Defaults to '.' (project root)"),
        depth: z.number().optional()
          .describe("Max depth to recurse. Default 3, max 5"),
        ignore: z.array(z.string()).optional()
          .describe("Additional glob patterns to ignore (e.g. ['*.log', 'temp/'])"),
      }),
      execute: async (args: { dir_path?: string; depth?: number; ignore?: string[] }) => {
        const dirPath = args.dir_path || ".";
        const maxDepth = Math.min(args.depth ?? 3, MAX_DEPTH);

        const resolved = resolvePath(cwd, dirPath);
        if ("error" in resolved) return resolved.error;
        const { abs } = resolved;

        if (!fs.existsSync(abs)) return `Error: directory not found: ${dirPath}`;
        if (!fs.statSync(abs).isDirectory()) return `Error: ${dirPath} is not a directory`;

        let files: string[];

        if (isGitRepo(abs)) {
          files = getGitFiles(abs);

          if (maxDepth < MAX_DEPTH) {
            files = files.filter((f) => f.split("/").length <= maxDepth + 1);
          }
        } else {
          const ignoreSet = new Set(IGNORE_PATTERNS);
          if (args.ignore) {
            for (const p of args.ignore) ignoreSet.add(p.endsWith("/") ? p : p + "/");
          }
          files = walkDir(abs, "", 0, maxDepth, ignoreSet);
        }

        if (args.ignore && isGitRepo(abs)) {
          const patterns = args.ignore.map((p) => p.replace(/\/$/, ""));
          files = files.filter((f) => !patterns.some((p) => f.includes(p)));
        }

        const truncated = files.length >= MAX_FILES;
        files = files.slice(0, MAX_FILES);

        const tree = buildTree(files);
        let output = `${dirPath}/\n` + renderTree(tree, 1);

        if (truncated) {
          output += `\n... (showing first ${MAX_FILES} files, more exist)`;
        }

        output += `\n(${files.length} files)`;

        return truncate(output);
      },
    });
  },
};
