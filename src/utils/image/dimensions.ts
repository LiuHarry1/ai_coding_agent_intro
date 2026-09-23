export interface ImageDimensions {
  width: number
  height: number
}

export function readImageDimensions(
  buffer: Buffer,
): ImageDimensions | undefined {
  if (
    buffer.length >= 24 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    const width = buffer.readUInt32BE(16)
    const height = buffer.readUInt32BE(20)
    return validDimensions(width, height)
  }

  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return undefined
  }
  let offset = 2
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer[offset + 1]
    offset += 2
    if (marker === 0xd8 || marker === 0xd9) continue
    if (offset + 2 > buffer.length) return undefined
    const length = buffer.readUInt16BE(offset)
    if (length < 2 || offset + length > buffer.length) return undefined
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      const height = buffer.readUInt16BE(offset + 3)
      const width = buffer.readUInt16BE(offset + 5)
      return validDimensions(width, height)
    }
    offset += length
  }
  return undefined
}

function validDimensions(
  width: number,
  height: number,
): ImageDimensions | undefined {
  return Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
    ? { width, height }
    : undefined
}
