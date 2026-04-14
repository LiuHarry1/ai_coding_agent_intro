import { defaultRegistry } from "../core/tool-registry.js";
import { definition as bash } from "./bash.js";
import { definition as readFile } from "./read_file.js";
import { definition as writeFile } from "./write_file.js";
import { definition as editFile } from "./edit_file.js";
import { definition as listDir } from "./list_dir.js";
import { definition as todoWrite } from "./todo_write.js";

[bash, readFile, writeFile, editFile, listDir, todoWrite].forEach((def) => defaultRegistry.register(def));

export { defaultRegistry };
