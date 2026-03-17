import { tool } from "ai";
import { z } from "zod";
import * as fs from "fs";

export function createReadFileTool(cwd, { truncate, resolvePath }) {
  return tool({
    description:
      "Read a file and return its contents with line numbers. " +
      "Supports optional offset/limit to read a specific range. " +
      "Use negative offset to read from the end of the file.",
    inputSchema: z.object({
      file_path: z.string().describe("Path to the file (relative to cwd)"),
      offset: z
        .number()
        .optional()
        .describe("Line to start from (1-based). Negative counts from end (e.g. -20 = last 20 lines)"),
      limit: z
        .number()
        .optional()
        .describe("Max number of lines to return"),
    }),
    execute: async ({ file_path, offset, limit }) => {
      const { abs, error } = resolvePath(cwd, file_path);
      if (error) return error;
      if (!fs.existsSync(abs)) return `Error: file not found: ${file_path}`;

      const stat = fs.statSync(abs);
      if (stat.isDirectory()) return `Error: ${file_path} is a directory, not a file`;

      const MAX_FILE_SIZE = 2 * 1024 * 1024;
      if (stat.size > MAX_FILE_SIZE) {
        return `Error: file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Use offset/limit or bash: head/tail`;
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
        .map((line, i) => `${String(startLine + i).padStart(4)}│${line}`)
        .join("\n");

      const header = `${file_path} (lines ${startLine}-${endLine} of ${totalLines})`;
      return truncate(`${header}\n${numbered}`);
    },
  });
}
