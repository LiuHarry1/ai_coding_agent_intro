import { defaultRegistry } from "../core/tool-registry.js";
import { isWindows } from "../core/platform.js";
import { definition as bash } from "./bash.js";
import { definition as powershell } from "./powershell.js";
import { definition as readFile } from "./read_file.js";
import { definition as writeFile } from "./write_file.js";
import { definition as editFile } from "./edit_file.js";
// list_dir intentionally NOT registered — glob/grep replace it. Naive
// directory listings either blow up context on large repos or hide what
// the model actually needs; glob with an mtime sort surfaces relevant
// files instead. The file is kept on disk for reference but unwired.
import { definition as todoWrite } from "./todo_write.js";
import { definition as webSearch } from "./web_search.js";
import { definition as webFetch } from "./web_fetch.js";
import { definition as globTool } from "./glob.js";
import { definition as grepTool } from "./grep.js";
import { definition as askUserQuestion } from "./ask_user_question.js";

// Register exactly one shell tool — `bash` on Unix, `powershell` on Windows.
// The model never sees the other; this prevents wrong-syntax confusion.
const shellTool = isWindows ? powershell : bash;

[
  shellTool,
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
