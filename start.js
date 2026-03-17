const example = process.argv[2] || "02-basic";

console.log(`[start] Loading example: ${example}`);

let runAgent, createTools, systemPrompt, startServer;
try {
  ({ runAgent } = await import(`./examples/${example}/agent.js`));
  ({ createTools } = await import(`./examples/${example}/tools.js`));
  ({ systemPrompt } = await import(`./examples/${example}/prompts.js`));

  // Use example's own server.js if it exists, otherwise fall back to shared
  try {
    ({ startServer } = await import(`./examples/${example}/server.js`));
    console.log(`[start] Using custom server from ${example}/server.js`);
  } catch {
    ({ startServer } = await import("./shared/server.js"));
  }
} catch (err) {
  console.error(`[start] Failed to load example "${example}": ${err.message}`);
  console.error(`[start] Available examples:`);

  import("fs").then(fs => {
    const dirs = fs.readdirSync(new URL("./examples", import.meta.url));
    dirs.forEach(d => console.error(`  - ${d}`));
  });
  process.exit(1);
}

startServer({ runAgent, createTools, systemPrompt });
