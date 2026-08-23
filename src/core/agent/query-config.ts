/**
 * Per-turn runtime gates (CC query/config.ts).
 * Streaming tool execution is always on — no batch fallback.
 */
export type QueryConfig = {
  gates: {
    streamingToolExecution: true
  }
}

export function buildQueryConfig(): QueryConfig {
  return {
    gates: {
      streamingToolExecution: true,
    },
  }
}
