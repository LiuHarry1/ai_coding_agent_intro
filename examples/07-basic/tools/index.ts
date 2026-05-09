import { defaultRegistry } from "../core/tool-registry.js";
import { definition as bash } from "./bash.js";
import { definition as readFile } from "./read_file.js";
import { definition as writeFile } from "./write_file.js";
import { definition as editFile } from "./edit_file.js";
import { definition as listDir } from "./list_dir.js";
import { definition as todoWrite } from "./todo_write.js";
import { definition as webSearch } from "./web_search.js";
import { definition as webFetch } from "./web_fetch.js";

[bash, readFile, writeFile, editFile, listDir, todoWrite, webSearch, webFetch].forEach((def) => defaultRegistry.register(def));

export { defaultRegistry };
