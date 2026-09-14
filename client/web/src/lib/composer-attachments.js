/**
 * Composer attachment helpers (InputArea).
 *
 * Images get blob: previews (cheap to re-render); everything else shows a
 * chip. The wire path uploads via /chat/uploads so chat state never holds
 * multi-MB data URLs. Classification mirrors the server's
 * `constants/attachment-types.ts` — keep the two in step.
 */

export const MAX_ATTACHMENTS = 10

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

/** Media types the model's image pipeline can carry — see SUPPORTED_IMAGE_MIMES. */
const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
])

/** Extensions the agent cannot read as text — it must shell out instead. */
const BINARY_EXTENSIONS = new Set([
  'bmp', 'ico', 'tiff', 'tif',
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'm4v', 'mpeg', 'mpg',
  'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'aiff', 'opus',
  'zip', 'tar', 'gz', 'bz2', '7z', 'rar', 'xz', 'z', 'tgz', 'iso',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'obj', 'lib', 'app',
  'msi', 'deb', 'rpm',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'pyc', 'pyo', 'class', 'jar', 'war', 'ear', 'node', 'wasm', 'rlib',
  'sqlite', 'sqlite3', 'db', 'mdb', 'idx',
  'psd', 'ai', 'eps', 'sketch', 'fig', 'xd', 'blend', '3ds', 'max',
  'swf', 'fla', 'lockb', 'dat', 'data',
])

/** Per-kind ceilings, mirroring ATTACHMENT_MAX_BYTES on the server. */
const MAX_BYTES = {
  image: 10 * 1024 * 1024,
  pdf: 20 * 1024 * 1024,
  text: 16 * 1024 * 1024,
  binary: 64 * 1024 * 1024,
}

export function fileExtension(name) {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

/** @returns {'image'|'pdf'|'text'|'binary'} */
export function attachmentKind(file) {
  const ext = fileExtension(file.name || '')
  const type = (file.type || '').toLowerCase().split(';')[0].trim()
  if (IMAGE_EXTENSIONS.has(ext) || IMAGE_TYPES.has(type)) return 'image'
  if (ext === 'pdf' || type === 'application/pdf') return 'pdf'
  // SVG is XML source the model can read; bmp/tiff/heic it cannot decode, so
  // those go over as a path for a shell tool to convert.
  if (ext === 'svg' || type === 'image/svg+xml') return 'text'
  if (type.startsWith('image/')) return 'binary'
  if (BINARY_EXTENSIONS.has(ext)) return 'binary'
  return 'text'
}

export function isImageFile(file) {
  return attachmentKind(file) === 'image'
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** @returns {string|null} rejection reason, or null when the file is accepted. */
export function attachmentRejection(file) {
  const kind = attachmentKind(file)
  if (file.size === 0) return `${file.name} is empty`
  if (file.size > MAX_BYTES[kind]) {
    return `${file.name} is too large (${formatBytes(file.size)}; max ${formatBytes(MAX_BYTES[kind])})`
  }
  return null
}

/**
 * @returns {{ id: string, kind: string, name: string, size: number, previewUrl: string|null, file: File }}
 */
export function fileToAttachment(file) {
  const kind = attachmentKind(file)
  return {
    id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    name: file.name,
    size: file.size,
    previewUrl: kind === 'image' ? URL.createObjectURL(file) : null,
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
  return extractDroppedFiles(dataTransfer).filter(isImageFile)
}
