/**
 * Composer image attachment helpers (InputArea).
 *
 * Previews use blob: object URLs (cheap to re-render). Wire path uploads files
 * via /chat/uploads so chat state never holds multi-MB data URLs.
 */

export const MAX_IMAGES = 5
export const ACCEPTED_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]

/** @returns {{ id: string, previewUrl: string, file: File }} */
export function fileToAttachment(file) {
  return {
    id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
    previewUrl: URL.createObjectURL(file),
    file,
  }
}

export function revokeAttachment(att) {
  if (att?.previewUrl?.startsWith('blob:')) {
    URL.revokeObjectURL(att.previewUrl)
  }
}

export function revokeAttachments(list) {
  for (const att of list || []) revokeAttachment(att)
}

/** @deprecated Prefer fileToAttachment + upload; kept for tests / legacy. */
export function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export function extractDroppedFiles(dataTransfer) {
  const files = []
  if (!dataTransfer?.items) return files
  for (const item of dataTransfer.items) {
    if (item.kind === 'file') {
      const f = item.getAsFile()
      if (f) files.push(f)
    }
  }
  return files
}

export function extractImages(dataTransfer) {
  return extractDroppedFiles(dataTransfer).filter(f =>
    ACCEPTED_TYPES.includes(f.type),
  )
}

export function isImageFile(file) {
  return ACCEPTED_TYPES.includes(file.type)
}
