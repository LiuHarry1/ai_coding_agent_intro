import { defaultRegistry } from "../core/tool-registry.js";
import { isPowerShellToolEnabled } from "../core/shell-utils.js";
import { definition as bash } from "./bash.js";
import { definition as powershell } from "./powershell.js";
import { definition as readFile } from "./read_file.js";
import { definition as writeFile } from "./write_file.js";
import { definition as editFile } from "./edit_file.js";
// list_dir intentionally NOT registered — no ListDir tool.
// Glob for file-name search; Bash read-only ls for directory checks.
// list_dir.ts is kept on disk for reference but unwired.
import { definition as todoWrite } from "./todo_write.js";
import { definition as webSearch } from "./web_search.js";
import { definition as webFetch } from "./web_fetch.js";
import { definition as globTool } from "./glob.js";
import { definition as grepTool } from "./grep.js";
import { definition as askUserQuestion } from "./ask_user_question.js";

// Default: bash always; powershell additionally on Windows.
const shellTools = [bash, ...(isPowerShellToolEnabled() ? [powershell] : [])];

[
  ...shellTools,
  readFile,
  writeFile,
  editFile,
  globTool,
  grepTool,
  todoWrite,
  webSearch,
  webFetch,
  askUserQuestion,
].forEach((def) => defaultRegistry.register(def));

export { defaultRegistry };
