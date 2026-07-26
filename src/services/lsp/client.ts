import { spawn, type ChildProcess } from 'child_process'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node'
import type {
  InitializeParams,
  InitializeResult,
  ServerCapabilities,
} from 'vscode-languageserver-protocol'

export interface LspClient {
  readonly capabilities: ServerCapabilities | undefined
  readonly isInitialized: boolean
  start(
    command: string,
    args: string[],
    options?: { cwd?: string; env?: Record<string, string> },
  ): Promise<void>
  initialize(params: InitializeParams): Promise<InitializeResult>
  sendRequest<T>(method: string, params: unknown): Promise<T>
  sendNotification(method: string, params: unknown): Promise<void>
  onNotification(method: string, handler: (params: unknown) => void): void
  onRequest<TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ): void
  stop(): Promise<void>
}

export function createLspClient(
  serverName: string,
  onCrash?: (error: Error) => void,
): LspClient {
  let child: ChildProcess | undefined
  let connection: MessageConnection | undefined
  let capabilities: ServerCapabilities | undefined
  let initialized = false
  let stopping = false
  let startError: Error | undefined
  const pendingNotifications: Array<{
    method: string
    handler: (params: unknown) => void
  }> = []
  const pendingRequests: Array<{
    method: string
    handler: (params: unknown) => unknown | Promise<unknown>
  }> = []

  function assertStarted(): MessageConnection {
    if (startError) throw startError
    if (!connection) throw new Error(`LSP server ${serverName} is not started`)
    return connection
  }

  return {
    get capabilities() {
      return capabilities
    },
    get isInitialized() {
      return initialized
    },
    async start(command, args, options) {
      stopping = false
      startError = undefined

      child = spawn(command, args, {
        cwd: options?.cwd,
        env: { ...process.env, ...(options?.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        windowsHide: true,
      })

      if (!child.stdin || !child.stdout) {
        throw new Error(`LSP server ${serverName} stdio is unavailable`)
      }

      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup()
          resolve()
        }
        const onError = (err: Error) => {
          cleanup()
          startError = err
          reject(err)
        }
        const cleanup = () => {
          child?.removeListener('spawn', onSpawn)
          child?.removeListener('error', onError)
        }
        child!.once('spawn', onSpawn)
        child!.once('error', onError)
      })

      child.stderr?.on('data', data => {
        const text = String(data).trim()
        if (text) console.warn(`[lsp:${serverName}] ${text}`)
      })
      child.stdin.on('error', err => {
        if (!stopping) console.warn(`[lsp:${serverName}] stdin: ${err.message}`)
      })
      child.on('error', err => {
        if (stopping) return
        startError = err
        onCrash?.(err)
      })
      child.on('exit', code => {
        if (stopping) return
        initialized = false
        if (code !== 0 && code !== null) {
          onCrash?.(
            new Error(`LSP server ${serverName} exited with code ${code}`),
          )
        }
      })

      connection = createMessageConnection(
        new StreamMessageReader(child.stdout),
        new StreamMessageWriter(child.stdin),
      )
      connection.onError(([err]: [Error, unknown, unknown]) => {
        if (stopping) return
        startError = err
        console.warn(`[lsp:${serverName}] connection error: ${err.message}`)
      })
      connection.onClose(() => {
        if (!stopping) initialized = false
      })
      connection.listen()

      for (const { method, handler } of pendingNotifications) {
        connection.onNotification(method, handler)
      }
      pendingNotifications.length = 0
      for (const { method, handler } of pendingRequests) {
        connection.onRequest(method, handler)
      }
      pendingRequests.length = 0
    },
    async initialize(params) {
      const conn = assertStarted()
      const result = await conn.sendRequest<InitializeResult>(
        'initialize',
        params,
      )
      capabilities = result.capabilities
      await conn.sendNotification('initialized', {})
      initialized = true
      return result
    },
    async sendRequest<T>(method: string, params: unknown): Promise<T> {
      if (!initialized) throw new Error(`LSP server ${serverName} is not ready`)
      return assertStarted().sendRequest<T>(method, params)
    },
    async sendNotification(method, params) {
      await assertStarted().sendNotification(method, params)
    },
    onNotification(method, handler) {
      if (!connection) {
        pendingNotifications.push({ method, handler })
        return
      }
      connection.onNotification(method, handler)
    },
    onRequest(method, handler) {
      if (!connection) {
        pendingRequests.push({
          method,
          handler: handler as (params: unknown) => unknown | Promise<unknown>,
        })
        return
      }
      ;(connection.onRequest as any)(method, handler)
    },
    async stop() {
      stopping = true
      try {
        if (connection && initialized) {
          await connection.sendRequest('shutdown', undefined)
          await connection.sendNotification('exit', undefined)
        }
      } catch (err) {
        console.warn(
          `[lsp:${serverName}] shutdown failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      } finally {
        connection?.dispose()
        connection = undefined
        child?.removeAllListeners()
        child?.stdin?.removeAllListeners()
        child?.stderr?.removeAllListeners()
        child?.kill()
        child = undefined
        capabilities = undefined
        initialized = false
        stopping = false
      }
    },
  }
}
