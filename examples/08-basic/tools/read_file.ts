import { tool } from "ai";
import { z } from "zod";
import * as fs from "fs";
import { truncate, resolvePath } from "./utils.js";
import type { ToolDefinition } from "../core/types.js";

// Hard cap on file size for read_file. Files over this throw — the
// model must use grep to locate the section first, or fall back to
// shell `sed -n 'A,Bp'`.
// `MAX_OUTPUT_SIZE` (0.25 MB), retained after their A/B test showed
// "throw on oversize" yields fewer tokens than "truncate and serve".
const MAX_FILE_SIZE = 256 * 1024;

export const definition: ToolDefinition = {
  name: "read_file",
  description: "Read file contents with line numbers",
  isConcurrencySafe: () => true,
  create(cwd) {
    return tool({
      description:
        `Read a file and return its contents with line numbers. ` +
        `Supports optional offset/limit to read a specific range. ` +
        `Use negative offset to read from the end of the file. ` +
        `Files over ${Math.round(MAX_FILE_SIZE / 1024)} KB are rejected — use \`grep\` to locate the section first.`,
      inputSchema: z.object({
        file_path: z.string().describe("Path to the file (relative to cwd)"),
        offset: z.number().optional().describe("Line to start from (1-based). Negative counts from end"),
        limit: z.number().optional().describe("Max number of lines to return"),
      }),
      execute: async ({ file_path, offset, limit }: { file_path: string; offset?: number; limit?: number }) => {
        const resolved = resolvePath(cwd, file_path);
        if ("error" in resolved) return resolved.error;
        const { abs } = resolved;
        if (!fs.existsSync(abs)) return `Error: file not found: ${file_path}`;

        const stat = fs.statSync(abs);
        if (stat.isDirectory()) return `Error: ${file_path} is a directory, not a file`;

        if (stat.size > MAX_FILE_SIZE) {
          return (
            `Error: file is ${(stat.size / 1024).toFixed(1)} KB (hard cap ${Math.round(MAX_FILE_SIZE / 1024)} KB). ` +
            `Use \`grep\` to find the relevant lines first, or use the shell with \`sed -n 'A,Bp'\` / \`head\` / \`tail\`.`
          );
        }

        const buf = fs.readFileSync(abs);
        for (let i = 0; i < Math.min(buf.length, 8192); i++) {
          if (buf[i] === 0) return `Error: binary file detected — cannot display ${file_path}`;
        }

        let lines = buf.toString("utf-8").split("\n");
        const totalLines = lines.length;

        let startLine = 1;
        if (offset != null && offset < 0) {
          startLine = Math.max(1, totalLines + offset + 1);
          lines = lines.slice(startLine - 1);
        } else if (offset != null && offset > 0) {
          startLine = offset;
          lines = lines.slice(offset - 1);
        }
        if (limit != null && limit > 0) lines = lines.slice(0, limit);

        const endLine = startLine + lines.length - 1;
        const numbered = lines
          .map((line: string, i: number) => `${String(startLine + i).padStart(4)}│${line}`)
          .join("\n");

        const header = `${file_path} (lines ${startLine}-${endLine} of ${totalLines})`;
        return truncate(`${header}\n${numbered}`);
      },
    });
  },
};
