/**
 * Script lists for the coding-tools suites. Shared by the vitest bridge
 * (`suites/tools.test.ts`) and the standalone runner used for coverage
 * (`run-coding-tools-tests.ts`).
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
