/**
 * Stable bubble ids for the Cursor-like transcript store.
 */

export function toolBubbleId(toolCallId) {
  return `tool:${toolCallId}`
}

export function thinkingBubbleId(turnId) {
  return `thinking:${turnId}`
}

export function textBubbleId(turnId, seq = 0) {
  return `text:${turnId}:${seq}`
}

export function reasoningBubbleId(id) {
  return `reasoning:${id}`
}

export function askBubbleId(questionId) {
  return `ask:${questionId}`
}

export function permBubbleId(requestId) {
  return `perm:${requestId}`
}

export function planBubbleId(requestId) {
  return `plan:${requestId}`
}

export function todoBubbleId(turnId) {
  return `todo:${turnId}`
}

export function compactionBubbleId(turnId) {
  return `compaction:${turnId}`
}

export function errorBubbleId(id) {
  return `error:${id}`
}
