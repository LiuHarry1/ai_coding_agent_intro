import { tool } from "ai";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

export function createWriteFileTool(cwd, { resolvePath }) {
  return tool({
    description:
      "Create a new file or overwrite an existing file. " +
      "Prefer this for new files. For small edits to existing files, prefer edit_file instead.",
    inputSchema: z.object({
      file_path: z.string().describe("Path to the file (relative to cwd)"),
      content: z.string().describe("The full content to write"),
    }),
    execute: async ({ file_path, content }) => {
      const { abs, error } = resolvePath(cwd, file_path);
      if (error) return error;

      const exists = fs.existsSync(abs);
      if (exists && fs.statSync(abs).isDirectory()) {
        return `Error: ${file_path} is a directory`;
      }

      fs.mkdirSync(path.dirname(abs), { recursive: true });

      const lines = content.split("\n").length;

      if (!exists) {
        fs.writeFileSync(abs, content, "utf-8");
        return `Created ${file_path} (${lines} lines)`;
      }

      const oldContent = fs.readFileSync(abs, "utf-8");
      if (oldContent === content) return `No changes — ${file_path} already has this content`;

      const oldLines = oldContent.split("\n").length;
      fs.writeFileSync(abs, content, "utf-8");
      return `Overwrote ${file_path} (${oldLines} → ${lines} lines)`;
    },
  });
}
