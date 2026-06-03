import * as fs from "fs";
import { MAX_OUTPUT_SIZE_BYTES } from "./limits.js";
import type { ReadNotebookOutput } from "./types.js";
import { FileTooLargeError } from "./types.js";

export function readNotebookFile(
  absPath: string,
  displayPath: string,
): ReadNotebookOutput {
  if (!fs.existsSync(absPath)) {
    throw new Error(`file not found: ${displayPath}`);
  }
  const stat = fs.statSync(absPath);
  if (stat.size > MAX_OUTPUT_SIZE_BYTES) {
    throw new FileTooLargeError(stat.size, MAX_OUTPUT_SIZE_BYTES);
  }

  const raw = fs.readFileSync(absPath, "utf-8");
  let parsed: { cells?: unknown[] };
  try {
    parsed = JSON.parse(raw) as { cells?: unknown[] };
  } catch {
    throw new Error(`invalid notebook JSON: ${displayPath}`);
  }

  const cells = Array.isArray(parsed.cells) ? parsed.cells : [];
  return {
    type: "notebook",
    file: {
      filePath: displayPath,
      cells,
    },
  };
}
