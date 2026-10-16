/**
 * Script lists for the coding-tools suites, run by `suites/tools.test.ts`.
 * `coverage:tools` wraps that same vitest file with c8; the child processes
 * inherit NODE_V8_COVERAGE so every script contributes to the report.
 */
export const CODING_TOOLS_UNIT = [
  'test-coding-tools-manifest.ts',
  'test-coding-tools-core.ts',
  'test-coding-tools-platform.ts',
  'test-coding-tools-orchestration.ts',
  'test-bundled-ripgrep.ts',
  'test-file-change-card-dom.mjs',
]

export const CODING_TOOLS_INTEGRATION = [
  'test-dual-channel-tools.ts',
  'test-grep-wire.ts',
  'test-ask-mode-restrictions.ts',
  'test-streaming-tool-exec.ts',
  'test-web-fetch.ts',
  'test-forked-agent.ts',
  'test-agent-loading.ts',
  'test-coding-tools-agent-skill.ts',
  'test-coding-tools-cron.ts',
]

/** Env overrides every coding-tools script runs with (no LLM, no network). */
export const CODING_TOOLS_ENV: Record<string, string | undefined> = {
  AUTH_ENABLED: undefined,
  SKIP_LLM: '1',
  WEB_FETCH_LIVE: '0',
}
