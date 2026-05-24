/**
 * Standalone test for Anthropic prompt caching against a local proxy.
 *
 * Bypasses Vercel AI SDK entirely — talks directly to the Anthropic-shaped
 * /v1/messages endpoint via fetch. That way the only variable is whether
 * we attach `cache_control: ephemeral` to a content block; everything else
 * (system prompt bytes, tools, model) is byte-identical across runs.
 *
 * Usage:
 *   npx tsx examples/08-basic/scripts/test-prompt-cache.ts
 *
 * Env overrides (rarely needed):
 *   TEST_BASE_URL   default: http://localhost:4141/v1
 *   TEST_MODEL      default: claude-opus-4.6
 *   TEST_API_KEY    default: not-needed (your proxy ignores it)
 *
 * The expected output is roughly:
 *   [A1] no cache_control          → cache_creation=0     cache_read=0
 *   [A2] no cache_control (repeat) → cache_creation=0     cache_read=0
 *   [B1] WITH cache_control        → cache_creation=N+    cache_read=0
 *   [B2] WITH cache_control (repeat) → cache_creation=0   cache_read=N+
 *
 * If [B2] cache_read stays 0, the proxy or the model isn't actually caching;
 * compare base URL, model name, and inspect the proxy logs.
 *
 * Caveat: the proxy at :4141 may strip headers or rewrite the body. If
 * something looks off, capture a network trace and compare what reaches
 * api.anthropic.com to what this script sent.
 */

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:4141/v1";
const MODEL = process.env.TEST_MODEL ?? "claude-opus-4.6";
const API_KEY = process.env.TEST_API_KEY ?? "not-needed";

// Anthropic's minimum cacheable prefix is 1024 tokens (~4KB of English).
// Pad the system prompt with deterministic boilerplate well past that
// threshold so even a strict proxy won't auto-skip caching as "too small".
function buildSystemPrompt(): string {
  const sections = [
    "You are an interactive agent that helps users with software engineering tasks.",
    "",
    "# Environment",
    " - Primary working directory: /workspace/test",
    " - Platform: linux",
    " - Shell: bash",
    "",
    "# Tone and style",
    " - Be concise and direct.",
    " - Use file_path:line_number when referencing code.",
    " - Avoid emojis unless requested.",
    "",
    "# Long boilerplate to exceed the 1024-token cache minimum",
  ];
  const boilerplate = Array.from({ length: 60 }, (_, i) =>
    ` - Rule ${i + 1}: Always think step by step about whether the requested change is reversible, idempotent, and free of side effects on shared systems. When in doubt, ask the user for explicit confirmation before mutating any file outside the working tree, and never assume a project's conventions without first reading the relevant configuration files.`,
  );
  return [...sections, ...boilerplate].join("\n");
}

interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const TOOLS: Tool[] = [
  {
    name: "read_file",
    description: "Read a file from disk and return its contents as text.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute file path" } },
      required: ["path"],
    },
  },
  {
    name: "bash",
    description: "Run a shell command in the current working directory.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string", description: "Shell command to run" } },
      required: ["command"],
    },
  },
];

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicResponse {
  usage?: AnthropicUsage;
  content?: Array<{ type: string; text?: string }>;
  error?: { type: string; message: string };
}

async function sendRequest(opts: {
  label: string;
  withCacheControl: boolean;
  userMessage: string;
}): Promise<AnthropicUsage | null> {
  const systemBlock: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: buildSystemPrompt(),
      ...(opts.withCacheControl && { cache_control: { type: "ephemeral" } }),
    },
  ];

  const body = {
    model: MODEL,
    max_tokens: 64,
    system: systemBlock,
    tools: TOOLS,
    messages: [{ role: "user", content: opts.userMessage }],
  };

  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error(`[${opts.label}] network error:`, (e as Error).message);
    return null;
  }
  const elapsed = Date.now() - t0;

  const text = await res.text();
  let data: AnthropicResponse;
  try {
    data = JSON.parse(text);
  } catch {
    console.error(
      `[${opts.label}] non-JSON response (status=${res.status}): ${text.slice(0, 200)}`,
    );
    return null;
  }

  if (!res.ok || data.error) {
    console.error(
      `[${opts.label}] HTTP ${res.status}: ${data.error?.message ?? text.slice(0, 200)}`,
    );
    return null;
  }

  const usage = data.usage ?? {};
  const cacheControlTag = opts.withCacheControl ? "WITH cache_control   " : "no cache_control     ";
  console.log(
    `[${opts.label}] ${cacheControlTag} ` +
      `input=${pad(usage.input_tokens, 5)} ` +
      `output=${pad(usage.output_tokens, 4)} ` +
      `cache_creation=${pad(usage.cache_creation_input_tokens, 5)} ` +
      `cache_read=${pad(usage.cache_read_input_tokens, 5)} ` +
      `(${elapsed}ms)`,
  );
  return usage;
}

function pad(n: number | undefined, width: number): string {
  const s = n == null ? "0" : String(n);
  return s.padStart(width, " ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  console.log("─".repeat(96));
  console.log(`Anthropic prompt-cache test`);
  console.log(`  endpoint: ${BASE_URL}/messages`);
  console.log(`  model:    ${MODEL}`);
  console.log(`  system:   ${buildSystemPrompt().length} chars (~${Math.ceil(buildSystemPrompt().length / 4)} tokens)`);
  console.log("─".repeat(96));
  console.log();

  console.log("Phase A — both requests WITHOUT cache_control");
  console.log("  Expectation: both rows show cache_creation=0 and cache_read=0.");
  console.log("  If you see cache_read > 0 here, a prior test run still has cache");
  console.log("  alive in the upstream — wait 6+ minutes and retry for a clean baseline.");
  console.log();
  await sendRequest({
    label: "A1",
    withCacheControl: false,
    userMessage: "Say hi in three words.",
  });
  await sleep(500);
  await sendRequest({
    label: "A2",
    withCacheControl: false,
    userMessage: "Say hi in four words.",
  });

  console.log();
  console.log("Phase B — both requests WITH cache_control");
  console.log("  Expectation: B1 shows cache_creation > 0 (writes the cache),");
  console.log("               B2 shows cache_read > 0 and input_tokens drops sharply.");
  console.log();
  await sendRequest({
    label: "B1",
    withCacheControl: true,
    userMessage: "Say hi in three words.",
  });
  await sleep(500);
  await sendRequest({
    label: "B2",
    withCacheControl: true,
    userMessage: "Say hi in four words.",
  });

  console.log();
  console.log("Phase C — request WITHOUT cache_control AFTER cache is warm");
  console.log("  Expectation: cache_read > 0 even though we didn't ask for caching.");
  console.log("  This is the 'free piggyback' effect — read uses prefix-match,");
  console.log("  it doesn't require the marker on the current request.");
  console.log();
  await sendRequest({
    label: "C1",
    withCacheControl: false,
    userMessage: "Say hi in five words.",
  });

  console.log();
  console.log("─".repeat(96));
  console.log("Done. Interpretation:");
  console.log("  • B2.cache_read >> A2.cache_read     → caching works, change is worthwhile.");
  console.log("  • B2.cache_read ≈ 0                  → upstream not honoring cache_control;");
  console.log("                                         check proxy at :4141.");
  console.log("  • A1/A2 cache_read both > 0          → stale cache from prior runs is alive.");
  console.log("                                         wait 6 min and re-run for a clean test.");
  console.log("─".repeat(96));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
