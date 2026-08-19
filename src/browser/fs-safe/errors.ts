/** FsSafeError codes and categories. */
const OPERATIONAL_CODES = new Set([
  'helper-failed',
  'helper-unavailable',
  'not-empty',
  'not-found',
  'not-removable',
  'permission-unverified',
  'read-failed',
  'timeout',
  'unsupported-platform',
])

export type FsSafeErrorCode = string

export function categorizeFsSafeError(
  code: string,
): 'operational' | 'policy' {
  return OPERATIONAL_CODES.has(code) ? 'operational' : 'policy'
}

export class FsSafeError extends Error {
  code: FsSafeErrorCode
  category: 'operational' | 'policy'
  details: unknown

  constructor(
    code: FsSafeErrorCode,
    message: string,
    options: { details?: unknown; cause?: unknown } = {},
  ) {
    super(message, options as ErrorOptions)
    this.name = 'FsSafeError'
    this.code = code
    this.category = categorizeFsSafeError(code)
    this.details = options.details
  }
}
