/**
 * Composer image attachment helpers (InputArea).
 */

export const MAX_IMAGES = 5
export const ACCEPTED_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]

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
