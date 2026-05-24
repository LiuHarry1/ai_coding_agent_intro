/**
 * Minimal demo: same request body sent 4 times, comparing what happens
 * with and without `cache_control: ephemeral` on the system prompt.
 *
 * Each run uses a UNIQUE system prompt (timestamp-tagged) so previous
 * cache entries from earlier test runs can't contaminate the result.
 *
 * Usage:
 *   npx tsx examples/08-basic/scripts/cache-demo.ts
 */

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:4141/v1";
const MODEL = process.env.TEST_MODEL ?? "claude-opus-4.6";
const API_KEY = process.env.TEST_API_KEY ?? "not-needed";

// Anthropic requires ≥1024 tokens of cacheable content (model-dependent).
// Pad the system prompt past that with deterministic boilerplate, then
// tag it with a per-run UUID so no previous test run's cache can match.
const RUN_TAG = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function buildSystemPrompt(): string {
  const lines = [
    `You are a test agent. Run ID: ${RUN_TAG}.`,
    `Always respond with exactly the requested number of words.`,
    ``,
  ];
  // Claude Opus 4.6 appears to need ≥~4096 tokens of cacheable content
  // (the 1024-token figure in older docs only applies to Sonnet 3.5).
  // Pad to ~6000 tokens to safely clear the threshold across model variants.
  for (let i = 0; i < 500; i++) {
    lines.push(
      ` - Guideline ${i}: think step by step, prefer concise replies, avoid unnecessary preamble, and never invent facts that aren't backed by the user's instructions or tool output.`,
    );
  }
  return lines.join("\n");
}

const SYSTEM_PROMPT = buildSystemPrompt();

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

async function callAnthropic(opts: {
  label: string;
  withCacheControl: boolean;
  userText: string;
}): Promise<Usage | null> {
  const systemBlock = {
    type: "text",
    text: SYSTEM_PROMPT,
    ...(opts.withCacheControl && { cache_control: { type: "ephemeral" } }),
  };

  const body = {
    model: MODEL,
    max_tokens: 32,
    system: [systemBlock],
    messages: [{ role: "user", content: opts.userText }],
  };

  const res = await fetch(`${BASE_URL}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data: { usage?: Usage; error?: { message: string } };
  try {
    data = JSON.parse(text);
  } catch {
    console.error(`[${opts.label}] non-JSON (status=${res.status}):`, text.slice(0, 200));
    return null;
  }
  if (!res.ok || data.error) {
    console.error(`[${opts.label}] HTTP ${res.status}: ${data.error?.message ?? text.slice(0, 200)}`);
    return null;
  }
  return data.usage ?? {};
}

function fmt(n: number | undefined, width = 5): string {
  return (n == null ? "0" : String(n)).padStart(width, " ");
}

function row(label: string, mode: string, u: Usage | null): string {
  if (!u) return `  ${label}  ${mode}  ERROR`;
  return (
    `  ${label}  ${mode.padEnd(22)}  ` +
    `input=${fmt(u.input_tokens)}  ` +
    `output=${fmt(u.output_tokens, 3)}  ` +
    `cache_write=${fmt(u.cache_creation_input_tokens)}  ` +
    `cache_read=${fmt(u.cache_read_input_tokens)}`
  );
}

async function main(): Promise<void> {
  const sysCharCount = SYSTEM_PROMPT.length;
  const sysTokEst = Math.ceil(sysCharCount / 4);

  console.log("═".repeat(96));
  console.log(`Prompt-caching A/B demo`);
  console.log(`  endpoint: ${BASE_URL}/messages`);
  console.log(`  model:    ${MODEL}`);
  console.log(`  system:   ${sysCharCount} chars (~${sysTokEst} tokens), run-tag=${RUN_TAG}`);
  console.log(`  body:     same in all 4 calls (only cache_control toggles)`);
  console.log("═".repeat(96));
  console.log();

  // -------- Phase A: no cache_control --------
  console.log("Phase A — NO cache_control on system block");
  const a1 = await callAnthropic({ label: "A1", withCacheControl: false, userText: "Say hi in 3 words." });
  console.log(row("A1", "no  cache_control", a1));
  const a2 = await callAnthropic({ label: "A2", withCacheControl: false, userText: "Say hi in 4 words." });
  console.log(row("A2", "no  cache_control", a2));
  console.log();

  // -------- Phase B: with cache_control --------
  console.log("Phase B — WITH cache_control on system block");
  const b1 = await callAnthropic({ label: "B1", withCacheControl: true, userText: "Say hi in 5 words." });
  console.log(row("B1", "with cache_control", b1));
  const b2 = await callAnthropic({ label: "B2", withCacheControl: true, userText: "Say hi in 6 words." });
  console.log(row("B2", "with cache_control", b2));
  console.log();

  // -------- Summary --------
  console.log("─".repeat(96));
  console.log("Summary:");
  if (a1 && a2 && b1 && b2) {
    const a2Billed = (a2.input_tokens ?? 0) + (a2.cache_creation_input_tokens ?? 0);
    const b2Billed = (b2.input_tokens ?? 0) + (b2.cache_creation_input_tokens ?? 0);
    const b2Cached = b2.cache_read_input_tokens ?? 0;
    const savedPct = a2Billed > 0 ? Math.round((1 - b2Billed / a2Billed) * 100) : 0;
    console.log(`  Without cache_control, 2nd call paid full input:   ${a2Billed} tokens`);
    console.log(`  With    cache_control, 2nd call paid full input:   ${b2Billed} tokens`);
    console.log(`  With    cache_control, 2nd call cache_read:        ${b2Cached} tokens (at ~10% price)`);
    console.log(`  → Input-token cost reduction on B2 vs A2:          ${savedPct}%`);
  }
  console.log("─".repeat(96));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
