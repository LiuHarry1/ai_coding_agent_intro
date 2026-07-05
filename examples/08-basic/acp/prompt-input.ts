import type { ContentBlock } from '@agentclientprotocol/sdk'

export function promptBlocksToUserTurn(blocks: ContentBlock[]): {
  text: string
  images?: string[]
} {
  const textParts: string[] = []
  const images: string[] = []

  for (const block of blocks) {
    if (block.type === 'text') {
      textParts.push(block.text)
      continue
    }
    if (block.type === 'image') {
      const mime = block.mimeType || 'image/png'
      images.push(`data:${mime};base64,${block.data}`)
      continue
    }
    if (block.type === 'resource_link') {
      textParts.push(`@${block.name ?? block.uri ?? 'resource'}`)
      continue
    }
    if (block.type === 'resource') {
      const resource = block.resource
      if (resource && typeof resource === 'object' && 'text' in resource) {
        const text = (resource as { text?: string }).text
        if (text) textParts.push(text)
      }
    }
  }

  return {
    text: textParts.join('\n').trim(),
    images: images.length ? images : undefined,
  }
}
