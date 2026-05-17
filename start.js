import * as fs from "fs";

// Load .env (Node 20.12+ built-in, no dotenv dependency needed).
// Silent when the file doesn't exist.
try {
  process.loadEnvFile(".env");
  console.log("[start] Loaded .env");
} catch (err) {
  if (err?.code !== "ENOENT") {
    console.warn(`[start] Failed to load .env: ${err.message}`);
  }
}

// Log the env vars that actually drive glob/grep behavior so a stale
// server (or a typo in .env) shows up immediately at boot instead of
// being diagnosed by inspection. Undefined here = ripgrep gets the
// surprise-permissive defaults baked into utils/glob.ts.
console.log(
  `[start] GLOB_NO_IGNORE=${process.env.GLOB_NO_IGNORE ?? "(unset → defaults true)"} ` +
    `GLOB_HIDDEN=${process.env.GLOB_HIDDEN ?? "(unset → defaults true)"}`
);

const example = process.argv[2] || "08-basic";

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
