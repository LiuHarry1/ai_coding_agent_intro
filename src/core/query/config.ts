/**
 * Per-turn runtime gates (CC query/config.ts).
 * Streaming tool execution is always on.
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
