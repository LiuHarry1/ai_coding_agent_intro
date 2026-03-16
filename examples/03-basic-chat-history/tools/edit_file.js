import { tool } from "ai";
import { z } from "zod";
import * as fs from "fs";

export function createEditFileTool(cwd, { resolvePath }) {
  return tool({
    description:
      "Make targeted edits to a file by replacing specific text. " +
      "More efficient than write_file for small changes to existing files — " +
      "only the changed portion needs to be specified. " +
      "old_string must uniquely identify the text to replace (include surrounding context if needed).",
    inputSchema: z.object({
      file_path: z.string().describe("Path to the file (relative to cwd)"),
      old_string: z.string().describe("The exact text to find and replace (must be unique in the file)"),
      new_string: z.string().describe("The replacement text (must differ from old_string)"),
      replace_all: z
        .boolean()
        .optional()
        .describe("Replace all occurrences instead of requiring uniqueness (default: false)"),
    }),
    execute: async ({ file_path, old_string, new_string, replace_all = false }) => {
      const { abs, error } = resolvePath(cwd, file_path);
      if (error) return error;
      if (!fs.existsSync(abs)) return `Error: file not found: ${file_path}`;
      if (fs.statSync(abs).isDirectory()) return `Error: ${file_path} is a directory`;
      if (old_string === new_string) return `Error: old_string and new_string are identical`;
      if (!old_string) return `Error: old_string cannot be empty — use write_file to create files`;

      const content = fs.readFileSync(abs, "utf-8");

      let search = old_string;
      let matchCount = countOccurrences(content, search);

      if (matchCount === 0) {
        search = fuzzyFind(content, old_string);
        if (!search) {
          return `Error: old_string not found in ${file_path}. Make sure it matches exactly (including whitespace and indentation).`;
        }
        matchCount = countOccurrences(content, search);
      }

      if (matchCount > 1 && !replace_all) {
        return `Error: found ${matchCount} matches for old_string in ${file_path}. Include more surrounding context to make it unique, or set replace_all: true.`;
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
}

function countOccurrences(text, search) {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(search, pos)) !== -1) {
    count++;
    pos += search.length;
  }
  return count;
}

function fuzzyFind(content, search) {
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
