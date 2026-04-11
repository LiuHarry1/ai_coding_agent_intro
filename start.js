import * as fs from "fs";

const example = process.argv[2] || "06-basic";

console.log(`[start] Loading example: ${example}`);

async function tryImport(base) {
  const tsPath = `./examples/${example}/${base}.ts`;
  const jsPath = `./examples/${example}/${base}.js`;
  const tsExists = fs.existsSync(new URL(tsPath, import.meta.url));
  return import(tsExists ? tsPath : jsPath);
}

let runAgent, createTools, systemPrompt, startServer;
try {
  ({ runAgent } = await tryImport("agent"));
  ({ createTools } = await tryImport("tools"));
  ({ systemPrompt } = await tryImport("prompts"));

  try {
    ({ startServer } = await tryImport("server"));
    console.log(`[start] Using custom server from ${example}/`);
  } catch {
    ({ startServer } = await import("./shared/server.js"));
  }
} catch (err) {
  console.error(`[start] Failed to load example "${example}": ${err.message}`);
  console.error(`[start] Available examples:`);

  const dirs = fs.readdirSync(new URL("./examples", import.meta.url));
  dirs.forEach(d => console.error(`  - ${d}`));
  process.exit(1);
}

startServer({ runAgent, createTools, systemPrompt });
