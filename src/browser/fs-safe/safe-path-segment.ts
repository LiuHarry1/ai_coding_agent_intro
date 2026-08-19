/** Reject path segments that contain separators or `..`. */
import { FsSafeError } from './errors.js'

const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/
const SAFE_DOT_PREFIX_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/

export function isSafePathSegment(
  segment: string,
  options: { allowDotPrefix?: boolean } = {},
): boolean {
  return (
    segment !== '' &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('/') &&
    !segment.includes('\\') &&
    !segment.includes('\0') &&
    (options.allowDotPrefix === true || !segment.startsWith('.')) &&
    (options.allowDotPrefix === true
      ? SAFE_DOT_PREFIX_PATH_SEGMENT_PATTERN.test(segment)
      : SAFE_PATH_SEGMENT_PATTERN.test(segment))
  )
}

export function assertSafePathSegment(
  segment: string,
  options: { allowDotPrefix?: boolean; label?: string } = {},
): string {
  if (!isSafePathSegment(segment, options)) {
    throw new FsSafeError(
      'invalid-path',
      `${options.label ?? 'path segment'} must be a safe path segment`,
    )
  }
  return segment
}
