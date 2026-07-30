import { randomBytes, timingSafeEqual } from 'crypto'
import { createServer, type Server } from 'net'
import type { RuntimeAuth } from './types.js'

export type IssuedAuth = RuntimeAuth & {
  sessionId: string
  environmentId: string
}

type TokenRecord = IssuedAuth & { revoked?: boolean }

/**
 * Issues short-lived runtime tokens and optionally hosts a local AuthProxy
 * that SSH -R / workers can call without embedding long-lived LLM keys.
 */
export class CredentialBroker {
  private tokens = new Map<string, TokenRecord>()
  private proxyServer: Server | null = null
  private proxyPort: number | null = null
  private readonly ttlMs: number

  constructor(opts?: { ttlMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? 60 * 60 * 1000
  }

  issueRuntimeAuth(sessionId: string, environmentId: string): IssuedAuth {
    const token = randomBytes(24).toString('base64url')
    const expiresAt = Date.now() + this.ttlMs
    const brokerUrl = this.getBrokerUrl()
    const record: TokenRecord = {
      token,
      brokerUrl,
      expiresAt,
      sessionId,
      environmentId,
    }
    this.tokens.set(token, record)
    return { token, brokerUrl, expiresAt, sessionId, environmentId }
  }

  validate(token: string): IssuedAuth | null {
    const rec = this.tokens.get(token)
    if (!rec || rec.revoked) return null
    if (Date.now() >= rec.expiresAt) {
      this.tokens.delete(token)
      return null
    }
    return rec
  }

  revoke(token: string): void {
    const rec = this.tokens.get(token)
    if (rec) rec.revoked = true
  }

  revokeSession(sessionId: string): void {
    for (const rec of this.tokens.values()) {
      if (rec.sessionId === sessionId) rec.revoked = true
    }
  }

  /** Compare tokens in constant time when both are known-length base64url. */
  safeEqual(a: string, b: string): boolean {
    const ba = Buffer.from(a)
    const bb = Buffer.from(b)
    if (ba.length !== bb.length) return false
    return timingSafeEqual(ba, bb)
  }

  getBrokerUrl(): string {
    if (this.proxyPort != null) {
      return `http://127.0.0.1:${this.proxyPort}`
    }
    // Fallback until AuthProxy is started — workers may still use HTTP mint
    // on the control plane later.
    return process.env.BAIX_BROKER_URL ?? 'http://127.0.0.1:0'
  }

  getProxyPort(): number | null {
    return this.proxyPort
  }

  /**
   * Minimal local HTTP proxy: validates Bearer runtime token, then answers
   * health. LLM credential forwarding can be layered on later.
   */
  async startAuthProxy(preferredPort = 0): Promise<number> {
    if (this.proxyServer && this.proxyPort != null) return this.proxyPort

    const server = createServer((socket) => {
      let buf = ''
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8')
        if (!buf.includes('\r\n\r\n')) return
        const auth = /^Authorization:\s*Bearer\s+(\S+)/im.exec(buf)
        const token = auth?.[1]
        const ok = token ? this.validate(token) : null
        const body = ok
          ? JSON.stringify({
              ok: true,
              sessionId: ok.sessionId,
              environmentId: ok.environmentId,
              expiresAt: ok.expiresAt,
            })
          : JSON.stringify({ ok: false, error: 'unauthorized' })
        const status = ok ? '200 OK' : '401 Unauthorized'
        socket.write(
          `HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        )
        socket.end()
      })
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(preferredPort, '127.0.0.1', () => resolve())
    })

    const addr = server.address()
    if (!addr || typeof addr === 'string') {
      server.close()
      throw new Error('CredentialBroker AuthProxy failed to bind')
    }

    this.proxyServer = server
    this.proxyPort = addr.port
    return addr.port
  }

  async stopAuthProxy(): Promise<void> {
    const server = this.proxyServer
    this.proxyServer = null
    this.proxyPort = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
