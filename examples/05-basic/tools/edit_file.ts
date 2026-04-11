import { tool } from "ai";
import { z } from "zod";
import * as fs from "fs";
import { resolvePath } from "./utils.js";
import type { ToolDefinition } from "../core/types.js";

export const definition: ToolDefinition = {
  name: "edit_file",
  description: "Make targeted edits by replacing specific text in a file",
  create(cwd) {
    return tool({
      description:
        "Replace a specific string in an existing file. " +
        "ALWAYS read the file first so you know the exact text. " +
        "old_string must match exactly (whitespace matters) and be unique in the file. " +
        "Include 2-3 lines of surrounding context if needed for uniqueness.",
      inputSchema: z.object({
        file_path: z.string().describe("Path to the file (relative to cwd)"),
        old_string: z.string().describe("The exact text to find and replace (must be unique in the file)"),
        new_string: z.string().describe("The replacement text (must differ from old_string)"),
        replace_all: z.boolean().optional().describe("Replace all occurrences (default: false)"),
      }),
      execute: async ({ file_path, old_string, new_string, replace_all = false }: {
        file_path: string; old_string: string; new_string: string; replace_all?: boolean;
      }) => {
        const resolved = resolvePath(cwd, file_path);
        if ("error" in resolved) return resolved.error;
        const { abs } = resolved;
        if (!fs.existsSync(abs)) return `Error: file not found: ${file_path}`;
        if (fs.statSync(abs).isDirectory()) return `Error: ${file_path} is a directory`;
        if (old_string === new_string) return `Error: old_string and new_string are identical`;
        if (!old_string) return `Error: old_string cannot be empty — use write_file to create files`;

        const content = fs.readFileSync(abs, "utf-8");

        let search = old_string;
        let matchCount = countOccurrences(content, search);

        if (matchCount === 0) {
          const fuzzyResult = fuzzyFind(content, old_string);
          if (!fuzzyResult) {
            return `Error: old_string not found in ${file_path}. Make sure it matches exactly (including whitespace and indentation).`;
          }
          search = fuzzyResult;
          matchCount = countOccurrences(content, search);
        }

        if (matchCount > 1 && !replace_all) {
          return `Error: found ${matchCount} matches in ${file_path}. Include more context or set replace_all: true.`;
        }

        const newContent = replace_all
          ? content.replaceAll(search, new_string)
          : content.replace(search, new_string);

        fs.writeFileSync(abs, newContent, "utf-8");

        const oldLines = content.split("\n").length;
        const newLines = newContent.split("\n").length;
        const replacements = replace_all ? matchCount : 1;
        const lineInfo = oldLines !== newLines ? ` (${oldLines} → ${newLines} lines)` : "";

        return `Edited ${file_path}: ${replacements} replacement(s)${lineInfo}`;
      },
    });
  },
};

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(search, pos)) !== -1) {
    count++;
    pos += search.length;
  }
  return count;
}

function fuzzyFind(content: string, search: string): string | null {
  const contentLines = content.split("\n");
  const searchLines = search.split("\n");

  if (searchLines[searchLines.length - 1] === "") searchLines.pop();
  if (searchLines.length === 0) return null;

  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (contentLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return contentLines.slice(i, i + searchLines.length).join("\n");
    }
  }

  return null;
}
