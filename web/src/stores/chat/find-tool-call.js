/** Find a tool_call part (top-level or nested in a subagent) by id. */
export function findToolCallInAssistant(assistantMsg, toolCallId) {
  if (assistantMsg?.type !== 'assistant' || !toolCallId) return null
  for (let i = assistantMsg.parts.length - 1; i >= 0; i--) {
    const p = assistantMsg.parts[i]
    if (p.type !== 'tool_call') continue
    if (p.toolCallId === toolCallId) return p
    for (const sub of p.subagentParts || []) {
      if (sub.toolCallId === toolCallId) return sub
    }
  }
  return null
}
