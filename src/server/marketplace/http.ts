import type { MarketplaceProviderConfig } from '../../core/types.js'

export class MarketplaceError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
  ) {
    super(message)
    this.name = 'MarketplaceError'
  }
}

export function validateProviderURL(config: MarketplaceProviderConfig): void {
  const url = new URL(config.baseURL)
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && config.allowInsecureHttp) return
  throw new MarketplaceError(
    `Marketplace '${config.id}' must use HTTPS (or be explicitly allowed by managed configuration)`,
    500,
  )
}

export function endpoint(
  config: MarketplaceProviderConfig,
  pathname: string,
): URL {
  validateProviderURL(config)
  const base = config.baseURL.replace(/\/+$/, '')
  return new URL(`${base}/${pathname.replace(/^\/+/, '')}`)
}

export async function fetchWithLimits(
  url: URL,
  init: RequestInit,
  config: MarketplaceProviderConfig,
): Promise<Response> {
  const signal = AbortSignal.timeout(config.timeoutMs ?? 15_000)
  let response: Response
  try {
    response = await fetch(url, { ...init, signal })
  } catch (error) {
    throw new MarketplaceError(
      `Marketplace '${config.id}' request failed: ${(error as Error).message}`,
      503,
    )
  }
  return response
}

export async function readJSON(response: Response): Promise<unknown> {
  const text = await response.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new MarketplaceError(
      `Marketplace returned invalid JSON (${response.status})`,
    )
  }
  if (!response.ok) {
    const message =
      typeof data === 'object' &&
      data !== null &&
      'error' in data &&
      typeof data.error === 'string'
        ? data.error
        : `Marketplace request failed (${response.status})`
    throw new MarketplaceError(
      message,
      response.status === 401 ? 401 : response.status >= 500 ? 503 : 400,
    )
  }
  return data
}

export async function readLimitedBuffer(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (!response.ok) {
    await readJSON(response)
  }
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > maxBytes) {
    throw new MarketplaceError(
      'Marketplace artifact exceeds download limit',
      413,
    )
  }
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new MarketplaceError(
        'Marketplace artifact exceeds download limit',
        413,
      )
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
}

export function unwrapData(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && 'data' in value) {
    return (value as { data: unknown }).data
  }
  return value
}
