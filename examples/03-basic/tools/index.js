import { truncate, resolvePath } from "./utils.js";
import { createBashTool } from "./bash.js";
import { createReadFileTool } from "./read_file.js";
import { createWriteFileTool } from "./write_file.js";
import { createEditFileTool } from "./edit_file.js";

export function createTools(cwd) {
  const utils = { truncate, resolvePath };

  return {
    bash: createBashTool(cwd, utils),
    read_file: createReadFileTool(cwd, utils),
    write_file: createWriteFileTool(cwd, utils),
    edit_file: createEditFileTool(cwd, utils),
  };
}
