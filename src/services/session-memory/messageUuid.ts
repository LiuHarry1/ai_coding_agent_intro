import { randomUUID } from 'crypto'
import type { Message } from '../../core/types.js'
import { isAttachmentMessage, isRoleMessage } from '../../core/types.js'

/** Stable per-message id (not the assistant API round `id`). */
export function getMessageUuid(msg: Message): string | undefined {
  if (isAttachmentMessage(msg)) return msg.uuid
  if (isRoleMessage(msg)) return msg.uuid
  return undefined
}

export function ensureMessageUuid<T extends Message>(msg: T): T {
  if (isAttachmentMessage(msg)) {
    if (!msg.uuid) msg.uuid = randomUUID()
    return msg
  }
  if (isRoleMessage(msg)) {
    if (!msg.uuid) msg.uuid = randomUUID()
  }
  return msg
}

export function ensureMessageUuids(messages: Message[]): void {
  for (const m of messages) ensureMessageUuid(m)
}

export function findMessageIndexByUuid(
  messages: Message[],
  uuid: string,
): number {
  return messages.findIndex(m => getMessageUuid(m) === uuid)
}
